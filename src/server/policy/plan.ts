import { z } from 'zod';
import { SourceFactSchema } from '../../shared/agents.js';
import {
  ApprovedContentRefSchema, DigestSchema, EffectKeySchema, IdSchema, ImmutablePlanSchema,
  IncidentIdentitySchema, PlannedEffectSchema, RestrictedArtifactRefSchema, RevisionSchema,
  RunIdSchema, SelectionSchema, SnapshotRefSchema, UtcTimestampSchema, immutable,
  planHashMaterial, requestHashMaterial, sha256Text,
} from '../../shared/domain.js';
import type { ImmutablePlan, PlannedEffect } from '../../shared/domain.js';
import { bindIncidentIdentity } from './identity.js';
import {
  PlanRoleResultsSchema, PlanTaskContractSchema, RolePlanProvenanceSchema, validatePlanClaims,
} from './claims.js';
import { canonicalDigest, normalizeApprovedText } from './canonical.js';
import { deriveEffectKey, verifyPlanEffectKeys } from './effect-keys.js';

export const PLAN_POLICY_VERSION = 'plan-v1';
const EMPTY_DIGEST = '0'.repeat(64);

export const PlanBuildInputSchema = z.object({
  schemaVersion: z.literal(2), runId: RunIdSchema, revision: RevisionSchema,
  createdAt: UtcTimestampSchema, incidentFingerprint: DigestSchema, incident: IncidentIdentitySchema,
  selection: SelectionSchema, sources: z.array(SnapshotRefSchema).min(2).max(100),
  sourceFacts: z.array(SourceFactSchema).min(1).max(500), taskContract: PlanTaskContractSchema,
  roleResults: PlanRoleResultsSchema, logicalManifestHash: DigestSchema,
  slack: z.object({ channelId: IdSchema, threadTs: IdSchema }).strict(),
}).strict();
export type PlanBuildInput = z.infer<typeof PlanBuildInputSchema>;

const ContentBindingSchema = z.object({
  contentRef: ApprovedContentRefSchema, source: z.literal('approved_plan'), contentDigest: DigestSchema,
}).strict();
export const PlanFreezeReceiptSchema = z.object({
  schemaVersion: z.literal(2), policyVersion: z.literal(PLAN_POLICY_VERSION),
  runId: RunIdSchema, revision: RevisionSchema, planHash: DigestSchema,
  incidentFingerprint: DigestSchema, logicalManifestHash: DigestSchema,
  sourceDigests: z.array(DigestSchema).min(2).max(100),
  sourceFactDigests: z.array(DigestSchema).min(1).max(500),
  roleOutputs: z.array(RolePlanProvenanceSchema).length(3),
  contentBindings: z.array(ContentBindingSchema).min(1).max(500), receiptHash: DigestSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.roleOutputs.map(output => output.role)).size !== 3)
    context.addIssue({ code: 'custom', message: 'incomplete_role_provenance' });
  const contentKeys = value.contentBindings.map(binding =>
    `${binding.contentRef.planRevision}:${binding.contentRef.contentKey}`);
  if (new Set(contentKeys).size !== contentKeys.length)
    context.addIssue({ code: 'custom', message: 'duplicate_content_binding' });
});
export type PlanFreezeReceipt = z.infer<typeof PlanFreezeReceiptSchema>;

export function planFreezeReceiptHashMaterial(receiptInput: PlanFreezeReceipt) {
  const { receiptHash: _receiptHash, ...material } = PlanFreezeReceiptSchema.parse(receiptInput);
  return material;
}

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function effectRef(effectKey: z.infer<typeof EffectKeySchema>) {
  return { type: 'effect_id' as const, effectKey };
}

function contentRef(planRevision: number, contentKey: string) {
  return ApprovedContentRefSchema.parse({ type: 'approved_content', planRevision, contentKey });
}

