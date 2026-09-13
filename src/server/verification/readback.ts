import { randomUUID } from 'node:crypto';

import type {
  GitHubReader,
  GmailReader,
  HubSpotReader,
  ReadCallContext,
  SlackReader,
} from '../../shared/adapters.js';
import { ImportedObservationSchema, type CompletionClaim } from '../../shared/evaluation.js';
import {
  IdSchema,
  verifyPlanIntegrity,
  type CollectionReceipt,
  type EffectKey,
  type EffectRecord,
  type ImmutablePlan,
  type PlannedEffect,
  type ReadResult,
  type RestrictedArtifactRef,
  type Selection,
} from '../../shared/domain.js';
import { githubCommentMarker } from '../adapters/github.js';
import { createCanonicalEvent, type EventContext, type EventStamp } from '../observability/events.js';
import { ApplicationRepository } from '../storage/repositories.js';
import {
  assertCommentReadback,
  assertDraftReadback,
  assertNoteReadback,
  assertProtectedCommitments,
  assertSlackSummaryReadback,
  assertTaskReadback,
  assertUniqueProviderBinding,
  combineAssertions,
  type ArtifactAssertion,
  type ArtifactMismatchCode,
  type ProtectedCommitmentExpectation,
  type ResolvedEffectIds,
} from './assertions.js';

type Awaitable<T> = T | Promise<T>;
type ReadOperation = ReadCallContext['operation'];
type ContextFor<Operation extends ReadOperation> = ReadCallContext & { operation: Operation };
type BusinessEffect = Exclude<PlannedEffect, { kind: 'thread' }>;
type ThreadEffect = Extract<PlannedEffect, { kind: 'thread' }>;
type ReadPurpose = 'binding' | 'artifact' | 'scope';
type ClaimIdentity = 'schemaVersion' | 'claimId' | 'runId' | 'evaluationAttemptId' |
  'runtimeAttemptId' | 'eventId' | 'sequence' | 'emittedAt';
type NoAffectedClaim = Extract<CompletionClaim, { scope: 'no_affected' }>;

export type NoAffectedCompletionProof = Omit<NoAffectedClaim, ClaimIdentity>;

export interface ReadbackReaders {
  github: GitHubReader;
  hubspot: HubSpotReader;
  gmail: GmailReader;
  slack: SlackReader;
}

export interface ReadbackContextRequest<Operation extends ReadOperation = ReadOperation> {
  operation: Operation;
  effectKey: string | null;
  purpose: ReadPurpose;
}

export interface ReadbackContextFactory {
  <Operation extends ReadOperation>(request: ReadbackContextRequest<Operation>): ContextFor<Operation>;
}

export interface ReadbackRead {
  purpose: ReadPurpose;
  context: ReadCallContext;
  result: ReadResult<unknown>;
}

export type ReadbackStatus = 'matched' | 'mismatched' | 'unverified';

export interface ReadbackRecordInput {
  plan: ImmutablePlan;
  effect: PlannedEffect;
  providerId: string;
  status: ReadbackStatus;
  mismatches: readonly ArtifactMismatchCode[];
  reads: readonly ReadbackRead[];
}

export interface ScopeReadbackRecordInput {
  scopeId: string;
  status: ReadbackStatus;
  mismatches: readonly ArtifactMismatchCode[];
  read: ReadbackRead;
}

export interface PersistedReadbackEvidence {
  observationIds: readonly string[];
  verificationId: string | null;
  observedAt: string;
  receipt: RestrictedArtifactRef;
}

export interface ReadbackRecorder {
  recordArtifact(input: ReadbackRecordInput): Awaitable<PersistedReadbackEvidence>;
  recordScope(input: ScopeReadbackRecordInput): Awaitable<PersistedReadbackEvidence>;
}

export interface ArtifactReadback {
  effectKey: EffectKey;
  kind: PlannedEffect['kind'];
  providerId: string | null;
  status: ReadbackStatus;
  mismatches: readonly ArtifactMismatchCode[];
  observationIds: readonly string[];
  verificationId: string | null;
  observedAt: string | null;
  receipt: RestrictedArtifactRef | null;
}

