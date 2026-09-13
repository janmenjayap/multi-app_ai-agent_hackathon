import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import { ApplicationDatabase } from '../../src/server/storage/database.js';
import { ApplicationRepository } from '../../src/server/storage/repositories.js';
import { createGuardedExecutor } from '../../src/server/execution/executor.js';
import { resolveApprovedRequest } from '../../src/server/execution/ordering.js';
import { deriveEffectKey } from '../../src/server/policy/effect-keys.js';
import { bindIncidentIdentity } from '../../src/server/policy/identity.js';
import { createApplicationReadbackRecorder, verifyArtifactReadback,
  type ReadbackContextFactory } from '../../src/server/verification/readback.js';
import type { ApprovalResult, ApprovalService } from '../../src/server/policy/approval.js';
import type { WorkflowNodeContext } from '../../src/server/workflow/driver.js';
import { WorkflowStateSchema } from '../../src/server/workflow/state.js';
import { EvaluationAttemptRegistrationSchema } from '../../src/shared/evaluation.js';
import { CollectionReceiptSchema, ExecutionModeSchema, IncidentIdentitySchema, ImmutablePlanSchema,
  RunIdSchema, EvaluationAttemptIdSchema, RuntimeAttemptIdSchema, SnapshotRefSchema, SlackDecisionSchema,
  PIPELINE_STAGE_IDS, planHashMaterial, requestHashMaterial, type RestrictedArtifactRef,
  type MutationOutcome, type ReadResult, type EffectKey } from '../../src/shared/domain.js';
import { HubSpotTaskSchema, HubSpotNoteSchema, GmailDraftSchema, GitHubCommentSchema,
  ReadCallContextSchema, ProviderAttemptReceiptSchema, type ReadCallContext, type ProtectedCallContext,
  type HubSpotAdapter, type GmailAdapter, type GitHubAdapter, type SlackReader } from '../../src/shared/adapters.js';
import { digest } from '../../src/shared/reliability.js';

const at = '2026-09-14T10:00:00.000Z';
const deadlineAt = '2026-09-14T10:10:00.000Z';
const budgets = { timeoutMs: 1000, totalMs: 1000, maxAttempts: 1, maxPages: 5, maxRecords: 100, maxResponseBytes: 10000 };
const configuration = ExecutionModeSchema.parse({ schemaVersion: 2, modelMode: 'mock', providerMode: 'fake',
  evidenceMode: 'synthetic_fixture', fixtureId: 'b06-execution-boundaries' });
const incident = IncidentIdentitySchema.parse({ schemaVersion: 2, repositoryId: 'repository-1', issueId: 'issue-1',
  issueNumber: 1, canonicalUrl: 'https://github.com/fixture/project/issues/1', service: 'billing-api', environment: 'test' });
const identity = { producerVersion: 'execution-test-v2', producerId: 'fixture-reader', runId: RunIdSchema.parse('run-1'),
  evaluationAttemptId: EvaluationAttemptIdSchema.parse('evaluation-1'), runtimeAttemptId: RuntimeAttemptIdSchema.parse('runtime-1'),
  stage: 'execute' as const, spanId: 'execute-stage', parentSpanId: null, causedBy: [] };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

