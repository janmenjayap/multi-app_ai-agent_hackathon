import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, test } from 'vitest';
import { ApplicationDatabase } from '../../src/server/storage/database.js';
import { ApplicationRepository } from '../../src/server/storage/repositories.js';
import { registerRunRoutes, type RunCommandDriver, type RunStateProjection } from '../../src/server/api/runs.js';
import { registerHealthRoutes } from '../../src/server/api/health.js';
import type { OperatorSession } from '../../src/server/api/auth.js';
import { createWorkflowApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/index.js';
import { ApiErrorSchema, AssessmentsViewSchema, CommandResultSchema, PlanViewSchema, RunEventsPageSchema, RunViewSchema, TraceViewSchema,
  type RunView } from '../../src/shared/api.js';
import { EvaluationAttemptRegistrationSchema } from '../../src/shared/evaluation.js';
import { EventV2Schema } from '../../src/shared/events.js';
import { EvaluationAttemptIdSchema, IncidentIdentitySchema, PIPELINE_STAGE_IDS, RunIdSchema, RuntimeAttemptIdSchema } from '../../src/shared/domain.js';

// Contract fixtures exercise HTTP projections only. driver.test.ts proves scheduling and command durability.
const nowMs = Date.parse('2026-09-14T09:05:00Z');
const at = '2026-09-14T09:00:00.000Z';
const runId = RunIdSchema.parse('api-run-1');
const evaluationAttemptId = EvaluationAttemptIdSchema.parse('api-evaluation-1');
const runtimeAttemptId = RuntimeAttemptIdSchema.parse('api-runtime-1');
const policy = { leaseMs: 100, maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1 };
function fixtures(id: string) {
  const planned = id !== 'queued';
  const plan = PlanViewSchema.parse({ revision: 1, planHash: 'a'.repeat(64),
    entries: [{ commitmentId: 'commitment-1', companyId: 'company-1', ownerId: 'owner-1', recipient: 'recipient@example.test',
      subject: 'Synthetic update', body: 'Synthetic approved update', draftOnly: true }],
    orderedEffectKeys: ['task-1', 'note-1', 'draft-1', 'comment-1', 'thread-1'],
    contents: [{ contentKey: 'content-1', text: 'Synthetic approved update', sha256: 'b'.repeat(64) }],
    effects: [
      { effectKey: 'task-1', app: 'hubspot', kind: 'task', commitmentId: 'commitment-1', requestDigest: '1'.repeat(64),
        payload: { companyId: 'company-1', commitmentId: 'commitment-1', ownerId: 'owner-1', dueAt: '2026-09-15T09:00:00Z',
          status: 'NOT_STARTED', subject: 'Synthetic review', body: [{ type: 'text', text: 'Synthetic task' }] } },
      { effectKey: 'note-1', app: 'hubspot', kind: 'note', commitmentId: 'commitment-1', requestDigest: '2'.repeat(64),
        payload: { companyId: 'company-1', commitmentId: 'commitment-1', taskId: { type: 'effect_id', effectKey: 'task-1' },
          body: [{ type: 'text', text: 'Synthetic note' }] } },
      { effectKey: 'draft-1', app: 'gmail', kind: 'draft', commitmentId: 'commitment-1', requestDigest: '3'.repeat(64),
        payload: { to: 'recipient@example.test', cc: [], bcc: [], subject: 'Synthetic update', isDraft: true,
          body: [{ type: 'approved_content', planRevision: 1, contentKey: 'content-1' }] } },
      { effectKey: 'comment-1', app: 'github', kind: 'comment', commitmentId: null, requestDigest: '4'.repeat(64),
        payload: { repositoryId: 'repository-1', issueId: 'issue-1', taskIds: [{ type: 'effect_id', effectKey: 'task-1' }],
          draftIds: [{ type: 'effect_id', effectKey: 'draft-1' }], body: [{ type: 'text', text: 'Synthetic comment' }] } },
      { effectKey: 'thread-1', app: 'slack', kind: 'thread', commitmentId: null, requestDigest: '5'.repeat(64),
        payload: { channelId: 'channel-1', threadTs: 'thread-1', body: [{ type: 'text', text: 'Synthetic summary' }] } },
    ] });
  const unavailable = { status: 'pending', coverage: 'unavailable', evaluatorVersion: null, assessmentRevision: null,
    observedAt: null, watermark: null, requiredCount: 0, confirmedCount: 0, humanLabelCount: null, gaps: [] };
  return RunViewSchema.parse({ schemaVersion: 2, runId, revision: 1, evaluationAttemptId, runtimeAttemptIds: [runtimeAttemptId],
    incident: { url: 'https://github.com/promiseguard-synthetic/checkout/issues/42', title: 'Synthetic incident', service: 'checkout', environment: 'test' },
    configuration: { schemaVersion: 2, modelMode: 'mock', providerMode: 'fake', evidenceMode: 'synthetic_fixture', fixtureId: 'api-synthetic-v2' },
    productStatus: id === 'queued' ? 'queued' : id === 'failed_partial' ? 'failed_partial' : 'completed', statusReason: null,
    stages: PIPELINE_STAGE_IDS.map(stageId => ({ stageId, role: ['analyst', 'drafter', 'auditor'].includes(stageId) ? stageId : null,
      status: 'not_started', startedAt: null, updatedAt: null, attemptCount: 0, latestAttemptRef: null, reason: null })),
    commitments: { status: planned ? 'selected' : 'pending', policyVersion: planned ? 'policy-v2' : null,
      selected: planned ? [{ commitmentId: 'commitment-1', company: 'Synthetic company', reason: 'affected_service' }] : [], excluded: [], evidenceRefs: [] },
    plan: planned ? plan : null, approval: null,
    effects: planned ? plan.effects.map((effect, index) => {
      const state = id === 'failed_partial' && index >= 2 ? index === 2 ? 'inflight' : 'planned' : 'verified';
      return { effectKey: effect.effectKey, app: effect.app, kind: effect.kind, state,
        outcome: state === 'verified' ? 'applied' : state === 'inflight' ? 'unknown' : 'unattempted',
        result: state === 'verified' ? 'created' : null, providerId: state === 'verified' ? `synthetic-provider-${index}` : null,
        providerLink: null, verifiedAt: state === 'verified' ? '2026-09-14T09:04:00Z' : null,
        comparison: state === 'verified' ? 'matched' : 'unverified', comparisons: [],
        readbackRef: state === 'verified' ? { referenceId: `synthetic-readback-${index}`, label: 'Synthetic readback',
          availability: 'available', href: `/api/evidence/synthetic-readback-${index}` } : null };
    }) : [],
    assessments: { trace: unavailable, outcome: unavailable, firstProposal: unavailable, selectedPlan: null },
    report: null, reportAvailability: 'unavailable', createdAt: at, updatedAt: '2026-09-14T09:05:00Z',
    verifiedAt: id === 'completed_pending_assessment' ? '2026-09-14T09:04:00Z' : null });
}
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const database = new ApplicationDatabase(':memory:'), repository = new ApplicationRepository(database);
  cleanup.push(() => database.close());
  const template = fixtures('queued');
  const incident = IncidentIdentitySchema.parse({ schemaVersion: 2, repositoryId: 'api-repository', issueId: 'api-issue', issueNumber: 42,
    canonicalUrl: template.incident.url, service: template.incident.service, environment: template.incident.environment });
  const context = { producerVersion: 'api-test-v2', producerId: 'api-test', runId, evaluationAttemptId, runtimeAttemptId,
    stage: 'ingest' as const, spanId: 'api-span', parentSpanId: null, causedBy: [] };
  let tick = 0;
  const stamp = () => ({ eventId: `api-event-${++tick}`, at, processId: 'api-process', bootId: 'api-boot', monotonicMs: tick });
  repository.transaction(context, tx => {
    tx.createRun({ runId, incident, configuration: template.configuration, createdAt: at });
    const source = tx.putArtifact({ artifactId: 'private-source', mediaType: 'application/json', content: '{"private":"never expose provider payload"}' });
    tx.registerEvaluation(EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2, runId, evaluationAttemptId,
      suiteEntryId: 'api-synthetic-entry', manifestHash: 'a'.repeat(64), registeredAt: at, dispatchAt: at,
      preflightRef: source, s0Ref: source, configuration: template.configuration, leg: 'baseline' }), policy);
    tx.startRuntime({ runtimeAttemptId, runId, evaluationAttemptId, startedAt: at });
    tx.appendEvent({ kind: 'stage.started' }, stamp());
    tx.appendEvent({ kind: 'sources.collected', complete: false, collectionRefs: [source] }, stamp());
    tx.appendEvent({ kind: 'run.status', status: 'queued' }, stamp());
  });
  let session: OperatorSession | null = { operatorId: 'operator-1', expiresAt: '2026-09-14T10:00:00Z', csrfToken: 'csrf-test-token',
    allowedRunIds: [], allowedRepositories: ['promiseguard-synthetic/checkout'], allowedEvidenceIds: [] };
  let state: RunStateProjection = { ...template, incidentTitle: template.incident.title, evaluationAttemptId, runtimeAttemptIds: [runtimeAttemptId], ownerId: 'operator-1' };
  let monitorReady = true, storageReady = true, checkpointsReady = true, accepts = 0, reconciles = 0;
  let savedAssessments: RunView['assessments'] | null = null;
  let lastStoredRevision = -1;
  const driver: RunCommandDriver = {
    readState: id => id === runId ? state : null,
    accept: () => { accepts++; return CommandResultSchema.parse({ schemaVersion: 2, commandId: `api-command-${accepts}`, runId,
      revision: repository.getRun(runId)!.revision, productStatus: repository.getRun(runId)!.status, disposition: 'reopened' }); },
    reconcile: (_id, revision) => { reconciles++; lastStoredRevision = revision; return CommandResultSchema.parse({ schemaVersion: 2,
      commandId: `reconcile-command-${reconciles}`, runId, revision, productStatus: repository.getRun(runId)!.status, disposition: 'not_eligible' }); },
  };
  const app = Fastify({ logger: false });
  registerRunRoutes(app, { driver, repository, auth: { resolveSession: () => session, clock: () => nowMs }, monitorReady: () => monitorReady,
    readAssessments: () => savedAssessments });
  registerHealthRoutes(app, { storageReady: () => storageReady, checkpointsReady: () => checkpointsReady, monitorReady: () => monitorReady });
  await app.ready(); cleanup.push(() => app.close());
  return { app, database, repository, incident,
    setSession: (value: OperatorSession | null) => { session = value; }, session: () => session!,
    setMonitorReady: (value: boolean) => { monitorReady = value; },
    setAssessments: (value: RunView['assessments']) => { savedAssessments = value; },
    setStorageReady: (value: boolean) => { storageReady = value; }, setCheckpointsReady: (value: boolean) => { checkpointsReady = value; },
    calls: () => ({ accepts, reconciles, lastStoredRevision }),
    setFixture: (id: string) => {
      const fixture = fixtures(id); state = { ...fixture, incidentTitle: fixture.incident.title, evaluationAttemptId, runtimeAttemptIds: [runtimeAttemptId], ownerId: 'operator-1' };
      const original = repository.getRun.bind(repository);
      // Only the public contract fixture's product projection changes; no fake protected write is executed.
      repository.getRun = requested => { const run = original(requested); return run ? { ...run, status: fixture.productStatus, updatedAt: fixture.updatedAt } : null; };
    },
    setPrivateTitle: () => { state = { ...state, incidentTitle: 'Bearer private-token-from-provider' }; },
  };
}
const read = (app: FastifyInstance, tail = '') => app.inject({ url: `/api/runs/${runId}${tail}` });
const post = (app: FastifyInstance, payload: unknown, csrf = 'csrf-test-token') =>
  app.inject({ method: 'POST', url: '/api/runs', headers: { 'x-csrf-token': csrf }, payload: payload as Record<string, unknown> });

