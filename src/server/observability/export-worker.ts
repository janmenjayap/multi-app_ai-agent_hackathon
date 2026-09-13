import { createHash, randomUUID } from 'node:crypto';
import { canonical, immutable } from '../../shared/domain.js';
import { parseCanonicalEvent } from './events.js';
import { assertNoSecrets } from './redaction.js';
import { LangSmithRunSchema, projectTraceEvent, traceReference, type LangSmithExporter, type LangSmithRun, type TraceExportResult } from './langsmith.js';
import { parseMeasurementJobPolicy, type MeasurementJobPolicy } from '../storage/monitor-store.js';
import type { ApplicationRepository } from '../storage/repositories.js';

export type TraceExportPolicy = MeasurementJobPolicy;
export interface TraceExportOptions {
  redactionKey: string;
  policy: TraceExportPolicy;
  clock?: () => number;
  newLeaseToken?: () => string;
}
export interface TraceExportStatus {
  exportId: string;
  destinationId: string;
  eventId: string;
  runId: string;
  evaluationAttemptId: string;
  sequence: number;
  status: 'pending' | 'leased' | 'completed' | 'exhausted';
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  nextAttemptAt: number;
  remoteRunId: string | null;
  remoteUrl: string | null;
  errorCode: string | null;
}
export interface TraceExportLease extends TraceExportStatus {
  status: 'leased';
  leaseToken: string;
  leaseExpiresAt: number;
  payload: LangSmithRun;
  policy: TraceExportPolicy;
}
export interface TraceExportBatchResult {
  enqueued: number;
  attempted: number;
  exported: number;
  failed: number;
  errorCode: string | null;
}

const ERROR_CODES = new Set(['disabled', 'credentials_unavailable', 'invalid_projection', 'timeout',
  'rate_limited', 'transport_error', 'service_unavailable', 'denied', 'rejected', 'unconfirmed',
  'trace_export_parent_unavailable']);
const count = (value: number, maximum = 1000): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('invalid_trace_export_limit');
  return value;
};
const time = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new Error('invalid_trace_export_time');
  return value;
};
function status(row: Record<string, unknown>): TraceExportStatus {
  return immutable({ exportId: String(row.export_id), destinationId: String(row.destination_id),
    eventId: String(row.event_id), runId: String(row.run_id), evaluationAttemptId: String(row.evaluation_attempt_id),
    sequence: Number(row.sequence), status: row.status as TraceExportStatus['status'], attempts: Number(row.attempts),
    leaseToken: row.lease_token === null ? null : String(row.lease_token),
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    nextAttemptAt: Number(row.next_attempt_at), remoteRunId: row.remote_run_id === null ? null : String(row.remote_run_id),
    remoteUrl: row.remote_url === null ? null : String(row.remote_url), errorCode: row.error_code === null ? null : String(row.error_code) });
}
function policy(row: Record<string, unknown>): TraceExportPolicy {
  return parseMeasurementJobPolicy({ leaseMs: Number(row.lease_ms), maxAttempts: Number(row.max_attempts),
    baseBackoffMs: Number(row.base_backoff_ms), maxBackoffMs: Number(row.max_backoff_ms) });
}

