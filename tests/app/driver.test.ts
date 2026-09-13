import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import { CollectionReceiptSchema, ExecutionModeSchema, IncidentIdentitySchema, SelectionSchema, SnapshotRefSchema } from '../../src/shared/domain.js';
import { ProviderAttemptReceiptSchema, ReadCallContextSchema } from '../../src/shared/adapters.js';
import { EvaluationAttemptRegistrationSchema, ImportedObservationSchema } from '../../src/shared/evaluation.js';
import { parseEventV2Compatibility } from '../../src/shared/events.js';
import { digest } from '../../src/shared/reliability.js';
import { ApplicationDatabase } from '../../src/server/storage/database.js';
import { WorkflowCheckpoints } from '../../src/server/storage/checkpoints.js';
import { ApplicationRepository } from '../../src/server/storage/repositories.js';
import { WorkflowDriver, type CompletionProof, type WorkflowDriverOptions, type WorkflowNodeContext } from '../../src/server/workflow/driver.js';

const configuration = ExecutionModeSchema.parse({ schemaVersion: 2, modelMode: 'mock', providerMode: 'fake',
  evidenceMode: 'synthetic_fixture', fixtureId: 'driver-synthetic-v2' });
const incident = IncidentIdentitySchema.parse({ schemaVersion: 2, repositoryId: 'repository-driver', issueId: 'issue-driver',
  issueNumber: 1, canonicalUrl: 'https://github.com/fixture/driver/issues/1', service: 'fixture-service', environment: 'test' });
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** Explicit synthetic receipts and injected nodes; no model/provider client is constructed. */
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'promiseguard-driver-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-09-14T10:00:00Z');
  let prepareCalls = 0;
  const open = (options: Partial<WorkflowDriverOptions> = {}) => {
    const database = new ApplicationDatabase(join(directory, 'application.sqlite'));
    const checkpoints = new WorkflowCheckpoints(join(directory, 'checkpoints.sqlite'), join(directory, 'application.sqlite'));
    const repository = new ApplicationRepository(database);
    const driver = new WorkflowDriver({ repository, checkpoints, configuration, clock: () => now,
      stageTimeoutMs: 1000, runTimeoutMs: 10000, pollMs: 60000, nodes: {},
      prepare: async () => {
        prepareCalls++;
        return { incident, title: 'Synthetic workflow fixture', register: (writer, identity) => {
          const preflightRef = writer.putArtifact({ artifactId: `${identity.runId}-preflight`, mediaType: 'application/json',
            content: { schemaVersion: 2, evidenceMode: 'synthetic_fixture', fixtureId: configuration.fixtureId, status: 'ready' } });
          const s0Ref = writer.putArtifact({ artifactId: `${identity.runId}-s0`, mediaType: 'application/json',
            content: { schemaVersion: 2, evidenceMode: 'synthetic_fixture', phase: 's0', objects: [] } });
          return EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2, runId: identity.runId,
            evaluationAttemptId: identity.evaluationAttemptId, suiteEntryId: 'driver-synthetic-entry',
            manifestHash: digest({ fixture: 'driver-synthetic-v2' }), registeredAt: identity.at, dispatchAt: identity.at,
            preflightRef, s0Ref, configuration, leg: 'baseline' });
        } };
      }, ...options });
    let closed = false;
    const close = async () => {
      if (closed) return;
      await driver.stop(); checkpoints.close(); database.close(); closed = true;
    };
    cleanup.push(close);
    return { driver, database, checkpoints, repository, close };
  };
  return { open, setNow: (value: number) => { now = value; }, advance: (ms: number) => { now += ms; },
    now: () => now, prepareCalls: () => prepareCalls };
}
function count(database: ApplicationDatabase, table: string): number {
  return Number(database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
}

test('concurrent synthetic commands commit one run and command before one node executes outside acceptance', async () => {
  const fixture = setup();
  let calls = 0;
  const { driver, database, repository } = fixture.open({ nodes: { ingest: async () => {
    calls++;
    return { kind: 'stop', status: 'safely_blocked', reason: 'fixture_boundary' };
  } } });
  await driver.start();
  const results = await Promise.all(Array.from({ length: 8 }, () => driver.accept(incident.canonicalUrl, 'operator-fixture')));
  assert.equal(calls, 0);
  assert.equal(fixture.prepareCalls(), 1);
  assert.equal(new Set(results.map(result => result.runId)).size, 1);
  assert.equal(new Set(results.map(result => result.commandId)).size, 1);
  for (const table of ['runs', 'workflow_commands', 'workflow_invocations', 'attempts', 'runtime_attempts']) assert.equal(count(database, table), 1);
  assert.equal(results.filter(result => result.disposition === 'created').length, 1);
  assert.equal(repository.getRun(results[0]!.runId)?.status, 'queued');
  await driver.tick();
  assert.equal(calls, 1);
  assert.equal(repository.getRun(results[0]!.runId)?.status, 'safely_blocked');
  const events = repository.readEvents({ runId: results[0]!.runId });
  assert.equal(new Set(events.map(event => event.eventId)).size, events.length);
  assert.equal(count(database, 'measurement_jobs'), events.length);
  assert.ok(events.every(event => !('attemptId' in event)));
  const event = events[0]!;
  const { runtimeAttemptId, ...withoutRuntime } = event;
  assert.equal(parseEventV2Compatibility({ ...withoutRuntime, attemptId: runtimeAttemptId }).runtimeAttemptId, runtimeAttemptId);
  assert.throws(() => parseEventV2Compatibility({ ...event, attemptId: 'conflicting-runtime' }), /conflicting_runtime_attempt_alias/);
});

test('a hung execute stage stops with unknown partial effects and is never replayed after restart', async () => {
  const fixture = setup();
  let dispatches = 0;
  const first = fixture.open({ stageTimeoutMs: 20, nodes: {
    ingest: async () => ({ kind: 'advance', nextStage: 'execute' }),
    execute: async () => { dispatches++; return await new Promise(() => {}); },
  } });
  await first.driver.start();
  const result = await first.driver.accept(incident.canonicalUrl, 'operator-fixture');
  await first.driver.tick();
  const state = first.driver.readState(result.runId)!;
  assert.equal(first.repository.getRun(result.runId)?.status, 'failed_partial');
  assert.equal(state.statusReason, 'stalled');
  assert.equal(state.stages.find(stage => stage.stageId === 'execute')?.status, 'unknown');
  assert.equal(state.spanOpen, true);
  assert.equal(dispatches, 1);
  assert.equal(first.repository.readEvents({ runId: result.runId }).filter(event =>
    event.stage === 'execute' && event.kind === 'stage.finished').length, 0);
  await first.close();
  const second = fixture.open({ nodes: { execute: async () => {
    dispatches++; return { kind: 'stop', status: 'failed_partial', reason: 'must_not_replay' };
  } } });
  await second.driver.start(); await second.driver.tick();
  assert.equal(dispatches, 1);
  assert.equal(second.repository.getRun(result.runId)?.status, 'failed_partial');
  assert.equal(count(second.database, 'attempts'), 1);
});

test('a waiting stage resumes on its saved wake time and deadline without rerunning completed roles', async () => {
  const fixture = setup();
  let analystCalls = 0, draftCalls = 0;
  const nodes: WorkflowDriverOptions['nodes'] = {
    ingest: async () => ({ kind: 'advance', nextStage: 'analyst' }),
    analyst: async () => { analystCalls++; return { kind: 'advance', nextStage: 'drafter' }; },
    drafter: async () => {
      draftCalls++;
      return draftCalls === 1 ? { kind: 'wait', wakeAt: new Date(fixture.now() + 1000).toISOString(), reason: 'fixture_retry' }
        : { kind: 'stop', status: 'safely_blocked', reason: 'fixture_boundary' };
    },
  };
  const first = fixture.open({ nodes });
  await first.driver.start();
  const result = await first.driver.accept(incident.canonicalUrl, 'operator-fixture');
  await first.driver.tick();
  const waiting = first.driver.readState(result.runId)!;
  assert.equal(waiting.scheduleStatus, 'waiting');
  assert.equal(waiting.stage, 'drafter');
  await first.close();
  fixture.advance(500);
  const second = fixture.open({ nodes, runTimeoutMs: 60000 });
  await second.driver.start(); await second.driver.tick();
  assert.equal(draftCalls, 1);
  fixture.advance(500); await second.driver.tick();
  const resumed = second.driver.readState(result.runId)!;
  assert.equal(analystCalls, 1); assert.equal(draftCalls, 2);
  assert.equal(resumed.deadlineAt, waiting.deadlineAt);
  assert.equal(resumed.evaluationAttemptId, waiting.evaluationAttemptId);
  assert.notEqual(resumed.runtimeAttemptId, waiting.runtimeAttemptId);
  assert.equal(resumed.runtimeAttemptIds.length, 2);
  assert.equal(count(second.database, 'attempts'), 1);
  assert.equal(count(second.database, 'runtime_attempts'), 2);
  assert.equal(second.repository.readEvents({ runId: result.runId }).filter(event => event.kind === 'wait.ended').length, 1);
});

test('a committed analyst result survives a failed following checkpoint without another analyst invocation', async () => {
  const fixture = setup();
  let analystCalls = 0, draftCalls = 0, checkpointFailed = false;
  const nodes: WorkflowDriverOptions['nodes'] = {
    ingest: async () => ({ kind: 'advance', nextStage: 'analyst' }),
    analyst: async () => { analystCalls++; return { kind: 'advance', nextStage: 'drafter' }; },
    drafter: async () => { draftCalls++; return { kind: 'stop', status: 'safely_blocked', reason: 'fixture_boundary' }; },
  };
  const first = fixture.open({ nodes });
  const originalPut = first.checkpoints.saver.put.bind(first.checkpoints.saver);
  first.checkpoints.saver.put = async (...args: Parameters<typeof originalPut>) => {
    const runId = args[0].configurable?.thread_id;
    if (!checkpointFailed && typeof runId === 'string' && first.driver.readState(runId)?.stage === 'drafter') {
      checkpointFailed = true;
      throw new Error('synthetic_checkpoint_crash');
    }
    return originalPut(...args);
  };
  await first.driver.start();
  const result = await first.driver.accept(incident.canonicalUrl, 'operator-fixture');
  await first.driver.tick();
  assert.equal(checkpointFailed, true);
  assert.equal(analystCalls, 1);
  assert.equal(draftCalls, 0);
  assert.equal(first.driver.readState(result.runId)?.scheduleStatus, 'queued');
  await first.close();
  const second = fixture.open({ nodes });
  await second.driver.start(); await second.driver.tick();
  assert.equal(analystCalls, 1);
  assert.equal(draftCalls, 1);
  assert.equal(second.repository.getRun(result.runId)?.status, 'safely_blocked');
  assert.equal(count(second.database, 'attempts'), 1);
});

test('an expired persisted run budget blocks a waiting stage before another node call', async () => {
  const fixture = setup();
  let calls = 0;
  const first = fixture.open({ runTimeoutMs: 2000, nodes: { ingest: async () => {
    calls++; return { kind: 'wait', wakeAt: new Date(fixture.now() + 1000).toISOString(), reason: 'fixture_retry' };
  } } });
  await first.driver.start();
  const result = await first.driver.accept(incident.canonicalUrl, 'operator-fixture');
  await first.driver.tick(); await first.close();
  fixture.advance(2001);
  const second = fixture.open({ runTimeoutMs: 60000, nodes: { ingest: async () => {
    calls++; return { kind: 'stop', status: 'failed', reason: 'must_not_dispatch' };
  } } });
  await second.driver.start(); await second.driver.tick();
  assert.equal(calls, 1);
  assert.equal(second.driver.readState(result.runId)?.statusReason, 'budget_exhausted');
  assert.equal(second.repository.getRun(result.runId)?.status, 'failed');
});

test('a failed node transition rolls back its artifact and emits failure without successful stage advancement', async () => {
  const fixture = setup();
  const { driver, database, repository } = fixture.open({ nodes: { ingest: async () => ({
    kind: 'advance', nextStage: 'analyst', persist: writer => {
      writer.putArtifact({ artifactId: 'must-rollback', mediaType: 'text/plain', content: 'synthetic private receipt' });
      throw new Error('private-storage-failure');
    },
  }) } });
  await driver.start();
  const result = await driver.accept(incident.canonicalUrl, 'operator-fixture');
  await driver.tick();
  assert.equal(repository.getRun(result.runId)?.status, 'failed');
  assert.equal(driver.readState(result.runId)?.stage, 'ingest');
  assert.equal(driver.readState(result.runId)?.statusReason, 'node_failed');
  assert.equal(count(database, 'restricted_artifacts'), 2);
  const events = repository.readEvents({ runId: result.runId });
  assert.equal(events.filter(event => event.kind === 'success.claimed').length, 0);
  assert.equal(events.filter(event => event.kind === 'stage.finished' && event.outcome === 'failed').length, 1);
  assert.equal(JSON.stringify(events).includes('private-storage-failure'), false);
});

test('incomplete no-affected evidence cannot produce a completion claim or successful terminal state', async () => {
  const fixture = setup();
  const { driver, database, repository } = fixture.open({ nodes: { ingest: async () => ({ kind: 'complete',
    proof: { scope: 'no_affected', sourceReceipts: [], absenceEvidence: [], protectedMutationCount: 0,
      modelCallCount: 0 } as unknown as CompletionProof,
  }) } });
  await driver.start();
  const result = await driver.accept(incident.canonicalUrl, 'operator-fixture');
  await driver.tick();
  assert.equal(repository.getRun(result.runId)?.status, 'failed');
  assert.equal(driver.readState(result.runId)?.verifiedAt, null);
  assert.equal(count(database, 'completion_claims'), 0);
  assert.equal(repository.readEvents({ runId: result.runId }).filter(event => event.kind === 'success.claimed').length, 0);
});

test('complete synthetic sources, empty selection and saved absence readback produce one durable no-affected claim', async () => {
  const fixture = setup();
  let fixtureReads = 0, stampNumber = 0;
  const stamp = () => ({ eventId: randomUUID(), at: new Date(fixture.now()).toISOString(),
    processId: 'synthetic-proof-process', bootId: 'synthetic-proof-boot', monotonicMs: ++stampNumber });
  const opened = fixture.open({ nodes: {
    ingest: async () => ({ kind: 'advance', nextStage: 'verify' }),
    verify: async context => {
      const at = new Date(fixture.now()).toISOString();
      const read = (app: 'github' | 'hubspot', phase: 'source' | 's1') => {
        fixtureReads++;
        const id = `${app}-${phase}`;
        const childContext = { ...context.eventContext, spanId: `span-${id}`, parentSpanId: context.eventContext.spanId };
        const call = ReadCallContextSchema.parse({ schemaVersion: 2, runId: context.state.runId,
          evaluationAttemptId: context.state.evaluationAttemptId, runtimeAttemptId: context.state.runtimeAttemptId,
          spanId: childContext.spanId, app, accountRef: `fixture-account-${app}`, mode: 'fake',
          logicalCallId: `call-${id}`, providerAttemptId: `attempt-${id}`, deadlineAt: context.state.deadlineAt,
          budgets: { timeoutMs: 1000, totalMs: 1000, maxAttempts: 1, maxPages: 1, maxRecords: 10, maxResponseBytes: 10000 },
          operation: app === 'github' ? 'github.readTechnicalEvidence' : phase === 'source' ? 'hubspot.readCommitmentBundle' : 'hubspot.findTasks' });
        const requestRef = opened.repository.transaction(childContext, writer => {
          const request = writer.putArtifact({ artifactId: `request-${id}`, mediaType: 'application/json',
            content: { evidenceMode: 'synthetic_fixture', queryScope: id } });
          writer.startProviderAttempt({ context: call, requestRef: request, startedAt: at });
          writer.appendEvent({ kind: 'tool.dispatch', app, operation: call.operation, logicalCallId: call.logicalCallId,
            providerAttemptId: call.providerAttemptId, actor: phase === 'source' ? 'reader' : 'collector',
            effectKey: null, requestDigest: null, planHash: null, approvalId: null }, stamp());
          return request;
        });
        return opened.repository.transaction(childContext, writer => {
          const response = writer.putArtifact({ artifactId: `response-${id}`, mediaType: 'application/json',
            content: { evidenceMode: 'synthetic_fixture', objects: app === 'github' ? [incident] : [] } });
          writer.recordProviderOutcome({ providerAttemptId: call.providerAttemptId, outcome: null,
            receipt: ProviderAttemptReceiptSchema.parse({ schemaVersion: 2, context: call, startedAt: at, finishedAt: at,
              transport: 'fake', httpStatus: 200, transportOutcome: 'response', providerOutcome: 'success', responseRef: response, errorCode: null }) });
          const receipt = CollectionReceiptSchema.parse({ schemaVersion: 2, collectionId: `collection-${id}`, app,
            accountRef: call.accountRef, producerId: phase === 'source' ? 'fixture-source-reader' : 'fixture-independent-collector',
            startedAt: at, finishedAt: at, status: 'complete', reason: null, requiredQueryIds: [id],
            pages: [{ queryId: id, cursor: null, nextCursor: null, recordCount: app === 'github' ? 1 : 0,
              response, providerAttemptId: call.providerAttemptId }] });
          if (phase === 'source') writer.saveSnapshot(SnapshotRefSchema.parse({ snapshotId: `snapshot-${id}`, app,
            accountRef: call.accountRef, sourceIds: [`fixture-scope-${app}`], capturedAt: at, relevantVersion: 'fixture-source-v2', artifact: response, receipt }));
          else writer.recordObservation(ImportedObservationSchema.parse({ schemaVersion: 2, observationId: `observation-${id}`,
            runId: context.state.runId, evaluationAttemptId: context.state.evaluationAttemptId,
            runtimeAttemptId: context.state.runtimeAttemptId, mode: 'synthetic_fixture', phase: 's1', receipt,
            scopeRef: requestRef, objectsRef: response, producer: { producerId: receipt.producerId, version: 'fixture-collector-v2',
              processId: 'fixture-collector-process', bootId: 'fixture-collector-boot' } }));
          writer.appendEvent({ kind: 'tool.result', app, operation: call.operation, logicalCallId: call.logicalCallId,
            providerAttemptId: call.providerAttemptId, transportOutcome: 'response', providerOutcome: 'success', receiptRef: response, latencyMs: 0 }, stamp());
          return { receipt, response };
        });
      };
      const sources = [read('github', 'source'), read('hubspot', 'source')];
      const absence = read('hubspot', 's1');
      const selectionRef = context.transaction(writer => {
        const bundle = writer.putArtifact({ artifactId: 'empty-source-bundle', mediaType: 'application/json', content: sources.map(source => source.receipt) });
        const selection = writer.putArtifact({ artifactId: 'empty-selection', mediaType: 'application/json',
          content: SelectionSchema.parse({ schemaVersion: 2, policyVersion: 'fixture-policy-v2', evaluatedAt: at,
            sourceBundleRef: bundle, sourceComplete: true, selected: [], excluded: [] }) });
        writer.appendEvent({ kind: 'sources.collected', complete: true, collectionRefs: sources.map(source => source.response) }, stamp());
        return selection;
      });
      return { kind: 'complete', patch: { commitments: { status: 'empty', policyVersion: 'fixture-policy-v2', selected: [], excluded: [],
        evidenceRefs: [{ referenceId: selectionRef.artifactId, label: 'Synthetic empty selection', availability: 'unavailable', href: null }] } },
      proof: { scope: 'no_affected', sourceReceipts: sources.map(source => source.receipt),
        selection: { eligibleCount: 0, sourceComplete: true, policyVersion: 'fixture-policy-v2', receipt: selectionRef },
        absenceEvidence: [{ predicateId: 'no-hubspot-tasks', status: 'confirmed', receipt: absence.response }],
        protectedMutationCount: 0, modelCallCount: 0 } };
    },
  } });
  await opened.driver.start();
  const result = await opened.driver.accept(incident.canonicalUrl, 'operator-fixture');
  await opened.driver.tick();
  assert.equal(opened.repository.getRun(result.runId)?.status, 'completed_no_affected_commitments');
  assert.equal(fixtureReads, 3);
  assert.equal(count(opened.database, 'completion_claims'), 1);
  for (const table of ['plans', 'approvals', 'effects', 'model_attempts']) assert.equal(count(opened.database, table), 0);
  const claim = opened.repository.readEvents({ runId: result.runId }).find(event => event.kind === 'success.claimed');
  assert.ok(claim?.kind === 'success.claimed');
  assert.equal(claim.claim.scope, 'no_affected');
  assert.equal('planRef' in claim.claim, false);
  await opened.close();
  const reopened = fixture.open();
  await reopened.driver.start(); await reopened.driver.tick();
  assert.equal(reopened.repository.getRun(result.runId)?.status, 'completed_no_affected_commitments');
  assert.equal(count(reopened.database, 'completion_claims'), 1);
  assert.equal(count(reopened.database, 'attempts'), 1);
  assert.equal(fixtureReads, 3);
});

test.each(['application', 'checkpoint'] as const)('unavailable %s storage prevents startup and durable acceptance', async store => {
  const fixture = setup();
  const { driver, database, checkpoints } = fixture.open();
  if (store === 'application') database.close(); else checkpoints.close();
  await assert.rejects(driver.start(), error => error instanceof Error && error.message === 'unavailable');
  await assert.rejects(driver.accept(incident.canonicalUrl, 'operator-fixture'), error => error instanceof Error && error.message === 'unavailable');
  assert.equal(fixture.prepareCalls(), 0);
});

test('a second scheduler for the same application store cannot start', async () => {
  const fixture = setup();
  const first = fixture.open();
  const second = fixture.open();
  await first.driver.start();
  await assert.rejects(second.driver.start(), error => error instanceof Error && error.message === 'conflict');
});

test('concurrent scheduler startups grant exactly one owner for an application store', async () => {
  const fixture = setup();
  const first = fixture.open(), second = fixture.open();
  const results = await Promise.allSettled([first.driver.start(), second.driver.start()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected');
  assert.equal(rejected.reason.message, 'conflict');
});

test('a completed stage cannot use its captured transaction capability for late ledger writes', async () => {
  const fixture = setup();
  const captured: { context?: WorkflowNodeContext } = {};
  const { driver, database, repository } = fixture.open({ nodes: {
    ingest: async context => { captured.context = context; return { kind: 'advance', nextStage: 'analyst' }; },
    analyst: async () => ({ kind: 'stop', status: 'safely_blocked', reason: 'fixture_boundary' }),
  } });
  await driver.start();
  const result = await driver.accept(incident.canonicalUrl, 'operator-fixture');
  await driver.tick();
  const before = repository.getRun(result.runId);
  let callbackCalled = false;
  assert.ok(captured.context);
  assert.throws(() => captured.context!.transaction(writer => {
    callbackCalled = true;
    writer.putArtifact({ artifactId: 'late-artifact', mediaType: 'text/plain', content: 'must not persist' });
  }), /stale_workflow_invocation/);
  assert.equal(callbackCalled, false);
  assert.equal(count(database, 'restricted_artifacts'), 2);
  assert.deepEqual(repository.getRun(result.runId), before);
});

test('reconciliation accepts one fresh runtime and command without replaying execute or resetting its budget', async () => {
  const fixture = setup();
  let executeCalls = 0, reconcileCalls = 0;
  const { driver, database, repository } = fixture.open({ nodes: {
    ingest: async () => ({ kind: 'advance', nextStage: 'execute' }),
    execute: async () => { executeCalls++; return { kind: 'stop', status: 'failed_partial', reason: 'fixture_unknown_effect' }; },
  }, reconcile: async () => {
    reconcileCalls++; return { kind: 'stop', status: 'failed_partial', reason: 'fixture_still_unresolved' };
  } });
  await driver.start();
  const accepted = await driver.accept(incident.canonicalUrl, 'operator-fixture');
  await driver.tick();
  const before = driver.readState(accepted.runId)!;
  const revision = repository.getRun(accepted.runId)!.revision;
  await assert.rejects(driver.reconcile(accepted.runId, revision - 1, 'operator-fixture'),
    error => error instanceof Error && error.message === 'stale_revision');
  const scheduled = await driver.reconcile(accepted.runId, revision, 'operator-fixture');
  const duplicate = await driver.reconcile(accepted.runId, repository.getRun(accepted.runId)!.revision, 'operator-fixture');
  assert.equal(scheduled.disposition, 'scheduled');
  assert.equal(duplicate.disposition, 'already_scheduled');
  assert.equal(duplicate.commandId, scheduled.commandId);
  assert.notEqual(scheduled.commandId, accepted.commandId);
  assert.equal(reconcileCalls, 0);
  const queued = driver.readState(accepted.runId)!;
  assert.notEqual(queued.runtimeAttemptId, before.runtimeAttemptId);
  assert.equal(queued.evaluationAttemptId, before.evaluationAttemptId);
  assert.equal(queued.deadlineAt, before.deadlineAt);
  assert.equal(queued.stageTimeoutMs, before.stageTimeoutMs);
  await driver.tick();
  assert.equal(reconcileCalls, 1);
  assert.equal(executeCalls, 1);
  assert.equal(count(database, 'workflow_commands'), 2);
  assert.equal(count(database, 'runtime_attempts'), 2);
  assert.equal(count(database, 'attempts'), 1);
});
