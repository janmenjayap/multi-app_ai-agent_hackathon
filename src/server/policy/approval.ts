import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ReadCallContextSchema, SlackMessageSchema } from '../../shared/adapters.js';
import { CollectionReceiptSchema, DigestSchema, EffectKeySchema, IdSchema, RestrictedArtifactRefSchema,
  RevisionSchema, RunIdSchema, SlackDecisionSchema, UtcTimestampSchema, canonical, immutable,
  type ImmutablePlan, type RestrictedArtifactRef, type SlackDecision } from '../../shared/domain.js';
import { checkSourceFreshness, type SourceReader } from './freshness.js';
import { type SelectionPolicyContext } from './selection.js';
import { type WorkflowNodeContext } from '../workflow/driver.js';
import { ApprovalPolicySchema, ReviewReceiptSchema, approvalDigest, approvalEvents, approvalStamp,
  createReviewService, currentApprovalPlan, readReviewThread, storeApprovalGuard,
  type ReviewOptions, type ReviewReceipt } from '../workflow/review.js';

const DecisionObservationSchema = z.object({ schemaVersion: z.literal(2), kind: z.literal('slack_decision_observation'),
  message: SlackMessageSchema, messageDigest: DigestSchema, receipt: CollectionReceiptSchema,
  readContext: ReadCallContextSchema,
}).strict();
const DispatchScopeSchema = z.object({ effectKey: EffectKeySchema, requestDigest: DigestSchema }).strict();
const AuthorityReceiptSchema = z.object({ schemaVersion: z.literal(2), kind: z.literal('approval_authority'),
  runId: RunIdSchema, planRevision: RevisionSchema, planHash: DigestSchema, approvalId: IdSchema,
  decisionMessageTs: IdSchema, decisionDigest: DigestSchema, policyDigest: DigestSchema,
  reviewRef: RestrictedArtifactRefSchema, decisionRef: RestrictedArtifactRefSchema,
  sourceEvidenceRef: RestrictedArtifactRefSchema, checkedAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema, validUntil: UtcTimestampSchema, scope: DispatchScopeSchema.nullable(),
}).strict();
export interface ApprovalServiceOptions extends ReviewOptions {
  sourcePolicy: SelectionPolicyContext; readSources: SourceReader;
}
export type ApprovalResult = { status: 'approved'; approvalId: string; reference: RestrictedArtifactRef;
  expiresAt: string; validUntil: string; plan: ImmutablePlan; review: ReviewReceipt }
  | { status: 'waiting'; plan: ImmutablePlan; review: ReviewReceipt; reviewRef: RestrictedArtifactRef }
  | { status: 'blocked'; reason: string; needsRevision: boolean };
