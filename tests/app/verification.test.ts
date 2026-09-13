import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  GitHubCommentSchema,
  GmailDraftSchema,
  HubSpotNoteSchema,
  HubSpotTaskSchema,
  CoordinationCallContextSchema,
  ReadCallContextSchema,
  SlackMessageSchema,
  type CoordinationCallContext,
  type ReadCallContext,
  type SlackCoordinator,
} from '../../src/shared/adapters.js';
import {
  finalizeVerifiedRun,
  type SummaryEffectPersistence,
} from '../../src/server/verification/finalize.js';
import {
  CollectionReceiptSchema,
  EffectRecordSchema,
  ImmutablePlanSchema,
  SelectionSchema,
  canonical,
  planHashMaterial,
  requestHashMaterial,
  sha256Text,
  type ImmutablePlan,
  type ReadResult,
} from '../../src/shared/domain.js';
import {
  assertCommentReadback,
  assertDraftReadback,
  assertNoteReadback,
  assertSlackSummaryReadback,
  assertTaskReadback,
  assertUniqueProviderBinding,
  type ProtectedCommitmentExpectation,
} from '../../src/server/verification/assertions.js';
import {
  verifyBusinessArtifacts,
  verifyNoAffected,
  type ReadbackReaders,
  type ReadbackRecordInput,
  type ReadbackRecorder,
  type ScopeReadbackRecordInput,
} from '../../src/server/verification/readback.js';

const digest = 'a'.repeat(64);
const at = '2026-09-14T10:00:00Z';
const plan = ImmutablePlanSchema.parse({
  schemaVersion: 2,
  runId: 'run-1',
  revision: 1,
  planHash: digest,
  createdAt: at,
  incident: {
    schemaVersion: 2,
    repositoryId: 'repository-1',
    issueId: 'issue-1',
    issueNumber: 1,
    canonicalUrl: 'https://github.com/fixture/project/issues/1',
    service: 'billing-api',
    environment: 'production',
  },
  selection: {
    schemaVersion: 2,
    policyVersion: 'selection-v1',
    evaluatedAt: at,
    sourceBundleRef: { artifactId: 'source-bundle', sha256: digest, byteLength: 1, mediaType: 'application/json' },
    sourceComplete: true,
    selected: [{
      commitmentId: 'commitment-1',
      companyId: 'company-1',
      ownerId: 'owner-1',
      contactId: 'contact-1',
      mailbox: 'customer@example.test',
      dueAt: '2026-09-16T10:00:00Z',
      service: 'billing-api',
      reason: 'service_match',
    }],
    excluded: [],
  },
  sources: ['github', 'hubspot'].map(app => ({
    snapshotId: `snapshot-${app}`,
    app,
    accountRef: `account-${app}`,
    sourceIds: [`source-${app}`],
    capturedAt: at,
    relevantVersion: 'source-v1',
    artifact: { artifactId: `artifact-${app}`, sha256: digest, byteLength: 1, mediaType: 'application/json' },
    receipt: {
      schemaVersion: 2,
      collectionId: `collection-${app}`,
      app,
      accountRef: `account-${app}`,
      producerId: 'fixture-reader',
      startedAt: at,
      finishedAt: at,
      status: 'complete',
      reason: null,
      requiredQueryIds: ['source'],
      pages: [{
        queryId: 'source',
        cursor: null,
        nextCursor: null,
        recordCount: 1,
        response: { artifactId: `response-${app}`, sha256: digest, byteLength: 1, mediaType: 'application/json' },
        providerAttemptId: `attempt-${app}`,
      }],
    },
  })),
  contents: [{ contentKey: 'approved-body', text: 'Approved update', sha256: digest }],
  effects: [
    {
      effectKey: 'effect-task', commitmentId: 'commitment-1', requestDigest: digest, kind: 'task', app: 'hubspot',
      payload: { companyId: 'company-1', commitmentId: 'commitment-1', ownerId: 'owner-1',
        dueAt: '2026-09-16T10:00:00Z', status: 'NOT_STARTED', subject: 'Follow up effect-task',
        body: [{ type: 'approved_content', planRevision: 1, contentKey: 'approved-body' }] },
    },
    {
      effectKey: 'effect-note', commitmentId: 'commitment-1', requestDigest: digest, kind: 'note', app: 'hubspot',
      payload: { companyId: 'company-1', commitmentId: 'commitment-1',
        taskId: { type: 'effect_id', effectKey: 'effect-task' },
        body: [{ type: 'text', text: 'Task: ' }, { type: 'effect_id', effectKey: 'effect-task' }] },
    },
    {
      effectKey: 'effect-draft', commitmentId: 'commitment-1', requestDigest: digest, kind: 'draft', app: 'gmail',
      payload: { to: 'customer@example.test', cc: [], bcc: [], subject: 'Incident update effect-draft',
        body: [{ type: 'approved_content', planRevision: 1, contentKey: 'approved-body' }], isDraft: true },
    },
    {
      effectKey: 'effect-comment', commitmentId: null, requestDigest: digest, kind: 'comment', app: 'github',
      payload: { repositoryId: 'repository-1', issueId: 'issue-1',
        taskIds: [{ type: 'effect_id', effectKey: 'effect-task' }],
        draftIds: [{ type: 'effect_id', effectKey: 'effect-draft' }],
        body: [{ type: 'text', text: 'Task ' }, { type: 'effect_id', effectKey: 'effect-task' },
          { type: 'text', text: '; draft ' }, { type: 'effect_id', effectKey: 'effect-draft' }] },
    },
    {
      effectKey: 'effect-thread', commitmentId: null, requestDigest: digest, kind: 'thread', app: 'slack',
      payload: { channelId: 'channel-1', threadTs: '100.1', body: [{ type: 'text', text: 'Verified task ' },
        { type: 'effect_id', effectKey: 'effect-task' }, { type: 'text', text: ', note ' },
        { type: 'effect_id', effectKey: 'effect-note' }, { type: 'text', text: ', draft ' },
        { type: 'effect_id', effectKey: 'effect-draft' }, { type: 'text', text: ', comment ' },
        { type: 'effect_id', effectKey: 'effect-comment' },
        { type: 'text', text: '. Coordination finalization: pending. effect-thread' }] },
    },
  ],
});

