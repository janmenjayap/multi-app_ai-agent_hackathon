import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import { ApplicationDatabase } from '../../src/server/storage/database.js';
import { ApplicationRepository } from '../../src/server/storage/repositories.js';
import { processApplicationJobs, readApplicationReport } from '../../src/server/monitoring/worker.js';
import { assessApplication, type ApplicationObservation } from '../../src/server/monitoring/assess.js';
import { EvaluationAttemptRegistrationSchema, LogicalManifestSchema, OriginalOutputSchema, ReviewLabelSchema,
  type OriginalOutput, type ReviewLabel } from '../../src/shared/evaluation.js';
import { EventBatchV2Schema, EventV2Schema, type EventV2 } from '../../src/shared/events.js';
import type { EventPayload } from '../../src/server/observability/events.js';
import { EvaluationAttemptIdSchema, ExecutionModeSchema, IncidentIdentitySchema, RunIdSchema,
  RestrictedArtifactRefSchema, RuntimeAttemptIdSchema, type RunStatus } from '../../src/shared/domain.js';
import { digest } from '../../src/shared/reliability.js';

const startedAt = '2026-09-14T10:00:00Z';
const startedAtMs = Date.parse(startedAt);
const policy = { leaseMs: 100, maxAttempts: 2, baseBackoffMs: 10, maxBackoffMs: 10 };
const manifest = LogicalManifestSchema.parse({ schemaVersion: 2, manifestId: 'monitor-app-manifest',
  cohortId: 'monitor-app-cohort', suiteEntryId: 'monitor-app-entry', family: 2,
  mode: 'synthetic_fixture', frozenAt: '2026-09-14T09:00:00Z', executionEligible: false,
  expectedUnsafe: false, variantId: 'baseline', repetition: 0, faultIds: [],
  budgets: { activeMs: 1000, humanWaitMs: 2000, wallMs: 3000, recoveryMs: 1000, maxToolAttempts: 10 },
  versions: { app: 'app-2', fixture: 'fixture-2', policy: 'policy-2', prompt: 'prompt-2', model: 'mock-2' },
  requiredRoles: [], expectedTerminalStatus: 'safely_blocked', effects: [], sourceFacts: [],
  protectedRecords: [{ app: 'hubspot', logicalId: 'protected-commitment' }],
  forbiddenEffects: ['send_email', 'delete', 'unapproved_write'],
  claimWindow: { maxEvidenceAgeMs: 1000, settlingMs: 100, cutoffAt: '2026-09-14T10:10:00Z' },
});
const resolveManifest = () => manifest;
const configuration = ExecutionModeSchema.parse({ schemaVersion: 2, modelMode: 'mock', providerMode: 'fake',
  evidenceMode: 'synthetic_fixture', fixtureId: 'monitor-app-fixture' });
const incident = IncidentIdentitySchema.parse({ schemaVersion: 2, repositoryId: 'repository-1', issueId: 'issue-1',
  issueNumber: 1, canonicalUrl: 'https://github.com/fixture/project/issues/1', service: 'service-1', environment: 'test' });
const context = { producerVersion: 'monitor-test-v2', producerId: 'test-producer', runId: RunIdSchema.parse('run-1'),
  evaluationAttemptId: EvaluationAttemptIdSchema.parse('evaluation-1'), runtimeAttemptId: RuntimeAttemptIdSchema.parse('runtime-1'),
  stage: 'analyst' as const, spanId: 'stage-1', parentSpanId: null, causedBy: [] };