/** Named barriers model interleaving without timing-dependent sleeps. */
function barrier() {
  let open!: () => void;
  const reached = new Promise<void>(resolve => { open = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, async wait() { open(); await released; } };
}

async function fixture() {
  let now = Date.parse(at), sequence = 0;
  const directory = mkdtempSync(join(tmpdir(), 'promiseguard-b06-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const database = new ApplicationDatabase(join(directory, 'application.sqlite'));
  cleanup.push(() => database.close());
  const repository = new ApplicationRepository(database);
  const id = (prefix = 'execution') => `${prefix}-${++sequence}`;
  const clock = () => now;
  const iso = () => new Date(now).toISOString();
  const stamp = () => ({ eventId: id('event'), at: iso(), processId: 'fixture-process', bootId: 'fixture-boot', monotonicMs: sequence });
  const artifact = (content: unknown): RestrictedArtifactRef => repository.transaction(identity, tx => {
    const ref = tx.putArtifact({ artifactId: id('artifact'), mediaType: 'application/json', content });
    tx.appendEvent({ kind: 'fault.recorded', faultId: id('fixture-evidence'), evidenceRef: ref }, stamp());
    return ref;
  });
  const source = repository.transaction(identity, tx => {
    tx.createRun({ runId: identity.runId, incident, configuration, createdAt: at });
    const ref = tx.putArtifact({ artifactId: 'fixture-source', mediaType: 'application/json', content: { fixture: 'b06' } });
    tx.registerEvaluation(EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2, runId: identity.runId,
      evaluationAttemptId: identity.evaluationAttemptId, suiteEntryId: 'b06-suite', manifestHash: digest({ fixture: 'b06' }),
      registeredAt: at, dispatchAt: at, preflightRef: ref, s0Ref: ref, configuration, leg: 'baseline' }));
    tx.startRuntime({ runtimeAttemptId: identity.runtimeAttemptId, runId: identity.runId,
      evaluationAttemptId: identity.evaluationAttemptId, startedAt: at });
    tx.appendEvent({ kind: 'stage.started' }, stamp());
    return ref;
  });
  repository.transaction({ ...identity, stage: 'verify', spanId: 'verify-stage' }, tx => tx.appendEvent({ kind: 'stage.started' }, stamp()));
  const sources = (['github', 'hubspot'] as const).map(app => SnapshotRefSchema.parse({ snapshotId: `snapshot-${app}`, app,
    accountRef: `account-${app}`, sourceIds: [`source-${app}`], capturedAt: at, relevantVersion: 'source-v1', artifact: source,
    receipt: { schemaVersion: 2, collectionId: `collection-${app}`, app, accountRef: `account-${app}`, producerId: 'fixture-reader',
      startedAt: at, finishedAt: at, status: 'complete', reason: null, requiredQueryIds: ['source'],
      pages: [{ queryId: 'source', cursor: null, nextCursor: null, recordCount: 1, response: source, providerAttemptId: `source-${app}` }] } }));
  const bodyText = 'Exact approved customer update.';
  const body = [{ type: 'approved_content', planRevision: 1, contentKey: 'approved-body' }];
  const selected = { commitmentId: 'commitment-1', companyId: 'company-1', ownerId: 'owner-1', contactId: 'contact-1',
    mailbox: 'customer@example.test', dueAt: deadlineAt, service: incident.service, reason: 'service_match' };
  const common = { commitmentId: selected.commitmentId, requestDigest: digest({ fixture: 'b06' }) };
  const fingerprint = bindIncidentIdentity(incident, incident).incidentFingerprint;
  const keys = Object.fromEntries(await Promise.all((['task', 'note', 'draft', 'comment', 'thread'] as const).map(async kind => [kind,
    await deriveEffectKey({ incidentFingerprint: fingerprint, app: kind === 'task' || kind === 'note' ? 'hubspot' : kind === 'draft' ? 'gmail' : kind === 'comment' ? 'github' : 'slack',
      stableBusinessTargetId: kind === 'comment' ? incident.issueId : kind === 'thread' ? fingerprint : selected.commitmentId, actionType: kind })]))) as Record<'task' | 'note' | 'draft' | 'comment' | 'thread', EffectKey>;
  let plan = ImmutablePlanSchema.parse(JSON.parse(JSON.stringify({ schemaVersion: 2, runId: identity.runId, revision: 1, planHash: common.requestDigest,
    createdAt: at, incident, sources, selection: { schemaVersion: 2, policyVersion: 'selection-v1', evaluatedAt: at,
      sourceBundleRef: source, sourceComplete: true, selected: [selected], excluded: [] },
    contents: [{ contentKey: 'approved-body', text: bodyText, sha256: createHash('sha256').update(bodyText).digest('hex') }], effects: [
      { ...common, kind: 'task', app: 'hubspot', effectKey: 'effect-task', payload: { companyId: selected.companyId,
        commitmentId: selected.commitmentId, ownerId: selected.ownerId, dueAt: selected.dueAt, status: 'NOT_STARTED',
        subject: 'Follow up effect-task', body } },
      { ...common, kind: 'note', app: 'hubspot', effectKey: 'effect-note', payload: { companyId: selected.companyId,
        commitmentId: selected.commitmentId, taskId: { type: 'effect_id', effectKey: 'effect-task' },
        body: [{ type: 'text', text: '[PromiseGuard:effect-note] Task: ' }, { type: 'effect_id', effectKey: 'effect-task' }] } },
      { ...common, kind: 'draft', app: 'gmail', effectKey: 'effect-draft', payload: { to: selected.mailbox,
        cc: [], bcc: [], subject: 'Incident update effect-draft', body, isDraft: true } },
      { ...common, commitmentId: null, kind: 'comment', app: 'github', effectKey: 'effect-comment', payload: {
        repositoryId: incident.repositoryId, issueId: incident.issueId,
        taskIds: [{ type: 'effect_id', effectKey: 'effect-task' }], draftIds: [{ type: 'effect_id', effectKey: 'effect-draft' }],
        body: [{ type: 'text', text: '<!-- promiseguard:effect-comment --> Task ' }, { type: 'effect_id', effectKey: 'effect-task' },
          { type: 'text', text: '; draft ' }, { type: 'effect_id', effectKey: 'effect-draft' }] } },
      { ...common, commitmentId: null, kind: 'thread', app: 'slack', effectKey: 'effect-thread', payload: {
        channelId: 'channel-1', threadTs: '100.1', body: [{ type: 'text', text: 'Summary effect-thread' }] } },
    ] }).replace(/effect-(task|note|draft|comment|thread)/g, (_match, kind: keyof typeof keys) => keys[kind])));
  plan = { ...plan, effects: plan.effects.map(effect => ({ ...effect, requestDigest: digest(requestHashMaterial(effect, plan.contents)) })) };
  plan = { ...plan, planHash: digest(planHashMaterial(plan)) };
  const planRef = repository.transaction(identity, tx => {
    sources.forEach(snapshot => tx.saveSnapshot(snapshot));
    tx.freezePlan(plan);
    const ref = tx.putArtifact({ artifactId: 'frozen-plan', mediaType: 'application/json', content: plan });
    tx.appendEvent({ kind: 'plan.frozen', planRevision: 1, planHash: plan.planHash, planRef: ref }, stamp());
    tx.recordApproval(SlackDecisionSchema.parse({ schemaVersion: 2, approvalId: 'approval-1', runId: identity.runId,
      planRevision: 1, planHash: plan.planHash, transport: 'slack_human_reply', workspaceId: 'workspace-1', channelId: 'channel-1',
      threadTs: '100.1', reviewMessageTs: '100.1', decisionMessageTs: '100.2', actorId: 'approver-1', authorizedActorId: 'approver-1',
      isBot: false, editedAt: null, deleted: false, decision: 'approved', decidedAt: at, observedAt: at,
      expiresAt: deadlineAt, reviewRef: source, decisionRef: source }));
    tx.appendEvent({ kind: 'approval.checked', approvalId: 'approval-1', planRevision: 1, planHash: plan.planHash,
      decision: 'approved', evidenceRef: source }, stamp());
    return ref;
  });
  const state = WorkflowStateSchema.parse({ schemaVersion: 2, runId: identity.runId, ownerId: 'operator-1',
    evaluationAttemptId: identity.evaluationAttemptId, runtimeAttemptId: identity.runtimeAttemptId,
    runtimeAttemptIds: [identity.runtimeAttemptId], commandId: 'command-1', incidentTitle: 'Fixture incident',
    stage: 'execute', spanId: identity.spanId, lastEventId: 'last-event', bootId: null, spanOpen: true, waitId: null,
    deadlineAt, stageDeadlineAt: null, stageTimeoutMs: 30000, wakeAt: null, scheduleStatus: 'running', statusReason: null,
    stages: PIPELINE_STAGE_IDS.map(stageId => ({ stageId, role: ['analyst', 'drafter', 'auditor'].includes(stageId) ? stageId : null,
      status: stageId === 'execute' ? 'running' : 'not_started', startedAt: null, updatedAt: null, attemptCount: 0,
      latestAttemptRef: null, reason: null })), commitments: { status: 'selected', policyVersion: 'selection-v1',
      selected: [{ commitmentId: 'commitment-1', company: 'Fixture customer', reason: 'eligible' }], excluded: [], evidenceRefs: [] },
    plan: null, approval: null, effects: [], verifiedAt: null, references: { plan: planRef } });
  const node: WorkflowNodeContext = { state, eventContext: identity, signal: new AbortController().signal,
    transaction: action => repository.transaction(identity, action) };
  const faults = { rejectApprovalAt: 0, expireAfterFirst: false, timeout: false, hideAccepted: false, duplicate: false,
    editAccepted: false, forgedSuccess: false, providerReject: false, loseReceipt: false, bypassDispatch: false,
    invalidateBeforeDispatch: false, gate: null as ReturnType<typeof barrier> | null };
  let approvals = 0;
  const approval: Pick<ApprovalService, 'withDispatchApproval'> = { async withDispatchApproval(_node, _input, dispatch) {
    approvals++;
    if (approvals === faults.rejectApprovalAt || clock() >= Date.parse(deadlineAt)) return { status: 'blocked', reason: 'approval_invalidated' };
    if (faults.gate && approvals <= 2) await faults.gate.wait();
    const reference = repository.transaction(identity, tx => {
      const reference = tx.putArtifact({ artifactId: id('dispatch-approval'), mediaType: 'application/json', content: {
        schemaVersion: 2, kind: 'approval_authority', runId: plan.runId, planRevision: plan.revision, planHash: plan.planHash,
        approvalId: 'approval-1', validUntil: deadlineAt, expiresAt: deadlineAt,
        scope: { effectKey: _input.effectKey, requestDigest: plan.effects.find(effect => effect.effectKey === _input.effectKey)!.requestDigest },
      } });
      tx.appendEvent({ kind: 'guard.checked', allowed: true, reason: 'dispatch_approval_validated',
        planHash: plan.planHash, evidenceRefs: [reference] }, stamp());
      return reference;
    });
    return { status: 'dispatched', value: await dispatch({ status: 'approved', approvalId: 'approval-1', reference,
      expiresAt: deadlineAt, validUntil: deadlineAt, plan, review: {} as Extract<ApprovalResult, { status: 'approved' }>['review'] }) };
  } };
  const order: string[] = [];
  const writes: { context: ProtectedCallContext; input: unknown }[] = [];
  const world = { tasks: [] as ReturnType<typeof HubSpotTaskSchema.parse>[], notes: [] as ReturnType<typeof HubSpotNoteSchema.parse>[],
    drafts: [] as ReturnType<typeof GmailDraftSchema.parse>[], comments: [] as ReturnType<typeof GitHubCommentSchema.parse>[] };
  let executorService: ReturnType<typeof createGuardedExecutor>;
  const createReadContext: ReadbackContextFactory = request => ReadCallContextSchema.parse({ schemaVersion: 2,
    runId: identity.runId, evaluationAttemptId: identity.evaluationAttemptId, runtimeAttemptId: identity.runtimeAttemptId,
    spanId: id('read-span'), logicalCallId: id('read-call'), providerAttemptId: id('read-attempt'), app: request.operation.split('.')[0],
    accountRef: `account-${request.operation.split('.')[0]}`, mode: 'fake', operation: request.operation, deadlineAt, budgets }) as ReturnType<ReadbackContextFactory> & { operation: typeof request.operation };
  function read<T>(context: ReadCallContext, value: T): Promise<ReadResult<T>> {
    order.push(context.operation);
    const eventContext = { ...identity, stage: 'verify' as const, spanId: context.spanId, parentSpanId: 'verify-stage' };
    const response = repository.transaction(eventContext, tx => {
      const requestRef = tx.putArtifact({ artifactId: id('read-request'), mediaType: 'application/json', content: { operation: context.operation } });
      tx.startProviderAttempt({ context, requestRef, startedAt: iso() });
      tx.appendEvent({ kind: 'tool.dispatch', app: context.app, operation: context.operation, logicalCallId: context.logicalCallId,
        providerAttemptId: context.providerAttemptId, actor: 'reader', effectKey: null, requestDigest: null, planHash: null, approvalId: null }, stamp());
      const responseRef = tx.putArtifact({ artifactId: id('read-response'), mediaType: 'application/json', content: value });
      const receipt = ProviderAttemptReceiptSchema.parse({ schemaVersion: 2, context, startedAt: iso(), finishedAt: iso(), transport: 'fake',
        httpStatus: null, transportOutcome: 'response', providerOutcome: 'success', responseRef, errorCode: null });
      tx.recordProviderOutcome({ providerAttemptId: context.providerAttemptId, outcome: null, receipt });
      tx.appendEvent({ kind: 'tool.result', app: context.app, operation: context.operation, logicalCallId: context.logicalCallId,
        providerAttemptId: context.providerAttemptId, transportOutcome: 'response', providerOutcome: 'success', receiptRef: responseRef, latencyMs: 0 }, stamp());
      return responseRef;
    });
    return Promise.resolve({ status: 'complete', data: structuredClone(value), receipt: CollectionReceiptSchema.parse({ schemaVersion: 2,
      collectionId: context.logicalCallId, app: context.app, accountRef: context.accountRef, producerId: 'fixture-reader', startedAt: iso(),
      finishedAt: iso(), status: 'complete', reason: null, requiredQueryIds: [context.operation], pages: [{ queryId: context.operation,
        cursor: null, nextCursor: null, recordCount: Array.isArray(value) ? value.length : 1, response, providerAttemptId: context.providerAttemptId }] }) });
  }
  async function write(context: ProtectedCallContext, input: unknown, apply: () => string): Promise<MutationOutcome> {
    if (faults.bypassDispatch) return { status: 'applied', providerId: 'forged-provider-id', receipt: source };
    if (faults.invalidateBeforeDispatch) repository.transaction(identity, tx => tx.appendEvent({ kind: 'guard.checked', allowed: false,
      reason: 'approval_invalidated', planHash: plan.planHash, evidenceRefs: [source] }, stamp()));
    await executorService.observer.onDispatch({ context, startedAt: iso(), monotonicMs: performance.now() });
    const attempt = repository.getProviderAttempt(context.providerAttemptId);
    assert.ok(attempt, 'every actual provider call must already have a durable intent');
    assert.equal(repository.getEffect(context.effectKey)?.state, 'inflight');
    writes.push({ context, input: structuredClone(input) });
    order.push(context.operation);
    const providerId = faults.providerReject ? null : apply();
    const responseRef = artifact({ providerId });
    if (faults.loseReceipt) throw new Error('after_acceptance_before_receipt');
    const receipt = artifact(ProviderAttemptReceiptSchema.parse({ schemaVersion: 2, context, startedAt: attempt.startedAt,
      finishedAt: iso(), transport: 'fake', httpStatus: faults.timeout ? null : 200,
      transportOutcome: faults.timeout ? 'timeout' : 'response', providerOutcome: faults.timeout ? 'unknown' : faults.providerReject ? 'denied' : 'success',
      responseRef, errorCode: faults.timeout ? 'timeout' : faults.providerReject ? 'denied' : null }));
    if (faults.timeout) return { status: 'unknown', reason: 'timeout', receipt };
    if (faults.providerReject) return { status: 'not_applied', reason: 'denied', receipt };
    return { status: 'applied', providerId: providerId!, receipt };
  }
  const unexpected = async (): Promise<never> => { throw new Error('unexpected_provider_operation'); };
  const hubspot: HubSpotAdapter = { scope: { app: 'hubspot', accountRef: 'account-hubspot' }, mode: 'fake', readCommitmentBundle: unexpected,
    findTasks: (marker, context) => read(context, faults.hideAccepted ? [] : world.tasks.filter(task => task.subject.includes(marker) || task.body.includes(marker))),
    getTask: (providerId, context) => read(context, world.tasks.find(task => task.id === providerId) ?? null),
    findNotes: (marker, context) => read(context, world.notes.filter(note => note.body.includes(marker))), getNote: (providerId, context) => read(context, world.notes.find(note => note.id === providerId) ?? null),
    createTask: (input, context) => write(context, input, () => {
      world.tasks.push(HubSpotTaskSchema.parse({ id: 'task-1', companyIds: [input.companyId], commitmentIds: [input.commitmentId],
        ownerId: input.ownerId, dueAt: input.dueAt, status: input.status, subject: input.subject,
        body: faults.editAccepted ? 'Human edited content' : input.body, version: 'v1' }));
      if (faults.duplicate) world.tasks.push({ ...world.tasks[0]!, id: 'task-2' });
      return 'task-1';
    }), createNote: (input, context) => write(context, input, () => {
      world.notes.push(HubSpotNoteSchema.parse({ id: 'note-1', companyIds: [input.companyId], commitmentIds: [input.commitmentId],
        taskIds: [input.taskId], body: input.body, version: 'v1' })); return 'note-1';
    }) };
  const gmail: GmailAdapter = { scope: { app: 'gmail', accountRef: 'account-gmail' }, mode: 'fake',
    listDrafts: context => read(context, world.drafts), findDrafts: (_marker, context) => read(context, world.drafts),
    getDraft: (providerId, context) => read(context, world.drafts.find(draft => draft.draftId === providerId) ?? null),
    createDraft: (input, context) => write(context, input, () => {
      world.drafts.push(GmailDraftSchema.parse({ draftId: 'draft-1', messageId: 'message-1', to: [input.to], cc: input.cc, bcc: input.bcc,
        subject: input.subject, body: input.body, isDraft: true, rawMimeRef: source, version: 'v1' })); return 'draft-1';
    }) };
  const github: GitHubAdapter = { scope: { app: 'github', accountRef: 'account-github' }, mode: 'fake', resolveIncident: unexpected,
    readTechnicalEvidence: unexpected, findComments: (_incident, _marker, context) => read(context, world.comments),
    getComment: (providerId, context) => read(context, world.comments.find(comment => comment.id === providerId) ?? null), updateComment: unexpected,
    createComment: (input, context) => write(context, input, () => {
      world.comments.push(GitHubCommentSchema.parse({ id: 'comment-1', repositoryId: input.repositoryId, issueId: input.issueId,
        authorId: 'bot-1', body: input.body, updatedAt: iso(), version: 'v1' })); return 'comment-1';
    }) };
  const slack: SlackReader = { scope: { app: 'slack', accountRef: 'account-slack' }, mode: 'fake', readApprovalThread: unexpected,
    findReview: unexpected, getMessage: unexpected, readSummary: unexpected };
  const readers = { hubspot, gmail, github, slack };
  const recorder = createApplicationReadbackRecorder({ repository,
    eventContext: context => ({ ...identity, stage: 'verify', spanId: context.spanId, parentSpanId: 'verify-stage' }), stamp, createId: id });
  type VerifyArgs = Parameters<typeof verifyArtifactReadback>;
  const verify = async (currentPlan: VerifyArgs[0], effect: VerifyArgs[1], record: VerifyArgs[2], effectIds: VerifyArgs[3]) => {
    if (faults.forgedSuccess) return { effectKey: effect.effectKey, kind: effect.kind, providerId: record.providerId,
      status: 'matched' as const, mismatches: [], observationIds: [], verificationId: 'forged', observedAt: iso(), receipt: source };
    const result = await verifyArtifactReadback(currentPlan, effect, record, effectIds, { readers, createContext: createReadContext, recorder });
    if (faults.expireAfterFirst) now = Date.parse(deadlineAt);
    return result;
  };
  executorService = createGuardedExecutor({ repository, approval, adapters: { hubspot, gmail, github }, verify,
    readers, createReadContext, readEventContext: context => ({ ...identity, stage: 'verify', spanId: context.spanId, parentSpanId: 'verify-stage' }),
    budgets, settling: { maxReads: 2, delayMs: 1 }, clock, sleep: async () => {} });
  return { database, repository, plan, node, source, bodyText, order, writes, world, faults, keys,
    run: () => executorService.execute(node, { planRevision: plan.revision, approvalRef: source }) };
}

test('dispatches frozen bytes and declared IDs in order, then replays without another create', async () => {
  const f = await fixture();
  const result = await f.run();
  assert.equal(result.status, 'verified', JSON.stringify(result));
  assert.deepEqual(f.writes.map(write => write.context.operation), ['hubspot.createTask', 'hubspot.createNote', 'gmail.createDraft', 'github.createComment']);
  assert.equal(f.world.tasks[0]?.body, f.bodyText);
  assert.equal(f.world.drafts[0]?.body, f.bodyText);
  assert.equal(f.world.notes[0]?.body, `[PromiseGuard:${f.keys.note}] Task: task-1`);
  assert.match(f.world.comments[0]!.body, /Task task-1; draft draft-1/);
  assert.ok(f.order.indexOf('hubspot.getTask') < f.order.indexOf('hubspot.createNote'));
  assert.ok(f.order.indexOf('hubspot.getNote') < f.order.indexOf('gmail.createDraft'));
  assert.ok(f.order.indexOf('gmail.getDraft') < f.order.indexOf('github.createComment'));
  assert.equal((await f.run()).status, 'verified');
  assert.equal(f.writes.length, 4);
  assert.equal(f.repository.getEffect(f.keys.thread)?.state, 'planned');
  assert.ok(f.writes.every(write => write.context.approvalRef === 'approval-1' && write.context.planHash === f.plan.planHash));
  const comment = f.plan.effects.find(effect => effect.kind === 'comment')!;
  await assert.rejects(resolveApprovedRequest(f.repository, f.plan, { ...comment, payload: { ...comment.payload,
    body: [...comment.payload.body, { type: 'effect_id', effectKey: f.keys.thread }] } }), /effect_not_approved/);
  assert.equal(f.writes.length, 4, 'an undeclared link substitution cannot dispatch');
});

test('concurrent-before-claim barrier admits one writer per logical effect', async () => {
  const f = await fixture();
  f.faults.gate = barrier();
  const first = f.run(), second = f.run();
  await f.faults.gate.reached;
  f.faults.gate.release();
  const results = await Promise.all([first, second]);
  assert.ok(results.some(result => result.status === 'verified'));
  assert.deepEqual(f.writes.map(write => write.context.operation), ['hubspot.createTask', 'hubspot.createNote', 'gmail.createDraft', 'github.createComment']);
  assert.equal(f.world.tasks.length, 1);
  assert.equal(f.world.drafts.length, 1);
});

test('accepted timeout adopts a single exact match; empty, duplicate and human-edited matches never recreate', async () => {
  for (const fault of ['exact', 'hideAccepted', 'duplicate', 'editAccepted'] as const) {
    const f = await fixture();
    f.faults.timeout = true;
    if (fault !== 'exact') f.faults[fault] = true;
    const result = await f.run();
    assert.equal(result.status, fault === 'exact' ? 'verified' : 'failed_partial', fault);
    assert.equal(f.writes.filter(write => write.context.operation === 'hubspot.createTask').length, 1, fault);
    if (fault !== 'exact') {
      await f.run();
      assert.equal(f.writes.length, 1, fault);
      assert.equal(f.repository.getEffect(f.keys.task)?.state, 'inflight', fault);
    }
    assert.ok(f.repository.readEvents({ runId: f.plan.runId }).some(event => event.kind === 'tool.result' && event.providerOutcome === 'unknown'));
  }
});

test('approval invalidation and expiry between effects stop dispatch and preserve partial work', async () => {
  for (const midway of [false, true]) {
    const f = await fixture();
    f.faults.rejectApprovalAt = midway ? 2 : 1;
    const result = await f.run();
    assert.equal(result.status, midway ? 'failed_partial' : 'safely_blocked');
    assert.equal(f.writes.length, midway ? 1 : 0);
  }
  const expired = await fixture();
  expired.faults.expireAfterFirst = true;
  assert.equal((await expired.run()).status, 'failed_partial');
  assert.equal(expired.writes.length, 1);
  assert.equal(expired.repository.getEffect(expired.keys.task)?.providerId, 'task-1');
});

test('storage failure prevents dispatch and missing receipts, forged success and HTTP-200 denial cannot advance', async () => {
  const storage = await fixture();
  storage.database.connection.exec(`CREATE TEMP TRIGGER reject_intent BEFORE INSERT ON provider_attempts
    WHEN NEW.effect_key IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'fixture_intent_failure'); END`);
  await storage.run();
  assert.equal(storage.writes.length, 0);
  assert.equal(storage.repository.getEffect(storage.keys.task)?.state, 'planned');
  for (const fault of ['loseReceipt', 'forgedSuccess', 'providerReject'] as const) {
    const f = await fixture();
    f.faults[fault] = true;
    if (fault === 'loseReceipt') f.faults.hideAccepted = true;
    const result = await f.run();
    assert.notEqual(result.status, 'verified', fault);
    assert.equal(f.writes.length, 1, fault);
    await f.run();
    assert.equal(f.writes.length, 1, fault);
    assert.notEqual(f.repository.getEffect(f.keys.task)?.state, 'verified', fault);
  }
  for (const fault of ['bypassDispatch', 'invalidateBeforeDispatch'] as const) {
    const f = await fixture();
    f.faults[fault] = true;
    assert.notEqual((await f.run()).status, 'verified', fault);
    assert.equal(f.writes.length, 0, fault);
  }
});
