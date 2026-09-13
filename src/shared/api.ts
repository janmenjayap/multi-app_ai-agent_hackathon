import { z } from 'zod';
import { AppSchema, CountSchema, DigestSchema, EffectKeySchema, EffectStateSchema, EvaluationAttemptIdSchema, EventKindSchema, ExecutionModeSchema,
  GitHubIssueUrlSchema, IdSchema, PIPELINE_STAGE_IDS, ProductStatusSchema, RevisionSchema,
  RoleSchema, RunIdSchema, RuntimeAttemptIdSchema, PlannedEffectSchema, StageIdSchema, UtcTimestampSchema, canonical, immutable } from './domain.js';
import { LatencySummarySchema, MetricCountSchema } from './evaluation.js';

export const API_SCHEMA_VERSION = 2 as const;
export const API_ROUTES = Object.freeze({ createRun: '/api/runs', run: '/api/runs/:id',
  events: '/api/runs/:id/events', reconcile: '/api/runs/:id/reconcile', latestEvaluation: '/api/evaluations/latest',
  trace: '/api/runs/:id/trace', assessments: '/api/runs/:id/assessments', metrics: '/api/metrics', health: '/healthz' });
export const EvidenceGapViewSchema = z.object({ code: IdSchema, referenceId: IdSchema.nullable() }).strict();
export const RedactedReferenceSchema = z.object({ referenceId: IdSchema, label: z.string().min(1).max(200),
  availability: z.enum(['available', 'unavailable', 'unauthorized']),
  href: z.string().regex(/^\/api\/evidence\/[A-Za-z0-9_.:-]{1,160}$/).nullable(),
}).strict().refine(v => (v.availability === 'available') === (v.href !== null) &&
  (v.href === null || v.href === `/api/evidence/${v.referenceId}`), 'reference_availability_mismatch');
export const ProviderLinkSchema = z.string().max(2048).refine(value => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.search &&
      (['github.com', 'app.hubspot.com', 'mail.google.com', 'app.slack.com'].includes(u.hostname) || /^[A-Za-z0-9-]+\.slack\.com$/.test(u.hostname));
  } catch { return false; }
}, 'invalid_provider_link');
export const AssessmentDisplayStateSchema = z.enum(['pending', 'pass', 'fail', 'incomplete', 'unverified', 'na']);
export const AssessmentSummaryViewSchema = z.object({
  status: AssessmentDisplayStateSchema, coverage: z.enum(['complete', 'incomplete', 'unavailable', 'not_applicable']),
  evaluatorVersion: z.enum(['monitor-v1', 'monitor-v2']).nullable(), assessmentRevision: RevisionSchema.nullable(),
  observedAt: UtcTimestampSchema.nullable(), watermark: IdSchema.nullable(),
  requiredCount: CountSchema, confirmedCount: CountSchema, humanLabelCount: CountSchema.nullable(),
  gaps: z.array(EvidenceGapViewSchema).max(1000),
}).strict().superRefine((v, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.confirmedCount > v.requiredCount) fail('invalid_assessment_counts');
  if (v.status === 'pass' && (v.coverage !== 'complete' || !v.evaluatorVersion || !v.assessmentRevision || !v.observedAt ||
      !v.watermark || v.confirmedCount !== v.requiredCount || v.requiredCount === 0 || v.gaps.length || v.humanLabelCount === 0)) fail('pass_requires_evidence');
  if (v.status === 'fail' && (!v.evaluatorVersion || !v.assessmentRevision || !v.observedAt || !v.watermark)) fail('failure_requires_assessment_receipt');
  if (v.status === 'na' && (v.coverage !== 'not_applicable' || v.requiredCount || v.confirmedCount)) fail('invalid_not_applicable_assessment');
});
export function assessmentDisplayState(value: 'pending' | 'unverified' | 'passed' | 'failed') {
  return ({ pending: 'pending', unverified: 'unverified', passed: 'pass', failed: 'fail' } as const)[value];
}
export const MetricCountViewSchema = z.union([MetricCountSchema, LatencySummarySchema]);
export const CensusCountsViewSchema = z.object({ planned: CountSchema, attempted: CountSchema, assessed: CountSchema,
  failed: CountSchema, unverified: CountSchema, setupFailed: CountSchema, notRun: CountSchema,
}).strict().refine(v => v.planned === v.attempted + v.setupFailed + v.notRun && v.assessed <= v.attempted &&
  v.failed <= v.assessed && v.unverified <= v.assessed && v.failed + v.unverified <= v.assessed, 'invalid_census_counts');