export async function freezePlan(input: PlanBuildInput) {
  const value = PlanBuildInputSchema.parse(input);
  const bound = bindIncidentIdentity(value.incident, value.incident);
  if (bound.incidentFingerprint !== value.incidentFingerprint) throw new Error('incident_fingerprint_mismatch');
  const selected = [...value.selection.selected].sort((left, right) => compareId(left.commitmentId, right.commitmentId));
  const excluded = [...value.selection.excluded].sort((left, right) => compareId(left.commitmentId, right.commitmentId));
  const selection = SelectionSchema.parse({ ...value.selection, selected, excluded });
  if (!selected.length) throw new Error('empty_selection_has_no_plan');
  if (selected.some(commitment => commitment.service !== value.incident.service))
    throw new Error('selection_incident_service_mismatch');
  const sources = [...value.sources].sort((left, right) => compareId(left.snapshotId, right.snapshotId));
  if (new Set(sources.map(source => source.snapshotId)).size !== sources.length) throw new Error('duplicate_source_snapshot');
  const sourceFacts = [...value.sourceFacts].sort((left, right) => compareId(left.factId, right.factId));
  const claims = validatePlanClaims({ schemaVersion: 2, runId: value.runId, revision: value.revision,
    selection, sourceFacts, taskContract: value.taskContract, roleResults: value.roleResults });

  const keys = await Promise.all(selected.map(async commitment => ({ commitmentId: commitment.commitmentId,
    task: await deriveEffectKey({ incidentFingerprint: value.incidentFingerprint, app: 'hubspot',
      stableBusinessTargetId: commitment.commitmentId, actionType: 'task' }),
    note: await deriveEffectKey({ incidentFingerprint: value.incidentFingerprint, app: 'hubspot',
      stableBusinessTargetId: commitment.commitmentId, actionType: 'note' }),
    draft: await deriveEffectKey({ incidentFingerprint: value.incidentFingerprint, app: 'gmail',
      stableBusinessTargetId: commitment.commitmentId, actionType: 'draft' }),
  })));
  const commentKey = await deriveEffectKey({ incidentFingerprint: value.incidentFingerprint, app: 'github',
    stableBusinessTargetId: value.incident.issueId, actionType: 'comment' });
  const threadKey = await deriveEffectKey({ incidentFingerprint: value.incidentFingerprint, app: 'slack',
    stableBusinessTargetId: value.incidentFingerprint, actionType: 'thread' });

  const contents = await Promise.all(selected.map(async commitment => {
    const draft = claims.proposal.entries.find(entry => entry.commitmentId === commitment.commitmentId)!;
    const text = normalizeApprovedText(draft.text);
    const contentKey = `draft:${keys.find(row => row.commitmentId === commitment.commitmentId)!.draft}`;
    return { contentKey, text, sha256: await sha256Text(text) };
  }));
  const effects: PlannedEffect[] = [];
  for (const commitment of selected) {
    const effectKeys = keys.find(row => row.commitmentId === commitment.commitmentId)!;
    const approvedBody = contentRef(value.revision, `draft:${effectKeys.draft}`);
    effects.push(
      PlannedEffectSchema.parse({ commitmentId: commitment.commitmentId, requestDigest: EMPTY_DIGEST,
        kind: 'task', app: 'hubspot', effectKey: effectKeys.task, payload: {
          companyId: commitment.companyId, commitmentId: commitment.commitmentId, ownerId: commitment.ownerId,
          dueAt: commitment.dueAt, status: 'NOT_STARTED',
          subject: `[PromiseGuard:${effectKeys.task}] Incident follow-up`,
          body: [{ type: 'text', text: `Follow up on ${value.incident.canonicalUrl} for commitment ${commitment.commitmentId}.` }],
        } }),
      PlannedEffectSchema.parse({ commitmentId: commitment.commitmentId, requestDigest: EMPTY_DIGEST,
        kind: 'note', app: 'hubspot', effectKey: effectKeys.note, payload: {
          companyId: commitment.companyId, commitmentId: commitment.commitmentId,
          taskId: effectRef(effectKeys.task), body: [
            { type: 'text', text: 'Approved customer update:\n' }, approvedBody,
          ],
        } }),
      PlannedEffectSchema.parse({ commitmentId: commitment.commitmentId, requestDigest: EMPTY_DIGEST,
        kind: 'draft', app: 'gmail', effectKey: effectKeys.draft, payload: {
          to: commitment.mailbox, cc: [], bcc: [],
          subject: `[PromiseGuard:${effectKeys.draft}] Incident update`, body: [approvedBody], isDraft: true,
        } }),
    );
  }
  effects.push(
    PlannedEffectSchema.parse({ commitmentId: null, requestDigest: EMPTY_DIGEST,
      kind: 'comment', app: 'github', effectKey: commentKey, payload: {
        repositoryId: value.incident.repositoryId, issueId: value.incident.issueId,
        taskIds: keys.map(row => effectRef(row.task)), draftIds: keys.map(row => effectRef(row.draft)),
        body: [{ type: 'text', text: `[PromiseGuard:${commentKey}] Approved customer-impact follow-up.` }],
      } }),
    PlannedEffectSchema.parse({ commitmentId: null, requestDigest: EMPTY_DIGEST,
      kind: 'thread', app: 'slack', effectKey: threadKey, payload: {
        channelId: value.slack.channelId, threadTs: value.slack.threadTs,
        body: [{ type: 'text', text: `[PromiseGuard:${threadKey}] Verified follow-up summary for ${value.runId}.` }],
      } }),
  );
  const signedEffects = await Promise.all(effects.map(async effect => PlannedEffectSchema.parse({ ...effect,
    requestDigest: await canonicalDigest(requestHashMaterial(effect, contents)) })));
  const unsigned = ImmutablePlanSchema.parse({ schemaVersion: 2, runId: value.runId, revision: value.revision,
    planHash: EMPTY_DIGEST, createdAt: value.createdAt, incident: value.incident, selection, sources, contents,
    effects: signedEffects });
  const plan = await verifyPlanEffectKeys({ ...unsigned, planHash: await canonicalDigest(planHashMaterial(unsigned)) });
  const receiptWithoutHash = {
    schemaVersion: 2 as const, policyVersion: PLAN_POLICY_VERSION, runId: plan.runId, revision: plan.revision,
    planHash: plan.planHash, incidentFingerprint: value.incidentFingerprint,
    logicalManifestHash: value.logicalManifestHash, sourceDigests: sources.map(source => source.artifact.sha256),
    sourceFactDigests: sourceFacts.map(fact => fact.sourceRef.sha256), roleOutputs: claims.roleOutputs,
    contentBindings: plan.contents.map(content => ({
      contentRef: contentRef(plan.revision, content.contentKey), source: 'approved_plan' as const,
      contentDigest: content.sha256,
    })),
  };
  const receipt = PlanFreezeReceiptSchema.parse({ ...receiptWithoutHash,
    receiptHash: await canonicalDigest(receiptWithoutHash) });
  return immutable({ plan, receipt });
}

