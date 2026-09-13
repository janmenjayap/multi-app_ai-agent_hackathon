import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeMonitorSchema, MonitorStore } from '../../dist/server/storage/monitor-store.js';
import { EVALUATOR_VERSION } from '../../dist/shared/reliability.js';

const manifest = () => ({
  schemaVersion: 1, manifestId: 'fixture-empty-v1', cohortId: 'cohort-store-tests',
  mode: 'synthetic_fixture', family: 2, contract: 'checkpoint',
  versions: { app: 'app-1', fixture: 'fixture-1', policy: 'policy-1', prompt: 'prompt-1', model: 'model-1' },
  executionEligible: false, expectedUnsafe: false, requiredRoles: [], recoveryKind: 'none',
  expected: { terminalStatus: 'completed_no_affected_commitments', effects: [], protectedRecords: [{ app: 'hubspot', id: 'protected-1' }] },
  budgets: { activeMs: 1_000, humanWaitMs: 2_000, wallMs: 3_000, recoveryMs: 1_000, maxToolAttempts: 10 },
});
const event = (sequence = 1, atMs = 1_001) => ({
  eventId: `event-${sequence}`, sequence, runtimeAttemptId: 'runtime-1', atMs,
  kind: 'run.status', status: 'completed_no_affected_commitments',
});
const label = () => ({ labelId: 'label-1', proposalEventId: 'proposal-1', role: 'analyst', reviewerKind: 'human', grounding: true, completeness: true, decision: true, handoff: true });
const assessment = (attempt, observedAtMs = 1_010, status = 'unverified') => ({
  schemaVersion: 1, evaluatorVersion: EVALUATOR_VERSION,
  evaluationAttemptId: attempt.evaluationAttemptId, runId: attempt.runId,
  versions: attempt.manifest.versions, cohortId: attempt.manifest.cohortId,
  mode: attempt.manifest.mode, watermark: attempt.watermark, observedAtMs,
  productStatus: null, traceCoverage: attempt.traceComplete ? 'complete' : 'incomplete',
  traceAssessment: 'unverified', outcomeAssessment: 'unverified', semanticAssessment: 'pending', status,
  checks: [], facts: {
    executionEligible: false, contractPassed: false, expectedUnsafe: false, safelyBlocked: false,
    tools: { dispatched: 0, succeeded: 0, firstDispatched: 0, firstSucceeded: 0, byApp: {} },
    predicates: { required: 1, confirmed: 0 }, mutationAcks: { total: 0, verified: 0 },
    recovery: { kind: 'none', eligible: false, passed: false }, creations: { applied: 0, excess: 0 },
    latency: { wallMs: observedAtMs - attempt.startedAtMs, waitMs: 0, activeMs: observedAtMs - attempt.startedAtMs, censored: true },
    quality: {}, critical: { forbiddenOperations: 0, approvalBypasses: 0, incorrectRecipients: 0, unsupportedClaims: 0, falseCompletion: 0, successClaims: 0 },
  },
});

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'promiseguard-monitor-test-'));
  const path = join(directory, 'evidence.sqlite');
  const store = new MonitorStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path, directory };
}

test('registration is immutable and idempotent across restart, and distinct attempts preserve denominators', t => {
  const { store, path } = setup(t);
  const initial = store.register('evaluation-1', 'run-1', manifest(), 1_000);
  assert.equal(initial.watermark, 0);
  assert.deepEqual(store.register('evaluation-1', 'run-1', manifest(), 1_000), initial);
  assert.throws(() => store.register('evaluation-1', 'run-other', manifest(), 1_000), /^Error: attempt_conflict$/);
  assert.throws(() => store.register('evaluation-1', 'run-1', manifest(), 999), /^Error: attempt_conflict$/);
  const changed = manifest(); changed.budgets.wallMs++;
  assert.throws(() => store.register('evaluation-1', 'run-1', changed, 1_000), /^Error: attempt_conflict$/);
  const differentVersion = manifest(); differentVersion.versions.prompt = 'prompt-2';
  assert.throws(() => store.register('evaluation-2', 'run-1', differentVersion, 1_000), /^Error: cohort_version_conflict$/);
  store.register('evaluation-2', 'run-1', manifest(), 1_010);
  store.close();
  const reopened = new MonitorStore(path);
  try {
    assert.equal(reopened.listAttempts().length, 2);
    assert.deepEqual(reopened.getAttempt('evaluation-1'), initial);
    const job = reopened.claimJob(1_020);
    assert.equal(job.evaluationAttemptId, 'evaluation-1');
    assert.equal(job.watermark, 0);
  } finally { reopened.close(); }
});

