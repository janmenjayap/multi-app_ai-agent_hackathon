import { randomUUID } from 'node:crypto';

import {
  GitHubCommentSchema,
  GmailDraftSchema,
  HubSpotNoteSchema,
  HubSpotTaskSchema,
  ReadCallContextSchema,
  type ReadCallContext,
} from '../../shared/adapters.js';
import {
  CollectionReceiptSchema,
  canonical,
  readResultSchema,
  verifyPlanIntegrity,
  type EffectRecord,
  type ImmutablePlan,
  type MutationOutcome,
  type PlannedEffect,
  type RestrictedArtifactRef,
} from '../../shared/domain.js';
import { ImportedObservationSchema } from '../../shared/evaluation.js';
import { githubCommentMarker } from '../adapters/github.js';
import { createCanonicalEvent, type EventContext, type EventStamp } from '../observability/events.js';
import { verifyObservedCollection } from '../policy/freshness.js';
import { ApplicationRepository } from '../storage/repositories.js';
import {
  assertCommentReadback,
  assertDraftReadback,
  assertNoteReadback,
  assertTaskReadback,
  type ArtifactAssertion,
  type ArtifactMismatchCode,
  type ResolvedEffectIds,
} from '../verification/assertions.js';
import type { ReadbackContextFactory, ReadbackRead, ReadbackReaders } from '../verification/readback.js';

type BusinessEffect = Exclude<PlannedEffect, { kind: 'thread' }>;
type ReadOperation = ReadCallContext['operation'];

export interface ReconcileEffectOptions {
  repository: ApplicationRepository;
  plan: ImmutablePlan;
  effect: BusinessEffect;
  readers: Pick<ReadbackReaders, 'github' | 'hubspot' | 'gmail'>;
  /** Readers use the durable adapter observer; this factory never supplies cached reads. */
  createContext: ReadbackContextFactory;
  eventContext(context: ReadCallContext): EventContext;
  stamp(): EventStamp;
  createId?: () => string;
}

export interface ReconciliationResult {
  resolution: 'adopted' | 'unresolved' | 'conflict';
  record: EffectRecord;
  observationIds: readonly string[];
  receipt: RestrictedArtifactRef;
  mismatches: readonly ArtifactMismatchCode[];
}

interface MarkerLookup {
  read: ReadbackRead;
  candidateIds: readonly string[];
  get(providerId: string): Promise<{ read: ReadbackRead; assertion: ArtifactAssertion | null }>;
}

function makeContext<Operation extends ReadOperation>(
  options: ReconcileEffectOptions,
  operation: Operation,
  purpose: 'binding' | 'artifact',
): ReadCallContext & { operation: Operation } {
  const context = ReadCallContextSchema.parse(options.createContext({
    operation, effectKey: options.effect.effectKey, purpose,
  }));
  const reader = options.readers[options.effect.app];
  if (context.operation !== operation || context.runId !== options.plan.runId ||
      context.app !== options.effect.app || context.accountRef !== reader.scope.accountRef ||
      context.mode !== reader.mode) throw new Error('reconciliation_context_mismatch');
  return { ...context, operation };
}

/** Expected IDs come only from independently verified, earlier ledger entries. */
function verifiedBindings(options: ReconcileEffectOptions): ResolvedEffectIds {
  const { plan, effect, repository } = options;
  const index = plan.effects.findIndex(candidate => candidate.effectKey === effect.effectKey);
  const refs = effect.payload.body.filter(part => part.type === 'effect_id').map(part => part.effectKey);
  if (effect.kind === 'note' && typeof effect.payload.taskId !== 'string') refs.push(effect.payload.taskId.effectKey);
  if (effect.kind === 'comment') refs.push(...effect.payload.taskIds.map(ref => ref.effectKey),
    ...effect.payload.draftIds.map(ref => ref.effectKey));
  const bindings: Record<string, string> = {};
  for (const effectKey of new Set(refs)) {
    const expected = plan.effects.slice(0, index).find(candidate => candidate.effectKey === effectKey);
    const record = repository.getEffect(effectKey);
    if (!expected || !record || record.runId !== plan.runId || record.requestDigest !== expected.requestDigest ||
        record.state !== 'verified' || !record.verificationRef || !record.providerId || record.outcome?.status !== 'applied') {
      throw new Error('reconciliation_dependency_unverified');
    }
    bindings[effectKey] = record.providerId;
  }
  return Object.freeze(bindings);
}

