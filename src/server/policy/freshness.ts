import { z } from 'zod';
import { ReadCallContextSchema, type ReadCallContext } from '../../shared/adapters.js';
import { CollectionReceiptSchema, UtcTimestampSchema, canonical, immutable, verifyPlanIntegrity,
  type CollectionReceipt, type ImmutablePlan, type SnapshotRef } from '../../shared/domain.js';
import type { ApplicationRepository } from '../storage/repositories.js';
import { compareUtcTimestamps } from './incident.js';
import { SelectionInputSchema, SelectionPolicyContextSchema, selectCommitments,
  type SelectionInput, type SelectionPolicyContext } from './selection.js';

export interface ObservedCollectionCheck {
  repository: ApplicationRepository;
  receipt: CollectionReceipt;
  context: ReadCallContext;
  checkedAt: string;
  maxAgeMs: number;
  /** A resumed guard requires a new observation, even if an older read is recent. */
  notBefore?: string;
}

function readIdentity(context: ReadCallContext) {
  // Pagination and retries get their own attempt and child span IDs. Everything
  // else, including account, runtime, operation and cumulative budget, is fixed.
  const { providerAttemptId: _attempt, spanId: _span, ...identity } = context;
  return identity;
}

/** Authenticate supplied observations against the application provider ledger. */
export function verifyObservedCollection(input: ObservedCollectionCheck): CollectionReceipt {
  const context = ReadCallContextSchema.parse(input.context);
  const receipt = CollectionReceiptSchema.parse(input.receipt);
  const checkedAt = UtcTimestampSchema.parse(input.checkedAt);
  const maxAgeMs = z.number().int().positive().safe().parse(input.maxAgeMs);
  const notBefore = input.notBefore === undefined ? null : UtcTimestampSchema.parse(input.notBefore);
  if (receipt.status !== 'complete') throw new Error('source_read_incomplete');
  if (receipt.app !== context.app || receipt.accountRef !== context.accountRef ||
      receipt.collectionId !== context.logicalCallId) throw new Error('observation_scope_mismatch');
  if (compareUtcTimestamps(receipt.finishedAt, checkedAt) > 0 ||
      (notBefore !== null && compareUtcTimestamps(receipt.startedAt, notBefore) < 0) ||
      Date.parse(checkedAt) - Date.parse(receipt.startedAt) >= maxAgeMs)
    throw new Error('observation_not_fresh');
  const run = input.repository.getRun(context.runId);
  if (!run || run.configuration.providerMode !== context.mode) throw new Error('observation_mode_mismatch');
  if (receipt.pages.length > context.budgets.maxPages ||
      receipt.pages.reduce((count, page) => count + page.recordCount, 0) > context.budgets.maxRecords ||
      receipt.pages.reduce((count, page) => count + page.response.byteLength, 0) > context.budgets.maxResponseBytes)
    throw new Error('observation_budget_exceeded');
  if (new Set(receipt.pages.map(page => page.providerAttemptId)).size !== receipt.pages.length)
    throw new Error('observation_attempt_reused');
  for (const page of receipt.pages) {
    const stored = input.repository.getProviderAttempt(page.providerAttemptId);
    if (!stored?.receipt) throw new Error('observation_attempt_missing');
    const actual = ReadCallContextSchema.safeParse(stored.context);
    if (!actual.success || canonical(readIdentity(actual.data)) !== canonical(readIdentity(context)) ||
        canonical(stored.context) !== canonical(stored.receipt.context) ||
        stored.context.providerAttemptId !== page.providerAttemptId ||
        stored.startedAt !== stored.receipt.startedAt || stored.outcome !== null)
      throw new Error('observation_attempt_mismatch');
    if (stored.receipt.providerOutcome !== 'success' || stored.receipt.transportOutcome !== 'response' ||
        stored.receipt.transport !== context.mode || !stored.receipt.responseRef ||
        canonical(stored.receipt.responseRef) !== canonical(page.response))
      throw new Error('observation_not_successful');
    if (compareUtcTimestamps(stored.receipt.startedAt, receipt.startedAt) < 0 ||
        compareUtcTimestamps(stored.receipt.finishedAt, receipt.finishedAt) > 0 ||
        compareUtcTimestamps(stored.receipt.startedAt, context.deadlineAt) >= 0 ||
        compareUtcTimestamps(stored.receipt.finishedAt, context.deadlineAt) > 0)
      throw new Error('observation_window_mismatch');
    input.repository.readArtifact(page.response);
  }
  return immutable(receipt);
}

export interface RefreshedSources {
  /** Snapshot artifacts contain the normalized reader data as JSON. */
  input: SelectionInput;
  githubContext: ReadCallContext;
  hubspotContext: ReadCallContext;
}
export type SourceReader = (plan: ImmutablePlan) => Promise<RefreshedSources>;
export interface SourceFreshnessOptions {
  repository: ApplicationRepository;
  plan: ImmutablePlan;
  readSources: SourceReader;
  policy: SelectionPolicyContext;
  clock: () => number;
  maxAgeMs: number;
}
interface SourceFreshnessEvidence {
  checkedAt: string;
  readStartedAt: string;
  sources: SnapshotRef[];
  receipts: CollectionReceipt[];
}
export type SourceFreshnessResult = SourceFreshnessEvidence & (
  | { status: 'fresh'; reason: 'sources_unchanged' }
  | { status: 'changed'; reason: string }
  | { status: 'unavailable'; reason: string }
);

