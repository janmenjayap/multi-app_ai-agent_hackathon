import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { EffectViewSchema } from '../../shared/api.js';
import { CoordinationCallContextSchema, ReadCallContextSchema, type GitHubAdapter, type GmailAdapter,
  type HubSpotAdapter, type SlackAdapter, type ReadCallContext, type TransportBudgetsSchema } from '../../shared/adapters.js';
import { type ImmutablePlan } from '../../shared/domain.js';
import type { TransportObserver } from '../adapters/common/transport.js';
import { executionStamp } from '../execution/claim.js';
import { createGuardedExecutor } from '../execution/executor.js';
import { encodeRestrictedArtifact } from '../observability/redaction.js';
import type { ApprovalService } from '../policy/approval.js';
import type { ApplicationRepository } from '../storage/repositories.js';
import type { ProtectedCommitmentExpectation } from '../verification/assertions.js';
import { createApplicationArtifactClaimPublisher, createApplicationSummaryPersistence,
  finalizeVerifiedRun } from '../verification/finalize.js';
import { createApplicationReadbackRecorder, verifyArtifactReadback, verifyBusinessArtifacts, verifyNoAffected,
  type NoAffectedVerificationInput, type ReadbackContextFactory, type ReadbackReaders,
  type ReadbackContextRequest, type ReadbackVerifierOptions } from '../verification/readback.js';
import { createApprovalNode } from './approval-wait.js';
import type { CompletionProof, WorkflowNode, WorkflowNodeContext, WorkflowNodeResult } from './driver.js';
import { currentApprovalPlan } from './review.js';

export interface ExecutionNodeOptions {
  repository: ApplicationRepository;
  providers: {
    adapters: { github: GitHubAdapter; hubspot: HubSpotAdapter; gmail: GmailAdapter; slack: SlackAdapter };
    readers: ReadbackReaders;
  };
  approval(node: WorkflowNodeContext): ApprovalService;
  budgets: z.infer<typeof TransportBudgetsSchema>;
  withExecutionObserver<T>(observer: TransportObserver, action: () => Promise<T>): Promise<T>;
  protectedCommitments?(node: WorkflowNodeContext): readonly ProtectedCommitmentExpectation[];
  noAffected?(node: WorkflowNodeContext, readback: ReadbackVerifierOptions): Promise<NoAffectedVerificationInput>;
  /** Independent evidence/measurement may remain unverified without changing product truth. */
  assess?(node: WorkflowNodeContext): Promise<void>;
  clock?: () => number;
}

function eventContext(node: WorkflowNodeContext, context: { spanId: string }) {
  return { ...node.eventContext, spanId: context.spanId,
    parentSpanId: context.spanId === node.eventContext.spanId ? node.eventContext.parentSpanId : node.eventContext.spanId };
}

function effectProjection(options: ExecutionNodeOptions, plan: ImmutablePlan) {
  return plan.effects.map(effect => {
    const record = options.repository.getEffect(effect.effectKey);
    if (!record) throw new Error('effect_record_missing');
    const verification = options.repository.database.connection.prepare(
      'SELECT verification_json FROM verifications WHERE run_id=? AND effect_key=? ORDER BY rowid DESC LIMIT 1',
    ).get(plan.runId, effect.effectKey);
    const observed = verification ? JSON.parse(String(verification.verification_json)).event : null;
    return EffectViewSchema.parse({ effectKey: effect.effectKey, app: effect.app, kind: effect.kind,
      state: record.state, outcome: record.outcome?.status ?? 'unattempted',
      result: record.providerId ? 'created' : null, providerId: record.providerId, providerLink: null,
      verifiedAt: record.state === 'verified' ? observed?.at ?? null : null,
      comparison: observed?.verdict ?? (record.state === 'planned' ? 'pending' : 'unverified'),
      readbackRef: record.verificationRef ? { referenceId: record.verificationRef.artifactId,
        label: 'Provider readback', availability: 'unavailable', href: null } : null, comparisons: [],
    });
  });
}

