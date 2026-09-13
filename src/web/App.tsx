import { useRef, useState } from 'react';
import type { RunView } from '../shared/api.js';
import { IncidentInput } from './components/IncidentInput.js';
import { AssessmentStatus, StatusBand } from './components/StatusBand.js';
import { EvidencePanel } from './components/EvidencePanel.js';
import { PlanPanel } from './components/PlanPanel.js';
import { RunTimeline } from './components/RunTimeline.js';
import { EffectsPanel } from './components/EffectsPanel.js';
import { DEFAULT_FIXTURE_ID, DEMO_FIXTURES, type ConsoleFixture } from './fixtures/demo.js';
import './styles.css';

function ReliabilitySummary({ run }: { run: RunView }) {
  const report = run.report;
  return <section className="reliability-section" aria-labelledby="reliability-heading">
    <div className="section-heading"><div><p className="eyebrow">Independent evidence</p><h2 id="reliability-heading">Reliability summary</h2></div>
      <span className="status-chip">◇ Synthetic</span></div>
    <div className="assessment-grid">
      {(['trace', 'outcome', 'firstProposal', 'selectedPlan'] as const).map(key => {
        const assessment = run.assessments[key];
        if (!assessment) return null;
        return <div key={key} className="assessment-item">
          <h3>{{ trace: 'Process / trace', outcome: 'Independent outcome', firstProposal: 'Original first proposal', selectedPlan: 'Selected plan' }[key]}</h3>
          <AssessmentStatus assessment={assessment} firstProposal={key === 'firstProposal'} />
          <p className="muted">{assessment.confirmedCount} / {assessment.requiredCount} confirmed · {assessment.coverage.replaceAll('_', ' ')}</p>
          {key === 'firstProposal' && <p className="muted">Human labels: {assessment.humanLabelCount ?? 'Unavailable'} · synthetic example</p>}
          {assessment.gaps.length > 0 && <ul className="gap-list">{assessment.gaps.map((gap, index) => <li key={`${gap.code}-${index}`}>△ {gap.code.replaceAll('_', ' ')}{gap.referenceId && <code> · {gap.referenceId}</code>}</li>)}</ul>}
        </div>;
      })}
    </div>
    {!report ? <p className="report-empty">{run.reportAvailability === 'pending' ? '◷ Report pending' : run.reportAvailability === 'unauthorized' ? '⊘ Report access unauthorized' : '? Report unavailable'}</p>
      : <details className="report-details"><summary>Saved synthetic report · {report.reportId}</summary>
        <p className="muted">{report.evaluatorVersion} · manifest {report.manifestVersion} · cohort {report.cohortId} · revision {report.revision} · {report.provenance}</p>
        <p className="muted">Cutoff: {report.cutoffAt} · watermark: {report.watermark}</p>
        <dl className="census">{Object.entries(report.census).map(([key, count]) => <div key={key}><dt>{key.replace(/([A-Z])/g, ' $1')}</dt><dd>{count}</dd></div>)}</dl>
        <ul className="metric-list">{report.metrics.map(metric => <li key={`${metric.metricId}-${metric.dimension}-${metric.role}`}>
          <strong>{metric.metricId}</strong> <span>{metric.dimension} {metric.role}</span>
          {'denominator' in metric ? <span>{metric.numerator} / {metric.denominator} · {metric.denominator === 0 ? 'N/A (0 eligible)' : metric.value === null ? 'Unavailable' : `Recorded rate: ${metric.value}`}</span>
            : <span>{metric.availability === 'na' ? 'N/A (0 eligible)' : `${metric.sampleCount} samples · median: ${metric.medianMs ?? 'Unavailable'} ms · max: ${metric.maxMs ?? 'Unavailable'} ms`} · censored: {metric.censoredCount}</span>}
        </li>)}</ul>
        <ul className="critical-list">{report.criticalCounts.map(count => <li key={count.code}>{count.code.replace(/([A-Z])/g, ' $1')}: <strong>{count.count ?? 'Unavailable'}</strong></li>)}</ul>
        <p>Human-label coverage: {report.humanLabelCount === 0 ? 'Unverified (0 reviewed)' : `${report.humanLabelCount} reviewed (synthetic example)`}</p>
        {report.gaps.length > 0 && <ul className="gap-list">{report.gaps.map((gap, index) => <li key={`${gap.code}-${index}`}>△ {gap.code.replaceAll('_', ' ')}</li>)}</ul>}
        {report.reportRef?.href ? <a className="source-link" href={report.reportRef.href}>{report.reportRef.label}</a> : <p className="muted">Report evidence: {report.reportRef?.availability ?? 'Unavailable'}</p>}
      </details>}
  </section>;
}

