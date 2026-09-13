import { randomUUID } from 'node:crypto';
import { RuntimeAttemptIdSchema } from '../../shared/domain.js';
import { ApplicationRepository } from '../storage/repositories.js';
import { readApplicationObservation, type ApplicationMonitorOptions } from './worker.js';
import { assessTrace } from './trace-rules.js';

const PROCESS_ID = `monitor-${process.pid}`;
const BOOT_ID = `monitor-boot-${randomUUID()}`;
const cursors = new WeakMap<ApplicationRepository, number>();

/** Repair absent jobs; record a real assessment checkpoint when time changes a verdict.
 * Existing exhausted/leased work is never reset. All writes use B01 transactions. */
export function sweepApplicationJobs(repository: ApplicationRepository, options: ApplicationMonitorOptions,
  nowMs: number, limit = 100): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('invalid_observation_time');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_worker_budget');
  const sql = repository.database.connection;
  const scan = sql.prepare(`SELECT a.rowid AS scan_id,a.evaluation_attempt_id,a.watermark,j.state,s.assessment_json
    FROM attempts a LEFT JOIN measurement_jobs j ON j.evaluation_attempt_id=a.evaluation_attempt_id
      AND j.watermark=a.watermark AND j.evaluator_version='monitor-v2'
    LEFT JOIN assessments s ON s.evaluation_attempt_id=a.evaluation_attempt_id
      AND s.watermark=a.watermark AND s.evaluator_version='monitor-v2'
    WHERE a.schema_version=2 AND a.rowid>? AND (j.id IS NULL OR j.state='complete') ORDER BY a.rowid LIMIT ?`);
  let rows = scan.all(cursors.get(repository) ?? 0, limit);
  if (!rows.length) rows = scan.all(0, limit);
  let queued = 0;
  for (const row of rows) {
    cursors.set(repository, Number(row.scan_id));
    if (queued >= limit) break;
    const id = String(row.evaluation_attempt_id);
    if (row.state === null) {
      repository.database.transaction(() => repository.database.monitor.enqueueInTransaction(id, Number(row.watermark), nowMs));
      queued++;
      continue;
    }
    if (!row.assessment_json) continue;
    try {
      const saved = JSON.parse(String(row.assessment_json));
      if (saved.status === 'passed' || saved.status === 'failed') continue;
      const observation = readApplicationObservation(repository, id, options);
      if (observation.watermark !== Number(row.watermark)) continue;
      const trace = assessTrace({ events: observation.events, manifest: observation.manifest,
        startedAtMs: observation.startedAtMs, nowMs });
      if (!trace.checks.some(check => check.status === 'failed' &&
          !saved.checks.some((old: { code: string; status: string }) => old.code === check.code && old.status === 'failed'))) continue;
      const last = observation.events.at(-1);
      const runtime = last?.runtimeAttemptId ?? sql.prepare(`SELECT runtime_attempt_id FROM runtime_attempts
        WHERE evaluation_attempt_id=? ORDER BY rowid DESC LIMIT 1`).get(id)?.runtime_attempt_id;
      if (!runtime) continue;
      const context = { producerId: 'reliability-monitor', producerVersion: 'monitor-v2',
        runId: observation.registration.runId, evaluationAttemptId: observation.registration.evaluationAttemptId,
        runtimeAttemptId: RuntimeAttemptIdSchema.parse(runtime),
        stage: 'assess' as const, spanId: randomUUID(), parentSpanId: null, causedBy: last ? [last.eventId] : [] };
      const stamp = () => ({ eventId: randomUUID(), at: new Date(nowMs).toISOString(),
        processId: PROCESS_ID, bootId: BOOT_ID, monotonicMs: performance.now() });
      repository.transaction(context, writer => {
        // Another process may have observed the same deadline since our read.
        const current = sql.prepare('SELECT watermark FROM attempts WHERE evaluation_attempt_id=?').get(id);
        if (current?.watermark !== row.watermark) return;
        writer.appendEvent({ kind: 'stage.started' }, stamp());
        writer.appendEvent({ kind: 'stage.finished', outcome: 'succeeded' }, stamp());
        queued++;
      });
    } catch {
      // The original revision remains pending/unverified; no retry budget is reset.
    }
  }
  return queued;
}