const effectIds = {
  'effect-task': 'task-1',
  'effect-note': 'note-1',
  'effect-draft': 'draft-1',
  'effect-comment': 'comment-1',
  'effect-thread': 'summary-1',
};

async function validPlan(): Promise<ImmutablePlan> {
  return rehashPlan(structuredClone(plan));
}

async function rehashPlan(planValue: ImmutablePlan): Promise<ImmutablePlan> {
  let value = structuredClone(planValue);
  value = { ...value, contents: await Promise.all(value.contents.map(async content => ({
    ...content, sha256: await sha256Text(content.text),
  }))) };
  value = { ...value, effects: await Promise.all(value.effects.map(async effect => ({
    ...effect, requestDigest: await sha256Text(canonical(requestHashMaterial(effect, value.contents))),
  }))) };
  value = { ...value, planHash: await sha256Text(canonical(planHashMaterial(value))) };
  return ImmutablePlanSchema.parse(value);
}

function ref(id: string) {
  return { artifactId: id, sha256: digest, byteLength: 1, mediaType: 'application/json' as const };
}

function complete<T>(context: ReturnType<typeof ReadCallContextSchema.parse>, data: T): ReadResult<T> {
  return { status: 'complete', data, receipt: CollectionReceiptSchema.parse({ schemaVersion: 2,
    collectionId: context.logicalCallId, app: context.app, accountRef: context.accountRef,
    producerId: 'verification-fixture-reader', startedAt: at, finishedAt: at, status: 'complete', reason: null,
    requiredQueryIds: [context.operation], pages: [{ queryId: context.operation, cursor: null, nextCursor: null,
      recordCount: Array.isArray(data) ? data.length : data === null ? 0 : 1,
      response: ref(`response-${context.providerAttemptId}`), providerAttemptId: context.providerAttemptId }] }) };
}

function incomplete<T>(context: ReturnType<typeof ReadCallContextSchema.parse>): ReadResult<T> {
  return { status: 'incomplete', reason: 'timeout', receipt: CollectionReceiptSchema.parse({ schemaVersion: 2,
    collectionId: context.logicalCallId, app: context.app, accountRef: context.accountRef,
    producerId: 'verification-fixture-reader', startedAt: at, finishedAt: at, status: 'incomplete', reason: 'timeout',
    requiredQueryIds: [context.operation], pages: [] }) };
}

