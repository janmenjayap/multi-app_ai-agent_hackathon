import { COORDINATION_OPERATIONS, READ_OPERATIONS, WRITE_OPERATIONS } from '../../shared/adapters.js';
import { canonical } from '../../shared/domain.js';
import { EventBatchV2Schema, EventV2Schema } from '../../shared/events.js';
import type { EventV2 } from '../../shared/events.js';
import type { LogicalManifest } from '../../shared/evaluation.js';
import type { AttemptFacts, Check, Verdict } from '../../shared/reliability.js';

type Dispatch = Extract<EventV2, { kind: 'tool.dispatch' }>;
type ToolResult = Extract<EventV2, { kind: 'tool.result' }>;
type ToolEnd = Extract<EventV2, { kind: 'tool.result' | 'tool.error' }>;
type ModelStart = Extract<EventV2, { kind: 'model.attempt.started' }>;
type ModelEnd = Extract<EventV2, { kind: 'model.attempt.result' | 'model.attempt.error' }>;
type Status = Extract<EventV2, { kind: 'run.status' }>['status'];

export interface TraceAssessment {
  checks: Check[];
  traceAssessment: Verdict;
  productStatus: Status | null;
  latency: AttemptFacts['latency'];
  tools: AttemptFacts['tools'];
  mutationDispatches: Dispatch[];
  mutationResults: ToolResult[];
  mutationAcks: AttemptFacts['mutationAcks'];
  verifiedEffectKeys: string[];
  unresolvedProviderAttemptIds: string[];
  unresolvedModelAttemptIds: string[];
  critical: { forbiddenOperations: number; approvalBypasses: number };
}

const reads: ReadonlySet<string> = new Set(READ_OPERATIONS);
const writes: ReadonlySet<string> = new Set(WRITE_OPERATIONS);
const coordination: ReadonlySet<string> = new Set(COORDINATION_OPERATIONS);
const roles = ['analyst', 'drafter', 'auditor'] as const;
const readbackOperations: Record<string, readonly string[]> = {
  task: ['hubspot.getTask'], note: ['hubspot.getNote'], draft: ['gmail.getDraft'],
  comment: ['github.getComment'], thread: ['slack.readSummary', 'slack.getMessage'],
};
const effectOperations: Record<string, readonly string[]> = {
  task: ['hubspot.createTask'], note: ['hubspot.createNote'], draft: ['gmail.createDraft'],
  comment: ['github.createComment', 'github.updateComment'], thread: ['slack.postSummary', 'slack.updateSummary'],
};
const succeeded = (result: ToolEnd | undefined): result is ToolResult => result?.kind === 'tool.result' &&
  result.transportOutcome === 'response' && result.providerOutcome === 'success';
const isMutation = (dispatch: Dispatch) => !reads.has(dispatch.operation);
const isReview = (dispatch: Dispatch) => ['slack.postReview', 'slack.updateReview'].includes(dispatch.operation);
const terminal = (status: Status | null) => status !== null && !['queued', 'running', 'awaiting_approval'].includes(status);

