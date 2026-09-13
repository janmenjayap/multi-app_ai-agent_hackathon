import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import { z } from 'zod';
import { buildFixture } from '../../src/server/monitoring/demo.js';
import { digest, parseBatch, parseManifest } from '../../src/shared/reliability.js';
import {
  canonical, CollectionReceiptSchema, EffectRecordSchema, ExecutionModeSchema,
  IncidentIdentitySchema, MutationOutcomeSchema, normalizeBody, parseImmutablePlan,
  PlannedEffectSchema, readResultSchema, SelectionSchema, SlackDecisionSchema, PIPELINE_STAGE_IDS, requestHashMaterial, sha256Text, verifyPlanIntegrity,
} from '../../src/shared/domain.js';
import {
  AgentInvocationContextSchema, AnalystInputSchema, AuditorInputSchema, DraftInputSchema,
  DraftProposalSchema, IncidentAssessmentSchema, agentCallResultSchema,
  parseAuditVerdict, parseDraftProposal, parseRoleInput, roleInvocationKey,
} from '../../src/shared/agents.js';
import {
  DraftWriteSchema, GmailDraftSchema, McpOperationBindingSchema, ProtectedCallContextSchema,
  ProviderAttemptReceiptSchema, ReadCallContextSchema, parseAdapterContext,
} from '../../src/shared/adapters.js';
import {
  ApprovedContentBindingSchema, ClaimFactsV2Schema, CompletionClaimSchema, ImportedObservationSchema,
  LatencySummarySchema, LogicalIdBindingSchema, LogicalManifestSchema, MetricCountSchema, ObservedCompletionClaimSchema, OriginalOutputSchema, OutputHistorySchema,
  ReviewLabelSchema, appendOriginalOutput, parseApprovedContentBinding, parseCheckerExportBinding, parseReviewLabel,
} from '../../src/shared/evaluation.js';
import { EventBatchV2Schema, EventV2Schema, parseEventV2Compatibility, parsePersistedEventBatch } from '../../src/shared/events.js';
import {
  ApiErrorSchema, AssessmentReadSchema, AssessmentSummaryViewSchema, CommandResultSchema, CreateRunCommandSchema,
  EvaluationSummaryViewSchema, HealthViewSchema, MetricCountViewSchema, ReconcileRunCommandSchema,
  RedactedReferenceSchema, RunEventsPageSchema, RunViewSchema, TraceViewSchema, acceptEventsPage, acceptRunView, assertPublicProjection,
} from '../../src/shared/api.js';
import type { EvaluationAttemptId, ModelAttemptId, ProviderAttemptId, RuntimeAttemptId } from '../../src/shared/domain.js';
import type { GitHubReader } from '../../src/shared/adapters.js';
import type { TrustedIngestionReceipt } from '../../src/shared/evaluation.js';

// Compile-only consumer contract checks. Never invoke this function: no adapter
// dispatch or trusted ingestion is performed by the schema example suite.
function compileTimeBoundaries(reader: GitHubReader, runtimeAttempt: RuntimeAttemptId, providerAttempt: ProviderAttemptId) {
  // @ts-expect-error A read-only capability never includes protected creates.
  reader.createComment;
  // @ts-expect-error Runtime resumption is not a new evaluation sample identity.
  const evaluationAttempt: EvaluationAttemptId = runtimeAttempt;
  // @ts-expect-error Provider dispatch identities cannot stand in for model attempts.
  const modelAttempt: ModelAttemptId = providerAttempt;
  // @ts-expect-error JSON-visible fields cannot create the trusted ingestion capability.
  const forgedReceipt: TrustedIngestionReceipt = { observationId: 'observation-1', origin: 'collector', ingestionId: 'ingest-1' };
  void evaluationAttempt; void modelAttempt; void forgedReceipt;
}
void compileTimeBoundaries;

// These examples establish accepted wire shapes independently of the product
// implementation and make no claim about real provider or model evidence.
const capturedAt = '2026-09-14T10:00:00Z';
const later = '2026-09-14T10:00:01Z';
const hash = 'a'.repeat(64);
const artifact = (artifactId = 'restricted-artifact-1') => ({
  artifactId, sha256: hash, byteLength: 32, mediaType: 'application/json' as const,
});
const collection = (app: 'github' | 'hubspot' | 'gmail' | 'slack' = 'github') => ({
  schemaVersion: 2, collectionId: `collection-${app}`, app, accountRef: `account-${app}`,
  producerId: 'reader-1', startedAt: capturedAt, finishedAt: later,
  status: 'complete', reason: null, requiredQueryIds: ['query-1'],
  pages: [{ queryId: 'query-1', cursor: null, nextCursor: null, recordCount: 0,
    response: artifact(), providerAttemptId: 'provider-read-1' }],
});
const incident = () => ({
  schemaVersion: 2, repositoryId: 'repository-123', issueId: 'issue-456', issueNumber: 7,
  canonicalUrl: 'https://github.com/example/fixture/issues/7', service: 'billing', environment: 'production',
});
const selected = (commitmentId = 'commitment-1') => ({
  commitmentId, companyId: 'company-1', ownerId: 'owner-1', contactId: 'contact-1',
  mailbox: 'designated@example.invalid', dueAt: '2026-09-15T10:00:00Z', service: 'billing', reason: 'active_in_horizon',
});
const selection = () => ({
  schemaVersion: 2, policyVersion: 'selection-v1', evaluatedAt: capturedAt,
  sourceBundleRef: artifact('source-bundle-1'), sourceComplete: true, selected: [selected()], excluded: [],
});
const sourceFacts = () => [{ factId: 'fact-1', sourceRef: artifact('source-fact-1'), sourceField: 'issue.body', text: 'A service incident is being investigated.' }];
const proposal = () => ({ schemaVersion: 2, entries: ['commitment-1', 'commitment-2'].map((commitmentId, i) => ({
  commitmentId, text: 'We are investigating the service incident.',
  claims: [{ claimId: `claim-${i + 1}`, text: 'An investigation is underway.', sourceFactIds: ['fact-1'] }],
})) });
const assessment = () => ({ schemaVersion: 2, facts: proposal().entries[0].claims, contradictions: [], unknowns: ['Recovery time'],
  candidateChange: { status: 'uncertain', sourceFactIds: ['fact-1'], reason: 'No causal confirmation exists.' } });
const auditorInput = () => AuditorInputSchema.parse({ schemaVersion: 2, sources: sourceFacts(), proposal: proposal(),
  taskContract: { selectedCommitmentIds: ['commitment-1', 'commitment-2'], requiredFacts: ['fact-1'], forbiddenClaims: ['Recovery is guaranteed'] } });
const context = (role: 'analyst' | 'drafter' | 'auditor' = 'analyst', input: unknown = { schemaVersion: 2, sources: sourceFacts() }) => AgentInvocationContextSchema.parse({
  schemaVersion: 2, runId: 'run-1', evaluationAttemptId: 'evaluation-1', runtimeAttemptId: 'runtime-1',
  planRevision: 1, role, roleInvocationKey: roleInvocationKey('run-1', 1, role), snapshotBundleRef: artifact('source-bundle-1'),
  inputDigest: digest(input), promptVersion: 'prompt-v1', outputSchemaVersion: 'role-v2', modelConfigRef: 'model-config-1', configDigest: hash,
  budgets: { timeoutMs: 1000, roleBudgetMs: 3000, maxAttempts: 2, maxOutputTokens: 2000, maxInputChars: 24000, maxCommitments: 100 },
  spanId: 'model-span-1', parentSpanId: 'stage-span-1', deadlineAt: later,
});
const readContext = () => ({ schemaVersion: 2, runId: 'run-1', evaluationAttemptId: 'evaluation-1', runtimeAttemptId: 'runtime-1',
  spanId: 'provider-span-1', app: 'gmail', accountRef: 'account-gmail', mode: 'rest', logicalCallId: 'logical-read-1',
  providerAttemptId: 'provider-read-1', deadlineAt: later, operation: 'gmail.getDraft',
  budgets: { timeoutMs: 1000, totalMs: 3000, maxAttempts: 2, maxPages: 10, maxRecords: 100, maxResponseBytes: 100000 } });
const originalOutput = () => ({ schemaVersion: 2, runId: 'run-1', evaluationAttemptId: 'evaluation-1', runtimeAttemptId: 'runtime-1',
  outputId: 'output-1', firstOutputId: 'output-1', previousOutputId: null, role: 'analyst', roleInvocationKey: context().roleInvocationKey,
  planRevision: 1, modelAttemptId: 'model-1', inputDigest: hash, sourceDigests: [hash], configDigest: hash,
  promptVersion: 'prompt-1', modelVersion: 'model-1', outputSchemaVersion: 'analyst-v2', receivedAt: capturedAt,
  rawOutput: artifact('raw-output-1'), parseStatus: 'malformed', validationStatus: 'invalid', correctionReason: null });
const reviewLabel = () => ({ schemaVersion: 2, labelId: 'label-1', runId: 'run-1', evaluationAttemptId: 'evaluation-1',
  outputId: 'output-1', role: 'analyst', outputDigest: hash, sourceDigests: [hash],
  reviewer: { kind: 'human', reviewerId: 'reviewer-1', interactionRef: artifact('operator-interaction') },
  reason: 'The original output omitted required information.', reviewedAt: later,
  grounding: true, completeness: false, decision: false, handoff: false,
  findings: [{ claimId: 'claim-1', judgment: 'uncertain', reason: 'Source evidence was insufficient.', sourceDigests: [hash] }],
  supersedesLabelId: null });
const noAffectedClaim = () => ({ schemaVersion: 2, claimId: 'claim-empty', runId: 'run-1', evaluationAttemptId: 'evaluation-1',
  runtimeAttemptId: 'runtime-1', eventId: 'event-empty', sequence: 3, emittedAt: later, scope: 'no_affected',
  sourceReceipts: [collection('github'), collection('hubspot')],
  selection: { eligibleCount: 0, sourceComplete: true, policyVersion: 'selection-v1', receipt: artifact('empty-selection') },
  absenceEvidence: [{ predicateId: 'no-protected-mutations', status: 'confirmed', receipt: artifact('absence-read') }],
  protectedMutationCount: 0, modelCallCount: 0 });
const eventEnvelope = (sequence = 1) => ({ schemaVersion: 2, producerVersion: 'producer-v2', producerId: 'producer-1', eventId: `event-${sequence}`,
  runId: 'run-1', evaluationAttemptId: 'evaluation-1', runtimeAttemptId: 'runtime-1', sequence, stage: 'analyst',
  spanId: 'stage-span-1', parentSpanId: null, at: capturedAt, processId: 'process-1', bootId: 'boot-1', monotonicMs: sequence, causedBy: [] });
