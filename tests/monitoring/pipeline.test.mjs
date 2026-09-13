import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { MonitorStore } from '../../dist/server/storage/monitor-store.js';
import { buildFixture } from '../../dist/server/monitoring/demo.js';
import { processJobs, readReport } from '../../dist/server/monitoring/worker.js';

const cli = fileURLToPath(new URL('../../dist/server/monitoring/cli.js', import.meta.url));

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'promiseguard-pipeline-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, db: join(directory, 'monitor.sqlite') };
}

function openStore(t, path) {
  const store = new MonitorStore(path);
  t.after(() => store.close());
  return store;
}

function ingest(store, fixture = buildFixture()) {
  const { manifest, record } = fixture;
  store.register(record.evaluationAttemptId, record.runId, manifest, record.startedAtMs);
  store.append(record.evaluationAttemptId, {
    events: record.events, evidence: record.evidence, labels: record.labels,
    traceComplete: record.traceComplete,
  });
  return fixture;
}

function group(report) {
  assert.equal(report.groups.length, 1);
  assert.equal(report.retainedAttempts, 1);
  return report.groups[0];
}

function command(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return { ...result, data: JSON.parse(result.stdout) };
}

test('registered attempts without observations remain pending in M1 and every required first-proposal denominator', t => {
  const { db } = workspace(t);
  const store = openStore(t, db);
  const { manifest, record } = buildFixture();
  store.register(record.evaluationAttemptId, record.runId, manifest, record.startedAtMs);
  const before = group(readReport(store, record.startedAtMs));
  assert.equal(before.coverage.assessmentStatuses.pending, 1);
  assert.equal(before.metrics.M1.numerator, 0);
  assert.equal(before.metrics.M1.denominator, 1);
  for (const role of manifest.requiredRoles) {
    assert.equal(before.metrics.M7[role].numerator, 0);
    assert.equal(before.metrics.M7[role].denominator, 1);
  }
  assert.equal(before.metrics.M2.overall.denominator, 0);
  assert.equal(before.metrics.M2.overall.rate, null);
  assert.equal(before.metrics.M3.requiredPredicates.numerator, 0);
  assert.ok(before.metrics.M3.requiredPredicates.denominator > 0);
  assert.equal(store.listAssessments().length, 0, 'reading a report cannot pretend a worker assessment was saved');

  assert.deepEqual(processJobs(store, { clock: () => record.startedAtMs + 1, maxJobs: 1 }), { swept: 0, processed: 1, failed: 0, exhausted: 0 });
  const after = group(readReport(store, record.startedAtMs + 1));
  assert.equal(after.coverage.assessmentStatuses.pending, 1);
  assert.equal(after.metrics.M1.denominator, 1);
  assert.equal(after.metrics.M7.analyst.denominator, 1);
  assert.equal(store.listAttempts().length, 1);
});

test('synthetic ingest is pending until measured, then its measured outcome survives close and reopen', t => {
  const { db } = workspace(t);
  const store = openStore(t, db);
  const { record } = ingest(store);
  const now = record.events.at(-1).atMs + 1;
  const before = group(readReport(store, now));
  assert.equal(before.observations[0].productStatus, 'completed');
  assert.equal(before.observations[0].status, 'pending');
  assert.equal(before.metrics.M1.numerator, 0, 'a supplied completed status cannot substitute for the measurement job');
  assert.equal(before.metrics.M7.drafter.numerator, 0);
  assert.equal(before.metrics.M6.uncensored.sampleCount, 0, 'pending measurement cannot establish a verified terminal latency');
  assert.equal(before.metrics.M6.censored.sampleCount, 1);

  assert.deepEqual(processJobs(store, { clock: () => now }), { swept: 0, processed: 1, failed: 0, exhausted: 0 });
  const measured = readReport(store, now);
  assert.equal(group(measured).observations[0].status, 'passed');
  assert.equal(group(measured).metrics.M1.numerator, 1);
  assert.equal(group(measured).metrics.M1.denominator, 1);
  assert.equal(group(measured).mode, 'synthetic_fixture');
  assert.match(measured.limitation, /No live provenance/);
  store.close();
  const reopened = openStore(t, db);
  assert.deepEqual(readReport(reopened, now), measured);
  assert.deepEqual(processJobs(reopened, { clock: () => now + 1 }), { swept: 0, processed: 0, failed: 0, exhausted: 0 });
});

