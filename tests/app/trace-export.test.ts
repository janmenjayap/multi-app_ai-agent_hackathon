import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { ApplicationDatabase } from '../../src/server/storage/database.js';
import { ApplicationRepository } from '../../src/server/storage/repositories.js';
import { processApplicationJobs, readApplicationReport } from '../../src/server/monitoring/worker.js';
import { createLangSmithExporter, LangSmithRunSchema, projectTraceEvent, traceReference,
  type LangSmithExporter, type LangSmithRun, type TraceExportResult } from '../../src/server/observability/langsmith.js';
import { TraceExportOutbox, processTraceExports, startTraceExportWorker } from '../../src/server/observability/export-worker.js';
import { EvaluationAttemptRegistrationSchema, LogicalManifestSchema } from '../../src/shared/evaluation.js';
import { EventV2Schema, type EventV2 } from '../../src/shared/events.js';
import { EvaluationAttemptIdSchema, ExecutionModeSchema, IncidentIdentitySchema, RunIdSchema,
  RuntimeAttemptIdSchema } from '../../src/shared/domain.js';
import { digest } from '../../src/shared/reliability.js';

// Synthetic evidence only: no customer data, live credentials or provider calls.
const redactionKey = 'synthetic-export-key-0123456789abcdef';
const projectId = 'b62f9a50-9ff4-461d-980a-e4a60b10c204';
const workspaceId = '266e96f5-9fd3-48c5-bd49-70cfa5f5ad60';
const startedAt = '2026-09-14T10:00:00.000Z';
const startedAtMs = Date.parse(startedAt);
const policy = { leaseMs: 100, maxAttempts: 2, baseBackoffMs: 10, maxBackoffMs: 20 };
const configuration = ExecutionModeSchema.parse({ schemaVersion: 2, modelMode: 'mock', providerMode: 'fake',
  evidenceMode: 'synthetic_fixture', fixtureId: 'export-fixture' });
const incident = IncidentIdentitySchema.parse({ schemaVersion: 2, repositoryId: 'repository-1', issueId: 'issue-1',
  issueNumber: 1, canonicalUrl: 'https://github.com/fixture/project/issues/1', service: 'service-1', environment: 'test' });
const context = { producerVersion: 'export-test-v2', producerId: 'test-producer', runId: RunIdSchema.parse('run-1'),
  evaluationAttemptId: EvaluationAttemptIdSchema.parse('evaluation-1'), runtimeAttemptId: RuntimeAttemptIdSchema.parse('runtime-1'),
  stage: 'analyst' as const, spanId: 'stage-1', parentSpanId: null, causedBy: [] };
const manifest = LogicalManifestSchema.parse({ schemaVersion: 2, manifestId: 'export-manifest',
  cohortId: 'export-cohort', suiteEntryId: 'export-entry', family: 2, mode: 'synthetic_fixture',
  frozenAt: '2026-09-14T09:00:00Z', executionEligible: false, expectedUnsafe: false,
  variantId: 'baseline', repetition: 0, faultIds: [],
  budgets: { activeMs: 1000, humanWaitMs: 2000, wallMs: 3000, recoveryMs: 1000, maxToolAttempts: 10 },
  versions: { app: 'app-2', fixture: 'fixture-2', policy: 'policy-2', prompt: 'prompt-2', model: 'mock-2' },
  requiredRoles: [], expectedTerminalStatus: 'safely_blocked', effects: [], sourceFacts: [],
  protectedRecords: [{ app: 'hubspot', logicalId: 'protected-commitment' }],
  forbiddenEffects: ['send_email', 'delete', 'unapproved_write'],
  claimWindow: { maxEvidenceAgeMs: 1000, settlingMs: 100, cutoffAt: '2026-09-14T10:10:00Z' },
});
const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) close(); });

