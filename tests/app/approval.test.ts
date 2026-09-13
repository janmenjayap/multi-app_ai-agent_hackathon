import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import { ApplicationDatabase } from '../../src/server/storage/database.js';
import { ApplicationRepository } from '../../src/server/storage/repositories.js';
import { selectCommitments, type SelectionInput, type SelectionPolicyContext } from '../../src/server/policy/selection.js';
import { deriveEffectKey } from '../../src/server/policy/effect-keys.js';
import { bindIncidentIdentity } from '../../src/server/policy/identity.js';
import { approvalWait, createApprovalNode } from '../../src/server/workflow/approval-wait.js';
import { createApprovalService, parseApprovalCommand, resolveApprovalHash } from '../../src/server/policy/approval.js';
import { WorkflowStateSchema } from '../../src/server/workflow/state.js';
import type { WorkflowNodeContext } from '../../src/server/workflow/driver.js';
import { EvaluationAttemptRegistrationSchema } from '../../src/shared/evaluation.js';
import { AdapterCallContextSchema, ReadCallContextSchema, ProviderAttemptReceiptSchema, type AdapterCallContext,
  type ReadCallContext, type SlackAdapter, type SlackMessageSchema } from '../../src/shared/adapters.js';
import { ExecutionModeSchema, IncidentIdentitySchema, ImmutablePlanSchema, RunIdSchema, EvaluationAttemptIdSchema,
  RuntimeAttemptIdSchema, CollectionReceiptSchema, PIPELINE_STAGE_IDS, requestHashMaterial, planHashMaterial,
  type ReadResult, type RestrictedArtifactRef, type SnapshotRef, type MutationOutcome } from '../../src/shared/domain.js';
import { digest } from '../../src/shared/reliability.js';
import type { z } from 'zod';

const at = '2026-09-14T10:00:00.000Z';
const deadlineAt = '2026-09-14T11:00:00.000Z';
const dueAt = '2026-09-16T10:00:00.000Z';
const configuration = ExecutionModeSchema.parse({ schemaVersion: 2, modelMode: 'mock', providerMode: 'fake',
  evidenceMode: 'synthetic_fixture', fixtureId: 'approval-v2' });
const incident = IncidentIdentitySchema.parse({ schemaVersion: 2, repositoryId: 'repository-1', issueId: 'issue-1',
  issueNumber: 1, canonicalUrl: 'https://github.com/fixture/project/issues/1', service: 'billing-api', environment: 'production' });
const identity = { producerVersion: 'approval-test-v2', producerId: 'test-reader', runId: RunIdSchema.parse('run-approval-1'),
  evaluationAttemptId: EvaluationAttemptIdSchema.parse('evaluation-approval-1'), runtimeAttemptId: RuntimeAttemptIdSchema.parse('runtime-approval-1'),
  stage: 'approval' as const, spanId: 'approval-stage', parentSpanId: null, causedBy: [] };
const budgets = { timeoutMs: 1000, totalMs: 3000, maxAttempts: 1, maxPages: 5, maxRecords: 100, maxResponseBytes: 100000 };
const policy = { schemaVersion: 2 as const, workspaceId: 'workspace-1', channelId: 'approval-channel',
  reviewActorId: 'review-bot', authorizedActorIds: ['approver-1'], ttlMs: 600000, sourceFreshnessMs: 30000,
  slackFreshnessMs: 30000, pollMs: 1000, budgets };
const sourcePolicy: SelectionPolicyContext = { schemaVersion: 2, evaluatedAt: at,
  supportedServices: ['billing-api'], allowedRepositories: [{ owner: 'fixture', name: 'project', repositoryId: 'repository-1' }],
  githubScope: { accountRef: 'account-github', requiredQueryIds: ['github.readTechnicalEvidence'] },
  hubspotScope: { accountRef: 'account-hubspot', requiredQueryIds: ['hubspot.readCommitmentBundle'] }, pinnedIncident: incident };
type SlackMessage = z.infer<typeof SlackMessageSchema>;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

