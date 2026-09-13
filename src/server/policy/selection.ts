import { z } from 'zod';
import { GitHubTechnicalEvidenceSchema, HubSpotCommitmentBundleSchema } from '../../shared/adapters.js';
import { IdSchema, IncidentIdentitySchema, RestrictedArtifactRefSchema, SelectionSchema,
  SnapshotRefSchema, UtcTimestampSchema, canonical, immutable, readResultSchema } from '../../shared/domain.js';
import type { CollectionReceipt, IncidentIdentity, RestrictedArtifactRef, Selection, SnapshotRef } from '../../shared/domain.js';
import { AllowedRepositorySchema, bindIncidentIdentity, parseIncidentIdentifier } from './identity.js';
import { compareUtcTimestamps, validateIncident } from './incident.js';

export const SELECTION_POLICY_VERSION = 'selection-v1';
export const IMPACT_HORIZON_HOURS = 72;
const ScopeSchema = z.object({ accountRef: IdSchema, requiredQueryIds: z.array(IdSchema).min(1).max(100)
  .refine(ids => new Set(ids).size === ids.length, 'duplicate_query') }).strict();
/** Server-owned policy, never supplied by a source record or a model. */
export const SelectionPolicyContextSchema = z.object({
  schemaVersion: z.literal(2), evaluatedAt: UtcTimestampSchema,
  allowedRepositories: z.array(AllowedRepositorySchema).min(1).max(100),
  supportedServices: z.array(IdSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'duplicate_service'),
  githubScope: ScopeSchema, hubspotScope: ScopeSchema, pinnedIncident: IncidentIdentitySchema.nullable(),
}).strict();
export type SelectionPolicyContext = z.infer<typeof SelectionPolicyContextSchema>;
export const SelectionInputSchema = z.object({
  schemaVersion: z.literal(2), incidentUrl: z.string(),
  github: readResultSchema(GitHubTechnicalEvidenceSchema), hubspot: readResultSchema(HubSpotCommitmentBundleSchema),
  sources: z.array(SnapshotRefSchema).max(100), sourceBundleRef: RestrictedArtifactRefSchema,
}).strict();
export type SelectionInput = z.infer<typeof SelectionInputSchema>;
// Validate retrieval independently of business fields so bad affected rows block,
// whereas missing pages fail. Neither can become a successful empty Selection.
const ReadEnvelopeSchema = readResultSchema(z.unknown());
const InputEnvelopeSchema = SelectionInputSchema.extend({ github: z.unknown(), hubspot: z.unknown() });
type CandidateDecision = { commitmentId: string; disposition: 'selected' | 'excluded' | 'blocked'; reason: string };
interface SelectionEvidence {
  schemaVersion: 2;
  policyVersion: typeof SELECTION_POLICY_VERSION;
  evaluatedAt: string;
  horizonEndsAt: string;
  sources: SnapshotRef[];
  receipts: CollectionReceipt[];
  sourceBundleRef: RestrictedArtifactRef | null;
  sourceComplete: boolean;
  incident: IncidentIdentity | null;
  observedIncident: IncidentIdentity | null;
  runIdentity: ReturnType<typeof bindIncidentIdentity>['runIdentity'] | null;
  incidentFingerprint: string | null;
  decisions: CandidateDecision[];
}
export type SelectionDecision = SelectionEvidence & (
  | { status: 'selected' | 'no_affected'; reason: string; selection: Selection }
  | { status: 'safely_blocked' | 'failed'; reason: string; selection: null }
);

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && new Set(left).size === left.length && left.every(id => right.includes(id));
const duplicateIds = (rows: readonly { id: string }[]) => new Set(rows.map(row => row.id)).size !== rows.length;
const compareIds = (left: { id: string }, right: { id: string }) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/**
 * Pure pre-effect policy. R01 supplies normalized, complete reader results and
 * persisted snapshot/bundle references. B04 records the decision; B07 alone can
 * turn no_affected into a completion claim after independent absence checks.
 * References are retained, not fetched: artifact byte verification/storage and
 * provider query correctness remain responsibilities of their owning boundaries.
 */