function event(fields: Record<string, unknown> = {}): EventV2 {
  return EventV2Schema.parse({ ...context, schemaVersion: 2, eventId: 'event-1', sequence: 1,
    at: startedAt, processId: 'process-1', bootId: 'boot-1', monotonicMs: 1, kind: 'stage.started', ...fields });
}
function projection(events = [event()]): LangSmithRun {
  return projectTraceEvent({ event: events.at(-1)!, spanEvents: events, configuration, redactionKey });
}
function ref(artifactId = 'private-artifact-canary') {
  return { artifactId, sha256: 'a'.repeat(64), byteLength: 37, mediaType: 'application/json' as const };
}
function exporter(transport: typeof fetch, options: Partial<Parameters<typeof createLangSmithExporter>[0]> = {}) {
  return createLangSmithExporter({ enabled: true, apiKey: 'synthetic-credential', projectId, workspaceId,
    redactionKey, fetch: transport, ...options });
}
function receipt(run: LangSmithRun, changes: Record<string, unknown> = {}) {
  return { id: run.id, session_id: projectId, parent_run_id: run.parent_run_id ?? null, extra: run.extra,
    app_path: `/o/${workspaceId}/projects/p/${projectId}/r/${run.id}`, ...changes };
}
function confirmed(run: LangSmithRun): Extract<TraceExportResult, { status: 'exported' }> {
  return { status: 'exported', remoteRunId: run.id, remoteUrl: null };
}
function syntheticExporter(send: LangSmithExporter['export'] = async run => confirmed(run), enabled = true): LangSmithExporter {
  return { destinationId: traceReference(redactionKey, 'destination', projectId), enabled, export: send };
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'promiseguard-trace-export-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'application.sqlite');
  const open = () => {
    const database = new ApplicationDatabase(path);
    cleanup.push(() => database.close());
    return { database, repository: new ApplicationRepository(database) };
  };
  const initialized = open();
  initialized.repository.transaction(context, tx => {
    tx.createRun({ runId: context.runId, incident, configuration, createdAt: startedAt });
    const source = tx.putArtifact({ artifactId: 'source-1', mediaType: 'application/json', content: { value: 'private-local-content' } });
    tx.registerEvaluation(EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2,
      runId: context.runId, evaluationAttemptId: context.evaluationAttemptId, suiteEntryId: manifest.suiteEntryId,
      manifestHash: digest(manifest), registeredAt: startedAt, dispatchAt: startedAt,
      preflightRef: source, s0Ref: source, configuration, leg: 'baseline',
    }), policy);
    tx.startRuntime({ runtimeAttemptId: context.runtimeAttemptId, runId: context.runId,
      evaluationAttemptId: context.evaluationAttemptId, startedAt });
    tx.appendEvent({ kind: 'stage.started' }, { eventId: 'event-1', at: startedAt,
      processId: 'process-1', bootId: 'boot-1', monotonicMs: 1 });
  });
  return { open, ...initialized };
}
function snapshot(repository: ApplicationRepository) {
  return { run: repository.getRun(context.runId), events: repository.readEvents({ runId: context.runId }),
    report: readApplicationReport(repository, { resolveManifest: () => manifest, nowMs: startedAtMs + 10 }),
    measurements: repository.database.monitor.listJobsV2(context.evaluationAttemptId),
    assessments: repository.database.monitor.listAssessmentsV2(context.evaluationAttemptId),
    registrations: repository.database.connection.prepare('SELECT * FROM attempts').all() };
}

