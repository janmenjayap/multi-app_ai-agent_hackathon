import { ApprovalViewSchema } from '../../shared/api.js';
import { type ImmutablePlan, type RestrictedArtifactRef } from '../../shared/domain.js';
import { type ApprovalService } from '../policy/approval.js';
import { ReviewReceiptSchema, type ReviewReceipt } from './review.js';
import { type WorkflowNode, type WorkflowNodeContext, type WorkflowNodeResult } from './driver.js';

/** Pure scheduling node: the driver atomically persists the deadline/projection and
 * releases its worker. Publishing and decision reads happen outside this function. */
export function approvalWait(node: WorkflowNodeContext, input: { plan: ImmutablePlan; review: ReviewReceipt;
  reviewRef?: RestrictedArtifactRef; clock?: () => number; pollMs: number }): WorkflowNodeResult {
  const review = ReviewReceiptSchema.parse(input.review), now = (input.clock ?? Date.now)();
  if (review.runId !== node.state.runId || review.planRevision !== input.plan.revision || review.planHash !== input.plan.planHash ||
      node.state.plan?.planHash !== input.plan.planHash)
    return { kind: 'stop', status: 'safely_blocked', reason: 'approval_wait_plan_mismatch' };
  const deadline = Math.min(Date.parse(review.expiresAt), Date.parse(node.state.deadlineAt));
  if (now >= deadline) return { kind: 'stop', status: 'safely_blocked', reason: 'approval_expired' };
  if (!Number.isInteger(input.pollMs) || input.pollMs <= 0 || input.pollMs > 60000) throw new Error('invalid_approval_poll');
  return { kind: 'wait', wakeAt: new Date(Math.min(now + input.pollMs, deadline)).toISOString(),
    reason: 'awaiting_slack_decision', awaitingApproval: true,
    patch: { approval: ApprovalViewSchema.parse({ status: 'waiting', planRevision: review.planRevision, planHash: review.planHash,
      slackLink: `https://app.slack.com/client/${review.workspaceId}/${review.channelId}/thread/${review.channelId}-${review.threadTs}`,
      approver: null, decidedAt: null, expiresAt: review.expiresAt, invalidationReason: null }),
      references: { ...node.state.references, ...(input.reviewRef ? { slackReview: input.reviewRef } : {}) } },
  };
}
/** R01 installs this at its approval stage after freezing/projecting the plan.
 * No resume payload is consumed as authority; every wake calls the server reader. */
export function createApprovalNode(service: ApprovalService): WorkflowNode {
  return async node => {
    const previous = node.state.references.slackReview;
    let canReuse = false;
    if (previous) {
      try {
        const receipt = ReviewReceiptSchema.parse(JSON.parse(service.options.repository.readArtifact(previous)));
        canReuse = receipt.runId === node.state.runId && receipt.planHash === node.state.plan?.planHash &&
          receipt.planRevision === node.state.plan.revision;
      } catch { /* A reference cannot supply authority; recover only by authentic review readback. */ }
    }
    if (!canReuse) {
      const published = await service.publishReview(node);
      if (published.status === 'blocked') return { kind: 'stop',
        status: published.reason === 'review_unavailable' ? 'failed' : 'safely_blocked', reason: published.reason };
      return approvalWait(node, { ...published, clock: service.options.clock, pollMs: service.options.policy.pollMs });
    }
    const result = await service.checkApproval(node);
    if (result.status === 'blocked') {
      const approval = node.state.approval;
      return { kind: 'stop', status: result.reason.endsWith('_unavailable') || result.reason.startsWith('observation_') || result.reason.endsWith('_incomplete') ? 'failed' : 'safely_blocked', reason: result.reason,
        patch: approval ? { approval: { ...approval, status: result.reason === 'plan_rejected' ? 'rejected' :
          result.reason === 'approval_expired' ? 'expired' : result.needsRevision ? 'invalidated' : 'unverified',
          invalidationReason: result.reason } } : undefined };
    }
    if (result.status === 'waiting') return approvalWait(node, { ...result, clock: service.options.clock, pollMs: service.options.policy.pollMs });
    const decision = service.options.repository.listApprovals(result.plan.runId, result.plan.revision)
      .find(value => value.approvalId === result.approvalId)!;
    return { kind: 'advance', nextStage: 'execute', patch: {
      references: { ...node.state.references, approvalAuthority: result.reference },
      approval: { ...node.state.approval!, status: 'approved', planRevision: result.plan.revision, planHash: result.plan.planHash,
        approver: decision.actorId, decidedAt: decision.decidedAt, expiresAt: result.expiresAt,
        slackLink: node.state.approval?.slackLink ?? null, invalidationReason: null },
    } };
  };
}
