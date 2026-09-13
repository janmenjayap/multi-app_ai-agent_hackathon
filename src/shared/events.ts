import { z } from 'zod';
import { AppSchema, CountSchema, DigestSchema, EffectKeySchema, EvaluationAttemptIdSchema, IdSchema,
  ModelAttemptIdSchema, ProductStatusSchema, ProviderAttemptIdSchema, RestrictedArtifactRefSchema,
  RevisionSchema, RoleSchema, RunIdSchema, RuntimeAttemptIdSchema, StageIdSchema, UtcTimestampSchema, immutable } from './domain.js';
import { AdapterOperationSchema } from './adapters.js';
import { ObservedCompletionClaimSchema } from './evaluation.js';
import { BatchSchema as LegacyBatchSchema } from './reliability.js';
export { StageIdSchema, PIPELINE_STAGE_IDS } from './domain.js';

export const EventErrorCodeSchema = z.enum(['input_invalid', 'input_budget_exceeded', 'denied', 'timeout', 'rate_limited',
  'transport_error', 'output_invalid', 'refusal', 'budget_exhausted', 'source_incomplete', 'source_stale',
  'approval_invalid', 'approval_expired', 'outcome_unknown', 'conflict', 'persistence_failed', 'cancelled']);
const envelope = {
  schemaVersion: z.literal(2), producerVersion: IdSchema, producerId: IdSchema, eventId: IdSchema,
  runId: RunIdSchema, evaluationAttemptId: EvaluationAttemptIdSchema, runtimeAttemptId: RuntimeAttemptIdSchema,
  sequence: RevisionSchema, stage: StageIdSchema, spanId: IdSchema, parentSpanId: IdSchema.nullable(),
  at: UtcTimestampSchema, processId: IdSchema, bootId: IdSchema, monotonicMs: z.number().finite().nonnegative(),
  causedBy: z.array(IdSchema).max(100),
};
const event = <T extends z.ZodRawShape>(shape: T) => z.object({ ...envelope, ...shape }).strict();
const model = { role: RoleSchema, logicalCallId: IdSchema, modelAttemptId: ModelAttemptIdSchema,
  roleInvocationKey: z.string().min(1).max(220), planRevision: RevisionSchema };
export const ObservedOperationSchema = z.enum([...AdapterOperationSchema.options,
  'gmail.send', 'gmail.delete', 'github.delete', 'hubspot.delete', 'slack.delete',
  'github.production_mutation', 'hubspot.production_mutation']);
