import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { AppSchema, CountSchema, DigestSchema, ExecutionModeSchema, ProductStatusSchema,
  RoleSchema, StageIdSchema, UtcTimestampSchema, canonical, immutable, type ExecutionMode } from '../../shared/domain.js';
import { EventErrorCodeSchema, EventV2Schema, ObservedOperationSchema, type EventV2 } from '../../shared/events.js';
import { collectArtifactReferences } from './events.js';

export const TRACE_PROJECTION_VERSION = 'q06-v1' as const;
const uuid = z.uuid();
const optionalId = uuid.nullable().optional();
const eventKinds = EventV2Schema.options.map(schema => schema.shape.kind.value);
const attributes = z.object({
  eventId: uuid, sequence: CountSchema, stage: StageIdSchema, producerVersion: uuid,
  causedBy: z.array(uuid).max(100), planRevision: CountSchema.optional(),
  logicalCallId: optionalId, modelAttemptId: optionalId, providerAttemptId: optionalId,
  claimId: optionalId, effectKey: optionalId, approvalId: optionalId, readAttemptId: optionalId, verificationId: optionalId,
  claimScope: z.enum(['artifacts', 'run', 'no_affected']).optional(),
  effectKeys: z.array(uuid).max(500).optional(), verificationIds: z.array(uuid).max(500).optional(),
  promptVersion: optionalId, modelVersion: optionalId, outputSchemaVersion: optionalId,
  inputDigest: DigestSchema.optional(), configDigest: DigestSchema.optional(),
  requestDigest: DigestSchema.nullable().optional(), planHash: DigestSchema.nullable().optional(),
  latencyMs: CountSchema.nullable().optional(), role: RoleSchema.optional(), app: AppSchema.optional(),
  operation: ObservedOperationSchema.optional(), errorCode: EventErrorCodeSchema.optional(),
  validation: z.enum(['valid', 'invalid', 'refused']).optional(),
  transportOutcome: z.enum(['response', 'timeout', 'error']).optional(),
  providerOutcome: z.enum(['success', 'error', 'unknown']).optional(),
  outcome: z.enum(['succeeded', 'failed', 'blocked', 'skipped', 'not_applied', 'unknown']).optional(),
  status: ProductStatusSchema.optional(), allowed: z.boolean().optional(), complete: z.boolean().optional(),
  verdict: z.enum(['matched', 'mismatched', 'unverified']).optional(),
  decision: z.enum(['approved', 'rejected', 'invalid', 'expired']).optional(),
  resolution: z.enum(['adopted', 'not_applied', 'unresolved', 'conflict']).optional(),
  delayMs: CountSchema.optional(), remainingBudgetMs: CountSchema.optional(),
  usage: z.object({ inputTokens: CountSchema, outputTokens: CountSchema }).strict().nullable().optional(),
  evidenceRefs: z.array(z.object({ artifactId: uuid, sha256: DigestSchema }).strict()).max(1000),
}).strict();
const metadata = z.object({ schemaVersion: z.literal(2), projectionVersion: z.literal(TRACE_PROJECTION_VERSION),
  runId: uuid, evaluationAttemptId: uuid, runtimeAttemptId: uuid, spanId: uuid,
  watermark: CountSchema, modelMode: ExecutionModeSchema.shape.modelMode,
  providerMode: ExecutionModeSchema.shape.providerMode, evidenceMode: ExecutionModeSchema.shape.evidenceMode,
  projectionDigest: DigestSchema,
}).strict();

/** Only this allowlist may cross the diagnostic boundary, including after an outbox reload. */
export const LangSmithRunSchema = z.object({
  id: uuid, parent_run_id: uuid.optional(), name: z.union([StageIdSchema, RoleSchema, ObservedOperationSchema]),
  run_type: z.enum(['chain', 'llm', 'tool']), start_time: UtcTimestampSchema, end_time: UtcTimestampSchema.optional(),
  inputs: z.object({}).strict(), outputs: z.object({}).strict(),
  events: z.array(z.object({ name: z.enum(eventKinds), time: UtcTimestampSchema, kwargs: attributes }).strict()).min(1).max(10000),
  extra: z.object({ metadata }).strict(),
}).strict();
export type LangSmithRun = z.infer<typeof LangSmithRunSchema>;
export type TraceExportResult = { status: 'exported'; remoteRunId: string; remoteUrl: string | null }
  | { status: 'unavailable' | 'retryable' | 'permanent'; errorCode: string; retryAfterMs?: number };
