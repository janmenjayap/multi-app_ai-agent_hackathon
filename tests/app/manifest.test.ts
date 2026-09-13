import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  assertFrozenManifest, bindApprovedPlan, createScenarioManifest, freezeManifest, loadFixtureSuite,
  loadFixtureSuiteFrom, resolveManifestExport, scenarioWorld, validateNoAffectedEvidence,
} from '../../src/server/evaluations/manifest.js';
import { digest } from '../../src/shared/reliability.js';
import { LogicalIdBindingSchema, LogicalManifestSchema } from '../../src/shared/evaluation.js';
import { canonical, ImmutablePlanSchema, planHashMaterial, requestHashMaterial, sha256Text } from '../../src/shared/domain.js';
import { CoordinationCallContextSchema, ProtectedCallContextSchema, ReadCallContextSchema } from '../../src/shared/adapters.js';
import type { ProtectedCallContext, ReadCallContext } from '../../src/shared/adapters.js';
import { AgentInvocationContextSchema, AnalystInputSchema, AuditVerdictSchema, AuditorInputSchema,
  DraftInputSchema, DraftProposalSchema, IncidentAssessmentSchema, roleInvocationKey } from '../../src/shared/agents.js';
import { createFakeProviders } from '../fakes/providers.js';
import { createFakeModel, FAKE_MODEL_CONFIGURATION } from '../fakes/model.js';
import { createFaultController, FaultController } from '../fixtures/faults.js';

// Q01 tests execute synthetic contracts and isolated fakes, not the workflow census.
const suitePromise = loadFixtureSuite();