export interface PlanReadbackReport {
  planHash: string;
  status: ReadbackStatus;
  artifacts: readonly ArtifactReadback[];
  effectIds: ResolvedEffectIds;
  protectedRecords: ScopeReadback | null;
}

export interface ScopeReadback {
  scopeId: string;
  status: ReadbackStatus;
  mismatches: readonly ArtifactMismatchCode[];
  observationIds: readonly string[];
  observedAt: string | null;
  receipt: RestrictedArtifactRef | null;
}

export interface ReadbackVerifierOptions {
  readers: ReadbackReaders;
  createContext: ReadbackContextFactory;
  recorder: ReadbackRecorder;
  expectedSlackWorkspaceId?: string;
  protectedCommitments?: readonly ProtectedCommitmentExpectation[];
}

export interface AbsencePredicate {
  predicateId: string;
  read(): Awaitable<{ context: ReadCallContext; result: ReadResult<unknown> }>;
  isAbsent(observed: unknown): boolean;
}

export interface NoAffectedVerificationInput {
  runId: string;
  selection: Selection;
  selectionRef: RestrictedArtifactRef;
  sourceReceipts: readonly CollectionReceipt[];
  absencePredicates: readonly AbsencePredicate[];
  recorder: ReadbackRecorder;
}

export type NoAffectedVerificationResult = Readonly<
  | { status: 'matched'; proof: NoAffectedCompletionProof; evidence: readonly ScopeReadback[] }
  | { status: 'mismatched' | 'unverified'; proof: null; evidence: readonly ScopeReadback[] }
>;

export interface ApplicationReadbackRecorderOptions {
  repository: ApplicationRepository;
  eventContext(context: ReadCallContext): EventContext;
  stamp(): EventStamp;
  createId?: () => string;
}

interface PreparedReads {
  binding: ReadbackRead;
  candidateProviderIds: readonly string[];
  read(providerId: string): Promise<{ read: ReadbackRead; assertion: ArtifactAssertion }>;
}

function makeContext<Operation extends ReadOperation>(
  plan: ImmutablePlan,
  effect: PlannedEffect,
  options: ReadbackVerifierOptions,
  operation: Operation,
  purpose: ReadPurpose,
): ContextFor<Operation> {
  const context = options.createContext({ operation, effectKey: effect.effectKey, purpose });
  if (context.operation !== operation || context.runId !== plan.runId ||
      context.app !== operation.split('.')[0] || context.spanId.length === 0) {
    throw new Error('invalid_readback_context');
  }
  return context;
}

function incompleteResult(effect: PlannedEffect): ArtifactReadback {
  return Object.freeze({
    effectKey: effect.effectKey,
    kind: effect.kind,
    providerId: null,
    status: 'unverified',
    mismatches: Object.freeze([]),
    observationIds: Object.freeze([]),
    verificationId: null,
    observedAt: null,
    receipt: null,
  });
}

function emptyScope(scopeId: string): ScopeReadback {
  return Object.freeze({ scopeId, status: 'unverified', mismatches: Object.freeze([]),
    observationIds: Object.freeze([]), observedAt: null, receipt: null });
}

async function persistScope(
  scopeId: string,
  read: ReadbackRead,
  assertion: ArtifactAssertion,
  recorder: ReadbackRecorder,
): Promise<ScopeReadback> {
  const status: ReadbackStatus = read.result.status === 'complete' ? assertion.status : 'unverified';
  const mismatches = status === 'unverified' ? Object.freeze([]) : assertion.mismatches;
  const evidence = await recorder.recordScope({ scopeId, status, mismatches, read });
  return Object.freeze({ scopeId, status, mismatches, observationIds: evidence.observationIds,
    observedAt: evidence.observedAt, receipt: evidence.receipt });
}

