import { z } from 'zod';
import { AppSchema, DigestSchema, EffectKeySchema, IdSchema, immutable, verifyPlanIntegrity } from '../../shared/domain.js';
import { canonicalDigest } from './canonical.js';
import { bindIncidentIdentity } from './identity.js';

export const EFFECT_KEY_POLICY_VERSION = 'effect-key-v1';
const ActionTypeSchema = z.enum(['task', 'note', 'draft', 'comment', 'thread']);
const APP_ACTIONS = {
  github: ['comment'],
  hubspot: ['task', 'note'],
  slack: ['thread'],
  gmail: ['draft'],
} as const;

export const EffectKeyInputSchema = z.object({
  incidentFingerprint: DigestSchema,
  app: AppSchema,
  stableBusinessTargetId: IdSchema,
  actionType: ActionTypeSchema,
}).strict().superRefine((value, context) => {
  if (!(APP_ACTIONS[value.app] as readonly string[]).includes(value.actionType))
    context.addIssue({ code: 'custom', message: 'effect_action_app_mismatch' });
});
export type EffectKeyInput = z.infer<typeof EffectKeyInputSchema>;

export function effectKeyMaterial(input: EffectKeyInput) {
  const value = EffectKeyInputSchema.parse(input);
  return immutable({ schemaVersion: 2 as const, policyVersion: EFFECT_KEY_POLICY_VERSION, ...value });
}

export async function deriveEffectKey(input: EffectKeyInput) {
  return EffectKeySchema.parse(await canonicalDigest(effectKeyMaterial(input)));
}

export async function verifyPlanEffectKeys(planInput: unknown) {
  const plan = await verifyPlanIntegrity(planInput);
  const incidentFingerprint = bindIncidentIdentity(plan.incident, plan.incident).incidentFingerprint;
  for (const effect of plan.effects) {
    const stableBusinessTargetId = effect.kind === 'comment' ? plan.incident.issueId
      : effect.kind === 'thread' ? incidentFingerprint : effect.commitmentId;
    const expected = await deriveEffectKey({ incidentFingerprint, app: effect.app,
      stableBusinessTargetId, actionType: effect.kind });
    if (effect.effectKey !== expected) throw new Error('effect_key_mismatch');
  }
  return immutable(plan);
}