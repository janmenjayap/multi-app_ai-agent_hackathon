import { z } from 'zod';
import { AppSchema, ApprovedContentRefSchema, CollectionReceiptSchema, CountSchema, DigestSchema, EffectIdRefSchema,
  EffectKeySchema, EvaluationAttemptIdSchema, ExecutionModeSchema, IdSchema, ModelAttemptIdSchema, ModeSchema,
  RestrictedArtifactRefSchema, RevisionSchema, RoleSchema, RunIdSchema, RuntimeAttemptIdSchema, StatusSchema,
  UtcTimestampSchema, canonical, immutable } from './domain.js';
import type { ImmutablePlan } from './domain.js';
export { ModeSchema } from './domain.js';
export type { Manifest as LegacyManifest, Assessment as LegacyAssessment, SemanticLabel as LegacySemanticLabel } from './reliability.js';
export const EVALUATOR_V2_VERSION = 'monitor-v2' as const;
export const AssessmentStateSchema = z.enum(['pending', 'unverified', 'passed', 'failed']);
const identity = { runId: RunIdSchema, evaluationAttemptId: EvaluationAttemptIdSchema, runtimeAttemptId: RuntimeAttemptIdSchema };

export const OriginalOutputSchema = z.object({
  schemaVersion: z.literal(2), ...identity, outputId: IdSchema, firstOutputId: IdSchema,
  previousOutputId: IdSchema.nullable(), role: RoleSchema, roleInvocationKey: z.string().min(1).max(220),
  planRevision: RevisionSchema, modelAttemptId: ModelAttemptIdSchema, inputDigest: DigestSchema,
  sourceDigests: z.array(DigestSchema).min(1).max(500), configDigest: DigestSchema,
  promptVersion: IdSchema, modelVersion: IdSchema, outputSchemaVersion: IdSchema,
  receivedAt: UtcTimestampSchema, rawOutput: RestrictedArtifactRefSchema,
  parseStatus: z.enum(['valid', 'malformed', 'refused']), validationStatus: z.enum(['valid', 'invalid', 'unrun']),
  correctionReason: z.string().min(1).max(4000).nullable(),
}).strict().superRefine((v, ctx) => {
  if ((v.outputId === v.firstOutputId) !== (v.previousOutputId === null) ||
      (v.previousOutputId === null) !== (v.correctionReason === null) ||
      (v.parseStatus !== 'valid' && v.validationStatus === 'valid') ||
      v.roleInvocationKey !== canonical([v.runId, v.planRevision, v.role]))
    ctx.addIssue({ code: 'custom', message: 'invalid_original_output_identity' });
});
export const OutputHistorySchema = z.array(OriginalOutputSchema).max(1000).superRefine((history, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const seen = new Map<string, z.infer<typeof OriginalOutputSchema>>();
  const attempts = new Set<string>();
  for (const output of history) {
    if (seen.has(output.outputId) || attempts.has(output.modelAttemptId)) fail('overwritten_output');
    if (output.previousOutputId) {
      const previous = seen.get(output.previousOutputId);
      if (!previous || previous.firstOutputId !== output.firstOutputId || previous.roleInvocationKey !== output.roleInvocationKey ||
          previous.runId !== output.runId || previous.evaluationAttemptId !== output.evaluationAttemptId ||
          previous.inputDigest !== output.inputDigest || previous.configDigest !== output.configDigest ||
          canonical(previous.sourceDigests) !== canonical(output.sourceDigests) ||
          Date.parse(output.receivedAt) < Date.parse(previous.receivedAt)) fail('invalid_correction_chain');
    } else if ([...seen.values()].some(p => p.roleInvocationKey === output.roleInvocationKey)) fail('overwritten_first_output');
    seen.set(output.outputId, output); attempts.add(output.modelAttemptId);
  }
});
export function appendOriginalOutput(history: unknown, next: unknown) {
  const parsed = OutputHistorySchema.parse(history);
  return immutable(OutputHistorySchema.parse([...parsed, OriginalOutputSchema.parse(next)]));
}
/** Human edits and new-revision repairs are separate from immutable original model responses. */
export const CorrectionArtifactSchema = z.object({ schemaVersion: z.literal(2), correctionId: IdSchema,
  runId: RunIdSchema, evaluationAttemptId: EvaluationAttemptIdSchema, firstOutputId: IdSchema,
  previousArtifactId: IdSchema, planRevision: RevisionSchema, correctedAt: UtcTimestampSchema,
  origin: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('human'), reviewerId: IdSchema, interactionRef: RestrictedArtifactRefSchema }).strict(),
    z.object({ kind: z.literal('model'), modelAttemptId: ModelAttemptIdSchema }).strict(),
  ]), reason: z.string().trim().min(1).max(4000), artifact: RestrictedArtifactRefSchema,
}).strict().refine(v => v.correctionId !== v.previousArtifactId && v.correctionId !== v.firstOutputId, 'invalid_correction_identity');
const labelValue = z.union([z.boolean(), z.literal('uncertain')]);
export const ReviewLabelSchema = z.object({
  schemaVersion: z.literal(2), labelId: IdSchema, runId: RunIdSchema, evaluationAttemptId: EvaluationAttemptIdSchema,
  outputId: IdSchema, role: RoleSchema, outputDigest: DigestSchema, sourceDigests: z.array(DigestSchema).min(1).max(500),
  reviewer: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('human'), reviewerId: IdSchema, interactionRef: RestrictedArtifactRefSchema }).strict(),
    z.object({ kind: z.literal('model'), modelId: IdSchema, modelAttemptId: ModelAttemptIdSchema }).strict(),
    z.object({ kind: z.literal('fixture'), fixtureId: IdSchema }).strict(),
  ]),
  reason: z.string().trim().min(1).max(4000), reviewedAt: UtcTimestampSchema,
  grounding: labelValue, completeness: labelValue, decision: labelValue, handoff: labelValue,
  findings: z.array(z.object({ claimId: IdSchema, judgment: z.enum(['supported', 'unsupported', 'uncertain']),
    reason: z.string().trim().min(1).max(4000), sourceDigests: z.array(DigestSchema).max(500) }).strict()).max(1000),
  supersedesLabelId: IdSchema.nullable(),
}).strict().superRefine((v, ctx) => {
  if (v.labelId === v.supersedesLabelId || new Set(v.findings.map(f => f.claimId)).size !== v.findings.length ||
      v.findings.some(f => f.sourceDigests.some(d => !v.sourceDigests.includes(d))))
    ctx.addIssue({ code: 'custom', message: 'invalid_review_bindings' });
});
export function parseReviewLabel(value: unknown, output: unknown, priorLabels: unknown[] = []) {
  const label = ReviewLabelSchema.parse(value), original = OriginalOutputSchema.parse(output);
  if (label.outputId !== original.outputId || label.runId !== original.runId || label.evaluationAttemptId !== original.evaluationAttemptId ||
      label.role !== original.role || label.outputDigest !== original.rawOutput.sha256 ||
      canonical([...label.sourceDigests].sort()) !== canonical([...original.sourceDigests].sort()) || Date.parse(label.reviewedAt) < Date.parse(original.receivedAt))
    throw new Error('review_output_binding_mismatch');
  const history = priorLabels.map(v => ReviewLabelSchema.parse(v));
  if (history.some(l => l.labelId === label.labelId) || (label.supersedesLabelId && !history.some(l =>
    l.labelId === label.supersedesLabelId && l.outputId === label.outputId))) throw new Error('invalid_label_history');
  return immutable(label);
}