async function findCandidates(options: ReconcileEffectOptions, effectIds: ResolvedEffectIds): Promise<MarkerLookup> {
  const { plan, effect, readers } = options;
  switch (effect.kind) {
    case 'task': {
      const context = makeContext(options, 'hubspot.findTasks', 'binding');
      const result = readResultSchema(HubSpotTaskSchema.array()).parse(
        await readers.hubspot.findTasks(effect.effectKey, context));
      return { read: { purpose: 'binding', context, result },
        candidateIds: result.status === 'complete' ? result.data.map(candidate => candidate.id) : [],
        get: async providerId => {
          const context = makeContext(options, 'hubspot.getTask', 'artifact');
          const result = readResultSchema(HubSpotTaskSchema.nullable()).parse(
            await readers.hubspot.getTask(providerId, context));
          return { read: { purpose: 'artifact', context, result }, assertion: result.status === 'complete'
            ? assertTaskReadback(plan, effect, providerId, result.data, effectIds) : null };
        } };
    }
    case 'note': {
      const context = makeContext(options, 'hubspot.findNotes', 'binding');
      const result = readResultSchema(HubSpotNoteSchema.array()).parse(
        await readers.hubspot.findNotes(effect.effectKey, context));
      return { read: { purpose: 'binding', context, result },
        candidateIds: result.status === 'complete' ? result.data.map(candidate => candidate.id) : [],
        get: async providerId => {
          const context = makeContext(options, 'hubspot.getNote', 'artifact');
          const result = readResultSchema(HubSpotNoteSchema.nullable()).parse(
            await readers.hubspot.getNote(providerId, context));
          return { read: { purpose: 'artifact', context, result }, assertion: result.status === 'complete'
            ? assertNoteReadback(plan, effect, providerId, result.data, effectIds) : null };
        } };
    }
    case 'draft': {
      const context = makeContext(options, 'gmail.findDrafts', 'binding');
      const result = readResultSchema(GmailDraftSchema.array()).parse(
        await readers.gmail.findDrafts(effect.effectKey, context));
      return { read: { purpose: 'binding', context, result },
        candidateIds: result.status === 'complete' ? result.data.map(candidate => candidate.draftId) : [],
        get: async providerId => {
          const context = makeContext(options, 'gmail.getDraft', 'artifact');
          const result = readResultSchema(GmailDraftSchema.nullable()).parse(
            await readers.gmail.getDraft(providerId, context));
          return { read: { purpose: 'artifact', context, result }, assertion: result.status === 'complete'
            ? assertDraftReadback(plan, effect, providerId, result.data, effectIds) : null };
        } };
    }
    case 'comment': {
      const context = makeContext(options, 'github.findComments', 'binding');
      const result = readResultSchema(GitHubCommentSchema.array()).parse(
        await readers.github.findComments(plan.incident, githubCommentMarker(effect.effectKey), context));
      return { read: { purpose: 'binding', context, result },
        candidateIds: result.status === 'complete' ? result.data.map(candidate => candidate.id) : [],
        get: async providerId => {
          const context = makeContext(options, 'github.getComment', 'artifact');
          const result = readResultSchema(GitHubCommentSchema.nullable()).parse(
            await readers.github.getComment(providerId, context));
          return { read: { purpose: 'artifact', context, result }, assertion: result.status === 'complete'
            ? assertCommentReadback(plan, effect, providerId, result.data, effectIds) : null };
        } };
    }
  }
}