export async function verifyPlanFreezeReceipt(receiptInput: unknown, planInput: unknown) {
  const plan = await verifyPlanEffectKeys(planInput);
  const receipt = PlanFreezeReceiptSchema.parse(receiptInput);
  if (receipt.planHash !== plan.planHash || receipt.runId !== plan.runId || receipt.revision !== plan.revision)
    throw new Error('plan_receipt_mismatch');
  if (await canonicalDigest(planFreezeReceiptHashMaterial(receipt)) !== receipt.receiptHash)
    throw new Error('plan_receipt_digest_mismatch');
  if (receipt.sourceDigests.length !== plan.sources.length ||
      receipt.sourceDigests.some((sourceDigest, index) => sourceDigest !== plan.sources[index].artifact.sha256))
    throw new Error('source_binding_mismatch');
  const bindings = new Map(receipt.contentBindings.map(binding =>
    [`${binding.contentRef.planRevision}:${binding.contentRef.contentKey}`, binding]));
  if (bindings.size !== plan.contents.length || plan.contents.some(content =>
    bindings.get(`${plan.revision}:${content.contentKey}`)?.contentDigest !== content.sha256))
    throw new Error('content_binding_mismatch');
  return immutable(receipt);
}

export const EffectIdBindingSchema = z.object({
  effectKey: EffectKeySchema, providerId: IdSchema, bindingReceipt: RestrictedArtifactRefSchema,
}).strict();

function requiredBindings(effect: PlannedEffect): string[] {
  const body = effect.payload.body.filter(part => part.type === 'effect_id').map(part => part.effectKey);
  if (effect.kind === 'note' && typeof effect.payload.taskId !== 'string') body.push(effect.payload.taskId.effectKey);
  if (effect.kind === 'comment') body.push(...effect.payload.taskIds.map(ref => ref.effectKey), ...effect.payload.draftIds.map(ref => ref.effectKey));
  return [...new Set(body)];
}

export async function resolvePlannedEffect(planInput: unknown, effectKeyInput: unknown, bindingsInput: unknown) {
  const plan = await verifyPlanEffectKeys(planInput);
  const effectKey = EffectKeySchema.parse(effectKeyInput);
  const effect = plan.effects.find(candidate => candidate.effectKey === effectKey);
  if (!effect) throw new Error('effect_not_in_plan');
  const bindings = z.array(EffectIdBindingSchema).max(500).parse(bindingsInput);
  if (new Set(bindings.map(binding => binding.effectKey)).size !== bindings.length)
    throw new Error('ambiguous_effect_binding');
  const required = requiredBindings(effect);
  if (bindings.some(binding => !required.includes(binding.effectKey))) throw new Error('undeclared_effect_binding');
  if (required.some(key => !bindings.some(binding => binding.effectKey === key))) throw new Error('missing_effect_binding');
  const providerIds = new Map(bindings.map(binding => [binding.effectKey, binding.providerId]));
  const approvedContents = new Map(plan.contents.map(content => [content.contentKey, content.text]));
  const body = effect.payload.body.map(part => part.type === 'text' ? part.text : part.type === 'approved_content'
    ? approvedContents.get(part.contentKey)! : providerIds.get(part.effectKey)!).join('');
  const payload = effect.kind === 'note' ? { ...effect.payload,
    taskId: typeof effect.payload.taskId === 'string' ? effect.payload.taskId : providerIds.get(effect.payload.taskId.effectKey)!, body }
    : effect.kind === 'comment' ? { ...effect.payload, taskIds: effect.payload.taskIds.map(ref => providerIds.get(ref.effectKey)!),
      draftIds: effect.payload.draftIds.map(ref => providerIds.get(ref.effectKey)!), body }
    : { ...effect.payload, body };
  return immutable({ schemaVersion: 2 as const, effectKey: effect.effectKey, app: effect.app, kind: effect.kind,
    commitmentId: effect.commitmentId, requestDigest: effect.requestDigest, payload,
    bindingReceipts: bindings.map(binding => binding.bindingReceipt) });
}