export interface LangSmithExporter {
  readonly destinationId: string;
  readonly enabled: boolean;
  export(run: LangSmithRun, options?: { signal?: AbortSignal }): Promise<TraceExportResult>;
}

/** Recompute locally with the same server-only key to navigate from an assessment to a trace. */
export function traceReference(redactionKey: string, kind: string, identity: unknown): string {
  if (Buffer.byteLength(redactionKey) < 32) throw new Error('invalid_trace_redaction_key');
  const bytes = createHmac('sha256', redactionKey)
    .update(canonical({ version: TRACE_PROJECTION_VERSION, kind, identity })).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // RFC 9562 application-defined UUIDv8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function projectAttributes(event: EventV2, key: string) {
  const ref = (kind: string, value: unknown) => value === null ? null : traceReference(key, kind, value);
  const projected: Record<string, unknown> = { eventId: ref('eventId', event.eventId),
    sequence: event.sequence, stage: event.stage, producerVersion: ref('producerVersion', event.producerVersion),
    causedBy: event.causedBy.map(id => ref('eventId', id)),
    evidenceRefs: collectArtifactReferences(event).map(item => ({ artifactId: ref('artifactId', item.artifactId), sha256: item.sha256 })),
  };
  // F02 validates each enum/number/digest first. Never copy arbitrary text or nested payloads.
  for (const field of ['planRevision', 'inputDigest', 'configDigest', 'requestDigest', 'planHash', 'latencyMs',
    'role', 'app', 'operation', 'errorCode', 'validation', 'transportOutcome', 'providerOutcome', 'outcome',
    'status', 'allowed', 'complete', 'verdict', 'decision', 'resolution', 'delayMs', 'remainingBudgetMs', 'usage'] as const) {
    if (field in event) projected[field] = event[field as keyof EventV2];
  }
  for (const field of ['logicalCallId', 'modelAttemptId', 'providerAttemptId', 'effectKey', 'approvalId',
    'readAttemptId', 'verificationId', 'promptVersion', 'modelVersion', 'outputSchemaVersion'] as const) {
    if (field in event) projected[field] = ref(field === 'readAttemptId' ? 'providerAttemptId' : field, event[field as keyof EventV2]);
  }
  if (event.kind === 'success.claimed') {
    projected.claimId = ref('claimId', event.claim.claimId);
    projected.claimScope = event.claim.scope;
    if (event.claim.scope !== 'no_affected') {
      projected.planHash = event.claim.planHash;
      projected.effectKeys = event.claim.effectKeys.map(id => ref('effectKey', id));
      projected.verificationIds = event.claim.verifications.map(item => ref('verificationId', item.verificationId));
    }
  }
  if (event.kind === 'retry.scheduled') {
    projected.errorCode = event.reason;
    const field = event.target.type === 'model' ? 'modelAttemptId' : 'providerAttemptId';
    projected[field] = ref(field, event.target.type === 'model' ? event.target.modelAttemptId : event.target.providerAttemptId);
  }
  return attributes.parse(projected);
}

function projectionDigest(run: Omit<LangSmithRun, 'extra'> & { extra: { metadata: Omit<LangSmithRun['extra']['metadata'], 'projectionDigest'> } }) {
  return createHash('sha256').update(canonical(run)).digest('hex');
}

