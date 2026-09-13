import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiErrorSchema, RunViewSchema, TraceViewSchema } from '../../src/shared/api.js';
import { PIPELINE_STAGE_IDS } from '../../src/shared/domain.js';
import { App } from '../../src/web/App.js';
import { AssessmentStatus } from '../../src/web/components/StatusBand.js';
import { DEMO_FIXTURES, type ConsoleFixture } from '../../src/web/fixtures/demo.js';

afterEach(cleanup);

function fixtureWhere(predicate: (fixture: ConsoleFixture) => boolean) {
  const fixture = DEMO_FIXTURES.find(predicate);
  expect(fixture, 'The synthetic matrix must contain this review scenario').toBeDefined();
  return fixture!;
}

function assessmentItem(name: string) {
  return screen.getByRole('heading', { name }).parentElement!;
}

describe('synthetic operator console', () => {
  it('keeps every run, trace, and error fixture within the frozen F02 schemas', () => {
    expect(new Set(DEMO_FIXTURES.map(fixture => fixture.id)).size).toBe(DEMO_FIXTURES.length);
    for (const fixture of DEMO_FIXTURES) {
      if (fixture.run) {
        expect(() => RunViewSchema.parse(fixture.run), fixture.id).not.toThrow();
        expect(fixture.run.configuration.evidenceMode, fixture.id).toBe('synthetic_fixture');
        expect(fixture.run.configuration.modelMode, fixture.id).toBe('mock');
        expect(fixture.run.configuration.providerMode, fixture.id).toBe('fake');
      }
      if (fixture.trace) expect(() => TraceViewSchema.parse(fixture.trace), fixture.id).not.toThrow();
      if (fixture.error) expect(() => ApiErrorSchema.parse(fixture.error), fixture.id).not.toThrow();
      const { unmount } = render(<App initialFixtureId={fixture.id} />);
      expect(screen.getByText('◇ Synthetic preview'), fixture.id).toBeVisible();
      expect(screen.queryByRole('button', { name: /^(approve|reject|send|reconcile)\b/i }), fixture.id).not.toBeInTheDocument();
      unmount();
    }
  });

  it('renders exact saved drafts, ordered stages, and explicit synthetic provenance without approval controls', () => {
    const fixture = fixtureWhere(item => item.run?.productStatus === 'awaiting_approval');
    const { container } = render(<App initialFixtureId={fixture.id} />);
    expect(screen.getByText('◇ Synthetic preview')).toBeVisible();
    expect(screen.getByText(/No models or external apps have been called/)).toBeVisible();
    const draftEntries = Array.from(container.querySelectorAll('.draft-entry'));
    expect(draftEntries).toHaveLength(fixture.run!.plan!.entries.length);
    fixture.run!.plan!.entries.forEach((entry, index) => {
      expect(within(draftEntries[index] as HTMLElement).getByText(entry.recipient, { exact: true })).toBeVisible();
      expect(within(draftEntries[index] as HTMLElement).getByText(entry.subject, { exact: true })).toBeVisible();
      expect(draftEntries[index].querySelector('.draft-body')?.textContent).toBe(entry.body);
    });
    expect(Array.from(container.querySelectorAll('[data-stage-id]')).map(stage => stage.getAttribute('data-stage-id'))).toEqual([...PIPELINE_STAGE_IDS]);
    expect(screen.getByRole('link', { name: /Open Slack review thread/ })).toHaveAttribute('href', fixture.run!.approval!.slackLink);
    expect(screen.queryByRole('button', { name: /^(approve|reject|send|reconcile)\b/i })).not.toBeInTheDocument();
    expect(container.querySelectorAll('textarea, [contenteditable="true"]')).toHaveLength(0);
  });

  it('keeps completed product readback distinct from pending independent assessment', () => {
    const fixture = fixtureWhere(item => item.run?.productStatus === 'completed' && item.run.assessments.outcome.status === 'pending');
    render(<App initialFixtureId={fixture.id} />);
    const band = screen.getByRole('region', { name: 'Run and assessment status' });
    expect(within(band).getByText('✓ Completed')).toBeVisible();
    expect(assessmentItem('Independent outcome')).toHaveTextContent('Pending');
    expect(assessmentItem('Independent outcome')).not.toHaveTextContent('✓ Pass');
    expect(screen.getByText(/Report pending/)).toBeVisible();
  });

  it('preserves expected and observed recipients alongside the failed readback', () => {
    const fixture = fixtureWhere(item => item.run?.effects.some(effect => effect.comparisons.some(field => field.field === 'recipient' && field.verdict === 'mismatched')) === true);
    const { container } = render(<App initialFixtureId={fixture.id} />);
    const mismatch = fixture.run!.effects.find(effect => effect.comparisons.some(field => field.field === 'recipient' && field.verdict === 'mismatched'))!;
    const field = mismatch.comparisons.find(value => value.field === 'recipient' && value.verdict === 'mismatched')!;
    const row = Array.from(container.querySelectorAll<HTMLElement>('[data-effect-key]')).find(element => element.dataset.effectKey === mismatch.effectKey)!;
    expect(row).toHaveTextContent('Field mismatch');
    expect(within(row).getByText(String(field.expected), { exact: true })).toBeInTheDocument();
    expect(within(row).getByText(String(field.observed), { exact: true })).toBeInTheDocument();
    expect(field.expected).not.toEqual(field.observed);
  });

  it('retains original proposal failure after a corrected selected plan passes', () => {
    const fixture = fixtureWhere(item => item.run?.assessments.firstProposal.status === 'fail' && item.run.assessments.selectedPlan?.status === 'pass');
    const { rerender } = render(<App initialFixtureId={fixture.id} />);
    expect(assessmentItem('Original first proposal')).toHaveTextContent('! Fail');
    expect(assessmentItem('Selected plan')).toHaveTextContent('✓ Pass');
    expect(assessmentItem('Original first proposal')).not.toHaveTextContent('✓ Pass');
    rerender(<AssessmentStatus assessment={{ ...fixture.run!.assessments.firstProposal, humanLabelCount: 0 }} firstProposal />);
    expect(screen.getByText('! Fail')).toBeVisible();
    expect(screen.getByText('? Unverified (0 reviewed)')).toBeVisible();
  });

  it('keeps unknown writes and missing readback visible with earlier accepted effects', () => {
    const unknown = fixtureWhere(item => item.run?.productStatus === 'failed_partial' && item.run.effects.some(effect => effect.outcome === 'unknown'));
    const { container, rerender } = render(<App key={unknown.id} initialFixtureId={unknown.id} />);
    expect(screen.getByText('Unknown mutation outcome')).toBeVisible();
    expect(container.querySelectorAll('[data-effect-key]')).toHaveLength(unknown.run!.effects.length);
    expect(screen.getByText(/Failed partial: accepted effects/)).toBeVisible();
    expect(unknown.run!.effects.some(effect => effect.state === 'verified')).toBe(true);

    const missing = fixtureWhere(item => item.run?.effects.some(effect => effect.comparison === 'missing_readback') === true);
    rerender(<App key={missing.id} initialFixtureId={missing.id} />);
    expect(screen.getAllByText('Missing readback').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);

    const missingField = fixtureWhere(item => item.run?.effects.some(effect => effect.comparisons.some(field => field.field === 'recipient' && field.observed === null)) === true);
    rerender(<App key={missingField.id} initialFixtureId={missingField.id} />);
    const comparison = screen.getByText('Recipient · Unavailable').parentElement!;
    expect(within(comparison).getByText('Observed').nextElementSibling).toHaveTextContent(/^Unavailable$/);
  });

  it('shows zero labels as unverified and a zero metric denominator as N/A', () => {
    const fixture = fixtureWhere(item => item.run?.assessments.firstProposal.humanLabelCount === 0 && item.run.report?.metrics.some(metric => 'denominator' in metric && metric.denominator === 0) === true);
    render(<App initialFixtureId={fixture.id} />);
    expect(assessmentItem('Original first proposal')).toHaveTextContent('Unverified (0 reviewed)');
    expect(screen.getAllByText(/N\/A \(0 eligible\)/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/100%/)).not.toBeInTheDocument();
  });

  it('distinguishes incomplete retrieval from the no-affected result', () => {
    const incomplete = fixtureWhere(item => item.run?.commitments.status === 'incomplete');
    const { rerender } = render(<App key={incomplete.id} initialFixtureId={incomplete.id} />);
    expect(screen.getByText('Retrieval incomplete')).toBeVisible();
    expect(screen.getByText(/An empty list does not establish/)).toBeVisible();
    const empty = fixtureWhere(item => item.run?.productStatus === 'completed_no_affected_commitments');
    rerender(<App key={empty.id} initialFixtureId={empty.id} />);
    expect(screen.getByText('No affected commitments')).toBeVisible();
    expect(screen.getByText(/No effects required/)).toBeVisible();
    expect(screen.queryByRole('link', { name: /Open Slack review thread/ })).not.toBeInTheDocument();
  });

  it('retains the previous run while disabling commands offline and after session expiry', () => {
    for (const connection of ['offline', 'session_expired'] as const) {
      const fixture = fixtureWhere(item => item.connection === connection && item.run !== undefined);
      const { unmount } = render(<App initialFixtureId={fixture.id} />);
      expect(screen.getByRole('button', { name: /Start or reopen/ })).toBeDisabled();
      expect(screen.getByRole('textbox', { name: 'GitHub incident URL' })).toBeDisabled();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(fixture.run!.incident.title);
      expect(screen.getByRole('combobox', { name: 'Preview scenario' })).toBeEnabled();
      if (connection === 'session_expired') expect(screen.getByRole('alert')).toHaveTextContent(/session has expired/i);
      else expect(screen.getByText(/Offline · stale data/)).toBeVisible();
      unmount();
    }
  });

  it('has no automated component accessibility violations in the review screen', async () => {
    const fixture = fixtureWhere(item => item.run?.productStatus === 'awaiting_approval');
    const { container } = render(<App initialFixtureId={fixture.id} />);
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
});
