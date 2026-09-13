import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AgentInvocationContextSchema, ModelConfigurationSchema, MAX_SELECTED_COMMITMENTS,
  IncidentAssessmentSchema, DraftProposalSchema, AuditVerdictSchema, agentCallResultSchema,
  parseRoleInput, parseIncidentAssessment, parseDraftProposal, parseAuditVerdict,
  type AgentCallResult, type AgentInvocationContext, type AgentRole, type AnalystInput,
  type DraftInput, type AuditorInput, AgentFailureCodeSchema } from '../../shared/agents.js';
import { canonical, immutable, ModelAttemptIdSchema, type RestrictedArtifactRef } from '../../shared/domain.js';
import { digest } from '../../shared/reliability.js';
import type { EventV2 } from '../../shared/events.js';
import type { OriginalOutput } from '../../shared/evaluation.js';
import type { AppConfig } from '../index.js';
import type { EventContext, EventStamp } from '../observability/events.js';
import { ApplicationRepository, type ApplicationWriter } from '../storage/repositories.js';
import { ModelDispatchError, inspectRawResponse, type ModelClient, type ModelMessage,
  type RawModelResponse, type ModelDispatchResult } from './model.js';

export const AGENT_RUNTIME_VERSION = 'agent-runtime-v1';
type FailureCode = z.infer<typeof AgentFailureCodeSchema>;
type ModelConfiguration = z.infer<typeof ModelConfigurationSchema>;
type RoleInput = AnalystInput | DraftInput | AuditorInput;

