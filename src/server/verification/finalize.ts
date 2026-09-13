import { randomUUID } from 'node:crypto';

import {
  CoordinationCallContextSchema,
  SlackWriteSchema,
  type CoordinationCallContext,
  type SlackCoordinator,
} from '../../shared/adapters.js';
import { CompletionClaimSchema, type CompletionClaim } from '../../shared/evaluation.js';
import {
  IdSchema,
  verifyPlanIntegrity,
  type EffectRecord,
  type ImmutablePlan,
  type MutationOutcome,
  type PlannedEffect,
  type RestrictedArtifactRef,
} from '../../shared/domain.js';
import { type EventContext, type EventStamp } from '../observability/events.js';
import { ApplicationRepository } from '../storage/repositories.js';
import { resolveContentTemplate } from './assertions.js';
import {
  verifySlackSummary,
  type ArtifactReadback,
  type PlanReadbackReport,
  type ReadbackStatus,
  type ReadbackVerifierOptions,
} from './readback.js';

type Awaitable<T> = T | Promise<T>;
type ClaimIdentity = 'schemaVersion' | 'claimId' | 'runId' | 'evaluationAttemptId' |
  'runtimeAttemptId' | 'eventId' | 'sequence' | 'emittedAt';
type ArtifactClaim = Extract<CompletionClaim, { scope: 'artifacts' }>;
type RunClaim = Extract<CompletionClaim, { scope: 'run' }>;
type ThreadEffect = Extract<PlannedEffect, { kind: 'thread' }>;

export type ArtifactCompletionProof = Omit<ArtifactClaim, ClaimIdentity>;
export type RunCompletionProof = Omit<RunClaim, ClaimIdentity>;

export interface SummaryContextFactory {
  (): CoordinationCallContext & { operation: 'slack.postSummary' };
}

export interface SummaryEffectPersistence {
  claim(input: {
    plan: ImmutablePlan;
    effect: ThreadEffect;
    record: EffectRecord;
    context: CoordinationCallContext & { operation: 'slack.postSummary' };
    summary: { channelId: string; threadTs: string; body: string };
  }): Awaitable<boolean>;
  recordOutcome(input: {
    effect: ThreadEffect;
    context: CoordinationCallContext & { operation: 'slack.postSummary' };
    outcome: MutationOutcome;
  }): Awaitable<EffectRecord>;
}

export interface ArtifactClaimPublisher {
  publish(proof: ArtifactCompletionProof): Awaitable<string>;
}

export interface FinalizeOptions {
  coordinator: SlackCoordinator;
  createContext: SummaryContextFactory;
  persistence: SummaryEffectPersistence;
  artifactClaims: ArtifactClaimPublisher;
  readback: ReadbackVerifierOptions;
}

export type FinalizationResult = Readonly<
  | { status: 'completed'; artifactClaimId: string; summary: ArtifactReadback; proof: RunCompletionProof }
  | { status: Exclude<ReadbackStatus, 'matched'>; reason: string; artifactClaimId: string | null; summary: ArtifactReadback | null }
>;

export interface ApplicationArtifactClaimPublisherOptions {
  repository: ApplicationRepository;
  eventContext(): EventContext;
  stamp(): EventStamp;
  createId?: () => string;
}

export interface ApplicationSummaryPersistenceOptions {
  repository: ApplicationRepository;
  eventContext(context: CoordinationCallContext): EventContext;
  stamp(): EventStamp;
  createId?: () => string;
}

function verificationScope(report: PlanReadbackReport) {
  return report.artifacts.map(artifact => {
    if (artifact.status !== 'matched' || !artifact.verificationId || !artifact.observedAt || !artifact.receipt) {
      throw new Error('business_artifact_verification_incomplete');
    }
    return { verificationId: artifact.verificationId, effectKey: artifact.effectKey,
      kind: artifact.kind, observedAt: artifact.observedAt, receipt: artifact.receipt };
  });
}

function threadEffect(plan: ImmutablePlan): ThreadEffect {
  const effect = plan.effects.find((candidate): candidate is ThreadEffect => candidate.kind === 'thread');
  if (!effect) throw new Error('summary_effect_missing');
  return effect;
}

function assertBusinessScope(plan: ImmutablePlan, report: PlanReadbackReport): void {
  const businessEffects = plan.effects.filter(effect => effect.kind !== 'thread');
  if (report.planHash !== plan.planHash || report.status !== 'matched' ||
      report.artifacts.length !== businessEffects.length ||
      report.artifacts.some((artifact, index) => artifact.effectKey !== businessEffects[index]?.effectKey || artifact.kind === 'thread')) {
    throw new Error('business_artifact_verification_incomplete');
  }
}