/** Reject receipts that cannot be joined to this independent, durably recorded read. */
function validateRead(repository: ApplicationRepository, read: ReadbackRead): void {
  const receipt = CollectionReceiptSchema.parse(read.result.receipt);
  if (receipt.status !== read.result.status || receipt.app !== read.context.app ||
      receipt.accountRef !== read.context.accountRef) throw new Error('reconciliation_receipt_mismatch');
  for (const page of receipt.pages) {
    const attempt = repository.getProviderAttempt(page.providerAttemptId);
    if (!attempt?.receipt || 'requestDigest' in attempt.context ||
        attempt.context.runId !== read.context.runId ||
        attempt.context.evaluationAttemptId !== read.context.evaluationAttemptId ||
        attempt.context.runtimeAttemptId !== read.context.runtimeAttemptId ||
        attempt.context.logicalCallId !== read.context.logicalCallId ||
        attempt.context.operation !== read.context.operation || attempt.context.app !== read.context.app ||
        attempt.context.accountRef !== read.context.accountRef || attempt.context.mode !== read.context.mode ||
        canonical(attempt.receipt.responseRef) !== canonical(page.response) ||
        (receipt.status === 'complete' && attempt.receipt.providerOutcome !== 'success')) {
      throw new Error('reconciliation_read_attempt_missing');
    }
  }
}

function persistReconciliation(
  options: ReconcileEffectOptions,
  reads: readonly ReadbackRead[],
  resolution: ReconciliationResult['resolution'],
  providerId: string | null,
  mismatches: readonly ArtifactMismatchCode[],
  notBefore: string,
): ReconciliationResult {
  const createId = options.createId ?? randomUUID;
  for (const read of reads) validateRead(options.repository, read);
  // A complete binding read can durably describe an unresolved exact read. If no
  // complete read exists, preserve the incomplete observation as a fault instead.
  const evidenceIndex = reads.findLastIndex(read => read.result.status === 'complete');
  const evidenceRead = reads[evidenceIndex] ?? reads.at(-1)!;
  const page = evidenceIndex >= 0 ? evidenceRead.result.receipt.pages.at(-1) : undefined;
  const context = page ? options.repository.getProviderAttempt(page.providerAttemptId)!.context : evidenceRead.context;
  if ('requestDigest' in context) throw new Error('reconciliation_requires_independent_read');
  const eventContext = options.eventContext(context);
  if (eventContext.runId !== context.runId || eventContext.runtimeAttemptId !== context.runtimeAttemptId ||
      eventContext.evaluationAttemptId !== context.evaluationAttemptId || eventContext.spanId !== context.spanId) {
    throw new Error('reconciliation_event_context_mismatch');
  }
  const stamp = options.stamp();
  for (const read of reads) {
    if (read.result.status === 'complete') {
      verifyObservedCollection({ repository: options.repository, receipt: read.result.receipt, context: read.context,
        checkedAt: stamp.at, maxAgeMs: read.context.budgets.totalMs, notBefore });
    }
  }
  if (reads.some(read => Date.parse(read.result.receipt.finishedAt) > Date.parse(stamp.at))) {
    throw new Error('reconciliation_event_precedes_observation');
  }
  return options.repository.transaction(eventContext, writer => {
    const run = writer.getRun(options.plan.runId);
    const record = writer.getEffect(options.effect.effectKey);
    if (!run || !record || record.state !== 'inflight' ||
        writer.getPlan(options.plan.runId, options.plan.revision)?.planHash !== options.plan.planHash) {
      throw new Error('reconciliation_effect_changed');
    }
    const scopeRef = writer.putArtifact({ artifactId: createId(), mediaType: 'application/json', content: {
      schemaVersion: 2, runId: options.plan.runId, planHash: options.plan.planHash,
      planRevision: options.plan.revision, effectKey: options.effect.effectKey, providerId,
    } });
    const observationIds = reads.map(read => {
      const observationId = createId();
      const objectsRef = writer.putArtifact({ artifactId: createId(), mediaType: 'application/json',
        content: read.result.status === 'complete' ? read.result.data : read.result.partialData ?? null });
      writer.recordObservation(ImportedObservationSchema.parse({
        schemaVersion: 2, observationId, runId: read.context.runId,
        evaluationAttemptId: read.context.evaluationAttemptId, runtimeAttemptId: read.context.runtimeAttemptId,
        mode: run.configuration.evidenceMode, phase: 'claim_window', receipt: read.result.receipt, scopeRef, objectsRef,
        producer: { producerId: read.result.receipt.producerId, version: 'effect-reconciliation-v1',
          processId: stamp.processId, bootId: stamp.bootId },
      }));
      return observationId;
    });
    const receipt = writer.putArtifact({ artifactId: createId(), mediaType: 'application/json', content: {
      schemaVersion: 2, runId: options.plan.runId, planHash: options.plan.planHash,
      planRevision: options.plan.revision, effectKey: options.effect.effectKey,
      requestDigest: options.effect.requestDigest, resolution, providerId, mismatches, observationIds,
    } });
    if (page) {
      const payload = { kind: 'effect.reconciled' as const, effectKey: options.effect.effectKey,
        resolution, providerId, readAttemptId: page.providerAttemptId, receiptRef: receipt };
      const event = createCanonicalEvent({ context: eventContext, payload, stamp,
        sequence: writer.getRun(options.plan.runId)!.eventSequence + 1 });
      if (event.kind !== 'effect.reconciled') throw new Error('invalid_reconciliation_event');
      const outcome: MutationOutcome = resolution === 'adopted'
        ? { status: 'applied', providerId: providerId!, receipt }
        : { status: 'unknown', reason: record.outcome?.status === 'unknown' ? record.outcome.reason : 'transport_error', receipt };
      writer.reconcileEffect({ event, observationId: observationIds[evidenceIndex]!, outcome });
      writer.appendEvent(payload, stamp);
    } else {
      writer.appendEvent({ kind: 'fault.recorded', faultId: createId(), evidenceRef: receipt }, stamp);
    }
    return Object.freeze({ resolution, record: writer.getEffect(options.effect.effectKey)!,
      observationIds: Object.freeze(observationIds), receipt, mismatches: Object.freeze([...mismatches]) });
  });
}