test('synthetic census freezes all 18 baselines and 42 baseline/repetition targets without registering attempts', async () => {
  const suite = await suitePromise;
  const baseline = suite.scenarios.entries.filter(entry => entry.leg === 'baseline');
  const cohort = suite.scenarios.entries.filter(entry => entry.leg === 'baseline' || entry.leg === 'repetition');
  assert.equal(baseline.length, 18);
  assert.deepEqual(baseline.map(entry => entry.family).sort((a, b) => a - b), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.equal(cohort.length, 42);
  for (const family of [1, 3, 5, 6, 9, 12]) assert.equal(cohort.filter(entry => entry.family === family).length, 5);
  assert.ok(suite.scenarios.entries.some(entry => entry.leg === 'variant'));
  assert.ok(suite.scenarios.entries.some(entry => entry.leg === 'repair'));
  assert.equal(suite.scenarios.handoff.actualWorkflowAttempts, 0);
  assert.equal(suite.scenarios.configuration.evidenceMode, 'synthetic_fixture');
  assert.equal(suite.scenarios.configuration.modelMode, 'mock');
  for (const entry of suite.scenarios.entries) {
    const frozen = createScenarioManifest(suite, entry.suiteEntryId);
    assert.ok(LogicalManifestSchema.safeParse(frozen.manifest).success, entry.suiteEntryId);
    assertFrozenManifest(frozen);
  }
});

test('synthetic fixture loading rejects omitted cohort slots and caller-generated human review provenance', async () => {
  const suite = await suitePromise;
  const omitted = structuredClone(suite);
  omitted.scenarios.entries.splice(0, 1);
  assert.throws(() => loadFixtureSuiteFrom(omitted));
  assert.throws(() => loadFixtureSuiteFrom({ ...suite, sourceLabels: { ...suite.sourceLabels,
    provenance: { ...suite.sourceLabels.provenance, actualHumanReview: true } } }));
  const changedSources = structuredClone(suite);
  changedSources.world.hubspot.commitments[0].ownerId = 'owner_202';
  assert.throws(() => loadFixtureSuiteFrom(changedSources));
});

test('synthetic source oracle is independently frozen and never prelabels nonexistent model outputs', async () => {
  const suite = await suitePromise;
  assert.equal(suite.sourceLabels.provenance.reviewer.kind, 'fixture');
  assert.equal(suite.sourceLabels.provenance.actualHumanReview, false);
  assert.equal(suite.sourceLabels.provenance.humanReviewStatus, 'pending');
  assert.deepEqual(suite.sourceLabels.reviewLabels, []);
  assert.deepEqual(suite.sourceLabels.sourceSnapshots.map(snapshot => snapshot.sourceDigest), [digest(suite.world.github), digest(suite.world.hubspot)]);
  assert.ok(Object.isFrozen(suite.sourceLabels.sourceFacts));
  assert.ok(Object.isFrozen(suite.scenarios.entries));
  assert.throws(() => { suite.sourceLabels.sourceFacts.pop(); });
  assert.throws(() => { suite.scenarios.entries.pop(); });
});

test('golden logical manifest requires all five artifacts and detects altered expected fields', async () => {
  const suite = await suitePromise;
  const golden = createScenarioManifest(suite, 'pg-f01-baseline');
  assert.deepEqual(golden.manifest.effects.map(effect => effect.kind), ['task', 'note', 'draft', 'comment', 'thread']);
  const missingDraft = structuredClone(golden.manifest);
  missingDraft.effects = missingDraft.effects.filter(effect => effect.kind !== 'draft');
  assert.throws(() => freezeManifest(missingDraft));
  const missingOwner = structuredClone(golden.manifest);
  delete missingOwner.effects[0].requiredFields.ownerId;
  assert.throws(() => freezeManifest(missingOwner));
  const changed = structuredClone(golden);
  changed.manifest.effects[0].requiredFields.ownerId = 'owner_202';
  assert.throws(() => assertFrozenManifest(changed));
  assert.equal(golden.manifest.effects[0].requiredFields.ownerId, 'owner_101');
  for (const effect of golden.manifest.effects.filter(effect => effect.kind !== 'task')) {
    assert.equal((effect.requiredFields.bodySha256 as { type: string }).type, 'approved_content');
  }
});

test('no-affected manifest proves an empty source selection without a plan, model roles or Slack artifacts', async () => {
  const suite = await suitePromise;
  const fixture = scenarioWorld(suite, 'pg-f02-baseline');
  assert.ok(fixture.hubspot.commitments.every(commitment => commitment.service === 'analytics-api'));
  const frozen = createScenarioManifest(suite, 'pg-f02-baseline');
  assert.equal(frozen.manifest.expectedTerminalStatus, 'completed_no_affected_commitments');
  assert.deepEqual(frozen.manifest.effects, []);
  assert.deepEqual(frozen.manifest.requiredRoles, []);
  assert.ok(frozen.manifest.sourceFacts.some(fact => /zero commitments|zero eligible/i.test(fact.assertion)));
  assert.ok(!frozen.manifest.sourceFacts.some(fact => fact.factId === 'acme_billing_commitment'));
  assert.ok(frozen.manifest.protectedRecords.some(record => record.logicalId === 'promise_102'));
});

test('separately frozen source correction changes expected owner without modifying baseline world or oracle', async () => {
  const suite = await suitePromise;
  const corrected = scenarioWorld(suite, 'pg-f06-owner_correction');
  assert.equal(corrected.hubspot.commitments[0].ownerId, 'owner_202');
  assert.equal(suite.world.hubspot.commitments[0].ownerId, 'owner_101');
  const baseline = createScenarioManifest(suite, 'pg-f01-baseline');
  const correction = createScenarioManifest(suite, 'pg-f06-owner_correction');
  assert.equal(baseline.manifest.effects[0].requiredFields.ownerId, 'owner_101');
  assert.equal(correction.manifest.effects[0].requiredFields.ownerId, 'owner_202');
  assert.notEqual(baseline.manifestHash, correction.manifestHash);
  assert.ok(!correction.manifest.sourceFacts.some(fact => fact.factId === 'acme_owner'));
});

const providerContext = (operation: string) => ({
  schemaVersion: 2, runId: 'fixture_run', evaluationAttemptId: 'fixture_evaluation', runtimeAttemptId: 'fixture_runtime',
  spanId: 'fixture_span', app: operation.split('.')[0], accountRef: `${operation.split('.')[0]}_test`,
  mode: 'fake', logicalCallId: operation, providerAttemptId: `attempt_${operation}`,
  deadlineAt: '2026-09-13T17:38:30Z', operation,
  budgets: { timeoutMs: 1000, totalMs: 3000, maxAttempts: 1, maxPages: 100, maxRecords: 100, maxResponseBytes: 100000 },
});
function readContext<T extends ReadCallContext['operation']>(operation: T): ReadCallContext & { operation: T } {
  return { ...ReadCallContextSchema.parse(providerContext(operation)), operation };
}
function writeContext<T extends ProtectedCallContext['operation']>(operation: T): ProtectedCallContext & { operation: T } {
  return { ...ProtectedCallContextSchema.parse({ ...providerContext(operation), effectKey: 'fixture_draft',
    requestDigest: digest('synthetic_request'), planHash: digest('synthetic_approved_plan'), approvalRef: 'fixture_approval' }), operation };
}
const draftInput = () => ({ to: 'avery@acme.example.test', cc: [], bcc: [],
  subject: 'PromiseGuard fixture_draft', body: 'Synthetic draft awaiting human review.', isDraft: true as const });
const modelContext = (role: 'analyst' | 'drafter' | 'auditor', input: unknown) => AgentInvocationContextSchema.parse({
  schemaVersion: 2, runId: 'fixture_run', evaluationAttemptId: 'fixture_evaluation', runtimeAttemptId: 'fixture_runtime',
  planRevision: 1, role, roleInvocationKey: roleInvocationKey('fixture_run', 1, role),
  snapshotBundleRef: { artifactId: 'fixture_sources', sha256: digest(input), byteLength: Buffer.byteLength(canonical(input)), mediaType: 'application/json' },
  inputDigest: digest(input), promptVersion: 'promiseguard-roles-v1', outputSchemaVersion: 'role-v2',
  modelConfigRef: FAKE_MODEL_CONFIGURATION.modelConfigRef, configDigest: FAKE_MODEL_CONFIGURATION.configDigest,
  budgets: FAKE_MODEL_CONFIGURATION.budgets, spanId: `${role}_model_span`, parentSpanId: `${role}_stage`, deadlineAt: '2026-09-13T17:38:30Z',
});

test('fake write acknowledgement cannot manufacture matching observed recipient fields', async () => {
  const suite = await suitePromise;
  const providers = createFakeProviders({ namespace: 'wrong_fields', ownerId: 'fixture_operator', world: suite.world,
    faults: createFaultController('incorrect_result') });
  const result = await providers.adapters.gmail.createDraft(draftInput(), writeContext('gmail.createDraft'));
  assert.equal(result.status, 'applied');
  if (result.status !== 'applied') assert.fail('draft write did not acknowledge success');
  const acknowledgement = JSON.parse(providers.operator.readArtifact(result.receipt.artifactId)!);
  assert.deepEqual(acknowledgement.acknowledged.to, ['avery@acme.example.test']);
  const observed = await providers.readers.gmail.getDraft(result.providerId, readContext('gmail.getDraft'));
  assert.equal(observed.status, 'complete');
  if (observed.status !== 'complete') assert.fail('draft read was incomplete');
  assert.deepEqual(observed.data?.to, ['wrong@acme.example.test']);
  assert.deepEqual(draftInput().to, 'avery@acme.example.test');
});

test('fake accepted unknown writes and duplicate creations remain independently discoverable by marker', async () => {
  const suite = await suitePromise;
  for (const kind of ['accepted_unknown_write', 'duplicate_creation'] as const) {
    const providers = createFakeProviders({ namespace: kind, ownerId: 'fixture_operator', world: suite.world,
      faults: new FaultController([{ faultId: kind, target: 'provider', operation: 'gmail.createDraft', phase: 'write', kind }]) });
    const result = await providers.adapters.gmail.createDraft(draftInput(), writeContext('gmail.createDraft'));
    assert.equal(result.status, kind === 'accepted_unknown_write' ? 'unknown' : 'applied');
    const found = await providers.readers.gmail.findDrafts('fixture_draft', readContext('gmail.findDrafts'));
    assert.equal(found.status, 'complete');
    if (found.status !== 'complete') assert.fail('marker collection incomplete');
    assert.equal(found.data.length, kind === 'accepted_unknown_write' ? 1 : 2);
    assert.equal(providers.operator.history().filter(event => event.action === 'create' && event.app === 'gmail').length, found.data.length);
  }
});

test('fake pagination and missing scope preserve incomplete evidence instead of empty success', async () => {
  const suite = await suitePromise;
  const providers = createFakeProviders({ namespace: 'incomplete_reads', ownerId: 'fixture_operator', world: suite.world,
    faults: createFaultController('incomplete_source_retrieval'), pageSize: 1, missingScopes: ['gmail.listDrafts'] });
  const result = await providers.readers.hubspot.readCommitmentBundle('billing-api', readContext('hubspot.readCommitmentBundle'));
  assert.equal(result.status, 'incomplete');
  if (result.status !== 'incomplete') assert.fail('second page should fail');
  assert.equal(result.reason, 'page_failed');
  assert.equal(result.receipt.pages.length, 1);
  assert.notEqual(result.receipt.pages[0].nextCursor, null);
  assert.equal(result.partialData?.commitments.length, 1);
  const denied = await providers.readers.gmail.listDrafts(readContext('gmail.listDrafts'));
  assert.equal(denied.status, 'incomplete');
  if (denied.status !== 'incomplete') assert.fail('missing scope should fail');
  assert.equal(denied.reason, 'denied');
});

test('a denied fake write remains denied until an explicit operator permission repair in the same state', async () => {
  const suite = await suitePromise;
  const identity = { namespace: 'permission_repair', ownerId: 'fixture_operator' };
  const providers = createFakeProviders({ ...identity, world: suite.world, faults: createFaultController('permission_denial'), declaredEdits: [{
    editId: 'restore_gmail', stage: 'repair', actorId: 'fixture_operator', observedAt: '2026-09-13T17:35:01Z',
    target: 'scope', recordId: 'gmail.createDraft', fields: { isAvailable: true },
  }] });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await providers.adapters.gmail.createDraft(draftInput(), writeContext('gmail.createDraft'));
    assert.equal(result.status, 'not_applied');
    if (result.status !== 'not_applied') assert.fail('permission denial must not create a draft');
    assert.equal(result.reason, 'denied');
  }
  assert.equal(providers.operator.snapshot().gmail.drafts.length, 0);
  providers.operator.applyDeclaredEdit('restore_gmail', 'repair', identity);
  const repaired = await providers.adapters.gmail.createDraft(draftInput(), writeContext('gmail.createDraft'));
  assert.equal(repaired.status, 'applied');
  assert.equal(providers.operator.snapshot().gmail.drafts.length, 1);
  assert.ok(providers.operator.history().some(event => event.action === 'repair' && event.actorId === 'fixture_operator'));
});