export const CriticalCountViewSchema = z.object({ code: z.enum(['duplicates', 'forbiddenEffects', 'approvalBypasses',
  'incorrectRecipients', 'unsupportedClaims', 'prematureSuccessClaims', 'outcomeContradictedCompletionClaims',
  'falseCompletion', 'successClaims', 'recoveryFailures']), count: CountSchema.nullable(),
  availability: z.enum(['available', 'unavailable']), sampleIds: z.array(IdSchema).max(100000),
}).strict().refine(v => (v.availability === 'available') === (v.count !== null), 'critical_count_availability_mismatch');
export const EvaluationSummaryViewSchema = z.object({
  schemaVersion: z.literal(2), reportId: IdSchema, revision: RevisionSchema, cohortId: IdSchema,
  evaluatorVersion: z.enum(['monitor-v1', 'monitor-v2']), manifestVersion: z.enum(['1', '2']),
  logicalManifestHash: DigestSchema, configuration: ExecutionModeSchema,
  provenance: z.enum(['synthetic', 'imported_untrusted', 'collected', 'unavailable']),
  cutoffAt: UtcTimestampSchema, observedAt: UtcTimestampSchema, watermark: IdSchema,
  census: CensusCountsViewSchema, metrics: z.array(MetricCountViewSchema).max(30),
  criticalCounts: z.array(CriticalCountViewSchema).max(20), humanLabelCount: CountSchema,
  gaps: z.array(EvidenceGapViewSchema).max(1000), reportRef: RedactedReferenceSchema.nullable(),
}).strict().superRefine((v, ctx) => {
  if ((v.evaluatorVersion === 'monitor-v1') !== (v.manifestVersion === '1') ||
      new Set(v.metrics.map(m => `${m.metricId}:${m.dimension}:${m.role}`)).size !== v.metrics.length ||
      new Set(v.criticalCounts.map(c => c.code)).size !== v.criticalCounts.length ||
      (v.humanLabelCount === 0 && v.metrics.some(m => m.metricId === 'M7' && m.numerator > 0)))
    ctx.addIssue({ code: 'custom', message: 'inconsistent_evaluation_summary' });
});
export const StageStateSchema = z.enum(['not_started', 'queued', 'running', 'waiting', 'succeeded', 'failed', 'blocked', 'skipped', 'unknown']);
export const StageViewSchema = z.object({ stageId: StageIdSchema, role: RoleSchema.nullable(), status: StageStateSchema,
  startedAt: UtcTimestampSchema.nullable(), updatedAt: UtcTimestampSchema.nullable(),
  attemptCount: CountSchema, latestAttemptRef: RedactedReferenceSchema.nullable(), reason: IdSchema.nullable(),
}).strict().refine(v => v.role === (['analyst', 'drafter', 'auditor'].includes(v.stageId) ? v.stageId : null), 'stage_role_mismatch');
export const EffectViewSchema = z.object({ effectKey: EffectKeySchema, app: AppSchema,
  kind: z.enum(['task', 'note', 'draft', 'comment', 'thread']), state: EffectStateSchema,
  outcome: z.enum(['unattempted', 'applied', 'not_applied', 'unknown']),
  result: z.enum(['created', 'reused']).nullable(), providerId: IdSchema.nullable(), providerLink: ProviderLinkSchema.nullable(),
  verifiedAt: UtcTimestampSchema.nullable(), comparison: z.enum(['pending', 'matched', 'missing_readback', 'mismatched', 'unverified', 'conflict', 'drift']),
  readbackRef: RedactedReferenceSchema.nullable(),
  comparisons: z.array(z.object({ field: z.enum(['recipient', 'cc', 'bcc', 'subject', 'body', 'bodyDigest', 'owner', 'company',
    'commitment', 'dueAt', 'status', 'draftOnly', 'taskId', 'noteId', 'draftId', 'commentId', 'channel', 'artifactCount']),
    expected: z.union([z.string().max(50000), z.array(z.string()).max(100), z.boolean(), CountSchema, z.null()]),
    observed: z.union([z.string().max(50000), z.array(z.string()).max(100), z.boolean(), CountSchema, z.null()]),
    verdict: z.enum(['matched', 'mismatched', 'unavailable']), evidenceRef: RedactedReferenceSchema.nullable(),
  }).strict()).max(100),
}).strict().superRefine((v, ctx) => {
  const apps = { task: 'hubspot', note: 'hubspot', draft: 'gmail', comment: 'github', thread: 'slack' };
  if (v.app !== apps[v.kind] || (v.state === 'planned' && (v.outcome !== 'unattempted' || v.providerId || v.result)) ||
      (v.outcome === 'unknown' && v.state !== 'inflight') || (['applied', 'verified'].includes(v.state) && (v.outcome !== 'applied' || !v.providerId || !v.result)) ||
      (v.state === 'verified' && (!v.verifiedAt || !v.readbackRef)))
    ctx.addIssue({ code: 'custom', message: 'effect_display_state_mismatch' });
});
export const PlanViewSchema = z.object({ revision: RevisionSchema, planHash: DigestSchema,
  entries: z.array(z.object({ commitmentId: IdSchema, companyId: IdSchema, ownerId: IdSchema,
    recipient: z.email(), subject: z.string().min(1).max(1000), body: z.string().max(50000), draftOnly: z.literal(true) }).strict()).min(1).max(100),
  orderedEffectKeys: z.array(EffectKeySchema).min(5).max(500),
  effects: z.array(PlannedEffectSchema).min(5).max(500),
  contents: z.array(z.object({ contentKey: IdSchema, text: z.string().max(50000), sha256: DigestSchema }).strict()).min(1).max(500),
}).strict().refine(v => new Set(v.entries.map(e => e.commitmentId)).size === v.entries.length &&
  new Set(v.orderedEffectKeys).size === v.orderedEffectKeys.length && canonical(v.orderedEffectKeys) === canonical(v.effects.map(e => e.effectKey)), 'duplicate_or_inconsistent_plan_view_identity');