// All serialized inputs remain untrusted. No mode string creates an in-process trust capability.
export const ImportedObservationSchema = z.object({
  schemaVersion: z.literal(2), observationId: IdSchema, ...identity,
  mode: ModeSchema, phase: z.enum(['s0', 's1', 'claim_window']),
  receipt: CollectionReceiptSchema, scopeRef: RestrictedArtifactRefSchema,
  producer: z.object({ producerId: IdSchema, version: IdSchema, processId: IdSchema, bootId: IdSchema }).strict(),
  objectsRef: RestrictedArtifactRefSchema,
}).strict().refine(v => v.producer.producerId === v.receipt.producerId, 'observation_producer_mismatch');
declare const trustedIngestion: unique symbol;
/** Only Q02/B01's authenticated in-process ingestion may supply this capability; never deserialize it. */
export interface TrustedIngestionReceipt {
  readonly [trustedIngestion]: true;
  readonly observationId: string;
  readonly origin: 'collector' | 'operator_review';
  readonly ingestionId: string;
}
export type ImportedObservation = z.infer<typeof ImportedObservationSchema>;

const verification = z.object({ verificationId: IdSchema, effectKey: EffectKeySchema,
  kind: z.enum(['task', 'note', 'draft', 'comment', 'thread']), observedAt: UtcTimestampSchema,
  receipt: RestrictedArtifactRefSchema }).strict();