const modelEvents = () => {
  const model = { role: 'analyst', logicalCallId: 'role-call-1', modelAttemptId: 'model-1', roleInvocationKey: context().roleInvocationKey, planRevision: 1 };
  return [{ ...eventEnvelope(), kind: 'stage.started' },
    { ...eventEnvelope(2), ...model, kind: 'model.attempt.started', spanId: 'model-span-1', parentSpanId: 'stage-span-1',
      inputDigest: hash, configDigest: hash, promptVersion: 'prompt-1', modelVersion: 'model-1', outputSchemaVersion: 'analyst-v2', causedBy: ['event-1'] },
    { ...eventEnvelope(3), ...model, kind: 'model.attempt.result', spanId: 'model-span-1', parentSpanId: 'stage-span-1',
      outputRef: artifact('raw-model-output'), validation: 'invalid', latencyMs: null, usage: null, causedBy: ['event-2'] }];
};
const eventBatch = () => ({ schemaVersion: 2, runId: 'run-1', evaluationAttemptId: 'evaluation-1', events: modelEvents() });
const plan = () => {
  const effectBase = { commitmentId: 'commitment-1', requestDigest: hash };
  const body = [{ type: 'text', text: 'Synthetic approved customer update.' }];
  return {
    schemaVersion: 2, runId: 'run-1', revision: 1, planHash: hash, createdAt: capturedAt,
    incident: incident(), selection: selection(),
    sources: (['github', 'hubspot'] as const).map(app => ({
      snapshotId: `snapshot-${app}`, app, accountRef: `account-${app}`, sourceIds: ['source-1'],
      capturedAt, relevantVersion: 'version-1', artifact: artifact(`source-${app}`), receipt: collection(app),
    })),
    contents: [{ contentKey: 'customer-body', text: 'Synthetic approved customer update.', sha256: hash }],
    effects: [
      { ...effectBase, kind: 'task', app: 'hubspot', effectKey: 'effect-task', payload: {
        companyId: 'company-1', commitmentId: 'commitment-1', ownerId: 'owner-1', dueAt: selected().dueAt,
        status: 'NOT_STARTED', subject: 'Follow up fixture incident', body,
      } },
      { ...effectBase, kind: 'note', app: 'hubspot', effectKey: 'effect-note', payload: {
        companyId: 'company-1', commitmentId: 'commitment-1', taskId: { type: 'effect_id', effectKey: 'effect-task' }, body,
      } },
      { ...effectBase, kind: 'draft', app: 'gmail', effectKey: 'effect-draft', payload: {
        to: selected().mailbox, cc: [], bcc: [], subject: 'Fixture incident update', body, isDraft: true,
      } },
      { ...effectBase, commitmentId: null, kind: 'comment', app: 'github', effectKey: 'effect-comment', payload: {
        repositoryId: 'repository-123', issueId: 'issue-456',
        taskIds: [{ type: 'effect_id', effectKey: 'effect-task' }], draftIds: [{ type: 'effect_id', effectKey: 'effect-draft' }], body,
      } },
      { ...effectBase, commitmentId: null, kind: 'thread', app: 'slack', effectKey: 'effect-thread', payload: {
        channelId: 'channel-1', threadTs: '123.456', body,
      } },
    ],
  };
};
const logicalManifest = () => {
  const ref = (effectKey: string) => ({ type: 'effect_id', effectKey });
  const content = { type: 'approved_content', planRevision: 1, contentKey: 'customer-body' };
  return { schemaVersion: 2, manifestId: 'manifest-full-v2', cohortId: 'cohort-v2', suiteEntryId: 'suite-entry-1', family: 1,
    executionEligible: true, expectedUnsafe: false, variantId: 'baseline', repetition: 0, faultIds: [],
    budgets: { activeMs: 90000, humanWaitMs: 120000, wallMs: 210000, recoveryMs: 60000, maxToolAttempts: 100 },
    mode: 'synthetic_fixture', frozenAt: capturedAt, versions: { app: 'app-v2', fixture: 'fixture-v2', policy: 'policy-v1', prompt: 'prompt-v1', model: 'model-v1' },
    requiredRoles: ['analyst', 'drafter', 'auditor'], expectedTerminalStatus: 'completed',
    effects: [
      { effectKey: 'effect-task', app: 'hubspot', accountRef: 'account-hubspot', kind: 'task', requiredFields: {
        companyId: 'company-1', commitmentId: 'commitment-1', ownerId: 'owner-1', dueAt: selected().dueAt, status: 'NOT_STARTED',
      } },
      { effectKey: 'effect-note', app: 'hubspot', accountRef: 'account-hubspot', kind: 'note', requiredFields: {
        companyId: 'company-1', commitmentId: 'commitment-1', taskId: ref('effect-task'), bodySha256: content,
      } },
      { effectKey: 'effect-draft', app: 'gmail', accountRef: 'account-gmail', kind: 'draft', requiredFields: {
        to: selected().mailbox, cc: [], bcc: [], subject: 'Fixture incident update', bodySha256: content, isDraft: true,
      } },
      { effectKey: 'effect-comment', app: 'github', accountRef: 'account-github', kind: 'comment', requiredFields: {
        incidentId: 'issue-456', taskIds: [ref('effect-task')], draftIds: [ref('effect-draft')], bodySha256: content,
      } },
      { effectKey: 'effect-thread', app: 'slack', accountRef: 'account-slack', kind: 'thread', requiredFields: {
        channelId: 'channel-1', taskIds: [ref('effect-task')], noteIds: [ref('effect-note')], draftIds: [ref('effect-draft')],
        commentId: ref('effect-comment'), bodySha256: content, verdict: 'completed',
      } },
    ], sourceFacts: [{ factId: 'fact-1', sourceDigest: hash, assertion: sourceFacts()[0].text }],
    protectedRecords: [{ app: 'hubspot', logicalId: 'company-1' }], forbiddenEffects: ['unapproved_write', 'send_email', 'duplicate_create'],
    claimWindow: { maxEvidenceAgeMs: 30000, settlingMs: 1000, cutoffAt: later } };
};
const publicReference = (referenceId = 'public-evidence-1') => ({ referenceId, label: 'Authorized evidence', availability: 'available', href: `/api/evidence/${referenceId}` });
const pendingAssessment = () => ({ status: 'pending', coverage: 'unavailable', evaluatorVersion: null,
  assessmentRevision: null, observedAt: null, watermark: null, requiredCount: 0, confirmedCount: 0, humanLabelCount: null,
  gaps: [{ code: 'assessment_pending', referenceId: null }] });
const passedAssessment = () => ({ status: 'pass', coverage: 'complete', evaluatorVersion: 'monitor-v2',
  assessmentRevision: 1, observedAt: later, watermark: 'watermark-1', requiredCount: 1, confirmedCount: 1, humanLabelCount: 1, gaps: [] });
const report = () => ({ schemaVersion: 2, reportId: 'report-1', revision: 1, cohortId: 'cohort-1', evaluatorVersion: 'monitor-v2', manifestVersion: '2',
  logicalManifestHash: hash, configuration: { schemaVersion: 2, modelMode: 'mock', providerMode: 'fake', evidenceMode: 'synthetic_fixture', fixtureId: 'fixture-1' },
  provenance: 'synthetic', cutoffAt: later, observedAt: later, watermark: 'watermark-1',
  census: { planned: 3, attempted: 1, assessed: 1, failed: 0, unverified: 1, setupFailed: 1, notRun: 1 },
  metrics: [{ metricId: 'M1', dimension: 'overall', role: null, numerator: 0, denominator: 0, value: null, availability: 'na', sampleIds: [] }],
  criticalCounts: [{ code: 'falseCompletion', count: null, availability: 'unavailable', sampleIds: [] }], humanLabelCount: 0,
  gaps: [{ code: 'no_human_labels', referenceId: null }], reportRef: publicReference('report-evidence') });
const runView = () => ({ schemaVersion: 2, revision: 1, runId: 'run-1', evaluationAttemptId: 'evaluation-1', runtimeAttemptIds: ['runtime-1'],
  incident: { url: incident().canonicalUrl, title: 'Synthetic service incident', service: 'billing', environment: 'production' },
  configuration: report().configuration, productStatus: 'completed', statusReason: null,
  stages: PIPELINE_STAGE_IDS.map(stageId => ({ stageId, role: ['analyst', 'drafter', 'auditor'].includes(stageId) ? stageId : null,
    status: stageId === 'assess' ? 'queued' : 'succeeded', startedAt: capturedAt, updatedAt: later,
    attemptCount: stageId === 'assess' ? 0 : 1, latestAttemptRef: null, reason: null })),
  commitments: { status: 'selected', policyVersion: 'selection-v1', selected: [{ commitmentId: 'commitment-1', company: 'Synthetic company', reason: 'active_in_horizon' }],
    excluded: [], evidenceRefs: [publicReference()] },
  plan: { revision: 1, planHash: hash, entries: [{ commitmentId: 'commitment-1', companyId: 'company-1', ownerId: 'owner-1',
    recipient: selected().mailbox, subject: 'Fixture incident update', body: 'Synthetic approved customer update.', draftOnly: true }],
    orderedEffectKeys: plan().effects.map(e => e.effectKey), effects: plan().effects, contents: plan().contents },
  approval: { status: 'approved', planRevision: 1, planHash: hash, slackLink: 'https://app.slack.com/archives/channel-1/p123',
    approver: 'Authorized reviewer', decidedAt: capturedAt, expiresAt: '2026-09-14T10:10:00Z', invalidationReason: null },
  effects: plan().effects.map(e => ({ effectKey: e.effectKey, app: e.app, kind: e.kind, state: 'verified', outcome: 'applied',
    result: 'created', providerId: `${e.effectKey}-provider`, providerLink: null, verifiedAt: later, comparison: 'matched', comparisons: [], readbackRef: publicReference(e.effectKey) })),
  assessments: { trace: pendingAssessment(), outcome: pendingAssessment(), firstProposal: { ...pendingAssessment(), status: 'unverified', humanLabelCount: 0 }, selectedPlan: null },
  report: null, reportAvailability: 'unavailable', createdAt: capturedAt, updatedAt: later, verifiedAt: later });
const eventsPage = () => ({ schemaVersion: 2, runId: 'run-1', runRevision: 1,
  events: [{ eventId: 'public-event-1', sequence: 1, stageId: 'ingest', kind: 'stage.started', at: capturedAt, reference: null },
    { eventId: 'public-event-2', sequence: 2, stageId: 'select', kind: 'stage.finished', at: later, reference: publicReference() }],
  nextCursor: 'opaque_cursor_2', hasMore: false });

test('persisted monitor-v1 manifests, events and labels retain their existing contract', () => {
  const { manifest, record } = buildFixture();
  assert.deepEqual(parseManifest(JSON.parse(JSON.stringify(manifest))), manifest);
  const batch = { events: record.events, labels: record.labels, traceComplete: true };
  assert.deepEqual(parseBatch(JSON.parse(JSON.stringify(batch))), batch);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.mode, 'synthetic_fixture');
});

