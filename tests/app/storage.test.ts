/// <reference path="../../src/shared/checker.d.ts" />
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import { ApplicationDatabase } from '../../src/server/storage/database.js';
import { ApplicationRepository } from '../../src/server/storage/repositories.js';
import { MonitorStore } from '../../src/server/storage/monitor-store.js';
import { assess } from '../../src/server/monitoring/assess.js';
import { AgentInvocationContextSchema, roleInvocationKey } from '../../src/shared/agents.js';
import { EvaluationAttemptRegistrationSchema, OriginalOutputSchema } from '../../src/shared/evaluation.js';
import { IncidentIdentitySchema, ExecutionModeSchema, RunIdSchema, EvaluationAttemptIdSchema,
  RuntimeAttemptIdSchema, ModelAttemptIdSchema, ImmutablePlanSchema, SnapshotRefSchema, SlackDecisionSchema,
  canonical, requestHashMaterial, planHashMaterial, type RestrictedArtifactRef } from '../../src/shared/domain.js';
import { ProtectedCallContextSchema, ProviderAttemptReceiptSchema } from '../../src/shared/adapters.js';
import { toPublicEvent } from '../../src/server/observability/events.js';
import { digest } from '../../src/shared/reliability.js';

const at = '2026-09-14T10:00:00Z';
const later = '2026-09-14T10:00:01Z';
const deadlineAt = '2026-09-14T10:10:00Z';
const hash = digest({ fixture: 'storage-v2' });
let tick = 0;
const stamp = () => ({ eventId: `storage-event-${++tick}`, at: later, processId: 'test-process', bootId: 'test-boot', monotonicMs: tick });
const configuration = ExecutionModeSchema.parse({ schemaVersion: 2, modelMode: 'mock', providerMode: 'fake',
  evidenceMode: 'synthetic_fixture', fixtureId: 'storage-v2' });
const incident = IncidentIdentitySchema.parse({ schemaVersion: 2, repositoryId: 'repository-1', issueId: 'issue-1',
  issueNumber: 1, canonicalUrl: 'https://github.com/fixture/project/issues/1', service: 'service-1', environment: 'test' });