let tick = 0;
const stamp = (elapsedMs = 1) => ({ eventId: `monitor-event-${++tick}`, at: new Date(startedAtMs + elapsedMs).toISOString(),
  processId: 'test-process', bootId: 'test-boot', monotonicMs: tick });
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'promiseguard-app-monitor-'));
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
    const source = tx.putArtifact({ artifactId: 'source-1', mediaType: 'application/json', content: '{}' });
    tx.registerEvaluation(EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2,
      runId: context.runId, evaluationAttemptId: context.evaluationAttemptId, suiteEntryId: manifest.suiteEntryId,
      manifestHash: digest(manifest), registeredAt: startedAt, dispatchAt: startedAt,
      preflightRef: source, s0Ref: source, configuration, leg: 'baseline',
    }), policy);
    tx.startRuntime({ runtimeAttemptId: context.runtimeAttemptId, runId: context.runId,
      evaluationAttemptId: context.evaluationAttemptId, startedAt });
    tx.appendEvent({ kind: 'stage.started' }, stamp(0));
  });
  return { open, ...initialized };
}
function changeStatus(repository: ApplicationRepository, status: RunStatus) {
  repository.transaction(context, tx => {
    tx.setRunStatus(status);
    tx.appendEvent({ kind: 'run.status', status }, stamp());
  });
}
function report(repository: ApplicationRepository, elapsedMs: number) {
  return readApplicationReport(repository, { resolveManifest, nowMs: startedAtMs + elapsedMs });
}
function process(repository: ApplicationRepository, elapsedMs: number) {
  return processApplicationJobs(repository, { resolveManifest, clock: () => startedAtMs + elapsedMs });
}

test('an enqueue failure rolls back status and event; the committed checkpoint is assessed after restart', () => {
  const { database, repository, open } = setup();
  const before = repository.getRun(context.runId);
  const events = repository.readEvents({ runId: context.runId });
  const jobs = database.monitor.listJobsV2(context.evaluationAttemptId);
  database.connection.exec(`CREATE TEMP TRIGGER stop_enqueue BEFORE INSERT ON measurement_jobs
    BEGIN SELECT RAISE(ABORT, 'private enqueue error'); END`);
  assert.throws(() => changeStatus(repository, 'failed'), /^Error: application_transaction_failed$/);
  assert.deepEqual(repository.getRun(context.runId), before);
  assert.deepEqual(repository.readEvents({ runId: context.runId }), events);
  assert.deepEqual(database.monitor.listJobsV2(context.evaluationAttemptId), jobs);
  database.connection.exec('DROP TRIGGER stop_enqueue');
  changeStatus(repository, 'failed');
  database.close();
  const reopened = open();
  assert.equal(reopened.repository.getRun(context.runId)!.status, 'failed');
  assert.equal(report(reopened.repository, 10).assessments[0]!.status, 'pending');
  assert.equal(process(reopened.repository, 10).processed, 1);
  const saved = reopened.database.monitor.listAssessmentsV2(context.evaluationAttemptId);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.watermark, 2);
  assert.equal(saved[0]!.evaluatorVersion, 'monitor-v2');
  assert.notEqual(saved[0]!.status, 'passed');
  assert.equal(report(reopened.repository, 10).assessments.length, 1);
  assert.deepEqual(reopened.database.monitor.listAssessments(), [], 'v1 reports exclude v2 receipts');
});

test('a restarted worker waits for a durable lease and fences the expired owner', () => {
  const { database, repository, open } = setup();
  changeStatus(repository, 'failed');
  const old = database.monitor.claimJobV2(startedAtMs + 10, policy)!;
  assert.equal(old.attempts, 1);
  database.close();
  const reopened = open();
  assert.equal(process(reopened.repository, 109).processed, 0);
  assert.equal(process(reopened.repository, 110).processed, 1);
  const saved = reopened.database.monitor.listAssessmentsV2(context.evaluationAttemptId)[0]!;
  assert.throws(() => reopened.database.monitor.completeJobV2(old, startedAtMs + 111, saved), /^Error: stale_job_lease$/);
  assert.throws(() => reopened.database.monitor.failJobV2(old, startedAtMs + 111, policy), /^Error: stale_job_lease$/);
  const job = reopened.database.monitor.listJobsV2(context.evaluationAttemptId).at(-1)!;
  assert.equal(job.status, 'completed');
  assert.equal(job.attempts, 2);
  assert.equal(report(reopened.repository, 111).assessments.length, 1);
});

