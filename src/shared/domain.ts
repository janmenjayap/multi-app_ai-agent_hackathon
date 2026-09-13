import { z } from 'zod';

/** Application v2. Monitor/checker v1 retain their original wire formats. */
export const APPLICATION_SCHEMA_VERSION = 2 as const;
export const IdSchema = z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/);
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const UtcTimestampSchema = z.iso.datetime();
export const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const RevisionSchema = CountSchema.positive();
export const RunIdSchema = IdSchema.brand<'RunId'>();
export const RuntimeAttemptIdSchema = IdSchema.brand<'RuntimeAttemptId'>();
export const EvaluationAttemptIdSchema = IdSchema.brand<'EvaluationAttemptId'>();
export const ModelAttemptIdSchema = IdSchema.brand<'ModelAttemptId'>();
export const ProviderAttemptIdSchema = IdSchema.brand<'ProviderAttemptId'>();
export const EffectKeySchema = IdSchema.brand<'EffectKey'>();

// These four schemas are also re-exported by reliability.ts, unchanged for v1.
export const AppSchema = z.enum(['github', 'hubspot', 'slack', 'gmail']);
export const ModeSchema = z.enum(['synthetic_fixture', 'model_with_fake_providers', 'imported_provider_snapshot']);
export const RoleSchema = z.enum(['analyst', 'drafter', 'auditor']);
export const StatusSchema = z.enum(['completed', 'completed_no_affected_commitments', 'awaiting_approval', 'safely_blocked', 'failed_partial', 'failed']);
export const ProductStatusSchema = z.enum(['queued', 'running', ...StatusSchema.options]);
export const PIPELINE_STAGE_IDS = ['ingest', 'select', 'analyst', 'drafter', 'auditor', 'approval', 'execute', 'verify', 'assess'] as const;
export const StageIdSchema = z.enum(PIPELINE_STAGE_IDS);
export const EventKindSchema = z.enum(['stage.started', 'stage.finished', 'model.attempt.started', 'model.attempt.result',
  'model.attempt.error', 'tool.dispatch', 'tool.result', 'tool.error', 'retry.scheduled', 'sources.collected', 'plan.frozen',
  'approval.checked', 'guard.checked', 'effect.reconciled', 'effect.verified', 'wait.started', 'wait.ended',
  'fault.recorded', 'correction.recorded', 'run.status', 'success.claimed']);
export const ModelModeSchema = z.enum(['mock', 'live']);
export const AdapterModeSchema = z.enum(['fake', 'rest']);
export const ExecutionModeSchema = z.object({
  schemaVersion: z.literal(2), modelMode: ModelModeSchema, providerMode: AdapterModeSchema,
  evidenceMode: ModeSchema, fixtureId: IdSchema.nullable(),
}).strict().superRefine((v, ctx) => {
  if ((v.modelMode === 'mock' || v.providerMode === 'fake') && !v.fixtureId)
    ctx.addIssue({ code: 'custom', message: 'synthetic_configuration_requires_fixture' });
});

export const RestrictedArtifactRefSchema = z.object({
  artifactId: IdSchema, sha256: DigestSchema, byteLength: CountSchema,
  mediaType: z.enum(['application/json', 'text/plain', 'message/rfc822']),
}).strict();
export const GitHubIssueUrlSchema = z.string().max(2048).refine(value => {
  try {
    const u = new URL(value);
    return u.origin === 'https://github.com' && !u.username && !u.password && !u.search && !u.hash &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/.test(u.pathname);
  } catch { return false; }
}, 'invalid_github_issue_url');
export const IncidentIdentitySchema = z.object({
  schemaVersion: z.literal(2), repositoryId: IdSchema, issueId: IdSchema,
  issueNumber: CountSchema.positive(), canonicalUrl: GitHubIssueUrlSchema,
  service: IdSchema, environment: IdSchema,
}).strict().superRefine((v, ctx) => {
  if (GitHubIssueUrlSchema.safeParse(v.canonicalUrl).success && new URL(v.canonicalUrl).pathname.split('/').at(-1) !== String(v.issueNumber))
    ctx.addIssue({ code: 'custom', message: 'issue_number_mismatch' });
});

export const ReadFailureReasonSchema = z.enum(['denied', 'timeout', 'rate_limited', 'transport_error',
  'page_failed', 'budget_exhausted', 'malformed_response', 'missing_identity', 'ambiguous_identity', 'scope_mismatch']);