test('operator access, expiry, CSRF and strict commands reject client authority before driver acceptance', async () => {
  const fixture = await setup(); const { app, incident } = fixture;
  const body = { schemaVersion: 2, incidentUrl: incident.canonicalUrl };
  const accepted = await post(app, body);
  assert.equal(accepted.statusCode, 202); CommandResultSchema.parse(accepted.json());
  for (const patch of [{ productStatus: 'completed' }, { approved: true }, { provenance: 'live_provider' }, { observations: [] }, { node: 'execute' }]) {
    const response = await post(app, { ...body, ...patch }); assert.equal(response.statusCode, 400);
    assert.equal(ApiErrorSchema.parse(response.json()).code, 'invalid_request');
  }
  assert.equal((await post(app, body, 'wrong')).json().code, 'csrf_failed');
  fixture.setSession({ ...fixture.session(), operatorId: 'other-operator' });
  assert.equal((await read(app)).json().code, 'forbidden');
  assert.equal((await post(app, body)).json().code, 'forbidden');
  fixture.setSession({ ...fixture.session(), expiresAt: '2026-09-14T09:05:00Z' });
  assert.equal((await read(app)).statusCode, 401);
  fixture.setSession(null); assert.equal((await post(app, body)).statusCode, 401);
  assert.equal(fixture.calls().accepts, 1);
});