test('monitor outages remain pending then exhausted across restart without resetting identical input', () => {
  const { database, repository, open } = setup();
  changeStatus(repository, 'failed');
  const outage = (elapsedMs: number) => processApplicationJobs(repository, {
    resolveManifest: () => { throw new Error('collector unavailable'); }, clock: () => startedAtMs + elapsedMs,
  });
  assert.equal(outage(10).failed, 1);
  assert.equal(report(repository, 10).assessments[0]!.status, 'pending');
  assert.equal(outage(19).failed, 0, 'backoff is durable');
  assert.equal(outage(20).failed, 1);
  assert.equal(database.monitor.listJobsV2(context.evaluationAttemptId).at(-1)!.status, 'exhausted');
  assert.deepEqual(database.monitor.listAssessmentsV2(context.evaluationAttemptId), []);
  database.close();
  const reopened = open();
  reopened.database.transaction(() => reopened.database.monitor.enqueueInTransaction(
    context.evaluationAttemptId, 2, startedAtMs + 30, 'monitor-v2'));
  assert.equal(process(reopened.repository, 30).processed, 0);
  assert.equal(process(reopened.repository, 10000).exhausted, 1);
  assert.equal(reopened.database.monitor.listJobsV2(context.evaluationAttemptId).at(-1)!.attempts, 2);
  const after = report(reopened.repository, 10000);
  assert.equal(after.assessments.length, 1);
  assert.equal(after.assessments[0]!.status, 'unverified');
  assert.deepEqual(reopened.database.monitor.listAssessmentsV2(context.evaluationAttemptId), []);
});

test('a no-result start gets a new budget observation without a second evaluation attempt or changed product status', () => {
  const { database, repository } = setup();
  assert.equal(process(repository, 10).processed, 1);
  const first = database.monitor.listAssessmentsV2(context.evaluationAttemptId)[0]!;
  assert.equal(first.watermark, 1);
  assert.ok(['pending', 'unverified'].includes(String(first.status)));
  const afterDeadline = process(repository, 1001);
  assert.ok(afterDeadline.swept > 0);
  assert.equal(afterDeadline.processed, 1);
  const history = database.monitor.listAssessmentsV2(context.evaluationAttemptId);
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], first, 'previous observation is immutable');
  assert.ok(Number(history[1]!.watermark) > Number(first.watermark));
  assert.equal(report(repository, 1001).assessments.length, 1);
  assert.equal(repository.getRun(context.runId)!.status, 'queued');
  assert.equal(process(repository, 1001).processed, 0, 'same deadline is not scheduled repeatedly');
});

test('the bounded sweep repairs a missing measurement job for an existing event watermark', () => {
  const { database, repository } = setup();
  changeStatus(repository, 'safely_blocked');
  database.connection.prepare('DELETE FROM measurement_jobs WHERE evaluation_attempt_id=?').run(context.evaluationAttemptId);
  assert.equal(report(repository, 10).assessments[0]!.status, 'pending');
  const result = process(repository, 10);
  assert.equal(result.swept, 1);
  assert.equal(result.processed, 1);
  assert.equal(database.monitor.listJobsV2(context.evaluationAttemptId).length, 1);
  assert.equal(report(repository, 10).assessments[0]!.watermark, 2);
  assert.equal(repository.readEvents({ runId: context.runId }).length, 2);
});

test.each(['awaiting_approval', 'safely_blocked', 'failed_partial', 'failed'] as const)(
  'the %s application checkpoint receives a v2 assessment with incomplete outcome evidence visible', status => {
    const { database, repository } = setup();
    changeStatus(repository, status);
    assert.equal(process(repository, 10).processed, 1);
    const result = report(repository, 10);
    assert.equal(result.evaluatorVersion, 'monitor-v2');
    assert.equal(result.assessments.length, 1);
    assert.equal(result.assessments[0]!.watermark, 2);
    assert.notEqual(result.assessments[0]!.status, 'passed', 'absent provider evidence cannot produce full success');
    assert.equal(repository.getRun(context.runId)!.status, status);
    assert.equal(database.monitor.listJobsV2(context.evaluationAttemptId).at(-1)!.status, 'completed');
  });

test.each(['completed', 'completed_no_affected_commitments'] as const)(
  'a %s transition without a persisted completion claim cannot enqueue fabricated success', status => {
    const { database, repository } = setup();
    assert.throws(() => changeStatus(repository, status), /^Error: application_transaction_failed$/);
    assert.equal(repository.getRun(context.runId)!.status, 'queued');
    assert.equal(repository.readEvents({ runId: context.runId }).length, 1);
    assert.equal(database.monitor.listJobsV2(context.evaluationAttemptId).length, 1);
    assert.equal(process(repository, 10).processed, 1);
    const assessment = report(repository, 10).assessments[0]!;
    assert.ok(assessment.claimFacts);
    assert.deepEqual(assessment.claimFacts.successClaims, []);
  });

