import { AgentInvocationContextSchema, AuditVerdictSchema, agentCallResultSchema,
  parseRoleInput, type AgentCallResult, type AgentDependencies, type AgentInvocationContext,
  type AuditorInput, type AuditVerdict } from '../../../shared/agents.js';
import { immutable } from '../../../shared/domain.js';
import { invokeRole, type RoleRuntimeDependencies } from '../runtime.js';
import { AUDITOR_OUTPUT_SCHEMA_VERSION, AUDITOR_PROMPT_VERSION, buildAuditorMessages } from './prompt.js';
import { validateAuditVerdict } from './validate.js';

/**
 * R01 invokes this after drafting and deterministic proposal checks. It routes
 * block/uncertain to safely_blocked and required-stage failure to failed.
 * A pass only permits plan freeze; this module exposes no approval or app tools.
 */
export async function auditSemantics(input: AuditorInput, context: AgentInvocationContext,
  dependencies: AgentDependencies): Promise<AgentCallResult<AuditVerdict>> {
  const parsedContext = AgentInvocationContextSchema.safeParse(context);
  if (!parsedContext.success) throw new Error('invalid_agent_context');
  const ctx = parsedContext.data;
  const failure = (reason: 'input_invalid' | 'input_budget_exceeded' | 'configuration_mismatch') =>
    immutable(agentCallResultSchema(AuditVerdictSchema).parse({ schemaVersion: 2,
      status: 'failure', reason, roleInvocationKey: ctx.roleInvocationKey,
      attemptRefs: [], firstOutputRef: null, artifactRefs: [] }));
  if (ctx.role !== 'auditor') return failure('input_invalid');
  if (ctx.promptVersion !== AUDITOR_PROMPT_VERSION || ctx.outputSchemaVersion !== AUDITOR_OUTPUT_SCHEMA_VERSION)
    return failure('configuration_mismatch');
  let projection: AuditorInput;
  try { projection = parseRoleInput('auditor', input, ctx) as AuditorInput; }
  catch (error) {
    return failure(error instanceof Error && error.message === 'input_budget_exceeded'
      ? 'input_budget_exceeded' : 'input_invalid');
  }
  return dependencies.invokeRole(projection, ctx, AuditVerdictSchema);
}

/** Bind in R01 with its repository/model/config; A01 owns retries and replay. */
export function createAuditorDependencies(
  dependencies: Omit<RoleRuntimeDependencies<unknown>, 'messages' | 'validate'>,
): AgentDependencies {
  return {
    async invokeRole(input, context, outputSchema) {
      const projection = parseRoleInput('auditor', input, context) as AuditorInput;
      return invokeRole(projection, context, outputSchema, {
        ...dependencies,
        messages: await buildAuditorMessages(projection),
        validate: output => { validateAuditVerdict(output, projection); },
      });
    },
  };
}
