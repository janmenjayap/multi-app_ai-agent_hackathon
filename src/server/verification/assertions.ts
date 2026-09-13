import type { z } from 'zod';

import {
  GitHubCommentSchema,
  GmailDraftSchema,
  HubSpotCommitmentBundleSchema,
  HubSpotNoteSchema,
  HubSpotTaskSchema,
  SlackMessageSchema,
} from '../../shared/adapters.js';
import { canonical, type ImmutablePlan, type PlannedEffect } from '../../shared/domain.js';

type TaskEffect = Extract<PlannedEffect, { kind: 'task' }>;
type NoteEffect = Extract<PlannedEffect, { kind: 'note' }>;
type DraftEffect = Extract<PlannedEffect, { kind: 'draft' }>;
type CommentEffect = Extract<PlannedEffect, { kind: 'comment' }>;
type ThreadEffect = Extract<PlannedEffect, { kind: 'thread' }>;
type HubSpotTask = z.infer<typeof HubSpotTaskSchema>;
type HubSpotNote = z.infer<typeof HubSpotNoteSchema>;
type GmailDraft = z.infer<typeof GmailDraftSchema>;
type GitHubComment = z.infer<typeof GitHubCommentSchema>;
type SlackMessage = z.infer<typeof SlackMessageSchema>;
export type ProtectedCommitmentExpectation = z.infer<typeof HubSpotCommitmentBundleSchema>['commitments'][number];

export const ARTIFACT_MISMATCH_CODES = [
  'missing_record',
  'duplicate_marker',
  'provider_id_mismatch',
  'company_association_mismatch',
  'commitment_association_mismatch',
  'task_association_mismatch',
  'owner_mismatch',
  'due_at_mismatch',
  'status_mismatch',
  'subject_mismatch',
  'body_mismatch',
  'recipient_mismatch',
  'cc_mismatch',
  'bcc_mismatch',
  'draft_state_mismatch',
  'repository_mismatch',
  'issue_mismatch',
  'workspace_mismatch',
  'channel_mismatch',
  'thread_mismatch',
  'summary_actor_mismatch',
  'summary_deleted',
  'protected_record_missing',
  'protected_record_mismatch',
  'absence_predicate_failed',
] as const;

export type ArtifactMismatchCode = typeof ARTIFACT_MISMATCH_CODES[number];
export type ResolvedEffectIds = Readonly<Record<string, string>>;
export type ArtifactAssertion = Readonly<
  | { status: 'matched'; mismatches: readonly ArtifactMismatchCode[] }
  | { status: 'mismatched'; mismatches: readonly ArtifactMismatchCode[] }
>;

function assertion(mismatches: ArtifactMismatchCode[]): ArtifactAssertion {
  const unique = [...new Set(mismatches)];
  return unique.length === 0
    ? Object.freeze({ status: 'matched', mismatches: Object.freeze([]) })
    : Object.freeze({ status: 'mismatched', mismatches: Object.freeze(unique) });
}