function readbackFixture(value: ImmutablePlan) {
  const [taskEffect, noteEffect, draftEffect, commentEffect] = value.effects;
  const task = HubSpotTaskSchema.parse({ id: 'task-1', companyIds: ['company-1'], commitmentIds: ['commitment-1'],
    ownerId: 'owner-1', dueAt: '2026-09-16T10:00:00Z', status: 'NOT_STARTED',
    subject: 'Follow up effect-task', body: 'Approved update', version: 'task-v1' });
  const note = HubSpotNoteSchema.parse({ id: 'note-1', companyIds: ['company-1'], commitmentIds: ['commitment-1'],
    taskIds: ['task-1'], body: 'Task: task-1', version: 'note-v1' });
  const draft = GmailDraftSchema.parse({ draftId: 'draft-1', messageId: 'message-1', to: ['customer@example.test'],
    cc: [], bcc: [], subject: 'Incident update effect-draft', body: 'Approved update', isDraft: true,
    rawMimeRef: { artifactId: 'mime-readback', sha256: digest, byteLength: 1, mediaType: 'message/rfc822' }, version: 'draft-v1' });
  const comment = GitHubCommentSchema.parse({ id: 'comment-1', repositoryId: 'repository-1', issueId: 'issue-1',
    authorId: 'bot-1', body: 'Task task-1; draft draft-1', updatedAt: at, version: 'comment-v1' });
  const state = { tasks: [task], notes: [note], drafts: [draft], comments: [comment],
    protectedCommitments: [] as ProtectedCommitmentExpectation[],
    messages: [] as Array<ReturnType<typeof SlackMessageSchema.parse>>, draftIncomplete: false };
  const calls: string[] = [];
  const readers: ReadbackReaders = {
    hubspot: {
      scope: { app: 'hubspot', accountRef: 'account-hubspot' }, mode: 'fake',
      readCommitmentBundle: async (_service, context) => { calls.push(context.operation); return complete(context,
        { commitments: state.protectedCommitments, companies: [], contacts: [], owners: [] }); },
      findTasks: async (_marker, context) => { calls.push(context.operation); return complete(context, state.tasks); },
      getTask: async (id, context) => { calls.push(context.operation); return complete(context, state.tasks.find(row => row.id === id) ?? null); },
      findNotes: async (_marker, context) => { calls.push(context.operation); return complete(context, state.notes); },
      getNote: async (id, context) => { calls.push(context.operation); return complete(context, state.notes.find(row => row.id === id) ?? null); },
    },
    gmail: {
      scope: { app: 'gmail', accountRef: 'account-gmail' }, mode: 'fake',
      listDrafts: async context => complete(context, state.drafts),
      findDrafts: async (_marker, context) => { calls.push(context.operation);
        return state.draftIncomplete ? incomplete(context) : complete(context, state.drafts); },
      getDraft: async (id, context) => { calls.push(context.operation); return complete(context, state.drafts.find(row => row.draftId === id) ?? null); },
    },
    github: {
      scope: { app: 'github', accountRef: 'account-github' }, mode: 'fake',
      resolveIncident: async (_url, context) => complete(context, value.incident),
      readTechnicalEvidence: async (_incident, context) => complete(context, { incident: value.incident,
        title: 'Fixture incident', body: '', comments: state.comments, changes: [] }),
      findComments: async (_incident, _marker, context) => { calls.push(context.operation); return complete(context, state.comments); },
      getComment: async (id, context) => { calls.push(context.operation); return complete(context, state.comments.find(row => row.id === id) ?? null); },
    },
    slack: {
      scope: { app: 'slack', accountRef: 'account-slack' }, mode: 'fake',
      readApprovalThread: async (channelId, threadTs, context) => { calls.push(context.operation); return complete(context,
        state.messages.filter(message => message.channelId === channelId && message.threadTs === threadTs)); },
      getMessage: async (channelId, messageTs, context) => complete(context,
        state.messages.find(message => message.channelId === channelId && message.messageTs === messageTs) ?? null),
      findReview: async (marker, context) => { calls.push(context.operation); return complete(context,
        state.messages.filter(message => message.body.includes(marker))); },
      readSummary: async (channelId, messageTs, context) => { calls.push(context.operation); return complete(context,
        state.messages.find(message => message.channelId === channelId && message.messageTs === messageTs) ?? null); },
    },
  };
  let attempt = 0;
  const createContext = <Operation extends ReadCallContext['operation']>(request: {
    operation: Operation;
    effectKey: string | null;
    purpose: 'binding' | 'artifact' | 'scope';
  }) =>
    ReadCallContextSchema.parse({ schemaVersion: 2, runId: value.runId, evaluationAttemptId: 'evaluation-1',
      runtimeAttemptId: 'runtime-1', spanId: `read-span-${++attempt}`, app: request.operation.split('.')[0],
      accountRef: `account-${request.operation.split('.')[0]}`, mode: 'fake', logicalCallId: `read-call-${attempt}`,
      providerAttemptId: `read-attempt-${attempt}`, deadlineAt: '2026-09-14T10:10:00Z',
      budgets: { timeoutMs: 1000, totalMs: 1000, maxAttempts: 1, maxPages: 20, maxRecords: 100, maxResponseBytes: 10000 },
      operation: request.operation }) as ContextFor<Operation>;
  const recorded: ReadbackRecordInput[] = [];
  const recordedScopes: ScopeReadbackRecordInput[] = [];
  const recorder: ReadbackRecorder = { recordArtifact(input) {
    recorded.push(input);
    const direct = input.reads.at(-1)?.purpose === 'artifact' && input.status !== 'unverified';
    return { observationIds: input.reads.map((_read, index) => `observation-${recorded.length}-${index}`),
      verificationId: direct ? `verification-${input.effect.effectKey}` : null,
      observedAt: input.reads.at(-1)!.result.receipt.finishedAt, receipt: ref(`verification-receipt-${recorded.length}`) };
  }, recordScope(input) {
    recordedScopes.push(input);
    return { observationIds: [`scope-observation-${recordedScopes.length}`], verificationId: null,
      observedAt: input.read.result.receipt.finishedAt, receipt: ref(`scope-receipt-${recordedScopes.length}`) };
  } };
  const records = value.effects.filter(effect => effect.kind !== 'thread').map(effect => EffectRecordSchema.parse({
    schemaVersion: 2, runId: value.runId, effectKey: effect.effectKey, state: 'applied', requestDigest: effect.requestDigest,
    providerId: effectIds[effect.effectKey as keyof typeof effectIds], claimId: `claim-${effect.effectKey}`,
    outcome: { status: 'applied', providerId: effectIds[effect.effectKey as keyof typeof effectIds], receipt: ref(`write-${effect.effectKey}`) },
    verificationRef: null,
  }));
  return { state, calls, readers, createContext, recorder, recorded, recordedScopes, records,
    effects: { taskEffect, noteEffect, draftEffect, commentEffect } };
}