/** Operational failures are deliberately outside F02's model-result vocabulary. */
export class AgentPersistenceError extends Error {
  constructor() { super('agent_persistence_failed'); this.name = 'AgentPersistenceError'; }
}
export class RoleInvocationPendingError extends Error {
  constructor() { super('role_invocation_pending'); this.name = 'RoleInvocationPendingError'; }
}
export interface RuntimeClock {
  now(): number;
  monotonicNow(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
export interface RoleRuntimeDependencies<T> {
  repository: ApplicationRepository;
  model: ModelClient;
  configuration: ModelConfiguration;
  messages: readonly ModelMessage[];
  validate?: (output: T) => void;
  clock?: RuntimeClock;
  signal?: AbortSignal;
}
const clock: RuntimeClock = { now: Date.now, monotonicNow: () => performance.now(),
  sleep: async (ms, signal) => { await delay(ms, undefined, { signal }); } };

/** R01 freezes this server-owned configuration once per role/revision. No secrets. */
export function freezeModelConfiguration(config: AppConfig, role: AgentRole): ModelConfiguration {
  const modelId = config.modelMode === 'mock' ? `mock-${config.fixtureId}` : config.model.roles[role];
  if (!modelId || (config.modelMode === 'live' && !config.secrets.geminiApiKey))
    throw new Error('invalid_model_configuration');
  const material = { schemaVersion: 2 as const, mode: config.modelMode, modelId,
    budgets: { timeoutMs: config.model.timeoutMs, roleBudgetMs: config.model.roleBudgetMs,
      maxAttempts: config.model.maxAttempts, maxOutputTokens: config.model.maxOutputTokens,
      maxInputChars: config.model.maxInputChars, maxCommitments: MAX_SELECTED_COMMITMENTS } };
  const configDigest = digest(material);
  return immutable(ModelConfigurationSchema.parse({ ...material, configDigest, modelConfigRef: `model-${configDigest}` }));
}

function allEvents(repository: ApplicationRepository, runId: string): EventV2[] {
  const events: EventV2[] = [];
  for (;;) {
    const page = repository.readEvents({ runId, afterSequence: events.at(-1)?.sequence ?? 0, limit: 1000 });
    events.push(...page);
    if (page.length < 1000) return events;
  }
}
function traceReason(reason: FailureCode): Extract<EventV2, { kind: 'model.attempt.error' }>['errorCode'] {
  if (reason === 'authentication') return 'denied';
  if (reason === 'configuration_mismatch') return 'conflict';
  if (reason === 'unsupported_model') return 'input_invalid';
  return reason;
}

/**
 * A02–A04 supply fresh role messages and optionally a stricter semantic validator.
 * Bind these dependencies in a closure to implement F02 AgentDependencies.invokeRole.
 * B01 has no lease/reclaim seam: an unfinished claimed invocation stays pending.
 */
export async function invokeRole<T>(input: RoleInput, context: AgentInvocationContext,
  outputSchema: z.ZodType<T>, deps: RoleRuntimeDependencies<T>): Promise<AgentCallResult<T>> {
  const parsedContext = AgentInvocationContextSchema.safeParse(context);
  if (!parsedContext.success) throw new Error('invalid_agent_context');
  const ctx = parsedContext.data;
  const repository = deps.repository;
  const activeClock = deps.clock ?? clock;
  const beganAt = activeClock.now(), beganMono = activeClock.monotonicNow();
  // Wall-clock regressions cannot shorten recorded timestamps or renew active budgets.
  let highWater = beganAt;
  const elapsed = () => Math.max(0, activeClock.monotonicNow() - beganMono);
  const now = () => highWater = Math.max(highWater, activeClock.now(), beganAt + elapsed());
  const bootId = `agent-boot-${randomUUID()}`;
  const stamp = (): EventStamp => ({ eventId: randomUUID(), at: new Date(now()).toISOString(),
    monotonicMs: activeClock.monotonicNow(), processId: `process-${process.pid}`, bootId });
  const stage: EventContext = { producerId: 'agent-runtime', producerVersion: AGENT_RUNTIME_VERSION,
    runId: ctx.runId, evaluationAttemptId: ctx.evaluationAttemptId, runtimeAttemptId: ctx.runtimeAttemptId,
    stage: ctx.role, spanId: ctx.parentSpanId, parentSpanId: null, causedBy: [] };
  const transaction = <R>(eventContext: EventContext, action: (writer: ApplicationWriter) => R): R => {
    try { return repository.transaction(eventContext, action); }
    catch (error) {
      if (error instanceof RoleInvocationPendingError) throw error;
      throw new AgentPersistenceError();
    }
  };
  const emptyFailure = (reason: FailureCode) => agentCallResultSchema(outputSchema).parse({ schemaVersion: 2,
    status: 'failure', roleInvocationKey: ctx.roleInvocationKey, reason, firstOutputRef: null,
    attemptRefs: [], artifactRefs: [] });
  let parsedInput: RoleInput;
  let configuration: ModelConfiguration;
  let messages: ModelMessage[];
  let schema: unknown;
  try {
    parsedInput = parseRoleInput(ctx.role, input, ctx);
    // Only the two plain message kinds are exposed, never LangChain client/tool objects.
    messages = z.array(z.object({ role: z.enum(['system', 'user']), content: z.string().min(1) }).strict())
      .min(2).parse(deps.messages);
    if (messages[0].role !== 'system' || messages.slice(1).some(message => message.role !== 'user'))
      return emptyFailure('input_invalid');
    if (canonical(messages).length > ctx.budgets.maxInputChars) return emptyFailure('input_budget_exceeded');
  } catch (error) {
    return emptyFailure(error instanceof Error && error.message === 'input_budget_exceeded' ? 'input_budget_exceeded' : 'input_invalid');
  }
  try {
    configuration = ModelConfigurationSchema.parse(deps.configuration);
    const { configDigest, modelConfigRef, ...material } = configuration;
    if (configDigest !== digest(material) || configuration.mode !== deps.model.mode ||
        repository.getRun(ctx.runId)?.configuration.modelMode !== configuration.mode ||
        configDigest !== ctx.configDigest || modelConfigRef !== ctx.modelConfigRef ||
        canonical(configuration.budgets) !== canonical(ctx.budgets)) return emptyFailure('configuration_mismatch');
    // Zod attaches non-enumerable runtime metadata; persist only its JSON schema.
    schema = JSON.parse(JSON.stringify(z.toJSONSchema(outputSchema)));
    const roleSchema = ctx.role === 'analyst' ? IncidentAssessmentSchema : ctx.role === 'drafter' ? DraftProposalSchema : AuditVerdictSchema;
    if (canonical(schema) !== canonical(z.toJSONSchema(roleSchema))) return emptyFailure('configuration_mismatch');
  } catch { return emptyFailure('configuration_mismatch'); }
  const requestId = `role-input-${digest({ schemaVersion: 2, roleInvocationKey: ctx.roleInvocationKey })}`;
  const request = { schemaVersion: 2, input: parsedInput, messages, schema, configuration,
    promptVersion: ctx.promptVersion, outputSchemaVersion: ctx.outputSchemaVersion,
    snapshotBundleRef: ctx.snapshotBundleRef, runDeadlineAt: ctx.deadlineAt };
  // Validate actual stored source bytes; a fabricated reference is never sent to a model.
  try {
    repository.readArtifact(ctx.snapshotBundleRef);
    for (const source of parsedInput.sources) repository.readArtifact(source.sourceRef);
  } catch { return emptyFailure('input_invalid'); }
  const previous = repository.getRole(ctx.roleInvocationKey);
  if (previous) {
    const frozen = previous.context;
    if (frozen.inputDigest !== ctx.inputDigest || frozen.configDigest !== ctx.configDigest ||
        frozen.promptVersion !== ctx.promptVersion || frozen.outputSchemaVersion !== ctx.outputSchemaVersion ||
        frozen.modelConfigRef !== ctx.modelConfigRef || frozen.evaluationAttemptId !== ctx.evaluationAttemptId ||
        canonical(frozen.budgets) !== canonical(ctx.budgets) ||
        canonical(frozen.snapshotBundleRef) !== canonical(ctx.snapshotBundleRef)) return emptyFailure('configuration_mismatch');
    // Request contents also bind messages/schema and the original run deadline on replay.
    const bytes = Buffer.from(canonical(request));
    const ref = { artifactId: requestId, sha256: digest(request), byteLength: bytes.length, mediaType: 'application/json' as const };
    try { repository.readArtifact(ref); } catch { return emptyFailure('configuration_mismatch'); }
    if (previous.result) return immutable(agentCallResultSchema(outputSchema).parse(previous.result));
    throw new RoleInvocationPendingError();
  }
  const deadlineAt = new Date(Math.min(Date.parse(ctx.deadlineAt), beganAt + ctx.budgets.roleBudgetMs)).toISOString();
  const frozenContext = { ...ctx, deadlineAt };
  const remaining = () => Math.min(Date.parse(deadlineAt) - now(), ctx.budgets.roleBudgetMs - elapsed());
  const claimed = transaction(stage, tx => {
    // Cross-process uniqueness is enforced in B01's BEGIN IMMEDIATE transaction.
    if (!tx.claimRole(frozenContext)) return false;
    // Reattach existing sources through B01's scoped artifact seam. A reference
    // that exists in another run must not enter this role's model context.
    for (const source of parsedInput.sources) {
      const content = tx.readArtifact(source.sourceRef);
      tx.putArtifact({ artifactId: source.sourceRef.artifactId, mediaType: source.sourceRef.mediaType,
        content: source.sourceRef.mediaType === 'application/json' ? JSON.parse(content) : content });
    }
    const existingStage = allEvents(tx, ctx.runId).find(event => event.kind === 'stage.started' && event.spanId === stage.spanId);
    if (!existingStage) tx.appendEvent({ kind: 'stage.started' }, stamp());
    const inputRef = tx.putArtifact({ artifactId: requestId, mediaType: 'application/json', content: request });
    tx.appendEvent({ kind: 'fault.recorded', faultId: `role-input-${randomUUID()}`, evidenceRef: inputRef }, stamp());
    return true;
  });
  if (!claimed) throw new RoleInvocationPendingError();
  const finishFailure = (reason: FailureCode): AgentCallResult<T> => transaction(stage, tx => {
    const role = tx.getRole(ctx.roleInvocationKey)!;
    const outputs = tx.listOutputs(ctx.roleInvocationKey);
    const result = agentCallResultSchema(outputSchema).parse({ schemaVersion: 2, status: 'failure', reason,
      roleInvocationKey: ctx.roleInvocationKey, firstOutputRef: outputs[0]?.rawOutput ?? null,
      attemptRefs: role.attempts.map(attempt => attempt.modelAttemptId), artifactRefs: outputs.map(output => output.rawOutput) });
    tx.saveRoleResult({ roleInvocationKey: ctx.roleInvocationKey, result });
    tx.appendEvent({ kind: 'stage.finished', outcome: 'failed' }, stamp());
    return immutable(result);
  });
  let repair = false;
  for (let index = 0; index < ctx.budgets.maxAttempts; index++) {
    if (deps.signal?.aborted) return finishFailure('cancelled');
    if (remaining() <= 0) return finishFailure('budget_exhausted');
    const attemptMessages = repair ? [...messages, { role: 'user' as const,
      content: 'The previous response did not match the required JSON schema. Return only a complete schema-valid response.' }] : messages;
    if (canonical(attemptMessages).length > ctx.budgets.maxInputChars) return finishFailure('input_budget_exceeded');
    const modelAttemptId = ModelAttemptIdSchema.parse(randomUUID());
    const attemptContext = { ...stage, spanId: index === 0 ? ctx.spanId : randomUUID(), parentSpanId: stage.spanId };
    const modelIdentity = { role: ctx.role, roleInvocationKey: ctx.roleInvocationKey, planRevision: ctx.planRevision,
      logicalCallId: digest({ schemaVersion: 2, roleInvocationKey: ctx.roleInvocationKey }), modelAttemptId };
    const attemptStart = now(), attemptMono = activeClock.monotonicNow();
    transaction(attemptContext, tx => {
      tx.startModelAttempt({ modelAttemptId, roleInvocationKey: ctx.roleInvocationKey, startedAt: new Date(attemptStart).toISOString() });
      tx.appendEvent({ kind: 'model.attempt.started', ...modelIdentity, inputDigest: ctx.inputDigest,
        configDigest: ctx.configDigest, promptVersion: ctx.promptVersion, modelVersion: configuration.modelId,
        outputSchemaVersion: ctx.outputSchemaVersion }, stamp());
      const requestRef = tx.putArtifact({ artifactId: `model-request-${modelAttemptId}`, mediaType: 'application/json',
        content: { schemaVersion: 2, modelAttemptId, messages: attemptMessages, schema,
          modelId: configuration.modelId, maxOutputTokens: ctx.budgets.maxOutputTokens,
          promptVersion: ctx.promptVersion, outputSchemaVersion: ctx.outputSchemaVersion } });
      tx.appendEvent({ kind: 'fault.recorded', faultId: `model-request-${modelAttemptId}`, evidenceRef: requestRef }, stamp());
    });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    deps.signal?.addEventListener('abort', cancel, { once: true });
    const timeoutMs = Math.max(1, Math.floor(Math.min(ctx.budgets.timeoutMs, remaining())));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let capture: RawModelResponse | null = null;
    let transportRef: RestrictedArtifactRef | null = null;
    let storageFailed = false;
    let settled = false;
    let response: ModelDispatchResult | undefined;
    let failure: FailureCode | undefined;
    let retryable = false;
    let retryAfterMs: number | null = null;
    const abort = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new ModelDispatchError(timedOut ? 'timeout' : 'cancelled', false, null)), { once: true });
    });
    try {
      // Storage can wait for another SQLite writer; recheck before touching HTTPS.
      if (deps.signal?.aborted) throw new ModelDispatchError('cancelled');
      if (remaining() <= 0) throw new ModelDispatchError('budget_exhausted');
      const dispatched = deps.model.dispatchStructured({ role: ctx.role, modelAttemptId, messages: attemptMessages,
        outputSchema, schemaName: `${ctx.role}_v2`, resolvedModelId: configuration.modelId,
        maxOutputTokens: ctx.budgets.maxOutputTokens, abortSignal: controller.signal }, async raw => {
        if (settled || controller.signal.aborted) throw new ModelDispatchError('cancelled', false, null);
        if (capture) throw new ModelDispatchError('configuration_mismatch', false, null);
        try {
          transportRef = transaction(attemptContext, tx => {
            // text/plain preserves HTTP bytes, including malformed JSON, without reserialization.
            const bodyRef = tx.putArtifact({ artifactId: `model-http-${modelAttemptId}`, mediaType: 'text/plain', content: raw.body });
            const receiptRef = tx.putArtifact({ artifactId: `model-receipt-${modelAttemptId}`, mediaType: 'application/json',
              content: { schemaVersion: 2, modelAttemptId, bodyRef, status: raw.status, requestId: raw.requestId,
                retryAfterMs: raw.retryAfterMs, mode: configuration.mode, receivedAt: new Date(now()).toISOString() } });
            tx.appendEvent({ kind: 'fault.recorded', faultId: `model-response-${modelAttemptId}`, evidenceRef: receiptRef }, stamp());
            return receiptRef;
          });
          capture = raw;
        } catch { storageFailed = true; throw new AgentPersistenceError(); }
      });
      response = await Promise.race([dispatched, abort]);
      if (!capture) throw new AgentPersistenceError();
    } catch (error) {
      if (storageFailed || error instanceof AgentPersistenceError) throw new AgentPersistenceError();
      if (controller.signal.aborted) failure = timedOut ? 'timeout' : 'cancelled';
      else if (error instanceof ModelDispatchError) {
        failure = error.reason; retryable = error.retryable; retryAfterMs = error.retryAfterMs;
      } else { failure = 'transport_error'; }
    } finally {
      settled = true; clearTimeout(timer); deps.signal?.removeEventListener('abort', cancel);
    }
    if (storageFailed) throw new AgentPersistenceError();
    if (!failure && (remaining() <= 0 || activeClock.monotonicNow() - attemptMono >= timeoutMs)) failure = 'timeout';
    if (!failure && deps.signal?.aborted) failure = 'cancelled';
    const raw = capture ? inspectRawResponse(capture) : null;
    // The transport capture is authoritative even if an injected parser changes its result.
    const rawText = raw?.rawText ?? null;
    const refused = raw?.refused || response?.refused || failure === 'refusal';
    const incomplete = raw?.incomplete || response?.incomplete;
    let output: T | undefined;
    let parseStatus: OriginalOutput['parseStatus'] = refused ? 'refused' : 'malformed';
    let validationStatus: OriginalOutput['validationStatus'] = 'unrun';
    if (refused) { failure = 'refusal'; retryable = false; }
    else if (incomplete) { failure ??= 'output_invalid'; retryable = false; }
    else if (!failure || failure === 'output_invalid') {
      try {
        const value = JSON.parse(rawText ?? '');
        parseStatus = 'valid';
        const validated = outputSchema.safeParse(value);
        if (!validated.success) { failure = 'output_invalid'; retryable = true; validationStatus = 'invalid'; }
        else {
          try {
            if (ctx.role === 'analyst') parseIncidentAssessment(value, parsedInput.sources);
            else if (ctx.role === 'drafter') parseDraftProposal(value, (parsedInput as DraftInput).commitments.map(c => c.commitmentId), parsedInput.sources.map(s => s.factId));
            else parseAuditVerdict(value, parsedInput as AuditorInput);
            deps.validate?.(validated.data);
            output = validated.data; validationStatus = 'valid'; failure = undefined;
          } catch { validationStatus = 'invalid'; failure = 'output_invalid'; retryable = false; }
        }
      } catch { failure = 'output_invalid'; retryable = true; }
    }
    // Mechanical/semantic validators consume the same role and dispatch budget.
    if (deps.signal?.aborted) { failure = 'cancelled'; retryable = false; }
    else if (remaining() <= 0 || activeClock.monotonicNow() - attemptMono >= timeoutMs) {
      failure = 'timeout'; retryable = false;
    }
    const latencyMs = Math.max(0, Math.floor(activeClock.monotonicNow() - attemptMono));
    let outputRef: RestrictedArtifactRef | null = null;
    let validationRef: RestrictedArtifactRef | null = null;
    transaction(attemptContext, tx => {
      if (capture) {
        outputRef = tx.putArtifact({ artifactId: `model-output-${modelAttemptId}`, mediaType: 'text/plain',
          content: rawText ?? (capture as RawModelResponse).body });
        validationRef = tx.putArtifact({ artifactId: `model-validation-${modelAttemptId}`, mediaType: 'application/json',
          content: { schemaVersion: 2, modelAttemptId, transportRef, outputRef, parseStatus, validationStatus,
            reason: failure ?? null, promptVersion: ctx.promptVersion, outputSchemaVersion: ctx.outputSchemaVersion } });
        const history = tx.listOutputs(ctx.roleInvocationKey), previousOutput = history.at(-1);
        const outputId = `output-${modelAttemptId}`;
        tx.recordOutput({ schemaVersion: 2, runId: ctx.runId, evaluationAttemptId: ctx.evaluationAttemptId,
          runtimeAttemptId: ctx.runtimeAttemptId, outputId, firstOutputId: history[0]?.firstOutputId ?? outputId,
          previousOutputId: previousOutput?.outputId ?? null, role: ctx.role, roleInvocationKey: ctx.roleInvocationKey,
          planRevision: ctx.planRevision, modelAttemptId, inputDigest: ctx.inputDigest,
          sourceDigests: parsedInput.sources.map(source => source.sourceRef.sha256), configDigest: ctx.configDigest,
          promptVersion: ctx.promptVersion, modelVersion: configuration.modelId, outputSchemaVersion: ctx.outputSchemaVersion,
          receivedAt: new Date(now()).toISOString(), rawOutput: outputRef, parseStatus, validationStatus,
          correctionReason: previousOutput ? 'bounded_model_retry' : null });
        tx.appendEvent({ kind: 'model.attempt.result', ...modelIdentity, outputRef,
          validation: refused ? 'refused' : validationStatus === 'valid' ? 'valid' : 'invalid', latencyMs, usage: raw?.usage ?? null }, stamp());
      } else {
        tx.appendEvent({ kind: 'model.attempt.error', ...modelIdentity, errorCode: traceReason(failure ?? 'transport_error'), latencyMs }, stamp());
      }
    });
    if (!failure && output !== undefined && outputRef && validationRef) {
      if (deps.signal?.aborted) return finishFailure('cancelled');
      if (remaining() <= 0 || activeClock.monotonicNow() - attemptMono >= timeoutMs) return finishFailure('timeout');
      return transaction(stage, tx => {
        const result = agentCallResultSchema(outputSchema).parse({ schemaVersion: 2, status: 'success', output,
          roleInvocationKey: ctx.roleInvocationKey, outputRef, validationRef,
          firstOutputRef: tx.listOutputs(ctx.roleInvocationKey)[0].rawOutput,
          attemptRefs: tx.getRole(ctx.roleInvocationKey)!.attempts.map(attempt => attempt.modelAttemptId) });
        tx.saveRoleResult({ roleInvocationKey: ctx.roleInvocationKey, result });
        tx.appendEvent({ kind: 'stage.finished', outcome: 'succeeded' }, stamp());
        return immutable(result);
      });
    }
    failure ??= 'output_invalid';
    const canRetry = retryable && ['output_invalid', 'transport_error', 'rate_limited', 'timeout'].includes(failure);
    if (!canRetry) return finishFailure(failure);
    if (index + 1 >= ctx.budgets.maxAttempts) return finishFailure('budget_exhausted');
    const delayMs = Math.max(0, Math.ceil(retryAfterMs ?? Math.min(1000 * 2 ** index, 10000)));
    if (delayMs >= remaining()) return finishFailure('budget_exhausted');
    transaction(attemptContext, tx => {
      tx.appendEvent({ kind: 'retry.scheduled', target: { type: 'model', modelAttemptId },
        logicalCallId: modelIdentity.logicalCallId, owner: 'agent-runtime', reason: traceReason(failure!),
        delayMs, remainingBudgetMs: Math.max(0, Math.floor(remaining())) }, stamp());
    });
    repair = failure === 'output_invalid';
    try { await activeClock.sleep(delayMs, deps.signal ?? new AbortController().signal); }
    catch { return finishFailure('cancelled'); }
  }
  return finishFailure('budget_exhausted');
}