async function persistResult(
  input: Omit<ReadbackRecordInput, 'status' | 'mismatches'>,
  assertion: ArtifactAssertion,
  isComplete: boolean,
  recorder: ReadbackRecorder,
): Promise<ArtifactReadback> {
  const status: ReadbackStatus = isComplete ? assertion.status : 'unverified';
  const mismatches = status === 'unverified' ? Object.freeze([]) : assertion.mismatches;
  const evidence = await recorder.recordArtifact({ ...input, status, mismatches });
  if (status === 'matched' && !evidence.verificationId) throw new Error('matched_readback_requires_persisted_verification');
  return Object.freeze({
    effectKey: input.effect.effectKey,
    kind: input.effect.kind,
    providerId: input.providerId,
    status,
    mismatches,
    observationIds: Object.freeze([...evidence.observationIds]),
    verificationId: evidence.verificationId,
    observedAt: evidence.observedAt,
    receipt: evidence.receipt,
  });
}

async function prepareReads(
  plan: ImmutablePlan,
  effect: PlannedEffect,
  effectIds: ResolvedEffectIds,
  options: ReadbackVerifierOptions,
): Promise<PreparedReads> {
  switch (effect.kind) {
    case 'task': {
      const bindingContext = makeContext(plan, effect, options, 'hubspot.findTasks', 'binding');
      const bindingResult = await options.readers.hubspot.findTasks(effect.effectKey, bindingContext);
      return {
        binding: { purpose: 'binding', context: bindingContext, result: bindingResult },
        candidateProviderIds: bindingResult.status === 'complete' ? bindingResult.data.map(candidate => candidate.id) : [],
        read: async providerId => {
          const context = makeContext(plan, effect, options, 'hubspot.getTask', 'artifact');
          const result = await options.readers.hubspot.getTask(providerId, context);
          return { read: { purpose: 'artifact', context, result },
            assertion: result.status === 'complete'
              ? assertTaskReadback(plan, effect, providerId, result.data, effectIds)
              : assertUniqueProviderBinding(providerId, [providerId]) };
        },
      };
    }
    case 'note': {
      const bindingContext = makeContext(plan, effect, options, 'hubspot.findNotes', 'binding');
      const bindingResult = await options.readers.hubspot.findNotes(effect.effectKey, bindingContext);
      return {
        binding: { purpose: 'binding', context: bindingContext, result: bindingResult },
        candidateProviderIds: bindingResult.status === 'complete' ? bindingResult.data.map(candidate => candidate.id) : [],
        read: async providerId => {
          const context = makeContext(plan, effect, options, 'hubspot.getNote', 'artifact');
          const result = await options.readers.hubspot.getNote(providerId, context);
          return { read: { purpose: 'artifact', context, result },
            assertion: result.status === 'complete'
              ? assertNoteReadback(plan, effect, providerId, result.data, effectIds)
              : assertUniqueProviderBinding(providerId, [providerId]) };
        },
      };
    }
    case 'draft': {
      const bindingContext = makeContext(plan, effect, options, 'gmail.findDrafts', 'binding');
      const bindingResult = await options.readers.gmail.findDrafts(effect.effectKey, bindingContext);
      return {
        binding: { purpose: 'binding', context: bindingContext, result: bindingResult },
        candidateProviderIds: bindingResult.status === 'complete' ? bindingResult.data.map(candidate => candidate.draftId) : [],
        read: async providerId => {
          const context = makeContext(plan, effect, options, 'gmail.getDraft', 'artifact');
          const result = await options.readers.gmail.getDraft(providerId, context);
          return { read: { purpose: 'artifact', context, result },
            assertion: result.status === 'complete'
              ? assertDraftReadback(plan, effect, providerId, result.data, effectIds)
              : assertUniqueProviderBinding(providerId, [providerId]) };
        },
      };
    }
    case 'comment': {
      const bindingContext = makeContext(plan, effect, options, 'github.findComments', 'binding');
      const bindingResult = await options.readers.github.findComments(
        plan.incident,
        githubCommentMarker(effect.effectKey),
        bindingContext,
      );
      return {
        binding: { purpose: 'binding', context: bindingContext, result: bindingResult },
        candidateProviderIds: bindingResult.status === 'complete' ? bindingResult.data.map(candidate => candidate.id) : [],
        read: async providerId => {
          const context = makeContext(plan, effect, options, 'github.getComment', 'artifact');
          const result = await options.readers.github.getComment(providerId, context);
          return { read: { purpose: 'artifact', context, result },
            assertion: result.status === 'complete'
              ? assertCommentReadback(plan, effect, providerId, result.data, effectIds)
              : assertUniqueProviderBinding(providerId, [providerId]) };
        },
      };
    }
    case 'thread': {
      if (!options.expectedSlackWorkspaceId) throw new Error('slack_workspace_required');
      const bindingContext = makeContext(plan, effect, options, 'slack.readApprovalThread', 'binding');
      const bindingResult = await options.readers.slack.readApprovalThread(
        effect.payload.channelId, effect.payload.threadTs, bindingContext);
      // The approval message quotes the entire plan, including this marker. Only
      // an artifact starting with the frozen summary prefix is a candidate.
      const firstPart = effect.payload.body[0];
      const prefix = firstPart?.type === 'text' ? firstPart.text : null;
      if (!prefix) throw new Error('summary_prefix_missing');
      return {
        binding: { purpose: 'binding', context: bindingContext, result: bindingResult },
        candidateProviderIds: bindingResult.status === 'complete' ? bindingResult.data
          .filter(candidate => candidate.body.startsWith(prefix) && candidate.body.includes(effect.effectKey))
          .map(candidate => candidate.messageTs) : [],
        read: async providerId => {
          const context = makeContext(plan, effect, options, 'slack.readSummary', 'artifact');
          const result = await options.readers.slack.readSummary(effect.payload.channelId, providerId, context);
          return { read: { purpose: 'artifact', context, result },
            assertion: result.status === 'complete'
              ? assertSlackSummaryReadback(plan, effect, providerId, options.expectedSlackWorkspaceId!, result.data, effectIds)
              : assertUniqueProviderBinding(providerId, [providerId]) };
        },
      };
    }
  }
}