type ContextFor<Operation extends ReadCallContext['operation']> = ReadCallContext & { operation: Operation };

test('matches exact approved fields, resolved IDs, associations, and final Slack scope', () => {
  const [taskEffect, noteEffect, draftEffect, commentEffect, threadEffect] = plan.effects;
  const task = HubSpotTaskSchema.parse({ id: 'task-1', companyIds: ['company-1'], commitmentIds: ['commitment-1'],
    ownerId: 'owner-1', dueAt: '2026-09-16T10:00:00Z', status: 'NOT_STARTED',
    subject: 'Follow up effect-task', body: 'Approved update', version: 'task-v1' });
  const note = HubSpotNoteSchema.parse({ id: 'note-1', companyIds: ['company-1'], commitmentIds: ['commitment-1'],
    taskIds: ['task-1'], body: 'Task: task-1', version: 'note-v1' });
  const draft = GmailDraftSchema.parse({ draftId: 'draft-1', messageId: 'message-1', to: ['customer@example.test'],
    cc: [], bcc: [], subject: 'Incident update effect-draft', body: 'Approved update', isDraft: true,
    rawMimeRef: { artifactId: 'mime-1', sha256: digest, byteLength: 1, mediaType: 'message/rfc822' }, version: 'draft-v1' });
  const comment = GitHubCommentSchema.parse({ id: 'comment-1', repositoryId: 'repository-1', issueId: 'issue-1',
    authorId: 'bot-1', body: 'Task task-1; draft draft-1', updatedAt: at, version: 'comment-v1' });
  const summary = SlackMessageSchema.parse({ workspaceId: 'workspace-1', channelId: 'channel-1', threadTs: '100.1',
    messageTs: 'summary-1', actorId: 'bot-1', isBot: true, subtype: null, editedAt: null, deleted: false,
    body: 'Verified task task-1, note note-1, draft draft-1, comment comment-1. Coordination finalization: pending. effect-thread', observedAt: at });

  assert.equal(assertTaskReadback(plan, taskEffect as Extract<typeof taskEffect, { kind: 'task' }>, 'task-1', task, effectIds).status, 'matched');
  assert.equal(assertNoteReadback(plan, noteEffect as Extract<typeof noteEffect, { kind: 'note' }>, 'note-1', note, effectIds).status, 'matched');
  assert.equal(assertDraftReadback(plan, draftEffect as Extract<typeof draftEffect, { kind: 'draft' }>, 'draft-1', draft, effectIds).status, 'matched');
  assert.equal(assertCommentReadback(plan, commentEffect as Extract<typeof commentEffect, { kind: 'comment' }>, 'comment-1', comment, effectIds).status, 'matched');
  assert.equal(assertSlackSummaryReadback(plan, threadEffect as Extract<typeof threadEffect, { kind: 'thread' }>,
    'summary-1', 'workspace-1', summary, effectIds).status, 'matched');
});