test('monitor-v1 compatibility never silently interprets a new schema version', () => {
  const { manifest } = buildFixture();
  assert.throws(() => parseManifest({ ...manifest, schemaVersion: 2 }), /invalid_manifest/);
});

test('canonical identities reject malformed IDs, mismatched issue URLs and unversioned inputs', () => {
  assert.doesNotThrow(() => IncidentIdentitySchema.parse(incident()));
  for (const patch of [
    { repositoryId: '' }, { issueId: 'private/path' }, { issueNumber: 8 }, { schemaVersion: undefined },
    { canonicalUrl: 'not-a-url' },
    { canonicalUrl: 'https://github.com/example/fixture/issues/7?token=private' },
    { canonicalUrl: 'https://github.com.evil.invalid/example/fixture/issues/7' },
    { canonicalUrl: 'https://user:password@github.com/example/fixture/issues/7' },
  ]) assert.equal(IncidentIdentitySchema.safeParse({ ...incident(), ...patch }).success, false);
});

test('complete empty reads require terminal page coverage and retain an incomplete failure reason', () => {
  const schema = readResultSchema(z.array(z.string()));
  assert.doesNotThrow(() => schema.parse({ status: 'complete', data: [], receipt: collection() }));
  const unfinished = { ...collection(), status: 'incomplete', reason: 'page_failed',
    pages: [{ ...collection().pages[0], nextCursor: 'page-2' }] };
  assert.doesNotThrow(() => schema.parse({ status: 'incomplete', reason: 'page_failed', partialData: [], receipt: unfinished }));
  assert.equal(schema.safeParse({ status: 'complete', data: [], receipt: unfinished }).success, false);
  assert.equal(schema.safeParse({ status: 'incomplete', reason: 'timeout', receipt: unfinished }).success, false);
  for (const receipt of [
    { ...collection(), pages: [] },
    { ...collection(), pages: [{ ...collection().pages[0], nextCursor: 'page-2' }] },
    { ...collection(), requiredQueryIds: ['query-1', 'missing-associations-query'] },
    { ...collection(), status: 'incomplete', reason: null },
    { ...collection(), finishedAt: '2026-09-14T09:59:59Z' },
    { ...collection(), pages: [collection().pages[0], collection().pages[0]] },
  ]) assert.equal(CollectionReceiptSchema.safeParse(receipt).success, false);
});

test('selection freezes owner, contact and designated recipient and never turns incomplete input into no affected', () => {
  assert.doesNotThrow(() => SelectionSchema.parse(selection()));
  assert.doesNotThrow(() => SelectionSchema.parse({ ...selection(), selected: [] }));
  for (const patch of [
    { sourceComplete: false }, { selected: [{ ...selected(), ownerId: null }] },
    { selected: [{ ...selected(), mailbox: 'one@example.invalid,two@example.invalid' }] },
    { selected: [selected(), selected()] }, { excluded: [{ commitmentId: 'commitment-1', reason: 'excluded' }] },
  ]) assert.equal(SelectionSchema.safeParse({ ...selection(), ...patch }).success, false);
});

test('approved plan preserves exact selected effects, order, recipient and immutable nested data', () => {
  const parsed = parseImmutablePlan(plan());
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.effects[0].payload), true);
  assert.throws(() => { (parsed.effects[0].payload as { subject: string }).subject = 'Changed'; });
  for (const patch of [
    { effects: plan().effects.slice(1) },
    { effects: [...plan().effects].reverse() },
    { effects: [...plan().effects, plan().effects[0]] },
    { selection: { ...selection(), selected: [] } },
    { effects: plan().effects.map(e => e.kind === 'draft' ? { ...e, payload: { ...e.payload, to: 'other@example.invalid' } } : e) },
    { effects: plan().effects.map(e => e.kind === 'task' ? { ...e, payload: { ...e.payload, ownerId: 'different-owner' } } : e) },
    { effects: plan().effects.map(e => e.kind === 'note' ? { ...e, payload: { ...e.payload, taskId: { type: 'effect_id', effectKey: 'effect-draft' } } } : e) },
  ]) assert.throws(() => parseImmutablePlan({ ...plan(), ...patch }));
});

test('a two-customer plan has three effects per customer and one complete incident summary and Slack thread', () => {
  const initial = plan();
  const second = initial.effects.slice(0, 3).map(e => ({ ...e, effectKey: `${e.effectKey}-2`, commitmentId: 'commitment-2',
    payload: e.kind === 'task' ? { ...e.payload, commitmentId: 'commitment-2' } : e.kind === 'note' ? {
      ...e.payload, commitmentId: 'commitment-2', taskId: { type: 'effect_id', effectKey: 'effect-task-2' },
    } : e.payload,
  }));
  const globals = initial.effects.slice(3).map(e => e.kind !== 'comment' ? e : { ...e, payload: {
    ...e.payload, taskIds: [{ type: 'effect_id', effectKey: 'effect-task' }, { type: 'effect_id', effectKey: 'effect-task-2' }],
    draftIds: [{ type: 'effect_id', effectKey: 'effect-draft' }, { type: 'effect_id', effectKey: 'effect-draft-2' }],
  } });
  const multiple = { ...initial, selection: { ...selection(), selected: [selected(), selected('commitment-2')] },
    effects: [...initial.effects.slice(0, 3), ...second, ...globals] };
  assert.equal(parseImmutablePlan(multiple).effects.length, 8);
  assert.throws(() => parseImmutablePlan({ ...multiple, effects: [...multiple.effects, ...globals] }));
  assert.throws(() => parseImmutablePlan({ ...multiple, effects: multiple.effects.map(e => e.kind === 'comment' ? {
    ...e, payload: { ...e.payload, taskIds: [{ type: 'effect_id', effectKey: 'effect-task' }] },
  } : e) }));
});

test('protected effect schemas reject undeclared mutations, extra recipients and mail header injection', () => {
  const draft = plan().effects.find(e => e.kind === 'draft')!;
  assert.doesNotThrow(() => PlannedEffectSchema.parse(draft));
  for (const patch of [
    { kind: 'send' }, { app: 'github' }, { operation: 'delete' },
    { payload: { ...draft.payload, isDraft: false } },
    { payload: { ...draft.payload, cc: ['other@example.invalid'] } },
    { payload: { ...draft.payload, bcc: ['hidden@example.invalid'] } },
    { payload: { ...draft.payload, subject: 'Subject\r\nBcc: hidden@example.invalid' } },
  ]) assert.equal(PlannedEffectSchema.safeParse({ ...draft, ...patch }).success, false);
});

test('canonical payload digests preserve arrays, Unicode and empty fields; body normalization is explicit', () => {
  assert.equal(canonical({ z: '', a: [2, 1] }), '{"a":[2,1],"z":""}');
  // Independently calculated SHA-256 vectors of the specified canonical UTF-8 bytes.
  for (const [value, expected] of [
    [{ b: 2, a: 1 }, '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777'],
    [[1, 2], '49a64717d5d4cb19952e6eac2946415cf6879adacf9908e7d872332d32c6e684'],
    ['é', 'f2886017e9c7abacf804b54d64787dce2b611c9544ba21f3affdd126a6e50086'],
    ['line1\r\nline2', '5fcbd27b066836fb900c48269972054847075260e87794824a021c48d6caa0f7'],
    [{ empty: '' }, '5ddea0bed9ab50512425b4c9fa9698e0bacfb81414a3e65f3af66c9e85a9c8f0'],
  ] as const) assert.equal(digest(value), expected);
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
  assert.notEqual(digest({ a: '' }), digest({}));
  assert.notEqual(digest('é'), digest('e\u0301'));
  assert.equal(normalizeBody('e\u0301\r\nnext\rline '), 'é\nnext\nline ');
  for (const patch of [{ recipient: 'changed@example.invalid' }, { body: 'changed' }, { association: 'other' }]) {
    const original = { recipient: 'selected@example.invalid', body: 'body', association: 'company-1' };
    assert.notEqual(digest(original), digest({ ...original, ...patch }));
  }
});