async function fixture() {
  let now = Date.parse(at), sequence = 0, posts = 0, protectedCalls = 0, sourceReads = 0;
  const faults = { slackIncomplete: false, sourceIncomplete: false, crashAfterPost: false, expireAfterValidation: false };
  const directory = mkdtempSync(join(tmpdir(), 'promiseguard-approval-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'application.sqlite');
  let database = new ApplicationDatabase(path), repository = new ApplicationRepository(database);
  cleanup.push(() => database.close());
  const clock = () => now;
  const iso = () => new Date(now).toISOString();
  const id = (prefix: string) => `${prefix}-${++sequence}`;
  const stamp = () => ({ eventId: id('approval-event'), at: iso(), processId: 'test-process', bootId: 'test-boot', monotonicMs: sequence });
  const artifact = (value: unknown, prefix = 'evidence'): RestrictedArtifactRef => repository.transaction(identity, tx => {
    const ref = tx.putArtifact({ artifactId: id(prefix), mediaType: 'application/json', content: value });
    tx.appendEvent({ kind: 'fault.recorded', faultId: 'fixture-evidence', evidenceRef: ref }, stamp());
    return ref;
  });
  repository.transaction(identity, tx => {
    tx.createRun({ runId: identity.runId, incident, configuration, createdAt: at });
    const ref = tx.putArtifact({ artifactId: 'preflight', mediaType: 'application/json', content: { fixture: 'approval-v2' } });
    tx.registerEvaluation(EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2, runId: identity.runId, evaluationAttemptId: identity.evaluationAttemptId,
      suiteEntryId: 'approval-suite', manifestHash: digest({ fixture: 'approval-v2' }), registeredAt: at, dispatchAt: at,
      preflightRef: ref, s0Ref: ref, configuration, leg: 'baseline',
    }));
    tx.startRuntime({ runtimeAttemptId: identity.runtimeAttemptId, runId: identity.runId,
      evaluationAttemptId: identity.evaluationAttemptId, startedAt: at });
    tx.appendEvent({ kind: 'stage.started' }, stamp());
  });
  const provider = (context: AdapterCallContext, data: unknown, outcome: MutationOutcome | null = null) => {
    const eventContext = { ...identity, spanId: context.spanId, parentSpanId: identity.spanId };
    return repository.transaction(eventContext, tx => {
      const requestRef = tx.putArtifact({ artifactId: id('request'), mediaType: 'application/json', content: { operation: context.operation } });
      tx.startProviderAttempt({ context, requestRef, startedAt: iso() });
      tx.appendEvent({ kind: 'tool.dispatch', app: context.app, operation: context.operation, logicalCallId: context.logicalCallId,
        providerAttemptId: context.providerAttemptId, actor: 'marker' in context ? 'coordinator' : 'reader',
        effectKey: 'marker' in context ? context.marker : null, requestDigest: 'requestDigest' in context ? context.requestDigest : null,
        planHash: null, approvalId: null }, stamp());
      const response = tx.putArtifact({ artifactId: id('response'), mediaType: 'application/json', content: data });
      const receipt = ProviderAttemptReceiptSchema.parse({ schemaVersion: 2, context, startedAt: iso(), finishedAt: iso(),
        transport: 'fake', httpStatus: null, transportOutcome: 'response', providerOutcome: 'success', responseRef: response, errorCode: null });
      tx.recordProviderOutcome({ providerAttemptId: context.providerAttemptId, outcome, receipt });
      tx.appendEvent({ kind: 'tool.result', app: context.app, operation: context.operation, logicalCallId: context.logicalCallId,
        providerAttemptId: context.providerAttemptId, transportOutcome: 'response', providerOutcome: 'success', receiptRef: response, latencyMs: 0 }, stamp());
      return response;
    });
  };
  const read = <T>(context: ReadCallContext, data: T): ReadResult<T> => {
    const response = provider(context, data);
    return { status: 'complete', data, receipt: CollectionReceiptSchema.parse({ schemaVersion: 2, collectionId: context.logicalCallId,
      app: context.app, accountRef: context.accountRef, producerId: 'test-reader', startedAt: iso(), finishedAt: iso(), status: 'complete', reason: null,
      requiredQueryIds: [context.operation], pages: [{ queryId: context.operation, cursor: null, nextCursor: null,
        recordCount: Array.isArray(data) ? data.length : 1, response, providerAttemptId: context.providerAttemptId }] }) };
  };
  const sourceContext = (operation: 'github.readTechnicalEvidence' | 'hubspot.readCommitmentBundle') => ReadCallContextSchema.parse({
    schemaVersion: 2, runId: identity.runId, runtimeAttemptId: identity.runtimeAttemptId, evaluationAttemptId: identity.evaluationAttemptId, app: operation.split('.')[0], accountRef: `account-${operation.split('.')[0]}`, mode: 'fake', operation,
    spanId: id('source-span'), logicalCallId: id('source-call'), providerAttemptId: id('source-attempt'), deadlineAt, budgets });
  const technical = { incident, title: 'Incident under investigation', body: '```json\n' + JSON.stringify({
    incidentId: incident.issueId, service: incident.service, environment: incident.environment, state: 'open',
    startedAt: at, customerImpact: true }) + '\n```', comments: [], changes: [] };
  const hubspot = { commitments: [{ id: 'commitment-1', companyIds: ['company-1'], contactIds: ['contact-1'], ownerId: 'owner-1',
    service: incident.service, status: 'active', dueAt, promise: 'Customer update', version: 'v1' }],
    companies: [{ id: 'company-1', name: 'Fixture customer', contactIds: ['contact-1'] }],
    contacts: [{ id: 'contact-1', email: 'fixture@example.test', designated: true }], owners: [{ id: 'owner-1', active: true }] };
  const readSources = async () => {
    const fresh = collectSources();
    if (faults.sourceIncomplete) fresh.input.hubspot = { status: 'incomplete', reason: 'page_failed',
      receipt: { ...fresh.input.hubspot.receipt, status: 'incomplete', reason: 'page_failed' } };
    return fresh;
  };
  const collectSources = () => {
    sourceReads++;
    const githubContext = sourceContext('github.readTechnicalEvidence'), hubspotContext = sourceContext('hubspot.readCommitmentBundle');
    const githubRead = read(githubContext, structuredClone(technical));
    const hubspotRead = read(hubspotContext, structuredClone(hubspot));
    const sources: SnapshotRef[] = [
      { app: 'github' as const, data: technical, receipt: githubRead.receipt, sourceIds: [incident.issueId] },
      { app: 'hubspot' as const, data: hubspot, receipt: hubspotRead.receipt, sourceIds: ['commitment-1', 'company-1', 'contact-1', 'owner-1'] },
    ].map(source => ({ snapshotId: id(`snapshot-${source.app}`), app: source.app, accountRef: `account-${source.app}`,
      sourceIds: source.sourceIds, capturedAt: iso(), relevantVersion: 'v1', artifact: artifact(source.data), receipt: source.receipt }));
    repository.transaction(identity, tx => {
      sources.forEach(source => tx.saveSnapshot(source));
      tx.appendEvent({ kind: 'fault.recorded', faultId: 'fixture-snapshots', evidenceRef: sources[0].artifact }, stamp());
    });
    const input: SelectionInput = { schemaVersion: 2, incidentUrl: incident.canonicalUrl, github: githubRead, hubspot: hubspotRead, sources,
      sourceBundleRef: artifact({ github: technical, hubspot }) };
    return { input, githubContext, hubspotContext };
  };
  const { input } = collectSources(), selected = selectCommitments(input, sourcePolicy);
  assert.equal(selected.status, 'selected');
  assert.ok(selected.selection);
  const body = [{ type: 'text', text: 'We are investigating the incident.' }];
  const fingerprint = bindIncidentIdentity(incident, incident).incidentFingerprint;
  const taskKey = await deriveEffectKey({ incidentFingerprint: fingerprint, app: 'hubspot', stableBusinessTargetId: 'commitment-1', actionType: 'task' });
  const noteKey = await deriveEffectKey({ incidentFingerprint: fingerprint, app: 'hubspot', stableBusinessTargetId: 'commitment-1', actionType: 'note' });
  const draftKey = await deriveEffectKey({ incidentFingerprint: fingerprint, app: 'gmail', stableBusinessTargetId: 'commitment-1', actionType: 'draft' });
  const commentKey = await deriveEffectKey({ incidentFingerprint: fingerprint, app: 'github', stableBusinessTargetId: incident.issueId, actionType: 'comment' });
  const threadKey = await deriveEffectKey({ incidentFingerprint: fingerprint, app: 'slack', stableBusinessTargetId: fingerprint, actionType: 'thread' });
  const common = { commitmentId: 'commitment-1', requestDigest: digest({ fixture: 'approval-v2' }) };
  let plan = ImmutablePlanSchema.parse({ schemaVersion: 2, runId: identity.runId, revision: 1, planHash: common.requestDigest,
    createdAt: at, incident, sources: input.sources, selection: selected.selection,
    contents: [{ contentKey: 'body', text: body[0].text, sha256: createHash('sha256').update(body[0].text).digest('hex') }], effects: [
      { ...common, kind: 'task', app: 'hubspot', effectKey: taskKey, payload: { companyId: 'company-1', commitmentId: 'commitment-1',
        ownerId: 'owner-1', dueAt, status: 'NOT_STARTED', subject: 'Incident follow up', body } },
      { ...common, kind: 'note', app: 'hubspot', effectKey: noteKey, payload: { companyId: 'company-1', commitmentId: 'commitment-1',
        taskId: { type: 'effect_id', effectKey: taskKey }, body } },
      { ...common, kind: 'draft', app: 'gmail', effectKey: draftKey, payload: { to: 'fixture@example.test', cc: [], bcc: [], subject: 'Incident update', body, isDraft: true } },
      { ...common, commitmentId: null, kind: 'comment', app: 'github', effectKey: commentKey, payload: { repositoryId: incident.repositoryId,
        issueId: incident.issueId, body, taskIds: [{ type: 'effect_id', effectKey: taskKey }], draftIds: [{ type: 'effect_id', effectKey: draftKey }] } },
      { ...common, commitmentId: null, kind: 'thread', app: 'slack', effectKey: threadKey, payload: { channelId: policy.channelId, threadTs: '1789380000.000001', body } },
    ] });
  plan = { ...plan, effects: plan.effects.map(effect => ({ ...effect, requestDigest: digest(requestHashMaterial(effect, plan.contents)) })) };
  plan = { ...plan, planHash: digest(planHashMaterial(plan)) };
  const planRef = repository.transaction(identity, tx => {
    tx.freezePlan(plan);
    const ref = tx.putArtifact({ artifactId: 'frozen-plan', mediaType: 'application/json', content: plan });
    tx.appendEvent({ kind: 'plan.frozen', planRevision: 1, planHash: plan.planHash, planRef: ref }, stamp());
    return ref;
  });
  let messages: SlackMessage[] = [];
  const currentMessages = () => messages.map(message => ({ ...message, observedAt: iso() }));
  const slack: SlackAdapter = {
    scope: { app: 'slack', accountRef: 'account-slack' }, mode: 'fake',
    async postReview(write, context) {
      posts++;
      const messageTs = String(now / 1000 + 0.001);
      const message: SlackMessage = { workspaceId: policy.workspaceId, channelId: write.channelId, threadTs: write.threadTs!,
        messageTs, actorId: policy.reviewActorId, isBot: true, subtype: 'bot_message', editedAt: null,
        deleted: false, body: write.body, observedAt: iso() };
      messages.push(message);
      const outcome = { status: 'applied' as const, providerId: messageTs, receipt: artifact(message) };
      provider(AdapterCallContextSchema.parse(context), message, outcome);
      if (faults.crashAfterPost) throw new Error('simulated_crash_after_acceptance');
      return outcome;
    },
    async readApprovalThread(_channel, _thread, context) {
      const result = read(context, currentMessages());
      return faults.slackIncomplete ? { status: 'incomplete', reason: 'page_failed',
        receipt: { ...result.receipt, status: 'incomplete', reason: 'page_failed' } } : result;
    },
    async findReview(marker, context) { return read(context, currentMessages().filter(message => message.body.includes(marker))); },
    async getMessage(_channel, messageTs, context) { return read(context, currentMessages().find(message => message.messageTs === messageTs) ?? null); },
    async readSummary(_channel, messageTs, context) { return read(context, currentMessages().find(message => message.messageTs === messageTs) ?? null); },
    async updateReview() { throw new Error('unexpected_review_update'); },
    async postSummary() { throw new Error('unexpected_summary_write'); },
    async updateSummary() { throw new Error('unexpected_summary_update'); },
  };
  const state = WorkflowStateSchema.parse({ schemaVersion: 2, runId: identity.runId, runtimeAttemptId: identity.runtimeAttemptId,
    evaluationAttemptId: identity.evaluationAttemptId, stage: identity.stage, spanId: identity.spanId, ownerId: 'operator-1', runtimeAttemptIds: [identity.runtimeAttemptId],
    commandId: 'command-1', incidentTitle: technical.title, lastEventId: 'last-event', bootId: null, spanOpen: true, waitId: null,
    deadlineAt, stageDeadlineAt: null, stageTimeoutMs: 30000, wakeAt: null, scheduleStatus: 'running', statusReason: null,
    stages: PIPELINE_STAGE_IDS.map(stageId => ({ stageId, role: ['analyst', 'drafter', 'auditor'].includes(stageId) ? stageId : null,
      status: stageId === 'approval' ? 'running' : 'not_started', startedAt: null, updatedAt: null, attemptCount: 0, latestAttemptRef: null, reason: null })),
    commitments: { status: 'selected', policyVersion: 'selection-v1', selected: [{ commitmentId: 'commitment-1', company: 'Fixture customer', reason: 'eligible' }], excluded: [], evidenceRefs: [] },
    plan: { revision: 1, planHash: plan.planHash, contents: plan.contents, effects: plan.effects, orderedEffectKeys: plan.effects.map(effect => effect.effectKey),
      entries: [{ commitmentId: 'commitment-1', companyId: 'company-1', ownerId: 'owner-1', recipient: 'fixture@example.test',
        subject: 'Incident update', body: body[0].text, draftOnly: true }] },
    approval: null, effects: [], verifiedAt: null, references: { plan: planRef } });
  const node: WorkflowNodeContext = { state, eventContext: identity, signal: new AbortController().signal,
    transaction: action => {
      const result = repository.transaction(identity, action);
      const latest = repository.readEvents({ runId: plan.runId }).at(-1);
      if (faults.expireAfterValidation && latest?.kind === 'guard.checked' && latest.reason === 'dispatch_approval_validated') now += policy.ttlMs;
      return result;
    } };
  const service = () => createApprovalService({ repository, slack, policy, sourcePolicy, readSources, clock });
  const human = (overrides: Partial<SlackMessage> = {}) => {
    now += 1000;
    const message: SlackMessage = { workspaceId: policy.workspaceId, channelId: policy.channelId, threadTs: '1789380000.000001',
      messageTs: (now / 1000).toFixed(6), actorId: 'approver-1', isBot: false, subtype: null, editedAt: null, deleted: false,
      body: `approve ${identity.runId} ${plan.planHash.slice(0, 12)}`, observedAt: iso(), ...overrides };
    messages.push(message);
    return message;
  };
  return { node, plan, service, human, technical, hubspot, clock, faults, artifact, stamp, advance: (ms: number) => { now += ms; },
    readSources, protectedCall: () => { protectedCalls++; return 'created'; }, get protectedCalls() { return protectedCalls; },
    get posts() { return posts; }, get sourceReads() { return sourceReads; }, get messages() { return messages; },
    set messages(value) { messages = value; }, get repository() { return repository; },
    reopen() { database.close(); database = new ApplicationDatabase(path); repository = new ApplicationRepository(database); } };
}