test('event cursors reconnect without duplication, bind run and stream, and expose no restricted payload', async () => {
  const fixture = await setup(); const { app, repository } = fixture;
  const first = RunEventsPageSchema.parse((await read(app, '/events?limit=1')).json());
  const second = RunEventsPageSchema.parse((await read(app, `/events?limit=1&after=${first.nextCursor}`)).json());
  const replay = RunEventsPageSchema.parse((await read(app, `/events?limit=1&after=${first.nextCursor}`)).json());
  assert.deepEqual(second, replay); assert.notEqual(first.events[0]!.eventId, second.events[0]!.eventId);
  assert.equal(second.events[0]!.reference?.href, null); assert.equal(second.events[0]!.reference?.availability, 'unavailable');
  const end = RunEventsPageSchema.parse((await read(app, `/events?after=${second.nextCursor}`)).json());
  assert.equal(end.hasMore, false);
  assert.equal((await read(app, `/trace?after=${first.nextCursor}`)).statusCode, 400);
  assert.equal((await read(app, '/events?after=hostile')).statusCode, 400);
  assert.equal((await read(app, '/events?limit=201')).statusCode, 400);
  TraceViewSchema.parse((await read(app, '/trace')).json());
  fixture.setFixture('failed_partial');
  const base = repository.readEvents({ runId })[0]!;
  const events = [0, 1].map(index => EventV2Schema.parse({ ...base, sequence: index + 1, eventId: `trace-model-${index}`,
    kind: 'model.attempt.started', stage: 'analyst', spanId: `model-span-${index}`, parentSpanId: 'api-span', role: 'analyst',
    planRevision: 1, roleInvocationKey: JSON.stringify([runId, 1, 'analyst']), logicalCallId: 'model-call', modelAttemptId: `model-${index}`,
    inputDigest: 'a'.repeat(64), configDigest: 'b'.repeat(64), promptVersion: 'prompt-1', modelVersion: 'model-1', outputSchemaVersion: 'output-1' }));
  events.push(EventV2Schema.parse({ ...base, sequence: 3, eventId: 'terminal-event', kind: 'run.status', status: 'failed_partial' }));
  repository.readEvents = ({ afterSequence = 0, limit = 1000 }) => events.filter(event => event.sequence > afterSequence).slice(0, limit);
  const traceFirst = TraceViewSchema.parse((await read(app, '/trace?limit=1')).json());
  const traceSecond = TraceViewSchema.parse((await read(app, `/trace?limit=1&after=${traceFirst.nextCursor}`)).json());
  assert.equal(traceFirst.attempts[0]!.type === 'model' && traceFirst.attempts[0]!.outcome, 'unknown');
  assert.equal(traceFirst.attempts[0]!.finishedAt, null);
  assert.notDeepEqual(traceFirst.attempts, traceSecond.attempts); assert.equal(traceSecond.hasMore, false);
  assert.deepEqual(TraceViewSchema.parse((await read(app, `/trace?after=${traceSecond.nextCursor}`)).json()).attempts, []);
});

