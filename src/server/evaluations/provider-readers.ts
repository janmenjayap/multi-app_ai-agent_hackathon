import {
  GmailDraftSchema,
  GitHubCommentSchema,
  GitHubTechnicalEvidenceSchema,
  HubSpotCommitmentBundleSchema,
  HubSpotNoteSchema,
  HubSpotTaskSchema,
  ReadCallContextSchema,
  SlackMessageSchema,
} from '../../shared/adapters.js';
import type {
  GmailReader,
  GitHubReader,
  HubSpotReader,
  ReadCallContext,
  SlackReader,
} from '../../shared/adapters.js';
import { canonical, immutable, sha256Text } from '../../shared/domain.js';
import type { IncidentIdentity, ReadResult } from '../../shared/domain.js';
import { LogicalIdBindingSchema, LogicalManifestSchema } from '../../shared/evaluation.js';
import type { ImportedObservation, LogicalIdBinding, LogicalManifest } from '../../shared/evaluation.js';
import { digest } from '../../shared/reliability.js';

export interface ProviderReaderSet {
  github: GitHubReader;
  hubspot: HubSpotReader;
  gmail: GmailReader;
  slack: SlackReader;
}

export interface ProviderEvidenceRead {
  app: ReadCallContext['app'];
  purpose: string;
  effectKey: string | null;
  result: ReadResult<unknown>;
}