test('plan integrity binds exact normalized content bytes, each request and the complete immutable plan', async () => {
  const signed = plan();
  for (const content of signed.contents) content.sha256 = createHash('sha256').update(content.text, 'utf8').digest('hex');
  for (const effect of signed.effects) {
    const { requestDigest: _requestDigest, ...material } = effect;
    effect.requestDigest = digest(material);
  }
  const { planHash: _planHash, ...material } = signed;
  signed.planHash = digest(material);
  const verified = await verifyPlanIntegrity(signed);
  assert.equal(verified.planHash, signed.planHash);
  assert.equal(Object.isFrozen(verified.effects[0]), true);
  assert.equal(await sha256Text('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await assert.rejects(verifyPlanIntegrity({ ...signed, planHash: hash }), /plan_digest_mismatch/);
  await assert.rejects(verifyPlanIntegrity({ ...signed, contents: signed.contents.map(c => ({ ...c, text: 'Changed bytes.' })) }), /content_digest_mismatch/);
  await assert.rejects(verifyPlanIntegrity({ ...signed, effects: signed.effects.map((e, i) => i === 0 ? { ...e, requestDigest: hash } : e) }), /request_digest_mismatch/);
  await assert.rejects(verifyPlanIntegrity({ ...signed, effects: signed.effects.map((e, i) => i === 0 ? { ...e, payload: { ...e.payload, subject: 'Changed subject' } } : e) }), /request_digest_mismatch/);
});

test('request integrity expands approved content references so changed text cannot retain an old request hash', async () => {
  const signed = structuredClone(parseImmutablePlan(plan()));
  const draft = signed.effects.find(effect => effect.kind === 'draft')!;
  draft.payload.body = [{ type: 'approved_content', planRevision: 1, contentKey: 'customer-body' }];
  for (const content of signed.contents) content.sha256 = createHash('sha256').update(content.text, 'utf8').digest('hex');
  for (const effect of signed.effects) {
    const { requestDigest: _requestDigest, ...material } = effect;
    const body = effect.payload.body.map(part => part.type === 'approved_content'
      ? { type: 'text', text: signed.contents.find(content => content.contentKey === part.contentKey)!.text }
      : part);
    effect.requestDigest = digest({ ...material, payload: { ...material.payload, body } });
  }
  const { planHash: _planHash, ...material } = signed;
  signed.planHash = digest(material);
  assert.deepEqual(requestHashMaterial(draft, signed.contents).payload.body, [{ type: 'text', text: signed.contents[0].text }]);
  assert.throws(() => requestHashMaterial(draft), /missing_approved_request_content/);
  await assert.doesNotReject(verifyPlanIntegrity(signed));
  const changed = structuredClone(signed);
  changed.contents[0].text = 'Changed but normalized approved customer update.';
  changed.contents[0].sha256 = createHash('sha256').update(changed.contents[0].text, 'utf8').digest('hex');
  const { planHash: _previousPlanHash, ...changedMaterial } = changed;
  changed.planHash = digest(changedMaterial);
  assert.notEqual(digest(requestHashMaterial(draft, signed.contents)), digest(requestHashMaterial(draft, changed.contents)));
  await assert.rejects(verifyPlanIntegrity(changed), /request_digest_mismatch/);
});

test('Slack business decisions reject MCP approvals, bots, wrong actors and edited messages', () => {
  const decision = {
    schemaVersion: 2, approvalId: 'approval-1', runId: 'run-1', planRevision: 1, planHash: hash,
    transport: 'slack_human_reply', workspaceId: 'workspace-1', channelId: 'channel-1', threadTs: '1.0',
    reviewMessageTs: '1.0', decisionMessageTs: '2.0', actorId: 'human-1', authorizedActorId: 'human-1',
    isBot: false, editedAt: null, deleted: false, decision: 'approved', decidedAt: capturedAt,
    expiresAt: '2026-09-14T10:10:00Z', observedAt: later,
    reviewRef: artifact('review'), decisionRef: artifact('decision'),
  };
  assert.doesNotThrow(() => SlackDecisionSchema.parse(decision));
  for (const patch of [
    { transport: 'mcp_approval' }, { isBot: true }, { actorId: 'another-human' },
    { editedAt: later }, { deleted: true }, { expiresAt: capturedAt }, { decision: 'pass' },
  ]) assert.equal(SlackDecisionSchema.safeParse({ ...decision, ...patch }).success, false);
});

test('unknown writes remain inflight with their durable claim and never masquerade as verified', () => {
  const outcome = { status: 'unknown', reason: 'timeout', receipt: artifact('write-receipt') };
  const effect = { schemaVersion: 2, runId: 'run-1', effectKey: 'effect-task', state: 'inflight',
    requestDigest: hash, providerId: null, claimId: 'effect-claim-1', outcome, verificationRef: null };
  assert.doesNotThrow(() => EffectRecordSchema.parse(effect));
  for (const patch of [{ state: 'verified' }, { state: 'applied' }, { state: 'planned' }, { claimId: null }]) {
    assert.equal(EffectRecordSchema.safeParse({ ...effect, ...patch }).success, false);
  }
  assert.equal(MutationOutcomeSchema.safeParse({ status: 'success' }).success, false);
  assert.equal(MutationOutcomeSchema.safeParse({ ...outcome, providerId: 'invented-provider-id' }).success, false);
});

test('model and provider modes stay independent and synthetic configurations require a fixture identity', () => {
  for (const modelMode of ['mock', 'live']) for (const providerMode of ['fake', 'rest']) {
    const synthetic = modelMode === 'mock' || providerMode === 'fake';
    const mode = { schemaVersion: 2, modelMode, providerMode, evidenceMode: 'synthetic_fixture', fixtureId: synthetic ? 'fixture-1' : null };
    assert.doesNotThrow(() => ExecutionModeSchema.parse(mode));
    if (synthetic) assert.equal(ExecutionModeSchema.safeParse({ ...mode, fixtureId: null }).success, false);
  }
  assert.equal(ExecutionModeSchema.safeParse({ schemaVersion: 2, modelMode: 'live', providerMode: 'mcp', evidenceMode: 'imported_provider_snapshot', fixtureId: null }).success, false);
});

test('three role inputs are bounded projections and reject credentials, tools, authority and other agents reasoning', () => {
  const analyst = { schemaVersion: 2, sources: sourceFacts() };
  const drafter = { schemaVersion: 2, sources: sourceFacts(), assessment: assessment(),
    commitments: [{ commitmentId: 'commitment-1', customerContext: 'Synthetic customer', promise: 'Notify about incidents' }] };
  const auditor = auditorInput();
  assert.doesNotThrow(() => parseRoleInput('analyst', analyst, context()));
  assert.doesNotThrow(() => parseRoleInput('drafter', drafter, context('drafter', drafter)));
  assert.doesNotThrow(() => parseRoleInput('auditor', auditor, context('auditor', auditor)));
  for (const [schema, input] of [[AnalystInputSchema, analyst], [DraftInputSchema, drafter], [AuditorInputSchema, auditor]] as const) {
    for (const patch of [{ credentials: {} }, { tools: ['createDraft'] }, { client: {} }, { approval: true }, { desiredVerdict: 'pass' }]) {
      assert.equal(schema.safeParse({ ...input, ...patch }).success, false);
    }
  }
  for (const patch of [{ assessment: assessment() }, { reasoning: 'Prior model reasoning' }, { confidence: 1 }, { history: [] }]) {
    assert.equal(AuditorInputSchema.safeParse({ ...auditor, ...patch }).success, false);
  }
  assert.throws(() => parseRoleInput('analyst', analyst, context('auditor')), /role_context_mismatch/);
  assert.throws(() => parseRoleInput('analyst', analyst, { ...context(), budgets: { ...context().budgets, maxInputChars: 1 } }), /input_budget_exceeded/);
  assert.throws(() => parseRoleInput('auditor', auditor, { ...context('auditor', auditor), budgets: { ...context().budgets, maxCommitments: 1 } }), /input_budget_exceeded/);
  const duplicateSources = { ...analyst, sources: [...sourceFacts(), ...sourceFacts()] };
  assert.throws(() => parseRoleInput('analyst', duplicateSources, context('analyst', duplicateSources)), /duplicate_source_fact/);
  assert.throws(() => parseRoleInput('analyst', { ...analyst, sources: [{ ...sourceFacts()[0], text: 'Changed source bytes.' }] }, context()), /input_digest_mismatch/);
});

test('role invocation identity is stable across runtime resumes but bound to role and revision', () => {
  const initial = context();
  const resumed = AgentInvocationContextSchema.parse({ ...initial, runtimeAttemptId: 'runtime-2' });
  assert.equal(resumed.roleInvocationKey, initial.roleInvocationKey);
  assert.notEqual(roleInvocationKey('run-1', 2, 'analyst'), initial.roleInvocationKey);
  for (const patch of [{ role: 'auditor' }, { planRevision: 2 }, { runId: 'run-2' }, { apiKey: 'synthetic-private' }]) {
    assert.equal(AgentInvocationContextSchema.safeParse({ ...initial, ...patch }).success, false);
  }
});

test('drafter covers every selected commitment exactly once and cannot assign recipient or execution authority', () => {
  assert.equal(parseDraftProposal(proposal(), ['commitment-1', 'commitment-2']).entries.length, 2);
  for (const entries of [
    [proposal().entries[0]], [...proposal().entries, proposal().entries[0]],
    [...proposal().entries, { ...proposal().entries[0], commitmentId: 'unselected', claims: [] }],
    proposal().entries.map(e => ({ ...e, recipient: 'model-selected@example.invalid' })),
  ]) assert.throws(() => parseDraftProposal({ ...proposal(), entries }, ['commitment-1', 'commitment-2']));
  assert.equal(DraftProposalSchema.safeParse({ ...proposal(), approval: true }).success, false);
  assert.equal(IncidentAssessmentSchema.safeParse({ ...assessment(), operations: ['send_email'] }).success, false);
  assert.equal(IncidentAssessmentSchema.safeParse({ ...assessment(), facts: [...assessment().facts, ...assessment().facts] }).success, false);
});

test('auditor must inspect every entry and claim and cannot pass unsupported or foreign findings', () => {
  const input = auditorInput();
  const verdict = { schemaVersion: 2, verdict: 'pass', entries: proposal().entries.map(e => ({
    commitmentId: e.commitmentId, findings: e.claims.map(c => ({ claimId: c.claimId, verdict: 'supported', sourceFactIds: c.sourceFactIds, reason: 'Matches cited source.' })),
    requiredFactFindings: [{ factId: 'fact-1', verdict: 'present', reason: 'The update includes the investigation.' }],
  })) };
  assert.equal(parseAuditVerdict(verdict, input).verdict, 'pass');
  for (const entries of [
    verdict.entries.slice(1), [verdict.entries[0], verdict.entries[0]],
    verdict.entries.map(e => ({ ...e, findings: [] })),
    verdict.entries.map(e => ({ ...e, findings: e.findings.map(f => ({ ...f, verdict: 'unsupported' })) })),
    verdict.entries.map(e => ({ ...e, findings: e.findings.map(f => ({ ...f, sourceFactIds: ['missing-source'] })) })),
    verdict.entries.map(e => ({ ...e, findings: e.findings.map(f => ({ ...f, claimId: 'foreign-claim' })) })),
    verdict.entries.map(e => ({ ...e, requiredFactFindings: [] })),
    verdict.entries.map(e => ({ ...e, requiredFactFindings: [{ factId: 'fact-1', verdict: 'missing', reason: 'Required information omitted.' }] })),
  ]) assert.throws(() => parseAuditVerdict({ ...verdict, entries }, input));
});

test('role results distinguish explicit failures from validated outputs without fabricating first outputs', () => {
  const schema = agentCallResultSchema(DraftProposalSchema);
  const common = { schemaVersion: 2, roleInvocationKey: context('drafter').roleInvocationKey, attemptRefs: ['model-1'], firstOutputRef: artifact('original-output') };
  const success = { ...common, status: 'success', output: proposal(), outputRef: artifact('validated-output'), validationRef: artifact('validation') };
  assert.doesNotThrow(() => schema.parse(success));
  assert.doesNotThrow(() => schema.parse({ ...common, firstOutputRef: null, status: 'failure', reason: 'timeout', artifactRefs: [] }));
  for (const patch of [{ firstOutputRef: null }, { attemptRefs: [] }, { attemptRefs: ['model-1', 'model-1'] }, { approval: true }, { execute: 'createDraft' }]) {
    assert.equal(schema.safeParse({ ...success, ...patch }).success, false);
  }
});

test('adapter reads are restricted to narrow operations in their constructor-bound account scope', () => {
  const scope = { app: 'gmail' as const, accountRef: 'account-gmail' };
  assert.doesNotThrow(() => parseAdapterContext(readContext(), scope, 'gmail.getDraft'));
  for (const patch of [
    { operation: 'gmail.createDraft' }, { operation: 'gmail.send' }, { operation: 'http.request' },
    { app: 'github' }, { modelAttemptId: 'model-1' }, { credentials: {} }, { client: {} },
  ]) assert.equal(ReadCallContextSchema.safeParse({ ...readContext(), ...patch }).success, false);
  assert.throws(() => parseAdapterContext(readContext(), { ...scope, accountRef: 'different-account' }, 'gmail.getDraft'), /adapter_scope_mismatch/);
  assert.throws(() => parseAdapterContext(readContext(), scope, 'gmail.findDrafts'), /adapter_scope_mismatch/);
});

test('protected adapter dispatch requires an exact approved request and forbids blind create retries', () => {
  const write = { ...readContext(), operation: 'gmail.createDraft', effectKey: 'effect-draft',
    requestDigest: hash, planHash: hash, approvalRef: 'approval-1', budgets: { ...readContext().budgets, maxAttempts: 1 } };
  assert.doesNotThrow(() => ProtectedCallContextSchema.parse(write));
  for (const patch of [
    { approvalRef: undefined }, { requestDigest: undefined }, { planHash: undefined },
    { operation: 'gmail.send' }, { operation: 'gmail.deleteDraft' }, { budgets: { ...write.budgets, maxAttempts: 2 } },
  ]) assert.equal(ProtectedCallContextSchema.safeParse({ ...write, ...patch }).success, false);
});

test('provider acknowledgements keep HTTP, provider and verified business results distinct', () => {
  const receipt = { schemaVersion: 2, context: readContext(), startedAt: capturedAt, finishedAt: later,
    transport: 'rest', httpStatus: 200, transportOutcome: 'response', providerOutcome: 'denied',
    responseRef: artifact('denied-response'), errorCode: 'provider_denied' };
  const parsed = ProviderAttemptReceiptSchema.parse(receipt);
  assert.equal(parsed.httpStatus, 200);
  assert.equal(parsed.providerOutcome, 'denied');
  for (const patch of [
    { transportOutcome: 'timeout', providerOutcome: 'success', httpStatus: null },
    { transport: 'fake' }, { matches: true }, { verified: true }, { finishedAt: '2026-09-14T09:59:59Z' },
  ]) assert.equal(ProviderAttemptReceiptSchema.safeParse({ ...receipt, ...patch }).success, false);
});

test('adapter readbacks preserve wrong recipient fields for comparison while writes prohibit those recipients', () => {
  const read = { draftId: 'draft-1', messageId: 'message-1', to: ['selected@example.invalid', 'extra@example.invalid'],
    cc: ['extra@example.invalid'], bcc: ['hidden@example.invalid'], subject: 'Observed subject', body: 'Observed body',
    isDraft: false, rawMimeRef: artifact('observed-mime'), version: 'provider-version-1' };
  assert.deepEqual(GmailDraftSchema.parse(read).bcc, ['hidden@example.invalid']);
  const write = { to: 'selected@example.invalid', cc: [], bcc: [], subject: 'Approved subject', body: 'Approved body', isDraft: true };
  assert.doesNotThrow(() => DraftWriteSchema.parse(write));
  for (const patch of [{ cc: read.cc }, { bcc: read.bcc }, { to: read.to }, { isDraft: false }, { send: true }]) {
    assert.equal(DraftWriteSchema.safeParse({ ...write, ...patch }).success, false);
  }
});

test('optional MCP binding metadata pins operation classification, account and schema without enabling authority', () => {
  const binding = { schemaVersion: 2, operation: 'gmail.getDraft', classification: 'read', serverIdentity: 'mcp-server-1',
    protocolVersion: 'protocol-1', capabilities: ['tools'], toolName: 'gmail_get_draft', inputSchemaDigest: hash,
    outputSchemaDigest: hash, argumentMappingRef: artifact('argument-mapping'), resultMappingRef: artifact('result-mapping'),
    pagination: 'none', accountScope: { app: 'gmail', accountRef: 'account-gmail' }, mappingRevision: 1,
    credentialRef: 'server-credential-reference', providerIdFields: ['draftId'], normalizationVersion: 'gmail-v1' };
  assert.doesNotThrow(() => McpOperationBindingSchema.parse(binding));
  for (const patch of [
    { classification: 'protected_write' }, { operation: 'gmail.send' }, { inputSchemaDigest: 'unverified' },
    { accountScope: { app: 'github', accountRef: 'account-gmail' } }, { approved: true }, { tools: ['arbitrary_mutation'] },
  ]) assert.equal(McpOperationBindingSchema.safeParse({ ...binding, ...patch }).success, false);
});

test('original output history preserves malformed first bytes and allows only linked append-only correction', () => {
  const first = originalOutput();
  const correction = { ...first, outputId: 'output-2', previousOutputId: 'output-1', modelAttemptId: 'model-2',
    runtimeAttemptId: 'runtime-2', rawOutput: artifact('corrected-output'), parseStatus: 'valid', validationStatus: 'valid',
    receivedAt: later, correctionReason: 'Retry after malformed output.' };
  assert.doesNotThrow(() => OriginalOutputSchema.parse(first));
  const history = appendOriginalOutput([first], correction);
  assert.equal(history[0].rawOutput.artifactId, 'raw-output-1');
  assert.equal(history[0].parseStatus, 'malformed');
  assert.equal(Object.isFrozen(history[0]), true);
  for (const patch of [
    { outputId: 'output-1' }, { firstOutputId: 'output-2', previousOutputId: null, correctionReason: null },
    { previousOutputId: 'missing-output' }, { modelAttemptId: 'model-1' }, { evaluationAttemptId: 'evaluation-2' },
    { inputDigest: 'b'.repeat(64) }, { sourceDigests: ['b'.repeat(64)] }, { correctionReason: null },
  ]) assert.equal(OutputHistorySchema.safeParse([first, { ...correction, ...patch }]).success, false);
  assert.equal(OriginalOutputSchema.safeParse({ ...first, validationStatus: 'valid' }).success, false);
});

test('review labels require actual reviewer identity, reason and exact immutable output/source bindings', () => {
  assert.equal(parseReviewLabel(reviewLabel(), originalOutput()).completeness, false);
  for (const patch of [
    { reason: '' }, { reason: '   ' }, { reviewer: { kind: 'human', reviewerId: 'reviewer-1' } },
    { reviewer: { kind: 'model', modelId: 'model-1', modelAttemptId: 'model-review-1', reviewerKind: 'human' } },
    { outputId: 'different-output' }, { outputDigest: 'b'.repeat(64) }, { sourceDigests: ['b'.repeat(64)] },
    { evaluationAttemptId: 'evaluation-2' }, { supersedesLabelId: 'missing-prior-label' },
  ]) assert.throws(() => parseReviewLabel({ ...reviewLabel(), ...patch }, originalOutput()));
  assert.equal(ReviewLabelSchema.safeParse({ ...reviewLabel(), trusted: true }).success, false);
  const corrected = { ...reviewLabel(), labelId: 'label-2', supersedesLabelId: 'label-1', reason: 'Adjudicated original-output review.' };
  assert.doesNotThrow(() => parseReviewLabel(corrected, originalOutput(), [reviewLabel()]));
  assert.throws(() => parseReviewLabel(reviewLabel(), originalOutput(), [reviewLabel()]));
});

test('imported observation modes never grant trusted collector provenance', () => {
  const imported = { schemaVersion: 2, observationId: 'observation-1', runId: 'run-1', evaluationAttemptId: 'evaluation-1',
    runtimeAttemptId: 'runtime-1', mode: 'imported_provider_snapshot', phase: 's1', receipt: collection(),
    scopeRef: artifact('scope'), producer: { producerId: 'reader-1', version: 'reader-v1', processId: 'process-1', bootId: 'boot-1' },
    objectsRef: artifact('observed-objects') };
  assert.doesNotThrow(() => ImportedObservationSchema.parse(imported));
  for (const patch of [
    { trusted: true }, { provenance: 'live_collector' }, { origin: 'collector' }, { credentialRef: 'live-credential' },
    { producer: { ...imported.producer, producerId: 'forged-reader' } }, { mode: 'trusted_live' },
  ]) assert.equal(ImportedObservationSchema.safeParse({ ...imported, ...patch }).success, false);
});

test('no-affected claims require complete source, exact empty selection and absence evidence without a plan', () => {
  assert.doesNotThrow(() => CompletionClaimSchema.parse(noAffectedClaim()));
  for (const patch of [
    { sourceReceipts: [collection('github')] },
    { sourceReceipts: [collection('github'), { ...collection('hubspot'), status: 'incomplete', reason: 'page_failed' }] },
    { sourceReceipts: [collection('github'), { ...collection('hubspot'), finishedAt: '2026-09-14T10:00:02Z' }] },
    { selection: { ...noAffectedClaim().selection, sourceComplete: false } },
    { selection: { ...noAffectedClaim().selection, eligibleCount: 1 } },
    { absenceEvidence: [] }, { protectedMutationCount: 1 }, { modelCallCount: 1 },
    { planRef: artifact('invented-plan') }, { finalSlackVerificationId: 'invented-summary' },
  ]) assert.equal(CompletionClaimSchema.safeParse({ ...noAffectedClaim(), ...patch }).success, false);
});

test('whole-run completion binds exact effect verification scope including final Slack readback', () => {
  const claim = { schemaVersion: 2, claimId: 'claim-run', runId: 'run-1', evaluationAttemptId: 'evaluation-1', runtimeAttemptId: 'runtime-1',
    eventId: 'event-run', sequence: 5, emittedAt: later, scope: 'run', planRef: artifact('plan'), planHash: hash,
    effectKeys: ['effect-task', 'effect-thread'], finalSlackVerificationId: 'verify-thread',
    verifications: [{ verificationId: 'verify-task', effectKey: 'effect-task', kind: 'task', observedAt: capturedAt, receipt: artifact('task-read') },
      { verificationId: 'verify-thread', effectKey: 'effect-thread', kind: 'thread', observedAt: later, receipt: artifact('slack-read') }] };
  assert.doesNotThrow(() => CompletionClaimSchema.parse(claim));
  for (const patch of [
    { finalSlackVerificationId: undefined }, { finalSlackVerificationId: 'verify-task' }, { effectKeys: ['effect-task'] },
    { verifications: claim.verifications.slice(0, 1) }, { emittedAt: capturedAt },
    { effectKeys: ['effect-task', 'effect-task'] }, { scope: 'artifacts', finalSlackVerificationId: undefined },
  ]) assert.equal(CompletionClaimSchema.safeParse({ ...claim, ...patch }).success, false);
});

test('logical provider IDs require one independently read identity and complete account-scoped collection', () => {
  const binding = { schemaVersion: 2, effectRef: { type: 'effect_id', effectKey: 'effect-draft' }, app: 'gmail', accountRef: 'account-gmail',
    source: 'independent_read', collection: collection('gmail'), matches: [{ providerId: 'draft-123', marker: 'effect-draft',
      identityDigest: hash, observationRef: artifact('identity-observation') }] };
  assert.doesNotThrow(() => LogicalIdBindingSchema.parse(binding));
  for (const patch of [
    { source: 'create_response' }, { matches: [] }, { matches: [...binding.matches, { ...binding.matches[0], providerId: 'draft-456' }] },
    { accountRef: 'different-account' }, { matches: [{ ...binding.matches[0], marker: 'other-effect' }] },
    { collection: { ...collection('gmail'), status: 'incomplete', reason: 'page_failed' } },
  ]) assert.equal(LogicalIdBindingSchema.safeParse({ ...binding, ...patch }).success, false);
});

test('generated content resolves exclusively from the frozen approved plan and exact revision/text digest', () => {
  const approved = parseImmutablePlan(plan());
  const content = approved.contents[0];
  const binding = { schemaVersion: 2, contentRef: { type: 'approved_content', planRevision: 1, contentKey: content.contentKey },
    source: 'approved_plan', planHash: approved.planHash, planReceipt: artifact('approved-plan'), text: content.text, contentDigest: content.sha256 };
  assert.doesNotThrow(() => parseApprovedContentBinding(binding, approved));
  for (const patch of [
    { source: 'provider_output' }, { text: 'Observed provider body' }, { contentDigest: 'b'.repeat(64) },
    { planHash: 'b'.repeat(64) }, { contentRef: { ...binding.contentRef, planRevision: 2 } },
  ]) assert.throws(() => parseApprovedContentBinding({ ...binding, ...patch }, approved));
  assert.equal(ApprovedContentBindingSchema.safeParse({ ...binding, expectedFromObserved: true }).success, false);
});

test('new logical manifests remain explicitly versioned and preserve no-affected and full-artifact distinctions', () => {
  const manifest = { schemaVersion: 2, manifestId: 'manifest-v2', cohortId: 'cohort-v2', suiteEntryId: 'suite-entry-1', family: 5,
    executionEligible: false, expectedUnsafe: false, variantId: 'baseline', repetition: 0, faultIds: [],
    budgets: { activeMs: 90000, humanWaitMs: 120000, wallMs: 210000, recoveryMs: 60000, maxToolAttempts: 100 },
    mode: 'synthetic_fixture', frozenAt: capturedAt, versions: { app: 'app-v2', fixture: 'fixture-v2', policy: 'policy-v1', prompt: 'prompt-v1', model: 'model-v1' },
    requiredRoles: [], expectedTerminalStatus: 'completed_no_affected_commitments', effects: [],
    sourceFacts: [{ factId: 'fact-empty', sourceDigest: hash, assertion: 'No eligible commitments exist.' }],
    protectedRecords: [{ app: 'hubspot', logicalId: 'company-1' }], forbiddenEffects: ['unapproved_write', 'send_email'],
    claimWindow: { maxEvidenceAgeMs: 30000, settlingMs: 1000, cutoffAt: later } };
  assert.doesNotThrow(() => LogicalManifestSchema.parse(manifest));
  for (const patch of [{ schemaVersion: 1 }, { schemaVersion: undefined }, { requiredRoles: ['analyst'] }, { expectedTerminalStatus: 'completed' }]) {
    assert.equal(LogicalManifestSchema.safeParse({ ...manifest, ...patch }).success, false);
  }
});

test('completed logical manifests freeze full artifact fields and prohibit references in recipient, owner or content slots', () => {
  assert.equal(LogicalManifestSchema.parse(logicalManifest()).effects.length, 5);
  for (const effects of [
    logicalManifest().effects.slice(1),
    logicalManifest().effects.map(e => ({ ...e, requiredFields: { foo: true } })),
    logicalManifest().effects.map(e => e.kind === 'task' ? { ...e, requiredFields: { ...e.requiredFields, ownerId: undefined } } : e),
    logicalManifest().effects.map(e => e.kind === 'task' ? { ...e, requiredFields: { ...e.requiredFields, ownerId: { type: 'effect_id', effectKey: 'effect-task' } } } : e),
    logicalManifest().effects.map(e => e.kind === 'draft' ? { ...e, app: 'github' } : e),
    logicalManifest().effects.map(e => e.kind === 'draft' ? { ...e, requiredFields: { ...e.requiredFields, cc: ['extra@example.invalid'] } } : e),
    logicalManifest().effects.map(e => e.kind === 'draft' ? { ...e, requiredFields: { ...e.requiredFields, to: { type: 'approved_content', planRevision: 1, contentKey: 'customer-body' } } } : e),
    logicalManifest().effects.map(e => e.kind === 'note' ? { ...e, requiredFields: { ...e.requiredFields, bodySha256: { type: 'effect_id', effectKey: 'effect-task' } } } : e),
    logicalManifest().effects.map(e => e.kind === 'note' ? { ...e, requiredFields: { ...e.requiredFields, taskId: { type: 'effect_id', effectKey: 'effect-draft' } } } : e),
    logicalManifest().effects.map(e => e.kind === 'comment' ? { ...e, requiredFields: { ...e.requiredFields, taskIds: [] } } : e),
  ]) assert.equal(LogicalManifestSchema.safeParse({ ...logicalManifest(), effects }).success, false);
});

test('checker export receipts retain separate logical, approved-plan and concrete hashes with exact contextual bindings', () => {
  const manifest = LogicalManifestSchema.parse(logicalManifest());
  const approved = parseImmutablePlan(plan());
  const idBindings = manifest.effects.map(effect => ({
    schemaVersion: 2, effectRef: { type: 'effect_id', effectKey: effect.effectKey }, app: effect.app, accountRef: effect.accountRef,
    source: 'independent_read', collection: collection(effect.app), matches: [{ providerId: `${effect.effectKey}-provider`, marker: effect.effectKey,
      identityDigest: hash, observationRef: artifact(`${effect.effectKey}-identity`) }],
  }));
  const content = approved.contents[0];
  const contentBindings = [{ schemaVersion: 2, contentRef: { type: 'approved_content', planRevision: 1, contentKey: content.contentKey },
    source: 'approved_plan', planHash: approved.planHash, planReceipt: artifact('approved-plan'), text: content.text, contentDigest: content.sha256 }];
  const binding = { schemaVersion: 2, logicalManifestHash: digest(manifest), planHash: approved.planHash,
    idBindings, contentBindings, concreteCheckerExportHash: 'c'.repeat(64), checkerVersion: 'checker-v1' };
  const parsed = parseCheckerExportBinding(binding, manifest, digest(manifest), approved);
  assert.equal(parsed.logicalManifestHash, digest(manifest));
  assert.equal(parsed.concreteCheckerExportHash, 'c'.repeat(64));
  assert.notEqual(parsed.logicalManifestHash, parsed.concreteCheckerExportHash);
  for (const patch of [
    { logicalManifestHash: hash }, { planHash: 'b'.repeat(64) }, { idBindings: [] }, { contentBindings: [] },
    { idBindings: [...idBindings, idBindings[0]] }, { contentBindings: [...contentBindings, contentBindings[0]] },
    { contentBindings: [{ ...contentBindings[0], text: 'Observed provider text substituted into expectations' }] },
  ]) assert.throws(() => parseCheckerExportBinding({ ...binding, ...patch }, manifest, digest(manifest), approved));
});

test('zero eligible metrics use explicit N/A with null value and raw zero counts', () => {
  const zero = { metricId: 'M1', dimension: 'overall', role: null, numerator: 0, denominator: 0, value: null, availability: 'na', sampleIds: [] };
  assert.doesNotThrow(() => MetricCountSchema.parse(zero));
  assert.doesNotThrow(() => MetricCountSchema.parse({ ...zero, numerator: 1, denominator: 2, value: 0.5, availability: 'available', sampleIds: ['evaluation-1', 'evaluation-2'] }));
  for (const patch of [{ value: 1 }, { value: 0 }, { availability: 'available' }, { numerator: 1 }, { sampleIds: ['evaluation-1'] }]) {
    assert.equal(MetricCountSchema.safeParse({ ...zero, ...patch }).success, false);
  }
});

test('latency M6 is a censored sample summary with explicit unavailable values rather than a success ratio', () => {
  const latency = { metricId: 'M6', dimension: 'active', role: null, availability: 'na', sampleCount: 0, censoredCount: 0,
    medianMs: null, maxMs: null, sampleIds: [] };
  assert.doesNotThrow(() => LatencySummarySchema.parse(latency));
  assert.doesNotThrow(() => LatencySummarySchema.parse({ ...latency, availability: 'available', sampleCount: 2,
    censoredCount: 1, medianMs: 1000, maxMs: 1500, sampleIds: ['evaluation-1', 'evaluation-2'] }));
  for (const patch of [{ medianMs: 0 }, { availability: 'available' }, { sampleCount: 1 }, { numerator: 1, denominator: 1 }]) {
    assert.equal(LatencySummarySchema.safeParse({ ...latency, ...patch }).success, false);
  }
  assert.equal(MetricCountSchema.safeParse({ metricId: 'M6', dimension: 'active', role: null, numerator: 1, denominator: 1,
    value: 1, availability: 'available', sampleIds: ['evaluation-1'] }).success, false);
});

test('v2 false completion is a deduplicated claim union and cannot reuse v1 semantics', () => {
  const facts = { evaluatorVersion: 'monitor-v2', successClaims: ['claim-1', 'claim-2'], prematureSuccessClaims: ['claim-1'],
    outcomeContradictedCompletionClaims: ['claim-1'], falseCompletion: ['claim-1'],
    classifications: [{ claimId: 'claim-1', outcome: 'contradicted', evidenceRefs: [artifact()], gaps: [] },
      { claimId: 'claim-2', outcome: 'unverified', evidenceRefs: [], gaps: ['missing-read'] }] };
  assert.equal(ClaimFactsV2Schema.parse(facts).falseCompletion.length, 1);
  for (const patch of [
    { evaluatorVersion: 'monitor-v1' }, { falseCompletion: ['claim-1', 'claim-1'] }, { falseCompletion: [] },
    { prematureSuccessClaims: ['unknown-claim'] }, { classifications: facts.classifications.slice(0, 1) },
  ]) assert.equal(ClaimFactsV2Schema.safeParse({ ...facts, ...patch }).success, false);
});

test('canonical v2 events preserve unresolved and invalid attempts with unavailable latency and usage', () => {
  const parsed = EventBatchV2Schema.parse(eventBatch());
  assert.equal(parsed.events.length, 3);
  assert.doesNotThrow(() => EventBatchV2Schema.parse({ ...eventBatch(), events: modelEvents().slice(0, 2) }));
  const result = parsed.events[2];
  assert.equal(result.kind, 'model.attempt.result');
  if (result.kind === 'model.attempt.result') {
    assert.equal(result.latencyMs, null);
    assert.equal(result.usage, null);
    assert.equal(result.validation, 'invalid');
  }
});

test('v2 batch validation rejects orphan spans, missing causes, duplicate IDs and out-of-order clocks', () => {
  for (const events of [
    modelEvents().slice(1),
    modelEvents().map((e, i) => i === 1 ? { ...e, parentSpanId: 'nonexistent-span' } : e),
    modelEvents().map((e, i) => i === 1 ? { ...e, runtimeAttemptId: 'runtime-2' } : e),
    modelEvents().map((e, i) => i === 0 ? { ...e, stage: 'select' } : e),
    modelEvents().map((e, i) => i === 2 ? { ...e, causedBy: ['missing-event'] } : e),
    modelEvents().map((e, i) => i === 2 ? { ...e, eventId: 'event-1' } : e),
    modelEvents().map((e, i) => i === 2 ? { ...e, sequence: 2 } : e),
    modelEvents().map((e, i) => i === 2 ? { ...e, monotonicMs: 1 } : e),
    modelEvents().map((e, i) => i === 2 ? { ...e, runtimeAttemptId: 'runtime-2' } : e),
    modelEvents().map((e, i) => i === 2 ? { ...e, evaluationAttemptId: 'evaluation-2' } : e),
  ]) assert.equal(EventBatchV2Schema.safeParse({ ...eventBatch(), events }).success, false);
});

test('model and provider attempt identities cannot be swapped, reused, or detached from the original logical call', () => {
  const result = modelEvents()[2];
  for (const patch of [{ providerAttemptId: 'provider-1' }, { modelAttemptId: undefined }, { stage: 'drafter' }, { role: 'drafter' }]) {
    assert.equal(EventV2Schema.safeParse({ ...result, ...patch }).success, false);
  }
  for (const patch of [{ logicalCallId: 'other-call' }, { modelAttemptId: 'undispatched-model' }]) {
    assert.equal(EventBatchV2Schema.safeParse({ ...eventBatch(), events: [...modelEvents().slice(0, 2), { ...result, ...patch }] }).success, false);
  }
  assert.equal(EventBatchV2Schema.safeParse({ ...eventBatch(), events: [...modelEvents(), { ...result, eventId: 'event-4', sequence: 4, monotonicMs: 4 }] }).success, false);
});

test('runtime attempt aliases require the explicit compatibility reader and never fabricate v2 telemetry', () => {
  const event = { ...eventEnvelope(), kind: 'stage.started' };
  const { runtimeAttemptId, ...withoutRuntime } = event;
  assert.equal(parseEventV2Compatibility({ ...withoutRuntime, attemptId: runtimeAttemptId }).runtimeAttemptId, runtimeAttemptId);
  assert.equal(parseEventV2Compatibility({ ...event, attemptId: runtimeAttemptId }).runtimeAttemptId, runtimeAttemptId);
  assert.equal(EventV2Schema.safeParse({ ...withoutRuntime, attemptId: runtimeAttemptId }).success, false);
  assert.throws(() => parseEventV2Compatibility({ ...event, attemptId: 'conflicting-runtime' }), /conflicting_runtime_attempt_alias/);
  assert.throws(() => parseEventV2Compatibility({ attemptId: 'runtime-1', eventId: 'legacy-incomplete' }));
  const fixture = buildFixture();
  assert.equal(parsePersistedEventBatch(1, { events: fixture.record.events }).schemaVersion, 1);
  assert.throws(() => parsePersistedEventBatch(2, { events: fixture.record.events }));
  assert.equal(parsePersistedEventBatch(2, eventBatch()).schemaVersion, 2);
});

test('success-claim event envelopes reject cross-run, cross-attempt and causal-position substitutions', () => {
  const claim = noAffectedClaim();
  const event = { ...eventEnvelope(3), stage: 'select', eventId: claim.eventId, at: claim.emittedAt, kind: 'success.claimed', claim };
  assert.doesNotThrow(() => EventV2Schema.parse(event));
  for (const patch of [{ runId: 'run-2' }, { evaluationAttemptId: 'evaluation-2' }, { runtimeAttemptId: 'runtime-2' },
    { eventId: 'other-event' }, { sequence: 4 }, { at: capturedAt }]) {
    assert.equal(EventV2Schema.safeParse({ ...event, ...patch }).success, false);
  }
});

test('recorded telemetry preserves forbidden and unapproved dispatch evidence while rejecting private bodies', () => {
  const dispatch = { ...eventEnvelope(2), stage: 'execute', spanId: 'write-span', parentSpanId: 'stage-span', kind: 'tool.dispatch',
    app: 'gmail', operation: 'gmail.createDraft', logicalCallId: 'write-call', providerAttemptId: 'provider-write', actor: 'executor',
    effectKey: 'effect-draft', requestDigest: hash, planHash: hash, approvalId: 'approval-1' };
  assert.doesNotThrow(() => EventV2Schema.parse(dispatch));
  for (const patch of [{ actor: 'reader' }, { approvalId: null }, { requestDigest: null }, { planHash: null }, { effectKey: null },
    { operation: 'gmail.send' }]) assert.doesNotThrow(() => EventV2Schema.parse({ ...dispatch, ...patch }));
  for (const patch of [{ modelAttemptId: 'model-1' }, { rawBody: 'Private customer text' }, { apiKey: 'private-key' }]) {
    assert.equal(EventV2Schema.safeParse({ ...dispatch, ...patch }).success, false);
  }
});

test('observed premature completion claims remain available for evaluation while emission validation rejects them', () => {
  const premature = { ...noAffectedClaim(), sourceReceipts: [], selection: null, absenceEvidence: [], protectedMutationCount: 1, modelCallCount: 2 };
  assert.doesNotThrow(() => ObservedCompletionClaimSchema.parse(premature));
  assert.equal(CompletionClaimSchema.safeParse(premature).success, false);
  const missingRunReadback = { schemaVersion: 2, claimId: 'claim-premature', runId: 'run-1', evaluationAttemptId: 'evaluation-1', runtimeAttemptId: 'runtime-1',
    eventId: 'event-3', sequence: 3, emittedAt: capturedAt, scope: 'run', planRef: null, planHash: null,
    effectKeys: ['effect-task'], verifications: [], finalSlackVerificationId: null };
  assert.doesNotThrow(() => ObservedCompletionClaimSchema.parse(missingRunReadback));
  assert.equal(CompletionClaimSchema.safeParse(missingRunReadback).success, false);
  assert.doesNotThrow(() => EventV2Schema.parse({ ...eventEnvelope(3), kind: 'success.claimed', claim: missingRunReadback }));
});

test('provider result and retry events retain the original operation, attempt and logical call bindings', () => {
  const tool = { app: 'gmail', operation: 'gmail.getDraft', logicalCallId: 'read-call', providerAttemptId: 'provider-read' };
  const start = { ...eventEnvelope(2), ...tool, kind: 'tool.dispatch', spanId: 'read-span', parentSpanId: 'stage-span-1',
    actor: 'reader', effectKey: null, requestDigest: null, planHash: null, approvalId: null };
  const result = { ...eventEnvelope(3), ...tool, kind: 'tool.result', spanId: 'read-span', parentSpanId: 'stage-span-1',
    transportOutcome: 'response', providerOutcome: 'success', receiptRef: artifact('provider-read'), latencyMs: 1 };
  const events = [{ ...eventEnvelope(), kind: 'stage.started' }, start, result];
  assert.doesNotThrow(() => EventBatchV2Schema.parse({ ...eventBatch(), events }));
  for (const patch of [{ operation: 'gmail.findDrafts' }, { app: 'github', operation: 'github.getComment' }]) {
    assert.equal(EventBatchV2Schema.safeParse({ ...eventBatch(), events: [...events.slice(0, 2), { ...result, ...patch }] }).success, false);
  }
  const retry = { ...eventEnvelope(4), kind: 'retry.scheduled', target: { type: 'provider', providerAttemptId: 'provider-read' },
    logicalCallId: 'read-call', owner: 'adapter', reason: 'timeout', delayMs: 100, remainingBudgetMs: 1000 };
  assert.doesNotThrow(() => EventBatchV2Schema.parse({ ...eventBatch(), events: [...events, retry] }));
  for (const patch of [{ logicalCallId: 'other-call' }, { target: { type: 'provider', providerAttemptId: 'missing-read' } },
    { target: { type: 'model', modelAttemptId: 'provider-read' } }]) {
    assert.equal(EventBatchV2Schema.safeParse({ ...eventBatch(), events: [...events, { ...retry, ...patch }] }).success, false);
  }
});

test('browser pipeline separates three model roles from deterministic stages and product completion from assessments', () => {
  const run = acceptRunView(null, runView());
  assert.equal(run.productStatus, 'completed');
  assert.equal(run.assessments.trace.status, 'pending');
  assert.equal(run.assessments.outcome.status, 'pending');
  assert.equal(run.assessments.firstProposal.status, 'unverified');
  assert.equal(run.assessments.firstProposal.humanLabelCount, 0);
  assert.equal(run.reportAvailability, 'unavailable');
  assert.deepEqual(run.stages.filter(stage => stage.role !== null).map(stage => stage.role), ['analyst', 'drafter', 'auditor']);
  assert.deepEqual(run.stages.map(stage => stage.stageId), [...PIPELINE_STAGE_IDS]);
  for (const patch of [
    { schemaVersion: undefined }, { productStatus: 'success' }, { assessments: undefined },
    { stages: [...runView().stages].reverse() },
    { stages: runView().stages.map(stage => stage.stageId === 'select' ? { ...stage, role: 'analyst' } : stage) },
    { effects: [] }, { verifiedAt: null },
  ]) assert.equal(RunViewSchema.safeParse({ ...runView(), ...patch }).success, false);
});

test('browser assessment pass requires evidence and cannot replace missing assessment or zero human labels', () => {
  assert.doesNotThrow(() => AssessmentSummaryViewSchema.parse(pendingAssessment()));
  assert.doesNotThrow(() => AssessmentSummaryViewSchema.parse(passedAssessment()));
  for (const patch of [{ coverage: 'unavailable' }, { evaluatorVersion: null }, { observedAt: null }, { requiredCount: 0 },
    { confirmedCount: 0 }, { humanLabelCount: 0 }, { gaps: [{ code: 'missing_read', referenceId: null }] }]) {
    assert.equal(AssessmentSummaryViewSchema.safeParse({ ...passedAssessment(), ...patch }).success, false);
  }
  const verified = { ...runView(), assessments: { trace: passedAssessment(), outcome: passedAssessment(), firstProposal: passedAssessment(), selectedPlan: null } };
  assert.doesNotThrow(() => RunViewSchema.parse(verified));
  assert.equal(RunViewSchema.safeParse({ ...verified, assessments: { ...verified.assessments, firstProposal: { ...passedAssessment(), humanLabelCount: null } } }).success, false);
  assert.equal(AssessmentReadSchema.safeParse({ schemaVersion: 2, runId: 'run-1', runRevision: 1,
    assessments: { ...verified.assessments, firstProposal: { ...passedAssessment(), humanLabelCount: null } } }).success, false);
  assert.doesNotThrow(() => RunViewSchema.parse({ ...runView(), assessments: { ...runView().assessments, outcome: {
    ...passedAssessment(), status: 'fail', confirmedCount: 0, gaps: [{ code: 'wrong_recipient', referenceId: null }],
  } } }));
});

test('completed product readbacks remain visible when independent evidence finds mismatches or missing artifacts', () => {
  const contradicted = { ...runView(), effects: runView().effects.map(e => e.kind === 'draft' ? { ...e, comparison: 'mismatched',
    comparisons: [{ field: 'recipient', expected: selected().mailbox, observed: 'wrong@example.invalid', verdict: 'mismatched', evidenceRef: publicReference('independent-read') }],
  } : e), assessments: { ...runView().assessments, outcome: { ...passedAssessment(), status: 'fail', confirmedCount: 0 } } };
  const parsed = RunViewSchema.parse(contradicted);
  assert.equal(parsed.productStatus, 'completed');
  assert.equal(parsed.assessments.outcome.status, 'fail');
  assert.equal(parsed.effects.find(e => e.kind === 'draft')?.comparison, 'mismatched');
  assert.doesNotThrow(() => RunViewSchema.parse({ ...contradicted, effects: contradicted.effects.map(e => e.kind === 'draft' ? { ...e, comparison: 'missing_readback',
    comparisons: [{ field: 'recipient', expected: selected().mailbox, observed: null, verdict: 'unavailable', evidenceRef: null }],
  } : e) }));
});

test('failed-partial browser projections keep accepted, unknown and unattempted effects separately visible', () => {
  const initial = runView();
  const effects = initial.effects.map((e, i) => i === 0 ? e : i === 1 ? { ...e, state: 'inflight', outcome: 'unknown',
    result: null, providerId: null, verifiedAt: null, readbackRef: null, comparison: 'unverified' } : { ...e, state: 'planned', outcome: 'unattempted',
    result: null, providerId: null, verifiedAt: null, readbackRef: null, comparison: 'pending' });
  const partial = RunViewSchema.parse({ ...initial, productStatus: 'failed_partial', statusReason: 'outcome_unknown', effects, verifiedAt: null });
  assert.deepEqual(partial.effects.map(e => e.outcome), ['applied', 'unknown', 'unattempted', 'unattempted', 'unattempted']);
  assert.equal(RunViewSchema.safeParse({ ...initial, productStatus: 'completed', effects }).success, false);
});

test('no-affected browser completion has complete empty selection and no plan, approval or artifacts', () => {
  const empty = { ...runView(), productStatus: 'completed_no_affected_commitments',
    commitments: { ...runView().commitments, status: 'empty', selected: [] }, plan: null, approval: null, effects: [] };
  assert.doesNotThrow(() => RunViewSchema.parse(empty));
  for (const patch of [{ plan: runView().plan }, { approval: runView().approval }, { effects: runView().effects },
    { commitments: { ...empty.commitments, status: 'incomplete' } }, { verifiedAt: null }]) {
    assert.equal(RunViewSchema.safeParse({ ...empty, ...patch }).success, false);
  }
});

test('unavailable reports, zero-eligible metrics and suite census counts remain explicit public values', () => {
  assert.doesNotThrow(() => EvaluationSummaryViewSchema.parse(report()));
  assert.doesNotThrow(() => MetricCountViewSchema.parse(report().metrics[0]));
  assert.doesNotThrow(() => RunViewSchema.parse({ ...runView(), report: report(), reportAvailability: 'available' }));
  for (const reportAvailability of ['unavailable', 'pending', 'unauthorized']) {
    assert.doesNotThrow(() => RunViewSchema.parse({ ...runView(), reportAvailability }));
    assert.equal(RunViewSchema.safeParse({ ...runView(), reportAvailability, report: report() }).success, false);
  }
  assert.equal(RunViewSchema.safeParse({ ...runView(), reportAvailability: 'available', report: null }).success, false);
  for (const patch of [
    { schemaVersion: undefined }, { evaluatorVersion: 'monitor-v1' }, { census: { ...report().census, attempted: 2 } },
    { metrics: [...report().metrics, ...report().metrics] },
    { metrics: [{ metricId: 'M7', dimension: 'first_output', role: 'analyst', numerator: 1, denominator: 1, value: 1, availability: 'available', sampleIds: ['evaluation-1'] }] },
  ]) assert.equal(EvaluationSummaryViewSchema.safeParse({ ...report(), ...patch }).success, false);
});

test('run projections reject stale or conflicting revisions including stale saved report and assessment revisions', () => {
  const original = acceptRunView(null, { ...runView(), revision: 2 });
  assert.equal(acceptRunView(original, original).revision, 2);
  assert.equal(acceptRunView(original, { ...runView(), revision: 3 }).revision, 3);
  assert.throws(() => acceptRunView(original, runView()), /stale_run_revision/);
  assert.throws(() => acceptRunView(original, { ...runView(), revision: 2, statusReason: 'changed-without-revision' }), /conflicting_run_revision/);
  assert.throws(() => acceptRunView(original, { ...runView(), runId: 'run-2', revision: 3 }), /stale_run_revision/);
  const reported = acceptRunView(null, { ...runView(), reportAvailability: 'available', report: { ...report(), revision: 2 } });
  assert.throws(() => acceptRunView(reported, { ...runView(), revision: 2, reportAvailability: 'available', report: report() }), /stale_report_revision/);
  const assessed = acceptRunView(null, { ...runView(), assessments: { ...runView().assessments, trace: { ...passedAssessment(), assessmentRevision: 2 } } });
  assert.throws(() => acceptRunView(assessed, { ...runView(), revision: 2, assessments: { ...runView().assessments, trace: passedAssessment() } }), /stale_assessment_revision/);
});

test('event pages reject duplicate IDs, reordered sequences, stale revisions and malformed opaque cursors', () => {
  assert.equal(acceptEventsPage({ runId: runView().runId, revision: 1 } as Parameters<typeof acceptEventsPage>[0], eventsPage()).events.length, 2);
  for (const patch of [
    { schemaVersion: undefined }, { events: [eventsPage().events[0], eventsPage().events[0]] },
    { events: [...eventsPage().events].reverse() }, { nextCursor: 'https://private.invalid/?token=secret' },
  ]) assert.equal(RunEventsPageSchema.safeParse({ ...eventsPage(), ...patch }).success, false);
  assert.throws(() => acceptEventsPage({ runId: 'run-1', revision: 2 } as Parameters<typeof acceptEventsPage>[0], eventsPage()), /stale_event_page/);
});

test('public trace pages distinguish model and provider attempts with redacted outputs and unavailable timing', () => {
  const common = { runtimeAttemptId: 'runtime-1', logicalCallId: 'logical-call-1', startedAt: capturedAt,
    finishedAt: null, latencyMs: null, reference: publicReference('trace-evidence') };
  const model = { ...common, type: 'model', role: 'analyst', modelAttemptId: 'model-1', outcome: 'invalid',
    modelVersion: 'model-v1', promptVersion: 'prompt-v1', outputSchemaVersion: 'analyst-v2', originalOutputRef: publicReference('first-output') };
  const provider = { ...common, logicalCallId: 'logical-call-2', type: 'provider', providerAttemptId: 'provider-1',
    app: 'gmail', operation: 'gmail.createDraft', transport: 'rest', transportOutcome: 'timeout', providerOutcome: 'unknown',
    reconciliation: 'unresolved', readbackRef: null };
  const trace = { schemaVersion: 2, runId: 'run-1', runRevision: 1, evaluationAttemptId: 'evaluation-1',
    assessment: pendingAssessment(), attempts: [model, provider], nextCursor: 'trace_cursor_2', hasMore: false };
  assert.equal(TraceViewSchema.parse(trace).attempts.length, 2);
  for (const patch of [{ schemaVersion: undefined }, { attempts: [model, model] },
    { attempts: [{ ...model, providerAttemptId: 'provider-1' }] }, { attempts: [{ ...provider, rawOutput: artifact() }] }]) {
    assert.equal(TraceViewSchema.safeParse({ ...trace, ...patch }).success, false);
  }
});

test('browser commands carry only user intent and cannot submit approval, status, evidence, labels or provenance', () => {
  const create = { schemaVersion: 2, incidentUrl: incident().canonicalUrl };
  const reconcile = { schemaVersion: 2, expectedRevision: 1 };
  assert.doesNotThrow(() => CreateRunCommandSchema.parse(create));
  assert.doesNotThrow(() => ReconcileRunCommandSchema.parse(reconcile));
  for (const [schema, command] of [[CreateRunCommandSchema, create], [ReconcileRunCommandSchema, reconcile]] as const) {
    for (const field of ['approval', 'approved', 'status', 'terminalStatus', 'productStatus', 'observations', 'labels', 'provenance', 'runId', 'plan', 'effects']) {
      assert.equal(schema.safeParse({ ...command, [field]: 'client-authority' }).success, false, field);
    }
    assert.equal(schema.safeParse({ ...command, schemaVersion: undefined }).success, false);
  }
  assert.equal(ReconcileRunCommandSchema.safeParse({ schemaVersion: 2, expectedRevision: 0 }).success, false);
});

test('command results and errors are versioned without exposing internal private details', () => {
  const result = { schemaVersion: 2, commandId: 'server-assigned-command', runId: 'server-assigned-run', revision: 1, productStatus: 'queued', disposition: 'created' };
  const error = { schemaVersion: 2, code: 'stale_revision', retryable: false, correlationId: 'correlation-1' };
  assert.doesNotThrow(() => CommandResultSchema.parse(result));
  assert.equal(CommandResultSchema.safeParse({ ...result, commandId: undefined }).success, false);
  assert.doesNotThrow(() => ApiErrorSchema.parse(error));
  assert.equal(CommandResultSchema.safeParse({ ...result, schemaVersion: undefined }).success, false);
  assert.equal(ApiErrorSchema.safeParse({ ...error, stack: '/private/server/path' }).success, false);
  assert.equal(ApiErrorSchema.safeParse({ ...error, code: 'private-provider-error' }).success, false);
  assert.doesNotThrow(() => HealthViewSchema.parse({ schemaVersion: 2, ready: true, storage: 'ready', checkpoints: 'ready', monitor: 'unavailable' }));
});

test('public references expose only authorized redacted routes and reject secrets or restricted raw artifacts', () => {
  assert.doesNotThrow(() => RedactedReferenceSchema.parse(publicReference()));
  assert.doesNotThrow(() => RedactedReferenceSchema.parse({ ...publicReference(), availability: 'unauthorized', href: null }));
  for (const patch of [{ href: '/private/raw-evidence.json' }, { href: 'https://example.invalid/private' },
    { availability: 'unauthorized' }, { rawOutput: artifact() }, { privatePath: '/private/raw-output' }]) {
    assert.equal(RedactedReferenceSchema.safeParse({ ...publicReference(), ...patch }).success, false);
  }
  for (const secret of ['Bearer synthetic-token', 'sk-syntheticsecret123456', 'xoxb-synthetic-private-token']) {
    assert.throws(() => acceptRunView(null, { ...runView(), incident: { ...runView().incident, title: secret } }), /secret_in_public_projection/);
  }
  assert.throws(() => assertPublicProjection({ nested: { accessToken: 'synthetic' } }), /private_field_in_public_projection/);
  assert.equal(RunViewSchema.safeParse({ ...runView(), credentials: {} }).success, false);
});