test('fake phantom Slack success stays absent and reader handles expose no mutation or cleanup methods', async () => {
  const suite = await suitePromise;
  const providers = createFakeProviders({ namespace: 'phantom_slack', ownerId: 'fixture_operator', world: suite.world,
    faults: createFaultController('phantom_slack_success') });
  const operation = 'slack.postSummary' as const;
  const context = { ...CoordinationCallContextSchema.parse({ ...providerContext(operation), marker: 'fixture_summary', requestDigest: digest('summary') }), operation };
  const result = await providers.adapters.slack.postSummary({ channelId: suite.world.slack.channelId, threadTs: 'fixture_thread', body: 'Synthetic summary.' }, context);
  assert.equal(result.status, 'applied');
  if (result.status !== 'applied') assert.fail('summary did not acknowledge success');
  const observed = await providers.readers.slack.readSummary(suite.world.slack.channelId, result.providerId, readContext('slack.readSummary'));
  assert.equal(observed.status, 'complete');
  if (observed.status !== 'complete') assert.fail('Slack lookup incomplete');
  assert.equal(observed.data, null);
  assert.ok(!('createDraft' in providers.readers.gmail));
  assert.ok(!('reset' in providers.adapters.gmail));
  assert.ok(!('operator' in providers.readers));
});