test('new evidence and labels on a sealed trace invalidate the displayed old pass until remeasurement', t => {
  const { db } = workspace(t);
  const store = openStore(t, db);
  const { record } = ingest(store);
  const now = record.events.at(-1).atMs + 1;
  processJobs(store, { clock: () => now });
  assert.equal(group(readReport(store, now)).metrics.M1.numerator, 1);
  const changed = structuredClone(record.evidence);
  changed.snapshots.find(s => s.app === 'gmail').after[0].fields.to = 'wrong@example.invalid';
  store.append(record.evaluationAttemptId, {
    evidence: changed,
    labels: [{ ...record.labels[0], labelId: 'additional-human-review', grounding: false }],
  });
  const pending = group(readReport(store, now + 1));
  assert.equal(pending.observations[0].watermark, 2);
  assert.equal(pending.observations[0].status, 'pending');
  assert.equal(pending.metrics.M1.numerator, 0);
  assert.equal(pending.metrics.M1.denominator, 1);
  assert.equal(pending.metrics.M3.requiredPredicates.numerator, 0);
  assert.equal(pending.metrics.M7.analyst.numerator, 0);
  assert.equal(store.getAttempt(record.evaluationAttemptId).traceComplete, true);
  assert.equal(store.getAttempt(record.evaluationAttemptId).events.length, record.events.length);
  assert.equal(store.listAssessments()[0].watermark, 1, 'the previous assessment stays as history, not current truth');

  assert.deepEqual(processJobs(store, { clock: () => now + 2 }), { swept: 0, processed: 1, failed: 0, exhausted: 0 });
  const failed = group(readReport(store, now + 2));
  assert.equal(failed.observations[0].status, 'failed');
  assert.equal(failed.observations[0].watermark, 2);
  assert.equal(failed.metrics.M1.numerator, 0);
  assert.equal(failed.metrics.M1.denominator, 1);
  assert.equal(failed.critical.totals.incorrectRecipients, 1);
  assert.equal(failed.critical.totals.unsupportedClaims, 1);
});

test('reingesting the identical demonstration preserves one attempt, watermark, and metric denominator', t => {
  const { db } = workspace(t);
  const store = openStore(t, db);
  const fixture = ingest(store);
  const now = fixture.record.events.at(-1).atMs + 1;
  processJobs(store, { clock: () => now });
  const initial = readReport(store, now);
  ingest(store, buildFixture());
  ingest(store, buildFixture());
  assert.equal(store.listAttempts().length, 1);
  assert.equal(store.getAttempt(fixture.record.evaluationAttemptId).watermark, 1);
  assert.deepEqual(processJobs(store, { clock: () => now }), { swept: 0, processed: 0, failed: 0, exhausted: 0 });
  assert.deepEqual(readReport(store, now), initial);
});

test('ongoing unknown write is retained and expires through the sweeper without losing its attempt or failed tool count', t => {
  const { db } = workspace(t);
  const store = openStore(t, db);
  const { manifest, record } = buildFixture();
  store.register(record.evaluationAttemptId, record.runId, manifest, record.startedAtMs);
  const write = record.events.find(e => e.kind === 'tool.dispatch' && e.app === 'gmail' && e.operation === 'create');
  const index = record.events.findIndex(e => e.kind === 'tool.result' && e.providerAttemptId === write.providerAttemptId);
  const events = structuredClone(record.events.slice(0, index + 1));
  events.at(-1).outcome = 'unknown';
  delete events.at(-1).providerId;
  store.append(record.evaluationAttemptId, { events, labels: record.labels, traceComplete: false });
  const early = events.at(-1).atMs + 1;
  assert.equal(processJobs(store, { clock: () => early }).processed, 1);
  const pending = group(readReport(store, early));
  assert.equal(pending.observations[0].status, 'pending');
  assert.ok(pending.observations[0].gaps.some(check => check.code === 'write_outcome_unknown'));
  assert.equal(pending.metrics.M2.overall.denominator - pending.metrics.M2.overall.numerator, 1);
  assert.equal(pending.metrics.M1.denominator, 1);
  assert.equal(pending.metrics.M1.numerator, 0);
  assert.equal(pending.metrics.M6.censored.sampleCount, 1);

  const expired = record.startedAtMs + manifest.budgets.wallMs + 1;
  assert.deepEqual(processJobs(store, { clock: () => expired }), { swept: 1, processed: 1, failed: 0, exhausted: 0 });
  const failed = group(readReport(store, expired));
  assert.equal(failed.observations[0].status, 'failed');
  assert.ok(failed.observations[0].gaps.some(check => check.code === 'deadline_exceeded'));
  assert.ok(failed.observations[0].gaps.some(check => check.code === 'write_outcome_unknown'));
  assert.equal(failed.metrics.M1.denominator, 1);
  assert.equal(failed.metrics.M2.overall.denominator, pending.metrics.M2.overall.denominator);
  assert.equal(failed.metrics.M2.overall.numerator, pending.metrics.M2.overall.numerator);
  assert.equal(failed.metrics.M7.analyst.denominator, 1);
  assert.equal(failed.metrics.M6.censored.sampleCount, 1);
  assert.equal(store.listAttempts().length, 1);
  assert.equal(store.listAssessments().length, 1);
});