/** Polls the immutable local ledger after commit. Remote I/O never holds a SQLite transaction. */
export class TraceExportOutbox {
  readonly #options: TraceExportOptions;
  readonly #destinationId: string;
  constructor(readonly repository: ApplicationRepository, readonly exporter: LangSmithExporter, options: TraceExportOptions) {
    try {
      if (typeof exporter.destinationId !== 'string' || !exporter.destinationId.length || exporter.destinationId.length > 256 ||
          typeof options.redactionKey !== 'string' || Buffer.byteLength(options.redactionKey) < 32) throw new Error();
      this.#destinationId = exporter.destinationId;
      this.#options = { ...options, policy: immutable(parseMeasurementJobPolicy(options.policy)) };
    } catch { throw new Error('invalid_trace_export_configuration'); }
  }
  private get sql() { return this.repository.database.connection; }
  now(): number { return time((this.#options.clock ?? Date.now)()); }

  enqueue(input: { maxEvents?: number } = {}): number {
    if (!this.exporter.enabled) return 0;
    const limit = count(input.maxEvents ?? 100);
    const now = this.now();
    try {
      return this.repository.database.transaction(() => {
        const rows = this.sql.prepare(`SELECT c.*,e.event_json FROM event_contexts c JOIN events e
          ON e.evaluation_attempt_id=c.evaluation_attempt_id AND e.event_id=c.event_id
          WHERE NOT EXISTS (SELECT 1 FROM trace_exports x WHERE x.destination_id=? AND x.run_id=c.run_id
            AND x.evaluation_attempt_id=c.evaluation_attempt_id AND x.event_id=c.event_id)
          ORDER BY c.run_id,c.sequence LIMIT ?`).all(this.#destinationId, limit);
        for (const row of rows) {
          const p = this.#options.policy;
          const identity = { version: 'q06-v1', destinationId: this.#destinationId, runId: String(row.run_id),
            evaluationAttemptId: String(row.evaluation_attempt_id), eventId: String(row.event_id) };
          const exportId = createHash('sha256').update(canonical(identity)).digest('hex');
          let desiredRunId = traceReference(this.#options.redactionKey, 'invalidProjection', identity);
          let parentRunId: string | null = null;
          let frozenPayload = '{}';
          let errorCode: string | null = null;
          try {
            const event = parseCanonicalEvent(JSON.parse(String(row.event_json)));
            const run = this.repository.getRun(event.runId);
            if (!run) throw new Error();
            const spanRows = this.sql.prepare(`SELECT e.event_json FROM event_contexts c JOIN events e
              ON e.evaluation_attempt_id=c.evaluation_attempt_id AND e.event_id=c.event_id
              WHERE c.run_id=? AND c.evaluation_attempt_id=? AND c.runtime_attempt_id=? AND c.sequence<=?
                AND json_extract(e.event_json,'$.spanId')=? ORDER BY c.sequence LIMIT 10001`)
              .all(event.runId, event.evaluationAttemptId, event.runtimeAttemptId, event.sequence, event.spanId);
            if (spanRows.length > 10000) throw new Error();
            const spanEvents = spanRows.map(item => parseCanonicalEvent(JSON.parse(String(item.event_json))));
            const payload = projectTraceEvent({ event, spanEvents, configuration: run.configuration, redactionKey: this.#options.redactionKey });
            assertNoSecrets(payload);
            const encoded = canonical(payload);
            if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new Error();
            frozenPayload = encoded;
            desiredRunId = payload.id;
            parentRunId = payload.parent_run_id ?? null;
          } catch { errorCode = 'invalid_projection'; }
          this.sql.prepare(`INSERT INTO trace_exports(export_id,destination_id,event_id,run_id,evaluation_attempt_id,
            sequence,desired_run_id,parent_run_id,payload_json,policy_version,lease_ms,max_attempts,base_backoff_ms,
            max_backoff_ms,status,next_attempt_at,created_at,updated_at,error_code) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)`)
            .run(exportId, this.#destinationId, row.event_id, row.run_id, row.evaluation_attempt_id, row.sequence,
              desiredRunId, parentRunId, frozenPayload, p.leaseMs, p.maxAttempts, p.baseBackoffMs, p.maxBackoffMs,
              errorCode ? 'exhausted' : 'pending', now, now, now, errorCode);
        }
        return rows.length;
      });
    } catch { throw new Error('trace_export_storage_failed'); }
  }

  claim(now = this.now()): TraceExportLease | null {
    if (!this.exporter.enabled) return null;
    time(now);
    try {
      return this.repository.database.transaction(() => {
        // Taking a lease consumes an attempt, including a process crash before dispatch.
        this.sql.prepare(`UPDATE trace_exports SET status='exhausted',lease_token=NULL,lease_expires_at=NULL,
          error_code='trace_export_lease_expired',updated_at=? WHERE destination_id=? AND status='leased'
          AND lease_expires_at<=? AND attempts>=max_attempts`).run(now, this.#destinationId, now);
        for (let skipped = 0; skipped < 1000; skipped++) {
          const row = this.sql.prepare(`SELECT x.* FROM trace_exports x WHERE x.destination_id=? AND x.attempts<x.max_attempts
          AND ((x.status='pending' AND x.next_attempt_at<=?) OR (x.status='leased' AND x.lease_expires_at<=?))
          AND NOT EXISTS (SELECT 1 FROM trace_exports prior WHERE prior.destination_id=x.destination_id
            AND prior.run_id=x.run_id AND prior.sequence<x.sequence AND prior.status IN ('pending','leased'))
          ORDER BY x.next_attempt_at,x.run_id,x.sequence LIMIT 1`).get(this.#destinationId, now, now);
          if (!row) return null;
          let payload: LangSmithRun | undefined;
          try {
            const parsed = LangSmithRunSchema.safeParse(JSON.parse(String(row.payload_json)));
            if (parsed.success && parsed.data.id === row.desired_run_id &&
                (parsed.data.parent_run_id ?? null) === row.parent_run_id && parsed.data.extra.metadata.watermark === row.sequence)
              payload = parsed.data;
          } catch { /* A corrupted payload must not become a remote request. */ }
          if (!payload) {
            this.sql.prepare(`UPDATE trace_exports SET status='exhausted',lease_token=NULL,lease_expires_at=NULL,
              error_code='invalid_projection',updated_at=? WHERE export_id=?`).run(now, row.export_id);
            continue;
          }
          const p = policy(row);
          const expiresAt = time(now + p.leaseMs);
          const token = (this.#options.newLeaseToken ?? randomUUID)();
          if (typeof token !== 'string' || token.length < 1 || token.length > 256 || token === row.lease_token) throw new Error();
          this.sql.prepare(`UPDATE trace_exports SET status='leased',lease_token=?,lease_expires_at=?,
            attempts=attempts+1,updated_at=? WHERE export_id=?`).run(token, expiresAt, now, row.export_id);
          return immutable({ ...status(row), status: 'leased' as const, leaseToken: token, leaseExpiresAt: expiresAt,
            attempts: Number(row.attempts) + 1, payload, policy: p });
        }
        return null;
      });
    } catch { throw new Error('trace_export_storage_failed'); }
  }

  /** A stale worker cannot complete a reclaimed, expired, or differently scoped lease. */
  complete(lease: TraceExportLease, result: Extract<TraceExportResult, { status: 'exported' }>, now = this.now()): boolean {
    time(now);
    if (result.remoteRunId !== lease.payload.id) return false;
    if (result.remoteUrl !== null) {
      try { const url = new URL(result.remoteUrl); if (url.protocol !== 'https:' || url.username || url.password) return false; }
      catch { return false; }
    }
    try {
      return this.sql.prepare(`UPDATE trace_exports SET status='completed',lease_token=NULL,lease_expires_at=NULL,
        remote_run_id=?,remote_url=?,error_code=NULL,updated_at=? WHERE export_id=? AND destination_id=?
        AND status='leased' AND lease_token=? AND lease_expires_at>? AND attempts=? AND desired_run_id=?`)
        .run(result.remoteRunId, result.remoteUrl, now, lease.exportId, this.#destinationId, lease.leaseToken,
          now, lease.attempts, result.remoteRunId).changes === 1;
    } catch { throw new Error('trace_export_storage_failed'); }
  }

  fail(lease: TraceExportLease, result: Exclude<TraceExportResult, { status: 'exported' }>, now = this.now()): boolean {
    time(now);
    try {
      return this.repository.database.transaction(() => {
        const row = this.sql.prepare(`SELECT * FROM trace_exports WHERE export_id=? AND destination_id=?
          AND status='leased' AND lease_token=? AND lease_expires_at>? AND attempts=?`)
          .get(lease.exportId, this.#destinationId, lease.leaseToken, now, lease.attempts);
        if (!row) return false;
        const p = policy(row);
        const requestedDelay = Number.isFinite(result.retryAfterMs) && Number(result.retryAfterMs) > 0 ? Number(result.retryAfterMs) : 0;
        const exhausted = result.status !== 'retryable' || Number(row.attempts) >= p.maxAttempts || requestedDelay > p.maxBackoffMs;
        const delay = Math.ceil(Math.min(p.maxBackoffMs, Math.max(requestedDelay, p.baseBackoffMs * 2 ** (Number(row.attempts) - 1))));
        const code = ERROR_CODES.has(result.errorCode) ? result.errorCode : 'trace_export_failed';
        this.sql.prepare(`UPDATE trace_exports SET status=?,next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,
          error_code=?,updated_at=? WHERE export_id=?`)
          .run(exhausted ? 'exhausted' : 'pending', time(now + delay), code, now, lease.exportId);
        return true;
      });
    } catch { throw new Error('trace_export_storage_failed'); }
  }

  list(input: { runId?: string; limit?: number } = {}): TraceExportStatus[] {
    try {
      return this.sql.prepare(`SELECT * FROM trace_exports WHERE destination_id=? AND (? IS NULL OR run_id=?)
        ORDER BY run_id,sequence LIMIT ?`).all(this.#destinationId, input.runId ?? null, input.runId ?? null, count(input.limit ?? 1000)).map(status);
    } catch { throw new Error('trace_export_storage_failed'); }
  }

  async send(lease: TraceExportLease, signal?: AbortSignal): Promise<TraceExportResult> {
    if (!this.exporter.enabled) return { status: 'unavailable', errorCode: 'disabled' };
    if (!this.sql.prepare(`SELECT 1 FROM trace_exports WHERE export_id=? AND destination_id=?
      AND status='leased' AND lease_token=? AND lease_expires_at>? AND attempts=?`)
      .get(lease.exportId, this.#destinationId, lease.leaseToken, this.now(), lease.attempts))
      return { status: 'permanent', errorCode: 'unconfirmed' };
    // A real parent span must already exist remotely, even if its latest update is still pending.
    if (lease.payload.parent_run_id && !this.sql.prepare(`SELECT 1 FROM trace_exports WHERE destination_id=?
      AND run_id=? AND desired_run_id=? AND status='completed' LIMIT 1`)
      .get(this.#destinationId, lease.runId, lease.payload.parent_run_id))
      return { status: 'permanent', errorCode: 'trace_export_parent_unavailable' };
    return this.exporter.export(lease.payload, { signal });
  }
}

/** One bounded pass; telemetry failure is reported without failing product work. */
export async function processTraceExports(outbox: TraceExportOutbox, input: { maxJobs?: number } = {}): Promise<TraceExportBatchResult> {
  const result: TraceExportBatchResult = { enqueued: 0, attempted: 0, exported: 0, failed: 0, errorCode: null };
  try {
    const maxJobs = count(input.maxJobs ?? 100);
    result.enqueued = outbox.enqueue({ maxEvents: maxJobs });
    for (let index = 0; index < maxJobs; index++) {
      const lease = outbox.claim();
      if (!lease) break;
      result.attempted++;
      let response: TraceExportResult;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      try {
        const remainingMs = Math.max(1, lease.leaseExpiresAt - outbox.now());
        // Reserve a little lease time to persist the timeout receipt before expiry.
        const timeoutMs = Math.max(1, remainingMs - Math.min(100, Math.floor(remainingMs / 10)));
        response = await Promise.race([outbox.send(lease, controller.signal), new Promise<TraceExportResult>(resolve => {
          timeout = setTimeout(() => {
            resolve({ status: 'retryable', errorCode: 'timeout' });
            controller.abort();
          }, timeoutMs);
        })]);
      }
      catch { response = { status: 'retryable', errorCode: 'transport_error' }; }
      finally { if (timeout) clearTimeout(timeout); }
      if (response.status === 'exported') {
        if (outbox.complete(lease, response)) result.exported++;
        else {
          outbox.fail(lease, { status: 'retryable', errorCode: 'unconfirmed' });
          result.failed++;
        }
      } else { outbox.fail(lease, response); result.failed++; }
    }
  } catch { result.errorCode = 'trace_export_worker_failed'; }
  return result;
}

/** Explicit lifecycle for the composition root; no background timer starts on import. */
export function startTraceExportWorker(outbox: TraceExportOutbox, options: { intervalMs: number; maxJobs?: number }) {
  count(options.intervalMs, 86_400_000);
  const maxJobs = count(options.maxJobs ?? 100);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let generation = 0;
  let inFlight: Promise<TraceExportBatchResult> | undefined;
  const flush = (): Promise<TraceExportBatchResult> => {
    if (!inFlight) inFlight = processTraceExports(outbox, { maxJobs }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
  const schedule = (startedGeneration: number): void => {
    if (!active || startedGeneration !== generation) return;
    timer = setTimeout(() => { timer = undefined; void flush().finally(() => schedule(startedGeneration)); }, options.intervalMs);
    timer.unref();
  };
  const start = (): void => {
    if (active) return;
    active = true;
    const startedGeneration = ++generation;
    void flush().finally(() => schedule(startedGeneration));
  };
  const stop = async (): Promise<void> => {
    active = false;
    generation++;
    if (timer) clearTimeout(timer);
    timer = undefined;
    await inFlight;
  };
  start();
  return { start, stop, flush };
}
