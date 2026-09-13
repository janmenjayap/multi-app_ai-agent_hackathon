import { z } from 'zod';
import {
  AgentInvocationContextSchema, AuditVerdictSchema, AuditorInputSchema, DraftProposalSchema,
  IncidentAssessmentSchema, SourceFactSchema, agentCallResultSchema, parseAuditVerdict,
  parseDraftProposal, parseIncidentAssessment, roleInvocationKey,
} from '../../shared/agents.js';
import {
  DigestSchema, EffectKeySchema, ModelAttemptIdSchema, RestrictedArtifactRefSchema,
  RevisionSchema, RunIdSchema, SelectionSchema, immutable,
} from '../../shared/domain.js';
import { normalizeApprovedText } from './canonical.js';
import { verifyPlanEffectKeys } from './effect-keys.js';

export const PlanTaskContractSchema = AuditorInputSchema.shape.taskContract;
export const PlanRoleResultsSchema = z.object({
  analyst: agentCallResultSchema(IncidentAssessmentSchema),
  drafter: agentCallResultSchema(DraftProposalSchema),
  auditor: agentCallResultSchema(AuditVerdictSchema),
}).strict();
export const RolePlanProvenanceSchema = z.object({
  role: AgentInvocationContextSchema.shape.role,
  roleInvocationKey: AgentInvocationContextSchema.shape.roleInvocationKey,
  attemptRefs: z.array(ModelAttemptIdSchema).min(1).max(10),
  firstOutputRef: RestrictedArtifactRefSchema,
  outputRef: RestrictedArtifactRefSchema,
  validationRef: RestrictedArtifactRefSchema,
}).strict();
export const PlanClaimValidationInputSchema = z.object({
  schemaVersion: z.literal(2), runId: RunIdSchema, revision: RevisionSchema,
  selection: SelectionSchema, sourceFacts: z.array(SourceFactSchema).min(1).max(500),
  taskContract: PlanTaskContractSchema, roleResults: PlanRoleResultsSchema,
}).strict();
export type PlanClaimValidationInput = z.infer<typeof PlanClaimValidationInputSchema>;

function assertExactSet(actual: readonly string[], expected: readonly string[], code: string): void {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length ||
      new Set(expected).size !== expected.length || actual.some(value => !expected.includes(value))) throw new Error(code);
}

export function validatePlanClaims(input: PlanClaimValidationInput) {
  const value = PlanClaimValidationInputSchema.parse(input);
  const selectedIds = value.selection.selected.map(commitment => commitment.commitmentId);
  assertExactSet(value.taskContract.selectedCommitmentIds, selectedIds, 'task_contract_selected_set_mismatch');
  if (new Set(value.sourceFacts.map(fact => fact.factId)).size !== value.sourceFacts.length)
    throw new Error('duplicate_source_fact');
  const { analyst, drafter, auditor } = value.roleResults;
  if (analyst.status !== 'success') throw new Error('analyst_result_required');
  if (drafter.status !== 'success') throw new Error('drafter_result_required');
  if (auditor.status !== 'success') throw new Error('auditor_result_required');
  for (const [role, result] of [['analyst', analyst], ['drafter', drafter], ['auditor', auditor]] as const) {
    if (result.roleInvocationKey !== roleInvocationKey(value.runId, value.revision, role))
      throw new Error('role_revision_mismatch');
    if (!result.firstOutputRef) throw new Error('first_output_reference_required');
  }
  const assessment = parseIncidentAssessment(analyst.output, value.sourceFacts);
  const proposal = parseDraftProposal(drafter.output, selectedIds, value.sourceFacts.map(fact => fact.factId));
  if (proposal.entries.some(entry => entry.claims.length === 0)) throw new Error('draft_claims_required');
  const forbidden = value.taskContract.forbiddenClaims.map(claim => normalizeApprovedText(claim).toLocaleLowerCase('en-US'));
  if (proposal.entries.some(entry => forbidden.some(claim =>
    normalizeApprovedText(entry.text).toLocaleLowerCase('en-US').includes(claim))))
    throw new Error('forbidden_claim');
  const auditInput = AuditorInputSchema.parse({ schemaVersion: 2, sources: value.sourceFacts, proposal,
    taskContract: value.taskContract });
  const audit = parseAuditVerdict(auditor.output, auditInput);
  if (audit.verdict !== 'pass') throw new Error('audit_not_passed');
  const roleOutputs = ([['analyst', analyst], ['drafter', drafter], ['auditor', auditor]] as const).map(([role, result]) =>
    RolePlanProvenanceSchema.parse({ role, roleInvocationKey: result.roleInvocationKey,
      attemptRefs: result.attemptRefs, firstOutputRef: result.firstOutputRef,
      outputRef: result.outputRef, validationRef: result.validationRef }));
  return immutable({ assessment, proposal, audit, roleOutputs });
}

export const SuccessClaimScopeTemplateSchema = z.object({
  schemaVersion: z.literal(2), scope: z.enum(['artifacts', 'run']), runId: RunIdSchema,
  planRevision: RevisionSchema, planHash: DigestSchema,
  effectKeys: z.array(EffectKeySchema).min(1).max(500), finalSlackEffectKey: EffectKeySchema.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.scope === 'run') !== (value.finalSlackEffectKey !== null))
    context.addIssue({ code: 'custom', message: 'invalid_claim_scope_template' });
});

export async function createSuccessClaimScopeTemplate(planInput: unknown, scope: 'artifacts' | 'run') {
  const plan = await verifyPlanEffectKeys(planInput);
  const thread = plan.effects.find(effect => effect.kind === 'thread');
  const effectKeys = plan.effects.filter(effect => scope === 'run' || effect.kind !== 'thread').map(effect => effect.effectKey);
  return immutable(SuccessClaimScopeTemplateSchema.parse({ schemaVersion: 2, scope, runId: plan.runId,
    planRevision: plan.revision, planHash: plan.planHash, effectKeys,
    finalSlackEffectKey: scope === 'run' ? thread?.effectKey ?? null : null }));
}