test('actual CLI demo and report use durable private storage and repeated demo does not grow the cohort', t => {
  const { db } = workspace(t);
  const first = command(['demo', '--db', db]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.data.demonstration, 'synthetic_monitor_only');
  assert.equal(first.data.worker.processed, 1);
  assert.equal(first.data.worker.failed, 0);
  assert.equal(group(first.data.report).metrics.M1.numerator, 1);
  assert.equal(statSync(db).mode & 0o777, 0o600);

  const read = command(['report', '--db', db]);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(read.data.groups, first.data.report.groups);
  assert.equal(group(read.data).mode, 'synthetic_fixture');
  const repeat = command(['demo', '--db', db]);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(repeat.data.worker.processed, 0);
  assert.equal(group(repeat.data.report).metrics.M1.denominator, 1);
  assert.equal(group(repeat.data.report).metrics.M7.analyst.denominator, 1);
});

test('actual CLI rejects malformed/private input with fixed errors without printing source text or paths', t => {
  const { directory, db } = workspace(t);
  const privatePath = join(directory, 'PRIVATE-filename.json');
  writeFileSync(privatePath, '{ PRIVATE-body recipient=secret@example.invalid', { mode: 0o600 });
  const badJson = command(['register', '--db', db, '--attempt', 'evaluation-1', '--run', 'run-1', '--manifest', privatePath]);
  assert.equal(badJson.status, 2);
  assert.deepEqual(badJson.data, { status: 'error', code: 'invalid_json_file' });
  assert.doesNotMatch(badJson.stdout + badJson.stderr, /PRIVATE-|secret@example|promiseguard-pipeline-test-/);

  writeFileSync(privatePath, JSON.stringify({ private: 'PRIVATE-body secret@example.invalid' }), { mode: 0o600 });
  const badSchema = command(['register', '--db', db, '--attempt', 'evaluation-1', '--run', 'run-1', '--manifest', privatePath]);
  assert.equal(badSchema.status, 2);
  assert.deepEqual(badSchema.data, { status: 'error', code: 'invalid_manifest' });
  assert.doesNotMatch(badSchema.stdout + badSchema.stderr, /PRIVATE-|secret@example|promiseguard-pipeline-test-/);
  const unknown = command(['PRIVATE-command', '--db', db]);
  assert.equal(unknown.status, 2);
  assert.deepEqual(unknown.data, { status: 'error', code: 'invalid_command' });
  assert.doesNotMatch(unknown.stdout + unknown.stderr, /PRIVATE-/);
  const report = command(['report', '--db', db]);
  assert.equal(report.data.retainedAttempts, 0, 'invalid input must not add attempted scenarios');
});