test('rejects duplicate markers and independently tampered provider fields', () => {
  const [taskEffect, noteEffect, draftEffect, commentEffect, threadEffect] = plan.effects;
  assert.deepEqual(assertUniqueProviderBinding('task-1', ['task-1', 'task-2']).mismatches, ['duplicate_marker']);

  const task = HubSpotTaskSchema.parse({ id: 'task-1', companyIds: ['company-2'], commitmentIds: ['commitment-1'],
    ownerId: 'owner-2', dueAt: '2026-09-17T10:00:00Z', status: 'COMPLETED',
    subject: 'Changed', body: 'Changed', version: 'task-v2' });
  assert.deepEqual(assertTaskReadback(plan, taskEffect as Extract<typeof taskEffect, { kind: 'task' }>,
    'task-1', task, effectIds).mismatches, [
    'company_association_mismatch', 'owner_mismatch', 'due_at_mismatch', 'status_mismatch', 'subject_mismatch', 'body_mismatch',
  ]);

  const note = HubSpotNoteSchema.parse({ id: 'note-1', companyIds: ['company-1'], commitmentIds: ['commitment-2'],
    taskIds: ['task-2'], body: 'Changed', version: 'note-v2' });
  assert.deepEqual(assertNoteReadback(plan, noteEffect as Extract<typeof noteEffect, { kind: 'note' }>,
    'note-1', note, effectIds).mismatches, ['commitment_association_mismatch', 'task_association_mismatch', 'body_mismatch']);

  const draft = GmailDraftSchema.parse({ draftId: 'draft-1', messageId: 'message-1',
    to: ['attacker@example.test'], cc: ['copy@example.test'], bcc: ['hidden@example.test'],
    subject: 'Changed', body: 'Changed', isDraft: false,
    rawMimeRef: { artifactId: 'mime-2', sha256: digest, byteLength: 1, mediaType: 'message/rfc822' }, version: 'draft-v2' });
  assert.deepEqual(assertDraftReadback(plan, draftEffect as Extract<typeof draftEffect, { kind: 'draft' }>,
    'draft-1', draft, effectIds).mismatches,
  ['recipient_mismatch', 'cc_mismatch', 'bcc_mismatch', 'subject_mismatch', 'body_mismatch', 'draft_state_mismatch']);

  const comment = GitHubCommentSchema.parse({ id: 'comment-1', repositoryId: 'repository-2', issueId: 'issue-2',
    authorId: 'bot-1', body: 'Changed', updatedAt: at, version: 'comment-v2' });
  assert.deepEqual(assertCommentReadback(plan, commentEffect as Extract<typeof commentEffect, { kind: 'comment' }>,
    'comment-1', comment, effectIds).mismatches, ['repository_mismatch', 'issue_mismatch', 'body_mismatch']);

  const summary = SlackMessageSchema.parse({ workspaceId: 'workspace-2', channelId: 'channel-2', threadTs: '200.1',
    messageTs: 'summary-1', actorId: 'human-1', isBot: false, subtype: null, editedAt: null, deleted: true,
    body: 'Changed', observedAt: at });
  assert.deepEqual(assertSlackSummaryReadback(plan, threadEffect as Extract<typeof threadEffect, { kind: 'thread' }>,
    'summary-1', 'workspace-1', summary, effectIds).mismatches,
  ['workspace_mismatch', 'channel_mismatch', 'thread_mismatch', 'body_mismatch', 'summary_actor_mismatch', 'summary_deleted']);
});

