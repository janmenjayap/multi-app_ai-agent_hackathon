import { AgentInvocationContextSchema, DraftProposalSchema, agentCallResultSchema,
  parseRoleInput, type AgentCallResult, type AgentDependencies, type AgentInvocationContext,
  type DraftInput, type DraftProposal } from '../../../shared/agents.js';
import { immutable } from '../../../shared/domain.js';
import { invokeRole, type RoleRuntimeDependencies } from '../runtime.js';
import { DRAFTER_OUTPUT_SCHEMA_VERSION, DRAFTER_PROMPT_VERSION, buildDrafterMessages } from './prompt.js';
import { validateDrafterInput, validateDraftProposal } from './validate.js';

/** R01 supplies the validated assessment and the complete deterministic selection. */
export async function draftCustomerUpdate(input: DraftInput, context: AgentInvocationContext,
  dependencies: AgentDependencies): Promise<AgentCallResult<DraftProposal>> {
  const parsedContext = AgentInvocationContextSchema.safeParse(context);
  if (!parsedContext.success) throw new Error('invalid_agent_context');
  const ctx = parsedContext.data;
  const failure = (reason: 'input_invalid' | 'input_budget_exceeded' | 'configuration_mismatch') =>
    immutable(agentCallResultSchema(DraftProposalSchema).parse({ schemaVersion: 2,
      status: 'failure', reason, roleInvocationKey: ctx.roleInvocationKey,
      attemptRefs: [], firstOutputRef: null, artifactRefs: [] }));
  if (ctx.role !== 'drafter') return failure('input_invalid');
  if (ctx.promptVersion !== DRAFTER_PROMPT_VERSION || ctx.outputSchemaVersion !== DRAFTER_OUTPUT_SCHEMA_VERSION)
    return failure('configuration_mismatch');
  let projection: DraftInput;
  try { projection = validateDrafterInput(parseRoleInput('drafter', input, ctx)); }
  catch (error) {
    return failure(error instanceof Error && error.message === 'input_budget_exceeded'
      ? 'input_budget_exceeded' : 'input_invalid');
  }
  // A01 persists exact request/output bytes before validation and owns all retries/replay.
  return dependencies.invokeRole(projection, ctx, DraftProposalSchema);
}

/** Bind in R01 once; the role owns its fresh prompt and pre-result validator. */
export function createDrafterDependencies(
  dependencies: Omit<RoleRuntimeDependencies<unknown>, 'messages' | 'validate'>,
): AgentDependencies {
  return {
    async invokeRole(input, context, outputSchema) {
      const projection = validateDrafterInput(parseRoleInput('drafter', input, context));
      return invokeRole(projection, context, outputSchema, {
        ...dependencies,
        messages: await buildDrafterMessages(projection),
        validate: output => { validateDraftProposal(output, projection); },
      });
    },
  };
}