function sourceIdentity(sources: readonly SnapshotRef[]) {
  return sources.map(source => ({ app: source.app, accountRef: source.accountRef,
    sourceIds: [...source.sourceIds].sort(), relevantVersion: source.relevantVersion,
    contentDigest: source.artifact.sha256 }))
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

function selectionIdentity(selection: ImmutablePlan['selection']) {
  const { evaluatedAt: _evaluated, sourceBundleRef: _bundle, ...identity } = selection;
  return { ...identity, selected: [...identity.selected].sort((a, b) => a.commitmentId.localeCompare(b.commitmentId)),
    excluded: [...identity.excluded].sort((a, b) => a.commitmentId.localeCompare(b.commitmentId)) };
}

/** Fresh reads and complete deterministic selection are required on every call. */
export async function checkSourceFreshness(options: SourceFreshnessOptions): Promise<SourceFreshnessResult> {
  // Invalid server configuration is a programming error rather than evidence of
  // source drift. Reads themselves fail closed into an observable result.
  const policy = SelectionPolicyContextSchema.parse(options.policy);
  z.number().int().positive().safe().parse(options.maxAgeMs);
  const readStartedAt = new Date(options.clock()).toISOString();
  let sources: SnapshotRef[] = [];
  let receipts: CollectionReceipt[] = [];
  const result = (status: SourceFreshnessResult['status'], reason: string): SourceFreshnessResult =>
    immutable({ status, reason, checkedAt: new Date(options.clock()).toISOString(),
      readStartedAt, sources, receipts }) as SourceFreshnessResult;
  try {
    const plan = await verifyPlanIntegrity(options.plan);
    const storedPlan = options.repository.getPlan(plan.runId, plan.revision);
    if (!storedPlan || canonical(storedPlan) !== canonical(plan)) return result('unavailable', 'plan_not_stored');
    const observed = await options.readSources(plan);
    const input = SelectionInputSchema.parse(observed.input);
    sources = input.sources;
    receipts = [input.github.receipt, input.hubspot.receipt];
    const checkedAt = new Date(options.clock()).toISOString();
    const githubContext = ReadCallContextSchema.parse(observed.githubContext);
    const hubspotContext = ReadCallContextSchema.parse(observed.hubspotContext);
    if (githubContext.runId !== plan.runId || hubspotContext.runId !== plan.runId ||
        githubContext.operation !== 'github.readTechnicalEvidence' ||
        hubspotContext.operation !== 'hubspot.readCommitmentBundle' ||
        githubContext.evaluationAttemptId !== hubspotContext.evaluationAttemptId ||
        githubContext.runtimeAttemptId !== hubspotContext.runtimeAttemptId)
      return result('unavailable', 'source_context_mismatch');
    for (const [read, context] of [[input.github, githubContext], [input.hubspot, hubspotContext]] as const) {
      verifyObservedCollection({ repository: options.repository, receipt: read.receipt, context,
        checkedAt, maxAgeMs: options.maxAgeMs, notBefore: readStartedAt });
      if (read.status !== 'complete') return result('unavailable', 'source_read_incomplete');
      const snapshot = sources.filter(source => source.app === context.app);
      if (snapshot.length !== 1) return result('unavailable', 'source_snapshot_mismatch');
      // A genuine provider receipt cannot legitimize an independently substituted
      // normalized bundle. Keep its immutable bytes tied to this selection input.
      const bytes = options.repository.readArtifact(snapshot[0].artifact);
      if (canonical(JSON.parse(bytes)) !== canonical(read.data))
        return result('unavailable', 'source_artifact_mismatch');
    }
    options.repository.readArtifact(input.sourceBundleRef);
    const decision = selectCommitments(input, { ...policy, evaluatedAt: checkedAt, pinnedIncident: plan.incident });
    if (decision.status === 'failed') return result('unavailable', decision.reason);
    if (decision.status === 'safely_blocked') return result('changed', decision.reason);
    if (!decision.selection) return result('unavailable', 'selection_unavailable');
    if (canonical(decision.incident) !== canonical(plan.incident)) return result('changed', 'incident_changed');
    if (canonical(selectionIdentity(decision.selection)) !== canonical(selectionIdentity(plan.selection)))
      return result('changed', 'selection_changed');
    if (canonical(sourceIdentity(sources)) !== canonical(sourceIdentity(plan.sources)))
      return result('changed', 'sources_changed');
    return result('fresh', 'sources_unchanged');
  } catch (error) {
    const reason = error instanceof Error && /^[a-z][a-z0-9_]{0,159}$/.test(error.message)
      ? error.message : 'source_read_unavailable';
    return result('unavailable', reason);
  }
}