test('fake operator source edits are predeclared and actor-tagged while scoped reset preserves history', async () => {
  const suite = await suitePromise;
  const identity = { namespace: 'operator_scope', ownerId: 'fixture_operator' };
  const providers = createFakeProviders({ ...identity, world: suite.world, declaredEdits: [{
    editId: 'owner_drift', stage: 'source_edit', actorId: 'fixture_human', observedAt: '2026-09-13T17:35:01Z',
    target: 'commitment', recordId: 'promise_101', fields: { ownerId: 'owner_202' },
  }] });
  assert.throws(() => providers.operator.reset({ ...identity, ownerId: 'other_operator' }));
  assert.throws(() => providers.operator.applyDeclaredEdit('undeclared', 'source_edit', identity));
  providers.operator.applyDeclaredEdit('owner_drift', 'source_edit', identity);
  assert.equal(providers.operator.snapshot().hubspot.commitments[0].ownerId, 'owner_202');
  const edit = providers.operator.history().find(event => event.action === 'source_edit');
  assert.equal(edit?.actorId, 'fixture_human');
  assert.equal(edit?.observedAt, '2026-09-13T17:35:01Z');
  assert.throws(() => providers.operator.applyDeclaredEdit('owner_drift', 'source_edit', identity));
  providers.operator.reset(identity);
  assert.equal(providers.operator.snapshot().hubspot.commitments[0].ownerId, 'owner_101');
  assert.ok(providers.operator.history().some(event => event.action === 'source_edit'));
  assert.ok(providers.operator.history().some(event => event.action === 'reset' && event.stage === 'setup'));
});