test('exact review, human approval and a fresh source check release one guarded callback', async () => {
  const f = await fixture(), service = f.service();
  const review = await service.publishReview(f.node);
  assert.equal(review.status, 'ready');
  assert.equal(f.posts, 1);
  assert.match(f.messages[0].body, /Gmail actions create drafts only/);
  assert.ok(f.messages[0].body.includes(f.plan.planHash));
  assert.ok(f.messages[0].body.includes('fixture@example.test'));
  f.human();
  const approval = await service.checkApproval(f.node);
  assert.equal(approval.status, 'approved');
  if (approval.status !== 'approved') return;
  assert.equal(f.protectedCalls, 0);
  const dispatched = await service.withDispatchApproval(f.node, { reference: approval.reference, effectKey: f.plan.effects[0].effectKey }, f.protectedCall);
  assert.equal(dispatched.status, 'dispatched', JSON.stringify(dispatched));
  assert.equal(f.protectedCalls, 1);
  assert.ok(f.sourceReads >= 2);
  assert.ok(f.repository.readEvents({ runId: f.plan.runId }).some(event => event.kind === 'guard.checked' && event.allowed));
});

for (const [name, change] of [
  ['wrong actor', { actorId: 'untrusted-actor' }], ['wrong workspace', { workspaceId: 'workspace-other' }],
  ['wrong channel', { channelId: 'channel-other' }], ['wrong thread', { threadTs: '1789380000.999999' }],
  ['wrong run/hash', { body: 'approve another-run aaaaaaaa' }], ['bot reply', { isBot: true }],
  ['edited reply', { editedAt: at }], ['deleted reply', { deleted: true }],
] satisfies [string, Partial<SlackMessage>][]) {
  test(`${name} cannot authorize protected dispatch`, async () => {
    const f = await fixture(), service = f.service();
    assert.equal((await service.publishReview(f.node)).status, 'ready');
    f.human(change);
    assert.notEqual((await service.checkApproval(f.node)).status, 'approved');
    assert.equal(f.protectedCalls, 0);
  });
}

