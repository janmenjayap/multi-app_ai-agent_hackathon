import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { immutable } from '../../shared/domain.js';
import { MeasurementJobSchema } from '../../shared/events.js';
import { assertNoSecrets } from '../observability/redaction.js';
import {
  assertId, canonical, EVALUATOR_VERSION, parseBatch, parseManifest,
  type Assessment, type AttemptRecord, type Manifest,
} from '../../shared/reliability.js';

export interface MeasurementJob {
  id: number;
  evaluationAttemptId: string;
  watermark: number;
  evaluatorVersion: string;
  leaseToken: string;
  leaseUntilMs: number;
  attempts: number;
}

export interface MeasurementJobPolicy {
  leaseMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

/** V2 policy is frozen with evaluation registration, not chosen by each worker. */
export function parseMeasurementJobPolicy(value: unknown): MeasurementJobPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_job_policy');
  const policy = value as Record<string, unknown>;
  const fields = ['leaseMs', 'maxAttempts', 'baseBackoffMs', 'maxBackoffMs'];
  if (Object.keys(policy).length !== fields.length || !fields.every(field =>
    Number.isSafeInteger(policy[field]) && Number(policy[field]) > 0 &&
    Number(policy[field]) <= (field === 'maxAttempts' ? 100 : 86_400_000)) ||
    Number(policy.maxBackoffMs) < Number(policy.baseBackoffMs)) throw new Error('invalid_job_policy');
  return { leaseMs: Number(policy.leaseMs), maxAttempts: Number(policy.maxAttempts),
    baseBackoffMs: Number(policy.baseBackoffMs), maxBackoffMs: Number(policy.maxBackoffMs) };
}

const MAX_JOB_ATTEMPTS = 3;
const SWEEP_INTERVAL_MS = 30_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const FIXED_ERRORS = new Set([
  'invalid_identifier', 'invalid_manifest', 'invalid_observation_batch',
  'invalid_time', 'invalid_lease', 'invalid_evidence', 'invalid_assessment',
  'attempt_not_found', 'attempt_conflict', 'cohort_version_conflict', 'event_conflict', 'event_sequence_invalid',
  'event_time_invalid', 'label_conflict', 'trace_sealed', 'stale_job_lease',
  'store_closed', 'store_failure', 'unsupported_store_version', 'transaction_required',
  'invalid_evaluator_version', 'invalid_watermark', 'invalid_job_policy',
  'secret_in_evidence', 'invalid_restricted_artifact',
]);

function time(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_time');
}

// Evidence is unknown at the API boundary, but persistent observations must be
// losslessly representable JSON. Do not silently stringify away invalid values.
function json(value: unknown, errorCode: string): string {
  const seen = new Set<object>();
  const valid = (item: unknown, depth: number): boolean => {
    if (depth > 100) return false;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    seen.add(item);
    const values = Array.isArray(item) ? Array.from(item) : Object.values(item);
    const result = values.every(child => valid(child, depth + 1));
    seen.delete(item);
    return result;
  };
  if (!valid(value, 0)) throw new Error(errorCode);
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) throw new Error(errorCode);
  return encoded;
}

function cleanError(error: unknown): Error {
  return new Error(error instanceof Error && FIXED_ERRORS.has(error.message) ? error.message : 'store_failure');
}

/** Bootstrap the preserved monitor-v1 schema without taking an existing transaction.
 * Application migrations use their own ledger; PRAGMA user_version remains v1. */