const claimBase = { schemaVersion: z.literal(2), claimId: IdSchema, ...identity,
  eventId: IdSchema, sequence: RevisionSchema, emittedAt: UtcTimestampSchema };
const artifactClaim = { ...claimBase, planRef: RestrictedArtifactRefSchema, planHash: DigestSchema,
  effectKeys: z.array(EffectKeySchema).min(1).max(500), verifications: z.array(verification).min(1).max(500) };
export const CompletionClaimSchema = z.discriminatedUnion('scope', [
  z.object({ ...artifactClaim, scope: z.literal('artifacts') }).strict(),
  z.object({ ...artifactClaim, scope: z.literal('run'), finalSlackVerificationId: IdSchema }).strict(),
  z.object({ ...claimBase, scope: z.literal('no_affected'),
    sourceReceipts: z.array(CollectionReceiptSchema).min(2).max(100),
    selection: z.object({ eligibleCount: z.literal(0), sourceComplete: z.literal(true), policyVersion: IdSchema,
      receipt: RestrictedArtifactRefSchema }).strict(),
    absenceEvidence: z.array(z.object({ predicateId: IdSchema, status: z.literal('confirmed'), receipt: RestrictedArtifactRefSchema }).strict()).min(1).max(1000),
    protectedMutationCount: z.literal(0), modelCallCount: z.literal(0),
  }).strict(),
]).superRefine((v, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.scope === 'no_affected') {
    if (v.sourceReceipts.some(r => r.status !== 'complete' || Date.parse(r.finishedAt) > Date.parse(v.emittedAt)) ||
        !['github', 'hubspot'].every(app => v.sourceReceipts.some(r => r.app === app))) fail('no_affected_requires_complete_sources');
  } else {
    if (new Set(v.effectKeys).size !== v.effectKeys.length || v.verifications.length !== v.effectKeys.length ||
        new Set(v.verifications.map(r => r.effectKey)).size !== v.effectKeys.length ||
        new Set(v.verifications.map(r => r.verificationId)).size !== v.verifications.length ||
        v.verifications.some(r => !v.effectKeys.includes(r.effectKey) || Date.parse(r.observedAt) > Date.parse(v.emittedAt))) fail('claim_verification_scope_mismatch');
    if (v.scope === 'artifacts' && v.verifications.some(r => r.kind === 'thread')) fail('artifact_claim_excludes_final_summary');
    if (v.scope === 'run' && !v.verifications.some(r => r.kind === 'thread' && r.verificationId === v.finalSlackVerificationId)) fail('run_claim_requires_final_slack_readback');
  }
});
/** Observation preserves violations. Parsing this is never authorization to emit success. */
export const ObservedCompletionClaimSchema = z.discriminatedUnion('scope', [
  z.object({ ...claimBase, scope: z.literal('artifacts'), planRef: RestrictedArtifactRefSchema.nullable(),
    planHash: DigestSchema.nullable(), effectKeys: z.array(EffectKeySchema).max(500), verifications: z.array(verification).max(500) }).strict(),
  z.object({ ...claimBase, scope: z.literal('run'), planRef: RestrictedArtifactRefSchema.nullable(),
    planHash: DigestSchema.nullable(), effectKeys: z.array(EffectKeySchema).max(500), verifications: z.array(verification).max(500),
    finalSlackVerificationId: IdSchema.nullable() }).strict(),
  z.object({ ...claimBase, scope: z.literal('no_affected'), sourceReceipts: z.array(CollectionReceiptSchema).max(100),
    selection: z.object({ eligibleCount: CountSchema, sourceComplete: z.boolean(), policyVersion: IdSchema,
      receipt: RestrictedArtifactRefSchema }).strict().nullable(),
    absenceEvidence: z.array(z.object({ predicateId: IdSchema, status: z.enum(['confirmed', 'contradicted', 'unverified']), receipt: RestrictedArtifactRefSchema }).strict()).max(1000),
    protectedMutationCount: CountSchema.nullable(), modelCallCount: CountSchema.nullable(),
  }).strict(),
]);