test('projects stable stage/model/tool correlations while redacting arbitrary IDs and model metadata', () => {
  const root = projection();
  const modelStart = event({ kind: 'model.attempt.started', sequence: 2, eventId: 'event-model-start',
    spanId: 'model-span', parentSpanId: 'stage-1', role: 'analyst', logicalCallId: 'model-call',
    modelAttemptId: 'private-model-attempt', roleInvocationKey: JSON.stringify(['run-1', 1, 'analyst']), planRevision: 1,
    inputDigest: 'b'.repeat(64), configDigest: 'c'.repeat(64), promptVersion: 'private-prompt-canary',
    modelVersion: 'private-model-canary', outputSchemaVersion: 'private-schema-canary' });
  const modelResult = event({ kind: 'model.attempt.result', sequence: 3, eventId: 'event-model-result',
    spanId: 'model-span', parentSpanId: 'stage-1', role: 'analyst', logicalCallId: 'model-call',
    modelAttemptId: 'private-model-attempt', roleInvocationKey: JSON.stringify(['run-1', 1, 'analyst']), planRevision: 1,
    outputRef: ref(), validation: 'valid', latencyMs: 42, usage: { inputTokens: 10, outputTokens: 5 } });
  const model = projection([modelStart, modelResult]);
  const toolStart = event({ kind: 'tool.dispatch', sequence: 4, eventId: 'event-tool-start', spanId: 'tool-span',
    parentSpanId: 'stage-1', app: 'github', operation: 'github.resolveIncident', logicalCallId: 'tool-call',
    providerAttemptId: 'private-provider-attempt', actor: 'reader', effectKey: null, requestDigest: null,
    planHash: null, approvalId: null });
  const tool = projection([toolStart]);
  const verified = event({ kind: 'effect.verified', sequence: 5, eventId: 'event-verified',
    verificationId: 'private-verification-canary', effectKey: 'private-effect-canary', planHash: 'd'.repeat(64),
    artifactKind: 'comment', verdict: 'matched', readAttemptId: 'private-provider-attempt', receiptRef: ref() });
  const claimed = event({ kind: 'success.claimed', eventId: 'artifact-claim-event', sequence: 6, claim: {
    schemaVersion: 2, claimId: 'private-artifact-claim-canary', runId: context.runId,
    evaluationAttemptId: context.evaluationAttemptId, runtimeAttemptId: context.runtimeAttemptId,
    eventId: 'artifact-claim-event', sequence: 6, emittedAt: startedAt, scope: 'artifacts',
    planRef: ref(), planHash: 'd'.repeat(64), effectKeys: ['private-effect-canary'], verifications: [
      { verificationId: 'private-verification-canary', effectKey: 'private-effect-canary', kind: 'comment',
        observedAt: startedAt, receipt: ref() },
    ],
  } });
  const evidence = projection([event(), verified, claimed]);
  assert.equal(model.parent_run_id, root.id);
  assert.equal(tool.parent_run_id, root.id);
  assert.equal(model.id, projection([modelStart]).id);
  assert.equal(model.extra.metadata.runtimeAttemptId, root.extra.metadata.runtimeAttemptId);
  assert.equal(model.events[0]!.kwargs.modelAttemptId, model.events[1]!.kwargs.modelAttemptId);
  assert.equal(model.events[1]!.kwargs.latencyMs, 42);
  assert.deepEqual(model.events[1]!.kwargs.usage, { inputTokens: 10, outputTokens: 5 });
  assert.deepEqual(model.events[1]!.kwargs.evidenceRefs, [{ artifactId: traceReference(redactionKey, 'artifactId', ref().artifactId), sha256: ref().sha256 }]);
  assert.equal(tool.events[0]!.kwargs.providerAttemptId, traceReference(redactionKey, 'providerAttemptId', 'private-provider-attempt'));
  assert.equal(evidence.events[1]!.kwargs.readAttemptId, tool.events[0]!.kwargs.providerAttemptId);
  assert.deepEqual(evidence.events[2]!.kwargs.verificationIds, [evidence.events[1]!.kwargs.verificationId]);
  const serialized = JSON.stringify([root, model, tool, evidence]);
  for (const canary of ['private-', 'run-1', 'runtime-1', 'stage-1', 'model-span', 'tool-call', redactionKey])
    assert.ok(!serialized.includes(canary), canary);
  assert.notEqual(traceReference(redactionKey, 'eventId', 'event-1'), traceReference('different-synthetic-key-0123456789abcdef', 'eventId', 'event-1'));
});

