import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ProtectedCallContextSchema, ProviderAttemptReceiptSchema, type ProtectedCallContext } from '../../shared/adapters.js';
import { canonical, immutable, MutationOutcomeSchema, type ImmutablePlan, type MutationOutcome, type RestrictedArtifactRef } from '../../shared/domain.js';
import type { TransportObserver, TransportResultObservation } from '../adapters/common/transport.js';
import type { EventContext } from '../observability/events.js';
import type { ApprovalResult } from '../policy/approval.js';
import type { ApplicationRepository } from '../storage/repositories.js';
import type { WorkflowNodeContext } from '../workflow/driver.js';
import { executionDigest, verifiedEffectIds, type ApprovedRequest, type BusinessEffect } from './ordering.js';

type Approved = Extract<ApprovalResult, { status: 'approved' }>;
interface PendingClaim {
  node: WorkflowNodeContext; plan: ImmutablePlan; effect: BusinessEffect; approval: Approved;
  context: ProtectedCallContext; request: ApprovedRequest; intent: RestrictedArtifactRef;
  dispatched: boolean;
  result?: TransportResultObservation;
}
const bootId = `execution-${randomUUID()}`;
export function executionStamp(clock: () => number) {
  return { eventId: randomUUID(), at: new Date(clock()).toISOString(), processId: `process-${process.pid}`,
    bootId, monotonicMs: performance.now() };
}
export function executionContext(node: WorkflowNodeContext, context: { spanId: string }): EventContext {
  return { ...node.eventContext, stage: 'execute', spanId: context.spanId,
    parentSpanId: context.spanId === node.eventContext.spanId ? node.eventContext.parentSpanId : node.eventContext.spanId };
}

/** Wire observer into I01 before using these adapters. Claim and actual dispatch share
 * the transport's UTC/monotonic start; a failed hook prevents fetch altogether. */
