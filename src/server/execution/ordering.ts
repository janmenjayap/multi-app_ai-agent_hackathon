import { createHash } from 'node:crypto';
import { CommentWriteSchema, DraftWriteSchema, NoteWriteSchema, TaskWriteSchema } from '../../shared/adapters.js';
import { canonical, ImmutablePlanSchema, type ImmutablePlan, type PlannedEffect } from '../../shared/domain.js';
import { resolvePlannedEffect } from '../policy/plan.js';
import type { ApplicationRepository } from '../storage/repositories.js';
import type { ResolvedEffectIds } from '../verification/assertions.js';

export type BusinessEffect = Exclude<PlannedEffect, { kind: 'thread' }>;
export const executionDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

/** Preserve the approved order; sorting a malformed plan would change its authority. */
export function orderedBusinessEffects(plan: ImmutablePlan): BusinessEffect[] {
  const parsed = ImmutablePlanSchema.parse(plan);
  for (const [index, selected] of parsed.selection.selected.entries()) {
    if (parsed.effects.slice(index * 3, index * 3 + 3).some(effect => effect.commitmentId !== selected.commitmentId))
      throw new Error('invalid_commitment_order');
  }
  return parsed.effects.filter((effect): effect is BusinessEffect => effect.kind !== 'thread');
}

/** Destination values come only from earlier, independently verified ledger bindings. */
export function verifiedEffectIds(repository: ApplicationRepository, plan: ImmutablePlan, before: number): ResolvedEffectIds {
  const ids: Record<string, string> = {};
  for (const effect of plan.effects.slice(0, before)) {
    const record = repository.getEffect(effect.effectKey);
    if (record?.state !== 'verified' || !record.providerId || !record.verificationRef ||
        record.runId !== plan.runId || record.requestDigest !== effect.requestDigest) throw new Error('prior_effect_not_verified');
    repository.readArtifact(record.verificationRef);
    ids[effect.effectKey] = record.providerId;
  }
  return Object.freeze(ids);
}

export async function resolveApprovedRequest(repository: ApplicationRepository, plan: ImmutablePlan, effect: BusinessEffect) {
  const index = plan.effects.findIndex(value => value.effectKey === effect.effectKey);
  if (index < 0 || canonical(plan.effects[index]) !== canonical(effect)) throw new Error('effect_not_approved');
  const ids = verifiedEffectIds(repository, plan, index);
  const keys = new Set(effect.payload.body.filter(part => part.type === 'effect_id').map(part => part.effectKey));
  if (effect.kind === 'note' && typeof effect.payload.taskId !== 'string') keys.add(effect.payload.taskId.effectKey);
  if (effect.kind === 'comment') [...effect.payload.taskIds, ...effect.payload.draftIds].forEach(ref => keys.add(ref.effectKey));
  const bindings = [...keys].map(effectKey => {
    const record = repository.getEffect(effectKey);
    if (!ids[effectKey] || !record?.verificationRef) throw new Error('unresolved_effect_id');
    return { effectKey, providerId: ids[effectKey], bindingReceipt: record.verificationRef };
  });
  const resolved = await resolvePlannedEffect(plan, effect.effectKey, bindings);
  const shared = { resolved, bindings };
  switch (effect.kind) {
    case 'task': return { ...shared, operation: 'hubspot.createTask' as const, input: TaskWriteSchema.parse(resolved.payload) };
    case 'note': return { ...shared, operation: 'hubspot.createNote' as const, input: NoteWriteSchema.parse(resolved.payload) };
    case 'draft': return { ...shared, operation: 'gmail.createDraft' as const, input: DraftWriteSchema.parse(resolved.payload) };
    case 'comment': return { ...shared, operation: 'github.createComment' as const, input: CommentWriteSchema.parse({
      repositoryId: effect.payload.repositoryId, issueId: effect.payload.issueId, body: resolved.payload.body }) };
  }
}
export type ApprovedRequest = Awaited<ReturnType<typeof resolveApprovedRequest>>;
