import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { ReadCallContextSchema, CoordinationCallContextSchema, SlackMessageSchema, SlackWriteSchema,
  TransportBudgetsSchema, type SlackAdapter, type ReadCallContext } from '../../shared/adapters.js';
import { CollectionReceiptSchema, IdSchema, RunIdSchema, RevisionSchema, DigestSchema, UtcTimestampSchema,
  RestrictedArtifactRefSchema, canonical, immutable, readResultSchema, type ImmutablePlan,
  type RestrictedArtifactRef } from '../../shared/domain.js';
import { verifyPlanEffectKeys } from '../policy/effect-keys.js';
import { verifyObservedCollection } from '../policy/freshness.js';
import { type ApplicationRepository } from '../storage/repositories.js';
import { type WorkflowNodeContext } from './driver.js';

export const ApprovalPolicySchema = z.object({ schemaVersion: z.literal(2), workspaceId: IdSchema,
  channelId: IdSchema, reviewActorId: IdSchema, authorizedActorIds: z.array(IdSchema).min(1).max(100)
    .refine(ids => new Set(ids).size === ids.length, 'duplicate_approver'),
  ttlMs: z.number().int().positive().max(86400000), sourceFreshnessMs: z.number().int().positive().max(300000),
  slackFreshnessMs: z.number().int().positive().max(300000), pollMs: z.number().int().positive().max(60000),
  budgets: TransportBudgetsSchema,
}).strict();
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export interface ReviewOptions {
  repository: ApplicationRepository; slack: SlackAdapter; policy: ApprovalPolicy; clock?: () => number;
}
export const ReviewReceiptSchema = z.object({ schemaVersion: z.literal(2), kind: z.literal('slack_review'),
  runId: RunIdSchema, planRevision: RevisionSchema, planHash: DigestSchema, policyDigest: DigestSchema,
  workspaceId: IdSchema, channelId: IdSchema, threadTs: IdSchema, reviewMessageTs: IdSchema,
  bodyDigest: DigestSchema, expiresAt: UtcTimestampSchema, observedAt: UtcTimestampSchema,
  message: SlackMessageSchema, receipt: CollectionReceiptSchema, readContext: ReadCallContextSchema,
}).strict();
export type ReviewReceipt = z.infer<typeof ReviewReceiptSchema>;
export type ReviewResult = { status: 'ready'; plan: ImmutablePlan; review: ReviewReceipt; reviewRef: RestrictedArtifactRef }
  | { status: 'blocked'; reason: string };