test('pending, exhausted and monitor unavailable assessments preserve product state with stable increasing revisions', async () => {
  const fixture = await setup(); const { app, database, repository } = fixture;
  const initial = RunViewSchema.parse((await read(app)).json());
  assert.equal(initial.assessments.trace.status, 'pending'); assert.equal(initial.assessments.trace.observedAt, null);
  assert.equal(initial.reportAvailability, 'unavailable'); assert.equal(initial.report, null);
  assert.deepEqual((await read(app)).json(), initial);
  const job = database.monitor.claimJobV2(nowMs, policy)!; database.monitor.failJobV2(job, nowMs + 1, policy);
  const exhausted = RunViewSchema.parse((await read(app)).json());
  assert.ok(exhausted.revision > initial.revision); assert.equal(exhausted.productStatus, initial.productStatus);
  assert.equal(exhausted.assessments.trace.status, 'unverified'); assert.equal(exhausted.assessments.trace.gaps[0]!.code, 'measurement_job_exhausted');
  const stale = await app.inject({ method: 'POST', url: `/api/runs/${runId}/reconcile`, headers: { 'x-csrf-token': 'csrf-test-token' }, payload: { schemaVersion: 2, expectedRevision: initial.revision } });
  assert.equal(stale.statusCode, 409); assert.equal(fixture.calls().reconciles, 0);
  const current = await app.inject({ method: 'POST', url: `/api/runs/${runId}/reconcile`, headers: { 'x-csrf-token': 'csrf-test-token' }, payload: { schemaVersion: 2, expectedRevision: exhausted.revision } });
  assert.equal(current.statusCode, 202); assert.equal(fixture.calls().lastStoredRevision, repository.getRun(runId)!.revision);
  fixture.setMonitorReady(false);
  const outage = RunViewSchema.parse((await read(app)).json()); assert.ok(outage.revision > exhausted.revision);
  assert.equal(outage.assessments.trace.gaps[0]!.code, 'monitor_unavailable');
  const trace = TraceViewSchema.parse((await read(app, '/trace')).json()); assert.deepEqual(trace.attempts, []);
  assert.deepEqual((await app.inject('/api/evaluations/latest')).json(), { schemaVersion: 2, availability: 'unavailable', report: null });
});