test('duplicate wakeups and database reopen reuse the exact review and retained approval', async () => {
  const f = await fixture();
  assert.equal((await f.service().publishReview(f.node)).status, 'ready');
  assert.equal((await f.service().publishReview(f.node)).status, 'ready');
  assert.equal(f.posts, 1);
  f.human();
  const first = await f.service().checkApproval(f.node);
  assert.equal(first.status, 'approved');
  f.reopen();
  assert.equal((await f.service().publishReview(f.node)).status, 'ready');
  const repeated = await f.service().checkApproval(f.node);
  assert.equal(repeated.status, 'approved', JSON.stringify(repeated));
  assert.equal(f.posts, 1);
  assert.equal(f.protectedCalls, 0);
});

test('rejection remains closed after the rejected message disappears and a later approve arrives', async () => {
  const f = await fixture(), service = f.service();
  assert.equal((await service.publishReview(f.node)).status, 'ready');
  f.human({ body: `reject ${f.plan.runId} ${f.plan.planHash}` });
  assert.equal((await service.checkApproval(f.node)).status, 'blocked');
  f.messages = f.messages.filter(message => message.isBot);
  f.human();
  f.reopen();
  assert.equal((await f.service().checkApproval(f.node)).status, 'blocked');
  assert.equal(f.protectedCalls, 0);
});