test('nested success-claim evidence exports keyed references and excludes private free-form fields', () => {
  const claim = event({ kind: 'success.claimed', eventId: 'claim-event', sequence: 2, claim: {
    schemaVersion: 2, claimId: 'private-claim-canary', runId: context.runId,
    evaluationAttemptId: context.evaluationAttemptId, runtimeAttemptId: context.runtimeAttemptId,
    eventId: 'claim-event', sequence: 2, emittedAt: startedAt, scope: 'no_affected',
    sourceReceipts: [{ schemaVersion: 2, collectionId: 'private-collection-canary', app: 'github',
      accountRef: 'private-account-canary', producerId: 'private-producer-canary', startedAt, finishedAt: startedAt,
      status: 'incomplete', reason: 'page_failed', requiredQueryIds: ['private-query-canary'], pages: [
        { queryId: 'private-query-canary', cursor: null, nextCursor: 'recipient@example.invalid Bearer nested-canary',
          recordCount: 1, response: ref(), providerAttemptId: 'private-page-attempt-canary' },
      ] }], selection: { eligibleCount: 0, sourceComplete: false, policyVersion: 'private-policy-canary', receipt: ref('private-selection-canary') },
    absenceEvidence: [{ predicateId: 'private-predicate-canary', status: 'unverified', receipt: ref('private-absence-canary') }],
    protectedMutationCount: null, modelCallCount: null,
  } });
  const run = projection([event(), claim]);
  const last = run.events.at(-1)!.kwargs;
  assert.equal(last.claimId, traceReference(redactionKey, 'claimId', 'private-claim-canary'));
  assert.equal(last.evidenceRefs.length, 3);
  for (const canary of ['private-', 'recipient@example.invalid', 'Bearer', 'nested-canary', 'byteLength', 'mediaType'])
    assert.ok(!JSON.stringify(run).includes(canary), canary);
  assert.deepEqual(run.inputs, {});
  assert.deepEqual(run.outputs, {});
  assert.throws(() => projection([event({ extra: { authorization: 'Bearer forbidden' } })]));
});

test('duplicate REST delivery upserts the stable run and exposes only its confirmed private link', async () => {
  const run = projection();
  const requests: { url: string; method: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'synthetic-credential');
    assert.equal(new Headers(init?.headers).get('x-tenant-id'), workspaceId);
    requests.push({ url: String(input), method: init!.method!, body: init?.body ? JSON.parse(String(init.body)) : null });
    return init?.method === 'POST' ? new Response(null, { status: 409 }) : init?.method === 'PATCH'
      ? new Response(null, { status: 200 }) : Response.json(receipt(run));
  };
  const client = exporter(transport);
  const first = await client.export(run);
  assert.deepEqual(await client.export(run), first);
  assert.deepEqual(first, { status: 'exported', remoteRunId: run.id,
    remoteUrl: `https://smith.langchain.com/o/${workspaceId}/projects/p/${projectId}/r/${run.id}` });
  assert.deepEqual(requests.map(item => item.method), ['POST', 'PATCH', 'GET', 'POST', 'PATCH', 'GET']);
  assert.deepEqual(requests[0]!.body, requests[3]!.body);
  assert.equal((requests[0]!.body as { session_id: string }).session_id, projectId);
  assert.ok(requests.every(item => item.url.startsWith('https://api.smith.langchain.com/runs')));
});

test('unconfirmed identity or digest never succeeds and malformed links never become saved URLs', async () => {
  const run = projection();
  const send = (changes: Record<string, unknown>) => exporter(async (_input, init) =>
    init?.method === 'GET' ? Response.json(receipt(run, changes)) : new Response(null, { status: 200 })).export(run);
  for (const changes of [{ id: workspaceId }, { session_id: workspaceId }, { parent_run_id: projectId },
    { extra: { metadata: { projectionDigest: 'd'.repeat(64) } } }]) {
    assert.deepEqual(await send(changes), { status: 'retryable', errorCode: 'unconfirmed' });
  }
  for (const path of ['https://outside.invalid/collect', '//outside.invalid/collect',
    `/o/${workspaceId}/projects/p/${workspaceId}/r/${run.id}`, `/o/${workspaceId}/projects/p/${projectId}/r/${run.id}?token=private`]) {
    assert.deepEqual(await send({ app_path: path }), { status: 'exported', remoteRunId: run.id, remoteUrl: null });
  }
});