test('reads every business artifact through a unique marker and a fresh provider get', async () => {
  const currentPlan = await validPlan();
  const fixture = readbackFixture(currentPlan);
  const report = await verifyBusinessArtifacts(currentPlan, fixture.records, {
    readers: fixture.readers,
    createContext: fixture.createContext,
    recorder: fixture.recorder,
  });

  assert.equal(report.status, 'matched');
  assert.deepEqual(report.artifacts.map(result => result.kind), ['task', 'note', 'draft', 'comment']);
  assert.deepEqual(report.effectIds, {
    'effect-task': 'task-1',
    'effect-note': 'note-1',
    'effect-draft': 'draft-1',
    'effect-comment': 'comment-1',
  });
  assert.deepEqual(fixture.calls, [
    'hubspot.findTasks', 'hubspot.getTask',
    'hubspot.findNotes', 'hubspot.getNote',
    'gmail.findDrafts', 'gmail.getDraft',
    'github.findComments', 'github.getComment',
  ]);
  assert.equal(fixture.recorded.length, 4);
  assert.ok(fixture.recorded.every(record => record.status === 'matched' && record.reads.length === 2));
});

test('blocks at an ambiguous marker without trusting the stored provider ID', async () => {
  const currentPlan = await validPlan();
  const fixture = readbackFixture(currentPlan);
  fixture.state.tasks.push(HubSpotTaskSchema.parse({ ...fixture.state.tasks[0], id: 'task-2' }));

  const report = await verifyBusinessArtifacts(currentPlan, fixture.records, {
    readers: fixture.readers,
    createContext: fixture.createContext,
    recorder: fixture.recorder,
  });

  assert.equal(report.status, 'mismatched');
  assert.deepEqual(report.artifacts[0]?.mismatches, ['duplicate_marker']);
  assert.deepEqual(fixture.calls, ['hubspot.findTasks']);
  assert.equal(fixture.recorded[0]?.reads.length, 1);
  assert.equal(fixture.recorded[0]?.status, 'mismatched');
});

test('keeps an incomplete fresh read unverified and does not inspect later artifacts', async () => {
  const currentPlan = await validPlan();
  const fixture = readbackFixture(currentPlan);
  fixture.state.draftIncomplete = true;

  const report = await verifyBusinessArtifacts(currentPlan, fixture.records, {
    readers: fixture.readers,
    createContext: fixture.createContext,
    recorder: fixture.recorder,
  });

  assert.equal(report.status, 'unverified');
  assert.deepEqual(report.artifacts.map(result => result.status), ['matched', 'matched', 'unverified']);
  assert.deepEqual(fixture.calls, [
    'hubspot.findTasks', 'hubspot.getTask',
    'hubspot.findNotes', 'hubspot.getNote',
    'gmail.findDrafts',
  ]);
  assert.equal(fixture.recorded.at(-1)?.status, 'unverified');
  assert.equal(fixture.recorded.at(-1)?.reads.length, 1);
});