export const ApprovalViewSchema = z.object({ status: z.enum(['not_requested', 'waiting', 'approved', 'rejected', 'expired', 'invalidated', 'unverified']),
  planRevision: RevisionSchema, planHash: DigestSchema, slackLink: ProviderLinkSchema.nullable(),
  approver: z.string().min(1).max(200).nullable(), decidedAt: UtcTimestampSchema.nullable(),
  expiresAt: UtcTimestampSchema.nullable(), invalidationReason: IdSchema.nullable(),
}).strict();
export const AssessmentsViewSchema = z.object({ trace: AssessmentSummaryViewSchema, outcome: AssessmentSummaryViewSchema,
  firstProposal: AssessmentSummaryViewSchema, selectedPlan: AssessmentSummaryViewSchema.nullable(),
}).strict().refine(v => v.firstProposal.status !== 'pass' || (v.firstProposal.humanLabelCount !== null && v.firstProposal.humanLabelCount > 0), 'first_proposal_requires_human_labels');
export const RunViewSchema = z.object({
  schemaVersion: z.literal(2), revision: RevisionSchema, runId: RunIdSchema,
  evaluationAttemptId: EvaluationAttemptIdSchema.nullable(), runtimeAttemptIds: z.array(RuntimeAttemptIdSchema).max(1000),
  incident: z.object({ url: GitHubIssueUrlSchema, title: z.string().max(10000), service: IdSchema, environment: IdSchema }).strict(),
  configuration: ExecutionModeSchema, productStatus: ProductStatusSchema, statusReason: IdSchema.nullable(),
  stages: z.array(StageViewSchema).length(PIPELINE_STAGE_IDS.length),
  commitments: z.object({ status: z.enum(['pending', 'selected', 'empty', 'blocked', 'incomplete']), policyVersion: IdSchema.nullable(),
    selected: z.array(z.object({ commitmentId: IdSchema, company: z.string().min(1).max(200), reason: IdSchema }).strict()).max(100),
    excluded: z.array(z.object({ commitmentId: IdSchema, reason: IdSchema }).strict()).max(1000),
    evidenceRefs: z.array(RedactedReferenceSchema).max(100),
  }).strict(),
  plan: PlanViewSchema.nullable(), approval: ApprovalViewSchema.nullable(), effects: z.array(EffectViewSchema).max(500),
  assessments: AssessmentsViewSchema,
  report: EvaluationSummaryViewSchema.nullable(), reportAvailability: z.enum(['available', 'pending', 'unavailable', 'unauthorized']),
  createdAt: UtcTimestampSchema, updatedAt: UtcTimestampSchema, verifiedAt: UtcTimestampSchema.nullable(),
}).strict().superRefine((v, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.stages.some((stage, i) => stage.stageId !== PIPELINE_STAGE_IDS[i])) fail('invalid_pipeline_order');
  if ((v.reportAvailability === 'available') !== (v.report !== null)) fail('report_availability_mismatch');
  if (Date.parse(v.updatedAt) < Date.parse(v.createdAt) || (v.verifiedAt && Date.parse(v.verifiedAt) > Date.parse(v.updatedAt))) fail('invalid_run_timestamps');
  if (new Set(v.effects.map(e => e.effectKey)).size !== v.effects.length) fail('duplicate_effect_key');
  if (new Set(v.runtimeAttemptIds).size !== v.runtimeAttemptIds.length) fail('duplicate_runtime_attempt');
  const selection = [...v.commitments.selected, ...v.commitments.excluded].map(c => c.commitmentId);
  if (new Set(selection).size !== selection.length || (v.commitments.status === 'empty' && v.commitments.selected.length) ||
      (v.commitments.status === 'selected' && !v.commitments.selected.length)) fail('invalid_selection_view');
  if (v.assessments.firstProposal.status === 'pass' && !v.assessments.firstProposal.humanLabelCount) fail('first_proposal_requires_human_labels');
  if (v.plan && (canonical(v.plan.entries.map(e => e.commitmentId).sort()) !== canonical(v.commitments.selected.map(c => c.commitmentId).sort()) ||
      canonical(v.plan.orderedEffectKeys) !== canonical(v.effects.map(e => e.effectKey)))) fail('plan_view_scope_mismatch');
  if (v.approval && (!v.plan || v.approval.planHash !== v.plan.planHash || v.approval.planRevision !== v.plan.revision)) fail('approval_view_plan_mismatch');
  if (v.productStatus === 'awaiting_approval' && (!v.plan || v.approval?.status !== 'waiting')) fail('waiting_requires_plan_and_slack_review');
  if (v.productStatus === 'completed' && (!v.plan || !v.verifiedAt || v.effects.length < 5 || v.effects.some(e => e.state !== 'verified'))) fail('completed_requires_product_readback');
  if (v.productStatus === 'completed_no_affected_commitments' && (v.plan || v.approval || v.effects.length || v.commitments.status !== 'empty' || !v.verifiedAt ||
      !v.commitments.policyVersion || !v.commitments.evidenceRefs.length)) fail('invalid_no_affected_view');
});
export const CursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
export const RunEventViewSchema = z.object({ eventId: IdSchema, sequence: RevisionSchema, stageId: StageIdSchema,
  kind: EventKindSchema, at: UtcTimestampSchema, reference: RedactedReferenceSchema.nullable(),
}).strict();
export const RunEventsPageSchema = z.object({ schemaVersion: z.literal(2), runId: RunIdSchema, runRevision: RevisionSchema,
  events: z.array(RunEventViewSchema).max(200), nextCursor: CursorSchema, hasMore: z.boolean(),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.events.map(e => e.eventId)).size !== v.events.length ||
      v.events.some((e, i) => i > 0 && e.sequence <= v.events[i - 1].sequence))
    ctx.addIssue({ code: 'custom', message: 'duplicate_or_unordered_public_event' });
});
export const CreateRunCommandSchema = z.object({ schemaVersion: z.literal(2), incidentUrl: GitHubIssueUrlSchema }).strict();
export const ReconcileRunCommandSchema = z.object({ schemaVersion: z.literal(2), expectedRevision: RevisionSchema }).strict();
export const CommandResultSchema = z.object({ schemaVersion: z.literal(2), commandId: IdSchema, runId: RunIdSchema, revision: RevisionSchema,
  productStatus: ProductStatusSchema, disposition: z.enum(['created', 'reopened', 'scheduled', 'already_scheduled', 'not_eligible']) }).strict();