export async function verifyArtifactReadback(
  plan: ImmutablePlan,
  effect: PlannedEffect,
  record: EffectRecord,
  effectIds: ResolvedEffectIds,
  options: ReadbackVerifierOptions,
): Promise<ArtifactReadback> {
  if (record.runId !== plan.runId || record.effectKey !== effect.effectKey || record.requestDigest !== effect.requestDigest ||
      !record.providerId || !['applied', 'verified'].includes(record.state) || record.outcome?.status !== 'applied') {
    return incompleteResult(effect);
  }

  const prepared = await prepareReads(plan, effect, effectIds, options);
  const reads = [prepared.binding];
  if (prepared.binding.result.status === 'incomplete') {
    return persistResult({ plan, effect, providerId: record.providerId, reads },
      assertUniqueProviderBinding(record.providerId, []), false, options.recorder);
  }

  const bindingAssertion = assertUniqueProviderBinding(record.providerId, prepared.candidateProviderIds);
  if (bindingAssertion.status === 'mismatched') {
    return persistResult({ plan, effect, providerId: record.providerId, reads }, bindingAssertion, true, options.recorder);
  }

  const providerId = prepared.candidateProviderIds[0]!;
  const artifact = await prepared.read(providerId);
  reads.push(artifact.read);
  return persistResult(
    { plan, effect, providerId, reads },
    combineAssertions(bindingAssertion, artifact.assertion),
    artifact.read.result.status === 'complete',
    options.recorder,
  );
}

