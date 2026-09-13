/** Stateful, simulated providers. The operator handle must never enter an agent client. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CommentWriteSchema, DraftWriteSchema, GitHubCommentSchema, GitHubTechnicalEvidenceSchema,
  GmailDraftSchema, HubSpotCommitmentBundleSchema, HubSpotNoteSchema, HubSpotTaskSchema,
  NoteWriteSchema, SlackMessageSchema, SlackWriteSchema, TaskWriteSchema, parseAdapterContext,
} from '../../src/shared/adapters.js';
import type {
  AdapterCallContext, AdapterOperation, CoordinationCallContext, GitHubAdapter, GitHubReader,
  GmailAdapter, GmailReader, HubSpotAdapter, HubSpotReader, ProtectedCallContext, ReadCallContext,
  SlackAdapter, SlackReader,
} from '../../src/shared/adapters.js';
import { IdSchema, UtcTimestampSchema, canonical, immutable } from '../../src/shared/domain.js';
import type { CollectionReceipt, MutationOutcome, ReadResult, RestrictedArtifactRef } from '../../src/shared/domain.js';
import type { FaultController, FaultDirective } from '../fixtures/faults.js';

type App = AdapterCallContext['app'];
type TechnicalEvidence = z.infer<typeof GitHubTechnicalEvidenceSchema>;
type CommitmentBundle = z.infer<typeof HubSpotCommitmentBundleSchema>;
type Task = z.infer<typeof HubSpotTaskSchema>;
type Note = z.infer<typeof HubSpotNoteSchema>;
type Draft = z.infer<typeof GmailDraftSchema>;
type Message = z.infer<typeof SlackMessageSchema>;
type Comment = z.infer<typeof GitHubCommentSchema>;
type FailureReason = Extract<ReadResult<unknown>, { status: 'incomplete' }>['reason'];
type RecordKind = 'comment' | 'task' | 'note' | 'draft' | 'message';

/** A structural projection of world.json; provider source records use F02 schemas. */
export interface FakeProviderWorld {
  fixtureId: string;
  clockAt: string;
  accounts: Record<App, string>;
  github: { technicalEvidence: TechnicalEvidence; incidentFields?: Record<string, unknown> };
  hubspot: CommitmentBundle;
  slack: { workspaceId: string; channelId: string; approverId: string; messages?: Message[] };
  gmail?: { drafts: Draft[] };
  ticketMappings?: { commitmentId: string; ticketId: string }[];
}
export interface DeclaredSourceEdit {
  editId: string;
  stage: 'source_edit' | 'repair';
  actorId: string;
  observedAt: string;
  target: 'incident' | 'commitment' | 'company' | 'contact' | 'owner' | 'scope' | RecordKind;
  action?: 'create' | 'update';
  marker?: string;
  recordId: string;
  fields: Record<string, unknown>;
}
export interface FakeHistoryEntry {
  sequence: number;
  namespace: string;
  app: App;
  recordId: string;
  action: 'seed' | 'create' | 'update' | 'source_edit' | 'repair' | 'reset';
  stage: 'setup' | 'scored' | 'source_edit' | 'repair';
  actorId: string;
  observedAt: string;
  before: unknown;
  after: unknown;
  marker: string | null;
}
export interface FakeProviderOptions {
  namespace: string;
  ownerId: string;
  world: FakeProviderWorld;
  now?: () => string;
  pageSize?: number;
  faults?: FaultController;
  missingScopes?: readonly AdapterOperation[];
  declaredEdits?: readonly DeclaredSourceEdit[];
}