export const PageReceiptSchema = z.object({
  queryId: IdSchema, cursor: z.string().min(1).max(2048).nullable(),
  nextCursor: z.string().min(1).max(2048).nullable(), recordCount: CountSchema,
  response: RestrictedArtifactRefSchema, providerAttemptId: ProviderAttemptIdSchema,
}).strict();
export const CollectionReceiptSchema = z.object({
  schemaVersion: z.literal(2), collectionId: IdSchema, app: AppSchema, accountRef: IdSchema,
  producerId: IdSchema, startedAt: UtcTimestampSchema, finishedAt: UtcTimestampSchema,
  status: z.enum(['complete', 'incomplete']), reason: ReadFailureReasonSchema.nullable(),
  requiredQueryIds: z.array(IdSchema).min(1).max(100), pages: z.array(PageReceiptSchema).max(1000),
}).strict().superRefine((v, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (Date.parse(v.finishedAt) < Date.parse(v.startedAt)) fail('invalid_collection_window');
  if (new Set(v.requiredQueryIds).size !== v.requiredQueryIds.length) fail('duplicate_query');
  if (v.status === 'complete' ? v.reason !== null : v.reason === null) fail('incomplete_reason_required');
  if (v.pages.some(p => !v.requiredQueryIds.includes(p.queryId))) fail('undeclared_query');
  for (const queryId of v.requiredQueryIds) {
    const pages = v.pages.filter(p => p.queryId === queryId);
    if (new Set(pages.map(p => p.cursor)).size !== pages.length) fail('duplicate_page');
    if (pages.some((p, i) => p.cursor !== (i === 0 ? null : pages[i - 1].nextCursor) || (i > 0 && p.cursor === null)))
      fail('broken_page_chain');
    if (v.status === 'complete' && (!pages.length || pages.at(-1)!.nextCursor !== null)) fail('incomplete_query_coverage');
  }
});
export function readResultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('complete'), data, receipt: CollectionReceiptSchema }).strict(),
    z.object({ status: z.literal('incomplete'), reason: ReadFailureReasonSchema,
      partialData: data.optional(), receipt: CollectionReceiptSchema }).strict(),
  ]).superRefine((v, ctx) => {
    if (v.status !== v.receipt.status || ('reason' in v && v.reason !== v.receipt.reason))
      ctx.addIssue({ code: 'custom', message: 'read_receipt_status_mismatch' });
  });
}
export const SnapshotRefSchema = z.object({
  snapshotId: IdSchema, app: AppSchema, accountRef: IdSchema, sourceIds: z.array(IdSchema).min(1).max(1000),
  capturedAt: UtcTimestampSchema, relevantVersion: IdSchema, artifact: RestrictedArtifactRefSchema,
  receipt: CollectionReceiptSchema,
}).strict().superRefine((v, ctx) => {
  if (v.app !== v.receipt.app || v.accountRef !== v.receipt.accountRef || v.receipt.status !== 'complete')
    ctx.addIssue({ code: 'custom', message: 'snapshot_requires_complete_matching_receipt' });
});
export const SelectedCommitmentSchema = z.object({
  commitmentId: IdSchema, companyId: IdSchema, ownerId: IdSchema, contactId: IdSchema,
  mailbox: z.email(), dueAt: UtcTimestampSchema, service: IdSchema, reason: IdSchema,
}).strict();
export const SelectionSchema = z.object({
  schemaVersion: z.literal(2), policyVersion: IdSchema, evaluatedAt: UtcTimestampSchema,
  sourceBundleRef: RestrictedArtifactRefSchema, sourceComplete: z.literal(true),
  selected: z.array(SelectedCommitmentSchema).max(100),
  excluded: z.array(z.object({ commitmentId: IdSchema, reason: IdSchema }).strict()).max(1000),
}).strict().superRefine((v, ctx) => {
  const ids = [...v.selected, ...v.excluded].map(c => c.commitmentId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate_selection_identity' });
});

export const EffectIdRefSchema = z.object({ type: z.literal('effect_id'), effectKey: EffectKeySchema }).strict();
export const ApprovedContentRefSchema = z.object({
  type: z.literal('approved_content'), planRevision: RevisionSchema, contentKey: IdSchema,
}).strict();
export const DestinationIdSchema = z.union([IdSchema, EffectIdRefSchema]);
export const ContentTemplateSchema = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(50000) }).strict(), EffectIdRefSchema, ApprovedContentRefSchema,
])).min(1).max(200);
const effectBase = { effectKey: EffectKeySchema, commitmentId: IdSchema, requestDigest: DigestSchema };
export const PlannedEffectSchema = z.discriminatedUnion('kind', [
  z.object({ ...effectBase, kind: z.literal('task'), app: z.literal('hubspot'), payload: z.object({
    companyId: IdSchema, commitmentId: IdSchema, ownerId: IdSchema, dueAt: UtcTimestampSchema,
    status: z.literal('NOT_STARTED'), subject: z.string().min(1).max(1000), body: ContentTemplateSchema,
  }).strict() }).strict(),
  z.object({ ...effectBase, kind: z.literal('note'), app: z.literal('hubspot'), payload: z.object({
    companyId: IdSchema, commitmentId: IdSchema, taskId: DestinationIdSchema, body: ContentTemplateSchema,
  }).strict() }).strict(),
  z.object({ ...effectBase, kind: z.literal('draft'), app: z.literal('gmail'), payload: z.object({
    to: z.email(), cc: z.array(z.email()).max(0), bcc: z.array(z.email()).max(0),
    subject: z.string().min(1).max(1000).regex(/^[^\r\n]+$/), body: ContentTemplateSchema, isDraft: z.literal(true),
  }).strict() }).strict(),
  z.object({ ...effectBase, commitmentId: z.null(), kind: z.literal('comment'), app: z.literal('github'), payload: z.object({
    repositoryId: IdSchema, issueId: IdSchema, taskIds: z.array(EffectIdRefSchema).min(1).max(100), draftIds: z.array(EffectIdRefSchema).min(1).max(100),
    body: ContentTemplateSchema,
  }).strict() }).strict(),
  z.object({ ...effectBase, commitmentId: z.null(), kind: z.literal('thread'), app: z.literal('slack'), payload: z.object({
    channelId: IdSchema, threadTs: IdSchema, body: ContentTemplateSchema,
  }).strict() }).strict(),
]);
export const ImmutablePlanSchema = z.object({
  schemaVersion: z.literal(2), runId: RunIdSchema, revision: RevisionSchema, planHash: DigestSchema,
  createdAt: UtcTimestampSchema, incident: IncidentIdentitySchema, selection: SelectionSchema,
  sources: z.array(SnapshotRefSchema).min(2).max(100),
  contents: z.array(z.object({ contentKey: IdSchema, text: z.string().max(50000), sha256: DigestSchema }).strict()).min(1).max(500),
  effects: z.array(PlannedEffectSchema).min(5).max(500),
}).strict().superRefine((v, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const keys = v.effects.map(e => e.effectKey);
  if (new Set(keys).size !== keys.length) fail('duplicate_effect_key');
  if (new Set(v.contents.map(c => c.contentKey)).size !== v.contents.length) fail('duplicate_content_key');
  if (!['github', 'hubspot'].every(app => v.sources.some(s => s.app === app))) fail('missing_source_app');
  const selected = new Map(v.selection.selected.map(c => [c.commitmentId, c]));
  if (!selected.size) fail('empty_selection_has_no_plan');
  const kinds = ['task', 'note', 'draft'];
  for (const c of selected.values()) {
    const es = v.effects.filter(e => e.commitmentId === c.commitmentId);
    if (es.length !== 3 || kinds.some(kind => es.filter(e => e.kind === kind).length !== 1)) fail('incomplete_effect_set');
    if (es.map(e => e.kind).join() !== kinds.join()) fail('invalid_effect_order');
  }
  const expectedOrder = [...v.selection.selected.flatMap(() => kinds), 'comment', 'thread'];
  if (v.effects.map(e => e.kind).join() !== expectedOrder.join()) fail('invalid_global_effect_order');
  for (const e of v.effects) {
    const c = e.commitmentId === null ? null : selected.get(e.commitmentId);
    if (e.commitmentId !== null && !c) { fail('unselected_effect'); continue; }
    if (e.kind === 'task' && (e.payload.companyId !== c!.companyId || e.payload.commitmentId !== c!.commitmentId ||
        e.payload.ownerId !== c!.ownerId || e.payload.dueAt !== c!.dueAt)) fail('task_selection_mismatch');
    if (e.kind === 'note' && (e.payload.companyId !== c!.companyId || e.payload.commitmentId !== c!.commitmentId)) fail('note_selection_mismatch');
    if (e.kind === 'draft' && e.payload.to !== c!.mailbox) fail('recipient_selection_mismatch');
    if (e.kind === 'comment' && (e.payload.repositoryId !== v.incident.repositoryId || e.payload.issueId !== v.incident.issueId)) fail('incident_selection_mismatch');
    const refs = e.payload.body.filter(p => p.type === 'effect_id');
    const typedRefs = e.kind === 'note' ? [e.payload.taskId] : e.kind === 'comment' ? [...e.payload.taskIds, ...e.payload.draftIds] : [];
    for (const ref of [...refs, ...typedRefs]) {
      if (typeof ref === 'string') continue;
      const target = v.effects.find(t => t.effectKey === ref.effectKey);
      if (!target || (e.commitmentId !== null && target.commitmentId !== e.commitmentId) || keys.indexOf(ref.effectKey) >= keys.indexOf(e.effectKey)) fail('invalid_effect_reference');
    }
    if (e.kind === 'note' && (typeof e.payload.taskId === 'string' || !v.effects.some(t =>
      t.effectKey === (e.payload.taskId as z.infer<typeof EffectIdRefSchema>).effectKey && t.kind === 'task' && t.commitmentId === e.commitmentId))) fail('note_task_binding_mismatch');
    if (e.kind === 'comment') for (const [kind, refs] of [['task', e.payload.taskIds], ['draft', e.payload.draftIds]] as const) {
      const expected = v.effects.filter(t => t.kind === kind).map(t => t.effectKey);
      if (refs.length !== expected.length || new Set(refs.map(r => r.effectKey)).size !== refs.length || refs.some(r => !expected.includes(r.effectKey))) fail('comment_dependency_mismatch');
    }
    for (const ref of e.payload.body) if (ref.type === 'approved_content' &&
      (ref.planRevision !== v.revision || !v.contents.some(c => c.contentKey === ref.contentKey))) fail('invalid_approved_content_reference');
  }
});