/** One settling pass. Empty or incomplete reads never release a claim or authorize another create. */
export async function reconcileEffect(input: ReconcileEffectOptions): Promise<ReconciliationResult> {
  const storedPlan = input.repository.getPlan(input.plan.runId, input.plan.revision);
  if (!storedPlan || canonical(storedPlan) !== canonical(input.plan)) throw new Error('reconciliation_plan_mismatch');
  const plan = await verifyPlanIntegrity(storedPlan);
  const effect = plan.effects.find(candidate => candidate.effectKey === input.effect.effectKey);
  const record = input.repository.getEffect(input.effect.effectKey);
  if (!effect || effect.kind === 'thread' || canonical(effect) !== canonical(input.effect) || !record ||
      record.runId !== plan.runId || record.requestDigest !== effect.requestDigest || record.state !== 'inflight') {
    throw new Error('reconciliation_effect_mismatch');
  }
  const options = { ...input, plan, effect };
  const startedAt = options.stamp().at;
  const lookup = await findCandidates(options, verifiedBindings(options));
  const reads = [lookup.read];
  if (lookup.read.result.status !== 'complete' || lookup.candidateIds.length === 0) {
    return persistReconciliation(options, reads, 'unresolved', null, [], startedAt);
  }
  if (lookup.candidateIds.length !== 1) {
    return persistReconciliation(options, reads, 'conflict', null, ['duplicate_marker'], startedAt);
  }
  const providerId = lookup.candidateIds[0]!;
  let artifact: Awaited<ReturnType<MarkerLookup['get']>>;
  try {
    artifact = await lookup.get(providerId);
  } catch {
    // The durable marker observation still describes uncertainty if the exact
    // read cannot return (including lost read-receipt persistence).
    return persistReconciliation(options, reads, 'unresolved', null, [], startedAt);
  }
  reads.push(artifact.read);
  if (!artifact.assertion) return persistReconciliation(options, reads, 'unresolved', null, [], startedAt);
  if (artifact.assertion.mismatches.includes('missing_record')) {
    return persistReconciliation(options, reads, 'unresolved', null, artifact.assertion.mismatches, startedAt);
  }
  if (artifact.assertion.status !== 'matched') {
    return persistReconciliation(options, reads, 'conflict', null, artifact.assertion.mismatches, startedAt);
  }
  return persistReconciliation(options, reads, 'adopted', providerId, [], startedAt);
}