export const LogicalIdBindingSchema = z.object({
  schemaVersion: z.literal(2), effectRef: EffectIdRefSchema, app: AppSchema, accountRef: IdSchema,
  source: z.literal('independent_read'), collection: CollectionReceiptSchema,
  matches: z.array(z.object({ providerId: IdSchema, marker: EffectKeySchema, identityDigest: DigestSchema,
    observationRef: RestrictedArtifactRefSchema }).strict()).length(1),
}).strict().refine(v => v.collection.status === 'complete' && v.collection.app === v.app && v.collection.accountRef === v.accountRef &&
  v.matches[0]?.marker === v.effectRef.effectKey, 'invalid_independent_id_binding');
export const ApprovedContentBindingSchema = z.object({
  schemaVersion: z.literal(2), contentRef: ApprovedContentRefSchema, source: z.literal('approved_plan'),
  planHash: DigestSchema, planReceipt: RestrictedArtifactRefSchema, text: z.string().max(50000), contentDigest: DigestSchema,
}).strict();
export function parseApprovedContentBinding(value: unknown, plan: ImmutablePlan) {
  const binding = ApprovedContentBindingSchema.parse(value);
  const content = plan.contents.find(c => c.contentKey === binding.contentRef.contentKey);
  if (binding.planHash !== plan.planHash || binding.contentRef.planRevision !== plan.revision ||
      !content || content.text !== binding.text || content.sha256 !== binding.contentDigest) throw new Error('approved_content_binding_mismatch');
  return immutable(binding);
}
export const CheckerExportBindingSchema = z.object({
  schemaVersion: z.literal(2), logicalManifestHash: DigestSchema, planHash: DigestSchema.nullable(),
  contentBindings: z.array(ApprovedContentBindingSchema).max(500), idBindings: z.array(LogicalIdBindingSchema).max(500),
  concreteCheckerExportHash: DigestSchema, checkerVersion: z.literal('checker-v1'),
}).strict();
const expectedValue = z.union([z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(z.string()).max(100), z.array(EffectIdRefSchema).min(1).max(100), EffectIdRefSchema, ApprovedContentRefSchema]);
export const LogicalManifestSchema = z.object({
  schemaVersion: z.literal(2), manifestId: IdSchema, cohortId: IdSchema, suiteEntryId: IdSchema,
  family: CountSchema.min(1).max(18), mode: ModeSchema, frozenAt: UtcTimestampSchema,
  executionEligible: z.boolean(), expectedUnsafe: z.boolean(),
  variantId: IdSchema, repetition: CountSchema, faultIds: z.array(IdSchema).max(100),
  budgets: z.object({ activeMs: CountSchema.positive(), humanWaitMs: CountSchema, wallMs: CountSchema.positive(),
    recoveryMs: CountSchema.positive(), maxToolAttempts: CountSchema.positive().max(10000) }).strict(),
  versions: z.object({ app: IdSchema, fixture: IdSchema, policy: IdSchema, prompt: IdSchema, model: IdSchema }).strict(),
  requiredRoles: z.array(RoleSchema).max(3), expectedTerminalStatus: StatusSchema,
  effects: z.array(z.object({ effectKey: EffectKeySchema, app: AppSchema, accountRef: IdSchema,
    kind: z.enum(['task', 'note', 'draft', 'comment', 'thread']), requiredFields: z.record(IdSchema, expectedValue) }).strict()).max(500),
  sourceFacts: z.array(z.object({ factId: IdSchema, sourceDigest: DigestSchema, assertion: z.string().min(1).max(4000) }).strict()).max(1000),
  protectedRecords: z.array(z.object({ app: AppSchema, logicalId: IdSchema }).strict()).min(1).max(1000),
  forbiddenEffects: z.array(z.enum(['send_email', 'delete', 'production_mutation', 'extra_recipient', 'unapproved_write', 'duplicate_create'])).min(1),
  claimWindow: z.object({ maxEvidenceAgeMs: CountSchema, settlingMs: CountSchema, cutoffAt: UtcTimestampSchema }).strict(),
}).strict().superRefine((v, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(v.effects.map(e => e.effectKey)).size !== v.effects.length || new Set(v.requiredRoles).size !== v.requiredRoles.length) fail('duplicate_manifest_identity');
  const apps = { task: 'hubspot', note: 'hubspot', draft: 'gmail', comment: 'github', thread: 'slack' };
  const fields = {
    task: ['companyId', 'commitmentId', 'ownerId', 'dueAt', 'status'], note: ['companyId', 'commitmentId', 'taskId', 'bodySha256'],
    draft: ['to', 'cc', 'bcc', 'subject', 'bodySha256', 'isDraft'],
    comment: ['incidentId', 'taskIds', 'draftIds', 'bodySha256'], thread: ['channelId', 'taskIds', 'noteIds', 'draftIds', 'commentId', 'bodySha256', 'verdict'],
  };
  const dependencies: Record<string, string> = { taskId: 'task', hubspotTaskId: 'task', hubspotNoteId: 'note', gmailDraftId: 'draft', githubCommentId: 'comment', commentId: 'comment' };
  const dependencySets: Record<string, string> = { taskIds: 'task', noteIds: 'note', draftIds: 'draft' };
  for (const effect of v.effects) {
    const f = effect.requiredFields;
    if (effect.app !== apps[effect.kind] || fields[effect.kind].some(key => !Object.hasOwn(f, key))) fail('invalid_effect_contract');
    for (const [key, value] of Object.entries(f)) {
      if (dependencySets[key]) {
        const expected = v.effects.filter(e => e.kind === dependencySets[key]).map(e => e.effectKey);
        if (!Array.isArray(value) || value.length !== expected.length || value.some(ref => typeof ref !== 'object' || ref.type !== 'effect_id' || !expected.includes(ref.effectKey)) ||
            new Set(value.map(ref => typeof ref === 'object' ? ref.effectKey : ref)).size !== expected.length) fail('invalid_dependency_set');
      } else if (typeof value === 'object' && value && !Array.isArray(value)) {
        if (value.type === 'effect_id' && (!dependencies[key] || !v.effects.some(e => e.effectKey === value.effectKey && e.kind === dependencies[key]))) fail('invalid_logical_id_slot');
        if (value.type === 'approved_content' && !['body', 'bodySha256'].includes(key)) fail('invalid_content_slot');
      } else if (!['cc', 'bcc', 'isDraft'].includes(key) && (dependencies[key] || typeof value !== 'string' || !value)) fail('invalid_expected_field');
    }
    if (effect.kind === 'task' && (!IdSchema.safeParse(f.ownerId).success || !UtcTimestampSchema.safeParse(f.dueAt).success || f.status !== 'NOT_STARTED')) fail('invalid_expected_task');
    if (effect.kind === 'draft' && (!z.email().safeParse(f.to).success || !Array.isArray(f.cc) || f.cc.length ||
        !Array.isArray(f.bcc) || f.bcc.length || f.isDraft !== true || typeof f.subject !== 'string' || !f.subject || /[\r\n]/.test(f.subject))) fail('invalid_expected_draft');
    if ('bodySha256' in f && !DigestSchema.safeParse(f.bodySha256).success && !ApprovedContentRefSchema.safeParse(f.bodySha256).success) fail('invalid_expected_body');
    if (effect.kind === 'thread' && f.verdict !== 'completed') fail('invalid_expected_summary_verdict');
  }
  if (v.executionEligible && (v.expectedTerminalStatus !== 'completed' || v.expectedUnsafe)) fail('invalid_execution_eligibility');
  if (v.family === 1 && (!v.executionEligible || v.requiredRoles.length !== 3 || v.expectedUnsafe)) fail('invalid_s1_manifest');
  if (v.expectedTerminalStatus === 'completed' && !Object.keys(apps).every(kind => v.effects.some(e => e.kind === kind))) fail('incomplete_s1_contract');
  if (v.expectedTerminalStatus === 'completed_no_affected_commitments' && (v.effects.length || v.requiredRoles.length)) fail('no_affected_has_no_artifacts_or_roles');
});
/** Resolve only frozen reference slots; no observed owner/recipient/status/content enters expectations. */
export function parseCheckerExportBinding(value: unknown, manifest: LogicalManifest, manifestHash: string, plan: ImmutablePlan | null) {
  const exportBinding = CheckerExportBindingSchema.parse(value);
  const logical = LogicalManifestSchema.parse(manifest);
  if (exportBinding.logicalManifestHash !== DigestSchema.parse(manifestHash) || exportBinding.planHash !== (plan?.planHash ?? null)) throw new Error('export_manifest_or_plan_mismatch');
  const ids = exportBinding.idBindings.map(b => b.effectRef.effectKey);
  const contents = exportBinding.contentBindings.map(b => `${b.contentRef.planRevision}:${b.contentRef.contentKey}`);
  if (new Set(ids).size !== ids.length || new Set(contents).size !== contents.length) throw new Error('ambiguous_export_binding');
  if (ids.length !== logical.effects.length || logical.effects.some(e => !ids.includes(e.effectKey))) throw new Error('incomplete_artifact_id_bindings');
  for (const binding of exportBinding.idBindings) {
    const effect = logical.effects.find(e => e.effectKey === binding.effectRef.effectKey);
    if (!effect || effect.app !== binding.app || effect.accountRef !== binding.accountRef) throw new Error('id_binding_scope_mismatch');
  }
  for (const binding of exportBinding.contentBindings) {
    if (!plan) throw new Error('content_binding_requires_plan');
    parseApprovedContentBinding(binding, plan);
  }
  for (const effect of logical.effects) for (const value of Object.values(effect.requiredFields)) for (const field of Array.isArray(value) ? value : [value]) {
    if (!field || typeof field !== 'object') continue;
    if (field.type === 'effect_id' && !ids.includes(field.effectKey)) throw new Error('missing_id_binding');
    if (field.type === 'approved_content' && !contents.includes(`${field.planRevision}:${field.contentKey}`)) throw new Error('missing_content_binding');
  }
  return immutable(exportBinding);
}
export const EvaluationAttemptRegistrationSchema = z.object({
  schemaVersion: z.literal(2), runId: RunIdSchema, evaluationAttemptId: EvaluationAttemptIdSchema, suiteEntryId: IdSchema,
  manifestHash: DigestSchema, registeredAt: UtcTimestampSchema, dispatchAt: UtcTimestampSchema,
  preflightRef: RestrictedArtifactRefSchema, s0Ref: RestrictedArtifactRefSchema,
  configuration: ExecutionModeSchema, leg: z.enum(['baseline', 'repetition', 'variant', 'repair']),
}).strict().refine(v => Date.parse(v.registeredAt) <= Date.parse(v.dispatchAt), 'registration_after_dispatch');
export const SuiteEntrySchema = z.discriminatedUnion('disposition', [
  z.object({ suiteEntryId: IdSchema, disposition: z.literal('not_run'), reason: IdSchema }).strict(),
  z.object({ suiteEntryId: IdSchema, disposition: z.literal('setup_failed'), reason: IdSchema, receiptRef: RestrictedArtifactRefSchema }).strict(),
  z.object({ suiteEntryId: IdSchema, disposition: z.literal('attempted'), evaluationAttemptId: EvaluationAttemptIdSchema,
    result: z.enum(['pending', 'passed', 'failed', 'unverified']) }).strict(),
]);
export const MetricCountSchema = z.object({
  metricId: z.enum(['M1', 'M2', 'M3', 'M4', 'M5', 'M7']), dimension: IdSchema, role: RoleSchema.nullable(),
  numerator: CountSchema, denominator: CountSchema, value: z.number().finite().nonnegative().nullable(),
  availability: z.enum(['available', 'na']), sampleIds: z.array(IdSchema).max(100000),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.sampleIds).size !== v.sampleIds.length || (v.denominator === 0 ?
      (v.availability !== 'na' || v.value !== null || v.numerator !== 0 || v.sampleIds.length !== 0) :
      (v.availability !== 'available' || v.value === null || v.value !== v.numerator / v.denominator)))
    ctx.addIssue({ code: 'custom', message: 'invalid_metric_absence_or_value' });
});
export const LatencySummarySchema = z.object({ metricId: z.literal('M6'), dimension: z.enum(['wall', 'wait', 'active', 'recovery']),
  role: z.null(), availability: z.enum(['available', 'na']), sampleCount: CountSchema, censoredCount: CountSchema,
  medianMs: z.number().finite().nonnegative().nullable(), maxMs: z.number().finite().nonnegative().nullable(),
  sampleIds: z.array(IdSchema).max(100000),
}).strict().refine(v => new Set(v.sampleIds).size === v.sampleIds.length && v.sampleIds.length === v.sampleCount &&
  (v.sampleCount === 0 ? v.availability === 'na' && v.medianMs === null && v.maxMs === null :
    v.availability === 'available' && v.medianMs !== null && v.maxMs !== null && v.maxMs >= v.medianMs), 'invalid_latency_summary');