function semanticObservation(corrected = false): ApplicationObservation {
  const semanticManifest = LogicalManifestSchema.parse({ ...manifest, requiredRoles: ['analyst'] });
  const source = RestrictedArtifactRefSchema.parse({ artifactId: 'semantic-source', mediaType: 'application/json',
    byteLength: 2, sha256: digest({ source: 'semantic-fixture' }) });
  const registration = EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2,
    runId: context.runId, evaluationAttemptId: context.evaluationAttemptId, suiteEntryId: semanticManifest.suiteEntryId,
    manifestHash: digest(semanticManifest), registeredAt: startedAt, dispatchAt: startedAt,
    preflightRef: source, s0Ref: source, configuration, leg: 'baseline' });
  const events: EventV2[] = [];
  const append = (payload: EventPayload, modelAttempt?: number) => {
    const sequence = events.length + 1;
    events.push(EventV2Schema.parse({ ...context, schemaVersion: 2, eventId: `semantic-event-${sequence}`,
      sequence, at: new Date(startedAtMs + sequence).toISOString(), processId: 'semantic-process', bootId: 'semantic-boot',
      monotonicMs: sequence, ...payload, ...(modelAttempt ? { spanId: `model-span-${modelAttempt}`, parentSpanId: context.spanId } : {}) }));
  };
  append({ kind: 'stage.started' });
  append({ kind: 'sources.collected', complete: true, collectionRefs: [source] });
  const originalOutputs: OriginalOutput[] = [];
  for (let n = 1; n <= (corrected ? 2 : 1); n++) {
    const roleInvocationKey = JSON.stringify([context.runId, 1, 'analyst']);
    const output = OriginalOutputSchema.parse({ schemaVersion: 2, runId: context.runId,
      evaluationAttemptId: context.evaluationAttemptId, runtimeAttemptId: context.runtimeAttemptId,
      outputId: `semantic-output-${n}`, firstOutputId: 'semantic-output-1', previousOutputId: n === 1 ? null : 'semantic-output-1',
      role: 'analyst', roleInvocationKey, planRevision: 1, modelAttemptId: `semantic-model-${n}`,
      inputDigest: source.sha256, sourceDigests: [source.sha256], configDigest: source.sha256,
      promptVersion: 'prompt-2', modelVersion: 'mock-2', outputSchemaVersion: 'analyst-v2',
      receivedAt: new Date(startedAtMs + events.length + 2).toISOString(),
      rawOutput: { ...source, artifactId: `semantic-output-${n}`, sha256: digest({ output: n }) },
      parseStatus: corrected && n === 1 ? 'malformed' : 'valid',
      validationStatus: corrected && n === 1 ? 'invalid' : 'valid',
      correctionReason: n === 1 ? null : 'Corrected the invalid first response' });
    const model = { role: output.role, roleInvocationKey, planRevision: 1, modelAttemptId: output.modelAttemptId,
      logicalCallId: 'semantic-analyst-call' };
    append({ kind: 'model.attempt.started', ...model, inputDigest: output.inputDigest,
      configDigest: output.configDigest, promptVersion: output.promptVersion, modelVersion: output.modelVersion,
      outputSchemaVersion: output.outputSchemaVersion }, n);
    append({ kind: 'model.attempt.result', ...model, outputRef: output.rawOutput,
      validation: output.validationStatus === 'valid' ? 'valid' : 'invalid', latencyMs: 1, usage: null }, n);
    originalOutputs.push(output);
    if (corrected && n === 1) append({ kind: 'retry.scheduled', target: { type: 'model', modelAttemptId: output.modelAttemptId },
      logicalCallId: model.logicalCallId, owner: 'agent-runtime', reason: 'output_invalid', delayMs: 1, remainingBudgetMs: 100 });
  }
  append({ kind: 'plan.frozen', planRevision: 1, planHash: digest({ plan: 'semantic-fixture' }), planRef: source });
  append({ kind: 'run.status', status: 'awaiting_approval' });
  EventBatchV2Schema.parse({ schemaVersion: 2, runId: context.runId, evaluationAttemptId: context.evaluationAttemptId, events });
  return { schemaVersion: 2, registration, manifest: semanticManifest, watermark: events.length,
    runId: context.runId, evaluationAttemptId: context.evaluationAttemptId, startedAtMs, events, originalOutputs, labels: [] };
}
function semanticLabel(output: OriginalOutput, kind: 'human' | 'fixture'): ReviewLabel {
  return ReviewLabelSchema.parse({ schemaVersion: 2, labelId: `label-${output.outputId}-${kind}`, runId: output.runId,
    evaluationAttemptId: output.evaluationAttemptId, outputId: output.outputId, role: output.role,
    outputDigest: output.rawOutput.sha256, sourceDigests: output.sourceDigests,
    reviewer: kind === 'human' ? { kind, reviewerId: 'reviewer-1', interactionRef: output.rawOutput } : { kind, fixtureId: 'semantic-fixture' },
    reason: 'Synthetic review receipt for testing the trust boundary', reviewedAt: new Date(startedAtMs + 50).toISOString(),
    grounding: true, completeness: true, decision: true, handoff: true, findings: [], supersedesLabelId: null });
}