async function finalizationFixture(phantomSummary = false) {
  const currentPlan = await validPlan();
  const fixture = readbackFixture(currentPlan);
  const business = await verifyBusinessArtifacts(currentPlan, fixture.records, {
    readers: fixture.readers,
    createContext: fixture.createContext,
    recorder: fixture.recorder,
  });
  const effect = currentPlan.effects.find(candidate => candidate.kind === 'thread')!;
  let stored = EffectRecordSchema.parse({ schemaVersion: 2, runId: currentPlan.runId,
    effectKey: effect.effectKey, state: 'planned', requestDigest: effect.requestDigest,
    providerId: null, claimId: null, outcome: null, verificationRef: null });
  const order: string[] = [];
  const persistence: SummaryEffectPersistence = {
    claim: async input => {
      order.push('claim');
      assert.equal(input.record.state, 'planned');
      return true;
    },
    recordOutcome: async input => {
      order.push('outcome');
      stored = EffectRecordSchema.parse(input.outcome.status === 'applied'
        ? { ...stored, state: 'applied', providerId: input.outcome.providerId,
            claimId: 'claim-effect-thread', outcome: input.outcome }
        : { ...stored, state: 'inflight', providerId: null,
            claimId: 'claim-effect-thread', outcome: input.outcome });
      return stored;
    },
  };
  const unavailable = async (): Promise<never> => { throw new Error('unexpected_slack_operation'); };
  const coordinator: SlackCoordinator = {
    ...fixture.readers.slack,
    postReview: unavailable,
    updateReview: unavailable,
    updateSummary: unavailable,
    postSummary: async (input, context) => {
      order.push('post');
      assert.equal(context.marker, effect.effectKey);
      if (!phantomSummary) fixture.state.messages.push(SlackMessageSchema.parse({
        workspaceId: 'workspace-1', channelId: input.channelId, threadTs: input.threadTs,
        messageTs: 'summary-1', actorId: 'bot-1', isBot: true, subtype: null,
        editedAt: null, deleted: false, body: input.body, observedAt: at,
      }));
      return { status: 'applied', providerId: 'summary-1', receipt: ref('summary-write') };
    },
  };
  const createContext = (): CoordinationCallContext & { operation: 'slack.postSummary' } => {
    const context = CoordinationCallContextSchema.parse({ schemaVersion: 2,
      runId: currentPlan.runId, evaluationAttemptId: 'evaluation-1', runtimeAttemptId: 'runtime-1',
      spanId: 'summary-write-span', app: 'slack', accountRef: 'account-slack', mode: 'fake',
      logicalCallId: 'summary-write-call', providerAttemptId: 'summary-write-attempt',
      deadlineAt: '2026-09-14T10:10:00Z', budgets: { timeoutMs: 1000, totalMs: 1000,
        maxAttempts: 1, maxPages: 1, maxRecords: 1, maxResponseBytes: 10000 },
      operation: 'slack.postSummary', marker: effect.effectKey, requestDigest: effect.requestDigest });
    return { ...context, operation: 'slack.postSummary' };
  };
  const artifactClaims = { publish: async (proof: { scope: string }) => {
    order.push('artifact-claim');
    assert.equal(proof.scope, 'artifacts');
    return 'artifact-claim-1';
  } };
  return { currentPlan, fixture, business, get stored() { return stored; }, order,
    coordinator, createContext, persistence, artifactClaims };
}

test('publishes and freshly reads Slack before returning a whole-run completion proof', async () => {
  const fixture = await finalizationFixture();
  const result = await finalizeVerifiedRun(fixture.currentPlan, ref('frozen-plan'), fixture.business,
    fixture.stored, { coordinator: fixture.coordinator, createContext: fixture.createContext,
      persistence: fixture.persistence, artifactClaims: fixture.artifactClaims,
      readback: { readers: fixture.fixture.readers, createContext: fixture.fixture.createContext,
        recorder: fixture.fixture.recorder, expectedSlackWorkspaceId: 'workspace-1' } });

  assert.equal(result.status, 'completed');
  if (result.status !== 'completed') return;
  assert.deepEqual(fixture.order, ['artifact-claim', 'claim', 'post', 'outcome']);
  assert.deepEqual(fixture.fixture.calls.slice(-2), ['slack.readApprovalThread', 'slack.readSummary']);
  assert.equal(result.proof.verifications.length, 5);
  assert.equal(result.proof.finalSlackVerificationId, 'verification-effect-thread');
  assert.match(fixture.fixture.state.messages[0]!.body, /Coordination finalization: pending/);
});

test('rejects a phantom Slack acknowledgement after fresh summary lookup', async () => {
  const fixture = await finalizationFixture(true);
  const result = await finalizeVerifiedRun(fixture.currentPlan, ref('frozen-plan'), fixture.business,
    fixture.stored, { coordinator: fixture.coordinator, createContext: fixture.createContext,
      persistence: fixture.persistence, artifactClaims: fixture.artifactClaims,
      readback: { readers: fixture.fixture.readers, createContext: fixture.fixture.createContext,
        recorder: fixture.fixture.recorder, expectedSlackWorkspaceId: 'workspace-1' } });

  assert.equal(result.status, 'mismatched');
  assert.equal('reason' in result ? result.reason : null, 'summary_readback_failed');
  assert.equal(fixture.fixture.state.messages.length, 0);
  assert.deepEqual(fixture.fixture.calls.slice(-1), ['slack.readApprovalThread']);
});

