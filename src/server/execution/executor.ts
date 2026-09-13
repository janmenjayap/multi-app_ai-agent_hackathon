import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ProtectedCallContextSchema, TransportBudgetsSchema, type GitHubAdapter, type GmailAdapter,
  type HubSpotAdapter, type ProtectedCallContext, type ReadCallContext } from '../../shared/adapters.js';
import { canonical, type ImmutablePlan, type RestrictedArtifactRef } from '../../shared/domain.js';
import type { EventContext } from '../observability/events.js';
import type { ApprovalService } from '../policy/approval.js';
import { currentApprovalPlan } from '../workflow/review.js';
import type { ApplicationRepository } from '../storage/repositories.js';
import type { WorkflowNodeContext } from '../workflow/driver.js';
import type { ResolvedEffectIds } from '../verification/assertions.js';
import type { ArtifactReadback, ReadbackContextFactory, ReadbackReaders, verifyArtifactReadback } from '../verification/readback.js';
import { createExecutionClaims, executionStamp } from './claim.js';
import { orderedBusinessEffects, resolveApprovedRequest, verifiedEffectIds, type ApprovedRequest, type BusinessEffect } from './ordering.js';
import { inspectPlannedEffect, reconcileEffect } from './reconcile.js';

export interface GuardedExecutorOptions {
  repository: ApplicationRepository;
  approval: Pick<ApprovalService, 'withDispatchApproval'>;
  adapters: { hubspot: HubSpotAdapter; gmail: GmailAdapter; github: GitHubAdapter };
  /** Fresh read adapters persist their own B01 provider observations through I01. */
  readers: Pick<ReadbackReaders, 'github' | 'hubspot' | 'gmail'>;
  createReadContext: ReadbackContextFactory;
  readEventContext(context: ReadCallContext): EventContext;
  verify(plan: Parameters<typeof verifyArtifactReadback>[0], effect: Parameters<typeof verifyArtifactReadback>[1],
    record: Parameters<typeof verifyArtifactReadback>[2], effectIds: ResolvedEffectIds): Promise<ArtifactReadback>;
  budgets: z.infer<typeof TransportBudgetsSchema>;
  settling: { maxReads: number; delayMs: number };
  clock?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}
export interface ExecutionResult {
  /** `verified` covers business effects only. B07/R01 still own final Slack/completion. */
  status: 'verified' | 'safely_blocked' | 'failed_partial' | 'failed';
  reason: string;
  effectIds: ResolvedEffectIds;
}