const bootId = `approval-${randomUUID()}`;
export const approvalDigest = (text: string) => createHash('sha256').update(text).digest('hex');
export function approvalStamp(clock: () => number) {
  return { eventId: randomUUID(), at: new Date(clock()).toISOString(), processId: `process-${process.pid}`,
    bootId, monotonicMs: performance.now() };
}
export function approvalEvents(repository: ApplicationRepository, runId: string) {
  const events = []; let afterSequence = 0;
  for (;;) {
    const page = repository.readEvents({ runId, afterSequence, limit: 1000 });
    events.push(...page);
    if (page.length < 1000) return events;
    afterSequence = page.at(-1)!.sequence;
  }
}
export async function currentApprovalPlan(repository: ApplicationRepository, runId: string): Promise<ImmutablePlan> {
  const row = repository.database.connection.prepare('SELECT MAX(plan_revision) AS revision FROM plans WHERE run_id=?').get(IdSchema.parse(runId));
  const plan = row?.revision ? repository.getPlan(runId, Number(row.revision)) : null;
  if (!plan) throw new Error('plan_missing');
  return verifyPlanEffectKeys(plan);
}
export function reviewTarget(plan: ImmutablePlan, policy: ApprovalPolicy) {
  const target = plan.effects.find(effect => effect.kind === 'thread');
  if (!target || target.payload.channelId !== policy.channelId) throw new Error('review_scope_mismatch');
  return { channelId: target.payload.channelId, threadTs: target.payload.threadTs };
}
export function reviewBody(plan: ImmutablePlan, policy: ApprovalPolicy) {
  const expiresAt = new Date(Date.parse(plan.createdAt) + policy.ttlMs).toISOString();
  const marker = `promiseguard-review-${plan.planHash}`;
  const body = [
    `PromiseGuard review: ${plan.runId}, revision ${plan.revision}`,
    `Plan SHA-256: ${plan.planHash}`, `Expires: ${expiresAt}`,
    'Gmail actions create drafts only. Review the exact selection, contents and ordered actions below.',
    `Approve: approve ${plan.runId} ${plan.planHash}`, `Reject: reject ${plan.runId} ${plan.planHash}`,
    'Reply in this thread. A rejection closes this revision.', marker,
    canonical(plan),
  ].join('\n');
  SlackWriteSchema.parse({ ...reviewTarget(plan, policy), body });
  return { body, marker, expiresAt };
}
export function approvalReadContext(node: WorkflowNodeContext, options: ReviewOptions,
  operation: 'slack.readApprovalThread'): ReadCallContext & { operation: 'slack.readApprovalThread' } {
  const now = (options.clock ?? Date.now)();
  return ReadCallContextSchema.parse({ schemaVersion: 2, runId: node.state.runId,
    runtimeAttemptId: node.state.runtimeAttemptId, evaluationAttemptId: node.state.evaluationAttemptId,
    spanId: randomUUID(), app: 'slack', accountRef: options.slack.scope.accountRef, mode: options.slack.mode,
    logicalCallId: randomUUID(), providerAttemptId: randomUUID(), operation,
    deadlineAt: new Date(Math.min(Date.parse(node.state.deadlineAt), now + options.policy.budgets.totalMs)).toISOString(),
    budgets: options.policy.budgets }) as ReadCallContext & { operation: 'slack.readApprovalThread' };
}
/** The injected I04 adapter records provider calls through B01 before returning. */
export async function readReviewThread(node: WorkflowNodeContext, options: ReviewOptions, plan: ImmutablePlan) {
  node.signal.throwIfAborted();
  const clock = options.clock ?? Date.now, notBefore = new Date(clock()).toISOString();
  const context = approvalReadContext(node, options, 'slack.readApprovalThread');
  const target = reviewTarget(plan, options.policy);
  const read = readResultSchema(z.array(SlackMessageSchema)).parse(await options.slack.readApprovalThread(target.channelId, target.threadTs, context));
  node.signal.throwIfAborted();
  if (read.status !== 'complete') throw new Error('slack_unavailable');
  verifyObservedCollection({ repository: options.repository, receipt: read.receipt, context,
    checkedAt: new Date(clock()).toISOString(), maxAgeMs: options.policy.slackFreshnessMs, notBefore });
  const messages = new Map<string, z.infer<typeof SlackMessageSchema>>();
  for (const message of read.data) {
    if (message.workspaceId !== options.policy.workspaceId || message.channelId !== target.channelId || message.threadTs !== target.threadTs ||
        Date.parse(message.observedAt) < Date.parse(read.receipt.startedAt) || Date.parse(message.observedAt) > Date.parse(read.receipt.finishedAt))
      throw new Error('slack_scope_mismatch');
    const prior = messages.get(message.messageTs);
    if (prior && canonical(prior) !== canonical(message)) throw new Error('conflicting_slack_message');
    messages.set(message.messageTs, message);
  }
  return { messages: [...messages.values()], receipt: read.receipt, context };
}
export function storeApprovalGuard(node: WorkflowNodeContext, options: ReviewOptions, plan: ImmutablePlan,
  reason: string, allowed: boolean, evidence: unknown): RestrictedArtifactRef {
  node.signal.throwIfAborted();
  return node.transaction(writer => {
    const ref = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: evidence });
    writer.appendEvent({ kind: 'guard.checked', allowed, reason, planHash: plan.planHash, evidenceRefs: [ref] }, approvalStamp(options.clock ?? Date.now));
    return ref;
  });
}
export function createReviewService(input: ReviewOptions) {
  const options = { ...input, policy: immutable(ApprovalPolicySchema.parse(input.policy)) }, clock = options.clock ?? Date.now;
  async function observe(node: WorkflowNodeContext, plan: ImmutablePlan): Promise<ReviewResult> {
    const expected = reviewBody(plan, options.policy), target = reviewTarget(plan, options.policy);
    const read = await readReviewThread(node, options, plan);
    const matches = read.messages.filter(message => message.body.includes(expected.marker));
    if (matches.length !== 1) return { status: 'blocked', reason: matches.length ? 'review_ambiguous' : 'review_missing' };
    const message = matches[0];
    if (message.body !== expected.body || message.actorId !== options.policy.reviewActorId || message.deleted || message.editedAt ||
        (message.subtype !== null && message.subtype !== 'bot_message')) return { status: 'blocked', reason: 'review_changed' };
    if (clock() >= Date.parse(expected.expiresAt)) return { status: 'blocked', reason: 'approval_expired' };
    const review = ReviewReceiptSchema.parse({ schemaVersion: 2, kind: 'slack_review', runId: plan.runId,
      planRevision: plan.revision, planHash: plan.planHash, policyDigest: approvalDigest(canonical(options.policy)),
      workspaceId: options.policy.workspaceId, ...target, reviewMessageTs: message.messageTs,
      bodyDigest: approvalDigest(message.body), expiresAt: expected.expiresAt, observedAt: read.receipt.finishedAt,
      message, receipt: read.receipt, readContext: read.context });
    const reviewRef = storeApprovalGuard(node, options, plan, 'review_verified', false, review);
    return { status: 'ready', plan, review, reviewRef };
  }
  return {
    options,
    async observeReview(node: WorkflowNodeContext): Promise<ReviewResult> {
      try { return await observe(node, await currentApprovalPlan(options.repository, node.state.runId)); }
      catch { return { status: 'blocked', reason: 'review_unavailable' }; }
    },
    /** Effectful publication is called separately from the pure durable wait node. */
    async publishReview(node: WorkflowNodeContext): Promise<ReviewResult> {
      try {
        const plan = await currentApprovalPlan(options.repository, node.state.runId);
        const expected = reviewBody(plan, options.policy);
        if (clock() >= Date.parse(expected.expiresAt)) return { status: 'blocked', reason: 'approval_expired' };
        const existing = await observe(node, plan);
        if (existing.status === 'ready' || existing.reason !== 'review_missing') return existing;
        // The intent and its event are committed before dispatch. An uncertain or interrupted
        // publish can only be adopted by a complete exact read; it is never blindly repeated.
        const claimed = node.transaction(writer => {
          if (approvalEvents(writer, plan.runId).some(event => event.kind === 'guard.checked' &&
              event.planHash === plan.planHash && event.reason === 'review_publication_intent')) return false;
          const ref = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: {
            schemaVersion: 2, runId: plan.runId, planRevision: plan.revision, planHash: plan.planHash,
            ...reviewTarget(plan, options.policy), bodyDigest: approvalDigest(expected.body), expiresAt: expected.expiresAt,
          } });
          writer.appendEvent({ kind: 'guard.checked', allowed: false, reason: 'review_publication_intent',
            planHash: plan.planHash, evidenceRefs: [ref] }, approvalStamp(clock));
          return true;
        });
        if (!claimed) return { status: 'blocked', reason: 'review_outcome_unknown' };
        node.signal.throwIfAborted();
        const readContext = approvalReadContext(node, options, 'slack.readApprovalThread');
        const payload = { ...reviewTarget(plan, options.policy), body: expected.body };
        const context = CoordinationCallContextSchema.parse({ ...readContext, operation: 'slack.postReview',
          marker: expected.marker, requestDigest: approvalDigest(canonical(payload)), budgets: { ...options.policy.budgets, maxAttempts: 1 } });
        const outcome = await options.slack.postReview(payload, { ...context, operation: 'slack.postReview' });
        node.signal.throwIfAborted();
        if (outcome.status === 'not_applied') return { status: 'blocked', reason: 'review_not_applied' };
        return await observe(node, plan);
      } catch { return { status: 'blocked', reason: 'review_unavailable' }; }
    },
  };
}