export function initializeMonitorSchema(db: DatabaseSync): void {
  const ownsTransaction = !db.isTransaction;
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 0 && version !== 1) throw new Error('unsupported_store_version');
    if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
    db.exec(`
        CREATE TABLE IF NOT EXISTS attempts (
          evaluation_attempt_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          started_at_ms INTEGER NOT NULL,
          watermark INTEGER NOT NULL DEFAULT 0,
          trace_complete INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE TABLE IF NOT EXISTS events (
          evaluation_attempt_id TEXT NOT NULL REFERENCES attempts(evaluation_attempt_id),
          event_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          at_ms INTEGER NOT NULL,
          event_json TEXT NOT NULL,
          PRIMARY KEY (evaluation_attempt_id, event_id),
          UNIQUE (evaluation_attempt_id, sequence)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS labels (
          evaluation_attempt_id TEXT NOT NULL REFERENCES attempts(evaluation_attempt_id),
          label_id TEXT NOT NULL,
          watermark INTEGER NOT NULL,
          label_json TEXT NOT NULL,
          PRIMARY KEY (evaluation_attempt_id, label_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS evidence_revisions (
          evaluation_attempt_id TEXT NOT NULL REFERENCES attempts(evaluation_attempt_id),
          watermark INTEGER NOT NULL,
          evidence_json TEXT NOT NULL,
          PRIMARY KEY (evaluation_attempt_id, watermark)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS measurement_jobs (
          id INTEGER PRIMARY KEY,
          evaluation_attempt_id TEXT NOT NULL REFERENCES attempts(evaluation_attempt_id),
          watermark INTEGER NOT NULL,
          evaluator_version TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('queued', 'leased', 'complete', 'failed', 'superseded')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_run_at_ms INTEGER NOT NULL,
          lease_token TEXT,
          lease_until_ms INTEGER,
          UNIQUE (evaluation_attempt_id, watermark, evaluator_version)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS pending_jobs ON measurement_jobs(state, next_run_at_ms, id);
        CREATE TABLE IF NOT EXISTS assessments (
          evaluation_attempt_id TEXT NOT NULL REFERENCES attempts(evaluation_attempt_id),
          evaluator_version TEXT NOT NULL,
          watermark INTEGER NOT NULL,
          observed_at_ms INTEGER NOT NULL,
          assessment_json TEXT NOT NULL,
          PRIMARY KEY (evaluation_attempt_id, evaluator_version, watermark)
        ) STRICT;
        PRAGMA user_version = 1;
    `);
    if (!db.prepare('PRAGMA table_info(attempts)').all().some(column => column.name === 'schema_version')) {
      db.exec('ALTER TABLE attempts ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version IN (1, 2))');
    }
    if (ownsTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction && db.isTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the sanitized initialization error. */ }
    }
    throw cleanError(error);
  }
}

/** Local measurement persistence only. This store never dispatches business work. */
export class MonitorStore {
  #db: DatabaseSync;
  #closed = false;
  #ownsConnection: boolean;

  /** An injected connection must already have the monitor schema and remains caller-owned. */
  constructor(path: string | DatabaseSync) {
    this.#ownsConnection = typeof path === 'string';
    if (typeof path !== 'string') {
      this.#db = path;
      return;
    }
    let db: DatabaseSync | undefined;
    try {
      if (path !== ':memory:') {
        // Create with restricted permissions before SQLite writes any content.
        // Refuse symlinks; never chmod the parent directory or change its mode.
        const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        try {
          if (!fstatSync(fd).isFile()) throw new Error('store_failure');
          fchmodSync(fd, 0o600);
        } finally { closeSync(fd); }
      }
      db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;');
      initializeMonitorSchema(db);
      this.#db = db;
    } catch (error) {
      try { db?.close(); } catch { /* Preserve the sanitized initialization error. */ }
      throw cleanError(error);
    }
  }

  #guard<T>(action: () => T): T {
    try {
      if (this.#closed) throw new Error('store_closed');
      return action();
    } catch (error) { throw cleanError(error); }
  }