test('append persists originals, deduplicates canonical replay, and selects latest evidence revision', t => {
  const { store, path } = setup(t);
  store.register('evaluation-1', 'run-1', manifest(), 1_000);
  const batch = { events: [event()], evidence: { before: 'original', after: 'first' }, labels: [label()], traceComplete: true };
  const first = store.append('evaluation-1', batch);
  assert.equal(first.watermark, 1);
  assert.deepEqual(store.append('evaluation-1', structuredClone(batch)), first);
  assert.equal(store.append('evaluation-1', { traceComplete: false }).watermark, 1);
  assert.equal(store.getAttempt('evaluation-1').traceComplete, true);
  const revision = store.append('evaluation-1', { evidence: { after: 'second', before: 'original' }, labels: [{ ...label(), labelId: 'label-2', grounding: false }] });
  assert.equal(revision.watermark, 2);
  assert.equal(revision.labels.length, 2);
  assert.equal(revision.labels.find(l => l.labelId === 'label-1').grounding, true);
  assert.deepEqual(revision.evidence, { after: 'second', before: 'original' });
  store.close();
  const read = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(read.prepare('SELECT count(*) AS n FROM evidence_revisions').get().n, 2);
    assert.equal(read.prepare('SELECT count(*) AS n FROM measurement_jobs').get().n, 3);
    assert.equal(JSON.parse(read.prepare('SELECT evidence_json FROM evidence_revisions WHERE watermark = 1').get().evidence_json).after, 'first');
  } finally { read.close(); }
  const reopened = new MonitorStore(path);
  try {
    assert.deepEqual(reopened.getAttempt('evaluation-1'), revision);
    assert.equal(reopened.claimJob(1_010).watermark, 2, 'superseded intermediate jobs must not evaluate a newer snapshot');
  } finally { reopened.close(); }
});

test('one invalid event or label rolls back all batch changes and its measurement job', t => {
  const { store } = setup(t);
  store.register('evaluation-1', 'run-1', manifest(), 1_000);
  assert.throws(() => store.append('evaluation-1', { events: [event(1), event(3)] }), /^Error: event_sequence_invalid$/);
  assert.equal(store.getAttempt('evaluation-1').events.length, 0);
  assert.equal(store.getAttempt('evaluation-1').watermark, 0);
  assert.throws(() => store.append('evaluation-1', { events: [event(1, 999)] }), /^Error: event_time_invalid$/);
  store.append('evaluation-1', { events: [event()], labels: [label()] });
  assert.throws(() => store.append('evaluation-1', { events: [event(2, 1_002)], labels: [{ ...label(), grounding: false }] }), /^Error: label_conflict$/);
  assert.equal(store.getAttempt('evaluation-1').events.length, 1);
  assert.equal(store.getAttempt('evaluation-1').watermark, 1);
  assert.throws(() => store.append('evaluation-1', { events: [{ ...event(), status: 'failed' }] }), /^Error: event_conflict$/);
  assert.throws(() => store.append('evaluation-1', { events: [event(2, 1_000)] }), /^Error: event_time_invalid$/);
  assert.equal(store.claimJob(1_010).watermark, 1);
  assert.equal(store.claimJob(1_010), null, 'failed append must not create a second pending job');
});

test('sealed traces accept exact event replay and later review evidence but reject new events', t => {
  const { store } = setup(t);
  store.register('evaluation-1', 'run-1', manifest(), 1_000);
  store.append('evaluation-1', { events: [event()], traceComplete: true });
  assert.throws(() => store.append('evaluation-1', { events: [event(2, 1_002)] }), /^Error: trace_sealed$/);
  assert.equal(store.append('evaluation-1', { events: [event()], labels: [label()] }).watermark, 2);
  assert.equal(store.getAttempt('evaluation-1').events.length, 1);
});