/** A planned effect may be created only after a fresh, complete marker search proves absence. */
export async function inspectPlannedEffect(
  input: ReconcileEffectOptions,
): Promise<'absent' | 'present' | 'unavailable'> {
  const storedPlan = input.repository.getPlan(input.plan.runId, input.plan.revision);
  if (!storedPlan || canonical(storedPlan) !== canonical(input.plan)) throw new Error('reconciliation_plan_mismatch');
  const plan = await verifyPlanIntegrity(storedPlan);
  const effect = plan.effects.find(candidate => candidate.effectKey === input.effect.effectKey);
  const record = input.repository.getEffect(input.effect.effectKey);
  if (!effect || effect.kind === 'thread' || canonical(effect) !== canonical(input.effect) || !record ||
      record.runId !== plan.runId || record.requestDigest !== effect.requestDigest || record.state !== 'planned') {
    throw new Error('reconciliation_effect_mismatch');
  }
  const options = { ...input, plan, effect };
  const startedAt = options.stamp().at;
  const lookup = await findCandidates(options, verifiedBindings(options));
  const read = lookup.read;
  const stamp = options.stamp();
  validateRead(options.repository, read);
  if (read.result.status === 'complete') {
    verifyObservedCollection({ repository: options.repository, receipt: read.result.receipt, context: read.context,
      checkedAt: stamp.at, maxAgeMs: read.context.budgets.totalMs, notBefore: startedAt });
  }
  const status = read.result.status === 'complete'
    ? lookup.candidateIds.length === 0 ? 'absent' : 'present'
    : 'unavailable';
  const context = options.eventContext(read.context);
  if (context.runId !== read.context.runId || context.runtimeAttemptId !== read.context.runtimeAttemptId ||
      context.evaluationAttemptId !== read.context.evaluationAttemptId || context.spanId !== read.context.spanId ||
      Date.parse(read.result.receipt.finishedAt) > Date.parse(stamp.at)) {
    throw new Error('reconciliation_event_context_mismatch');
  }
  const createId = options.createId ?? randomUUID;
  return options.repository.transaction(context, writer => {
    const run = writer.getRun(plan.runId);
    if (!run || writer.getEffect(effect.effectKey)?.state !== 'planned' ||
        writer.getPlan(plan.runId, plan.revision)?.planHash !== plan.planHash) {
      throw new Error('reconciliation_effect_changed');
    }
    const scopeRef = writer.putArtifact({ artifactId: createId(), mediaType: 'application/json', content: {
      schemaVersion: 2, runId: plan.runId, planHash: plan.planHash, planRevision: plan.revision,
      effectKey: effect.effectKey, purpose: 'pre_dispatch_marker_lookup',
    } });
    const objectsRef = writer.putArtifact({ artifactId: createId(), mediaType: 'application/json',
      content: read.result.status === 'complete' ? read.result.data : read.result.partialData ?? null });
    const observationId = createId();
    writer.recordObservation(ImportedObservationSchema.parse({
      schemaVersion: 2, observationId, runId: read.context.runId,
      evaluationAttemptId: read.context.evaluationAttemptId, runtimeAttemptId: read.context.runtimeAttemptId,
      mode: run.configuration.evidenceMode, phase: 'claim_window', receipt: read.result.receipt, scopeRef, objectsRef,
      producer: { producerId: read.result.receipt.producerId, version: 'effect-reconciliation-v1',
        processId: stamp.processId, bootId: stamp.bootId },
    }));
    const report = writer.putArtifact({ artifactId: createId(), mediaType: 'application/json', content: {
      schemaVersion: 2, runId: plan.runId, planHash: plan.planHash, planRevision: plan.revision,
      effectKey: effect.effectKey, requestDigest: effect.requestDigest,
      purpose: 'pre_dispatch_marker_lookup', status, observationId, candidateIds: lookup.candidateIds,
    } });
    writer.appendEvent({ kind: 'fault.recorded', faultId: createId(), evidenceRef: report }, stamp);
    return status;
  });
}