  #transaction<T>(action: () => T): T {
    return this.#guard(() => {
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const result = action();
        this.#db.exec('COMMIT');
        return result;
      } catch (error) {
        try { this.#db.exec('ROLLBACK'); } catch { /* Do not expose SQLite detail. */ }
        throw error;
      }
    });
  }

  #inTransaction<T>(action: () => T): T {
    return this.#guard(() => {
      if (!this.#db.isTransaction) throw new Error('transaction_required');
      return action();
    });
  }

  #enqueue(id: string, watermark: number, nowMs: number, evaluatorVersion = EVALUATOR_VERSION): void {
    this.#db.prepare(`UPDATE measurement_jobs SET state = 'superseded'
      WHERE evaluation_attempt_id = ? AND watermark < ? AND evaluator_version = ? AND state = 'queued'`)
      .run(id, watermark, evaluatorVersion);
    this.#db.prepare(`INSERT INTO measurement_jobs
      (evaluation_attempt_id, watermark, evaluator_version, state, next_run_at_ms)
      VALUES (?, ?, ?, 'queued', ?) ON CONFLICT DO NOTHING`).run(id, watermark, evaluatorVersion, nowMs);
  }

  /** Add the versioned assessment job to the caller's event/state transaction. */
  enqueueInTransaction(id: string, watermark: number, nowMs: number, evaluatorVersion = 'monitor-v2'): void {
    this.#inTransaction(() => {
      assertId(id); time(nowMs);
      if (!['monitor-v1', 'monitor-v2'].includes(evaluatorVersion)) throw new Error('invalid_evaluator_version');
      if (!Number.isSafeInteger(watermark) || watermark < 0) throw new Error('invalid_watermark');
      const attempt = this.#db.prepare('SELECT watermark FROM attempts WHERE evaluation_attempt_id = ?').get(id);
      if (!attempt) throw new Error('attempt_not_found');
      if (attempt.watermark !== watermark) throw new Error('invalid_watermark');
      this.#enqueue(id, watermark, nowMs, evaluatorVersion);
    });
  }

  register(evaluationAttemptId: string, runId: string, manifest: unknown, startedAtMs: number): AttemptRecord {
    return this.#transaction(() => this.registerInTransaction(evaluationAttemptId, runId, manifest, startedAtMs));
  }

  /** Caller owns commit/rollback, including rollback after a validation or write failure. */
  registerInTransaction(evaluationAttemptId: string, runId: string, manifest: unknown, startedAtMs: number): AttemptRecord {
    return this.#inTransaction(() => {
      assertId(evaluationAttemptId); assertId(runId); time(startedAtMs);
      const parsed = parseManifest(manifest);
      const encoded = json(parsed, 'invalid_manifest');
      for (const row of this.#db.prepare('SELECT manifest_json FROM attempts WHERE schema_version = 1').all()) {
        const other = JSON.parse(String(row.manifest_json)) as Manifest;
        if (other.cohortId === parsed.cohortId && other.mode === parsed.mode && canonical(other.versions) !== canonical(parsed.versions)) {
          throw new Error('cohort_version_conflict');
        }
      }
      const existing = this.#db.prepare('SELECT * FROM attempts WHERE evaluation_attempt_id = ?').get(evaluationAttemptId);
      if (existing) {
        if (existing.schema_version !== 1 || existing.run_id !== runId || existing.started_at_ms !== startedAtMs || existing.manifest_json !== encoded) {
          throw new Error('attempt_conflict');
        }
      } else {
        this.#db.prepare(`INSERT INTO attempts
          (evaluation_attempt_id, run_id, manifest_json, started_at_ms) VALUES (?, ?, ?, ?)`)
          .run(evaluationAttemptId, runId, encoded, startedAtMs);
        this.#enqueue(evaluationAttemptId, 0, startedAtMs);
      }
      return this.#readAttempt(evaluationAttemptId);
    });
  }

  #readAttempt(id: string): AttemptRecord {
    const row = this.#db.prepare('SELECT * FROM attempts WHERE evaluation_attempt_id = ? AND schema_version = 1').get(id);
    if (!row) throw new Error('attempt_not_found');
    const evidence = this.#db.prepare(`SELECT evidence_json FROM evidence_revisions
      WHERE evaluation_attempt_id = ? ORDER BY watermark DESC LIMIT 1`).get(id);
    return {
      evaluationAttemptId: id, runId: String(row.run_id),
      manifest: JSON.parse(String(row.manifest_json)) as Manifest,
      startedAtMs: Number(row.started_at_ms), watermark: Number(row.watermark),
      traceComplete: row.trace_complete === 1,
      events: this.#db.prepare('SELECT event_json FROM events WHERE evaluation_attempt_id = ? ORDER BY sequence')
        .all(id).map(event => JSON.parse(String(event.event_json))),
      evidence: evidence ? JSON.parse(String(evidence.evidence_json)) : null,
      labels: this.#db.prepare(`SELECT label_json FROM labels WHERE evaluation_attempt_id = ?
        ORDER BY watermark, label_id`).all(id).map(label => JSON.parse(String(label.label_json))),
    };
  }

  getAttempt(id: string): AttemptRecord {
    return this.#guard(() => { assertId(id); return this.#readAttempt(id); });
  }

  listAttempts(): AttemptRecord[] {
    return this.#guard(() => this.#db.prepare('SELECT evaluation_attempt_id FROM attempts WHERE schema_version = 1 ORDER BY started_at_ms, evaluation_attempt_id')
      .all().map(row => this.#readAttempt(String(row.evaluation_attempt_id))));
  }

  append(id: string, input: unknown): AttemptRecord {
    return this.#transaction(() => this.appendInTransaction(id, input));
  }

  /** Append evidence and its job on the application transaction's exact connection.
   * This method never begins, commits, or rolls back the caller's transaction. */
  appendInTransaction(id: string, input: unknown): AttemptRecord {
    return this.#inTransaction(() => {
      assertId(id);
      const batch = parseBatch(input);
      const previous = this.#readAttempt(id);
      const watermark = previous.watermark + 1;
      let changed = false;
      let lastSequence = previous.events.at(-1)?.sequence ?? 0;
      let lastTime = previous.events.at(-1)?.atMs ?? previous.startedAtMs;
      for (const event of batch.events) {
        const encoded = json(event, 'invalid_observation_batch');
        const old = this.#db.prepare('SELECT event_json FROM events WHERE evaluation_attempt_id = ? AND event_id = ?').get(id, event.eventId);
        if (old) {
          if (old.event_json !== encoded) throw new Error('event_conflict');
          continue;
        }
        if (previous.traceComplete) throw new Error('trace_sealed');
        if (event.sequence !== lastSequence + 1) throw new Error('event_sequence_invalid');
        if (event.atMs < lastTime) throw new Error('event_time_invalid');
        this.#db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)').run(id, event.eventId, event.sequence, event.atMs, encoded);
        lastSequence = event.sequence; lastTime = event.atMs; changed = true;
      }
      for (const label of batch.labels) {
        const encoded = json(label, 'invalid_observation_batch');
        const old = this.#db.prepare('SELECT label_json FROM labels WHERE evaluation_attempt_id = ? AND label_id = ?').get(id, label.labelId);
        if (old) {
          if (old.label_json !== encoded) throw new Error('label_conflict');
          continue;
        }
        this.#db.prepare('INSERT INTO labels VALUES (?, ?, ?, ?)').run(id, label.labelId, watermark, encoded);
        changed = true;
      }
      if (Object.hasOwn(batch, 'evidence')) {
        const encoded = json(batch.evidence, 'invalid_evidence');
        const old = this.#db.prepare(`SELECT evidence_json FROM evidence_revisions
          WHERE evaluation_attempt_id = ? ORDER BY watermark DESC LIMIT 1`).get(id);
        if (!old || old.evidence_json !== encoded) {
          this.#db.prepare('INSERT INTO evidence_revisions VALUES (?, ?, ?)').run(id, watermark, encoded);
          changed = true;
        }
      }
      // A stale sender cannot retract a previously sealed complete trace.
      const complete = previous.traceComplete || batch.traceComplete === true;
      if (complete !== previous.traceComplete) changed = true;
      if (changed) {
        this.#db.prepare('UPDATE attempts SET watermark = ?, trace_complete = ? WHERE evaluation_attempt_id = ?')
          .run(watermark, Number(complete), id);
        this.#enqueue(id, watermark, previous.startedAtMs);
      }
      return this.#readAttempt(id);
    });
  }

  claimJob(nowMs: number, leaseMs = 30_000): MeasurementJob | null {
    return this.#transaction(() => {
      time(nowMs);
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(nowMs + leaseMs)) throw new Error('invalid_lease');
      // Three process crashes/failed leases exhaust the same retry budget as
      // explicit failures. Tokens fence any worker still holding an old lease.
      this.#db.prepare(`UPDATE measurement_jobs SET state = 'failed', lease_token = NULL, lease_until_ms = NULL
        WHERE evaluator_version = ? AND state = 'leased' AND lease_until_ms <= ? AND attempts >= ?`)
        .run(EVALUATOR_VERSION, nowMs, MAX_JOB_ATTEMPTS);
      const row = this.#db.prepare(`SELECT * FROM measurement_jobs WHERE evaluator_version = ? AND attempts < ?
        AND watermark = (SELECT watermark FROM attempts WHERE attempts.evaluation_attempt_id = measurement_jobs.evaluation_attempt_id
          AND attempts.schema_version = 1)
        AND ((state = 'queued' AND next_run_at_ms <= ?) OR (state = 'leased' AND lease_until_ms <= ?))
        ORDER BY next_run_at_ms, id LIMIT 1`).get(EVALUATOR_VERSION, MAX_JOB_ATTEMPTS, nowMs, nowMs);
      if (!row) return null;
      const token = randomUUID();
      this.#db.prepare(`UPDATE measurement_jobs SET state = 'leased', lease_token = ?, lease_until_ms = ?,
        attempts = attempts + 1 WHERE id = ?`).run(token, nowMs + leaseMs, row.id);
      return {
        id: Number(row.id), evaluationAttemptId: String(row.evaluation_attempt_id),
        watermark: Number(row.watermark), evaluatorVersion: String(row.evaluator_version),
        leaseToken: token, leaseUntilMs: nowMs + leaseMs, attempts: Number(row.attempts) + 1,
      };
    });
  }

  #assertLease(job: MeasurementJob, nowMs: number, evaluatorVersion = EVALUATOR_VERSION): void {
    time(nowMs);
    if (!job || !Number.isSafeInteger(job.id) || job.id <= 0 || typeof job.leaseToken !== 'string') throw new Error('stale_job_lease');
    const row = this.#db.prepare('SELECT * FROM measurement_jobs WHERE id = ?').get(job.id);
    if (!row || row.state !== 'leased' || row.lease_token !== job.leaseToken ||
      Number(row.lease_until_ms) <= nowMs || row.evaluation_attempt_id !== job.evaluationAttemptId ||
      row.watermark !== job.watermark || row.evaluator_version !== evaluatorVersion ||
      job.evaluatorVersion !== evaluatorVersion || row.attempts !== job.attempts) throw new Error('stale_job_lease');
  }

  /** V2 workers may only use the immutable policy persisted with the evaluation. */
  claimJobV2(nowMs: number, input: MeasurementJobPolicy): MeasurementJob | null {
    return this.#transaction(() => {
      time(nowMs);
      const policy = parseMeasurementJobPolicy(input);
      if (!Number.isSafeInteger(nowMs + policy.leaseMs)) throw new Error('invalid_lease');
      const matchingPolicy = [policy.leaseMs, policy.maxAttempts, policy.baseBackoffMs, policy.maxBackoffMs];
      this.#db.prepare(`UPDATE measurement_jobs SET state = 'failed', lease_token = NULL, lease_until_ms = NULL
        WHERE evaluator_version = 'monitor-v2' AND state = 'leased' AND lease_until_ms <= ? AND attempts >= ?
        AND evaluation_attempt_id IN (SELECT evaluation_attempt_id FROM measurement_policies
          WHERE lease_ms = ? AND max_attempts = ? AND base_backoff_ms = ? AND max_backoff_ms = ?)`)
        .run(nowMs, policy.maxAttempts, ...matchingPolicy);
      const row = this.#db.prepare(`SELECT j.* FROM measurement_jobs j
        JOIN attempts a ON a.evaluation_attempt_id = j.evaluation_attempt_id AND a.watermark = j.watermark AND a.schema_version = 2
        JOIN measurement_policies p ON p.evaluation_attempt_id = j.evaluation_attempt_id
        WHERE j.evaluator_version = 'monitor-v2' AND j.attempts < ?
          AND p.lease_ms = ? AND p.max_attempts = ? AND p.base_backoff_ms = ? AND p.max_backoff_ms = ?
          AND ((j.state = 'queued' AND j.next_run_at_ms <= ?) OR (j.state = 'leased' AND j.lease_until_ms <= ?))
        ORDER BY j.next_run_at_ms, j.id LIMIT 1`).get(policy.maxAttempts, ...matchingPolicy, nowMs, nowMs);
      if (!row) return null;
      const token = randomUUID();
      this.#db.prepare(`UPDATE measurement_jobs SET state = 'leased', lease_token = ?, lease_until_ms = ?,
        attempts = attempts + 1 WHERE id = ?`).run(token, nowMs + policy.leaseMs, row.id);
      return { id: Number(row.id), evaluationAttemptId: String(row.evaluation_attempt_id),
        watermark: Number(row.watermark), evaluatorVersion: 'monitor-v2', leaseToken: token,
        leaseUntilMs: nowMs + policy.leaseMs, attempts: Number(row.attempts) + 1 };
    });
  }

  failJobV2(job: MeasurementJob, nowMs: number, input: MeasurementJobPolicy): void {
    this.#transaction(() => {
      this.#assertLease(job, nowMs, 'monitor-v2');
      const policy = parseMeasurementJobPolicy(input);
      const stored = this.#db.prepare(`SELECT lease_ms, max_attempts, base_backoff_ms, max_backoff_ms
        FROM measurement_policies WHERE evaluation_attempt_id = ?`).get(job.evaluationAttemptId);
      if (!stored || stored.lease_ms !== policy.leaseMs || stored.max_attempts !== policy.maxAttempts ||
        stored.base_backoff_ms !== policy.baseBackoffMs || stored.max_backoff_ms !== policy.maxBackoffMs) {
        throw new Error('invalid_job_policy');
      }
      const exhausted = job.attempts >= policy.maxAttempts;
      const delay = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** (job.attempts - 1));
      if (!Number.isSafeInteger(nowMs + delay)) throw new Error('invalid_time');
      this.#db.prepare(`UPDATE measurement_jobs SET state = ?, next_run_at_ms = ?, lease_token = NULL, lease_until_ms = NULL
        WHERE id = ?`).run(exhausted ? 'failed' : 'queued', nowMs + delay, job.id);
    });
  }

  /** Persist the evaluator's versioned result and complete its lease atomically.
   * B01 validates storage identity and JSON; Q03 validates assessment semantics. */
  completeJobV2(job: MeasurementJob, nowMs: number, input: unknown): void {
    this.#transaction(() => {
      this.#assertLease(job, nowMs, 'monitor-v2');
      assertNoSecrets(input);
      const attempt = this.#db.prepare(`SELECT run_id, started_at_ms FROM attempts
        WHERE evaluation_attempt_id = ? AND schema_version = 2`).get(job.evaluationAttemptId);
      const assessment = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
      if (!attempt || !assessment || assessment.schemaVersion !== 2 || assessment.evaluatorVersion !== 'monitor-v2' ||
        assessment.evaluationAttemptId !== job.evaluationAttemptId || assessment.runId !== attempt.run_id ||
        assessment.watermark !== job.watermark || !Number.isSafeInteger(assessment.observedAtMs) ||
        Number(assessment.observedAtMs) < Number(attempt.started_at_ms) || Number(assessment.observedAtMs) > nowMs) {
        throw new Error('invalid_assessment');
      }
      const encoded = json(assessment, 'invalid_assessment');
      this.#db.prepare(`INSERT INTO assessments
        (evaluation_attempt_id, evaluator_version, watermark, observed_at_ms, assessment_json) VALUES (?, ?, ?, ?, ?)`)
        .run(job.evaluationAttemptId, 'monitor-v2', job.watermark, Number(assessment.observedAtMs), encoded);
      this.#db.prepare(`UPDATE measurement_jobs SET state = 'complete', lease_token = NULL, lease_until_ms = NULL
        WHERE id = ?`).run(job.id);
    });
  }

  /** Internal superseded rows are retained in SQLite but have no F02 public status. */
  listJobsV2(evaluationAttemptId: string): ReadonlyArray<Readonly<ReturnType<typeof MeasurementJobSchema.parse>>> {
    return this.#guard(() => {
      assertId(evaluationAttemptId);
      const statuses: Record<string, string> = { queued: 'pending', leased: 'leased', complete: 'completed', failed: 'exhausted' };
      return immutable(this.#db.prepare(`SELECT j.*, a.run_id FROM measurement_jobs j
        JOIN attempts a ON a.evaluation_attempt_id = j.evaluation_attempt_id AND a.schema_version = 2
        WHERE j.evaluation_attempt_id = ? AND j.evaluator_version = 'monitor-v2' AND j.state <> 'superseded'
        ORDER BY j.watermark, j.id`).all(evaluationAttemptId).map(row => MeasurementJobSchema.parse({
          schemaVersion: 2, jobId: String(row.id), evaluationAttemptId: String(row.evaluation_attempt_id),
          runId: String(row.run_id), evaluatorVersion: 'monitor-v2', watermark: Number(row.watermark),
          status: statuses[String(row.state)], leaseToken: row.lease_token,
          leaseExpiresAt: row.lease_until_ms === null ? null : new Date(Number(row.lease_until_ms)).toISOString(),
          attempts: Number(row.attempts),
        })));
    });
  }

  /** Return all preserved v2 revisions after checking their bounded JSON and durable identity. */
  listAssessmentsV2(evaluationAttemptId: string): ReadonlyArray<Readonly<Record<string, unknown>>> {
    return this.#guard(() => {
      assertId(evaluationAttemptId);
      return immutable(this.#db.prepare(`SELECT s.*, a.run_id FROM assessments s
        JOIN attempts a ON a.evaluation_attempt_id = s.evaluation_attempt_id AND a.schema_version = 2
        WHERE s.evaluation_attempt_id = ? AND s.evaluator_version = 'monitor-v2' ORDER BY s.watermark`)
        .all(evaluationAttemptId).map(row => {
          const encoded = String(row.assessment_json);
          if (Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) throw new Error('invalid_assessment');
          const assessment: unknown = JSON.parse(encoded);
          if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) throw new Error('invalid_assessment');
          const data = assessment as Record<string, unknown>;
          if (data.schemaVersion !== 2 || data.evaluatorVersion !== row.evaluator_version ||
            data.evaluationAttemptId !== row.evaluation_attempt_id || data.runId !== row.run_id ||
            data.watermark !== row.watermark || data.observedAtMs !== row.observed_at_ms) throw new Error('invalid_assessment');
          assertNoSecrets(data);
          return data;
        }));
    });
  }

  completeJob(job: MeasurementJob, assessment: Assessment, nowMs = Date.now()): void {
    this.#transaction(() => {
      this.#assertLease(job, nowMs);
      const attempt = this.#readAttempt(job.evaluationAttemptId);
      if (!assessment || assessment.schemaVersion !== 1 || assessment.evaluatorVersion !== EVALUATOR_VERSION ||
        assessment.evaluationAttemptId !== job.evaluationAttemptId || assessment.watermark !== job.watermark ||
        assessment.runId !== attempt.runId || assessment.cohortId !== attempt.manifest.cohortId || assessment.mode !== attempt.manifest.mode ||
        canonical(assessment.versions) !== canonical(attempt.manifest.versions) ||
        !Number.isSafeInteger(assessment.observedAtMs) || assessment.observedAtMs < attempt.startedAtMs ||
        assessment.observedAtMs > nowMs || !['pending','unverified','passed','failed'].includes(assessment.status)) {
        throw new Error('invalid_assessment');
      }
      const encoded = json(assessment, 'invalid_assessment');
      this.#db.prepare(`INSERT INTO assessments VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(evaluation_attempt_id, evaluator_version, watermark) DO UPDATE SET
        observed_at_ms = excluded.observed_at_ms, assessment_json = excluded.assessment_json`)
        .run(job.evaluationAttemptId, EVALUATOR_VERSION, job.watermark, assessment.observedAtMs, encoded);
      this.#db.prepare(`UPDATE measurement_jobs SET state = 'complete', lease_token = NULL, lease_until_ms = NULL WHERE id = ?`).run(job.id);
    });
  }

  failJob(job: MeasurementJob, nowMs: number): void {
    this.#transaction(() => {
      this.#assertLease(job, nowMs);
      const exhausted = job.attempts >= MAX_JOB_ATTEMPTS;
      const delay = 1_000 * 2 ** (job.attempts - 1);
      if (!Number.isSafeInteger(nowMs + delay)) throw new Error('invalid_time');
      this.#db.prepare(`UPDATE measurement_jobs SET state = ?, next_run_at_ms = ?, lease_token = NULL, lease_until_ms = NULL
        WHERE id = ?`).run(exhausted ? 'failed' : 'queued', nowMs + delay, job.id);
    });
  }

  sweep(nowMs: number): number {
    return this.#transaction(() => {
      time(nowMs);
      let queued = 0;
      for (const attempt of this.#db.prepare('SELECT evaluation_attempt_id, watermark FROM attempts WHERE schema_version = 1').all()) {
        const id = String(attempt.evaluation_attempt_id);
        const watermark = Number(attempt.watermark);
        const job = this.#db.prepare(`SELECT id, state FROM measurement_jobs
          WHERE evaluation_attempt_id = ? AND watermark = ? AND evaluator_version = ?`).get(id, watermark, EVALUATOR_VERSION);
        if (!job) { this.#enqueue(id, watermark, nowMs); queued++; continue; }
        if (job.state !== 'complete') continue;
        const record = this.#db.prepare(`SELECT assessment_json, observed_at_ms FROM assessments
          WHERE evaluation_attempt_id = ? AND watermark = ? AND evaluator_version = ?`).get(id, watermark, EVALUATOR_VERSION);
        const assessment = record ? JSON.parse(String(record.assessment_json)) as Assessment : null;
        if (!assessment || (['pending', 'unverified'].includes(assessment.status) &&
          nowMs - Number(record!.observed_at_ms) >= SWEEP_INTERVAL_MS)) {
          this.#db.prepare(`UPDATE measurement_jobs SET state = 'queued', attempts = 0, next_run_at_ms = ? WHERE id = ?`).run(nowMs, job.id);
          queued++;
        }
      }
      return queued;
    });
  }

  listAssessments(): Assessment[] {
    return this.#guard(() => this.#db.prepare(`SELECT a.assessment_json FROM assessments a
      JOIN attempts attempt ON attempt.evaluation_attempt_id = a.evaluation_attempt_id
      WHERE attempt.schema_version = 1 AND a.evaluator_version = 'monitor-v1' AND NOT EXISTS (
      SELECT 1 FROM assessments newer WHERE newer.evaluation_attempt_id = a.evaluation_attempt_id
      AND newer.evaluator_version = a.evaluator_version AND newer.watermark > a.watermark)
      ORDER BY a.evaluation_attempt_id, a.evaluator_version`).all().map(row => JSON.parse(String(row.assessment_json)) as Assessment));
  }

  /** Exhaustion belongs to the current observation, never to a superseded revision. */
  listFailedJobs(): { evaluationAttemptId: string; watermark: number; attempts: number }[] {
    return this.#guard(() => this.#db.prepare(`SELECT j.evaluation_attempt_id, j.watermark, j.attempts
      FROM measurement_jobs j JOIN attempts a ON a.evaluation_attempt_id = j.evaluation_attempt_id
      AND a.watermark = j.watermark AND a.schema_version = 1
      WHERE j.evaluator_version = ? AND j.state = 'failed' ORDER BY j.evaluation_attempt_id`)
      .all(EVALUATOR_VERSION).map(row => ({ evaluationAttemptId: String(row.evaluation_attempt_id),
        watermark: Number(row.watermark), attempts: Number(row.attempts) })));
  }

  close(): void {
    if (this.#closed) return;
    this.#guard(() => {
      if (this.#ownsConnection) this.#db.close();
      this.#closed = true;
    });
  }
}