test('completed and partial fixture projections retain independent assessment failure and redact evidence links', async () => {
  const fixture = await setup(); const { app, database } = fixture;
  fixture.setFixture('completed_pending_assessment');
  const pending = RunViewSchema.parse((await read(app)).json()); assert.equal(pending.productStatus, 'completed');
  assert.equal(pending.assessments.outcome.status, 'pending'); assert.equal(pending.effects[0]!.readbackRef!.href, null);
  assert.equal(pending.effects[0]!.readbackRef!.availability, 'unauthorized');
  const job = database.monitor.claimJobV2(nowMs, policy)!;
  const assessment = { schemaVersion: 2, evaluatorVersion: 'monitor-v2', evaluationAttemptId, runId, watermark: job.watermark, observedAtMs: nowMs };
  database.monitor.completeJobV2(job, nowMs + 1, assessment);
  const missing = RunViewSchema.parse((await read(app)).json());
  assert.equal(missing.assessments.outcome.status, 'unverified');
  assert.equal(missing.assessments.outcome.gaps[0]!.code, 'assessment_projection_unavailable');
  fixture.setAssessments(AssessmentsViewSchema.parse({ ...pending.assessments, outcome: {
    status: 'fail', coverage: 'incomplete', evaluatorVersion: 'monitor-v2', assessmentRevision: job.watermark,
    observedAt: new Date(nowMs).toISOString(), watermark: String(job.watermark), requiredCount: 9, confirmedCount: 8,
    humanLabelCount: null, gaps: [{ code: 'outcome_mismatch', referenceId: null }] } }));
  const failed = RunViewSchema.parse((await read(app)).json());
  assert.equal(failed.productStatus, 'completed'); assert.equal(failed.assessments.outcome.status, 'fail');
  assert.equal(failed.assessments.outcome.requiredCount, 9); assert.equal(failed.assessments.outcome.confirmedCount, 8);
  assert.ok(failed.revision > pending.revision);
  fixture.setFixture('failed_partial');
  const partial = RunViewSchema.parse((await read(app)).json()); assert.equal(partial.productStatus, 'failed_partial');
  assert.ok(partial.effects.some(effect => effect.state === 'verified'));
  assert.ok(partial.effects.some(effect => effect.outcome === 'unknown'));
  assert.ok(partial.effects.some(effect => effect.state === 'planned'));
});