/** B04 owns the durable LangGraph scheduler; these nodes join the fixed control stages. */
export function createExecutionNodes(options: ExecutionNodeOptions): Record<'approval' | 'execute' | 'verify' | 'assess', WorkflowNode> {
  const clock = options.clock ?? Date.now;
  const stamp = () => executionStamp(clock);

  function readback(node: WorkflowNodeContext): ReadbackVerifierOptions {
    const createContext: ReadbackContextFactory = <Operation extends ReadCallContext['operation']>(request: ReadbackContextRequest<Operation>) => {
      node.signal.throwIfAborted();
      const app = request.operation.split('.')[0] as keyof ReadbackReaders;
      const reader = options.providers.readers[app];
      const deadline = Math.min(Date.parse(node.state.deadlineAt), clock() + options.budgets.totalMs);
      if (deadline <= clock()) throw new Error('readback_deadline_expired');
      return ReadCallContextSchema.parse({ schemaVersion: 2, runId: node.state.runId,
        evaluationAttemptId: node.state.evaluationAttemptId, runtimeAttemptId: node.state.runtimeAttemptId,
        spanId: randomUUID(), app, accountRef: reader.scope.accountRef, mode: reader.mode,
        logicalCallId: randomUUID(), providerAttemptId: randomUUID(), operation: request.operation,
        deadlineAt: new Date(deadline).toISOString(), budgets: options.budgets }) as ReadCallContext & { operation: Operation };
    };
    return { readers: options.providers.readers, createContext,
      expectedSlackWorkspaceId: node.state.plan ? options.approval(node).options.policy.workspaceId : undefined,
      protectedCommitments: options.protectedCommitments?.(node),
      recorder: createApplicationReadbackRecorder({ repository: options.repository,
        eventContext: context => eventContext(node, context), stamp }) };
  }

  function proofReady(node: WorkflowNodeContext, proof: CompletionProof, plan?: ImmutablePlan): WorkflowNodeResult {
    const artifact = { artifactId: randomUUID(), mediaType: 'application/json' as const, content: proof };
    const ref = encodeRestrictedArtifact(artifact).ref;
    return { kind: 'advance', nextStage: 'assess', patch: {
      references: { ...node.state.references, completionProof: ref },
      ...(plan ? { effects: effectProjection(options, plan) } : {}),
    }, persist: writer => { writer.putArtifact(artifact); } };
  }

  return {
    approval: node => createApprovalNode(options.approval(node))(node),
    execute: async node => {
      const authority = node.state.references.approvalAuthority;
      if (!authority || !node.state.plan) return { kind: 'stop', status: 'safely_blocked', reason: 'approval_authority_missing' };
      const verification = readback(node);
      const executor = createGuardedExecutor({ repository: options.repository, approval: options.approval(node),
        adapters: options.providers.adapters, readers: options.providers.readers,
        createReadContext: verification.createContext, readEventContext: context => eventContext(node, context),
        verify: (plan, effect, record, ids) => verifyArtifactReadback(plan, effect, record, ids, verification),
        budgets: options.budgets, settling: { maxReads: 2, delayMs: 0 }, clock });
      const result = await options.withExecutionObserver(executor.observer,
        () => executor.execute(node, { planRevision: node.state.plan!.revision, approvalRef: authority }));
      const plan = await currentApprovalPlan(options.repository, node.state.runId);
      const patch = { effects: effectProjection(options, plan) };
      return result.status === 'verified' ? { kind: 'advance', nextStage: 'verify', patch }
        : { kind: 'stop', status: result.status, reason: result.reason, patch };
    },
    verify: async node => {
      const verification = readback(node);
      if (!node.state.plan) {
        if (!options.noAffected) return { kind: 'stop', status: 'failed', reason: 'absence_evidence_unavailable' };
        const input = await options.noAffected(node, verification);
        const result = await verifyNoAffected(input);
        if (result.status !== 'matched') return { kind: 'stop', status: 'failed', reason: 'absence_evidence_unverified' };
        return proofReady(node, result.proof);
      }
      const plan = await currentApprovalPlan(options.repository, node.state.runId);
      const records = plan.effects.map(effect => options.repository.getEffect(effect.effectKey)!);
      if (records.some(record => !record)) return { kind: 'stop', status: 'failed_partial', reason: 'effect_record_missing' };
      const business = await verifyBusinessArtifacts(plan, records, verification);
      if (business.status !== 'matched') return { kind: 'stop', status: 'failed_partial',
        reason: 'business_artifacts_unverified', patch: { effects: effectProjection(options, plan) } };
      const planRef = node.state.references.plan;
      if (!planRef) return { kind: 'stop', status: 'failed_partial', reason: 'plan_artifact_missing' };
      const summary = plan.effects.find(effect => effect.kind === 'thread')!;
      const slack = options.providers.adapters.slack;
      const result = await finalizeVerifiedRun(plan, planRef, business,
        options.repository.getEffect(summary.effectKey)!, {
          coordinator: slack, readback: verification,
          createContext: () => ({ ...CoordinationCallContextSchema.parse({ schemaVersion: 2,
            runId: node.state.runId, evaluationAttemptId: node.state.evaluationAttemptId,
            runtimeAttemptId: node.state.runtimeAttemptId, spanId: randomUUID(), app: 'slack',
            accountRef: slack.scope.accountRef, mode: slack.mode, logicalCallId: randomUUID(),
            providerAttemptId: randomUUID(), operation: 'slack.postSummary',
            deadlineAt: new Date(Math.min(Date.parse(node.state.deadlineAt), clock() + options.budgets.totalMs)).toISOString(),
            budgets: { ...options.budgets, maxAttempts: 1 }, marker: summary.effectKey,
            requestDigest: summary.requestDigest }), operation: 'slack.postSummary' }),
          artifactClaims: createApplicationArtifactClaimPublisher({ repository: options.repository,
            eventContext: () => eventContext(node, node.eventContext), stamp }),
          persistence: createApplicationSummaryPersistence({ repository: options.repository,
            eventContext: context => eventContext(node, context), stamp }),
        });
      if (result.status !== 'completed') return { kind: 'stop', status: 'failed_partial', reason: result.reason,
        patch: { effects: effectProjection(options, plan) } };
      return proofReady(node, result.proof, plan);
    },
    assess: async node => {
      const reference = node.state.references.completionProof;
      if (!reference) return { kind: 'stop', status: 'failed', reason: 'completion_proof_missing' };
      if (options.assess) {
        try { await options.assess(node); }
        catch {
          node.transaction(writer => {
            const evidenceRef = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json',
              content: { schemaVersion: 2, reason: 'independent_assessment_unavailable' } });
            writer.appendEvent({ kind: 'fault.recorded', faultId: randomUUID(), evidenceRef }, stamp());
          });
        }
      }
      node.signal.throwIfAborted();
      return { kind: 'complete', proof: JSON.parse(options.repository.readArtifact(reference)) as CompletionProof };
    },
  };
}