const context = { producerVersion: 'storage-test-v2', producerId: 'test-producer', runId: RunIdSchema.parse('run-1'),
  evaluationAttemptId: EvaluationAttemptIdSchema.parse('evaluation-1'), runtimeAttemptId: RuntimeAttemptIdSchema.parse('runtime-1'),
  stage: 'analyst' as const, spanId: 'stage-1', parentSpanId: null, causedBy: [] };

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'promiseguard-app-storage-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'application.sqlite');
  const open = () => {
    const database = new ApplicationDatabase(path);
    cleanup.push(() => database.close());
    return { database, repository: new ApplicationRepository(database) };
  };
  return { path, open, ...open() };
}
function initialize(repository: ApplicationRepository) {
  return repository.transaction(context, tx => {
    tx.createRun({ runId: context.runId, incident, configuration, createdAt: at });
    const source = tx.putArtifact({ artifactId: 'source-1', mediaType: 'application/json', content: '{"fact":"fixture only"}' });
    tx.registerEvaluation(EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2,
      runId: context.runId, evaluationAttemptId: context.evaluationAttemptId,
      suiteEntryId: 'suite-entry-1', manifestHash: hash, registeredAt: at, dispatchAt: at,
      preflightRef: source, s0Ref: source, configuration, leg: 'baseline',
    }));
    tx.startRuntime({ runtimeAttemptId: context.runtimeAttemptId, runId: context.runId,
      evaluationAttemptId: context.evaluationAttemptId, startedAt: at });
    tx.appendEvent({ kind: 'stage.started' }, stamp());
    return source;
  });
}
function count(database: ApplicationDatabase, table: string) {
  return Number(database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
}

test('migration preserves populated monitor-v1 evidence, assessments, exhaustion and denominator identities', () => {
  const { path, database } = setup();
  database.close();
  rmSync(path);
  const legacy = new MonitorStore(path);
  const manifest = { schemaVersion: 1, manifestId: 'empty-v1', cohortId: 'cohort-1', mode: 'synthetic_fixture',
    family: 2, contract: 'checkpoint', versions: { app: 'app-1', fixture: 'fixture-1', policy: 'policy-1', prompt: 'prompt-1', model: 'model-1' },
    executionEligible: false, expectedUnsafe: false, requiredRoles: [], recoveryKind: 'none',
    expected: { terminalStatus: 'completed_no_affected_commitments', effects: [], protectedRecords: [{ app: 'hubspot', id: 'protected-1' }] },
    budgets: { activeMs: 1000, humanWaitMs: 2000, wallMs: 3000, recoveryMs: 1000, maxToolAttempts: 10 } };
  legacy.register('legacy-evaluation', 'legacy-run', manifest, 1000);
  const first = legacy.append('legacy-evaluation', { evidence: { original: 'retained' }, events: [{
    eventId: 'legacy-event', sequence: 1, runtimeAttemptId: 'legacy-runtime', atMs: 1001,
    kind: 'run.status', status: 'failed',
  }] });
  const job = legacy.claimJob(1010)!;
  const assessment = assess(first, 1011);
  legacy.completeJob(job, assessment, 1011);
  legacy.append('legacy-evaluation', { evidence: { original: 'retained', revised: true } });
  for (const now of [1020, 3020, 7020]) legacy.failJob(legacy.claimJob(now)!, now + 1);
  const before = legacy.getAttempt('legacy-evaluation');
  const failed = legacy.listFailedJobs();
  legacy.close();
  const migrated = new ApplicationDatabase(path);
  cleanup.push(() => migrated.close());
  assert.deepEqual(migrated.monitor.getAttempt('legacy-evaluation'), before);
  assert.deepEqual(migrated.monitor.listAssessments(), [assessment]);
  assert.deepEqual(migrated.monitor.listFailedJobs(), failed);
  assert.equal(migrated.monitor.listAttempts().length, 1);
  assert.equal(count(migrated, 'evidence_revisions'), 2);
  assert.equal(migrated.connection.prepare('PRAGMA user_version').get()!.user_version, 1);
  assert.equal(count(migrated, 'application_migrations'), 2);
});

test.each(['events', 'measurement_jobs'])('failed %s persistence rolls initial application state and evidence back together', table => {
  const { database, repository, open } = setup();
  database.connection.exec(`CREATE TEMP TRIGGER stop_insert BEFORE INSERT ON ${table}
    BEGIN SELECT RAISE(ABORT, 'private-provider-response'); END`);
  assert.throws(() => initialize(repository), error => {
    assert.equal(String(error).includes('private-provider-response'), false);
    return true;
  });
  database.close();
  const reopened = open();
  assert.equal(count(reopened.database, 'runs'), 0);
  assert.equal(count(reopened.database, 'attempts'), 0);
  assert.equal(count(reopened.database, 'events'), 0);
  assert.equal(count(reopened.database, 'measurement_jobs'), 0);
});

test('B01 upgrade retains history and workflow scheduling, commands and public revisions survive restart', () => {
  const { database, repository, open } = setup();
  initialize(repository);
  const original = repository.getRun(context.runId);
  database.connection.exec(`DROP TABLE workflow_commands; DROP TABLE workflow_invocations; DROP TABLE run_projections;
    DELETE FROM application_migrations WHERE migration_id=2`);
  database.close();
  const upgraded = open();
  assert.deepEqual(upgraded.repository.getRun(context.runId), original);
  const state = { schemaVersion: 2, runId: context.runId, stageTimeoutMs: 1000 };
  const save = () => upgraded.repository.transaction(context, tx => {
    tx.saveWorkflow({ ...context, ownerId: 'operator-1', state, scheduleStatus: 'waiting', wakeAt: later, deadlineAt, updatedAt: at });
    tx.saveCommand({ commandId: 'command-1', runId: context.runId, operatorId: 'operator-1', kind: 'create', expectedRevision: null, acceptedAt: at });
    tx.appendEvent({ kind: 'wait.started', waitId: 'wait-1', reason: 'approval' }, stamp());
  });
  upgraded.database.connection.exec(`CREATE TEMP TRIGGER reject_workflow_job BEFORE INSERT ON measurement_jobs
    BEGIN SELECT RAISE(ABORT,'test_failure'); END`);
  assert.throws(save);
  assert.equal(upgraded.repository.getWorkflow(context.runId), null);
  assert.equal(count(upgraded.database, 'workflow_commands'), 0);
  upgraded.database.connection.exec('DROP TRIGGER reject_workflow_job');
  save();
  for (const override of [{ ownerId: 'other-operator' }, { evaluationAttemptId: 'other-evaluation' },
    { deadlineAt: '2026-09-14T11:00:00Z' }, { state: { ...state, stageTimeoutMs: 2000 } }]) {
    assert.throws(() => upgraded.repository.transaction(context, tx => {
      tx.saveWorkflow({ ...context, ownerId: 'operator-1', state, scheduleStatus: 'waiting', wakeAt: later, deadlineAt, updatedAt: at, ...override });
      tx.appendEvent({ kind: 'wait.ended', waitId: 'wait-1' }, stamp());
    }));
  }
  assert.equal(upgraded.repository.getWorkflow(context.runId)?.ownerId, 'operator-1');
  assert.deepEqual(upgraded.repository.listEligibleWorkflow(at), []);
  assert.deepEqual(upgraded.repository.listEligibleWorkflow(later), [context.runId]);
  const revision = upgraded.repository.getPublicRevision(context.runId, hash);
  assert.equal(upgraded.repository.getPublicRevision(context.runId, hash), revision);
  assert.equal(upgraded.repository.getPublicRevision(context.runId, digest({ changed: 'assessment' })), revision + 1);
  upgraded.database.close();
  const reopened = open();
  assert.deepEqual(reopened.repository.getWorkflow(context.runId)?.state, state);
  assert.equal(reopened.repository.getPublicRevision(context.runId, digest({ changed: 'assessment' })), revision + 1);
  assert.equal(count(reopened.database, 'workflow_commands'), 1);
  assert.equal(count(reopened.database, 'application_migrations'), 2);
});

test('terminal transition and its event/job commit together and event cursor survives reopening', () => {
  const { database, repository, open } = setup();
  initialize(repository);
  const before = repository.getRun(context.runId);
  const eventsBefore = repository.readEvents({ runId: context.runId });
  const jobsBefore = count(database, 'measurement_jobs');
  database.connection.exec(`CREATE TEMP TRIGGER stop_terminal BEFORE INSERT ON measurement_jobs
    BEGIN SELECT RAISE(ABORT, 'terminal-failed'); END`);
  assert.throws(() => repository.transaction(context, tx => {
    tx.setRunStatus('failed');
    tx.appendEvent({ kind: 'run.status', status: 'failed' }, stamp());
  }));
  assert.deepEqual(repository.getRun(context.runId), before);
  assert.deepEqual(repository.readEvents({ runId: context.runId }), eventsBefore);
  assert.equal(count(database, 'measurement_jobs'), jobsBefore);
  database.connection.exec('DROP TRIGGER stop_terminal');
  repository.transaction(context, tx => {
    tx.setRunStatus('failed');
    tx.appendEvent({ kind: 'run.status', status: 'failed' }, {
      ...stamp(), processId: 'restarted-process', bootId: 'restarted-boot', monotonicMs: 0,
    });
  });
  database.close();
  const reopened = open();
  assert.equal(reopened.repository.getRun(context.runId)!.status, 'failed');
  const after = reopened.repository.readEvents({ runId: context.runId, afterSequence: 1 });
  assert.equal(after.length, 1);
  assert.equal(after[0]!.sequence, 2);
  assert.equal(after[0]!.kind, 'run.status');
  assert.equal(count(reopened.database, 'measurement_jobs'), jobsBefore + 1);
});

test('a mutation without a canonical event cannot commit and duplicate incident identity cannot create another run', () => {
  const { repository, database } = setup();
  const source = initialize(repository);
  const original = repository.getRun(context.runId);
  const expiredWriter = repository.transaction(context, tx => tx);
  assert.throws(() => repository.transaction(context, tx => {
    expiredWriter.putArtifact({ artifactId: 'expired-writer', mediaType: 'text/plain', content: 'must not persist' });
    tx.appendEvent({ kind: 'fault.recorded', faultId: 'expired-writer', evidenceRef: source }, stamp());
  }));
  assert.equal(count(database, 'restricted_artifacts'), 1);
  assert.throws(() => repository.transaction(context, tx => { tx.setRunStatus('running'); }));
  assert.deepEqual(repository.getRun(context.runId), original);
  assert.throws(() => repository.transaction(context, tx => {
    tx.createRun({ runId: RunIdSchema.parse('run-duplicate'), incident, configuration, createdAt: later });
    tx.appendEvent({ kind: 'run.status', status: 'running' }, stamp());
  }));
  assert.equal(count(database, 'runs'), 1);
});

test('restricted artifacts retain original malformed bytes, refuse overwrites and do not enter ordinary event payloads', () => {
  const { repository, database, path, open } = setup();
  initialize(repository);
  const content = '{"privateCustomer":"synthetic@example.test", "broken":\r\n';
  const ref = repository.transaction(context, tx => {
    const result = tx.putArtifact({ artifactId: 'malformed-raw', mediaType: 'text/plain', content });
    tx.appendEvent({ kind: 'fault.recorded', faultId: 'malformed-output', evidenceRef: result }, stamp());
    return result;
  });
  assert.throws(() => repository.transaction(context, tx => {
    tx.putArtifact({ artifactId: ref.artifactId, mediaType: 'text/plain', content: 'replacement' });
    tx.appendEvent({ kind: 'fault.recorded', faultId: 'overwrite', evidenceRef: ref }, stamp());
  }));
  assert.equal(canonical(repository.readEvents({ runId: context.runId })).includes('synthetic@example.test'), false);
  const publicEvent = toPublicEvent(repository.readEvents({ runId: context.runId }).at(-1));
  assert.deepEqual(Object.keys(publicEvent).sort(), ['at', 'eventId', 'kind', 'reference', 'sequence', 'stageId']);
  assert.throws(() => repository.transaction(context, tx => {
    tx.putArtifact({ artifactId: 'credential', mediaType: 'application/json', content: { authorization: 'credential' } });
    tx.appendEvent({ kind: 'fault.recorded', faultId: 'secret', evidenceRef: ref }, stamp());
  }));
  assert.throws(() => database.connection.prepare('UPDATE restricted_artifacts SET content=? WHERE artifact_id=?')
    .run(Buffer.from('replacement'), ref.artifactId), /immutable_evidence/);
  assert.throws(() => database.connection.prepare('DELETE FROM restricted_artifacts WHERE artifact_id=?')
    .run(ref.artifactId), /immutable_evidence/);
  assert.throws(() => database.connection.exec("UPDATE events SET event_json='{}'"), /immutable_evidence/);
  assert.throws(() => database.connection.exec('DELETE FROM events'), /immutable_evidence/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  database.close();
  const reopened = open();
  assert.equal(reopened.repository.readArtifact(ref), content);
});

test('role claim, original malformed output and later valid result survive restart without dispatching again', () => {
  const fixture = setup();
  const { open } = fixture;
  let { repository, database } = fixture;
  const source = initialize(repository);
  const key = roleInvocationKey(context.runId, 1, 'analyst');
  const role = AgentInvocationContextSchema.parse({ schemaVersion: 2, runId: context.runId,
    evaluationAttemptId: context.evaluationAttemptId, runtimeAttemptId: context.runtimeAttemptId,
    planRevision: 1, role: 'analyst', roleInvocationKey: key, snapshotBundleRef: source, inputDigest: hash,
    promptVersion: 'prompt-v2', outputSchemaVersion: 'analyst-v2', modelConfigRef: 'model-config', configDigest: hash,
    budgets: { timeoutMs: 1000, roleBudgetMs: 10000, maxAttempts: 2, maxOutputTokens: 500, maxInputChars: 10000, maxCommitments: 10 },
    spanId: 'model-span-1', parentSpanId: context.spanId, deadlineAt });
  const modelContext = (n: number) => ({ ...context, spanId: `model-span-${n}`, parentSpanId: context.spanId });
  const modelIdentity = (n: number) => ({ role: 'analyst' as const, logicalCallId: 'analyst-call', modelAttemptId: ModelAttemptIdSchema.parse(`model-${n}`),
    roleInvocationKey: key, planRevision: 1 });
  const started = (n: number) => ({ kind: 'model.attempt.started' as const, ...modelIdentity(n), inputDigest: hash,
    configDigest: hash, promptVersion: 'prompt-v2', modelVersion: 'mock-model', outputSchemaVersion: 'analyst-v2' });
  const persistIntent = () => repository.transaction(modelContext(1), tx => {
      assert.equal(tx.claimRole(role), true);
      tx.startModelAttempt({ modelAttemptId: 'model-1', roleInvocationKey: key, startedAt: at });
      tx.appendEvent(started(1), stamp());
    });
  database.connection.exec(`CREATE TEMP TRIGGER stop_dispatch BEFORE INSERT ON measurement_jobs
    BEGIN SELECT RAISE(ABORT, 'intent-failed'); END`);
  let dispatches = 0;
  assert.throws(() => { persistIntent(); dispatches++; });
  assert.equal(dispatches, 0);
  assert.equal(count(database, 'model_attempts'), 0);
  assert.equal(count(database, 'role_invocations'), 0);
  database.connection.exec('DROP TRIGGER stop_dispatch');
  persistIntent();
  database.close();
  ({ repository, database } = open());
  assert.equal(count(database, 'model_attempts'), 1);
  assert.deepEqual(repository.listOutputs(key), []);
  assert.equal(repository.transaction(modelContext(1), tx => tx.claimRole(role)), false);
  const validResult = { schemaVersion: 2 as const, facts: [], contradictions: [], unknowns: ['Pending confirmation'],
    candidateChange: { status: 'uncertain' as const, sourceFactIds: [], reason: 'Insufficient evidence' } };
  const rawValues = ['{"broken":', canonical(validResult)];
  for (let n = 1; n <= 2; n++) {
    if (n === 2) repository.transaction(modelContext(n), tx => {
      tx.startModelAttempt({ modelAttemptId: 'model-2', roleInvocationKey: key, startedAt: later });
      tx.appendEvent(started(n), stamp());
    });
    const persistOutput = (eventOutputRef?: RestrictedArtifactRef) => repository.transaction(modelContext(n), tx => {
      const rawOutput = tx.putArtifact({ artifactId: `raw-${n}`, mediaType: 'text/plain', content: rawValues[n - 1]! });
      tx.recordOutput(OriginalOutputSchema.parse({ schemaVersion: 2, runId: context.runId,
        evaluationAttemptId: context.evaluationAttemptId, runtimeAttemptId: context.runtimeAttemptId,
        outputId: `output-${n}`, firstOutputId: 'output-1', previousOutputId: n === 1 ? null : 'output-1',
        role: 'analyst', roleInvocationKey: key, planRevision: 1, modelAttemptId: `model-${n}`,
        inputDigest: hash, sourceDigests: [source.sha256], configDigest: hash, promptVersion: 'prompt-v2',
        modelVersion: 'mock-model', outputSchemaVersion: 'analyst-v2', receivedAt: n === 1 ? at : later,
        rawOutput, parseStatus: n === 1 ? 'malformed' : 'valid', validationStatus: n === 1 ? 'invalid' : 'valid',
        correctionReason: n === 1 ? null : 'Bounded format repair' }));
      if (n === 2) {
        const validationRef = tx.putArtifact({ artifactId: 'analyst-validation', mediaType: 'application/json',
          content: { schemaVersion: 2, outputId: 'output-2', status: 'valid' } });
        tx.saveRoleResult({ roleInvocationKey: key, result: { schemaVersion: 2, status: 'success', roleInvocationKey: key,
          attemptRefs: ['model-1', 'model-2'], firstOutputRef: tx.listOutputs(key)[0]!.rawOutput,
          output: validResult, outputRef: rawOutput, validationRef } });
      }
      tx.appendEvent({ kind: 'model.attempt.result', ...modelIdentity(n), outputRef: eventOutputRef ?? rawOutput,
        validation: n === 1 ? 'invalid' : 'valid', latencyMs: 1, usage: null }, stamp());
    });
    if (n === 1) {
      assert.throws(() => persistOutput(source));
      assert.equal(count(database, 'original_outputs'), 0);
      database.connection.exec(`CREATE TEMP TRIGGER stop_output BEFORE INSERT ON measurement_jobs
        BEGIN SELECT RAISE(ABORT, 'output-failed'); END`);
      assert.throws(() => persistOutput());
      assert.equal(count(database, 'original_outputs'), 0);
      assert.equal(count(database, 'model_attempts'), 1);
      database.close();
      ({ repository, database } = open());
      assert.deepEqual(repository.listOutputs(key), []);
    }
    persistOutput();
  }
  const before = repository.getRole(key);
  assert.deepEqual(before?.result?.status === 'success' ? before.result.output : null, validResult);
  assert.equal(count(database, 'role_results'), 1);
  database.close();
  const reopened = open();
  assert.deepEqual(reopened.repository.getRole(key), before);
  const outputs = reopened.repository.listOutputs(key);
  assert.equal(outputs.length, 2);
  assert.equal(outputs[0]!.firstOutputId, outputs[1]!.firstOutputId);
  assert.equal(outputs[0]!.parseStatus, 'malformed');
  assert.equal(reopened.repository.readArtifact(outputs[0]!.rawOutput), rawValues[0]);
  assert.equal(reopened.repository.transaction(modelContext(2), tx => tx.claimRole(role)), false);
});

test('unknown provider write retains its unique inflight claim and exact intent across reopening', () => {
  const { database, repository, open } = setup();
  const source = initialize(repository);
  const sources = (['github', 'hubspot'] as const).map(app => SnapshotRefSchema.parse({
    snapshotId: `snapshot-${app}`, app, accountRef: `account-${app}`, sourceIds: [`source-${app}`],
    capturedAt: at, relevantVersion: 'source-v1', artifact: source,
    receipt: { schemaVersion: 2, collectionId: `collection-${app}`, app, accountRef: `account-${app}`,
      producerId: 'test-reader', startedAt: at, finishedAt: at, status: 'complete', reason: null,
      requiredQueryIds: ['source-query'], pages: [{ queryId: 'source-query', cursor: null, nextCursor: null,
        recordCount: 1, response: source, providerAttemptId: `source-read-${app}` }] },
  }));
  const text = 'Approved fixture update';
  const body = [{ type: 'text', text }];
  const selected = { commitmentId: 'commitment-1', companyId: 'company-1', ownerId: 'owner-1', contactId: 'contact-1',
    mailbox: 'fixture@example.test', dueAt: deadlineAt, service: 'service-1', reason: 'service_match' };
  const common = { commitmentId: selected.commitmentId, requestDigest: hash };
  let plan = ImmutablePlanSchema.parse({ schemaVersion: 2, runId: context.runId, revision: 1, planHash: hash,
    createdAt: at, incident, sources,
    selection: { schemaVersion: 2, policyVersion: 'selection-v1', evaluatedAt: at, sourceBundleRef: source,
      sourceComplete: true, selected: [selected], excluded: [] },
    contents: [{ contentKey: 'body', text, sha256: createHash('sha256').update(text).digest('hex') }],
    effects: [
      { ...common, kind: 'task', app: 'hubspot', effectKey: 'effect-task', payload: {
        companyId: selected.companyId, commitmentId: selected.commitmentId, ownerId: selected.ownerId,
        dueAt: selected.dueAt, status: 'NOT_STARTED', subject: 'Incident follow up', body } },
      { ...common, kind: 'note', app: 'hubspot', effectKey: 'effect-note', payload: {
        companyId: selected.companyId, commitmentId: selected.commitmentId,
        taskId: { type: 'effect_id', effectKey: 'effect-task' }, body } },
      { ...common, kind: 'draft', app: 'gmail', effectKey: 'effect-draft', payload: {
        to: selected.mailbox, cc: [], bcc: [], subject: 'Incident update', body, isDraft: true } },
      { ...common, commitmentId: null, kind: 'comment', app: 'github', effectKey: 'effect-comment', payload: {
        repositoryId: incident.repositoryId, issueId: incident.issueId, body,
        taskIds: [{ type: 'effect_id', effectKey: 'effect-task' }], draftIds: [{ type: 'effect_id', effectKey: 'effect-draft' }] } },
      { ...common, commitmentId: null, kind: 'thread', app: 'slack', effectKey: 'effect-thread', payload: {
        channelId: 'approval-channel', threadTs: '100.1', body } },
    ] });
  plan = { ...plan, effects: plan.effects.map(effect => ({ ...effect, requestDigest: digest(requestHashMaterial(effect, plan.contents)) })) };
  plan = { ...plan, planHash: digest(planHashMaterial(plan)) };
  repository.transaction(context, tx => {
    sources.forEach(snapshot => tx.saveSnapshot(snapshot));
    tx.freezePlan(plan);
    const planRef = tx.putArtifact({ artifactId: 'frozen-plan', mediaType: 'application/json', content: plan });
    tx.appendEvent({ kind: 'plan.frozen', planRevision: plan.revision, planHash: plan.planHash, planRef }, stamp());
  });
  repository.transaction(context, tx => {
    tx.recordApproval(SlackDecisionSchema.parse({ schemaVersion: 2, approvalId: 'approval-1', runId: context.runId,
      planRevision: 1, planHash: plan.planHash, transport: 'slack_human_reply', workspaceId: 'workspace-1',
      channelId: 'approval-channel', threadTs: '100.1', reviewMessageTs: '100.1', decisionMessageTs: '100.2',
      actorId: 'actor-1', authorizedActorId: 'actor-1', isBot: false, editedAt: null, deleted: false,
      decision: 'approved', decidedAt: at, observedAt: at, expiresAt: deadlineAt, reviewRef: source, decisionRef: source }));
    tx.appendEvent({ kind: 'approval.checked', approvalId: 'approval-1', planRevision: 1, planHash: plan.planHash,
      decision: 'approved', evidenceRef: source }, stamp());
  });
  const stageContext = { ...context, stage: 'execute' as const, spanId: 'execute-stage' };
  repository.transaction(stageContext, tx => tx.appendEvent({ kind: 'stage.started' }, stamp()));
  const providerContext = { ...stageContext, spanId: 'provider-span', parentSpanId: stageContext.spanId };
  const adapter = ProtectedCallContextSchema.parse({ schemaVersion: 2, runId: context.runId,
    evaluationAttemptId: context.evaluationAttemptId, runtimeAttemptId: context.runtimeAttemptId,
    spanId: providerContext.spanId, app: 'hubspot', accountRef: 'account-hubspot', mode: 'fake',
    logicalCallId: 'task-create', providerAttemptId: 'provider-create-1', deadlineAt,
    budgets: { timeoutMs: 1000, totalMs: 1000, maxAttempts: 1, maxPages: 1, maxRecords: 1, maxResponseBytes: 10000 },
    operation: 'hubspot.createTask', effectKey: 'effect-task', requestDigest: plan.effects[0]!.requestDigest,
    planHash: plan.planHash, approvalRef: 'approval-1' });
  const persistClaim = (callContext = adapter, bypassClaim = false) => repository.transaction(providerContext, tx => {
    const ref = tx.putArtifact({ artifactId: 'exact-request', mediaType: 'application/json', content: plan.effects[0]!.payload });
    if (bypassClaim) tx.startProviderAttempt({ context: callContext, requestRef: ref, startedAt: at });
    else assert.equal(tx.claimEffect({ effectKey: 'effect-task', claimId: 'claim-task', context: callContext, requestRef: ref, startedAt: at }), true);
    tx.appendEvent({ kind: 'tool.dispatch', app: callContext.app, operation: callContext.operation, logicalCallId: callContext.logicalCallId,
      providerAttemptId: callContext.providerAttemptId, actor: 'executor', effectKey: callContext.effectKey,
      requestDigest: callContext.requestDigest, planHash: callContext.planHash, approvalId: callContext.approvalRef }, stamp());
    return ref;
  });
  assert.throws(() => persistClaim(adapter, true));
  assert.throws(() => persistClaim(ProtectedCallContextSchema.parse({ ...adapter, operation: 'hubspot.createNote' })));
  assert.throws(() => persistClaim(ProtectedCallContextSchema.parse({ ...adapter, app: 'gmail', accountRef: 'account-gmail', operation: 'gmail.createDraft' })));
  assert.equal(count(database, 'provider_attempts'), 0);
  assert.equal(repository.getEffect('effect-task')!.state, 'planned');
  const requestRef = persistClaim();
  repository.transaction(providerContext, tx => {
    const receipt = ProviderAttemptReceiptSchema.parse({ schemaVersion: 2, context: adapter, startedAt: at, finishedAt: later,
      transport: 'fake', httpStatus: null, transportOutcome: 'timeout', providerOutcome: 'unknown', responseRef: source,
      errorCode: 'timeout' });
    tx.recordProviderOutcome({ providerAttemptId: adapter.providerAttemptId,
      outcome: { status: 'unknown', reason: 'timeout', receipt: source }, receipt });
    tx.appendEvent({ kind: 'tool.result', app: 'hubspot', operation: 'hubspot.createTask', logicalCallId: 'task-create',
      providerAttemptId: adapter.providerAttemptId, transportOutcome: 'timeout', providerOutcome: 'unknown', receiptRef: source, latencyMs: 1000 }, stamp());
  });
  database.close();
  const reopened = open();
  const effect = reopened.repository.getEffect('effect-task');
  assert.ok(effect);
  assert.equal(effect.state, 'inflight');
  assert.equal(effect.claimId, 'claim-task');
  assert.equal(effect.outcome?.status, 'unknown');
  assert.equal(effect.providerId, null);
  assert.equal(reopened.repository.readArtifact(requestRef), canonical(plan.effects[0]!.payload));
  assert.equal(reopened.repository.transaction(providerContext, tx => tx.claimEffect({
    effectKey: 'effect-task', claimId: 'another-claim', context: adapter, requestRef, startedAt: later,
  })), false);
  assert.equal(count(reopened.database, 'provider_attempts'), 1);
});
