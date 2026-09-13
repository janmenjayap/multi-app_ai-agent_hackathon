import { AgentInvocationContextSchema, IncidentAssessmentSchema, agentCallResultSchema,
  parseRoleInput, type AgentCallResult, type AgentDependencies, type AgentInvocationContext,
  type AnalystInput, type IncidentAssessment } from '../../../shared/agents.js';
import { immutable } from '../../../shared/domain.js';
import { invokeRole, type RoleRuntimeDependencies } from '../runtime.js';
import { ANALYST_OUTPUT_SCHEMA_VERSION, ANALYST_PROMPT_VERSION, buildAnalystMessages } from './prompt.js';
import { validateIncidentAssessment } from './validate.js';

/** R01 calls only after complete source retrieval and valid, nonempty selection. */
export async function analyzeIncident(input: AnalystInput, context: AgentInvocationContext,
  dependencies: AgentDependencies): Promise<AgentCallResult<IncidentAssessment>> {
  // Match A01's invalid-context behavior: no fabricated invocation identity.
  const parsedContext = AgentInvocationContextSchema.safeParse(context);
  if (!parsedContext.success) throw new Error('invalid_agent_context');
  const ctx = parsedContext.data;
  const failure = (reason: 'input_invalid' | 'input_budget_exceeded' | 'configuration_mismatch') =>
    immutable(agentCallResultSchema(IncidentAssessmentSchema).parse({ schemaVersion: 2,
      status: 'failure', reason, roleInvocationKey: ctx.roleInvocationKey,
      attemptRefs: [], firstOutputRef: null, artifactRefs: [] }));
  if (ctx.role !== 'analyst') return failure('input_invalid');
  if (ctx.promptVersion !== ANALYST_PROMPT_VERSION || ctx.outputSchemaVersion !== ANALYST_OUTPUT_SCHEMA_VERSION)
    return failure('configuration_mismatch');
  let parsedInput: AnalystInput;
  try { parsedInput = parseRoleInput('analyst', input, ctx) as AnalystInput; }
  catch (error) {
    return failure(error instanceof Error && error.message === 'input_budget_exceeded'
      ? 'input_budget_exceeded' : 'input_invalid');
  }
  // A01 owns invocation claims, bounded retries, replay and all immutable refs.
  return dependencies.invokeRole(parsedInput, ctx, IncidentAssessmentSchema);
}

/**
 * Bind once in R01 with its server-owned repository, model and frozen config.
 * The role supplies messages and validation through A01's pre-result seam;
 * callers cannot replace them with another role's history or a weaker check.
 */
export function createAnalystDependencies(
  dependencies: Omit<RoleRuntimeDependencies<unknown>, 'messages' | 'validate'>,
): AgentDependencies {
  return {
    async invokeRole(input, context, outputSchema) {
      const projection = parseRoleInput('analyst', input, context) as AnalystInput;
      return invokeRole(projection, context, outputSchema, {
        ...dependencies,
        messages: await buildAnalystMessages(projection),
        validate: output => { validateIncidentAssessment(output, projection); },
      });
    },
  };
}