export function createExecutionClaims(repository: ApplicationRepository, clock: () => number) {
  const pending = new Map<string, PendingClaim>();
  const observer: TransportObserver = {
    onDispatch(observation) {
      const context = ProtectedCallContextSchema.parse(observation.context);
      const claim = pending.get(context.providerAttemptId);
      if (!claim || claim.dispatched || canonical(context) !== canonical(claim.context)) throw new Error('dispatch_intent_missing');
      const { node, plan, effect, approval, request } = claim;
      node.signal.throwIfAborted();
      const now = clock();
      if (Date.parse(observation.startedAt) > now || now >= Date.parse(approval.validUntil) ||
          now >= Date.parse(context.deadlineAt) || Date.parse(observation.startedAt) >= Date.parse(approval.validUntil))
        throw new Error('dispatch_authority_expired');
      const stamp = { ...executionStamp(clock), at: observation.startedAt, monotonicMs: observation.monotonicMs };
      repository.transaction(node.eventContext, writer => {
        const latest = writer.database.connection.prepare('SELECT plan_digest FROM plans WHERE run_id=? ORDER BY plan_revision DESC LIMIT 1').get(plan.runId);
        if (latest?.plan_digest !== plan.planHash || canonical(writer.getPlan(plan.runId, plan.revision)) !== canonical(plan))
          throw new Error('plan_changed');
        const ids = verifiedEffectIds(writer, plan, plan.effects.findIndex(value => value.effectKey === effect.effectKey));
        if (request.bindings.some(binding => ids[binding.effectKey] !== binding.providerId)) throw new Error('effect_binding_changed');
        const rows = writer.database.connection.prepare(`SELECT e.event_json FROM events e
          JOIN event_contexts c ON e.event_id=c.event_id AND e.evaluation_attempt_id=c.evaluation_attempt_id
          WHERE c.run_id=?`).all(plan.runId);
        const events = rows.map(row => JSON.parse(String(row.event_json)));
        const authority = JSON.parse(writer.readArtifact(approval.reference));
        if (authority.kind !== 'approval_authority' || authority.runId !== plan.runId ||
            authority.planRevision !== plan.revision || authority.planHash !== plan.planHash ||
            authority.approvalId !== approval.approvalId || authority.validUntil !== approval.validUntil ||
            authority.expiresAt !== approval.expiresAt || authority.scope?.effectKey !== effect.effectKey ||
            authority.scope?.requestDigest !== effect.requestDigest ||
            !events.some(event => event.kind === 'guard.checked' && event.allowed &&
              event.reason === 'dispatch_approval_validated' && event.planHash === plan.planHash &&
              event.evidenceRefs.some((ref: RestrictedArtifactRef) => canonical(ref) === canonical(approval.reference))))
          throw new Error('dispatch_authority_unproven');
        if (events.some(event => event.kind === 'guard.checked' &&
          event.planHash === plan.planHash && event.reason === 'approval_invalidated')) throw new Error('approval_invalidated');
        writer.appendEvent({ kind: 'guard.checked', allowed: true, reason: 'effect_dispatch_authorized',
          planHash: plan.planHash, evidenceRefs: [approval.reference, claim.intent] }, { ...stamp, eventId: randomUUID() });
      });
      // Both transactions are synchronous: no adapter or task can run between
      // authority validation and the unique durable claim in this process.
      repository.transaction(executionContext(node, context), writer => {
        if (!writer.claimEffect({ effectKey: effect.effectKey, claimId: randomUUID(), context,
          requestRef: claim.intent, startedAt: observation.startedAt })) throw new Error('effect_already_claimed');
        writer.appendEvent({ kind: 'tool.dispatch', app: context.app, operation: context.operation,
          logicalCallId: context.logicalCallId, providerAttemptId: context.providerAttemptId, actor: 'executor',
          effectKey: effect.effectKey, requestDigest: effect.requestDigest, planHash: plan.planHash,
          approvalId: approval.approvalId }, stamp);
      });
      claim.dispatched = true;
      node.signal.throwIfAborted();
      if (clock() >= Date.parse(approval.validUntil) || clock() >= Date.parse(context.deadlineAt))
        throw new Error('dispatch_authority_expired');
    },
    onResult(observation) {
      const claim = pending.get(observation.context.providerAttemptId);
      if (!claim?.dispatched || canonical(claim.context) !== canonical(observation.context)) throw new Error('dispatch_intent_missing');
      const receipt = ProviderAttemptReceiptSchema.parse(observation.receipt);
      if (canonical(receipt.context) !== canonical(claim.context) ||
          receipt.startedAt !== repository.getProviderAttempt(claim.context.providerAttemptId)?.startedAt ||
          Date.parse(receipt.finishedAt) > clock() ||
          canonical(JSON.parse(repository.readArtifact(observation.receiptRef))) !== canonical(receipt))
        throw new Error('provider_receipt_mismatch');
      claim.result = immutable(observation);
      // I01 has already saved the raw receipt; retain its actual transport timing separately.
      repository.transaction(executionContext(claim.node, claim.context), writer => {
        const ref = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: observation });
        writer.appendEvent({ kind: 'guard.checked', allowed: false, reason: 'transport_result_observed',
          planHash: claim.plan.planHash, evidenceRefs: [ref] }, executionStamp(clock));
      });
    },
    onRetry() { throw new Error('mutation_retry_forbidden'); },
  };
  return {
    observer,
    prepare(input: Omit<PendingClaim, 'intent' | 'dispatched' | 'result'>) {
      input.node.signal.throwIfAborted();
      const context = ProtectedCallContextSchema.parse(input.context);
      if (pending.has(context.providerAttemptId) || canonical(input.approval.plan) !== canonical(input.plan)) throw new Error('plan_changed');
      const request = immutable(input.request);
      const intent = repository.transaction(input.node.eventContext, writer => {
        const ref = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: {
          schemaVersion: 2, kind: 'protected_effect_intent', planRevision: input.plan.revision, context,
          exactRequest: request.input, exactRequestDigest: executionDigest(request.input),
          resolved: request.resolved, bindings: request.bindings, approvalRef: input.approval.reference,
        } });
        writer.appendEvent({ kind: 'guard.checked', allowed: false, reason: 'effect_intent_persisted',
          planHash: input.plan.planHash, evidenceRefs: [ref, input.approval.reference] }, executionStamp(clock));
        return ref;
      });
      pending.set(context.providerAttemptId, { ...input, context, request, intent, dispatched: false });
    },
    finish(context: ProtectedCallContext, value: unknown): MutationOutcome {
      const claim = pending.get(context.providerAttemptId);
      if (!claim?.dispatched) throw new Error('provider_dispatch_unproven');
      const outcome = MutationOutcomeSchema.parse(value);
      const existing = repository.getProviderAttempt(context.providerAttemptId);
      if (existing?.receipt) {
        if (canonical(existing.outcome) !== canonical(outcome)) throw new Error('provider_outcome_mismatch');
        return outcome;
      }
      const receipt = ProviderAttemptReceiptSchema.parse(JSON.parse(repository.readArtifact(outcome.receipt)));
      if (canonical(receipt.context) !== canonical(context) || receipt.startedAt !== existing?.startedAt ||
          Date.parse(receipt.finishedAt) > clock() || (outcome.status === 'applied' &&
          (receipt.transportOutcome !== 'response' || receipt.providerOutcome !== 'success')))
        throw new Error('provider_receipt_mismatch');
      repository.transaction(executionContext(claim.node, context), writer => {
        writer.recordProviderOutcome({ providerAttemptId: context.providerAttemptId, receipt, outcome });
        writer.appendEvent({ kind: 'tool.result', app: context.app, operation: context.operation,
          logicalCallId: context.logicalCallId, providerAttemptId: context.providerAttemptId,
          transportOutcome: receipt.transportOutcome, providerOutcome: receipt.providerOutcome === 'success' ? 'success' :
            receipt.providerOutcome === 'unknown' ? 'unknown' : 'error', receiptRef: outcome.receipt,
          latencyMs: Math.max(0, Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt)) }, executionStamp(clock));
      });
      return outcome;
    },
    failed(context: ProtectedCallContext): void {
      const claim = pending.get(context.providerAttemptId);
      if (!claim?.dispatched || repository.getProviderAttempt(context.providerAttemptId)?.receipt) return;
      // An observed transport receipt remains true even if the adapter cannot
      // return an application outcome. Preserve it without inventing a response.
      const result = claim.result;
      repository.transaction(executionContext(claim.node, context), writer => {
        if (result) {
          const reason = result.receipt.errorCode === 'timeout' ? 'timeout' as const :
            result.receipt.errorCode === 'malformed_response' ? 'malformed_response' as const : 'transport_error' as const;
          writer.recordProviderOutcome({ providerAttemptId: context.providerAttemptId, receipt: result.receipt,
            outcome: { status: 'unknown', reason, receipt: result.receiptRef } });
          writer.appendEvent({ kind: 'tool.result', app: context.app, operation: context.operation,
            logicalCallId: context.logicalCallId, providerAttemptId: context.providerAttemptId,
            transportOutcome: result.receipt.transportOutcome, providerOutcome: result.receipt.providerOutcome === 'success' ? 'success' :
              result.receipt.providerOutcome === 'unknown' ? 'unknown' : 'error', receiptRef: result.receiptRef,
            latencyMs: result.latencyMs }, executionStamp(clock));
        }
        const evidence = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: {
          schemaVersion: 2, kind: 'unknown_application_outcome', providerAttemptId: context.providerAttemptId,
          effectKey: claim.effect.effectKey, planHash: claim.plan.planHash, intentRef: claim.intent,
          transportReceiptRef: result?.receiptRef ?? null,
        } });
        writer.appendEvent({ kind: 'fault.recorded', faultId: randomUUID(), evidenceRef: evidence }, executionStamp(clock));
      });
    },
    forget(providerAttemptId: string) { pending.delete(providerAttemptId); },
  };
}