export function projectTraceEvent(input: { event: EventV2; spanEvents: readonly EventV2[];
  configuration: ExecutionMode; redactionKey: string }): LangSmithRun {
  const event = EventV2Schema.parse(input.event);
  const configuration = ExecutionModeSchema.parse(input.configuration);
  const events = input.spanEvents.map(value => EventV2Schema.parse(value));
  const first = events[0];
  if (!first || !['stage.started', 'model.attempt.started', 'tool.dispatch'].includes(first.kind) ||
      events.at(-1)?.eventId !== event.eventId || events.some((item, index) =>
        item.runId !== event.runId || item.evaluationAttemptId !== event.evaluationAttemptId ||
        item.runtimeAttemptId !== event.runtimeAttemptId || item.spanId !== event.spanId ||
        item.parentSpanId !== event.parentSpanId || item.stage !== event.stage || item.sequence > event.sequence ||
        (index > 0 && item.sequence <= events[index - 1]!.sequence))) throw new Error('invalid_trace_span');
  const ref = (kind: string, value: unknown) => traceReference(input.redactionKey, kind, value);
  const spanRef = (spanId: string) => ref('spanId', { runId: event.runId, runtimeAttemptId: event.runtimeAttemptId, spanId });
  const terminal = events.find(item => ['stage.finished', 'model.attempt.result', 'model.attempt.error', 'tool.result', 'tool.error'].includes(item.kind));
  const projected = {
    id: spanRef(event.spanId), ...(event.parentSpanId ? { parent_run_id: spanRef(event.parentSpanId) } : {}),
    name: first.kind === 'tool.dispatch' ? first.operation : first.kind === 'model.attempt.started' ? first.role : first.stage,
    run_type: first.kind === 'tool.dispatch' ? 'tool' as const : first.kind === 'model.attempt.started' ? 'llm' as const : 'chain' as const,
    start_time: first.at, ...(terminal ? { end_time: terminal.at } : {}), inputs: {}, outputs: {},
    events: events.map(item => ({ name: item.kind, time: item.at, kwargs: projectAttributes(item, input.redactionKey) })),
    extra: { metadata: { schemaVersion: 2 as const, projectionVersion: TRACE_PROJECTION_VERSION,
      runId: ref('runId', event.runId), evaluationAttemptId: ref('evaluationAttemptId', event.evaluationAttemptId),
      runtimeAttemptId: ref('runtimeAttemptId', event.runtimeAttemptId), spanId: spanRef(event.spanId),
      watermark: event.sequence, modelMode: configuration.modelMode, providerMode: configuration.providerMode,
      evidenceMode: configuration.evidenceMode } },
  };
  return immutable(LangSmithRunSchema.parse({ ...projected, extra: { metadata: {
    ...projected.extra.metadata, projectionDigest: projectionDigest(projected) } } }));
}

