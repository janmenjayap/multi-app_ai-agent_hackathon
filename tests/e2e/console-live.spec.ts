import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { createWorkflowApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/index.js';
import { CommandResultSchema, RunViewSchema, type RunView } from '../../src/shared/api.js';
import { IncidentIdentitySchema } from '../../src/shared/domain.js';
import { EvaluationAttemptRegistrationSchema } from '../../src/shared/evaluation.js';
import { DEMO_FIXTURES } from '../../src/web/fixtures/demo.js';

const CSRF = 'synthetic-browser-csrf';
const fixtureRun = (id: string) => structuredClone(DEMO_FIXTURES.find(fixture => fixture.id === id)!.run!);

// Actual Fastify/SQLite/LangGraph HTTP integration with controlled graph nodes.
// This is synthetic lifecycle evidence, not an assembled S1/S2/S3 provider workflow.
test('assembled HTTP preserves one durable run across duplicate start, refresh and browser closure', async ({ page, context }, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'promiseguard-console-http-'));
  const webRoot = join(directory, 'web');
  cpSync(resolve('dist/web'), webRoot, { recursive: true });
  const shell = join(webRoot, 'index.html');
  writeFileSync(shell, readFileSync(shell, 'utf8').replace('<head>', `<head><meta name="csrf-token" content="${CSRF}">`));
  const configuration = fixtureRun('queued').configuration;
  const config = loadConfig({ PG_FIXTURE_ID: configuration.fixtureId!, PG_DATABASE_PATH: join(directory, 'application.sqlite'),
    PG_CHECKPOINT_PATH: join(directory, 'checkpoints.sqlite'), PG_EVIDENCE_DIR: join(directory, 'evidence') });
  const incident = IncidentIdentitySchema.parse({ schemaVersion: 2, repositoryId: 'browser-repository', issueId: 'browser-issue', issueNumber: 42,
    canonicalUrl: 'https://github.com/promiseguard-synthetic/checkout/issues/42', service: 'checkout', environment: 'test' });
  let releaseNode!: () => void;
  const gate = new Promise<void>(resolveGate => { releaseNode = resolveGate; });
  let simulatedRoleCalls = 0;
  const app = await createWorkflowApp(config, { webRoot, auth: { resolveSession: request =>
    request.headers.cookie?.includes('operator=synthetic-browser') ? {
      operatorId: 'browser-operator', expiresAt: new Date(Date.now() + 60_000).toISOString(), csrfToken: CSRF,
      allowedRunIds: '*', allowedRepositories: ['promiseguard-synthetic/checkout'],
    } : null }, workflow: { configuration, pollMs: 5, prepare: async () => ({ incident,
      title: 'Synthetic durable browser lifecycle', register: (writer, identity) => {
        const receipt = writer.putArtifact({ artifactId: `${identity.runId}-fixture`, mediaType: 'application/json', content: { mode: 'synthetic_fixture' } });
        return EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2, runId: identity.runId,
          evaluationAttemptId: identity.evaluationAttemptId, suiteEntryId: 'browser-lifecycle-entry', manifestHash: 'b'.repeat(64),
          registeredAt: identity.at, dispatchAt: identity.at, preflightRef: receipt, s0Ref: receipt, configuration, leg: 'baseline' });
      } }), nodes: {
        ingest: async () => ({ kind: 'advance', nextStage: 'select' }),
        select: async () => ({ kind: 'advance', nextStage: 'analyst' }),
        analyst: async () => { simulatedRoleCalls++; await gate;
          return { kind: 'stop', status: 'safely_blocked', reason: 'synthetic_boundary' }; },
      } } });
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    await context.addCookies([{ name: 'operator', value: 'synthetic-browser', url: origin }]);
    await page.goto(origin);
    await expect(page.getByRole('combobox', { name: 'Preview scenario' })).toHaveCount(0);
    const rejected = await context.request.post(`${origin}/api/runs`, { data: { schemaVersion: 2, incidentUrl: incident.canonicalUrl } });
    expect(rejected.status()).toBe(403);
    expect((await rejected.json()).code).toBe('csrf_failed');

    await page.getByRole('textbox', { name: 'GitHub incident URL' }).fill(incident.canonicalUrl);
    const commandResponse = page.waitForResponse(response => response.url() === `${origin}/api/runs` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Start or reopen ↗' }).click();
    const first = CommandResultSchema.parse(await (await commandResponse).json());
    await expect.poll(() => simulatedRoleCalls).toBe(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Synthetic durable browser lifecycle');
    const before = RunViewSchema.parse(await (await context.request.get(`${origin}/api/runs/${first.runId}`)).json());
    const duplicateResponse = page.waitForResponse(response => response.url() === `${origin}/api/runs` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Start or reopen ↗' }).click();
    const duplicate = CommandResultSchema.parse(await (await duplicateResponse).json());
    expect(duplicate.runId).toBe(first.runId);
    expect(duplicate.commandId).toBe(first.commandId);
    expect(duplicate.disposition).toBe('reopened');

    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Synthetic durable browser lifecycle');
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('promiseguard.run.v2')!));
    expect(persisted.runId).toBe(first.runId);
    expect(Object.keys(persisted).every(key => ['runId', 'cursor'].includes(key))).toBe(true);
    await page.close();
    releaseNode();
    await expect.poll(async () => (await (await context.request.get(`${origin}/api/runs/${first.runId}`)).json()).productStatus).toBe('safely_blocked');
    const reopened = await context.newPage();
    await reopened.goto(origin);
    await expect(reopened.locator('.product-status')).toHaveText('⊘ Safely blocked');
    const after = RunViewSchema.parse(await (await context.request.get(`${origin}/api/runs/${first.runId}`)).json());
    expect(after.runId).toBe(before.runId);
    expect(after.evaluationAttemptId).toBe(before.evaluationAttemptId);
    expect(after.runtimeAttemptIds).toEqual(before.runtimeAttemptIds);
    expect(simulatedRoleCalls).toBe(1);
    const database = new DatabaseSync(config.storage.databasePath, { readOnly: true });
    try {
      for (const table of ['runs', 'attempts', 'runtime_attempts', 'workflow_commands'])
        expect(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(1);
      expect(database.prepare('SELECT count(*) AS n FROM model_attempts').get()!.n).toBe(0);
    } finally { database.close(); }
    const evidencePath = testInfo.outputPath('synthetic-http-lifecycle.json');
    writeFileSync(evidencePath, JSON.stringify({ runId: after.runId, evaluationAttemptId: after.evaluationAttemptId,
      runtimeAttemptIds: after.runtimeAttemptIds, productStatus: after.productStatus, simulatedRoleCalls,
      liveModelCalls: 0, liveProviderCalls: 0 }, null, 2));
    await testInfo.attach('Synthetic assembled HTTP lifecycle evidence', { contentType: 'application/json', path: evidencePath });
    await reopened.close();
  } finally {
    releaseNode();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// HTTP responses below are explicit public projection fixtures, not Q05 measurements.
test('simulated HTTP renders saved counts, partial controls, outage and session states at three viewports', async ({ page }, testInfo) => {
  const initial = fixtureRun('failed_partial');
  let current = RunViewSchema.parse({ ...initial, report: fixtureRun('zero_labels').report, reportAvailability: 'available' });
  const savedReport = current.report!;
  let denied: 'unauthenticated' | 'forbidden' | null = null;
  const commands: unknown[] = [];
  await page.addInitScript(token => {
    document.addEventListener('DOMContentLoaded', () => {
      const meta = document.createElement('meta'); meta.name = 'csrf-token'; meta.content = token; document.head.append(meta);
    });
  }, CSRF);
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const reply = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (denied) return reply({ schemaVersion: 2, code: denied, retryable: false, correlationId: 'synthetic-browser-denied' }, denied === 'unauthenticated' ? 401 : 403);
    if (request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe(CSRF);
      commands.push(request.postDataJSON());
      return reply({ schemaVersion: 2, commandId: 'synthetic-reconcile-command', runId: current.runId,
        revision: current.revision, productStatus: current.productStatus, disposition: 'not_eligible' }, 202);
    }
    if (path.endsWith('/events')) return reply({ schemaVersion: 2, runId: current.runId, runRevision: current.revision,
      events: [], nextCursor: 'synthetic_events_end', hasMore: false });
    if (path.endsWith('/trace')) return reply({ schemaVersion: 2, runId: current.runId, runRevision: current.revision,
      evaluationAttemptId: current.evaluationAttemptId, assessment: current.assessments.trace,
      attempts: [], nextCursor: 'synthetic_trace_end', hasMore: false });
    return reply(current);
  });
  await page.goto(`/?run=${encodeURIComponent(current.runId)}`);
  await expect(page.locator('.product-status')).toHaveText('! Failed partial');
  await expect(page.getByRole('link', { name: 'Open Slack review ↗', exact: true })).toHaveAttribute('href', initial.approval!.slackLink!);
  const summary = page.getByRole('region', { name: 'Reliability summary' });
  for (const [key, count] of Object.entries(savedReport.census))
    await expect(summary.locator(`[data-census-key="${key}"] dd`)).toHaveText(String(count));
  for (const metric of savedReport.metrics) {
    if ('denominator' in metric) await expect(summary.locator(`[data-metric-id="${metric.metricId}"][data-dimension="${metric.dimension}"]`))
      .toContainText(`${metric.numerator} / ${metric.denominator}`);
  }
  for (const count of savedReport.criticalCounts)
    await expect(summary.locator(`[data-critical-code="${count.code}"] strong`)).toHaveText(String(count.count ?? 'Unavailable'));
  await expect(summary).toContainText('Unverified (0 reviewed)');
  await expect(summary).toContainText('N/A (0 eligible)');
  for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    const { width, height } = viewport;
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const screenshot = testInfo.outputPath(`synthetic-http-${width}x${height}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`Synthetic HTTP projection ${width}×${height}`, { path: screenshot, contentType: 'image/png' });
  }
  await page.getByRole('button', { name: 'Request reconciliation' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'not_eligible' })).toBeVisible();
  expect(commands).toEqual([{ schemaVersion: 2, expectedRevision: current.revision }]);

  const update = (changes: Partial<RunView>) => {
    current = RunViewSchema.parse({ ...current, ...changes, runId: initial.runId, incident: initial.incident,
      evaluationAttemptId: initial.evaluationAttemptId, runtimeAttemptIds: initial.runtimeAttemptIds,
      configuration: initial.configuration, revision: current.revision + 1,
      updatedAt: new Date(Date.parse(current.updatedAt) + 1000).toISOString() });
  };
  update(fixtureRun('completed_pending_assessment'));
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.locator('.product-status')).toHaveText('✓ Completed');
  await expect(page.getByRole('region', { name: 'Run and assessment status' })).toContainText('Pending');
  await expect(page.getByRole('button', { name: 'Request reconciliation' })).toHaveCount(0);
  update({ report: null, reportAvailability: 'unavailable', assessments: { ...current.assessments,
    trace: { ...current.assessments.trace, status: 'unverified', gaps: [{ code: 'monitor_unavailable', referenceId: null }] } } });
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(summary).toContainText('monitor unavailable');
  await expect(summary).toContainText('Report unavailable');
  await expect(page.locator('.product-status')).toHaveText('✓ Completed');

  denied = 'unauthenticated';
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('session has expired');
  await expect(page.getByRole('button', { name: 'Start or reopen ↗' })).toBeDisabled();
  await expect(page.locator('.product-status')).toHaveText('✓ Completed');
  denied = 'forbidden';
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('do not have access');
  await expect(page.locator('.product-status')).toHaveText('✓ Completed');
  expect(commands).toHaveLength(1);
});