test('expiry, source correction and edited review each stop an already approved reference', async () => {
  for (const change of ['expiry', 'source', 'review'] as const) {
    const f = await fixture(), service = f.service();
    assert.equal((await service.publishReview(f.node)).status, 'ready');
    f.human();
    const approval = await service.checkApproval(f.node);
    assert.equal(approval.status, 'approved');
    if (approval.status !== 'approved') continue;
    if (change === 'expiry') f.advance(policy.ttlMs);
    else if (change === 'source') f.hubspot.contacts[0].email = 'changed@example.test';
    else f.messages[0].body += '\nChanged after approval.';
    await service.withDispatchApproval(f.node, { reference: approval.reference, effectKey: f.plan.effects[0].effectKey }, f.protectedCall);
    assert.equal(f.protectedCalls, 0, change);
  }
});

test('wait scheduling is pure and its frozen expiry survives durable workflow reopening', async () => {
  const f = await fixture(), service = f.service();
  const review = await service.publishReview(f.node);
  assert.equal(review.status, 'ready');
  if (review.status !== 'ready') return;
  const before = f.repository.readEvents({ runId: f.plan.runId }).length;
  const result = approvalWait(f.node, { ...review, clock: f.clock, pollMs: policy.pollMs });
  assert.equal(result.kind, 'wait');
  assert.equal(f.repository.readEvents({ runId: f.plan.runId }).length, before);
  assert.equal(f.posts, 1);
  if (result.kind !== 'wait') return;
  const saved = { ...f.node.state, ...result.patch, scheduleStatus: 'waiting' as const, wakeAt: result.wakeAt, waitId: 'approval-wait-1' };
  f.node.transaction(tx => {
    tx.saveWorkflow({ ...identity, ownerId: saved.ownerId, state: saved, scheduleStatus: saved.scheduleStatus,
      wakeAt: saved.wakeAt, deadlineAt: saved.deadlineAt, updatedAt: at });
    tx.appendEvent({ kind: 'wait.started', waitId: saved.waitId, reason: 'approval' }, f.stamp());
  });
  f.reopen();
  assert.deepEqual(f.repository.getWorkflow(f.plan.runId)?.state, saved);
  Object.assign(f.node.state, saved);
  f.human();
  const resumed = await createApprovalNode(f.service())(f.node);
  assert.equal(resumed.kind, 'advance');
  if (resumed.kind === 'advance') assert.equal(resumed.nextStage, 'execute');
  assert.equal(f.posts, 1);
  assert.equal(f.protectedCalls, 0);
});