const cloudEndpoints = new Map([
  ['https://api.smith.langchain.com', 'https://smith.langchain.com'],
  ['https://eu.api.smith.langchain.com', 'https://eu.smith.langchain.com'],
  ['https://apac.api.smith.langchain.com', 'https://apac.smith.langchain.com'],
  ['https://aws.api.smith.langchain.com', 'https://aws.smith.langchain.com'],
]);
export interface LangSmithOptions {
  enabled: boolean;
  apiKey?: string;
  projectId?: string;
  workspaceId?: string;
  apiUrl?: string;
  redactionKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Explicit REST-only diagnostic client; no SDK auto-tracing, retries, or ambient env reads.
 * https://docs.langchain.com/langsmith/trace-with-api
 * R01 injects server configuration and runs the outbox independently of graph dispatch.
 */
export function createLangSmithExporter(options: LangSmithOptions): LangSmithExporter {
  const apiUrl = options.apiUrl ?? 'https://api.smith.langchain.com';
  const webUrl = cloudEndpoints.get(apiUrl);
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!webUrl || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      (options.projectId && !uuid.safeParse(options.projectId).success) ||
      (options.workspaceId && !uuid.safeParse(options.workspaceId).success)) throw new Error('invalid_trace_configuration');
  const destinationId = traceReference(options.redactionKey, 'destinationId', {
    apiUrl, projectId: options.projectId ?? null, workspaceId: options.workspaceId ?? null,
  });
  const transport = options.fetch ?? fetch;
  return { destinationId, enabled: options.enabled, async export(value, requestOptions) {
    if (!options.enabled) return { status: 'unavailable', errorCode: 'disabled' };
    if (!options.apiKey || !options.projectId) return { status: 'unavailable', errorCode: 'credentials_unavailable' };
    const parsed = LangSmithRunSchema.safeParse(value);
    if (!parsed.success) return { status: 'permanent', errorCode: 'invalid_projection' };
    const run = parsed.data;
    const { projectionDigest: expectedDigest, ...rest } = run.extra.metadata;
    if (projectionDigest({ ...run, extra: { metadata: rest } }) !== expectedDigest)
      return { status: 'permanent', errorCode: 'invalid_projection' };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let onAbort: () => void;
    const expired = new Promise<TraceExportResult>(resolve => {
      onAbort = () => { controller.abort(); resolve({ status: 'retryable', errorCode: 'timeout' }); };
      timer = setTimeout(onAbort, timeoutMs);
      requestOptions?.signal?.addEventListener('abort', onAbort, { once: true });
      if (requestOptions?.signal?.aborted) onAbort();
    });
    const request = (path: string, method: string, body?: unknown) => transport(`${apiUrl}${path}`, {
      method, redirect: 'error', signal: controller.signal,
      headers: { 'x-api-key': options.apiKey!, ...(options.workspaceId ? { 'x-tenant-id': options.workspaceId } : {}),
        'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const failure = (response: Response): TraceExportResult => {
      const retryAfter = response.headers.get('retry-after');
      const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Math.min(Number(retryAfter) * 1000, 86400000) : undefined;
      if (response.status === 429) return { status: 'retryable', errorCode: 'rate_limited', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
      if (response.status === 408 || response.status === 404 || response.status >= 500)
        return { status: 'retryable', errorCode: 'service_unavailable' };
      return { status: 'permanent', errorCode: response.status === 401 || response.status === 403 ? 'denied' : 'rejected' };
    };
    const send = async (): Promise<TraceExportResult> => {
      try {
        if (controller.signal.aborted) return { status: 'retryable', errorCode: 'timeout' };
        // Replaying the same span uses the same id. PATCH also handles a POST that
        // was accepted before a worker crash or whose duplicate POST was ignored.
        const body = { ...run, session_id: options.projectId };
        const created = await request('/runs', 'POST', body);
        void created.body?.cancel().catch(() => {});
        if (!created.ok && created.status !== 409) return failure(created);
        if (controller.signal.aborted) return { status: 'retryable', errorCode: 'timeout' };
        const updated = await request(`/runs/${run.id}`, 'PATCH', body);
        void updated.body?.cancel().catch(() => {});
        if (!updated.ok) return failure(updated);
        if (controller.signal.aborted) return { status: 'retryable', errorCode: 'timeout' };
        const observed = await request(`/runs/${run.id}`, 'GET');
        if (!observed.ok) { void observed.body?.cancel().catch(() => {}); return failure(observed); }
        const reader = observed.body?.getReader();
        if (!reader) return { status: 'retryable', errorCode: 'unconfirmed' };
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 2 * 1024 * 1024) { void reader.cancel().catch(() => {}); return { status: 'permanent', errorCode: 'unconfirmed' }; }
          chunks.push(chunk.value);
        }
        const confirmed = z.object({ id: uuid, session_id: uuid, parent_run_id: uuid.nullable().optional(),
          extra: z.object({ metadata: z.object({ projectionDigest: DigestSchema }) }), app_path: z.string().max(2048).nullish(),
        }).safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (!confirmed.success || confirmed.data.id !== run.id || confirmed.data.session_id !== options.projectId ||
            (confirmed.data.parent_run_id ?? null) !== (run.parent_run_id ?? null) ||
            confirmed.data.extra.metadata.projectionDigest !== expectedDigest) return { status: 'retryable', errorCode: 'unconfirmed' };
        const path = confirmed.data.app_path;
        // Accept only the service-returned private run route, never arbitrary URLs.
        const match = path?.match(/^\/o\/([a-f0-9-]{36})\/projects\/p\/([a-f0-9-]{36})\/r\/([a-f0-9-]{36})(?:\?poll=true)?$/i);
        const remoteUrl = match && match[2] === options.projectId && match[3] === run.id &&
          (!options.workspaceId || match[1] === options.workspaceId) ? `${webUrl}${path}` : null;
        return { status: 'exported', remoteRunId: run.id, remoteUrl };
      } catch { return { status: 'retryable', errorCode: controller.signal.aborted ? 'timeout' : 'transport_error' }; }
    };
    try { return await Promise.race([send(), expired]); }
    finally { clearTimeout(timer!); requestOptions?.signal?.removeEventListener('abort', onAbort!); }
  } };
}