export function buildArtifactCompletionProof(
  plan: ImmutablePlan,
  planRef: RestrictedArtifactRef,
  report: PlanReadbackReport,
): ArtifactCompletionProof {
  assertBusinessScope(plan, report);
  return {
    scope: 'artifacts',
    planRef,
    planHash: plan.planHash,
    effectKeys: report.artifacts.map(artifact => artifact.effectKey),
    verifications: verificationScope(report),
  };
}

export function buildSlackArtifactSummary(plan: ImmutablePlan, report: PlanReadbackReport): string {
  assertBusinessScope(plan, report);
  const effect = threadEffect(plan);
  const body = resolveContentTemplate(plan, effect.payload.body, report.effectIds);
  if (!/coordination finalization:\s*pending/i.test(body)) throw new Error('summary_pending_disclosure_missing');
  if (body.split(effect.effectKey).length !== 2) throw new Error('summary_marker_invalid');
  for (const artifact of report.artifacts) {
    if (!artifact.providerId || !body.includes(artifact.providerId)) throw new Error('summary_artifact_link_missing');
  }
  return body;
}

function failed(status: Exclude<ReadbackStatus, 'matched'>, reason: string,
  artifactClaimId: string | null, summary: ArtifactReadback | null = null): FinalizationResult {
  return Object.freeze({ status, reason, artifactClaimId, summary });
}

export async function finalizeVerifiedRun(
  planValue: ImmutablePlan,
  planRef: RestrictedArtifactRef,
  business: PlanReadbackReport,
  summaryRecordValue: EffectRecord,
  options: FinalizeOptions,
): Promise<FinalizationResult> {
  const plan = await verifyPlanIntegrity(planValue);
  try {
    assertBusinessScope(plan, business);
  } catch {
    return failed(business.status === 'mismatched' ? 'mismatched' : 'unverified',
      'business_artifacts_unverified', null);
  }
  const effect = threadEffect(plan);
  let summaryRecord = summaryRecordValue;
  if (summaryRecord.runId !== plan.runId || summaryRecord.effectKey !== effect.effectKey ||
      summaryRecord.requestDigest !== effect.requestDigest) return failed('unverified', 'summary_effect_identity_mismatch', null);
  if (summaryRecord.state === 'inflight' || summaryRecord.outcome?.status === 'unknown') {
    return failed('unverified', 'summary_outcome_unknown', null);
  }

  const artifactProof = buildArtifactCompletionProof(plan, planRef, business);
  const artifactClaimId = IdSchema.parse(await options.artifactClaims.publish(artifactProof));
  const parsedSummary = SlackWriteSchema.parse({ channelId: effect.payload.channelId,
    threadTs: effect.payload.threadTs, body: buildSlackArtifactSummary(plan, business) });
  if (parsedSummary.threadTs === null) throw new Error('summary_thread_missing');
  const summary = { ...parsedSummary, threadTs: parsedSummary.threadTs };

  if (summaryRecord.state === 'planned') {
    const parsedContext = CoordinationCallContextSchema.parse(options.createContext());
    if (parsedContext.operation !== 'slack.postSummary' || parsedContext.runId !== plan.runId ||
        parsedContext.marker !== effect.effectKey || parsedContext.requestDigest !== effect.requestDigest ||
        parsedContext.app !== 'slack') {
      throw new Error('invalid_summary_context');
    }
    const context = { ...parsedContext, operation: 'slack.postSummary' as const };
    const claimed = await options.persistence.claim({ plan, effect, record: summaryRecord, context, summary });
    if (!claimed) return failed('unverified', 'summary_claim_conflict', artifactClaimId);
    const outcome = await options.coordinator.postSummary(summary, context);
    summaryRecord = await options.persistence.recordOutcome({ effect, context, outcome });
    if (outcome.status !== 'applied' || summaryRecord.state !== 'applied' ||
        summaryRecord.providerId !== outcome.providerId || summaryRecord.outcome?.status !== 'applied') {
      return failed('unverified', outcome.status === 'unknown' ? 'summary_outcome_unknown' : 'summary_not_applied', artifactClaimId);
    }
  } else if (!['applied', 'verified'].includes(summaryRecord.state)) {
    return failed('unverified', 'summary_not_applied', artifactClaimId);
  }

  const summaryReadback = await verifySlackSummary(plan, summaryRecord, business.effectIds, options.readback);
  if (summaryReadback.status !== 'matched') {
    return failed(summaryReadback.status, 'summary_readback_failed', artifactClaimId, summaryReadback);
  }
  const verifications = [...verificationScope(business), {
    verificationId: summaryReadback.verificationId!, effectKey: summaryReadback.effectKey,
    kind: summaryReadback.kind, observedAt: summaryReadback.observedAt!, receipt: summaryReadback.receipt!,
  }];
  const proof: RunCompletionProof = { scope: 'run', planRef, planHash: plan.planHash,
    effectKeys: plan.effects.map(item => item.effectKey), verifications,
    finalSlackVerificationId: summaryReadback.verificationId! };
  const completed: Extract<FinalizationResult, { status: 'completed' }> = {
    status: 'completed', artifactClaimId, summary: summaryReadback, proof,
  };
  return Object.freeze(completed);
}