export const SlackDecisionSchema = z.object({
  schemaVersion: z.literal(2), approvalId: IdSchema, runId: RunIdSchema,
  planRevision: RevisionSchema, planHash: DigestSchema, transport: z.literal('slack_human_reply'),
  workspaceId: IdSchema, channelId: IdSchema, threadTs: IdSchema, reviewMessageTs: IdSchema,
  decisionMessageTs: IdSchema, actorId: IdSchema, authorizedActorId: IdSchema,
  isBot: z.literal(false), editedAt: z.null(), deleted: z.literal(false),
  decision: z.enum(['approved', 'rejected']), decidedAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema, observedAt: UtcTimestampSchema,
  reviewRef: RestrictedArtifactRefSchema, decisionRef: RestrictedArtifactRefSchema,
}).strict().superRefine((v, ctx) => {
  if (v.actorId !== v.authorizedActorId || Date.parse(v.expiresAt) <= Date.parse(v.decidedAt) ||
      Date.parse(v.observedAt) < Date.parse(v.decidedAt))
    ctx.addIssue({ code: 'custom', message: 'invalid_slack_decision' });
});
export const EffectStateSchema = z.enum(['planned', 'inflight', 'applied', 'verified']);
export const MutationOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied'), providerId: IdSchema, receipt: RestrictedArtifactRefSchema }).strict(),
  z.object({ status: z.literal('not_applied'), reason: ReadFailureReasonSchema, receipt: RestrictedArtifactRefSchema }).strict(),
  z.object({ status: z.literal('unknown'), reason: z.enum(['timeout', 'transport_error', 'malformed_response']), receipt: RestrictedArtifactRefSchema }).strict(),
]);
export const EffectRecordSchema = z.object({
  schemaVersion: z.literal(2), runId: RunIdSchema, effectKey: EffectKeySchema, state: EffectStateSchema,
  requestDigest: DigestSchema, providerId: IdSchema.nullable(), claimId: IdSchema.nullable(),
  outcome: MutationOutcomeSchema.nullable(), verificationRef: RestrictedArtifactRefSchema.nullable(),
}).strict().superRefine((v, ctx) => {
  if ((v.state !== 'planned' && !v.claimId) || (['applied', 'verified'].includes(v.state) && !v.providerId) ||
      (v.state === 'verified' && !v.verificationRef) || (v.outcome?.status === 'unknown' && v.state !== 'inflight') ||
      (v.outcome?.status === 'applied' && v.providerId !== v.outcome.providerId) ||
      (v.state === 'planned' && (v.outcome !== null || v.claimId !== null || v.providerId !== null || v.verificationRef !== null)) ||
      (['applied', 'verified'].includes(v.state) && v.outcome?.status !== 'applied') ||
      (v.outcome?.status === 'not_applied' && v.providerId !== null))
    ctx.addIssue({ code: 'custom', message: 'inconsistent_effect_state' });
});

