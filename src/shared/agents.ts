import { z } from 'zod';
import { digest } from './reliability.js';
import { CountSchema, DigestSchema, EvaluationAttemptIdSchema, IdSchema, ModelAttemptIdSchema,
  ModelModeSchema, RestrictedArtifactRefSchema, RevisionSchema, RoleSchema, RunIdSchema,
  RuntimeAttemptIdSchema, UtcTimestampSchema, canonical, immutable } from './domain.js';

export { RoleSchema as AgentRoleSchema } from './domain.js';
export const MAX_SELECTED_COMMITMENTS = 100;
export const ModelBudgetsSchema = z.object({
  timeoutMs: CountSchema.positive().max(300000), roleBudgetMs: CountSchema.positive().max(900000),
  maxAttempts: CountSchema.positive().max(10), maxOutputTokens: CountSchema.positive().max(100000),
  maxInputChars: CountSchema.positive().max(1000000), maxCommitments: CountSchema.positive().max(MAX_SELECTED_COMMITMENTS),
}).strict().refine(v => v.timeoutMs <= v.roleBudgetMs, 'timeout_exceeds_role_budget');
export const ModelConfigurationSchema = z.object({
  schemaVersion: z.literal(2), modelConfigRef: IdSchema, configDigest: DigestSchema,
  mode: ModelModeSchema, modelId: IdSchema, budgets: ModelBudgetsSchema,
}).strict();
export function roleInvocationKey(runId: string, planRevision: number, role: AgentRole): string {
  return canonical([RunIdSchema.parse(runId), RevisionSchema.parse(planRevision), RoleSchema.parse(role)]);
}
export const RoleInvocationKeySchema = z.string().min(1).max(220);
export const AgentInvocationContextSchema = z.object({
  schemaVersion: z.literal(2), runId: RunIdSchema, evaluationAttemptId: EvaluationAttemptIdSchema,
  runtimeAttemptId: RuntimeAttemptIdSchema, planRevision: RevisionSchema, role: RoleSchema,
  roleInvocationKey: RoleInvocationKeySchema, snapshotBundleRef: RestrictedArtifactRefSchema,
  inputDigest: DigestSchema, promptVersion: IdSchema, outputSchemaVersion: IdSchema,
  modelConfigRef: IdSchema, configDigest: DigestSchema, budgets: ModelBudgetsSchema,
  spanId: IdSchema, parentSpanId: IdSchema, deadlineAt: UtcTimestampSchema,
}).strict().refine(v => v.roleInvocationKey === roleInvocationKey(v.runId, v.planRevision, v.role), 'invalid_role_invocation_key');