test('named faults replay deterministically and malformed fake model attempts preserve original outputs', async () => {
  const suite = await suitePromise;
  const controller = createFaultController('invalid_model_output');
  const point = { target: 'model', operation: 'analyst', phase: 'invoke' } as const;
  controller.take(point); controller.take(point);
  const replay = controller.replay();
  replay.take(point); replay.take(point);
  replay.assertReplay(controller.trace());
  const model = createFakeModel({ faults: createFaultController('invalid_model_output') });
  const input = AnalystInputSchema.parse({ schemaVersion: 2, sources: suite.sourceLabels.sourceFacts.map(fact => ({
    factId: fact.factId, sourceRef: { artifactId: `source_${fact.factId}`, sha256: fact.sourceDigest, byteLength: 100, mediaType: 'application/json' },
    sourceField: fact.factId, text: fact.assertion,
  })) });
  const result = await model.invokeRole(input, modelContext('analyst', input), IncidentAssessmentSchema);
  assert.equal(result.status, 'failure');
  if (result.status !== 'failure') assert.fail('malformed model output must fail');
  assert.equal(result.reason, 'output_invalid');
  assert.equal(result.attemptRefs.length, 2);
  assert.ok(result.firstOutputRef);
  const originals = model.artifacts().filter(artifact => artifact.kind === 'output');
  assert.equal(originals.length, 2);
  assert.equal(originals[0].ref.artifactId, result.firstOutputRef.artifactId);
  assert.equal(originals[0].content, '{invalid JSON');
  assert.equal(model.evidenceMode, 'synthetic_fixture');
});

test('default synthetic model script consumes analyst, drafter and auditor with the frozen source facts', async () => {
  const suite = await suitePromise;
  const sources = suite.sourceLabels.sourceFacts.map(fact => ({ factId: fact.factId, text: fact.assertion, sourceField: fact.factId,
    sourceRef: { artifactId: `source_${fact.factId}`, sha256: fact.sourceDigest, byteLength: 100, mediaType: 'application/json' } }));
  const model = createFakeModel();
  const input = AnalystInputSchema.parse({ schemaVersion: 2, sources });
  const analysis = await model.invokeRole(input, modelContext('analyst', input), IncidentAssessmentSchema);
  if (analysis.status !== 'success') assert.fail(`analyst script failed: ${analysis.reason}`);
  const drafting = DraftInputSchema.parse({ schemaVersion: 2, sources, assessment: analysis.output,
    commitments: [{ commitmentId: 'promise_101', customerContext: 'Acme billing migration due September 16, 2026.', promise: 'billing migration' }] });
  const draft = await model.invokeRole(drafting, modelContext('drafter', drafting), DraftProposalSchema);
  if (draft.status !== 'success') assert.fail(`drafter script failed: ${draft.reason}`);
  const auditing = AuditorInputSchema.parse({ schemaVersion: 2, sources, proposal: draft.output, taskContract: {
    selectedCommitmentIds: ['promise_101'], requiredFacts: ['incident_billing_impact', 'cause_and_recovery_unknown', 'acme_billing_commitment'],
    forbiddenClaims: suite.sourceLabels.forbiddenClaims.map(claim => claim.assertion),
  } });
  const audit = await model.invokeRole(auditing, modelContext('auditor', auditing), AuditVerdictSchema);
  if (audit.status !== 'success') assert.fail(`auditor script failed: ${audit.reason}`);
  assert.equal(audit.output.verdict, 'pass');
  model.assertConsumed();
  assert.deepEqual(model.history().map(call => call.role), ['analyst', 'drafter', 'auditor']);
  assert.ok(model.artifacts().every(record => record.evidenceMode === 'synthetic_fixture'));
});