export interface CollectedProviderRecord {
  readonly id: string;
  readonly effectKey: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface ProviderReadProjection {
  readonly records: Readonly<Record<ReadCallContext['app'], readonly CollectedProviderRecord[]>>;
  readonly idBindings: readonly LogicalIdBinding[];
  readonly collectionGaps: readonly string[];
  readonly bindingGaps: readonly string[];
}

export interface ProviderPhaseReadInput {
  readers: ProviderReaderSet;
  manifest: LogicalManifest;
  runId: string;
  evaluationAttemptId: string;
  runtimeAttemptId: string;
  incident: IncidentIdentity;
  deadlineAt: string;
  budgets: ReadCallContext['budgets'];
  createId: (purpose: string) => string;
}

function context<Operation extends ReadCallContext['operation']>(
  input: ProviderPhaseReadInput,
  app: ReadCallContext['app'],
  operation: Operation,
  purpose: string,
): ReadCallContext & { operation: Operation } {
  const reader = input.readers[app];
  return ReadCallContextSchema.parse({
    schemaVersion: 2,
    runId: input.runId,
    evaluationAttemptId: input.evaluationAttemptId,
    runtimeAttemptId: input.runtimeAttemptId,
    spanId: input.createId(`${purpose}-span`),
    app,
    accountRef: reader.scope.accountRef,
    mode: reader.mode,
    operation,
    logicalCallId: input.createId(`${purpose}-call`),
    providerAttemptId: input.createId(`${purpose}-attempt`),
    deadlineAt: input.deadlineAt,
    budgets: input.budgets,
  }) as ReadCallContext & { operation: Operation };
}

export async function readProviderPhase(input: ProviderPhaseReadInput): Promise<readonly ProviderEvidenceRead[]> {
  const manifest = LogicalManifestSchema.parse(input.manifest);
  const sourceReads: Promise<ProviderEvidenceRead>[] = [
    input.readers.github.readTechnicalEvidence(input.incident,
      context(input, 'github', 'github.readTechnicalEvidence', 'github-source'))
      .then(result => ({ app: 'github', purpose: 'source', effectKey: null, result })),
    input.readers.hubspot.readCommitmentBundle(input.incident.service,
      context(input, 'hubspot', 'hubspot.readCommitmentBundle', 'hubspot-source'))
      .then(result => ({ app: 'hubspot', purpose: 'source', effectKey: null, result })),
    input.readers.gmail.listDrafts(context(input, 'gmail', 'gmail.listDrafts', 'gmail-scope'))
      .then(result => ({ app: 'gmail', purpose: 'scope', effectKey: null, result })),
    input.readers.slack.findReview(input.runId, context(input, 'slack', 'slack.findReview', 'slack-scope'))
      .then(result => ({ app: 'slack', purpose: 'scope', effectKey: null, result })),
  ];
  const effectReads = manifest.effects.map(async (effect): Promise<ProviderEvidenceRead> => {
    switch (effect.kind) {
      case 'task':
        return { app: 'hubspot', purpose: 'effect', effectKey: effect.effectKey,
          result: await input.readers.hubspot.findTasks(effect.effectKey,
            context(input, 'hubspot', 'hubspot.findTasks', `task-${effect.effectKey}`)) };
      case 'note':
        return { app: 'hubspot', purpose: 'effect', effectKey: effect.effectKey,
          result: await input.readers.hubspot.findNotes(effect.effectKey,
            context(input, 'hubspot', 'hubspot.findNotes', `note-${effect.effectKey}`)) };
      case 'draft':
        return { app: 'gmail', purpose: 'effect', effectKey: effect.effectKey,
          result: await input.readers.gmail.findDrafts(effect.effectKey,
            context(input, 'gmail', 'gmail.findDrafts', `draft-${effect.effectKey}`)) };
      case 'comment':
        return { app: 'github', purpose: 'effect', effectKey: effect.effectKey,
          result: await input.readers.github.findComments(input.incident, effect.effectKey,
            context(input, 'github', 'github.findComments', `comment-${effect.effectKey}`)) };
      case 'thread':
        return { app: 'slack', purpose: 'effect', effectKey: effect.effectKey,
          result: await input.readers.slack.findReview(effect.effectKey,
            context(input, 'slack', 'slack.findReview', `thread-${effect.effectKey}`)) };
    }
  });
  return Promise.all([...sourceReads, ...effectReads]);
}

type RecordKind = 'incident' | 'comment' | 'commitment' | 'company' | 'contact' | 'owner' | 'task' | 'note' | 'draft' | 'thread';
interface RawRecord {
  app: ReadCallContext['app'];
  kind: RecordKind;
  id: string;
  effectKey: string | null;
  value: unknown;
}

function readData(read: ProviderEvidenceRead): unknown {
  return read.result.status === 'complete' ? read.result.data : read.result.partialData ?? null;
}

function effectRows(read: ProviderEvidenceRead, manifest: LogicalManifest): RawRecord[] {
  if (!read.effectKey) return [];
  const effect = manifest.effects.find(candidate => candidate.effectKey === read.effectKey);
  if (!effect) throw new Error('collector_effect_scope_mismatch');
  switch (effect.kind) {
    case 'task':
      return HubSpotTaskSchema.array().parse(readData(read)).map(value => ({ app: 'hubspot', kind: 'task', id: value.id, effectKey: effect.effectKey, value }));
    case 'note':
      return HubSpotNoteSchema.array().parse(readData(read)).map(value => ({ app: 'hubspot', kind: 'note', id: value.id, effectKey: effect.effectKey, value }));
    case 'draft':
      return GmailDraftSchema.array().parse(readData(read)).map(value => ({ app: 'gmail', kind: 'draft', id: value.draftId, effectKey: effect.effectKey, value }));
    case 'comment':
      return GitHubCommentSchema.array().parse(readData(read)).map(value => ({ app: 'github', kind: 'comment', id: value.id, effectKey: effect.effectKey, value }));
    case 'thread':
      return SlackMessageSchema.array().parse(readData(read)).map(value => ({ app: 'slack', kind: 'thread', id: value.messageTs, effectKey: effect.effectKey, value }));
  }
}

function sourceRows(read: ProviderEvidenceRead): RawRecord[] {
  if (read.purpose !== 'source' && read.purpose !== 'scope') return [];
  const data = readData(read);
  if (read.app === 'github') {
    const source = GitHubTechnicalEvidenceSchema.parse(data);
    return [
      { app: 'github', kind: 'incident', id: source.incident.issueId, effectKey: null, value: source },
      ...source.comments.map(value => ({ app: 'github' as const, kind: 'comment' as const, id: value.id, effectKey: null, value })),
    ];
  }
  if (read.app === 'hubspot') {
    const source = HubSpotCommitmentBundleSchema.parse(data);
    return [
      ...source.commitments.map(value => ({ app: 'hubspot' as const, kind: 'commitment' as const, id: value.id, effectKey: null, value })),
      ...source.companies.map(value => ({ app: 'hubspot' as const, kind: 'company' as const, id: value.id, effectKey: null, value })),
      ...source.contacts.map(value => ({ app: 'hubspot' as const, kind: 'contact' as const, id: value.id, effectKey: null, value })),
      ...source.owners.map(value => ({ app: 'hubspot' as const, kind: 'owner' as const, id: value.id, effectKey: null, value })),
    ];
  }
  if (read.app === 'gmail') return GmailDraftSchema.array().parse(data)
    .map(value => ({ app: 'gmail' as const, kind: 'draft' as const, id: value.draftId, effectKey: null, value }));
  return SlackMessageSchema.array().parse(data)
    .map(value => ({ app: 'slack' as const, kind: 'thread' as const, id: value.messageTs, effectKey: null, value }));
}

function single(values: readonly string[]): string | null {
  return values.length === 1 ? values[0] : null;
}

async function normalizedFields(raw: RawRecord, manifest: LogicalManifest, providerIds: ReadonlyMap<string, string>): Promise<Record<string, unknown>> {
  switch (raw.kind) {
    case 'incident': {
      const source = GitHubTechnicalEvidenceSchema.parse(raw.value);
      return { repositoryId: source.incident.repositoryId, issueId: source.incident.issueId,
        issueNumber: source.incident.issueNumber, canonicalUrl: source.incident.canonicalUrl,
        service: source.incident.service, environment: source.incident.environment,
        titleSha256: await sha256Text(source.title), bodySha256: await sha256Text(source.body),
        changeIds: source.changes.map(change => change.id) };
    }
    case 'commitment': {
      const value = HubSpotCommitmentBundleSchema.shape.commitments.element.parse(raw.value);
      return { recordType: 'commitment', companyIds: value.companyIds, contactIds: value.contactIds,
        ownerId: value.ownerId, service: value.service, status: value.status, dueAt: value.dueAt,
        promise: value.promise, version: value.version };
    }
    case 'company': {
      const value = HubSpotCommitmentBundleSchema.shape.companies.element.parse(raw.value);
      return { recordType: 'company', name: value.name, contactIds: value.contactIds };
    }
    case 'contact': {
      const value = HubSpotCommitmentBundleSchema.shape.contacts.element.parse(raw.value);
      return { recordType: 'contact', email: value.email, designated: value.designated };
    }
    case 'owner': {
      const value = HubSpotCommitmentBundleSchema.shape.owners.element.parse(raw.value);
      return { recordType: 'owner', active: value.active };
    }
    case 'task': {
      const value = HubSpotTaskSchema.parse(raw.value);
      return { companyId: single(value.companyIds), companyIds: value.companyIds,
        commitmentId: single(value.commitmentIds), commitmentIds: value.commitmentIds,
        ownerId: value.ownerId, dueAt: value.dueAt, status: value.status, subject: value.subject,
        bodySha256: await sha256Text(value.body), version: value.version };
    }
    case 'note': {
      const value = HubSpotNoteSchema.parse(raw.value);
      return { companyId: single(value.companyIds), companyIds: value.companyIds,
        commitmentId: single(value.commitmentIds), commitmentIds: value.commitmentIds,
        taskId: single(value.taskIds), taskIds: value.taskIds, bodySha256: await sha256Text(value.body), version: value.version };
    }
    case 'draft': {
      const value = GmailDraftSchema.parse(raw.value);
      return { messageId: value.messageId, to: single(value.to) ?? value.to, cc: value.cc, bcc: value.bcc,
        subject: value.subject, bodySha256: await sha256Text(value.body), isDraft: value.isDraft, version: value.version };
    }
    case 'comment': {
      const value = GitHubCommentSchema.parse(raw.value);
      const idsByKind = (kind: LogicalManifest['effects'][number]['kind']) => manifest.effects
        .filter(effect => effect.kind === kind).map(effect => providerIds.get(effect.effectKey))
        .filter((id): id is string => Boolean(id && value.body.includes(id)));
      return { repositoryId: value.repositoryId, incidentId: value.issueId,
        taskIds: idsByKind('task'), draftIds: idsByKind('draft'), bodySha256: await sha256Text(value.body),
        authorId: value.authorId, updatedAt: value.updatedAt, version: value.version };
    }
    case 'thread': {
      const value = SlackMessageSchema.parse(raw.value);
      const idsByKind = (kind: LogicalManifest['effects'][number]['kind']) => manifest.effects
        .filter(effect => effect.kind === kind).map(effect => providerIds.get(effect.effectKey))
        .filter((id): id is string => Boolean(id && value.body.includes(id)));
      const comments = idsByKind('comment');
      return { channelId: value.channelId, threadTs: value.threadTs, messageTs: value.messageTs,
        taskIds: idsByKind('task'), noteIds: idsByKind('note'), draftIds: idsByKind('draft'),
        commentId: single(comments), bodySha256: await sha256Text(value.body),
        verdict: /\bcompleted\b/i.test(value.body) ? 'completed' : null,
        actorId: value.actorId, isBot: value.isBot, editedAt: value.editedAt, deleted: value.deleted,
        observedAt: value.observedAt };
    }
  }
}

export async function projectProviderReads(
  reads: readonly ProviderEvidenceRead[],
  observations: readonly ImportedObservation[],
  manifestValue: LogicalManifest,
): Promise<ProviderReadProjection> {
  const manifest = LogicalManifestSchema.parse(manifestValue);
  if (reads.length !== observations.length) throw new Error('collector_observation_count_mismatch');
  const collectionGaps: string[] = [];
  const bindingGaps: string[] = [];
  const raw = new Map<string, RawRecord>();
  const add = (record: RawRecord) => {
    const key = `${record.app}:${record.id}`;
    const prior = raw.get(key);
    if (prior && canonical(prior.value) !== canonical(record.value)) {
      collectionGaps.push(`conflicting_read:${key}`);
      return;
    }
    if (prior?.effectKey && record.effectKey && prior.effectKey !== record.effectKey) {
      collectionGaps.push(`ambiguous_marker:${key}`);
      return;
    }
    raw.set(key, { ...record, effectKey: record.effectKey ?? prior?.effectKey ?? null });
  };
  const idBindings: LogicalIdBinding[] = [];
  for (const [index, read] of reads.entries()) {
    if (read.result.status === 'incomplete') collectionGaps.push(`${read.app}:${read.result.reason}`);
    try {
      sourceRows(read).forEach(add);
      const matches = effectRows(read, manifest);
      matches.forEach(add);
      if (read.effectKey && read.result.status === 'complete') {
        const effect = manifest.effects.find(candidate => candidate.effectKey === read.effectKey)!;
        if (matches.length === 1) idBindings.push(LogicalIdBindingSchema.parse({
          schemaVersion: 2,
          effectRef: { type: 'effect_id', effectKey: effect.effectKey },
          app: effect.app,
          accountRef: effect.accountRef,
          source: 'independent_read',
          collection: read.result.receipt,
          matches: [{ providerId: matches[0].id, marker: effect.effectKey,
            identityDigest: digest({ app: effect.app, kind: effect.kind, value: matches[0].value }),
            observationRef: observations[index].objectsRef }],
        }));
        else bindingGaps.push(`${matches.length ? 'ambiguous' : 'missing'}_binding:${effect.effectKey}`);
      }
    } catch {
      collectionGaps.push(`malformed_projection:${read.app}:${read.purpose}`);
    }
  }
  const providerIds = new Map(idBindings.map(binding => [binding.effectRef.effectKey, binding.matches[0].providerId]));
  const records: Record<ReadCallContext['app'], CollectedProviderRecord[]> = { github: [], hubspot: [], gmail: [], slack: [] };
  for (const record of raw.values()) records[record.app].push(immutable({ id: record.id, effectKey: record.effectKey,
    fields: await normalizedFields(record, manifest, providerIds) }));
  for (const app of Object.keys(records) as ReadCallContext['app'][]) records[app].sort((left, right) => left.id.localeCompare(right.id));
  return immutable({ records, idBindings, collectionGaps: [...new Set(collectionGaps)], bindingGaps: [...new Set(bindingGaps)] });
}