test('expired leases are reclaimed with fencing; stale tokens cannot complete or fail another worker', t => {
  const { store } = setup(t);
  const attempt = store.register('evaluation-1', 'run-1', manifest(), 1_000);
  const old = store.claimJob(1_000, 10);
  assert.equal(store.claimJob(1_009, 10), null);
  assert.throws(() => store.completeJob(old, assessment(attempt, 1_010), 1_010), /^Error: stale_job_lease$/);
  const current = store.claimJob(1_010, 100);
  assert.equal(current.id, old.id);
  assert.notEqual(current.leaseToken, old.leaseToken);
  assert.equal(current.attempts, 2);
  assert.throws(() => store.completeJob(old, assessment(attempt, 1_011), 1_011), /^Error: stale_job_lease$/);
  assert.throws(() => store.failJob(old, 1_011), /^Error: stale_job_lease$/);
  assert.equal(store.listAssessments().length, 0);
  store.completeJob(current, assessment(attempt, 1_011), 1_011);
  assert.equal(store.listAssessments().length, 1);
  assert.throws(() => store.completeJob(current, assessment(attempt, 1_012), 1_012), /^Error: stale_job_lease$/);
});

test('worker failures back off and exhaust a finite retry budget without sweep revival', t => {
  const { store } = setup(t);
  store.register('evaluation-1', 'run-1', manifest(), 1_000);
  const first = store.claimJob(1_000);
  store.failJob(first, 1_001);
  assert.equal(store.claimJob(2_000), null);
  const second = store.claimJob(2_001);
  assert.equal(second.attempts, 2);
  store.failJob(second, 2_002);
  assert.equal(store.claimJob(4_001), null);
  const third = store.claimJob(4_002);
  assert.equal(third.attempts, 3);
  store.failJob(third, 4_003);
  assert.equal(store.sweep(100_000), 0);
  assert.equal(store.claimJob(100_000), null);
  assert.equal(store.listAttempts().length, 1);
  assert.equal(store.listAssessments().length, 0, 'exhaustion is never an implicit passing assessment');
});

test('a sequence of crashed workers exhausts lease retries', t => {
  const { store } = setup(t);
  store.register('evaluation-1', 'run-1', manifest(), 1_000);
  assert.equal(store.claimJob(1_000, 10).attempts, 1);
  assert.equal(store.claimJob(1_010, 10).attempts, 2);
  assert.equal(store.claimJob(1_020, 10).attempts, 3);
  assert.equal(store.claimJob(1_030, 10), null);
  assert.equal(store.sweep(100_000), 0);
});

test('sweep reassesses stalled observations without increasing the scenario denominator', t => {
  const { store } = setup(t);
  const attempt = store.register('evaluation-1', 'run-1', manifest(), 1_000);
  const first = store.claimJob(1_000);
  store.completeJob(first, assessment(attempt, 1_001), 1_001);
  assert.equal(store.sweep(31_000), 0);
  assert.equal(store.sweep(31_001), 1);
  assert.equal(store.sweep(31_001), 0);
  const next = store.claimJob(31_001);
  assert.equal(next.id, first.id);
  assert.equal(next.watermark, first.watermark);
  assert.equal(next.attempts, 1);
  store.completeJob(next, assessment(attempt, 31_002, 'failed'), 31_002);
  assert.equal(store.listAssessments().length, 1);
  assert.equal(store.listAssessments()[0].observedAtMs, 31_002);
  assert.equal(store.listAttempts().length, 1);
  assert.equal(store.sweep(100_000), 0);
});

test('assessments bind to immutable attempt metadata and latest watermark survives late old completion', t => {
  const { store, path } = setup(t);
  const initial = store.register('evaluation-1', 'run-1', manifest(), 1_000);
  const oldJob = store.claimJob(1_000);
  const current = store.append('evaluation-1', { events: [event()], traceComplete: true });
  const newJob = store.claimJob(1_001);
  const good = assessment(current, 1_002);
  for (const mutation of [
    { evaluatorVersion: 'other' }, { evaluationAttemptId: 'other' }, { runId: 'other' }, { cohortId: 'other' },
    { mode: 'imported_provider_snapshot' }, { watermark: 999 }, { versions: { ...good.versions, prompt: 'other' } },
    { observedAtMs: 999 }, { observedAtMs: 2_000 },
  ]) assert.throws(() => store.completeJob(newJob, { ...good, ...mutation }, 1_002), /^Error: invalid_assessment$/);
  assert.equal(store.listAssessments().length, 0);
  store.completeJob(newJob, good, 1_002);
  store.completeJob(oldJob, assessment(initial, 1_003), 1_003);
  assert.equal(store.listAssessments().length, 1);
  assert.equal(store.listAssessments()[0].watermark, 1);
  store.close();
  const reopened = new MonitorStore(path);
  try { assert.deepEqual(reopened.listAssessments()[0], good); } finally { reopened.close(); }
});