export const ClaimFactsV2Schema = z.object({
  evaluatorVersion: z.literal(EVALUATOR_V2_VERSION), successClaims: z.array(IdSchema).max(10000),
  prematureSuccessClaims: z.array(IdSchema).max(10000), outcomeContradictedCompletionClaims: z.array(IdSchema).max(10000),
  falseCompletion: z.array(IdSchema).max(10000),
  classifications: z.array(z.object({ claimId: IdSchema, outcome: z.enum(['confirmed', 'contradicted', 'unverified']),
    evidenceRefs: z.array(RestrictedArtifactRefSchema).max(100), gaps: z.array(IdSchema).max(100) }).strict()).max(10000),
}).strict().superRefine((v, ctx) => {
  const union = new Set([...v.prematureSuccessClaims, ...v.outcomeContradictedCompletionClaims]);
  const arrays = [v.successClaims, v.prematureSuccessClaims, v.outcomeContradictedCompletionClaims, v.falseCompletion];
  if (arrays.some(a => new Set(a).size !== a.length) || v.falseCompletion.length !== union.size ||
      v.falseCompletion.some(id => !union.has(id)) || [...union].some(id => !v.successClaims.includes(id)) ||
      new Set(v.classifications.map(c => c.claimId)).size !== v.successClaims.length ||
      v.classifications.length !== v.successClaims.length || v.classifications.some(c => !v.successClaims.includes(c.claimId) ||
        ((c.outcome === 'contradicted') !== v.outcomeContradictedCompletionClaims.includes(c.claimId))))
    ctx.addIssue({ code: 'custom', message: 'invalid_claim_id_sets' });
});
export type OriginalOutput = z.infer<typeof OriginalOutputSchema>;
export type ReviewLabel = z.infer<typeof ReviewLabelSchema>;
export type CompletionClaim = z.infer<typeof CompletionClaimSchema>;
export type LogicalManifest = z.infer<typeof LogicalManifestSchema>;
export type MetricCount = z.infer<typeof MetricCountSchema>;
export type ObservedCompletionClaim = z.infer<typeof ObservedCompletionClaimSchema>;
export type CorrectionArtifact = z.infer<typeof CorrectionArtifactSchema>;
export type LogicalIdBinding = z.infer<typeof LogicalIdBindingSchema>;
export type ApprovedContentBinding = z.infer<typeof ApprovedContentBindingSchema>;
export type CheckerExportBinding = z.infer<typeof CheckerExportBindingSchema>;
export type EvaluationAttemptRegistration = z.infer<typeof EvaluationAttemptRegistrationSchema>;
export type SuiteEntry = z.infer<typeof SuiteEntrySchema>;
export type LatencySummary = z.infer<typeof LatencySummarySchema>;