test('incomplete Slack or source observations cannot release an existing approved reference', async () => {
  for (const fault of ['slackIncomplete', 'sourceIncomplete'] as const) {
    const f = await fixture(), service = f.service();
    assert.equal((await service.publishReview(f.node)).status, 'ready');
    f.human();
    const approval = await service.checkApproval(f.node);
    assert.equal(approval.status, 'approved');
    if (approval.status !== 'approved') continue;
    f.faults[fault] = true;
    const result = await service.withDispatchApproval(f.node, { reference: approval.reference, effectKey: f.plan.effects[0].effectKey }, f.protectedCall);
    assert.equal(result.status, 'blocked');
    assert.equal(f.protectedCalls, 0);
  }
});

test('removing an accepted human reply blocks each remaining protected action', async () => {
  const f = await fixture(), service = f.service();
  assert.equal((await service.publishReview(f.node)).status, 'ready');
  f.human();
  const approval = await service.checkApproval(f.node);
  assert.equal(approval.status, 'approved');
  if (approval.status !== 'approved') return;
  await service.withDispatchApproval(f.node, { reference: approval.reference, effectKey: f.plan.effects[0].effectKey }, f.protectedCall);
  assert.equal(f.protectedCalls, 1);
  f.messages = f.messages.filter(message => message.isBot);
  await service.withDispatchApproval(f.node, { reference: approval.reference, effectKey: f.plan.effects[1].effectKey }, f.protectedCall);
  assert.equal(f.protectedCalls, 1);
});