export async function verifyBusinessArtifacts(
  planValue: ImmutablePlan,
  records: readonly EffectRecord[],
  options: ReadbackVerifierOptions,
): Promise<PlanReadbackReport> {
  const plan = await verifyPlanIntegrity(planValue);
  const artifacts: ArtifactReadback[] = [];
  const effectIds: Record<string, string> = {};
  const businessEffects = plan.effects.filter((effect): effect is BusinessEffect => effect.kind !== 'thread');

  for (const effect of businessEffects) {
    const record = records.find(candidate => candidate.effectKey === effect.effectKey);
    if (!record) {
      artifacts.push(incompleteResult(effect));
      break;
    }
    const result = await verifyArtifactReadback(plan, effect, record, effectIds, options);
    artifacts.push(result);
    if (result.status !== 'matched' || !result.providerId) break;
    effectIds[effect.effectKey] = result.providerId;
  }

  let protectedRecords: ScopeReadback | null = null;
  if (artifacts.length === businessEffects.length && artifacts.every(result => result.status === 'matched') &&
      plan.selection.excluded.length > 0) {
    const expectedIds = plan.selection.excluded.map(record => record.commitmentId);
    const expected = options.protectedCommitments ?? [];
    if (expectedIds.some(id => !expected.some(record => record.id === id))) {
      protectedRecords = emptyScope('protected-commitments');
    } else {
      const context = options.createContext({ operation: 'hubspot.readCommitmentBundle', effectKey: null, purpose: 'scope' });
      if (context.runId !== plan.runId || context.app !== 'hubspot' || context.operation !== 'hubspot.readCommitmentBundle') {
        throw new Error('invalid_readback_context');
      }
      const result = await options.readers.hubspot.readCommitmentBundle(plan.incident.service, context);
      const assertion = result.status === 'complete'
        ? assertProtectedCommitments(expected, result.data.commitments)
        : assertUniqueProviderBinding('protected-scope', []);
      protectedRecords = await persistScope('protected-commitments',
        { purpose: 'scope', context, result }, assertion, options.recorder);
    }
  }

  const status: ReadbackStatus = artifacts.length === businessEffects.length && artifacts.every(result => result.status === 'matched') &&
      (!protectedRecords || protectedRecords.status === 'matched')
    ? 'matched'
    : artifacts.some(result => result.status === 'mismatched') || protectedRecords?.status === 'mismatched' ? 'mismatched' : 'unverified';
  return Object.freeze({ planHash: plan.planHash, status, artifacts: Object.freeze(artifacts),
    effectIds: Object.freeze(effectIds), protectedRecords });
}

export async function verifyNoAffected(
  input: NoAffectedVerificationInput,
): Promise<NoAffectedVerificationResult> {
  if (input.selection.selected.length > 0 || !input.selection.sourceComplete || input.absencePredicates.length === 0 ||
      input.sourceReceipts.some(receipt => receipt.status !== 'complete') ||
      !['github', 'hubspot'].every(app => input.sourceReceipts.some(receipt => receipt.app === app))) {
    return Object.freeze({ status: 'unverified', proof: null, evidence: Object.freeze([]) });
  }
  const evidence: ScopeReadback[] = [];
  for (const predicate of input.absencePredicates) {
    IdSchema.parse(predicate.predicateId);
    const observed = await predicate.read();
    if (observed.context.runId !== input.runId || observed.context.operation.split('.')[0] !== observed.context.app) {
      throw new Error('invalid_absence_context');
    }
    const assertion = observed.result.status === 'complete' && predicate.isAbsent(observed.result.data)
      ? assertUniqueProviderBinding('absence-confirmed', ['absence-confirmed'])
      : observed.result.status === 'complete'
        ? { status: 'mismatched' as const, mismatches: Object.freeze(['absence_predicate_failed'] as const) }
        : assertUniqueProviderBinding('absence-confirmed', []);
    const result = await persistScope(predicate.predicateId,
      { purpose: 'scope', context: observed.context, result: observed.result }, assertion, input.recorder);
    evidence.push(result);
    if (result.status !== 'matched') {
      return Object.freeze({ status: result.status, proof: null, evidence: Object.freeze(evidence) });
    }
  }
  const proof: NoAffectedCompletionProof = {
    scope: 'no_affected', sourceReceipts: [...input.sourceReceipts],
    selection: { eligibleCount: 0, sourceComplete: true, policyVersion: input.selection.policyVersion,
      receipt: input.selectionRef },
    absenceEvidence: evidence.map(result => ({ predicateId: result.scopeId, status: 'confirmed' as const,
      receipt: result.receipt! })), protectedMutationCount: 0, modelCallCount: 0,
  };
  return Object.freeze({ status: 'matched', evidence: Object.freeze(evidence), proof });
}