export const ApiErrorSchema = z.object({ schemaVersion: z.literal(2), code: z.enum(['invalid_request', 'unauthenticated',
  'forbidden', 'not_found', 'csrf_failed', 'stale_revision', 'conflict', 'rate_limited', 'unavailable', 'internal_error']),
  retryable: z.boolean(), correlationId: IdSchema,
}).strict();
export const AssessmentReadSchema = z.object({ schemaVersion: z.literal(2), runId: RunIdSchema, runRevision: RevisionSchema,
  assessments: RunViewSchema.shape.assessments }).strict();
const traceAttempt = { runtimeAttemptId: RuntimeAttemptIdSchema, logicalCallId: IdSchema,
  startedAt: UtcTimestampSchema.nullable(), finishedAt: UtcTimestampSchema.nullable(),
  latencyMs: CountSchema.nullable(), reference: RedactedReferenceSchema.nullable() };
export const TraceAttemptViewSchema = z.discriminatedUnion('type', [
  z.object({ ...traceAttempt, type: z.literal('model'), role: RoleSchema, modelAttemptId: IdSchema,
    outcome: z.enum(['running', 'valid', 'invalid', 'refused', 'error', 'unknown']),
    modelVersion: IdSchema, promptVersion: IdSchema, outputSchemaVersion: IdSchema,
    originalOutputRef: RedactedReferenceSchema.nullable() }).strict(),
  z.object({ ...traceAttempt, type: z.literal('provider'), providerAttemptId: IdSchema, app: AppSchema,
    operation: IdSchema, transport: z.enum(['fake', 'rest']),
    transportOutcome: z.enum(['pending', 'response', 'timeout', 'error', 'unknown']),
    providerOutcome: z.enum(['pending', 'success', 'error', 'unknown']),
    reconciliation: z.enum(['not_required', 'pending', 'adopted', 'not_applied', 'unresolved', 'conflict']),
    readbackRef: RedactedReferenceSchema.nullable() }).strict(),
]);
export const TraceViewSchema = z.object({ schemaVersion: z.literal(2), runId: RunIdSchema, runRevision: RevisionSchema,
  evaluationAttemptId: EvaluationAttemptIdSchema.nullable(), assessment: AssessmentSummaryViewSchema,
  attempts: z.array(TraceAttemptViewSchema).max(200), nextCursor: CursorSchema, hasMore: z.boolean(),
}).strict().refine(v => new Set(v.attempts.map(a => a.type === 'model' ? a.modelAttemptId : a.providerAttemptId)).size === v.attempts.length, 'duplicate_trace_attempt');
export const EvaluationReadSchema = z.object({ schemaVersion: z.literal(2), availability: z.enum(['available', 'pending', 'unavailable', 'unauthorized']),
  report: EvaluationSummaryViewSchema.nullable() }).strict().refine(v => (v.availability === 'available') === (v.report !== null), 'report_availability_mismatch');