const artifact = (artifactId: string, value: unknown) => ({
  artifactId, sha256: digest(value), byteLength: Buffer.byteLength(canonical(value)), mediaType: 'application/json' as const,
});
const collectionOperation = { github: 'github.readTechnicalEvidence', hubspot: 'hubspot.readCommitmentBundle', gmail: 'gmail.findDrafts', slack: 'slack.findReview' };
const collection = (app: 'github' | 'hubspot' | 'gmail' | 'slack') => ({
  schemaVersion: 2, collectionId: `fixture_collection_${app}`, app, accountRef: `${app}_test`, producerId: 'fixture_independent_reader',
  startedAt: '2026-09-13T17:35:00Z', finishedAt: '2026-09-13T17:35:01Z', status: 'complete', reason: null,
  requiredQueryIds: [collectionOperation[app]], pages: [{ queryId: collectionOperation[app], cursor: null, nextCursor: null,
    recordCount: 1, response: artifact(`fixture_page_${app}`, { app }), providerAttemptId: `fixture_read_${app}` }],
});

test('no-affected evidence requires complete sources, independently asserted absence and zero protected writes', async () => {
  const suite = await suitePromise;
  const frozen = createScenarioManifest(suite, 'pg-f02-baseline');
  const world = scenarioWorld(suite, 'pg-f02-baseline');
  const selection = { schemaVersion: 2, policyVersion: suite.scenarios.versions.policy, evaluatedAt: world.clockAt,
    sourceBundleRef: artifact('fixture_no_affected_sources', { github: world.github, hubspot: world.hubspot }), sourceComplete: true,
    selected: [], excluded: world.hubspot.commitments.map(commitment => ({ commitmentId: commitment.id, reason: 'service_mismatch' })) };
  const claim = { schemaVersion: 2, claimId: 'fixture_no_affected', runId: 'fixture_run', evaluationAttemptId: 'fixture_evaluation',
    runtimeAttemptId: 'fixture_runtime', eventId: 'fixture_completion', sequence: 1, emittedAt: '2026-09-13T17:35:02Z', scope: 'no_affected',
    sourceReceipts: [collection('github'), collection('hubspot')],
    selection: { eligibleCount: 0, sourceComplete: true, policyVersion: suite.scenarios.versions.policy, receipt: artifact('fixture_selection', selection) },
    absenceEvidence: ['no_protected_writes', 'protected_company_beta', 'protected_promise_102', 'protected_ticket_102'].map(predicateId =>
      ({ predicateId, status: 'confirmed', receipt: artifact(`fixture_${predicateId}`, []) })),
    protectedMutationCount: 0, modelCallCount: 0,
  };
  assert.equal(validateNoAffectedEvidence(frozen, claim, selection).scope, 'no_affected');
  assert.throws(() => validateNoAffectedEvidence(frozen, { ...claim, absenceEvidence: [] }, selection));
  assert.throws(() => validateNoAffectedEvidence(frozen, { ...claim, protectedMutationCount: 1 }, selection));
  assert.throws(() => validateNoAffectedEvidence(frozen, { ...claim, modelCallCount: 1 }, selection));
  assert.throws(() => validateNoAffectedEvidence(frozen, { ...claim, sourceReceipts: [collection('github'),
    { ...collection('hubspot'), status: 'incomplete', reason: 'page_failed' }] }, selection));
  assert.throws(() => validateNoAffectedEvidence(frozen, { ...claim, emittedAt: '2026-09-13T17:36:00Z' }, selection));
  assert.throws(() => validateNoAffectedEvidence(frozen, claim, { ...selection, sourceBundleRef: artifact('wrong_source_world', suite.world) }));
});