/** Exact commands only. Quotes, mentions, prose, and UI flags never grant authority. */
export function parseApprovalCommand(body: string): { decision: 'approved' | 'rejected'; runId: string; hashPrefix: string } | null {
  const match = /^(approve|reject) ([a-zA-Z0-9_.:-]{1,160}) ([a-f0-9]{8,64})$/.exec(body);
  return match ? { decision: match[1] === 'approve' ? 'approved' : 'rejected', runId: match[2], hashPrefix: match[3] } : null;
}
export function resolveApprovalHash(prefix: string, activeHashes: readonly string[]): string | null {
  if (!/^[a-f0-9]{8,64}$/.test(prefix)) return null;
  const matches = [...new Set(activeHashes)].filter(hash => hash.startsWith(prefix));
  return matches.length === 1 ? matches[0] : null;
}
function slackMicros(timestamp: string): bigint | null {
  const match = /^(\d+)\.(\d{1,6})$/.exec(timestamp);
  return match ? BigInt(match[1]) * 1000000n + BigInt(match[2].padEnd(6, '0')) : null;
}
function messageIdentity(message: z.infer<typeof SlackMessageSchema>) {
  const { observedAt: _observedAt, ...identity } = message;
  return canonical(identity);
}
export function createApprovalService(input: ApprovalServiceOptions) {
  const options = { ...input, policy: immutable(ApprovalPolicySchema.parse(input.policy)) };
  const clock = options.clock ?? Date.now, reviewService = createReviewService(options);
  function activeHashes(plan: ImmutablePlan) {
    const rows = options.repository.database.connection.prepare(`SELECT p.plan_json FROM plans p JOIN runs r USING(run_id)
      WHERE p.plan_revision=(SELECT MAX(q.plan_revision) FROM plans q WHERE q.run_id=p.run_id)
      AND r.status IN ('queued','running','awaiting_approval','failed_partial')`).all();
    return [...rows.flatMap(row => {
      const value = JSON.parse(String(row.plan_json));
      // Stored plans have already passed B01 validation. Scope only the configured channel.
      return value.effects.some((effect: ImmutablePlan['effects'][number]) => effect.kind === 'thread' &&
        effect.payload.channelId === options.policy.channelId) ? [String(value.planHash)] : [];
    }), plan.planHash];
  }
  function stop(node: WorkflowNodeContext, plan: ImmutablePlan, reason: string, needsRevision = false): ApprovalResult {
    storeApprovalGuard(node, options, plan, needsRevision ? 'approval_invalidated' : reason, false,
      { schemaVersion: 2, runId: plan.runId, planRevision: plan.revision, planHash: plan.planHash, reason, checkedAt: new Date(clock()).toISOString() });
    return { status: 'blocked', reason, needsRevision };
  }
  function hasInvalidation(plan: ImmutablePlan) {
    return approvalEvents(options.repository, plan.runId).some(event => event.kind === 'guard.checked' &&
      event.planHash === plan.planHash && event.reason === 'approval_invalidated');
  }
  async function check(node: WorkflowNodeContext, effectKey?: string): Promise<ApprovalResult> {
    let plan: ImmutablePlan;
    try { plan = await currentApprovalPlan(options.repository, node.state.runId); }
    catch { return { status: 'blocked', reason: 'plan_invalid', needsRevision: false }; }
    try {
      node.signal.throwIfAborted();
      if (hasInvalidation(plan)) return stop(node, plan, 'approval_invalidated', true);
      const stored = options.repository.listApprovals(plan.runId, plan.revision);
      if (stored.some(decision => decision.decision === 'rejected')) return stop(node, plan, 'plan_rejected');
      const observed = await reviewService.observeReview(node);
      if (observed.status === 'blocked') return stop(node, plan, observed.reason,
        stored.length > 0 && ['review_changed', 'review_missing', 'review_ambiguous'].includes(observed.reason));
      if (observed.plan.planHash !== plan.planHash) return stop(node, plan, 'plan_changed', true);
      const { review, reviewRef } = observed;
      const read = await readReviewThread(node, options, plan);
      // The review must still be exact in the same observation that supplies decisions.
      const currentReview = read.messages.find(message => message.messageTs === review.reviewMessageTs);
      if (!currentReview || messageIdentity(currentReview) !== messageIdentity(review.message)) return stop(node, plan, 'review_changed', true);
      const reviewTs = slackMicros(review.reviewMessageTs);
      if (reviewTs === null) return stop(node, plan, 'review_timestamp_invalid');
      const hashes = activeHashes(plan);
      const candidates = read.messages.flatMap(message => {
        const command = parseApprovalCommand(message.body), ts = slackMicros(message.messageTs);
        if (!command || command.runId !== plan.runId || resolveApprovalHash(command.hashPrefix, hashes) !== plan.planHash ||
            message.isBot || message.subtype !== null || message.editedAt || message.deleted ||
            !options.policy.authorizedActorIds.includes(message.actorId) || ts === null || ts <= reviewTs ||
            ts < BigInt(Date.parse(plan.createdAt)) * 1000n || ts >= BigInt(Date.parse(review.expiresAt)) * 1000n ||
            ts > BigInt(clock()) * 1000n) return [];
        return [{ message, command, ts }];
      }).sort((left, right) => left.ts < right.ts ? -1 : left.ts > right.ts ? 1 : 0);
      const rejection = candidates.find(candidate => candidate.command.decision === 'rejected');
      function persistDecision(candidate: typeof candidates[number], prior?: SlackDecision) {
        const evidence = DecisionObservationSchema.parse({ schemaVersion: 2, kind: 'slack_decision_observation',
          message: candidate.message, messageDigest: approvalDigest(messageIdentity(candidate.message)),
          receipt: read.receipt, readContext: read.context });
        return node.transaction(writer => {
          const decisionRef = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: evidence });
          const decision = prior ?? SlackDecisionSchema.parse({ schemaVersion: 2, approvalId: randomUUID(), runId: plan.runId,
            planRevision: plan.revision, planHash: plan.planHash, transport: 'slack_human_reply', workspaceId: review.workspaceId,
            channelId: review.channelId, threadTs: review.threadTs, reviewMessageTs: review.reviewMessageTs,
            decisionMessageTs: candidate.message.messageTs, actorId: candidate.message.actorId, authorizedActorId: candidate.message.actorId,
            isBot: false, editedAt: null, deleted: false, decision: candidate.command.decision,
            decidedAt: new Date(Number(candidate.ts / 1000n)).toISOString(), expiresAt: review.expiresAt,
            observedAt: read.receipt.finishedAt, reviewRef, decisionRef });
          if (!prior) writer.recordApproval(decision);
          writer.appendEvent({ kind: 'approval.checked', approvalId: decision.approvalId, planRevision: plan.revision,
            planHash: plan.planHash, decision: decision.decision, evidenceRef: decisionRef }, approvalStamp(clock));
          return { decision, decisionRef, evidence };
        });
      }
      if (rejection) {
        persistDecision(rejection);
        return stop(node, plan, 'plan_rejected');
      }
      let candidate = candidates.find(value => value.command.decision === 'approved');
      const prior = stored.find(decision => decision.decision === 'approved');
      if (prior) {
        // Pin the original authentic reply. Deletion/edit/replacement cannot be repaired by
        // importing another approved flag or selecting a later reply for the same revision.
        candidate = candidates.find(value => value.message.messageTs === prior.decisionMessageTs && value.command.decision === 'approved');
        let previous;
        try { previous = DecisionObservationSchema.parse(JSON.parse(options.repository.readArtifact(prior.decisionRef))); }
        catch { return stop(node, plan, 'approval_evidence_invalid', true); }
        if (!candidate || prior.reviewMessageTs !== review.reviewMessageTs || prior.expiresAt !== review.expiresAt ||
            prior.workspaceId !== review.workspaceId || prior.channelId !== review.channelId || prior.threadTs !== review.threadTs ||
            previous.messageDigest !== approvalDigest(messageIdentity(candidate.message))) return stop(node, plan, 'approval_changed', true);
      }
      if (clock() >= Date.parse(review.expiresAt)) return stop(node, plan, 'approval_expired');
      if (!candidate) return { status: 'waiting', plan, review, reviewRef };
      const freshness = await checkSourceFreshness({ repository: options.repository, plan, readSources: options.readSources,
        policy: options.sourcePolicy, clock, maxAgeMs: options.policy.sourceFreshnessMs });
      node.signal.throwIfAborted();
      if (freshness.status !== 'fresh') return stop(node, plan, freshness.reason, freshness.status === 'changed');
      if ((await currentApprovalPlan(options.repository, plan.runId)).planHash !== plan.planHash) return stop(node, plan, 'plan_changed', true);
      if (clock() >= Date.parse(review.expiresAt)) return stop(node, plan, 'approval_expired');
      // Slow source reads cannot stretch the Slack decision observation window.
      const validUntil = new Date(Math.min(Date.parse(review.expiresAt),
        Date.parse(read.receipt.startedAt) + options.policy.slackFreshnessMs,
        Date.parse(freshness.readStartedAt) + options.policy.sourceFreshnessMs)).toISOString();
      if (clock() >= Date.parse(validUntil)) return stop(node, plan, 'observation_expired');
      const effect = effectKey ? plan.effects.find(value => value.effectKey === effectKey) : null;
      if (effectKey && (!effect || options.repository.getEffect(effectKey)?.state !== 'planned')) return stop(node, plan, 'effect_not_dispatchable');
      const saved = persistDecision(candidate, prior);
      const sourceEvidenceRef = storeApprovalGuard(node, options, plan, 'sources_rechecked', false, freshness);
      const authority = AuthorityReceiptSchema.parse({ schemaVersion: 2, kind: 'approval_authority', runId: plan.runId,
        planRevision: plan.revision, planHash: plan.planHash, approvalId: saved.decision.approvalId,
        decisionMessageTs: candidate.message.messageTs, decisionDigest: saved.evidence.messageDigest,
        policyDigest: approvalDigest(canonical(options.policy)), reviewRef, decisionRef: saved.decisionRef, sourceEvidenceRef,
        checkedAt: new Date(clock()).toISOString(), expiresAt: review.expiresAt, validUntil,
        scope: effect ? { effectKey: effect.effectKey, requestDigest: effect.requestDigest } : null });
      const reference = storeApprovalGuard(node, options, plan, effect ? 'dispatch_approval_validated' : 'approval_validated', true, authority);
      return immutable({ status: 'approved' as const, approvalId: saved.decision.approvalId, reference, expiresAt: review.expiresAt, validUntil, plan, review });
    } catch {
      return stop(node, plan, 'approval_unavailable');
    }
  }
  async function revalidateForDispatch(node: WorkflowNodeContext, input: { reference: RestrictedArtifactRef; effectKey: string }): Promise<ApprovalResult> {
    try {
      const reference = RestrictedArtifactRefSchema.parse(input.reference);
      const receipt = AuthorityReceiptSchema.parse(JSON.parse(options.repository.readArtifact(reference)));
      if (receipt.runId !== node.state.runId || receipt.policyDigest !== approvalDigest(canonical(options.policy)) ||
          (receipt.scope && receipt.scope.effectKey !== input.effectKey)) throw new Error();
      const issued = approvalEvents(options.repository, node.state.runId).some(event => event.kind === 'guard.checked' && event.allowed &&
        ['approval_validated', 'dispatch_approval_validated'].includes(event.reason) && event.planHash === receipt.planHash &&
        event.evidenceRefs.some(ref => canonical(ref) === canonical(reference)));
      if (!issued || (await currentApprovalPlan(options.repository, node.state.runId)).planHash !== receipt.planHash) throw new Error();
      const result = await check(node, input.effectKey);
      if (result.status === 'approved' && result.approvalId !== receipt.approvalId) return { status: 'blocked', reason: 'approval_changed', needsRevision: true };
      return result;
    } catch { return { status: 'blocked', reason: 'approval_reference_invalid', needsRevision: false }; }
  }
  return { options, publishReview: reviewService.publishReview, checkApproval: (node: WorkflowNodeContext) => check(node), revalidateForDispatch,
    /** B06 calls this immediately around each guarded claim/dispatch. No await occurs
     * between the last clock/effect/plan check and invoking its callback. */
    async withDispatchApproval<T>(node: WorkflowNodeContext, input: { reference: RestrictedArtifactRef; effectKey: string },
      dispatch: (approval: Extract<ApprovalResult, { status: 'approved' }>) => T | Promise<T>) {
      const result = await revalidateForDispatch(node, input);
      if (result.status !== 'approved') return { status: 'blocked' as const, reason: result.status === 'blocked' ? result.reason : 'approval_missing' };
      node.signal.throwIfAborted();
      const latest = options.repository.database.connection.prepare(
        'SELECT plan_revision,plan_digest FROM plans WHERE run_id=? ORDER BY plan_revision DESC LIMIT 1').get(result.plan.runId);
      const effect = options.repository.getEffect(input.effectKey);
      const planned = result.plan.effects.find(value => value.effectKey === input.effectKey);
      if (latest?.plan_digest !== result.plan.planHash || latest.plan_revision !== result.plan.revision ||
          !planned || effect?.requestDigest !== planned.requestDigest ||
          clock() >= Date.parse(result.validUntil) || effect.state !== 'planned' ||
          hasInvalidation(result.plan) || options.repository.listApprovals(result.plan.runId, result.plan.revision).some(value => value.decision === 'rejected'))
        return { status: 'blocked' as const, reason: 'dispatch_authority_expired' };
      return { status: 'dispatched' as const, value: await dispatch(result) };
    },
  };
}
export type ApprovalService = ReturnType<typeof createApprovalService>;