export function createGuardedExecutor(options: GuardedExecutorOptions) {
  const clock = options.clock ?? Date.now;
  const budgets = TransportBudgetsSchema.parse({ ...options.budgets, maxAttempts: 1 });
  const settling = z.object({ maxReads: z.number().int().min(1).max(10), delayMs: z.number().int().min(0).max(30000) }).strict().parse(options.settling);
  const sleep = options.sleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
  const claims = createExecutionClaims(options.repository, clock);
  const activeRuns = new Set<string>();

  function dispatch(request: ApprovedRequest, context: ProtectedCallContext) {
    // Deliberately no generic URL, arbitrary method, Gmail send or model capability.
    switch (request.operation) {
      case 'hubspot.createTask': return options.adapters.hubspot.createTask(request.input, { ...context, operation: request.operation });
      case 'hubspot.createNote': return options.adapters.hubspot.createNote(request.input, { ...context, operation: request.operation });
      case 'gmail.createDraft': return options.adapters.gmail.createDraft(request.input, { ...context, operation: request.operation });
      case 'github.createComment': return options.adapters.github.createComment(request.input, { ...context, operation: request.operation });
    }
  }
  function reconciliationOptions(node: WorkflowNodeContext, plan: ImmutablePlan, effect: BusinessEffect,
    deadline = Math.min(Date.parse(node.state.deadlineAt), clock() + budgets.totalMs)) {
    const createContext: ReadbackContextFactory = request => {
      node.signal.throwIfAborted();
      const remainingMs = deadline - clock();
      if (remainingMs <= 0) throw new Error('reconciliation_budget_exhausted');
      const context = options.createReadContext(request);
      if (context.runId !== node.state.runId || context.runtimeAttemptId !== node.state.runtimeAttemptId ||
          context.evaluationAttemptId !== node.state.evaluationAttemptId) throw new Error('read_context_mismatch');
      return { ...context, deadlineAt: new Date(Math.min(deadline, Date.parse(context.deadlineAt))).toISOString(),
        budgets: { ...context.budgets, totalMs: Math.min(context.budgets.totalMs, remainingMs),
          timeoutMs: Math.min(context.budgets.timeoutMs, remainingMs) } };
    };
    return { repository: options.repository, plan, effect, readers: options.readers,
      createContext, eventContext: options.readEventContext,
      stamp: () => executionStamp(clock) };
  }
  function stop(node: WorkflowNodeContext, plan: ImmutablePlan | null, reason: string, failure = false): ExecutionResult {
    const records = options.repository.database.connection.prepare('SELECT record_json FROM effects WHERE run_id=?').all(node.state.runId);
    const partial = records.some(row => JSON.parse(String(row.record_json)).state !== 'planned');
    const status = partial ? 'failed_partial' : failure ? 'failed' : 'safely_blocked';
    const effectIds: Record<string, string> = {};
    if (plan) for (const effect of plan.effects) {
      const record = options.repository.getEffect(effect.effectKey);
      if (record?.providerId) effectIds[effect.effectKey] = record.providerId;
    }
    // A storage failure may prevent this diagnostic; never reinterpret it as permission.
    try { node.transaction(writer => {
      const ref = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: {
        schemaVersion: 2, kind: 'execution_stop', planRevision: plan?.revision ?? null, planHash: plan?.planHash ?? null,
        status, reason, effects: records.map(row => JSON.parse(String(row.record_json))),
      } });
      writer.appendEvent({ kind: 'fault.recorded', faultId: randomUUID(), evidenceRef: ref }, executionStamp(clock));
    }); } catch { /* Durable inflight claims survive an unavailable diagnostic store. */ }
    return { status, reason, effectIds: Object.freeze(effectIds) };
  }

  async function execute(node: WorkflowNodeContext, input: { planRevision: number; approvalRef: RestrictedArtifactRef }): Promise<ExecutionResult> {
    if (activeRuns.has(node.state.runId)) return stop(node, null, 'execution_already_active');
    activeRuns.add(node.state.runId);
    let plan: ImmutablePlan | null = null;
    try {
      node.signal.throwIfAborted();
      plan = await currentApprovalPlan(options.repository, node.state.runId);
      if (plan.revision !== input.planRevision) return stop(node, plan, 'plan_changed');
      const effects = orderedBusinessEffects(plan);
      for (const app of ['github', 'hubspot', 'gmail'] as const) {
        if (canonical(options.adapters[app].scope) !== canonical(options.readers[app].scope) ||
            options.adapters[app].mode !== options.readers[app].mode) throw new Error('reader_write_scope_mismatch');
        if (app !== 'gmail' && (plan.sources.filter(source => source.app === app).length !== 1 ||
            plan.sources.find(source => source.app === app)?.accountRef !== options.adapters[app].scope.accountRef))
          throw new Error('approved_account_scope_mismatch');
      }
      for (const [index, effect] of effects.entries()) {
        node.signal.throwIfAborted();
        if (clock() >= Date.parse(node.state.deadlineAt)) return stop(node, plan, 'execution_deadline_expired');
        let record = options.repository.getEffect(effect.effectKey);
        if (!record || record.runId !== plan.runId || record.requestDigest !== effect.requestDigest)
          return stop(node, plan, 'effect_plan_conflict');
        if (record.state === 'verified') {
          verifiedEffectIds(options.repository, plan, index + 1);
          continue;
        }
        if (record.state === 'planned') {
          const request = await resolveApprovedRequest(options.repository, plan, effect);
          const absence = await inspectPlannedEffect(reconciliationOptions(node, plan, effect));
          if (absence !== 'absent') return stop(node, plan, absence === 'present' ? 'existing_marker_requires_review' : 'marker_lookup_unavailable');
          let callContext: ProtectedCallContext | null = null;
          try {
            const gate = await options.approval.withDispatchApproval(node, { reference: input.approvalRef, effectKey: effect.effectKey }, approval => {
              const adapter = options.adapters[effect.app];
              if (adapter.scope.app !== effect.app || adapter.mode !== options.repository.getRun(plan!.runId)?.configuration.providerMode ||
                  canonical(approval.plan) !== canonical(plan)) throw new Error('adapter_or_plan_mismatch');
              const context = ProtectedCallContextSchema.parse({ schemaVersion: 2, runId: node.state.runId,
                evaluationAttemptId: node.state.evaluationAttemptId, runtimeAttemptId: node.state.runtimeAttemptId,
                spanId: randomUUID(), app: effect.app, accountRef: adapter.scope.accountRef, mode: adapter.mode,
                logicalCallId: randomUUID(), providerAttemptId: randomUUID(), operation: request.operation,
                deadlineAt: new Date(Math.min(Date.parse(node.state.deadlineAt), clock() + budgets.totalMs)).toISOString(),
                budgets, effectKey: effect.effectKey, requestDigest: effect.requestDigest, planHash: plan!.planHash, approvalRef: approval.approvalId });
              callContext = context;
              claims.prepare({ node, plan: plan!, effect, approval, context, request });
              return dispatch(request, context).then(outcome => claims.finish(context, outcome));
            });
            if (gate.status === 'blocked') return stop(node, plan, gate.reason);
            if (gate.value.status === 'not_applied') return stop(node, plan, 'provider_not_applied', true);
          } catch {
            try { if (callContext) claims.failed(callContext); } catch { /* Preserve the unresolved durable claim. */ }
            // A throw or lost receipt after dispatch is unknown, never permission to create again.
            record = options.repository.getEffect(effect.effectKey);
            if (record?.state === 'planned') return stop(node, plan, 'dispatch_prevented', true);
          } finally {
            if (callContext) claims.forget((callContext as ProtectedCallContext).providerAttemptId);
          }
          record = options.repository.getEffect(effect.effectKey)!;
        }
        if (record.state === 'inflight') {
          if (record.outcome?.status === 'not_applied') return stop(node, plan, 'provider_not_applied', true);
          const deadline = Math.min(Date.parse(node.state.deadlineAt), clock() + budgets.totalMs);
          let settlingRead: ReadCallContext | null = null;
          for (let attempt = 0; attempt < settling.maxReads && clock() < deadline; attempt++) {
            node.signal.throwIfAborted();
            if (attempt > 0) {
              const delayMs = Math.min(settling.delayMs, Math.max(0, deadline - clock()));
              if (settlingRead) {
                const previousRead = settlingRead;
                node.transaction(writer => writer.appendEvent({ kind: 'retry.scheduled', target: { type: 'provider', providerAttemptId: previousRead.providerAttemptId },
                  logicalCallId: previousRead.logicalCallId, owner: 'execution_reconciler', reason: 'outcome_unknown', delayMs,
                  remainingBudgetMs: Math.max(0, deadline - clock()) }, executionStamp(clock)));
              }
              await sleep(delayMs);
              node.signal.throwIfAborted();
              if (clock() >= deadline) break;
            }
            const result = await reconcileEffect(reconciliationOptions(node, plan, effect, deadline));
            record = result.record;
            const observationId = result.observationIds.at(-1);
            const page = observationId ? options.repository.getObservation(observationId)?.receipt.pages.at(-1) : null;
            const observedContext = page ? options.repository.getProviderAttempt(page.providerAttemptId)?.context : null;
            if (observedContext && !('requestDigest' in observedContext)) settlingRead = observedContext;
            if (result.resolution === 'adopted') break;
            if (result.resolution === 'conflict') return stop(node, plan, 'reconciliation_conflict');
          }
          if (record.state !== 'applied') return stop(node, plan, 'effect_outcome_unknown');
        }
        const ids = verifiedEffectIds(options.repository, plan, index);
        const verification = await options.verify(plan, effect, record, ids);
        const persisted = options.repository.getEffect(effect.effectKey);
        if (verification.status !== 'matched' || !verification.verificationId || verification.effectKey !== effect.effectKey ||
            verification.providerId !== record.providerId || !verification.receipt || persisted?.state !== 'verified' ||
            canonical(persisted.verificationRef) !== canonical(verification.receipt)) return stop(node, plan, 'effect_readback_unverified');
        const saved = options.repository.database.connection.prepare('SELECT verification_json FROM verifications WHERE verification_id=?').get(verification.verificationId);
        if (!saved || JSON.parse(String(saved.verification_json)).event.planHash !== plan.planHash)
          return stop(node, plan, 'verification_evidence_missing');
      }
      return { status: 'verified', reason: 'business_effects_verified', effectIds: verifiedEffectIds(options.repository, plan, effects.length) };
    } catch (error) {
      const reason = error instanceof Error && /^[a-z][a-z0-9_]{0,159}$/.test(error.message) ? error.message : 'execution_unavailable';
      return stop(node, plan, reason, true);
    } finally { activeRuns.delete(node.state.runId); }
  }
  return { execute, observer: claims.observer };
}