export function createApplicationArtifactClaimPublisher(
  options: ApplicationArtifactClaimPublisherOptions,
): ArtifactClaimPublisher {
  const createId = options.createId ?? randomUUID;
  return Object.freeze({ publish(proof: ArtifactCompletionProof): string {
    const context = options.eventContext();
    const existing = options.repository.readEvents({ runId: context.runId, limit: 1000 }).find(event =>
      event.kind === 'success.claimed' && event.claim.scope === 'artifacts' &&
      event.claim.planHash === proof.planHash &&
      JSON.stringify(event.claim.effectKeys) === JSON.stringify(proof.effectKeys));
    if (existing?.kind === 'success.claimed') return existing.claim.claimId;
    const stamp = options.stamp();
    return options.repository.transaction(context, writer => {
      const claim = CompletionClaimSchema.parse({ ...proof, schemaVersion: 2, claimId: IdSchema.parse(createId()),
        runId: context.runId, evaluationAttemptId: context.evaluationAttemptId,
        runtimeAttemptId: context.runtimeAttemptId, eventId: stamp.eventId,
        sequence: writer.getRun(context.runId)!.eventSequence + 1, emittedAt: stamp.at });
      writer.appendEvent({ kind: 'success.claimed', claim }, stamp);
      return claim.claimId;
    });
  } });
}

export function createApplicationSummaryPersistence(
  options: ApplicationSummaryPersistenceOptions,
): SummaryEffectPersistence {
  const createId = options.createId ?? randomUUID;
  return Object.freeze({
    claim(input: Parameters<SummaryEffectPersistence['claim']>[0]): boolean {
      const current = options.repository.getEffect(input.effect.effectKey);
      if (!current || current.state !== 'planned') return false;
      const eventContext = options.eventContext(input.context);
      const stamp = options.stamp();
      if (eventContext.stage !== 'verify' || eventContext.spanId !== input.context.spanId ||
          eventContext.runId !== input.context.runId || eventContext.evaluationAttemptId !== input.context.evaluationAttemptId ||
          eventContext.runtimeAttemptId !== input.context.runtimeAttemptId) throw new Error('summary_event_context_mismatch');
      return options.repository.transaction(eventContext, writer => {
        const requestRef = writer.putArtifact({ artifactId: createId(), mediaType: 'application/json', content: input.summary });
        const claimed = writer.claimEffect({ effectKey: input.effect.effectKey, claimId: IdSchema.parse(createId()),
          context: input.context, requestRef, startedAt: stamp.at });
        if (claimed) writer.appendEvent({ kind: 'tool.dispatch', app: 'slack', operation: 'slack.postSummary',
          logicalCallId: input.context.logicalCallId, providerAttemptId: input.context.providerAttemptId,
          actor: 'coordinator', effectKey: input.effect.effectKey, requestDigest: input.effect.requestDigest,
          planHash: null, approvalId: null }, stamp);
        return claimed;
      });
    },
    recordOutcome(input: Parameters<SummaryEffectPersistence['recordOutcome']>[0]): EffectRecord {
      const current = options.repository.getEffect(input.effect.effectKey);
      const attempt = options.repository.getProviderAttempt(input.context.providerAttemptId);
      if (!current || !attempt?.receipt || !attempt.outcome || attempt.outcome.status !== input.outcome.status ||
          (input.outcome.status === 'applied' && (current.state !== 'applied' || current.providerId !== input.outcome.providerId)) ||
          (input.outcome.status === 'unknown' && current.state !== 'inflight')) {
        throw new Error('summary_outcome_not_persisted');
      }
      return current;
    },
  });
}