const tool = { app: AppSchema, operation: ObservedOperationSchema, logicalCallId: IdSchema, providerAttemptId: ProviderAttemptIdSchema };
export const EventV2Schema = z.discriminatedUnion('kind', [
  event({ kind: z.literal('stage.started') }),
  event({ kind: z.literal('stage.finished'), outcome: z.enum(['succeeded', 'failed', 'blocked', 'skipped']) }),
  event({ kind: z.literal('model.attempt.started'), ...model, inputDigest: DigestSchema, configDigest: DigestSchema,
    promptVersion: IdSchema, modelVersion: IdSchema, outputSchemaVersion: IdSchema }),
  event({ kind: z.literal('model.attempt.result'), ...model, outputRef: RestrictedArtifactRefSchema,
    validation: z.enum(['valid', 'invalid', 'refused']), latencyMs: CountSchema.nullable(),
    usage: z.object({ inputTokens: CountSchema, outputTokens: CountSchema }).strict().nullable() }),
  event({ kind: z.literal('model.attempt.error'), ...model, errorCode: EventErrorCodeSchema, latencyMs: CountSchema.nullable() }),
  event({ kind: z.literal('tool.dispatch'), ...tool, actor: z.enum(['reader', 'executor', 'verifier', 'coordinator', 'collector']),
    effectKey: EffectKeySchema.nullable(), requestDigest: DigestSchema.nullable(), planHash: DigestSchema.nullable(), approvalId: IdSchema.nullable() }),
  event({ kind: z.literal('tool.result'), ...tool, transportOutcome: z.enum(['response', 'timeout', 'error']),
    providerOutcome: z.enum(['success', 'error', 'unknown']), receiptRef: RestrictedArtifactRefSchema, latencyMs: CountSchema.nullable() }),
  event({ kind: z.literal('tool.error'), ...tool, errorCode: EventErrorCodeSchema, outcome: z.enum(['not_applied', 'unknown']) }),
  event({ kind: z.literal('retry.scheduled'), target: z.discriminatedUnion('type', [
    z.object({ type: z.literal('model'), modelAttemptId: ModelAttemptIdSchema }).strict(),
    z.object({ type: z.literal('provider'), providerAttemptId: ProviderAttemptIdSchema }).strict(),
  ]), logicalCallId: IdSchema, owner: IdSchema, reason: EventErrorCodeSchema, delayMs: CountSchema, remainingBudgetMs: CountSchema }),
  event({ kind: z.literal('sources.collected'), complete: z.boolean(), collectionRefs: z.array(RestrictedArtifactRefSchema).min(1).max(100) }),
  event({ kind: z.literal('plan.frozen'), planRevision: RevisionSchema, planHash: DigestSchema, planRef: RestrictedArtifactRefSchema }),
  event({ kind: z.literal('approval.checked'), approvalId: IdSchema, planRevision: RevisionSchema, planHash: DigestSchema,
    decision: z.enum(['approved', 'rejected', 'invalid', 'expired']), evidenceRef: RestrictedArtifactRefSchema }),
  event({ kind: z.literal('guard.checked'), allowed: z.boolean(), reason: IdSchema, planHash: DigestSchema, evidenceRefs: z.array(RestrictedArtifactRefSchema).max(100) }),
  event({ kind: z.literal('effect.reconciled'), effectKey: EffectKeySchema, resolution: z.enum(['adopted', 'not_applied', 'unresolved', 'conflict']),
    providerId: IdSchema.nullable(), readAttemptId: ProviderAttemptIdSchema, receiptRef: RestrictedArtifactRefSchema }),
  event({ kind: z.literal('effect.verified'), verificationId: IdSchema, effectKey: EffectKeySchema, planHash: DigestSchema,
    artifactKind: z.enum(['task', 'note', 'draft', 'comment', 'thread']), verdict: z.enum(['matched', 'mismatched', 'unverified']),
    readAttemptId: ProviderAttemptIdSchema, receiptRef: RestrictedArtifactRefSchema }),
  event({ kind: z.literal('wait.started'), waitId: IdSchema, reason: IdSchema }),
  event({ kind: z.literal('wait.ended'), waitId: IdSchema }),
  event({ kind: z.literal('fault.recorded'), faultId: IdSchema, evidenceRef: RestrictedArtifactRefSchema }),
  event({ kind: z.literal('correction.recorded'), previousOutputId: IdSchema, outputId: IdSchema, reason: IdSchema }),
  event({ kind: z.literal('run.status'), status: ProductStatusSchema }),
  event({ kind: z.literal('success.claimed'), claim: ObservedCompletionClaimSchema }),
]).superRefine((v, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.parentSpanId === v.spanId || v.causedBy.includes(v.eventId) || new Set(v.causedBy).size !== v.causedBy.length) fail('invalid_event_causality');
  if ('role' in v && (v.stage !== v.role || v.roleInvocationKey !== JSON.stringify([v.runId, v.planRevision, v.role]))) fail('model_role_binding_mismatch');
  if ('app' in v && !v.operation.startsWith(`${v.app}.`)) fail('tool_operation_app_mismatch');
  if (v.kind === 'success.claimed' && (v.claim.runId !== v.runId || v.claim.evaluationAttemptId !== v.evaluationAttemptId ||
      v.claim.runtimeAttemptId !== v.runtimeAttemptId || v.claim.eventId !== v.eventId || v.claim.sequence !== v.sequence || v.claim.emittedAt !== v.at)) fail('cross_attempt_claim_binding');
});
export const EventBatchV2Schema = z.object({ schemaVersion: z.literal(2), runId: RunIdSchema,
  evaluationAttemptId: EvaluationAttemptIdSchema, events: z.array(EventV2Schema).max(100000),
}).strict().superRefine((batch, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const seen = new Map<string, EventV2>();
  const spans = new Map<string, EventV2>();
  const attempts = new Map<string, EventV2>();
  const finished = new Set<string>();
  const clocks = new Map<string, number>();
  const claims = new Set<string>();
  let sequence = 0;
  for (const e of batch.events) {
    if (e.runId !== batch.runId || e.evaluationAttemptId !== batch.evaluationAttemptId) fail('cross_attempt_event_binding');
    if (seen.has(e.eventId) || e.sequence <= sequence) fail('duplicate_or_unordered_event');
    if (e.causedBy.some(id => !seen.has(id))) fail('missing_causal_parent');
    const starts = ['stage.started', 'model.attempt.started', 'tool.dispatch'].includes(e.kind);
    const span = spans.get(e.spanId);
    if (starts) {
      if (span || (e.parentSpanId && !spans.has(e.parentSpanId))) fail('orphan_or_duplicate_span');
      const parent = e.parentSpanId ? spans.get(e.parentSpanId) : null;
      if (parent && (parent.runtimeAttemptId !== e.runtimeAttemptId || parent.stage !== e.stage ||
          (e.kind === 'model.attempt.started' && parent.kind !== 'stage.started'))) fail('span_parent_context_mismatch');
      if (!e.parentSpanId && e.kind !== 'stage.started') fail('attempt_requires_stage_span');
      spans.set(e.spanId, e);
    } else if (!span || span.runtimeAttemptId !== e.runtimeAttemptId || span.parentSpanId !== e.parentSpanId || span.stage !== e.stage) fail('orphan_span');
    const clock = `${e.processId}:${e.bootId}`;
    if (e.monotonicMs < (clocks.get(clock) ?? 0)) fail('monotonic_clock_regression');
    clocks.set(clock, e.monotonicMs);
    const attemptId = 'modelAttemptId' in e ? e.modelAttemptId : 'providerAttemptId' in e ? e.providerAttemptId : null;
    if (attemptId && starts) {
      if (attempts.has(attemptId)) fail('reused_dispatch_attempt');
      attempts.set(attemptId, e);
    } else if (attemptId) {
      const start = attempts.get(attemptId);
      if (!start || start.spanId !== e.spanId || start.runtimeAttemptId !== e.runtimeAttemptId ||
          !('logicalCallId' in start) || !('logicalCallId' in e) || start.logicalCallId !== e.logicalCallId || finished.has(attemptId) ||
          (('modelAttemptId' in start) !== ('modelAttemptId' in e)) ||
          ('app' in start && (!('app' in e) || e.app !== start.app || e.operation !== start.operation)) ||
          ('role' in start && (!('role' in e) || e.role !== start.role || e.planRevision !== start.planRevision || e.roleInvocationKey !== start.roleInvocationKey))) fail('invalid_attempt_result_binding');
      finished.add(attemptId);
    }
    if (e.kind === 'retry.scheduled') {
      const targetId = e.target.type === 'model' ? e.target.modelAttemptId : e.target.providerAttemptId;
      const target = attempts.get(targetId);
      if (!target || !('logicalCallId' in target) || target.logicalCallId !== e.logicalCallId ||
          (e.target.type === 'model') !== ('modelAttemptId' in target)) fail('invalid_retry_target');
    }
    if (e.kind === 'success.claimed') {
      if (claims.has(e.claim.claimId)) fail('duplicate_claim_id');
      claims.add(e.claim.claimId);
    }
    sequence = e.sequence; seen.set(e.eventId, e);
  }
});
/** Explicit alias reader only: all other v2 fields remain required, with no fabricated telemetry. */
export function parseEventV2Compatibility(value: unknown): EventV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EventV2Schema.parse(value);
  const data = { ...value } as Record<string, unknown>;
  if ('attemptId' in data) {
    if ('runtimeAttemptId' in data && data.runtimeAttemptId !== data.attemptId) throw new Error('conflicting_runtime_attempt_alias');
    data.runtimeAttemptId = data.attemptId;
    delete data.attemptId;
  }
  return immutable(EventV2Schema.parse(data));
}
/** Old batches must be explicitly selected as v1; they are never upgraded into v2 proof. */
export function parsePersistedEventBatch(version: 1 | 2, value: unknown) {
  if (version === 1) return { schemaVersion: 1 as const, batch: LegacyBatchSchema.parse(value) };
  if (version === 2) return { schemaVersion: 2 as const, batch: EventBatchV2Schema.parse(value) };
  throw new Error('unsupported_event_schema_version');
}
export const MeasurementJobSchema = z.object({ schemaVersion: z.literal(2), jobId: IdSchema,
  evaluationAttemptId: EvaluationAttemptIdSchema, runId: RunIdSchema, evaluatorVersion: z.enum(['monitor-v1', 'monitor-v2']),
  watermark: CountSchema, status: z.enum(['pending', 'leased', 'completed', 'exhausted']),
  leaseToken: IdSchema.nullable(), leaseExpiresAt: UtcTimestampSchema.nullable(), attempts: CountSchema,
}).strict().refine(v => v.status === 'leased' ? v.leaseToken !== null && v.leaseExpiresAt !== null :
  v.leaseToken === null && v.leaseExpiresAt === null, 'invalid_job_lease');
export type EventV2 = z.infer<typeof EventV2Schema>;
export type EventBatchV2 = z.infer<typeof EventBatchV2Schema>;