test('database contents stay private without altering parent permissions; errors contain only fixed codes', t => {
  const { store, path, directory } = setup(t);
  chmodSync(directory, 0o750);
  store.register('evaluation-1', 'run-1', manifest(), 1_000);
  const invalid = { secret: 'PRIVATE-recipient@example.invalid' };
  assert.throws(() => store.append('evaluation-1', { events: [invalid] }), /^Error: invalid_observation_batch$/);
  assert.throws(() => store.register('PRIVATE email@example.invalid', 'run', manifest(), 1_000), /^Error: invalid_identifier$/);
  assert.throws(() => store.getAttempt('missing'), /^Error: attempt_not_found$/);
  assert.throws(() => store.append('evaluation-1', { evidence: { secret: undefined } }), /^Error: invalid_evidence$/);
  const circular = {}; circular.self = circular;
  assert.throws(() => store.append('evaluation-1', { evidence: circular }), /^Error: invalid_evidence$/);
  assert.throws(() => new MonitorStore(join(directory, 'PRIVATE-missing-folder', 'PRIVATE-name.sqlite')), /^Error: store_failure$/);
  store.append('evaluation-1', { evidence: invalid });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  store.close();
  chmodSync(path, 0o644);
  const reopened = new MonitorStore(path);
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o750);
    assert.deepEqual(reopened.getAttempt('evaluation-1').evidence, invalid, 'redacted reports must not destroy original restricted evidence');
  } finally { reopened.close(); }
  assert.throws(() => store.listAttempts(), /^Error: store_closed$/);
});

test('borrowed transaction commits or rolls back application state, observations, and jobs together', t => {
  const { store, path } = setup(t);
  store.close();
  const db = new DatabaseSync(path);
  const borrowed = new MonitorStore(db);
  t.after(() => { borrowed.close(); db.close(); });
  db.exec('CREATE TABLE application_states (run_id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT');
  assert.throws(() => borrowed.registerInTransaction('evaluation-1', 'run-1', manifest(), 1_000), /^Error: transaction_required$/);
  assert.throws(() => borrowed.appendInTransaction('evaluation-1', {}), /^Error: transaction_required$/);
  const write = () => {
    db.prepare('INSERT INTO application_states VALUES (?, ?)').run('run-1', 'completed_no_affected_commitments');
    borrowed.registerInTransaction('evaluation-1', 'run-1', manifest(), 1_000);
    borrowed.appendInTransaction('evaluation-1', { events: [event()], traceComplete: true });
    assert.equal(db.isTransaction, true, 'the caller retains transaction ownership');
  };
  db.exec('BEGIN IMMEDIATE');
  write();
  db.exec('ROLLBACK');
  for (const table of ['application_states', 'attempts', 'events', 'measurement_jobs']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  }
  db.exec('BEGIN IMMEDIATE');
  write();
  db.exec('COMMIT');
  borrowed.close();
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 1, 'closing a borrowed store leaves the caller connection open');
  const reopened = new MonitorStore(path);
  try {
    assert.equal(reopened.getAttempt('evaluation-1').traceComplete, true);
    assert.equal(reopened.claimJob(1_010).watermark, 1);
  } finally { reopened.close(); }
});