/** Canonical v1-compatible JSON: sort object keys, preserve arrays and exact strings. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Normalize once before plan freeze; never trim or normalize a readback to hide edits. */
export function normalizeBody(text: string): string { return text.replace(/\r\n?/g, '\n').normalize('NFC'); }
export function immutable<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
export function parseImmutablePlan(value: unknown): ImmutablePlan { return immutable(ImmutablePlanSchema.parse(value)); }
export function parseIncidentIdentity(value: unknown): IncidentIdentity { return immutable(IncidentIdentitySchema.parse(value)); }
/** Hash rules shared by B03 and its consumers; hashes never include their own field. */
export function requestHashMaterial(effect: PlannedEffect, contents: ImmutablePlan['contents'] = []) {
  const { requestDigest: _digest, ...material } = PlannedEffectSchema.parse(effect);
  const body = material.payload.body.map(part => {
    if (part.type !== 'approved_content') return part;
    const content = contents.find(c => c.contentKey === part.contentKey);
    if (!content) throw new Error('missing_approved_request_content');
    return { type: 'text' as const, text: content.text };
  });
  return { ...material, payload: { ...material.payload, body } };
}
export function planHashMaterial(plan: ImmutablePlan) {
  const { planHash: _hash, ...material } = ImmutablePlanSchema.parse(plan);
  return material;
}
export async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Structural parsing is not integrity verification. B03 verifies bytes before persisting a frozen plan. */
export async function verifyPlanIntegrity(value: unknown): Promise<ImmutablePlan> {
  const plan = ImmutablePlanSchema.parse(value);
  for (const content of plan.contents) if (content.text !== normalizeBody(content.text) || await sha256Text(content.text) !== content.sha256) throw new Error('content_digest_mismatch');
  for (const effect of plan.effects) if (await sha256Text(canonical(requestHashMaterial(effect, plan.contents))) !== effect.requestDigest) throw new Error('request_digest_mismatch');
  if (await sha256Text(canonical(planHashMaterial(plan))) !== plan.planHash) throw new Error('plan_digest_mismatch');
  return immutable(plan);
}
export type RunId = z.infer<typeof RunIdSchema>;
export type RuntimeAttemptId = z.infer<typeof RuntimeAttemptIdSchema>;
export type EvaluationAttemptId = z.infer<typeof EvaluationAttemptIdSchema>;
export type ModelAttemptId = z.infer<typeof ModelAttemptIdSchema>;
export type ProviderAttemptId = z.infer<typeof ProviderAttemptIdSchema>;
export type EffectKey = z.infer<typeof EffectKeySchema>;
export type IncidentIdentity = z.infer<typeof IncidentIdentitySchema>;
export type RestrictedArtifactRef = z.infer<typeof RestrictedArtifactRefSchema>;
export type CollectionReceipt = z.infer<typeof CollectionReceiptSchema>;
export type ReadResult<T> = { status: 'complete'; data: T; receipt: CollectionReceipt } |
  { status: 'incomplete'; reason: z.infer<typeof ReadFailureReasonSchema>; partialData?: T; receipt: CollectionReceipt };
export type SelectedCommitment = z.infer<typeof SelectedCommitmentSchema>;
export type Selection = z.infer<typeof SelectionSchema>;
export type ImmutablePlan = z.infer<typeof ImmutablePlanSchema>;
export type PlannedEffect = z.infer<typeof PlannedEffectSchema>;
export type MutationOutcome = z.infer<typeof MutationOutcomeSchema>;
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export type EffectIdRef = z.infer<typeof EffectIdRefSchema>;
export type ApprovedContentRef = z.infer<typeof ApprovedContentRefSchema>;
export type SnapshotRef = z.infer<typeof SnapshotRefSchema>;
export type SlackDecision = z.infer<typeof SlackDecisionSchema>;
export type EffectRecord = z.infer<typeof EffectRecordSchema>;
export type RunStatus = z.infer<typeof ProductStatusSchema>;