// This separate post-generation test plan exercises exact byte binding; its text never enters the pre-run source oracle.
async function approvedGoldenPlan() {
  const suite = await suitePromise;
  const frozen = createScenarioManifest(suite, 'pg-f01-baseline');
  const kinds = ['task', 'note', 'draft', 'comment', 'thread'];
  const key = (kind: string) => frozen.manifest.effects.find(effect => effect.kind === kind)!.effectKey;
  const ref = (kind: string) => ({ type: 'effect_id', effectKey: key(kind) });
  const body = (kind: string) => [{ type: 'approved_content', planRevision: 1, contentKey: `${kind}_body` }];
  const contents = await Promise.all(kinds.map(async kind => {
    const text = `Synthetic approved ${kind} text.`;
    return { contentKey: `${kind}_body`, text, sha256: await sha256Text(text) };
  }));
  const base = { commitmentId: 'promise_101', requestDigest: '0'.repeat(64) };
  const plan = ImmutablePlanSchema.parse({
    schemaVersion: 2, runId: 'fixture_run', revision: 1, planHash: '0'.repeat(64), createdAt: '2026-09-13T17:35:02Z',
    incident: suite.world.github.technicalEvidence.incident,
    selection: { schemaVersion: 2, policyVersion: suite.scenarios.versions.policy, evaluatedAt: suite.world.clockAt,
      sourceBundleRef: artifact('fixture_source_bundle', { github: suite.world.github, hubspot: suite.world.hubspot }), sourceComplete: true,
      selected: [{ commitmentId: 'promise_101', companyId: 'company_acme', ownerId: 'owner_101', contactId: 'contact_101',
        mailbox: 'avery@acme.example.test', dueAt: '2026-09-16T17:30:00Z', service: 'billing-api', reason: 'active_in_horizon' }],
      excluded: [{ commitmentId: 'promise_102', reason: 'service_mismatch' }] },
    sources: (['github', 'hubspot'] as const).map(app => ({ snapshotId: `fixture_snapshot_${app}`, app, accountRef: suite.world.accounts[app],
      sourceIds: [app === 'github' ? 'inc_pg_001' : 'promise_101'], capturedAt: suite.world.clockAt, relevantVersion: 'source-v1',
      artifact: artifact(`fixture_source_${app}`, suite.world[app]), receipt: collection(app) })),
    contents,
    effects: [
      { ...base, kind: 'task', app: 'hubspot', effectKey: key('task'), payload: { companyId: 'company_acme', commitmentId: 'promise_101',
        ownerId: 'owner_101', dueAt: '2026-09-16T17:30:00Z', status: 'NOT_STARTED', subject: 'Synthetic approved follow-up', body: body('task') } },
      { ...base, kind: 'note', app: 'hubspot', effectKey: key('note'), payload: { companyId: 'company_acme', commitmentId: 'promise_101', taskId: ref('task'), body: body('note') } },
      { ...base, kind: 'draft', app: 'gmail', effectKey: key('draft'), payload: { to: 'avery@acme.example.test', cc: [], bcc: [],
        subject: `[PromiseGuard ${key('draft')}] Billing migration follow-up`, body: body('draft'), isDraft: true } },
      { ...base, commitmentId: null, kind: 'comment', app: 'github', effectKey: key('comment'), payload: {
        repositoryId: suite.world.github.technicalEvidence.incident.repositoryId, issueId: 'inc_pg_001', taskIds: [ref('task')], draftIds: [ref('draft')], body: body('comment') } },
      { ...base, commitmentId: null, kind: 'thread', app: 'slack', effectKey: key('thread'), payload: {
        channelId: suite.world.slack.channelId, threadTs: 'fixture_thread', body: body('thread') } },
    ],
  });
  for (const effect of plan.effects) effect.requestDigest = await sha256Text(canonical(requestHashMaterial(effect, plan.contents)));
  plan.planHash = await sha256Text(canonical(planHashMaterial(plan)));
  return { plan, receipt: artifact('fixture_approved_plan', plan), frozen };
}

test('approved content must be frozen before dispatch and cannot be bound from provider text or altered plan bytes', async () => {
  const { plan, receipt, frozen } = await approvedGoldenPlan();
  const boundAt = '2026-09-13T17:35:03Z', dispatchAt = '2026-09-13T17:35:04Z';
  const approved = await bindApprovedPlan(frozen, plan, receipt, boundAt, dispatchAt);
  assert.equal(approved.contentBindings.length, 4);
  assert.ok(approved.contentBindings.every(binding => binding.source === 'approved_plan'));
  await assert.rejects(bindApprovedPlan(frozen, plan, receipt, dispatchAt, dispatchAt), /content_binding_after_dispatch/);
  await assert.rejects(bindApprovedPlan(frozen, plan, { ...receipt, source: 'provider_output' }, boundAt, dispatchAt));
  const tampered = structuredClone(plan);
  tampered.contents[0].text = 'Different bytes supplied after approval.';
  await assert.rejects(bindApprovedPlan(frozen, tampered, artifact('tampered_receipt', tampered), boundAt, dispatchAt), /content_digest_mismatch/);
  await assert.rejects(resolveManifestExport(frozen, structuredClone(approved), []), /untrusted_approved_content_receipt/);
});