test('readiness requires both stores and safe errors never return provider secrets', async () => {
  const fixture = await setup(); const { app } = fixture;
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  fixture.setMonitorReady(false); assert.equal((await app.inject('/healthz')).json().monitor, 'unavailable');
  fixture.setStorageReady(false); assert.equal((await app.inject('/healthz')).statusCode, 503);
  fixture.setStorageReady(true); fixture.setCheckpointsReady(false); assert.equal((await app.inject('/healthz')).statusCode, 503);
  fixture.setPrivateTitle(); const response = await read(app);
  assert.equal(response.statusCode, 500); const error = ApiErrorSchema.parse(response.json());
  assert.equal(error.code, 'internal_error'); assert.equal(response.headers['x-correlation-id'], error.correlationId);
  assert.ok(!response.body.includes('private-token')); assert.equal(response.headers['cache-control'], 'no-store');
});

test('the composed application durably accepts duplicate HTTP commands before invoking injected graph nodes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'promiseguard-api-app-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const configuration = fixtures('queued').configuration;
  const config = loadConfig({ PG_FIXTURE_ID: configuration.fixtureId!, PG_DATABASE_PATH: join(directory, 'application.sqlite'),
    PG_CHECKPOINT_PATH: join(directory, 'checkpoints.sqlite'), PG_EVIDENCE_DIR: join(directory, 'evidence') });
  const incident = IncidentIdentitySchema.parse({ schemaVersion: 2, repositoryId: 'composed-repository', issueId: 'composed-issue', issueNumber: 42,
    canonicalUrl: 'https://github.com/promiseguard-synthetic/checkout/issues/42', service: 'checkout', environment: 'test' });
  let nodeCalls = 0;
  let operatorId = 'operator-1';
  const app = await createWorkflowApp(config, { auth: { clock: () => nowMs, resolveSession: () => ({ operatorId,
    expiresAt: '2026-09-14T10:00:00Z', csrfToken: 'csrf-test-token', allowedRunIds: '*', allowedRepositories: ['promiseguard-synthetic/checkout'] }) },
    workflow: { configuration, clock: () => nowMs, pollMs: 60000, nodes: { ingest: async () => {
      nodeCalls++; return { kind: 'stop', status: 'safely_blocked', reason: 'synthetic_boundary' };
    } }, prepare: async () => ({ incident, title: 'Synthetic API integration fixture', register: (writer, identity) => {
      const receipt = writer.putArtifact({ artifactId: `${identity.runId}-fixture`, mediaType: 'application/json', content: { mode: 'synthetic_fixture' } });
      return EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2, runId: identity.runId, evaluationAttemptId: identity.evaluationAttemptId,
        suiteEntryId: 'api-composed-entry', manifestHash: 'b'.repeat(64), registeredAt: identity.at, dispatchAt: identity.at,
        preflightRef: receipt, s0Ref: receipt, configuration, leg: 'baseline' });
    } }) } });
  cleanup.push(() => app.close());
  const responses = await Promise.all([post(app, { schemaVersion: 2, incidentUrl: incident.canonicalUrl }),
    post(app, { schemaVersion: 2, incidentUrl: incident.canonicalUrl })]);
  const commands = responses.map(response => { assert.equal(response.statusCode, 202); return CommandResultSchema.parse(response.json()); });
  assert.equal(commands[0]!.runId, commands[1]!.runId); assert.equal(commands[0]!.commandId, commands[1]!.commandId);
  assert.equal(nodeCalls, 0);
  const persisted = new DatabaseSync(config.storage.databasePath, { readOnly: true });
  try {
    assert.equal(persisted.prepare('SELECT count(*) AS n FROM workflow_commands').get()!.n, 1);
    assert.equal(persisted.prepare('SELECT command_id FROM workflow_commands').get()!.command_id, commands[0]!.commandId);
  } finally { persisted.close(); }
  const view = RunViewSchema.parse((await app.inject(`/api/runs/${commands[0]!.runId}`)).json());
  assert.equal(view.productStatus, 'queued'); assert.equal(view.revision, commands[0]!.revision);
  operatorId = 'explicit-viewer-without-command-ownership';
  const denied = await post(app, { schemaVersion: 2, incidentUrl: incident.canonicalUrl });
  assert.equal(denied.statusCode, 403); assert.equal(denied.json().code, 'forbidden');
});