test('actual measure command reports a worker persistence failure nonzero and leaves a pending report, never a fake pass', t => {
  const { db } = workspace(t);
  const store = openStore(t, db);
  const { record } = ingest(store);
  store.close();
  // Simulate a failed assessment commit while leaving the attempt and queue
  // readable. This failure must be counted by the actual CLI worker process.
  const fault = new DatabaseSync(db);
  try {
    fault.exec(`CREATE TRIGGER fail_assessment_insert BEFORE INSERT ON assessments BEGIN
      SELECT RAISE(ABORT, 'PRIVATE-database-fault recipient=secret@example.invalid'); END;`);
  } finally { fault.close(); }
  const measured = command(['measure', '--db', db]);
  assert.equal(measured.status, 1, measured.stderr);
  assert.deepEqual(measured.data, { swept: 0, processed: 0, failed: 1, exhausted: 0 });
  assert.doesNotMatch(measured.stdout + measured.stderr, /PRIVATE-|secret@example|promiseguard-pipeline-test-/);

  const reported = command(['report', '--db', db]);
  assert.equal(reported.status, 0, reported.stderr);
  const pending = group(reported.data);
  assert.equal(pending.observations[0].status, 'pending');
  assert.equal(pending.metrics.M1.numerator, 0);
  assert.equal(pending.metrics.M1.denominator, 1);
  assert.equal(pending.metrics.M7.analyst.numerator, 0);
  assert.equal(pending.metrics.M7.analyst.denominator, 1);
  const reopened = openStore(t, db);
  assert.equal(reopened.getAttempt(record.evaluationAttemptId).watermark, 1);
  assert.equal(reopened.listAssessments().length, 0);
});

test('exhausted worker failures remain visible and keep measure nonzero until a new observation supersedes them', t => {
  const { db } = workspace(t);
  const store = openStore(t, db);
  const { record } = ingest(store);
  const now = record.events.at(-1).atMs + 1;
  const fault = new DatabaseSync(db);
  try {
    fault.exec(`CREATE TRIGGER fail_assessment_insert BEFORE INSERT ON assessments BEGIN
      SELECT RAISE(ABORT, 'PRIVATE-measurement-failure'); END;`);
    assert.deepEqual(processJobs(store, { clock: () => now }), { swept: 0, processed: 0, failed: 1, exhausted: 0 });
    assert.deepEqual(processJobs(store, { clock: () => now + 1_000 }), { swept: 0, processed: 0, failed: 1, exhausted: 0 });
    assert.deepEqual(processJobs(store, { clock: () => now + 3_000 }), { swept: 0, processed: 0, failed: 1, exhausted: 1 });
    assert.deepEqual(processJobs(store, { clock: () => now + 100_000 }), { swept: 0, processed: 0, failed: 0, exhausted: 1 });
    const unverified = group(readReport(store, now + 100_000));
    assert.equal(unverified.observations[0].productStatus, 'completed', 'measurement failure is separate from supplied business status');
    assert.equal(unverified.observations[0].status, 'unverified');
    assert.ok(unverified.observations[0].gaps.some(check => check.code === 'measurement_job_failed'));
    assert.equal(unverified.metrics.M1.numerator, 0);
    assert.equal(unverified.metrics.M1.denominator, 1);
    assert.equal(unverified.metrics.M7.analyst.numerator, 0);
    assert.equal(unverified.metrics.M7.analyst.denominator, 1);
    assert.equal(store.listFailedJobs().length, 1);
    assert.equal(store.listAttempts().length, 1);

    const measured = command(['measure', '--db', db]);
    assert.equal(measured.status, 1, measured.stderr);
    assert.deepEqual(measured.data, { swept: 0, processed: 0, failed: 0, exhausted: 1 });
    assert.doesNotMatch(measured.stdout + measured.stderr, /PRIVATE-/);
    const reported = command(['report', '--db', db]);
    assert.equal(reported.status, 0);
    assert.equal(group(reported.data).observations[0].status, 'unverified');
    assert.ok(group(reported.data).observations[0].gaps.some(check => check.code === 'measurement_job_failed'));

    fault.exec('DROP TRIGGER fail_assessment_insert');
    store.append(record.evaluationAttemptId, { labels: [{ ...record.labels[0], labelId: 'new-independent-review' }] });
    assert.equal(store.listFailedJobs().length, 0, 'failed previous-watermark work is historical, not current exhaustion');
    assert.equal(group(readReport(store, now + 100_001)).observations[0].status, 'pending');
    assert.deepEqual(processJobs(store, { clock: () => now + 100_001 }), { swept: 0, processed: 1, failed: 0, exhausted: 0 });
    assert.equal(group(readReport(store, now + 100_001)).metrics.M1.numerator, 1);
    assert.equal(group(readReport(store, now + 100_001)).metrics.M1.denominator, 1);
  } finally { fault.close(); }
});