test('unissued copied authority and expiry at the final dispatch gate both block the callback', async () => {
  const f = await fixture(), service = f.service();
  assert.equal((await service.publishReview(f.node)).status, 'ready');
  f.human();
  const approval = await service.checkApproval(f.node);
  assert.equal(approval.status, 'approved');
  if (approval.status !== 'approved') return;
  const forged = f.artifact(JSON.parse(f.repository.readArtifact(approval.reference)));
  const copied = await service.withDispatchApproval(f.node, { reference: forged, effectKey: f.plan.effects[0].effectKey }, f.protectedCall);
  assert.equal(copied.status, 'blocked');
  f.faults.expireAfterValidation = true;
  const expired = await service.withDispatchApproval(f.node, { reference: approval.reference, effectKey: f.plan.effects[0].effectKey }, f.protectedCall);
  assert.equal(expired.status, 'blocked');
  assert.equal(f.protectedCalls, 0);
});

test('a publication crash adopts an exact read after reopen and never issues another post', async () => {
  const f = await fixture();
  f.faults.crashAfterPost = true;
  assert.equal((await f.service().publishReview(f.node)).status, 'blocked');
  assert.equal(f.posts, 1);
  f.reopen();
  assert.equal((await f.service().publishReview(f.node)).status, 'ready');
  assert.equal(f.posts, 1);
  f.messages = [];
  assert.equal((await f.service().publishReview(f.node)).status, 'blocked');
  assert.equal(f.posts, 1);
});

test('only exact approval grammar with an unambiguous active hash can resolve', () => {
  const hash = 'a'.repeat(64), other = 'a'.repeat(8) + 'b'.repeat(56);
  assert.equal(resolveApprovalHash('a'.repeat(8), [hash, other]), null);
  assert.equal(resolveApprovalHash(hash, [hash, other]), hash);
  assert.deepEqual(parseApprovalCommand(`approve run-1 ${hash}`), { decision: 'approved', runId: 'run-1', hashPrefix: hash });
  for (const text of [`approve run-1 aaaaaaa`, `approve run-1 ${hash}\n`, `please approve run-1 ${hash}`, `approve run-1 ${hash} revision-1`])
    assert.equal(parseApprovalCommand(text), null);
});