export const SourceFactSchema = z.object({
  factId: IdSchema, sourceRef: RestrictedArtifactRefSchema, sourceField: IdSchema,
  text: z.string().min(1).max(10000),
}).strict();
export const CitedClaimSchema = z.object({
  claimId: IdSchema, text: z.string().min(1).max(10000), sourceFactIds: z.array(IdSchema).min(1).max(100),
}).strict();
export const IncidentAssessmentSchema = z.object({
  schemaVersion: z.literal(2), facts: z.array(CitedClaimSchema).max(100),
  contradictions: z.array(z.object({ factIds: z.array(IdSchema).min(2).max(100), reason: z.string().min(1).max(4000) }).strict()).max(100),
  unknowns: z.array(z.string().min(1).max(4000)).max(100),
  candidateChange: z.object({ status: z.enum(['supported', 'unsupported', 'uncertain']),
    sourceFactIds: z.array(IdSchema).max(100), reason: z.string().min(1).max(4000) }).strict(),
}).strict().refine(v => new Set(v.facts.map(f => f.claimId)).size === v.facts.length, 'duplicate_claim_id');
export const DraftEntrySchema = z.object({
  commitmentId: IdSchema, text: z.string().min(1).max(20000), claims: z.array(CitedClaimSchema).max(100),
}).strict();
export const DraftProposalSchema = z.object({
  schemaVersion: z.literal(2), entries: z.array(DraftEntrySchema).min(1).max(MAX_SELECTED_COMMITMENTS),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.entries.map(e => e.commitmentId)).size !== v.entries.length)
    ctx.addIssue({ code: 'custom', message: 'duplicate_commitment' });
  const ids = v.entries.flatMap(e => e.claims.map(c => c.claimId));
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate_claim_id' });
});
export const AuditVerdictSchema = z.object({
  schemaVersion: z.literal(2), verdict: z.enum(['pass', 'block', 'uncertain']),
  entries: z.array(z.object({ commitmentId: IdSchema,
    findings: z.array(z.object({ claimId: IdSchema, verdict: z.enum(['supported', 'unsupported', 'uncertain']),
      sourceFactIds: z.array(IdSchema).max(100), reason: z.string().min(1).max(4000) }).strict()).max(100),
    requiredFactFindings: z.array(z.object({ factId: IdSchema, verdict: z.enum(['present', 'missing', 'uncertain']),
      reason: z.string().min(1).max(4000) }).strict()).max(500),
  }).strict()).min(1).max(MAX_SELECTED_COMMITMENTS),
}).strict();
const sources = z.array(SourceFactSchema).min(1).max(500);
export const AnalystInputSchema = z.object({ schemaVersion: z.literal(2), sources }).strict();
export const DraftInputSchema = z.object({
  schemaVersion: z.literal(2), sources, assessment: IncidentAssessmentSchema,
  commitments: z.array(z.object({ commitmentId: IdSchema, customerContext: z.string().max(4000),
    promise: z.string().min(1).max(4000) }).strict()).min(1).max(MAX_SELECTED_COMMITMENTS),
}).strict().refine(v => new Set(v.commitments.map(c => c.commitmentId)).size === v.commitments.length, 'duplicate_commitment');
// No analyst rationale, confidence, history, recipient/owner authority or desired verdict.
export const AuditorInputSchema = z.object({
  schemaVersion: z.literal(2), sources, proposal: DraftProposalSchema,
  taskContract: z.object({ selectedCommitmentIds: z.array(IdSchema).min(1).max(MAX_SELECTED_COMMITMENTS),
    requiredFacts: z.array(IdSchema).max(500), forbiddenClaims: z.array(z.string().min(1).max(4000)).max(100),
  }).strict(),
}).strict().superRefine((v, ctx) => {
  try { parseDraftProposal(v.proposal, v.taskContract.selectedCommitmentIds); }
  catch { ctx.addIssue({ code: 'custom', message: 'audit_requires_exact_selected_set' }); }
});
function assertExactSet(actual: string[], expected: readonly string[], code: string): void {
  if (!expected.length || new Set(expected).size !== expected.length || actual.length !== expected.length ||
      new Set(actual).size !== actual.length || actual.some(id => !expected.includes(id))) throw new Error(code);
}
export function parseDraftProposal(value: unknown, selectedCommitmentIds: readonly string[], sourceFactIds?: readonly string[]): DraftProposal {
  const parsed = DraftProposalSchema.parse(value);
  assertExactSet(parsed.entries.map(e => e.commitmentId), selectedCommitmentIds, 'draft_selected_set_mismatch');
  if (sourceFactIds && parsed.entries.some(e => e.claims.some(c => c.sourceFactIds.some(id => !sourceFactIds.includes(id))))) throw new Error('unknown_source_citation');
  return immutable(parsed);
}
export function parseIncidentAssessment(value: unknown, sources: readonly z.infer<typeof SourceFactSchema>[]): IncidentAssessment {
  const parsed = IncidentAssessmentSchema.parse(value);
  const ids = sources.map(s => s.factId);
  const refs = [...parsed.facts.flatMap(c => c.sourceFactIds), ...parsed.contradictions.flatMap(c => c.factIds), ...parsed.candidateChange.sourceFactIds];
  if (refs.some(id => !ids.includes(id))) throw new Error('unknown_source_citation');
  return immutable(parsed);
}
export function parseAuditVerdict(value: unknown, input: AuditorInput): AuditVerdict {
  const parsedInput = AuditorInputSchema.parse(input);
  const result = AuditVerdictSchema.parse(value);
  assertExactSet(result.entries.map(e => e.commitmentId), parsedInput.taskContract.selectedCommitmentIds, 'audit_selected_set_mismatch');
  for (const entry of result.entries) {
    const proposal = parsedInput.proposal.entries.find(e => e.commitmentId === entry.commitmentId)!;
    const claims = proposal.claims.map(c => c.claimId);
    if (entry.findings.length !== claims.length || new Set(entry.findings.map(f => f.claimId)).size !== claims.length ||
        entry.findings.some(f => !claims.includes(f.claimId) || f.sourceFactIds.some(id => !parsedInput.sources.some(s => s.factId === id))))
      throw new Error('audit_claim_coverage_mismatch');
    const required = parsedInput.taskContract.requiredFacts;
    if (entry.requiredFactFindings.length !== required.length || new Set(entry.requiredFactFindings.map(f => f.factId)).size !== required.length ||
        entry.requiredFactFindings.some(f => !required.includes(f.factId))) throw new Error('audit_required_fact_coverage_mismatch');
  }
  if (result.verdict === 'pass' && result.entries.some(e => e.findings.some(f => f.verdict !== 'supported') || e.requiredFactFindings.some(f => f.verdict !== 'present')))
    throw new Error('audit_verdict_conflict');
  return immutable(result);
}
export function parseRoleInput(role: AgentRole, value: unknown, context: AgentInvocationContext): AnalystInput | DraftInput | AuditorInput {
  const ctx = AgentInvocationContextSchema.parse(context);
  if (ctx.role !== role) throw new Error('role_context_mismatch');
  const input = role === 'analyst' ? AnalystInputSchema.parse(value) : role === 'drafter' ? DraftInputSchema.parse(value) : AuditorInputSchema.parse(value);
  if (digest(input) !== ctx.inputDigest) throw new Error('input_digest_mismatch');
  if (canonical(input).length > ctx.budgets.maxInputChars || (role === 'drafter' && (input as DraftInput).commitments.length > ctx.budgets.maxCommitments) ||
      (role === 'auditor' && (input as AuditorInput).proposal.entries.length > ctx.budgets.maxCommitments)) throw new Error('input_budget_exceeded');
  const ids = input.sources.map(s => s.factId);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate_source_fact');
  if (role === 'drafter') parseIncidentAssessment((input as DraftInput).assessment, input.sources);
  if (role === 'auditor') {
    const audit = input as AuditorInput;
    parseDraftProposal(audit.proposal, audit.taskContract.selectedCommitmentIds, ids);
    if (new Set(audit.taskContract.requiredFacts).size !== audit.taskContract.requiredFacts.length || audit.taskContract.requiredFacts.some(id => !ids.includes(id))) throw new Error('unknown_required_fact');
  }
  return immutable(input);
}
export const AgentFailureCodeSchema = z.enum(['input_invalid', 'input_budget_exceeded', 'configuration_mismatch',
  'authentication', 'unsupported_model', 'refusal', 'timeout', 'cancelled', 'rate_limited',
  'transport_error', 'output_invalid', 'budget_exhausted']);