test('job insertion failure leaves the outer transaction available for complete rollback', t => {
  const { store, path } = setup(t);
  store.register('evaluation-1', 'run-1', manifest(), 1_000);
  store.close();
  const db = new DatabaseSync(path);
  const borrowed = new MonitorStore(db);
  t.after(() => { borrowed.close(); db.close(); });
  db.exec(`CREATE TABLE application_states (status TEXT NOT NULL) STRICT;
    INSERT INTO application_states VALUES ('executing');
    CREATE TRIGGER fail_new_job BEFORE INSERT ON measurement_jobs WHEN NEW.watermark = 1
    BEGIN SELECT RAISE(ABORT, 'PRIVATE provider failure'); END;`);
  db.exec('BEGIN IMMEDIATE');
  db.prepare('UPDATE application_states SET status = ?').run('failed_partial');
  assert.throws(() => borrowed.appendInTransaction('evaluation-1', { events: [event()], traceComplete: true }), /^Error: store_failure$/);
  assert.equal(db.isTransaction, true);
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT status FROM application_states').get().status, 'executing');
  assert.equal(borrowed.getAttempt('evaluation-1').watermark, 0);
  assert.equal(borrowed.getAttempt('evaluation-1').events.length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM measurement_jobs').get().n, 1);
});

test('additive schema migration preserves v1 and isolates v2 observations and evaluator jobs', t => {
  const { store, path } = setup(t);
  const first = store.register('evaluation-1', 'run-1', manifest(), 1_000);
  const job = store.claimJob(1_000);
  store.completeJob(job, assessment(first, 1_001), 1_001);
  store.close();
  const db = new DatabaseSync(path);
  const borrowed = new MonitorStore(db);
  t.after(() => { borrowed.close(); db.close(); });
  db.exec('ALTER TABLE attempts DROP COLUMN schema_version');
  db.exec('BEGIN IMMEDIATE');
  initializeMonitorSchema(db);
  assert.equal(db.isTransaction, true);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  db.prepare(`INSERT INTO attempts
    (evaluation_attempt_id, run_id, manifest_json, started_at_ms, schema_version) VALUES (?, ?, ?, ?, ?)`)
    .run('evaluation-v2', 'run-v2', '{"schemaVersion":2}', 1_000, 2);
  borrowed.enqueueInTransaction('evaluation-v2', 0, 1_000);
  borrowed.enqueueInTransaction('evaluation-v2', 0, 1_000);
  borrowed.enqueueInTransaction('evaluation-1', 0, 1_000, 'monitor-v2');
  borrowed.appendInTransaction('evaluation-1', { events: [event()] });
  db.exec('COMMIT');
  assert.equal(db.prepare("SELECT state FROM measurement_jobs WHERE evaluation_attempt_id = 'evaluation-1' AND evaluator_version = 'monitor-v2'").get().state, 'queued');
  assert.equal(db.prepare("SELECT count(*) AS n FROM measurement_jobs WHERE evaluation_attempt_id = 'evaluation-v2'").get().n, 1);
  assert.equal(borrowed.listAttempts().length, 1);
  assert.throws(() => borrowed.getAttempt('evaluation-v2'), /^Error: attempt_not_found$/);
  assert.equal(borrowed.listAssessments().length, 1);
  const next = borrowed.claimJob(1_010);
  assert.equal(next.evaluatorVersion, 'monitor-v1');
  borrowed.completeJob(next, assessment(borrowed.getAttempt('evaluation-1'), 1_011, 'passed'), 1_011);
  assert.equal(borrowed.claimJob(100_000), null);
  assert.equal(borrowed.sweep(100_000), 0);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
});

test('v2 jobs bind durable policy, fence expired workers, complete atomically, and preserve exhaustion', t => {
  const { store, path } = setup(t);
  store.close();
  const db = new DatabaseSync(path);
  const borrowed = new MonitorStore(db);
  t.after(() => { borrowed.close(); db.close(); });
  db.exec(`CREATE TABLE measurement_policies (
    evaluation_attempt_id TEXT PRIMARY KEY REFERENCES attempts(evaluation_attempt_id),
    lease_ms INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
    base_backoff_ms INTEGER NOT NULL, max_backoff_ms INTEGER NOT NULL) STRICT`);
  const policy = { leaseMs: 10, maxAttempts: 2, baseBackoffMs: 5, maxBackoffMs: 20 };
  const register = (id, atMs) => {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`INSERT INTO attempts
      (evaluation_attempt_id, run_id, manifest_json, started_at_ms, schema_version) VALUES (?, ?, ?, ?, ?)`)
      .run(id, `run-${id}`, '{"schemaVersion":2}', atMs, 2);
    db.prepare('INSERT INTO measurement_policies VALUES (?, ?, ?, ?, ?)').run(id, 10, 2, 5, 20);
    borrowed.enqueueInTransaction(id, 0, atMs);
    db.exec('COMMIT');
  };
  register('evaluation-v2', 1_000);
  assert.equal(borrowed.listJobsV2('evaluation-v2')[0].status, 'pending');
  assert.throws(() => borrowed.claimJobV2(1_000, { ...policy, maxAttempts: 0 }), /^Error: invalid_job_policy$/);
  const old = borrowed.claimJobV2(1_000, policy);
  assert.equal(borrowed.listJobsV2('evaluation-v2')[0].status, 'leased');
  assert.equal(borrowed.listJobsV2('evaluation-v2')[0].leaseExpiresAt, new Date(1_010).toISOString());
  assert.equal(borrowed.claimJobV2(1_009, policy), null);
  const current = borrowed.claimJobV2(1_010, policy);
  assert.equal(current.attempts, 2);
  assert.notEqual(current.leaseToken, old.leaseToken);
  const result = { schemaVersion: 2, evaluatorVersion: 'monitor-v2', runId: 'run-evaluation-v2',
    evaluationAttemptId: 'evaluation-v2', watermark: 0, observedAtMs: 1_011, status: 'unverified' };
  assert.throws(() => borrowed.failJobV2(old, 1_011, policy), /^Error: stale_job_lease$/);
  assert.throws(() => borrowed.completeJobV2(old, 1_011, result), /^Error: stale_job_lease$/);
  assert.throws(() => borrowed.completeJobV2(current, 1_011, { ...result, runId: 'another-run' }), /^Error: invalid_assessment$/);
  assert.throws(() => borrowed.completeJobV2(current, 1_011, { ...result, authorization: 'Bearer PRIVATE' }), /^Error: secret_in_evidence$/);
  db.exec(`CREATE TRIGGER fail_v2_completion BEFORE UPDATE ON measurement_jobs WHEN NEW.state = 'complete'
    BEGIN SELECT RAISE(ABORT, 'PRIVATE completion failure'); END;`);
  assert.throws(() => borrowed.completeJobV2(current, 1_011, result), /^Error: store_failure$/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM assessments').get().n, 0);
  assert.equal(db.prepare('SELECT state FROM measurement_jobs WHERE id = ?').get(current.id).state, 'leased');
  db.exec('DROP TRIGGER fail_v2_completion');
  borrowed.completeJobV2(current, 1_011, result);
  assert.equal(borrowed.listJobsV2('evaluation-v2')[0].status, 'completed');
  assert.deepEqual(borrowed.listAssessmentsV2('evaluation-v2'), [result]);
  assert.equal(JSON.parse(db.prepare('SELECT assessment_json FROM assessments').get().assessment_json).status, 'unverified');
  assert.throws(() => borrowed.completeJobV2(current, 1_011, result), /^Error: stale_job_lease$/);
  register('evaluation-exhausted', 1_020);
  const failed = borrowed.claimJobV2(1_020, policy);
  assert.throws(() => borrowed.failJobV2(failed, 1_021, { ...policy, maxAttempts: 3 }), /^Error: invalid_job_policy$/);
  borrowed.failJobV2(failed, 1_021, policy);
  assert.equal(borrowed.claimJobV2(1_025, policy), null);
  const crashed = borrowed.claimJobV2(1_026, policy);
  assert.equal(crashed.attempts, 2);
  assert.equal(borrowed.claimJobV2(1_036, policy), null);
  db.exec('BEGIN IMMEDIATE');
  borrowed.enqueueInTransaction('evaluation-exhausted', 0, 2_000);
  db.exec('COMMIT');
  assert.equal(borrowed.claimJobV2(2_000, policy), null);
  assert.equal(borrowed.listJobsV2('evaluation-exhausted')[0].status, 'exhausted');
  assert.deepEqual(borrowed.listAssessmentsV2('evaluation-exhausted'), []);
  assert.equal(db.prepare('SELECT state FROM measurement_jobs WHERE id = ?').get(crashed.id).state, 'failed');
  assert.equal(db.prepare('SELECT count(*) AS n FROM assessments').get().n, 1, 'exhaustion creates no fabricated result');
  assert.equal(db.prepare('SELECT count(*) AS n FROM attempts').get().n, 2, 'worker retries preserve evaluation denominators');
  const reopened = new MonitorStore(path);
  try {
    assert.equal(reopened.claimJobV2(3_000, policy), null);
    assert.equal(reopened.listAssessments().length, 0, 'legacy reports do not parse v2 results');
  } finally { reopened.close(); }
});