test('disabled, missing credentials, HTTP failures and timeout retain explicit bounded outcomes', async () => {
  const run = projection();
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; return new Response(null, { status: 200 }); };
  assert.deepEqual(await exporter(transport, { enabled: false }).export(run), { status: 'unavailable', errorCode: 'disabled' });
  assert.deepEqual(await exporter(transport, { apiKey: undefined }).export(run), { status: 'unavailable', errorCode: 'credentials_unavailable' });
  assert.equal(calls, 0);
  for (const [status, expected] of [[429, { status: 'retryable', errorCode: 'rate_limited', retryAfterMs: 3000 }],
    [503, { status: 'retryable', errorCode: 'service_unavailable' }],
    [401, { status: 'permanent', errorCode: 'denied' }], [400, { status: 'permanent', errorCode: 'rejected' }]] as const) {
    assert.deepEqual(await exporter(async () => new Response('private-error-canary', { status,
      headers: { 'retry-after': '3' } })).export(run), expected);
  }
  vi.useFakeTimers();
  let aborted = false;
  const hanging: typeof fetch = async (_input, init) => {
    init!.signal!.addEventListener('abort', () => { aborted = true; });
    return new Promise<Response>(() => {});
  };
  const pending = exporter(hanging, { timeoutMs: 20 }).export(run);
  await vi.advanceTimersByTimeAsync(20);
  assert.deepEqual(await pending, { status: 'retryable', errorCode: 'timeout' });
  assert.equal(aborted, true);
});

test('tampered or widened persisted projections are rejected before remote dispatch', async () => {
  const run = projection();
  let calls = 0;
  const client = exporter(async () => { calls++; throw new Error('unexpected dispatch'); });
  const altered = LangSmithRunSchema.parse({ ...run, name: 'select' });
  assert.deepEqual(await client.export(altered), { status: 'permanent', errorCode: 'invalid_projection' });
  const raw = structuredClone(run) as unknown as Record<string, unknown>;
  raw.inputs = { prompt: 'private-prompt-canary' };
  assert.deepEqual(await client.export(raw as unknown as LangSmithRun), { status: 'permanent', errorCode: 'invalid_projection' });
  assert.equal(calls, 0);
});

test('disabled, successful and failed export preserve the same local assessment and denominator', async () => {
  for (const mode of ['disabled', 'success', 'failure'] as const) {
    const { database, repository } = setup();
    processApplicationJobs(repository, { resolveManifest: () => manifest, clock: () => startedAtMs + 10 });
    const before = snapshot(repository);
    let dispatches = 0;
    const outbox = new TraceExportOutbox(repository, syntheticExporter(async run => {
      dispatches++;
      assert.equal(database.connection.isTransaction, false, 'remote dispatch never holds the application transaction');
      return mode === 'success' ? confirmed(run) : { status: 'permanent', errorCode: 'denied' };
    }, mode !== 'disabled'), { redactionKey, policy, clock: () => startedAtMs + 10 });
    const result = await processTraceExports(outbox);
    assert.equal(result.errorCode, null);
    assert.equal(dispatches, mode === 'disabled' ? 0 : 1);
    assert.equal(outbox.list().length, mode === 'disabled' ? 0 : 1);
    if (mode !== 'disabled') assert.equal(outbox.list()[0]!.status, mode === 'success' ? 'completed' : 'exhausted');
    assert.equal((await processTraceExports(outbox)).attempted, 0, 'duplicate scan never dispatches completed/exhausted exports');
    assert.deepEqual(snapshot(repository), before, mode);
    assert.equal(before.report.assessments.length, 1, 'exactly one registered evaluation remains counted');
  }
});