function addWhen(
  mismatches: ArtifactMismatchCode[],
  condition: boolean,
  code: ArtifactMismatchCode,
): void {
  if (condition) mismatches.push(code);
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function resolveEffectId(value: string | { type: 'effect_id'; effectKey: string }, effectIds: ResolvedEffectIds): string {
  if (typeof value === 'string') return value;
  const providerId = effectIds[value.effectKey];
  if (!providerId) throw new Error('unresolved_effect_id');
  return providerId;
}

export function resolveContentTemplate(
  plan: ImmutablePlan,
  template: PlannedEffect['payload']['body'],
  effectIds: ResolvedEffectIds,
): string {
  return template.map(part => {
    if (part.type === 'text') return part.text;
    if (part.type === 'effect_id') return resolveEffectId(part, effectIds);
    if (part.planRevision !== plan.revision) throw new Error('approved_content_revision_mismatch');
    const content = plan.contents.find(candidate => candidate.contentKey === part.contentKey);
    if (!content) throw new Error('approved_content_missing');
    return content.text;
  }).join('');
}

export function assertUniqueProviderBinding(
  expectedProviderId: string,
  candidateProviderIds: readonly string[],
): ArtifactAssertion {
  const mismatches: ArtifactMismatchCode[] = [];
  addWhen(mismatches, candidateProviderIds.length === 0, 'missing_record');
  addWhen(mismatches, candidateProviderIds.length > 1, 'duplicate_marker');
  addWhen(mismatches, candidateProviderIds.length === 1 && candidateProviderIds[0] !== expectedProviderId,
    'provider_id_mismatch');
  return assertion(mismatches);
}

export function assertTaskReadback(
  plan: ImmutablePlan,
  effect: TaskEffect,
  expectedProviderId: string,
  observed: HubSpotTask | null,
  effectIds: ResolvedEffectIds,
): ArtifactAssertion {
  if (!observed) return assertion(['missing_record']);
  const mismatches: ArtifactMismatchCode[] = [];
  addWhen(mismatches, observed.id !== expectedProviderId, 'provider_id_mismatch');
  addWhen(mismatches, !sameStrings(observed.companyIds, [effect.payload.companyId]), 'company_association_mismatch');
  addWhen(mismatches, !sameStrings(observed.commitmentIds, [effect.payload.commitmentId]), 'commitment_association_mismatch');
  addWhen(mismatches, observed.ownerId !== effect.payload.ownerId, 'owner_mismatch');
  addWhen(mismatches, observed.dueAt !== effect.payload.dueAt, 'due_at_mismatch');
  addWhen(mismatches, observed.status !== effect.payload.status, 'status_mismatch');
  addWhen(mismatches, observed.subject !== effect.payload.subject, 'subject_mismatch');
  addWhen(mismatches, observed.body !== resolveContentTemplate(plan, effect.payload.body, effectIds), 'body_mismatch');
  return assertion(mismatches);
}

export function assertNoteReadback(
  plan: ImmutablePlan,
  effect: NoteEffect,
  expectedProviderId: string,
  observed: HubSpotNote | null,
  effectIds: ResolvedEffectIds,
): ArtifactAssertion {
  if (!observed) return assertion(['missing_record']);
  const mismatches: ArtifactMismatchCode[] = [];
  addWhen(mismatches, observed.id !== expectedProviderId, 'provider_id_mismatch');
  addWhen(mismatches, !sameStrings(observed.companyIds, [effect.payload.companyId]), 'company_association_mismatch');
  addWhen(mismatches, !sameStrings(observed.commitmentIds, [effect.payload.commitmentId]), 'commitment_association_mismatch');
  addWhen(mismatches, !sameStrings(observed.taskIds, [resolveEffectId(effect.payload.taskId, effectIds)]),
    'task_association_mismatch');
  addWhen(mismatches, observed.body !== resolveContentTemplate(plan, effect.payload.body, effectIds), 'body_mismatch');
  return assertion(mismatches);
}

export function assertDraftReadback(
  plan: ImmutablePlan,
  effect: DraftEffect,
  expectedProviderId: string,
  observed: GmailDraft | null,
  effectIds: ResolvedEffectIds,
): ArtifactAssertion {
  if (!observed) return assertion(['missing_record']);
  const mismatches: ArtifactMismatchCode[] = [];
  addWhen(mismatches, observed.draftId !== expectedProviderId, 'provider_id_mismatch');
  addWhen(mismatches, !sameStrings(observed.to, [effect.payload.to]), 'recipient_mismatch');
  addWhen(mismatches, !sameStrings(observed.cc, effect.payload.cc), 'cc_mismatch');
  addWhen(mismatches, !sameStrings(observed.bcc, effect.payload.bcc), 'bcc_mismatch');
  addWhen(mismatches, observed.subject !== effect.payload.subject, 'subject_mismatch');
  addWhen(mismatches, observed.body !== resolveContentTemplate(plan, effect.payload.body, effectIds), 'body_mismatch');
  addWhen(mismatches, observed.isDraft !== effect.payload.isDraft, 'draft_state_mismatch');
  return assertion(mismatches);
}

export function assertCommentReadback(
  plan: ImmutablePlan,
  effect: CommentEffect,
  expectedProviderId: string,
  observed: GitHubComment | null,
  effectIds: ResolvedEffectIds,
): ArtifactAssertion {
  if (!observed) return assertion(['missing_record']);
  const mismatches: ArtifactMismatchCode[] = [];
  addWhen(mismatches, observed.id !== expectedProviderId, 'provider_id_mismatch');
  addWhen(mismatches, observed.repositoryId !== effect.payload.repositoryId, 'repository_mismatch');
  addWhen(mismatches, observed.issueId !== effect.payload.issueId, 'issue_mismatch');
  addWhen(mismatches, observed.body !== resolveContentTemplate(plan, effect.payload.body, effectIds), 'body_mismatch');
  return assertion(mismatches);
}

export function assertSlackSummaryReadback(
  plan: ImmutablePlan,
  effect: ThreadEffect,
  expectedProviderId: string,
  expectedWorkspaceId: string,
  observed: SlackMessage | null,
  effectIds: ResolvedEffectIds,
): ArtifactAssertion {
  if (!observed) return assertion(['missing_record']);
  const mismatches: ArtifactMismatchCode[] = [];
  addWhen(mismatches, observed.messageTs !== expectedProviderId, 'provider_id_mismatch');
  addWhen(mismatches, observed.workspaceId !== expectedWorkspaceId, 'workspace_mismatch');
  addWhen(mismatches, observed.channelId !== effect.payload.channelId, 'channel_mismatch');
  addWhen(mismatches, observed.threadTs !== effect.payload.threadTs, 'thread_mismatch');
  addWhen(mismatches, observed.body !== resolveContentTemplate(plan, effect.payload.body, effectIds), 'body_mismatch');
  addWhen(mismatches, !observed.isBot, 'summary_actor_mismatch');
  addWhen(mismatches, observed.deleted, 'summary_deleted');
  return assertion(mismatches);
}

export function assertProtectedCommitments(
  expected: readonly ProtectedCommitmentExpectation[],
  observed: readonly ProtectedCommitmentExpectation[],
): ArtifactAssertion {
  const mismatches: ArtifactMismatchCode[] = [];
  for (const protectedRecord of expected) {
    const actual = observed.find(candidate => candidate.id === protectedRecord.id);
    if (!actual) mismatches.push('protected_record_missing');
    else if (canonical(actual) !== canonical(protectedRecord)) mismatches.push('protected_record_mismatch');
  }
  return assertion(mismatches);
}

export function combineAssertions(...results: readonly ArtifactAssertion[]): ArtifactAssertion {
  return assertion(results.flatMap(result => [...result.mismatches]));
}