test('corrected contact gets revision 2 in the same thread and requires a new exact-plan approval', async () => {
  const f = await fixture(), service = f.service(), node = createApprovalNode(service);
  const firstWait = await node(f.node);
  assert.equal(firstWait.kind, 'wait');
  Object.assign(f.node.state, firstWait.patch);
  const originalReviewRef = f.node.state.references.slackReview;
  const originalSources = structuredClone(f.plan.sources);
  f.human({ body: `approve ${f.plan.runId} ${f.plan.planHash}` });
  const firstApproval = await service.checkApproval(f.node);
  assert.equal(firstApproval.status, 'approved');
  if (firstApproval.status !== 'approved') return;
  const retainedApprovals = f.repository.listApprovals(f.plan.runId, 1);

  f.hubspot.contacts[0].email = 'corrected@example.test';
  const invalidated = await service.revalidateForDispatch(f.node, {
    reference: firstApproval.reference, effectKey: f.plan.effects[0].effectKey,
  });
  assert.equal(invalidated.status, 'blocked');
  const fresh = await f.readSources();
  const selection = selectCommitments(fresh.input, { ...sourcePolicy, evaluatedAt: new Date(f.clock()).toISOString() });
  assert.equal(selection.status, 'selected');
  assert.ok(selection.selection);
  let revised = ImmutablePlanSchema.parse({ ...f.plan, revision: 2, createdAt: new Date(f.clock()).toISOString(),
    sources: fresh.input.sources, selection: selection.selection,
    effects: f.plan.effects.map(effect => effect.kind === 'draft'
      ? { ...effect, payload: { ...effect.payload, to: 'corrected@example.test' } } : effect) });
  revised = { ...revised, effects: revised.effects.map(effect => ({ ...effect, requestDigest: digest(requestHashMaterial(effect, revised.contents)) })) };
  revised = { ...revised, planHash: digest(planHashMaterial(revised)) };
  const revisedRef = f.node.transaction(tx => {
    tx.freezePlan(revised);
    const ref = tx.putArtifact({ artifactId: 'frozen-plan-2', mediaType: 'application/json', content: revised });
    tx.appendEvent({ kind: 'plan.frozen', planRevision: 2, planHash: revised.planHash, planRef: ref }, f.stamp());
    return ref;
  });
  assert.notEqual(revised.planHash, f.plan.planHash);
  assert.deepEqual(revised.effects.map(effect => effect.effectKey), f.plan.effects.map(effect => effect.effectKey));
  f.node.state.plan = { ...f.node.state.plan!, revision: 2, planHash: revised.planHash, effects: revised.effects,
    entries: f.node.state.plan!.entries.map(entry => ({ ...entry, recipient: 'corrected@example.test' })) };
  f.node.state.references.plan = revisedRef;
  assert.deepEqual(f.node.state.references.slackReview, originalReviewRef);

  const replacementWait = await node(f.node);
  assert.equal(replacementWait.kind, 'wait');
  Object.assign(f.node.state, replacementWait.patch);
  assert.notDeepEqual(f.node.state.references.slackReview, originalReviewRef);
  assert.equal(f.posts, 2);
  assert.equal(new Set(f.messages.filter(message => message.isBot).map(message => message.threadTs)).size, 1);
  assert.ok(f.messages.filter(message => message.isBot)[1].body.includes('corrected@example.test'));
  f.human({ body: `approve ${f.plan.runId} ${f.plan.planHash}` });
  assert.equal((await node(f.node)).kind, 'wait');
  f.human({ body: `approve ${revised.runId} ${revised.planHash}` });
  const approved = await node(f.node);
  assert.equal(approved.kind, 'advance');
  if (approved.kind === 'advance') assert.equal(approved.nextStage, 'execute');
  assert.equal(approved.patch?.approval?.planHash, revised.planHash);
  assert.deepEqual(f.repository.getPlan(f.plan.runId, 1)?.sources, originalSources);
  for (const source of originalSources) assert.ok(f.repository.readArtifact(source.artifact));
  assert.deepEqual(f.repository.listApprovals(f.plan.runId, 1), retainedApprovals);
  assert.equal(f.repository.listApprovals(f.plan.runId, 2).length, 1);
  assert.equal(f.protectedCalls, 0);
});