const CONNECTION_LABELS: Record<ConsoleFixture['connection'], string> = {
  synthetic: '◇ Local preview', offline: '△ Offline · stale data', reconnecting: '◷ Reconnecting', session_expired: '⊘ Session expired',
};

export function App({ initialFixtureId = DEFAULT_FIXTURE_ID }: { initialFixtureId?: string }) {
  const [fixtureId, setFixtureId] = useState(initialFixtureId);
  const [copyStatus, setCopyStatus] = useState('Copy run ID');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fixture = DEMO_FIXTURES.find(item => item.id === fixtureId) ?? DEMO_FIXTURES[0];
  const defaultFixture = DEMO_FIXTURES.find(item => item.id === DEFAULT_FIXTURE_ID)!;
  const run = fixture.run;
  const allowedIncidentUrl = defaultFixture.run!.incident.url;

  function reopen() {
    setFixtureId(DEFAULT_FIXTURE_ID);
    requestAnimationFrame(() => headingRef.current?.focus());
  }

  async function copyRunId() {
    if (!run) return;
    try { await navigator.clipboard.writeText(run.runId); setCopyStatus('Copied'); }
    catch { setCopyStatus('Copy unavailable'); }
  }

  return <>
    <a className="skip-link" href="#console-main">Skip to incident</a>
    <header className="app-header">
      <a className="wordmark" href="#console-main"><span className="brand-mark" aria-hidden="true">P</span>PromiseGuard</a>
      <span className="header-divider" aria-hidden="true" />
      <span className="header-caption">Operator console</span>
      <span className="environment-label">◇ Synthetic · mock models · fake providers</span>
      <span className="connection-label" aria-live="polite">{CONNECTION_LABELS[fixture.connection]}</span>
    </header>
    <main id="console-main" className="console-shell">
      <section className="preview-toolbar" aria-label="Synthetic fixture selector">
        <div><strong>◇ Synthetic preview</strong><p>No models or external apps have been called. All records, approvals and assessments are illustrative.</p></div>
        <div className="fixture-picker"><label htmlFor="fixture-select">Preview scenario</label>
          <select id="fixture-select" value={fixture.id} onChange={event => { setFixtureId(event.target.value); setCopyStatus('Copy run ID'); }}>
            {DEMO_FIXTURES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></div>
      </section>
      <div className="run-heading-row"><div><p className="eyebrow">Incident workspace</p>
        <h1 ref={headingRef} tabIndex={-1}>{run?.incident.title ?? 'Review an incident. Protect a promise.'}</h1></div>
        {run && <div className="run-identity"><span>Run <code>{run.runId}</code></span><button type="button" className="quiet-button" onClick={copyRunId}>{copyStatus}</button><span className="muted">Revision {run.revision} · {run.incident.environment}</span></div>}
      </div>
      <IncidentInput key={fixture.id} incidentUrl={run?.incident.url ?? allowedIncidentUrl} allowedIncidentUrl={allowedIncidentUrl}
        disabled={fixture.connection !== 'synthetic'} error={fixture.error} onSubmit={reopen} />
      {fixture.notice && <p className="notice fixture-notice">△ {fixture.notice}</p>}
      {run ? <>
        <StatusBand run={run} />
        <RunTimeline run={run} trace={fixture.trace} />
        <div className="review-workspace"><EvidencePanel run={run} /><PlanPanel run={run} /></div>
        <EffectsPanel run={run} />
        <ReliabilitySummary run={run} />
      </> : <section className="empty-workspace"><span className="empty-mark" aria-hidden="true">↗</span><h2>No run selected</h2><p>Open the synthetic incident to review its selected commitments, exact draft and Slack review state.</p></section>}
      <footer className="console-footer"><span>PromiseGuard · GitHub / HubSpot / Slack / Gmail</span><span>Fixture console U01 · conventions 1.2 · API schema v2</span></footer>
    </main>
  </>;
}