/** No oracle, model output, executor cache, credentials, or real provider is accepted. */
export function createFakeProviders(options: FakeProviderOptions) {
  const namespace = IdSchema.parse(options.namespace);
  if (namespace.length > 60) throw new Error('fake_namespace_too_long');
  const ownerId = IdSchema.parse(options.ownerId);
  const world = structuredClone(options.world);
  for (const accountRef of Object.values(world.accounts)) IdSchema.parse(accountRef);
  UtcTimestampSchema.parse(world.clockAt);
  IdSchema.parse(world.slack.workspaceId);
  const now = () => UtcTimestampSchema.parse(options.now?.() ?? world.clockAt);
  const pageSize = options.pageSize ?? 1;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10000) throw new Error('invalid_fake_page_size');
  const missingScopes = new Set(options.missingScopes ?? []);
  const declarations = immutable(structuredClone(options.declaredEdits ?? []));
  if (new Set(declarations.map(edit => edit.editId)).size !== declarations.length) throw new Error('duplicate_declared_edit');
  let technical = GitHubTechnicalEvidenceSchema.parse(world.github.technicalEvidence);
  let incidentFields = structuredClone(world.github.incidentFields ?? {});
  let bundle = HubSpotCommitmentBundleSchema.parse(world.hubspot);
  const ticketMappings = immutable((world.ticketMappings ?? []).map(mapping => ({
    commitmentId: IdSchema.parse(mapping.commitmentId), ticketId: IdSchema.parse(mapping.ticketId),
  })));
  if (new Set(ticketMappings.map(mapping => mapping.ticketId)).size !== ticketMappings.length ||
      new Set(ticketMappings.map(mapping => mapping.commitmentId)).size !== ticketMappings.length ||
      ticketMappings.some(mapping => !bundle.commitments.some(row => row.id === mapping.commitmentId)))
    throw new Error('invalid_fake_ticket_mapping');
  // Tickets and commitments are two observations of the same persisted source row.
  function projectTickets(commitments = bundle.commitments) {
    return ticketMappings.flatMap(mapping => {
      const commitment = commitments.find(row => row.id === mapping.commitmentId);
      return commitment ? [{ ...commitment, id: mapping.ticketId, commitmentId: commitment.id }] : [];
    });
  }
  let comments: Comment[] = structuredClone(technical.comments);
  let tasks: Task[] = [];
  let notes: Note[] = [];
  let drafts: Draft[] = (world.gmail?.drafts ?? []).map(row => GmailDraftSchema.parse(row));
  let messages: Message[] = (world.slack.messages ?? []).map(row => SlackMessageSchema.parse(row));
  let nextId = 0;
  let collectionNumber = 0;
  const history: FakeHistoryEntry[] = [];
  const artifacts = new Map<string, string>();
  const markers = new Map<string, string>();
  const appliedEdits = new Set<string>();
  const clone = <T>(value: T): T => structuredClone(value);
  const frozenCopy = <T>(value: T): Readonly<T> => immutable(clone(value));
  // Approval validates Slack's actual numeric timestamp identity and ordering.
  const allocateId = (kind: string) => kind === 'message'
    ? `${Math.floor(Date.parse(now()) / 1000)}.${String(Date.parse(now()) % 1000 * 1000 + ++nextId).padStart(6, '0')}`
    : `${namespace}.${kind}.${++nextId}`;
  const recordId = (row: Record<string, unknown>) => String(row.id ?? row.draftId ?? row.messageTs);
  function artifact(value: unknown, mediaType: RestrictedArtifactRef['mediaType'] = 'application/json'): RestrictedArtifactRef {
    const bytes = typeof value === 'string' && mediaType !== 'application/json' ? value : canonical(value);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifactId = `${namespace}.artifact.${sha256}`;
    artifacts.set(artifactId, bytes);
    return { artifactId, sha256, byteLength: Buffer.byteLength(bytes), mediaType };
  }
  function record(app: App, id: string, action: FakeHistoryEntry['action'], before: unknown, after: unknown,
    actorId = 'promiseguard_fake_bot', stage: FakeHistoryEntry['stage'] = 'scored', observedAt = now(), marker: string | null = null) {
    history.push(clone({ sequence: history.length + 1, namespace, app, recordId: id, action, stage,
      actorId, observedAt, before, after, marker }));
  }
  function seedHistory() {
    record('github', technical.incident.issueId, 'seed', null, { ...technical, incidentFields }, ownerId, 'setup');
    for (const [kind, rows] of Object.entries(bundle)) for (const row of rows)
      record('hubspot', row.id, 'seed', null, { kind, ...row }, ownerId, 'setup');
    for (const ticket of projectTickets()) record('hubspot', ticket.id, 'seed', null, ticket, ownerId, 'setup');
    for (const row of comments) record('github', row.id, 'seed', null, row, row.authorId, 'setup', row.updatedAt);
    for (const row of drafts) record('gmail', row.draftId, 'seed', null, row, ownerId, 'setup');
    for (const row of messages) record('slack', row.messageTs, 'seed', null, row, row.actorId, 'setup', row.observedAt);
  }
  seedHistory();
  function assertContext(context: AdapterCallContext, operation: AdapterOperation) {
    const app = operation.split('.')[0] as App;
    parseAdapterContext(context, { app, accountRef: world.accounts[app] }, operation);
    if (context.mode !== 'fake') throw new Error('fake_provider_requires_fake_mode');
  }
  function faultReason(fault: FaultDirective | undefined): FailureReason | undefined {
    if (!fault) return;
    if (fault.kind === 'missing_scope') return 'denied';
    if (fault.kind === 'page_two_failure') return 'page_failed';
    if (fault.kind === 'timeout') return 'timeout';
    if (fault.kind === 'tool_error') return 'transport_error';
    if (fault.kind === 'rate_limited') return 'rate_limited';
    if (fault.kind === 'pagination_budget') return 'budget_exhausted';
    return;
  }
  function patchRecord(target: DeclaredSourceEdit['target'], id: string, fields: Record<string, unknown>,
    actorId: string, observedAt: string, stage: 'source_edit' | 'repair') {
    IdSchema.parse(actorId); UtcTimestampSchema.parse(observedAt);
    if (target === 'scope') {
      const operation = id as AdapterOperation;
      const app = operation.split('.')[0] as App;
      if (!['github', 'hubspot', 'gmail', 'slack'].includes(app) || typeof fields.isAvailable !== 'boolean')
        throw new Error('invalid_fake_scope_edit');
      const before = !missingScopes.has(operation);
      if (fields.isAvailable) missingScopes.delete(operation); else missingScopes.add(operation);
      record(app, id, stage, { isAvailable: before }, { isAvailable: fields.isAvailable }, actorId, stage, observedAt);
      return;
    }
    if (target === 'incident') {
      if (id !== technical.incident.issueId) throw new Error('fake_edit_record_missing');
      const before = clone({ technicalEvidence: technical, incidentFields });
      const { incident, title, body, incidentFields: sourceFields } = fields;
      technical = GitHubTechnicalEvidenceSchema.parse({ ...technical,
        ...(incident ? { incident: { ...technical.incident, ...(incident as object) } } : {}),
        ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) });
      if (sourceFields) incidentFields = { ...incidentFields, ...(sourceFields as object) };
      record('github', id, stage, before, { technicalEvidence: technical, incidentFields }, actorId, stage, observedAt);
      return;
    }
    const sourceKinds = { commitment: 'commitments', company: 'companies', contact: 'contacts', owner: 'owners' } as const;
    if (target in sourceKinds) {
      const key = sourceKinds[target as keyof typeof sourceKinds];
      const rows = bundle[key];
      const old = rows.find(row => row.id === id);
      if (!old) throw new Error('fake_edit_record_missing');
      const next = HubSpotCommitmentBundleSchema.parse({ ...bundle, [key]: rows.map(row => row.id === id ? { ...row, ...fields, ...('version' in row ? { version: allocateId('version') } : {}), id } : row) });
      const previousTickets = target === 'commitment' ? projectTickets() : [];
      bundle = next;
      record('hubspot', id, stage, old, next[key].find(row => row.id === id), actorId, stage, observedAt);
      if (target === 'commitment') for (const ticket of projectTickets().filter(row => row.commitmentId === id))
        record('hubspot', ticket.id, stage, previousTickets.find(row => row.id === ticket.id), ticket, actorId, stage, observedAt);
      return;
    }
    const kind = target as RecordKind;
    const rows = records(kind);
    const index = rows.findIndex(row => recordId(row) === id);
    if (index < 0) throw new Error('fake_edit_record_missing');
    const before = clone(rows[index]);
    const next = parseRecord(kind, { ...before, ...fields,
      ...('version' in before ? { version: allocateId('version') } : {}),
      ...(kind === 'comment' ? { updatedAt: observedAt } : {}),
      ...(kind === 'message' ? { messageTs: id, editedAt: observedAt, actorId } : kind === 'draft' ? { draftId: id } : { id }) });
    rows[index] = next;
    record(appFor(kind), id, stage, before, next, actorId, stage, observedAt, markers.get(id) ?? null);
  }
  function applyReadDrift(fault: FaultDirective | undefined) {
    if (fault?.kind !== 'human_drift') return;
    const fields = clone(fault.fields ?? {});
    const target = fields.target as DeclaredSourceEdit['target'] | undefined;
    const id = fields.recordId as string | undefined;
    delete fields.target; delete fields.recordId;
    if (!target || !id) throw new Error('human_drift_requires_target_and_record_id');
    patchRecord(target, id, fields, fault.actorId ?? 'fixture_human', fault.observedAt ?? now(), 'source_edit');
  }
  async function read<T>(context: ReadCallContext, operation: AdapterOperation,
    project: () => { rows: unknown[]; assemble: (rows: unknown[]) => T }, absentReason?: FailureReason): Promise<ReadResult<T>> {
    assertContext(context, operation);
    const startedAt = now();
    const receipt: CollectionReceipt = { schemaVersion: 2, collectionId: `${namespace}.collection.${++collectionNumber}`,
      app: context.app, accountRef: context.accountRef, producerId: `${namespace}.independent_reader`, startedAt,
      finishedAt: startedAt, status: 'complete', reason: null, requiredQueryIds: [context.operation], pages: [] };
    let reason: FailureReason | undefined = missingScopes.has(operation) ? 'denied' : absentReason;
    if (Date.parse(startedAt) >= Date.parse(context.deadlineAt)) reason = 'timeout';
    const taken = options.faults?.take({ target: 'provider', operation, phase: 'read', page: 1 });
    if (taken?.kind === 'missing_scope') missingScopes.add(operation);
    if (!reason) reason = faultReason(taken);
    applyReadDrift(taken);
    const projection = project();
    const rows = taken?.kind === 'invisible_marker' ? [] : projection.rows;
    const assemble = projection.assemble;
    const accepted: unknown[] = [];
    let bytes = 0;
    for (let offset = 0, page = 1; !reason; page++) {
      if (Date.parse(now()) >= Date.parse(context.deadlineAt) || Date.parse(now()) - Date.parse(startedAt) >= context.budgets.totalMs) { reason = 'timeout'; break; }
      if (page > context.budgets.maxPages || (offset < rows.length && accepted.length >= context.budgets.maxRecords)) {
        reason = 'budget_exhausted'; break;
      }
      if (page > 1) {
        const fault = options.faults?.take({ target: 'provider', operation, phase: 'read', page });
        if (fault?.kind === 'missing_scope') missingScopes.add(operation);
        reason = faultReason(fault);
        if (reason) break;
        // A read has a fixed snapshot. Later drift is visible to the next read.
      }
      const count = Math.min(pageSize, context.budgets.maxRecords - accepted.length);
      const pageRows = rows.slice(offset, offset + count);
      const response = artifact(pageRows);
      if (bytes + response.byteLength > context.budgets.maxResponseBytes) { reason = 'budget_exhausted'; break; }
      bytes += response.byteLength;
      const nextOffset = offset + pageRows.length;
      receipt.pages.push({ queryId: context.operation, cursor: offset === 0 ? null : String(offset),
        nextCursor: nextOffset < rows.length ? String(nextOffset) : null, recordCount: pageRows.length,
        response, providerAttemptId: context.providerAttemptId });
      accepted.push(...pageRows);
      offset = nextOffset;
      if (offset >= rows.length) break;
    }
    receipt.finishedAt = now();
    if (reason) {
      receipt.status = 'incomplete'; receipt.reason = reason;
      return frozenCopy({ status: 'incomplete' as const, reason,
        ...(receipt.pages.length ? { partialData: assemble(accepted) } : {}), receipt });
    }
    return frozenCopy({ status: 'complete' as const, data: assemble(accepted), receipt });
  }
  function rowsRead<T>(context: ReadCallContext, operation: AdapterOperation, rows: () => T[]) {
    return read(context, operation, () => ({ rows: clone(rows()), assemble: values => values as T[] }));
  }
  function oneRead<T>(context: ReadCallContext, operation: AdapterOperation, row: () => T | null) {
    return read<T | null>(context, operation, () => {
      const value = clone(row()); return { rows: value === null ? [] : [value], assemble: values => values[0] as T ?? null };
    });
  }
  function records(kind: RecordKind): Record<string, unknown>[] {
    return ({ comment: comments, task: tasks, note: notes, draft: drafts, message: messages })[kind];
  }
  function appFor(kind: RecordKind): App { return ({ comment: 'github', task: 'hubspot', note: 'hubspot', draft: 'gmail', message: 'slack' } as const)[kind]; }
  function parseRecord(kind: RecordKind, value: unknown): Record<string, unknown> {
    const parsed = ({ comment: GitHubCommentSchema, task: HubSpotTaskSchema, note: HubSpotNoteSchema,
      draft: GmailDraftSchema, message: SlackMessageSchema })[kind].parse(value);
    if (kind === 'draft') {
      const draft = parsed as Draft;
      // Readback MIME describes stored fields, independently of the write acknowledgement.
      draft.rawMimeRef = artifact(`To: ${draft.to.join(', ')}\r\nCc: ${draft.cc.join(', ')}\r\nBcc: ${draft.bcc.join(', ')}\r\nSubject: ${draft.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${draft.body}`, 'message/rfc822');
    }
    return parsed;
  }
  function markerMatches(row: { body: string }, id: string, marker: string) { return markers.get(id) === marker || row.body.includes(marker); }
  async function write(context: ProtectedCallContext | CoordinationCallContext, operation: AdapterOperation, kind: RecordKind,
    materialize: (id: string) => Record<string, unknown>, existingId?: string): Promise<MutationOutcome> {
    assertContext(context, operation);
    const fault = options.faults?.take({ target: 'provider', operation, phase: 'write' });
    if (fault?.kind === 'missing_scope') missingScopes.add(operation);
    const denied = missingScopes.has(operation) ? 'denied' : faultReason(fault);
    if (denied) return { status: 'not_applied', reason: denied, receipt: artifact({ operation, wasApplied: false, reason: denied }) };
    if (Date.parse(now()) >= Date.parse(context.deadlineAt))
      return { status: 'not_applied', reason: 'timeout', receipt: artifact({ operation, wasApplied: false, reason: 'timeout' }) };
    const rows = records(kind);
    if (existingId && !rows.some(row => recordId(row) === existingId))
      return { status: 'not_applied', reason: 'missing_identity', receipt: artifact({ operation, wasApplied: false }) };
    const id = existingId ?? allocateId(kind);
    const marker = 'effectKey' in context ? context.effectKey : context.marker;
    const acknowledged = materialize(id);
    if (fault?.kind !== 'phantom_slack_success' || kind !== 'message') {
      const stored = parseRecord(kind, { ...acknowledged, ...(fault?.kind === 'wrong_fields_ack' ? fault.fields : {}) });
      const oldIndex = rows.findIndex(row => recordId(row) === id);
      const before = oldIndex < 0 ? null : clone(rows[oldIndex]);
      if (oldIndex < 0) rows.push(stored); else rows[oldIndex] = stored;
      markers.set(recordId(stored), marker);
      record(context.app, recordId(stored), existingId ? 'update' : 'create', before, stored, 'promiseguard_fake_bot', 'scored', now(), marker);
      if (fault?.kind === 'duplicate_creation') {
        const duplicateId = allocateId(kind);
        const duplicate = parseRecord(kind, materialize(duplicateId));
        rows.push(duplicate); markers.set(duplicateId, marker);
        record(context.app, duplicateId, 'create', null, duplicate, 'promiseguard_fake_bot', 'scored', now(), marker);
      }
    }
    if (fault?.kind === 'accepted_unknown_write')
      return frozenCopy({ status: 'unknown' as const, reason: 'timeout' as const,
        receipt: artifact({ operation, transportOutcome: 'timeout', providerOutcome: 'unknown' }) });
    // The acknowledgement deliberately uses the request, never the independently persisted row.
    return frozenCopy({ status: 'applied' as const, providerId: id, receipt: artifact({ operation, providerId: id, acknowledged }) });
  }
  const githubReader: GitHubReader = Object.freeze<GitHubReader>({ scope: Object.freeze({ app: 'github' as const, accountRef: world.accounts.github }), mode: 'fake',
    resolveIncident: (url, context) => read(context, 'github.resolveIncident', () => ({ rows: [clone(technical.incident)],
      assemble: rows => rows[0] as TechnicalEvidence['incident'] }), url === technical.incident.canonicalUrl ? undefined : 'missing_identity'),
    readTechnicalEvidence: (incident, context) => read(context, 'github.readTechnicalEvidence', () => {
      const root = clone({ ...technical, comments: [] as Comment[], changes: [] as TechnicalEvidence['changes'] });
      const rows = [{ kind: 'root', value: root }, ...comments.map(value => ({ kind: 'comment', value: clone(value) })),
        ...technical.changes.map(value => ({ kind: 'change', value: clone(value) }))];
      return { rows, assemble: values => {
        const parts = values as typeof rows;
        return { ...root, comments: parts.filter(row => row.kind === 'comment').map(row => row.value as Comment),
          changes: parts.filter(row => row.kind === 'change').map(row => row.value as TechnicalEvidence['changes'][number]) };
      } };
    }, incident.issueId === technical.incident.issueId && incident.repositoryId === technical.incident.repositoryId ? undefined : 'missing_identity'),
    findComments: (incident, marker, context) => rowsRead(context, 'github.findComments', () => comments.filter(row =>
      row.issueId === incident.issueId && row.repositoryId === incident.repositoryId && markerMatches(row, row.id, marker))),
    getComment: (id, context) => oneRead(context, 'github.getComment', () => comments.find(row => row.id === id) ?? null),
  });
  const hubspotReader: HubSpotReader = Object.freeze<HubSpotReader>({ scope: Object.freeze({ app: 'hubspot' as const, accountRef: world.accounts.hubspot }), mode: 'fake',
    readCommitmentBundle: (_service, context) => read(context, 'hubspot.readCommitmentBundle', () => ({
      // Preserve unrelated records so deterministic selection and protected-record checks see Beta.
      rows: Object.entries(bundle).flatMap(([kind, rows]) => rows.map(value => ({ kind, value: clone(value) }))),
      assemble: values => {
        const result: CommitmentBundle = { commitments: [], companies: [], contacts: [], owners: [] };
        for (const item of values as { kind: keyof CommitmentBundle; value: never }[]) result[item.kind].push(item.value);
        return result;
      },
    })),
    findTasks: (marker, context) => rowsRead(context, 'hubspot.findTasks', () => tasks.filter(row => markerMatches(row, row.id, marker))),
    getTask: (id, context) => oneRead(context, 'hubspot.getTask', () => tasks.find(row => row.id === id) ?? null),
    findNotes: (marker, context) => rowsRead(context, 'hubspot.findNotes', () => notes.filter(row => markerMatches(row, row.id, marker))),
    getNote: (id, context) => oneRead(context, 'hubspot.getNote', () => notes.find(row => row.id === id) ?? null),
  });
  const gmailReader: GmailReader = Object.freeze<GmailReader>({ scope: Object.freeze({ app: 'gmail' as const, accountRef: world.accounts.gmail }), mode: 'fake',
    listDrafts: context => rowsRead(context, 'gmail.listDrafts', () => drafts),
    findDrafts: (marker, context) => rowsRead(context, 'gmail.findDrafts', () => drafts.filter(row => markerMatches(row, row.draftId, marker) || row.subject.includes(marker))),
    getDraft: (id, context) => oneRead(context, 'gmail.getDraft', () => drafts.find(row => row.draftId === id) ?? null),
  });
  // observedAt describes this fresh read, not the message's original creation time.
  const observedMessage = (message: Message | undefined): Message | null => message ? { ...message, observedAt: now() } : null;
  const slackReader: SlackReader = Object.freeze<SlackReader>({ scope: Object.freeze({ app: 'slack' as const, accountRef: world.accounts.slack }), mode: 'fake',
    readApprovalThread: (channelId, threadTs, context) => rowsRead(context, 'slack.readApprovalThread', () => messages.filter(row => row.channelId === channelId && row.threadTs === threadTs).map(row => observedMessage(row)!)),
    getMessage: (channelId, messageTs, context) => oneRead(context, 'slack.getMessage', () => observedMessage(messages.find(row => row.channelId === channelId && row.messageTs === messageTs))),
    findReview: (marker, context) => rowsRead(context, 'slack.findReview', () => messages.filter(row => markerMatches(row, row.messageTs, marker)).map(row => observedMessage(row)!)),
    readSummary: (channelId, messageTs, context) => oneRead(context, 'slack.readSummary', () => observedMessage(messages.find(row => row.channelId === channelId && row.messageTs === messageTs))),
  });
  const github: GitHubAdapter = Object.freeze<GitHubAdapter>({ ...githubReader,
    createComment: (input, context) => {
      const data = CommentWriteSchema.parse(input);
      return write(context, 'github.createComment', 'comment', id => ({ ...data, id, authorId: 'promiseguard_fake_bot', updatedAt: now(), version: allocateId('version') }));
    },
    updateComment: (id, input, context) => {
      const data = CommentWriteSchema.parse(input);
      return write(context, 'github.updateComment', 'comment', providerId => ({ ...data, id: providerId, authorId: 'promiseguard_fake_bot', updatedAt: now(), version: allocateId('version') }), id);
    },
  });
  const hubspot: HubSpotAdapter = Object.freeze<HubSpotAdapter>({ ...hubspotReader,
    createTask: (input, context) => {
      const { companyId, commitmentId, ...data } = TaskWriteSchema.parse(input);
      return write(context, 'hubspot.createTask', 'task', id => ({ ...data, id, companyIds: [companyId], commitmentIds: [commitmentId], version: allocateId('version') }));
    },
    createNote: (input, context) => {
      const { companyId, commitmentId, taskId, ...data } = NoteWriteSchema.parse(input);
      return write(context, 'hubspot.createNote', 'note', id => ({ ...data, id, companyIds: [companyId], commitmentIds: [commitmentId], taskIds: [taskId], version: allocateId('version') }));
    },
  });
  const gmail: GmailAdapter = Object.freeze<GmailAdapter>({ ...gmailReader,
    createDraft: (input, context) => {
      const data = DraftWriteSchema.parse(input);
      return write(context, 'gmail.createDraft', 'draft', draftId => ({ ...data, to: [data.to], draftId,
        messageId: allocateId('gmail_message'), version: allocateId('version'),
        rawMimeRef: artifact(`To: ${data.to}\r\nSubject: ${data.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${data.body}`, 'message/rfc822') }));
    },
  });
  function slackWrite(operation: AdapterOperation, input: z.infer<typeof SlackWriteSchema>, context: CoordinationCallContext, existingId?: string) {
    const data = SlackWriteSchema.parse(input);
    return write(context, operation, 'message', messageTs => ({ ...data, workspaceId: world.slack.workspaceId,
      threadTs: data.threadTs ?? messageTs, messageTs, actorId: 'promiseguard_fake_bot', isBot: true,
      subtype: null, editedAt: existingId ? now() : null, deleted: false, observedAt: now() }), existingId);
  }
  const slack: SlackAdapter = Object.freeze<SlackAdapter>({ ...slackReader,
    postReview: (input, context) => slackWrite('slack.postReview', input, context),
    updateReview: (id, input, context) => slackWrite('slack.updateReview', input, context, id),
    postSummary: (input, context) => slackWrite('slack.postSummary', input, context),
    updateSummary: (id, input, context) => slackWrite('slack.updateSummary', input, context, id),
  });
  function assertOwner(identity: { namespace: string; ownerId: string }) {
    if (identity.namespace !== namespace || identity.ownerId !== ownerId) throw new Error('fake_namespace_ownership_mismatch');
  }
  const operator = Object.freeze({
    snapshot: () => frozenCopy({ namespace, fixtureId: world.fixtureId, capturedAt: now(), evidenceMode: 'synthetic_fixture' as const,
      github: { technicalEvidence: { ...technical, comments }, incidentFields }, hubspot: { ...bundle, tickets: projectTickets(), tasks, notes },
      gmail: { drafts }, slack: { workspaceId: world.slack.workspaceId, messages } }),
    history: () => frozenCopy(history),
    readArtifact: (artifactId: string) => artifacts.get(artifactId) ?? null,
    applyDeclaredEdit: (editId: string, stage: DeclaredSourceEdit['stage'], identity: { namespace: string; ownerId: string }) => {
      assertOwner(identity);
      const edit = declarations.find(candidate => candidate.editId === editId);
      if (!edit || edit.stage !== stage || appliedEdits.has(editId)) throw new Error('undeclared_or_repeated_source_edit');
      if (edit.action === 'create') {
        if (!['comment', 'task', 'note', 'draft', 'message'].includes(edit.target)) throw new Error('invalid_declared_create_target');
        const kind = edit.target as RecordKind;
        const value = parseRecord(kind, edit.fields);
        if (recordId(value) !== edit.recordId || records(kind).some(row => recordId(row) === edit.recordId))
          throw new Error('invalid_or_duplicate_declared_record');
        IdSchema.parse(edit.actorId); UtcTimestampSchema.parse(edit.observedAt);
        records(kind).push(value);
        if (edit.marker) markers.set(edit.recordId, edit.marker);
        record(appFor(kind), edit.recordId, stage, null, value, edit.actorId, stage, edit.observedAt, edit.marker ?? null);
      } else {
        patchRecord(edit.target, edit.recordId, edit.fields, edit.actorId, edit.observedAt, stage);
      }
      appliedEdits.add(editId);
    },
    // Invalid-authority but schema-valid Slack replies exercise approval rejection.
    appendFixtureMessage: (input: Message, identity: { namespace: string; ownerId: string }) => {
      assertOwner(identity);
      const message = SlackMessageSchema.parse(input);
      if (messages.some(row => row.messageTs === message.messageTs && row.workspaceId === message.workspaceId))
        throw new Error('duplicate_fake_message');
      messages.push(clone(message));
      record('slack', message.messageTs, 'create', null, message, message.actorId, 'scored', message.observedAt);
    },
    appendHumanMessage: (input: Message, identity: { namespace: string; ownerId: string }) => {
      assertOwner(identity);
      const message = SlackMessageSchema.parse(input);
      if (message.isBot || message.workspaceId !== world.slack.workspaceId || messages.some(row => row.messageTs === message.messageTs))
        throw new Error('invalid_fake_human_message');
      messages.push(clone(message));
      record('slack', message.messageTs, 'create', null, message, message.actorId, 'scored', message.observedAt);
    },
    reset: (identity: { namespace: string; ownerId: string }) => {
      assertOwner(identity);
      technical = GitHubTechnicalEvidenceSchema.parse(world.github.technicalEvidence);
      bundle = HubSpotCommitmentBundleSchema.parse(world.hubspot);
      incidentFields = clone(world.github.incidentFields ?? {});
      comments = clone(technical.comments); tasks = []; notes = [];
      drafts = (world.gmail?.drafts ?? []).map(row => GmailDraftSchema.parse(row));
      messages = (world.slack.messages ?? []).map(row => SlackMessageSchema.parse(row));
      markers.clear(); appliedEdits.clear();
      // History and restricted artifacts are append-only even across operator cleanup.
      for (const app of ['github', 'hubspot', 'gmail', 'slack'] as const) record(app, namespace, 'reset', null, null, ownerId, 'setup');
      seedHistory();
    },
  });
  const observer = Object.freeze({ snapshot: operator.snapshot, history: operator.history, readArtifact: operator.readArtifact });
  return Object.freeze({ adapters: Object.freeze({ github, hubspot, gmail, slack }),
    readers: Object.freeze({ github: githubReader, hubspot: hubspotReader, gmail: gmailReader, slack: slackReader }), observer, operator });
}