test('restart reclaims expired leases with stable remote IDs and fences the crashed owner', () => {
  const { database, repository, open } = setup();
  let now = startedAtMs + 10;
  let token = 0;
  const options = { redactionKey, policy, clock: () => now, newLeaseToken: () => `lease-${++token}` };
  const outbox = new TraceExportOutbox(repository, syntheticExporter(), options);
  assert.equal(outbox.enqueue(), 1);
  assert.equal(outbox.enqueue(), 0);
  const old = outbox.claim()!;
  database.close();
  const reopened = open();
  const next = new TraceExportOutbox(reopened.repository, syntheticExporter(), options);
  assert.equal(next.claim(), null);
  now += policy.leaseMs;
  const current = next.claim()!;
  assert.equal(current.attempts, 2);
  assert.equal(current.exportId, old.exportId);
  assert.deepEqual(current.payload, old.payload);
  assert.notEqual(current.leaseToken, old.leaseToken);
  assert.equal(next.complete(old, confirmed(old.payload)), false);
  assert.equal(next.fail(old, { status: 'retryable', errorCode: 'transport_error' }), false);
  assert.equal(next.complete(current, confirmed(current.payload)), true);
  assert.equal(next.claim(), null);
  assert.equal(next.list()[0]!.remoteRunId, old.payload.id);
});

test('retry backoff and crash exhaustion survive reopening without leaking raw errors', () => {
  const { database, repository, open } = setup();
  let now = startedAtMs;
  const options = { redactionKey, policy, clock: () => now };
  const outbox = new TraceExportOutbox(repository, syntheticExporter(), options);
  outbox.enqueue();
  const first = outbox.claim()!;
  assert.equal(outbox.fail(first, { status: 'retryable', errorCode: 'private-provider-error', retryAfterMs: 15 }), true);
  assert.equal(outbox.list()[0]!.errorCode, 'trace_export_failed');
  assert.equal(outbox.list()[0]!.nextAttemptAt, now + 15);
  database.close();
  const reopened = open();
  const next = new TraceExportOutbox(reopened.repository, syntheticExporter(), options);
  now += 14;
  assert.equal(next.claim(), null);
  now++;
  assert.equal(next.claim()!.attempts, 2);
  now += policy.leaseMs;
  assert.equal(next.claim(), null, 'second crash exhausts durable attempts');
  assert.equal(next.list()[0]!.status, 'exhausted');
  assert.equal(next.list()[0]!.remoteUrl, null);
  assert.equal(next.enqueue(), 0);
});

test('optional worker keeps local work usable during an unavailable service and coalesces flushes', async () => {
  const { repository } = setup();
  let release!: (value: TraceExportResult) => void;
  let dispatches = 0;
  const outbox = new TraceExportOutbox(repository, syntheticExporter(async () => {
    dispatches++;
    return new Promise<TraceExportResult>(resolve => { release = resolve; });
  }), { redactionKey, policy, clock: () => startedAtMs + 10 });
  const lifecycle = startTraceExportWorker(outbox, { intervalMs: 1000, maxJobs: 1 });
  const first = lifecycle.flush();
  assert.equal(lifecycle.flush(), first);
  assert.equal(dispatches, 1);
  assert.equal(processApplicationJobs(repository, { resolveManifest: () => manifest, clock: () => startedAtMs + 10 }).processed, 1);
  const during = snapshot(repository);
  release({ status: 'unavailable', errorCode: 'credentials_unavailable' });
  assert.equal((await first).failed, 1);
  await lifecycle.stop();
  assert.equal(outbox.list()[0]!.status, 'exhausted');
  assert.equal(outbox.list()[0]!.errorCode, 'credentials_unavailable');
  assert.deepEqual(snapshot(repository), during);
});

test('the trace migration upgrades a prior application database without changing local evidence', () => {
  const { database, repository, open } = setup();
  const before = snapshot(repository);
  // Reconstruct the previous durable schema while retaining actual B01/Q03 rows.
  database.connection.exec('DROP TABLE trace_exports');
  database.connection.prepare('DELETE FROM application_migrations WHERE migration_id = 3').run();
  database.close();
  const reopened = open();
  assert.deepEqual(snapshot(reopened.repository), before);
  assert.equal(new TraceExportOutbox(reopened.repository, syntheticExporter(), {
    redactionKey, policy, clock: () => startedAtMs + 10,
  }).enqueue(), 1);
});