export function agentCallResultSchema<T extends z.ZodType>(output: T) {
  const common = { schemaVersion: z.literal(2), roleInvocationKey: RoleInvocationKeySchema,
    attemptRefs: z.array(ModelAttemptIdSchema).max(10), firstOutputRef: RestrictedArtifactRefSchema.nullable() };
  return z.discriminatedUnion('status', [
    z.object({ ...common, status: z.literal('success'), output, outputRef: RestrictedArtifactRefSchema,
      validationRef: RestrictedArtifactRefSchema }).strict(),
    z.object({ ...common, status: z.literal('failure'), reason: AgentFailureCodeSchema,
      artifactRefs: z.array(RestrictedArtifactRefSchema).max(10) }).strict(),
  ]).superRefine((v, ctx) => {
    if (new Set(v.attemptRefs).size !== v.attemptRefs.length || (v.status === 'success' && (!v.firstOutputRef || !v.attemptRefs.length)))
      ctx.addIssue({ code: 'custom', message: 'invalid_model_attempt_references' });
  });
}
export type AgentRole = z.infer<typeof RoleSchema>;
export type AgentInvocationContext = z.infer<typeof AgentInvocationContextSchema>;
export type AnalystInput = z.infer<typeof AnalystInputSchema>;
export type DraftInput = z.infer<typeof DraftInputSchema>;
export type AuditorInput = z.infer<typeof AuditorInputSchema>;
export type IncidentAssessment = z.infer<typeof IncidentAssessmentSchema>;
export type DraftProposal = z.infer<typeof DraftProposalSchema>;
export type AuditVerdict = z.infer<typeof AuditVerdictSchema>;
export type AgentCallResult<T> = z.infer<ReturnType<typeof agentCallResultSchema<z.ZodType<T>>>>;
/** Runtime implementation belongs to A01; this dependency has no provider capabilities. */
export interface AgentDependencies {
  invokeRole<T>(input: AnalystInput | DraftInput | AuditorInput, context: AgentInvocationContext,
    outputSchema: z.ZodType<T>): Promise<AgentCallResult<T>>;
}
export interface AgentFunctions {
  analyzeIncident(input: AnalystInput, context: AgentInvocationContext, dependencies: AgentDependencies): Promise<AgentCallResult<IncidentAssessment>>;
  draftCustomerUpdate(input: DraftInput, context: AgentInvocationContext, dependencies: AgentDependencies): Promise<AgentCallResult<DraftProposal>>;
  auditSemantics(input: AuditorInput, context: AgentInvocationContext, dependencies: AgentDependencies): Promise<AgentCallResult<AuditVerdict>>;
}