export const HealthViewSchema = z.object({ schemaVersion: z.literal(2), ready: z.literal(true),
  storage: z.literal('ready'), checkpoints: z.literal('ready'), monitor: z.enum(['ready', 'unavailable']) }).strict();

/** Stateful consistency helpers, applied before replacing a browser's last-known projection. */
export function acceptRunView(previous: RunView | null, incoming: unknown): RunView {
  const next = RunViewSchema.parse(incoming);
  assertPublicProjection(next);
  if (previous) {
    if (previous.runId !== next.runId || next.revision < previous.revision || Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) throw new Error('stale_run_revision');
    if (previous.incident.url !== next.incident.url || previous.incident.service !== next.incident.service || previous.incident.environment !== next.incident.environment ||
        canonical(previous.configuration) !== canonical(next.configuration)) throw new Error('immutable_run_identity_changed');
    if (next.revision === previous.revision && canonical(next) !== canonical(previous)) throw new Error('conflicting_run_revision');
    if (previous.report && next.report && previous.report.reportId === next.report.reportId && next.report.revision < previous.report.revision) throw new Error('stale_report_revision');
    if (previous.report && next.report && previous.report.cohortId === next.report.cohortId && Date.parse(next.report.cutoffAt) < Date.parse(previous.report.cutoffAt)) throw new Error('stale_report_cutoff');
    for (const key of ['trace', 'outcome', 'firstProposal', 'selectedPlan'] as const) {
      const old = previous.assessments[key], current = next.assessments[key];
      if (old?.assessmentRevision && current?.assessmentRevision && current.assessmentRevision < old.assessmentRevision) throw new Error('stale_assessment_revision');
    }
  }
  return immutable(next);
}
export function acceptEventsPage(previousRun: Pick<RunView, 'runId' | 'revision'>, incoming: unknown): RunEventsPage {
  const page = RunEventsPageSchema.parse(incoming);
  if (page.runId !== previousRun.runId || page.runRevision < previousRun.revision) throw new Error('stale_event_page');
  assertPublicProjection(page);
  return immutable(page);
}
/** Defense-in-depth for public producers; authorization of each reference remains B04's responsibility. */
export function assertPublicProjection(value: unknown): void {
  if (typeof value === 'string' && /(?:\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|\bxox[baprs]-[A-Za-z0-9-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(value)) throw new Error('secret_in_public_projection');
  if (Array.isArray(value)) { value.forEach(assertPublicProjection); return; }
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (/^(?:apiKey|accessToken|refreshToken|authorization|credentials|rawMime|rawOutput|clientSecret|privatePath)$/i.test(key)) throw new Error('private_field_in_public_projection');
    assertPublicProjection(child);
  }
}
export type RunView = z.infer<typeof RunViewSchema>;
export type RunEventsPage = z.infer<typeof RunEventsPageSchema>;
export type AssessmentSummaryView = z.infer<typeof AssessmentSummaryViewSchema>;
export type EvaluationSummaryView = z.infer<typeof EvaluationSummaryViewSchema>;
export type CreateRunCommand = z.infer<typeof CreateRunCommandSchema>;
export type ReconcileRunCommand = z.infer<typeof ReconcileRunCommandSchema>;
export type CommandResult = z.infer<typeof CommandResultSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type RedactedReference = z.infer<typeof RedactedReferenceSchema>;
export type RunEventView = z.infer<typeof RunEventViewSchema>;
export type StageView = z.infer<typeof StageViewSchema>;
export type EffectView = z.infer<typeof EffectViewSchema>;
export type PlanView = z.infer<typeof PlanViewSchema>;
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;
export type TraceView = z.infer<typeof TraceViewSchema>;
export type TraceAttemptView = z.infer<typeof TraceAttemptViewSchema>;