export async function verifySlackSummary(
  planValue: ImmutablePlan,
  record: EffectRecord,
  effectIds: ResolvedEffectIds,
  options: ReadbackVerifierOptions,
): Promise<ArtifactReadback> {
  const plan = await verifyPlanIntegrity(planValue);
  const effect = plan.effects.find((candidate): candidate is ThreadEffect => candidate.kind === 'thread');
  if (!effect) throw new Error('summary_effect_missing');
  return verifyArtifactReadback(plan, effect, record, effectIds, options);
}

export function createApplicationReadbackRecorder(options: ApplicationReadbackRecorderOptions): ReadbackRecorder {
  const createId = options.createId ?? randomUUID;
  return Object.freeze({
    recordArtifact(input: ReadbackRecordInput): PersistedReadbackEvidence {
      if (input.reads.length === 0) throw new Error('readback_observation_required');
      const lastRead = input.reads.at(-1)!;
      const verificationAttemptId = lastRead.purpose === 'artifact' && lastRead.result.status === 'complete'
        ? lastRead.result.receipt.pages.find(page => page.queryId === lastRead.result.receipt.requiredQueryIds[0])?.providerAttemptId
        : undefined;
      const persistedAttempt = verificationAttemptId
        ? options.repository.getProviderAttempt(verificationAttemptId)?.context
        : null;
      if (persistedAttempt && ('requestDigest' in persistedAttempt || 'marker' in persistedAttempt)) {
        throw new Error('verification_read_attempt_invalid');
      }
      const eventReadContext = persistedAttempt ?? lastRead.context;
      const eventContext = options.eventContext(eventReadContext);
      if (!['execute', 'verify'].includes(eventContext.stage) || eventContext.runId !== eventReadContext.runId ||
          eventContext.evaluationAttemptId !== eventReadContext.evaluationAttemptId ||
          eventContext.runtimeAttemptId !== eventReadContext.runtimeAttemptId || eventContext.spanId !== eventReadContext.spanId) {
        throw new Error('readback_event_context_mismatch');
      }
      const stamp = options.stamp();
      if (input.reads.some(read => Date.parse(read.result.receipt.finishedAt) > Date.parse(stamp.at))) {
        throw new Error('readback_event_precedes_observation');
      }

      return options.repository.transaction(eventContext, writer => {
        const run = writer.getRun(input.plan.runId);
        if (!run || input.plan.planHash !== writer.getPlan(input.plan.runId, input.plan.revision)?.planHash) {
          throw new Error('readback_plan_missing');
        }
        const scopeRef = writer.putArtifact({ artifactId: createId(), mediaType: 'application/json', content: {
          schemaVersion: 2, runId: input.plan.runId, planHash: input.plan.planHash,
          effectKey: input.effect.effectKey, providerId: input.providerId,
        } });
        const observationIds: string[] = [];
        for (const read of input.reads) {
          const observationId = IdSchema.parse(createId());
          const objectsRef = writer.putArtifact({ artifactId: createId(), mediaType: 'application/json',
            content: read.result.status === 'complete' ? read.result.data : read.result.partialData ?? null });
          writer.recordObservation(ImportedObservationSchema.parse({
            schemaVersion: 2, observationId, runId: read.context.runId,
            evaluationAttemptId: read.context.evaluationAttemptId, runtimeAttemptId: read.context.runtimeAttemptId,
            mode: run.configuration.evidenceMode, phase: 'claim_window', receipt: read.result.receipt, scopeRef,
            producer: { producerId: read.result.receipt.producerId, version: 'readback-verifier-v1',
              processId: stamp.processId, bootId: stamp.bootId }, objectsRef,
          }));
          observationIds.push(observationId);
        }

        const reportRef = writer.putArtifact({ artifactId: createId(), mediaType: 'application/json', content: {
          schemaVersion: 2, runId: input.plan.runId, planHash: input.plan.planHash,
          effectKey: input.effect.effectKey, providerId: input.providerId, status: input.status,
          mismatches: input.mismatches, observationIds, observedAt: lastRead.result.receipt.finishedAt,
        } });
        const mayRecordVerification = lastRead.purpose === 'artifact' && lastRead.result.status === 'complete' && input.status !== 'unverified';
        let verificationId: string | null = null;
        if (mayRecordVerification) {
          verificationId = IdSchema.parse(createId());
          const payload = { kind: 'effect.verified' as const, verificationId, effectKey: input.effect.effectKey,
            planHash: input.plan.planHash, artifactKind: input.effect.kind, verdict: input.status,
            readAttemptId: eventReadContext.providerAttemptId, receiptRef: reportRef };
          const event = createCanonicalEvent({ context: eventContext, payload,
            sequence: writer.getRun(input.plan.runId)!.eventSequence + 1, stamp });
          if (event.kind !== 'effect.verified') throw new Error('verification_event_invalid');
          writer.recordVerification({ observationId: observationIds.at(-1)!, event, providerId: input.providerId });
          writer.appendEvent(payload, stamp);
        } else {
          writer.appendEvent({ kind: 'fault.recorded', faultId: IdSchema.parse(createId()), evidenceRef: reportRef }, stamp);
        }
        return Object.freeze({ observationIds: Object.freeze(observationIds), verificationId,
          observedAt: lastRead.result.receipt.finishedAt, receipt: reportRef });
      });
    },
    recordScope(input: ScopeReadbackRecordInput): PersistedReadbackEvidence {
      const eventContext = options.eventContext(input.read.context);
      if (eventContext.stage !== 'verify' || eventContext.runId !== input.read.context.runId ||
          eventContext.evaluationAttemptId !== input.read.context.evaluationAttemptId ||
          eventContext.runtimeAttemptId !== input.read.context.runtimeAttemptId || eventContext.spanId !== input.read.context.spanId) {
        throw new Error('readback_event_context_mismatch');
      }
      const stamp = options.stamp();
      if (Date.parse(input.read.result.receipt.finishedAt) > Date.parse(stamp.at)) throw new Error('readback_event_precedes_observation');
      return options.repository.transaction(eventContext, writer => {
        const run = writer.getRun(input.read.context.runId);
        if (!run) throw new Error('run_not_found');
        const scopeRef = writer.putArtifact({ artifactId: createId(), mediaType: 'application/json', content: {
          schemaVersion: 2, runId: input.read.context.runId, scopeId: input.scopeId,
        } });
        const objectsRef = writer.putArtifact({ artifactId: createId(), mediaType: 'application/json',
          content: input.read.result.status === 'complete' ? input.read.result.data : input.read.result.partialData ?? null });
        const observationId = IdSchema.parse(createId());
        writer.recordObservation(ImportedObservationSchema.parse({ schemaVersion: 2, observationId,
          runId: input.read.context.runId, evaluationAttemptId: input.read.context.evaluationAttemptId,
          runtimeAttemptId: input.read.context.runtimeAttemptId, mode: run.configuration.evidenceMode,
          phase: 'claim_window', receipt: input.read.result.receipt, scopeRef,
          producer: { producerId: input.read.result.receipt.producerId, version: 'readback-verifier-v1',
            processId: stamp.processId, bootId: stamp.bootId }, objectsRef }));
        const reportRef = writer.putArtifact({ artifactId: createId(), mediaType: 'application/json', content: {
          schemaVersion: 2, runId: input.read.context.runId, scopeId: input.scopeId,
          status: input.status, mismatches: input.mismatches, observationId,
        } });
        if (input.status === 'matched') {
          writer.appendEvent({ kind: 'sources.collected', complete: true, collectionRefs: [objectsRef] }, stamp);
        } else {
          writer.appendEvent({ kind: 'fault.recorded', faultId: IdSchema.parse(createId()), evidenceRef: reportRef }, stamp);
        }
        return Object.freeze({ observationIds: Object.freeze([observationId]), verificationId: null,
          observedAt: input.read.result.receipt.finishedAt, receipt: objectsRef });
      });
    },
  });
}