test('does not publish a success claim or Slack summary when business evidence is incomplete', async () => {
  const fixture = await finalizationFixture();
  const incompleteBusiness = { ...fixture.business, status: 'unverified' as const };
  const result = await finalizeVerifiedRun(fixture.currentPlan, ref('frozen-plan'), incompleteBusiness,
    fixture.stored, { coordinator: fixture.coordinator, createContext: fixture.createContext,
      persistence: fixture.persistence, artifactClaims: fixture.artifactClaims,
      readback: { readers: fixture.fixture.readers, createContext: fixture.fixture.createContext,
        recorder: fixture.fixture.recorder, expectedSlackWorkspaceId: 'workspace-1' } });

  assert.equal(result.status, 'unverified');
  assert.deepEqual(fixture.order, []);
  assert.equal(fixture.fixture.state.messages.length, 0);
});

test('freshly verifies excluded HubSpot commitments and rejects protected-record drift', async () => {
  const protectedCommitment = { id: 'commitment-beta', companyIds: ['company-beta'], contactIds: ['contact-beta'],
    ownerId: 'owner-beta', service: 'analytics-api', status: 'active', dueAt: '2026-09-16T10:00:00Z',
    promise: 'Analytics migration', version: 'protected-v1' };
  const planned = structuredClone(plan);
  planned.selection.excluded = [{ commitmentId: protectedCommitment.id, reason: 'service_mismatch' }];
  const currentPlan = await rehashPlan(ImmutablePlanSchema.parse(planned));
  const matching = readbackFixture(currentPlan);
  matching.state.protectedCommitments.push(protectedCommitment);
  const passed = await verifyBusinessArtifacts(currentPlan, matching.records, {
    readers: matching.readers, createContext: matching.createContext, recorder: matching.recorder,
    protectedCommitments: [protectedCommitment],
  });
  assert.equal(passed.status, 'matched');
  assert.equal(passed.protectedRecords?.status, 'matched');
  assert.equal(matching.calls.at(-1), 'hubspot.readCommitmentBundle');

  const drifted = readbackFixture(currentPlan);
  drifted.state.protectedCommitments.push({ ...protectedCommitment, ownerId: 'owner-changed' });
  const failed = await verifyBusinessArtifacts(currentPlan, drifted.records, {
    readers: drifted.readers, createContext: drifted.createContext, recorder: drifted.recorder,
    protectedCommitments: [protectedCommitment],
  });
  assert.equal(failed.status, 'mismatched');
  assert.deepEqual(failed.protectedRecords?.mismatches, ['protected_record_mismatch']);
});

test('no-affected proof requires complete source and absence reads and never uses Slack', async () => {
  const currentPlan = await validPlan();
  const fixture = readbackFixture(currentPlan);
  const selection = SelectionSchema.parse({ ...currentPlan.selection, selected: [], excluded: [
    { commitmentId: 'commitment-1', reason: 'outside_horizon' },
  ] });
  const context = fixture.createContext({ operation: 'hubspot.findTasks', effectKey: null, purpose: 'scope' });
  const passed = await verifyNoAffected({ runId: currentPlan.runId, selection,
    selectionRef: ref('empty-selection'), sourceReceipts: currentPlan.sources.map(source => source.receipt),
    absencePredicates: [{ predicateId: 'no-protected-tasks', read: () => ({ context, result: complete(context, []) }),
      isAbsent: observed => Array.isArray(observed) && observed.length === 0 }], recorder: fixture.recorder });
  assert.equal(passed.status, 'matched');
  assert.equal(passed.status === 'matched' ? passed.proof.scope : null, 'no_affected');
  assert.equal(fixture.calls.some(call => call.startsWith('slack.')), false);

  const incompleteContext = fixture.createContext({ operation: 'hubspot.findTasks', effectKey: null, purpose: 'scope' });
  const blocked = await verifyNoAffected({ runId: currentPlan.runId, selection,
    selectionRef: ref('empty-selection'), sourceReceipts: currentPlan.sources.map(source => source.receipt),
    absencePredicates: [{ predicateId: 'no-protected-tasks',
      read: () => ({ context: incompleteContext, result: incomplete<unknown[]>(incompleteContext) }),
      isAbsent: () => true }], recorder: fixture.recorder });
  assert.equal(blocked.status, 'unverified');
  assert.equal(blocked.proof, null);
});