test('missing labels, fixture labels and untrusted human-shaped labels remain semantically unverified', () => {
  const observation = semanticObservation();
  const output = observation.originalOutputs[0]!;
  for (const variant of [
    { labels: [] },
    { labels: [semanticLabel(output, 'fixture')], isTrustedReview: () => true },
    { labels: [semanticLabel(output, 'human')] },
  ]) {
    const assessment = assessApplication({ ...observation, ...variant }, startedAtMs + 100);
    assert.equal(assessment.facts.quality.analyst!.selectedOutputId, output.outputId);
    assert.equal(assessment.firstProposalAssessment, 'unverified');
    assert.equal(assessment.semanticAssessment, 'unverified');
    assert.equal(assessment.facts.contractPassed, false);
    assert.ok(assessment.checks.some(check => check.code === 'semantic_labels_missing'));
  }
});

test('a reviewed corrected proposal can pass selected-plan semantics while the original failure remains', () => {
  const observation = semanticObservation(true);
  const first = observation.originalOutputs[0]!, corrected = observation.originalOutputs[1]!;
  const label = semanticLabel(corrected, 'human');
  const assessment = assessApplication({ ...observation, labels: [label],
    isTrustedReview: candidate => candidate.labelId === label.labelId }, startedAtMs + 100);
  assert.equal(assessment.firstProposalAssessment, 'failed');
  assert.equal(assessment.semanticAssessment, 'passed');
  assert.deepEqual(assessment.facts.quality.analyst, { firstOutputId: first.outputId, selectedOutputId: corrected.outputId,
    firstProposalAssessment: 'failed', selectedPlanAssessment: 'passed' });
  assert.equal(assessment.outcomeAssessment, 'unverified', 'semantic review cannot replace independent provider evidence');
  assert.equal(assessment.facts.contractPassed, false);
  assert.equal(observation.originalOutputs[0]!.parseStatus, 'malformed');
});

test('reporting retains a pending attempt while its manifest resolver remains unavailable', () => {
  const { repository, database } = setup();
  const result = readApplicationReport(repository, { nowMs: startedAtMs + 10,
    resolveManifest: () => { throw new Error('manifest service unavailable'); } });
  assert.equal(result.assessments.length, 1);
  assert.equal(result.assessments[0]!.evaluationAttemptId, context.evaluationAttemptId);
  assert.equal(result.assessments[0]!.status, 'pending');
  assert.equal(result.assessments[0]!.claimFacts, null, 'resolver outage does not fabricate measured claim facts');
  assert.equal('facts' in result.assessments[0]!, false);
  assert.deepEqual(database.monitor.listAssessmentsV2(context.evaluationAttemptId), []);
  assert.equal(database.monitor.listJobsV2(context.evaluationAttemptId)[0]!.attempts, 0);
});
