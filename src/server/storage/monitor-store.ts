import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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

const MAX_JOB_ATTEMPTS = 3;
const SWEEP_INTERVAL_MS = 30_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const FIXED_ERRORS = new Set([
  'invalid_identifier', 'invalid_manifest', 'invalid_observation_batch',
  'invalid_time', 'invalid_lease', 'invalid_evidence', 'invalid_assessment',
  'attempt_not_found', 'attempt_conflict', 'cohort_version_conflict', 'event_conflict', 'event_sequence_invalid',
  'event_time_invalid', 'label_conflict', 'trace_sealed', 'stale_job_lease',
  'store_closed', 'store_failure', 'unsupported_store_version',
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

/** Local measurement persistence only. This store never dispatches business work. */
export class MonitorStore {
  #db: DatabaseSync;
  #closed = false;

  constructor(path: string) {
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
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error('unsupported_store_version');
      db.exec(`
        BEGIN IMMEDIATE;
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
        COMMIT;
      `);
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

  #enqueue(id: string, watermark: number, nowMs: number): void {
    this.#db.prepare(`UPDATE measurement_jobs SET state = 'superseded'
      WHERE evaluation_attempt_id = ? AND watermark < ? AND state = 'queued'`).run(id, watermark);
    this.#db.prepare(`INSERT INTO measurement_jobs
      (evaluation_attempt_id, watermark, evaluator_version, state, next_run_at_ms)
      VALUES (?, ?, ?, 'queued', ?) ON CONFLICT DO NOTHING`).run(id, watermark, EVALUATOR_VERSION, nowMs);
  }

  register(evaluationAttemptId: string, runId: string, manifest: unknown, startedAtMs: number): AttemptRecord {
    return this.#transaction(() => {
      assertId(evaluationAttemptId); assertId(runId); time(startedAtMs);
      const parsed = parseManifest(manifest);
      const encoded = json(parsed, 'invalid_manifest');
      for (const row of this.#db.prepare('SELECT manifest_json FROM attempts').all()) {
        const other = JSON.parse(String(row.manifest_json)) as Manifest;
        if (other.cohortId === parsed.cohortId && other.mode === parsed.mode && canonical(other.versions) !== canonical(parsed.versions)) {
          throw new Error('cohort_version_conflict');
        }
      }
      const existing = this.#db.prepare('SELECT * FROM attempts WHERE evaluation_attempt_id = ?').get(evaluationAttemptId);
      if (existing) {
        if (existing.run_id !== runId || existing.started_at_ms !== startedAtMs || existing.manifest_json !== encoded) {
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
    const row = this.#db.prepare('SELECT * FROM attempts WHERE evaluation_attempt_id = ?').get(id);
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
    return this.#guard(() => this.#db.prepare('SELECT evaluation_attempt_id FROM attempts ORDER BY started_at_ms, evaluation_attempt_id')
      .all().map(row => this.#readAttempt(String(row.evaluation_attempt_id))));
  }

  append(id: string, input: unknown): AttemptRecord {
    return this.#transaction(() => {
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
        WHERE state = 'leased' AND lease_until_ms <= ? AND attempts >= ?`).run(nowMs, MAX_JOB_ATTEMPTS);
      const row = this.#db.prepare(`SELECT * FROM measurement_jobs WHERE evaluator_version = ? AND attempts < ?
        AND watermark = (SELECT watermark FROM attempts WHERE attempts.evaluation_attempt_id = measurement_jobs.evaluation_attempt_id)
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

  #assertLease(job: MeasurementJob, nowMs: number): void {
    time(nowMs);
    if (!job || !Number.isSafeInteger(job.id) || job.id <= 0 || typeof job.leaseToken !== 'string') throw new Error('stale_job_lease');
    const row = this.#db.prepare('SELECT * FROM measurement_jobs WHERE id = ?').get(job.id);
    if (!row || row.state !== 'leased' || row.lease_token !== job.leaseToken ||
      Number(row.lease_until_ms) <= nowMs || row.evaluation_attempt_id !== job.evaluationAttemptId ||
      row.watermark !== job.watermark || row.evaluator_version !== EVALUATOR_VERSION ||
      job.evaluatorVersion !== EVALUATOR_VERSION || row.attempts !== job.attempts) throw new Error('stale_job_lease');
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
      for (const attempt of this.#db.prepare('SELECT evaluation_attempt_id, watermark FROM attempts').all()) {
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
    return this.#guard(() => this.#db.prepare(`SELECT a.assessment_json FROM assessments a WHERE NOT EXISTS (
      SELECT 1 FROM assessments newer WHERE newer.evaluation_attempt_id = a.evaluation_attempt_id
      AND newer.evaluator_version = a.evaluator_version AND newer.watermark > a.watermark)
      ORDER BY a.evaluation_attempt_id, a.evaluator_version`).all().map(row => JSON.parse(String(row.assessment_json)) as Assessment));
  }

  /** Exhaustion belongs to the current observation, never to a superseded revision. */
  listFailedJobs(): { evaluationAttemptId: string; watermark: number; attempts: number }[] {
    return this.#guard(() => this.#db.prepare(`SELECT j.evaluation_attempt_id, j.watermark, j.attempts
      FROM measurement_jobs j JOIN attempts a ON a.evaluation_attempt_id = j.evaluation_attempt_id
      AND a.watermark = j.watermark
      WHERE j.evaluator_version = ? AND j.state = 'failed' ORDER BY j.evaluation_attempt_id`)
      .all(EVALUATOR_VERSION).map(row => ({ evaluationAttemptId: String(row.evaluation_attempt_id),
        watermark: Number(row.watermark), attempts: Number(row.attempts) })));
  }

  close(): void {
    if (this.#closed) return;
    this.#guard(() => { this.#db.close(); this.#closed = true; });
  }
}