/** Pure trace assessment. Provider fields and immutable claims are evaluated separately. */
export function assessTrace(input: { events: EventV2[]; manifest: LogicalManifest; startedAtMs: number; nowMs: number }): TraceAssessment {
  const { manifest, startedAtMs, nowMs } = input;
  const checks: Check[] = [];
  const add = (code: string, status: Check['status'], event?: EventV2) => {
    if (!checks.some(check => check.code === code && check.status === status && check.eventSequence === event?.sequence))
      checks.push({ code, status, ...(event ? { eventSequence: event.sequence } : {}) });
  };
  const events: EventV2[] = [];
  const identities = new Map<string, EventV2>();
  for (const raw of input.events) {
    const parsed = EventV2Schema.safeParse(raw);
    if (!parsed.success) { add('invalid_event_schema', 'failed'); continue; }
    const event = parsed.data, previous = identities.get(event.eventId);
    if (previous) {
      if (canonical(previous) !== canonical(event)) add('event_identity_conflict', 'failed', event);
      continue;
    }
    identities.set(event.eventId, event); events.push(event);
  }
  if (events.length && !EventBatchV2Schema.safeParse({ schemaVersion: 2, runId: events[0].runId,
    evaluationAttemptId: events[0].evaluationAttemptId, events }).success) add('invalid_event_order_or_binding', 'failed');

  const dispatches = new Map<string, Dispatch>(), results = new Map<string, ToolEnd>();
  const modelStarts = new Map<string, ModelStart>(), modelEnds = new Map<string, ModelEnd>();
  const stageStarts = new Set<string>(), stageEnds = new Set<string>();
  const invocations = new Map<string, ModelStart[]>(), validRoles = new Map<string, ModelEnd>();
  const logicalCalls = new Map<string, string>();
  const retries = new Map<string, Extract<EventV2, { kind: 'retry.scheduled' }>>();
  const retryOwners = new Map<string, string>(), retryBudgets = new Map<string, number>();
  const approvals = new Map<string, Extract<EventV2, { kind: 'approval.checked' }>>();
  const firstApprovals = new Map<string, number>(), rejectedPlans = new Set<string>();
  const planHashes = new Map<number, string>();
  const verified = new Map<string, Extract<EventV2, { kind: 'effect.verified' }>>();
  const pendingWrites = new Map<string, Dispatch>(), lastWrites = new Map<string, Dispatch>();
  const lastActions = new Map<string, number>(), applied = new Set<string>();
  const resolvedAttempts = new Set<string>();
  const claims: Array<Extract<EventV2, { kind: 'success.claimed' }>> = [];
  const effectDefinitions = new Map(manifest.effects.map(effect => [String(effect.effectKey), effect]));
  const waits = new Map<string, number>(), intervals: Array<[number, number]> = [];
  let source: Extract<EventV2, { kind: 'sources.collected' }> | undefined;
  let plan: Extract<EventV2, { kind: 'plan.frozen' }> | undefined;
  let guard: Extract<EventV2, { kind: 'guard.checked' }> | undefined;
  let productStatus: Status | null = null, terminalAt: number | null = null, lastMutationSequence = 0;
  const critical = { forbiddenOperations: 0, approvalBypasses: 0 };

  const validRead = (readAttemptId: string, app: string, after: number, operations?: readonly string[], independent = true) => {
    const read = dispatches.get(readAttemptId), result = results.get(readAttemptId);
    return Boolean(read && (independent ? read.actor === 'verifier' : ['verifier', 'reader', 'executor'].includes(read.actor)) && reads.has(read.operation) && read.app === app &&
      read.sequence > after && succeeded(result) && result.sequence > read.sequence &&
      (!operations || operations.includes(read.operation)));
  };
  const roleKey = (revision: number, role: string) => `${revision}:${role}`;
  const allVerified = (includeSlack = true) => manifest.effects.filter(effect => includeSlack || effect.app !== 'slack')
    .every(effect => verified.get(effect.effectKey)?.planHash === plan?.planHash);

  for (const event of events) {
    if (Date.parse(event.at) > nowMs) add('event_in_future', 'failed', event);
    switch (event.kind) {
      case 'stage.started': stageStarts.add(event.spanId); break;
      case 'stage.finished':
        if (!stageStarts.has(event.spanId) || stageEnds.has(event.spanId)) add('orphan_or_duplicate_stage_result', 'failed', event);
        stageEnds.add(event.spanId); break;
      case 'model.attempt.started': {
        if (modelStarts.has(event.modelAttemptId)) { add('duplicate_model_attempt', 'failed', event); break; }
        const previous = invocations.get(event.roleInvocationKey) ?? [];
        const first = previous[0], last = previous.at(-1);
        if (first && (first.logicalCallId !== event.logicalCallId || first.inputDigest !== event.inputDigest ||
          first.configDigest !== event.configDigest || first.promptVersion !== event.promptVersion ||
          first.modelVersion !== event.modelVersion || first.outputSchemaVersion !== event.outputSchemaVersion))
          add('model_invocation_identity_conflict', 'failed', event);
        if (last) {
          const end = modelEnds.get(last.modelAttemptId), retry = retries.get(last.modelAttemptId);
          if (end?.kind === 'model.attempt.result' && end.validation === 'valid') add('completed_role_reinvoked', 'failed', event);
          if (!retry || retry.logicalCallId !== event.logicalCallId) add('model_retry_not_scheduled', 'failed', event);
          if (end?.kind === 'model.attempt.result' && end.validation === 'refused' ||
            end?.kind === 'model.attempt.error' && !['timeout', 'rate_limited', 'transport_error', 'output_invalid'].includes(end.errorCode))
            add('nonretryable_model_failure_retried', 'failed', event);
          // Events bind the configuration digest, but do not contain its tighter role limit.
          add('model_retry_configuration_unavailable', 'unverified', event);
        }
        if (previous.length >= 10) add('model_attempt_limit_exceeded', 'failed', event);
        const roleIndex = roles.indexOf(event.role);
        if (roles.slice(0, roleIndex).some(role => !validRoles.has(roleKey(event.planRevision, role))) ||
          roles.slice(roleIndex + 1).some(role => [...modelStarts.values()].some(start => start.planRevision === event.planRevision && start.role === role)))
          add('model_stage_order_invalid', 'failed', event);
        if (!source?.complete) add('model_sources_incomplete', 'failed', event);
        modelStarts.set(event.modelAttemptId, event); previous.push(event); invocations.set(event.roleInvocationKey, previous);
        break;
      }
      case 'model.attempt.result':
      case 'model.attempt.error':
        if (!modelStarts.has(event.modelAttemptId) || modelEnds.has(event.modelAttemptId)) add('orphan_or_duplicate_model_result', 'failed', event);
        else {
          modelEnds.set(event.modelAttemptId, event);
          if (event.kind === 'model.attempt.result' && event.validation === 'valid') validRoles.set(roleKey(event.planRevision, event.role), event);
        }
        break;
      case 'retry.scheduled': {
        const id = event.target.type === 'model' ? event.target.modelAttemptId : event.target.providerAttemptId;
        const previousBudget = retryBudgets.get(event.logicalCallId), owner = retryOwners.get(event.logicalCallId);
        if (owner && owner !== event.owner) add('multiple_retry_owners', 'failed', event);
        if (event.delayMs >= event.remainingBudgetMs || previousBudget !== undefined && event.remainingBudgetMs > previousBudget)
          add('retry_budget_invalid', 'failed', event);
        if (event.target.type === 'provider' && dispatches.has(id) && isMutation(dispatches.get(id)!)) add('mutation_retry_requires_reconciliation', 'failed', event);
        retries.set(id, event); retryOwners.set(event.logicalCallId, event.owner); retryBudgets.set(event.logicalCallId, event.remainingBudgetMs);
        break;
      }
      case 'sources.collected': source = event; break;
      case 'plan.frozen':
        if (planHashes.has(event.planRevision) && planHashes.get(event.planRevision) !== event.planHash ||
          plan && event.planRevision < plan.planRevision) add('plan_revision_conflict', 'failed', event);
        if (!source?.complete) add('plan_sources_incomplete', 'failed', event);
        for (const role of manifest.requiredRoles) if (!validRoles.has(roleKey(event.planRevision, role))) add('model_stage_order_invalid', 'failed', event);
        if (plan?.planHash !== event.planHash) verified.clear();
        planHashes.set(event.planRevision, event.planHash); plan = event; guard = undefined;
        break;
      case 'approval.checked': {
        const previous = approvals.get(event.approvalId);
        if (previous && (previous.planHash !== event.planHash || previous.planRevision !== event.planRevision)) add('approval_identity_conflict', 'failed', event);
        if (event.decision === 'rejected') rejectedPlans.add(event.planHash);
        if (event.decision === 'approved' && !firstApprovals.has(event.planHash)) firstApprovals.set(event.planHash, event.sequence);
        approvals.set(event.approvalId, event); break;
      }
      case 'guard.checked': guard = event; break;
      case 'tool.dispatch': {
        if (dispatches.has(event.providerAttemptId)) { add('duplicate_provider_attempt', 'failed', event); break; }
        const identity = canonical([event.app, event.operation, event.effectKey, event.requestDigest, event.planHash]);
        if (logicalCalls.has(event.logicalCallId) && logicalCalls.get(event.logicalCallId) !== identity) add('logical_call_identity_conflict', 'failed', event);
        logicalCalls.set(event.logicalCallId, identity); dispatches.set(event.providerAttemptId, event);
        if (!reads.has(event.operation) && !writes.has(event.operation) && !coordination.has(event.operation)) {
          critical.forbiddenOperations++; add('forbidden_operation', 'failed', event);
        }
        if (!isMutation(event)) break;
        if (writes.has(event.operation) && event.actor !== 'executor' || coordination.has(event.operation) && event.actor !== 'coordinator' ||
          ['reader', 'verifier', 'collector'].includes(event.actor)) add('invalid_app_authority', 'failed', event);
        if (pendingWrites.size) add('concurrent_or_unresolved_mutation', 'failed', event);
        if (event.effectKey && pendingWrites.has(event.effectKey)) add('unknown_write_retried', 'failed', event);
        if (!event.effectKey || !event.requestDigest) add('mutation_identity_missing', 'failed', event);
        const effect = event.effectKey ? effectDefinitions.get(event.effectKey) : undefined;
        if (!isReview(event) && (!effect || effect.app !== event.app)) add('undeclared_mutation', 'failed', event);
        if (!isReview(event) && effect && !effectOperations[effect.kind].includes(event.operation)) add('effect_operation_mismatch', 'failed', event);
        if (!isReview(event) && [...lastWrites.values()].some(write => !isReview(write) && applied.has(write.effectKey!) && !verified.has(write.effectKey!)))
          add('next_write_before_verification', 'failed', event);
        if (!isReview(event) && effect) {
          const index = manifest.effects.indexOf(effect);
          if (manifest.effects.slice(0, index).some(prior => !verified.has(prior.effectKey))) add('effect_order_invalid', 'failed', event);
        }
        if (writes.has(event.operation)) {
          const approval = event.approvalId ? approvals.get(event.approvalId) : undefined;
          if (!plan || event.planHash !== plan.planHash || !approval || approval.decision !== 'approved' ||
            approval.planHash !== event.planHash || approval.planRevision !== plan.planRevision || rejectedPlans.has(plan.planHash) ||
            approval.sequence <= lastMutationSequence || !guard?.allowed || guard.planHash !== event.planHash ||
            guard.sequence <= approval.sequence || guard.sequence <= lastMutationSequence || !guard.evidenceRefs.length) {
            critical.approvalBypasses++; add('approval_or_guard_invalid', 'failed', event);
          }
          if (!source?.complete || source.sequence <= (firstApprovals.get(event.planHash ?? '') ?? Infinity) ||
            !guard || source.sequence >= guard.sequence) add('sources_incomplete_or_stale', 'failed', event);
        }
        if (['slack.postSummary', 'slack.updateSummary'].includes(event.operation) && !allVerified(false)) add('summary_before_verification', 'failed', event);
        if (event.effectKey) {
          if (applied.has(event.effectKey) && event.operation.includes('.create')) add('duplicate_applied_creation', 'failed', event);
          pendingWrites.set(event.effectKey, event); lastWrites.set(event.effectKey, event);
          lastActions.set(event.effectKey, event.sequence); verified.delete(event.effectKey);
        }
        lastMutationSequence = event.sequence; break;
      }
      case 'tool.result':
      case 'tool.error': {
        const dispatch = dispatches.get(event.providerAttemptId);
        if (!dispatch || results.has(event.providerAttemptId)) { add('orphan_or_duplicate_result', 'failed', event); break; }
        results.set(event.providerAttemptId, event);
        if (event.kind === 'tool.result' && event.providerOutcome === 'success' && event.transportOutcome !== 'response') add('invalid_transport_success', 'failed', event);
        if (isMutation(dispatch) && dispatch.effectKey) {
          if (succeeded(event)) { applied.add(dispatch.effectKey); lastActions.set(dispatch.effectKey, event.sequence); }
          const known = event.kind === 'tool.error' ? event.outcome === 'not_applied' :
            event.transportOutcome === 'response' && event.providerOutcome !== 'unknown';
          if (known && pendingWrites.get(dispatch.effectKey)?.providerAttemptId === dispatch.providerAttemptId) pendingWrites.delete(dispatch.effectKey);
        }
        break;
      }
      case 'effect.reconciled': {
        const previous = lastWrites.get(event.effectKey), effect = effectDefinitions.get(event.effectKey);
        if (!previous || !validRead(event.readAttemptId, previous.app, previous.sequence, undefined, false)) { add('invalid_reconciliation_read', 'failed', event); break; }
        if (event.resolution === 'adopted' && event.providerId) {
          resolvedAttempts.add(previous.providerAttemptId); pendingWrites.delete(event.effectKey);
          applied.add(event.effectKey); lastActions.set(event.effectKey, event.sequence); verified.delete(event.effectKey);
        } else if (event.resolution === 'not_applied') {
          // An empty lookup cannot, by itself, resolve a previously ambiguous write.
          if (pendingWrites.has(event.effectKey)) add('unknown_nonapplication_not_proven', 'unverified', event);
        } else add('reconciliation_unresolved', event.resolution === 'conflict' ? 'failed' : 'unverified', event);
        if (!effect && !isReview(previous)) add('undeclared_reconciliation', 'failed', event);
        break;
      }
      case 'effect.verified': {
        const effect = effectDefinitions.get(event.effectKey), previous = lastWrites.get(event.effectKey);
        if (!effect || !plan || event.planHash !== plan.planHash || effect.kind !== event.artifactKind ||
          !previous || !applied.has(event.effectKey) || pendingWrites.has(event.effectKey) ||
          !validRead(event.readAttemptId, effect.app, lastActions.get(event.effectKey) ?? previous.sequence, readbackOperations[effect.kind])) {
          verified.delete(event.effectKey); add('verification_readback_missing', 'failed', event); break;
        }
        if (event.verdict === 'matched') verified.set(event.effectKey, event);
        else { verified.delete(event.effectKey); add('verification_not_matched', event.verdict === 'mismatched' ? 'failed' : 'unverified', event); }
        break;
      }
      case 'wait.started':
        if (waits.has(event.waitId)) add('invalid_wait', 'failed', event);
        else waits.set(event.waitId, Date.parse(event.at));
        break;
      case 'wait.ended': {
        const start = waits.get(event.waitId);
        if (start === undefined || Date.parse(event.at) < start) add('invalid_wait', 'failed', event);
        else { intervals.push([start, Date.parse(event.at)]); waits.delete(event.waitId); }
        break;
      }
      case 'success.claimed': claims.push(event); break;
      case 'run.status':
        productStatus = event.status; terminalAt = terminal(event.status) ? Date.parse(event.at) : null;
        if (event.status === 'completed' || event.status === 'completed_no_affected_commitments') {
          const scope = event.status === 'completed' ? 'run' : 'no_affected';
          if (!claims.some(prior => prior.claim.scope === scope && prior.sequence < event.sequence &&
            Date.parse(prior.at) <= Date.parse(event.at) && (prior.claim.scope === 'no_affected' || prior.claim.planHash === plan?.planHash)))
            add('completion_claim_missing', 'failed', event);
        }
        if (event.status === 'completed' && (!plan || !source?.complete || !allVerified() || pendingWrites.size)) add('completion_verification_missing', 'failed', event);
        if (event.status === 'completed_no_affected_commitments') {
          if (!source?.complete) add('no_affected_requires_complete_sources', 'failed', event);
          if (plan || approvals.size || modelStarts.size || [...dispatches.values()].some(isMutation)) add('no_affected_history_conflict', 'failed', event);
        }
        if (['safely_blocked', 'awaiting_approval', 'failed'].includes(event.status) &&
          [...lastWrites.values()].some(write => writes.has(write.operation) && (applied.has(write.effectKey!) || pendingWrites.has(write.effectKey!))))
          add('partial_effects_hidden', 'failed', event);
        break;
    }
  }

  const unresolvedProviderAttemptIds = [...dispatches.values()].filter(dispatch => !resolvedAttempts.has(dispatch.providerAttemptId) &&
    (!results.has(dispatch.providerAttemptId) || isMutation(dispatch) && pendingWrites.get(dispatch.effectKey ?? '')?.providerAttemptId === dispatch.providerAttemptId))
    .map(dispatch => String(dispatch.providerAttemptId));
  const unresolvedModelAttemptIds = [...modelStarts.keys()].filter(id => !modelEnds.has(id));
  if (unresolvedProviderAttemptIds.length) add('provider_call_unresolved', 'unverified');
  if (unresolvedModelAttemptIds.length) add('model_call_unresolved', 'unverified');
  if (terminal(productStatus) && [...stageStarts].some(spanId => !stageEnds.has(spanId))) add('stage_result_missing', 'unverified');
  if (!terminal(productStatus) && productStatus !== 'awaiting_approval') add('terminal_status_missing', 'unverified');
  if (productStatus === 'completed' && manifest.requiredRoles.some(role => !plan || !validRoles.has(roleKey(plan.planRevision, role)))) add('required_role_missing', 'failed');

  const end = Math.max(startedAtMs, Math.min(nowMs, terminalAt ?? nowMs));
  for (const start of waits.values()) intervals.push([start, end]);
  let waitMs = 0, unionEnd = startedAtMs;
  for (const [start, finish] of intervals.map(([start, finish]) => [Math.max(startedAtMs, start), Math.min(end, finish)] as const).sort((a, b) => a[0] - b[0])) {
    if (finish > start) { waitMs += Math.max(0, finish - Math.max(start, unionEnd)); unionEnd = Math.max(unionEnd, finish); }
  }
  const wallMs = end - startedAtMs, activeMs = wallMs - waitMs;
  if (wallMs > manifest.budgets.wallMs || activeMs > manifest.budgets.activeMs || waitMs > manifest.budgets.humanWaitMs) add('deadline_exceeded', 'failed');
  if (!terminal(productStatus) && nowMs - startedAtMs > manifest.budgets.wallMs) add('run_stalled', 'unverified');
  const tools: AttemptFacts['tools'] = { dispatched: 0, succeeded: 0, firstDispatched: 0, firstSucceeded: 0, byApp: {} };
  const firstCalls = new Set<string>(), mutationDispatches: Dispatch[] = [], mutationResults: ToolResult[] = [];
  for (const dispatch of dispatches.values()) {
    const result = results.get(dispatch.providerAttemptId), success = succeeded(result);
    const group = tools.byApp[`${dispatch.app}:${isMutation(dispatch) ? 'write' : 'read'}`] ??=
      { dispatched: 0, succeeded: 0, firstDispatched: 0, firstSucceeded: 0 };
    tools.dispatched++; group.dispatched++;
    if (success) { tools.succeeded++; group.succeeded++; }
    if (!firstCalls.has(dispatch.logicalCallId)) {
      tools.firstDispatched++; group.firstDispatched++;
      if (success) { tools.firstSucceeded++; group.firstSucceeded++; }
      firstCalls.add(dispatch.logicalCallId);
    }
    if (isMutation(dispatch)) { mutationDispatches.push(dispatch); if (success) mutationResults.push(result); }
  }
  if (tools.dispatched > manifest.budgets.maxToolAttempts) add('tool_budget_exceeded', 'failed');
  const traceAssessment: Verdict = checks.some(check => check.status === 'failed') ? 'failed' :
    checks.some(check => check.status === 'unverified') ? 'unverified' : productStatus === 'awaiting_approval' ? 'pending' : 'passed';
  if (!checks.length && traceAssessment === 'passed') add('trace_rules_passed', 'passed');
  return { checks, traceAssessment, productStatus,
    latency: { wallMs, waitMs, activeMs, censored: terminalAt === null || productStatus === 'completed' && traceAssessment !== 'passed' },
    tools, mutationDispatches, mutationResults, mutationAcks: { total: mutationResults.length, verified: 0 },
    verifiedEffectKeys: [...verified.keys()], unresolvedProviderAttemptIds, unresolvedModelAttemptIds, critical };
}