export function selectCommitments(input: unknown, policy: SelectionPolicyContext): SelectionDecision {
  // Invalid server configuration is a programming error, not source evidence.
  const context = SelectionPolicyContextSchema.parse(policy);
  const horizonEndsAt = new Date(Date.parse(context.evaluatedAt) + IMPACT_HORIZON_HOURS * 3600000).toISOString()
    .replace(/\.\d+Z$/, context.evaluatedAt.match(/\.\d+Z$/)?.[0] ?? '.000Z');
  const pinned = context.pinnedIncident ? bindIncidentIdentity(context.pinnedIncident, context.pinnedIncident) : null;
  const evidence: SelectionEvidence = { schemaVersion: 2, policyVersion: SELECTION_POLICY_VERSION,
    evaluatedAt: context.evaluatedAt, horizonEndsAt, sources: [], receipts: [], sourceBundleRef: null,
    sourceComplete: false, incident: pinned?.incident ?? null, observedIncident: null,
    runIdentity: pinned?.runIdentity ?? null, incidentFingerprint: pinned?.incidentFingerprint ?? null, decisions: [] };
  const stop = (status: 'safely_blocked' | 'failed', reason: string): SelectionDecision =>
    immutable({ ...evidence, status, reason, selection: null });
  const envelope = InputEnvelopeSchema.safeParse(input);
  if (!envelope.success) return stop('failed', 'malformed_response');
  const value = envelope.data;
  evidence.sources = value.sources.sort((left, right) => compareIds({ id: left.snapshotId }, { id: right.snapshotId }));
  evidence.sourceBundleRef = value.sourceBundleRef;
  const githubRead = ReadEnvelopeSchema.safeParse(value.github);
  const hubspotRead = ReadEnvelopeSchema.safeParse(value.hubspot);
  for (const read of [githubRead, hubspotRead]) if (read.success) evidence.receipts.push(read.data.receipt);
  if (!githubRead.success || !hubspotRead.success) return stop('failed', 'malformed_response');
  const github = githubRead.data;
  const hubspot = hubspotRead.data;
  for (const [app, read, scope] of [
    ['github', github, context.githubScope], ['hubspot', hubspot, context.hubspotScope],
  ] as const) {
    if (read.receipt.app !== app || read.receipt.accountRef !== scope.accountRef ||
        !sameSet(read.receipt.requiredQueryIds, scope.requiredQueryIds)) return stop('failed', 'scope_mismatch');
  }
  // Resolve immutable IDs even on a failed HubSpot read, before eligibility checks.
  const technical = github.status === 'complete' ? GitHubTechnicalEvidenceSchema.safeParse(github.data) : null;
  if (technical?.success) {
    const bound = bindIncidentIdentity(technical.data.incident, context.pinnedIncident);
    evidence.incident = bound.incident;
    evidence.observedIncident = bound.observedIncident;
    evidence.runIdentity = bound.runIdentity;
    evidence.incidentFingerprint = bound.incidentFingerprint;
  }
  if (github.status === 'incomplete') return stop('failed', github.reason);
  if (hubspot.status === 'incomplete') return stop('failed', hubspot.reason);
  if (!technical?.success) return stop('safely_blocked', 'incident_fields_invalid');
  const bundleResult = HubSpotCommitmentBundleSchema.safeParse(hubspot.data);
  if (!bundleResult.success) return stop('safely_blocked', 'malformed_commitment');
  const bundle = bundleResult.data;
  // Snapshot receipts must describe these very reads, not another successful call.
  if (value.sources.length !== 2 || new Set(value.sources.map(source => source.snapshotId)).size !== 2)
    return stop('failed', 'scope_mismatch');
  for (const [app, read] of [['github', github], ['hubspot', hubspot]] as const) {
    const sources = value.sources.filter(source => source.app === app);
    if (sources.length !== 1 || canonical(sources[0].receipt) !== canonical(read.receipt) ||
        compareUtcTimestamps(sources[0].capturedAt, read.receipt.startedAt) < 0 ||
        compareUtcTimestamps(sources[0].capturedAt, read.receipt.finishedAt) > 0) return stop('failed', 'scope_mismatch');
    const ids = app === 'github' ? [technical.data.incident.issueId] : bundle.commitments.map(row => row.id);
    if (ids.some(id => !sources[0].sourceIds.includes(id)) || new Set(sources[0].sourceIds).size !== sources[0].sourceIds.length)
      return stop('failed', 'scope_mismatch');
  }
  evidence.sourceComplete = true;
  let identifier: ReturnType<typeof parseIncidentIdentifier>;
  try { identifier = parseIncidentIdentifier(value.incidentUrl, context.allowedRepositories); }
  catch { return stop('safely_blocked', 'incident_identifier_invalid'); }
  const observed = technical.data.incident;
  let sourceIdentifier: ReturnType<typeof parseIncidentIdentifier>;
  try { sourceIdentifier = parseIncidentIdentifier(observed.canonicalUrl, context.allowedRepositories); }
  catch { return stop('safely_blocked', 'incident_identifier_invalid'); }
  if (identifier.repositoryId !== observed.repositoryId || identifier.issueNumber !== observed.issueNumber ||
      sourceIdentifier.repositoryId !== identifier.repositoryId || sourceIdentifier.issueNumber !== identifier.issueNumber)
    return stop('safely_blocked', 'incident_identity_changed');
  const bound = bindIncidentIdentity(observed, context.pinnedIncident);
  if (bound.reason) return stop('safely_blocked', bound.reason);
  const incidentValidation = validateIncident(technical.data, context.evaluatedAt);
  if (incidentValidation.status === 'safely_blocked') return stop('safely_blocked', incidentValidation.reason);
  if (!context.supportedServices.includes(observed.service)) return stop('safely_blocked', 'incident_service_unsupported');
  if ([bundle.commitments, bundle.companies, bundle.contacts, bundle.owners].some(duplicateIds))
    return stop('safely_blocked', 'ambiguous_identity');

  const companies = new Map(bundle.companies.map(row => [row.id, row]));
  const contacts = new Map(bundle.contacts.map(row => [row.id, row]));
  const owners = new Map(bundle.owners.map(row => [row.id, row]));
  const selected: Selection['selected'] = [];
  const excluded: Selection['excluded'] = [];
  for (const row of [...bundle.commitments].sort(compareIds)) {
    const block = (reason: string) => evidence.decisions.push({ commitmentId: row.id, disposition: 'blocked', reason });
    const exclude = (reason: string) => {
      excluded.push({ commitmentId: row.id, reason });
      evidence.decisions.push({ commitmentId: row.id, disposition: 'excluded', reason });
    };
    // Missing/invalid eligibility fields cannot prove that a row is unaffected.
    if (!IdSchema.safeParse(row.service).success || !IdSchema.safeParse(row.status).success ||
        !UtcTimestampSchema.safeParse(row.dueAt).success) { block('malformed_commitment'); continue; }
    if (row.service !== observed.service) { exclude('service_mismatch'); continue; }
    if (row.status !== 'active') { exclude('status_inactive'); continue; }
    // Validate potentially affected mappings before dropping out-of-horizon rows.
    if (row.companyIds.length !== 1) { block(row.companyIds.length ? 'ambiguous_company' : 'missing_company'); continue; }
    const company = companies.get(row.companyIds[0]);
    if (!company) { block('missing_company'); continue; }
    const owner = row.ownerId === null ? undefined : owners.get(row.ownerId);
    if (!owner) { block('missing_owner'); continue; }
    if (!owner.active) { block('owner_inactive'); continue; }
    if (!row.promise?.trim()) { block('malformed_commitment'); continue; }
    if (new Set(row.contactIds).size !== row.contactIds.length || new Set(company.contactIds).size !== company.contactIds.length) {
      block('ambiguous_contact'); continue;
    }
    if (!row.contactIds.length || row.contactIds.some(id => !contacts.has(id))) { block('missing_contact'); continue; }
    if (row.contactIds.some(id => !company.contactIds.includes(id))) { block('invalid_contact'); continue; }
    const designated = row.contactIds.flatMap(id => contacts.get(id)!.designated ? [contacts.get(id)!] : []);
    if (designated.length !== 1) {
      block(designated.length > 1 || row.contactIds.length > 1 ? 'ambiguous_contact' : 'missing_contact'); continue;
    }
    const mailbox = z.email().safeParse(designated[0].email);
    if (!mailbox.success) { block('invalid_contact'); continue; }
    const dueAt = row.dueAt!;
    if (compareUtcTimestamps(dueAt, context.evaluatedAt) < 0) { exclude('due_before_horizon'); continue; }
    if (compareUtcTimestamps(dueAt, horizonEndsAt) > 0) { exclude('due_after_horizon'); continue; }
    selected.push({ commitmentId: row.id, companyId: company.id, ownerId: owner.id, contactId: designated[0].id,
      mailbox: mailbox.data, dueAt, service: observed.service, reason: 'eligible' });
    evidence.decisions.push({ commitmentId: row.id, disposition: 'selected', reason: 'eligible' });
  }
  const blocked = evidence.decisions.find(decision => decision.disposition === 'blocked');
  if (blocked) return stop('safely_blocked', blocked.reason);
  const selection = SelectionSchema.safeParse({ schemaVersion: 2, policyVersion: SELECTION_POLICY_VERSION,
    evaluatedAt: context.evaluatedAt, sourceBundleRef: value.sourceBundleRef, sourceComplete: true, selected, excluded });
  if (!selection.success) return stop('safely_blocked', 'input_budget_exceeded');
  return immutable({ ...evidence, status: selected.length ? 'selected' : 'no_affected',
    reason: selected.length ? 'eligible_commitments' : 'no_eligible_commitments', selection: selection.data });
}