test('resolved exports use unique independent object bindings without replacing the logical manifest or its source facts', async () => {
  const { plan, receipt, frozen } = await approvedGoldenPlan();
  const approved = await bindApprovedPlan(frozen, plan, receipt, '2026-09-13T17:35:03Z', '2026-09-13T17:35:04Z');
  const bindings = frozen.manifest.effects.map(effect => LogicalIdBindingSchema.parse({
    schemaVersion: 2, effectRef: { type: 'effect_id', effectKey: effect.effectKey }, app: effect.app, accountRef: effect.accountRef,
    source: 'independent_read', collection: collection(effect.app),
    matches: [{ providerId: `provider_${effect.kind}`, marker: effect.effectKey, identityDigest: digest({ effectKey: effect.effectKey }),
      observationRef: artifact(`observed_${effect.kind}`, { providerId: `provider_${effect.kind}`, marker: effect.effectKey }) }],
  }));
  const originalHash = frozen.manifestHash;
  const resolved = await resolveManifestExport(frozen, approved, bindings);
  assert.equal(resolved.binding.logicalManifestHash, originalHash);
  assert.notEqual(resolved.resolvedExportHash, originalHash);
  assert.deepEqual(resolved.resolvedManifest.sourceFacts, frozen.manifest.sourceFacts);
  assert.equal(resolved.resolvedManifest.effects.find(effect => effect.kind === 'draft')?.requiredFields.bodySha256,
    await sha256Text('Synthetic approved draft text.'));
  assert.equal(frozen.manifestHash, originalHash);
  assertFrozenManifest(frozen);
  await assert.rejects(resolveManifestExport(frozen, approved, bindings.slice(1)), /incomplete_artifact_id_bindings/);
  const ambiguous = structuredClone(bindings);
  ambiguous[1].matches[0].providerId = ambiguous[0].matches[0].providerId;
  await assert.rejects(resolveManifestExport(frozen, approved, ambiguous), /ambiguous_provider_identity/);
  const nonunique = structuredClone(bindings);
  nonunique[0].matches.push({ ...nonunique[0].matches[0], providerId: 'second_candidate' });
  await assert.rejects(resolveManifestExport(frozen, approved, nonunique));
});

test('partial manifests bind the full approved plan while requiring only independently frozen partial artifacts', async () => {
  const suite = await suitePromise;
  const partial = createScenarioManifest(suite, 'pg-f10-baseline');
  assert.equal(partial.manifest.expectedTerminalStatus, 'failed_partial');
  assert.deepEqual(partial.manifest.effects.map(effect => effect.kind), ['task', 'note']);
  assert.deepEqual(createScenarioManifest(suite, 'pg-f11-baseline').manifest.effects.map(effect => effect.kind), ['task', 'note', 'draft']);
  assert.deepEqual(createScenarioManifest(suite, 'pg-f18-baseline').manifest.effects.map(effect => effect.kind), ['task']);
  const { plan, receipt } = await approvedGoldenPlan();
  const approved = await bindApprovedPlan(partial, plan, receipt, '2026-09-13T17:35:03Z', '2026-09-13T17:35:04Z');
  assert.equal(approved.plan.effects.length, 5);
  assert.equal(approved.contentBindings.length, 1);
  const bindings = partial.manifest.effects.map(effect => LogicalIdBindingSchema.parse({
    schemaVersion: 2, effectRef: { type: 'effect_id', effectKey: effect.effectKey }, app: effect.app, accountRef: effect.accountRef,
    source: 'independent_read', collection: collection(effect.app), matches: [{ providerId: `partial_${effect.kind}`, marker: effect.effectKey,
      identityDigest: digest({ effectKey: effect.effectKey }), observationRef: artifact(`partial_observed_${effect.kind}`, { marker: effect.effectKey }) }],
  }));
  const resolved = await resolveManifestExport(partial, approved, bindings);
  assert.deepEqual(resolved.resolvedManifest.effects.map(effect => effect.kind), ['task', 'note']);
  assert.equal(resolved.resolvedManifest.expectedTerminalStatus, 'failed_partial');
  const copiedManifest = Object.freeze(structuredClone(partial.manifest));
  const forged = Object.freeze({ manifest: copiedManifest, manifestHash: digest(copiedManifest) });
  assert.throws(() => assertFrozenManifest(forged), /mutable_or_changed_manifest/);
});
