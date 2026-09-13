import assert from 'node:assert/strict';
import { test } from 'vitest';
import { roleInvocationKey } from '../../src/shared/agents.js';
import { bindIncidentIdentity } from '../../src/server/policy/identity.js';
import { canonicalDigest, normalizeApprovedText } from '../../src/server/policy/canonical.js';
import { deriveEffectKey, effectKeyMaterial } from '../../src/server/policy/effect-keys.js';
import { createSuccessClaimScopeTemplate } from '../../src/server/policy/claims.js';
import { freezePlan, resolvePlannedEffect, verifyPlanFreezeReceipt } from '../../src/server/policy/plan.js';
import { verifyPlanIntegrity } from '../../src/shared/domain.js';

const incidentFingerprint = 'b'.repeat(64);
const digest = 'a'.repeat(64);
const at = '2026-09-14T10:00:00Z';
const dueAt = '2026-09-16T10:00:00Z';
const artifact = (artifactId: string, sha256 = digest) => ({
  artifactId, sha256, byteLength: 32, mediaType: 'application/json' as const,
});
const collection = (app: 'github' | 'hubspot') => ({
  schemaVersion: 2 as const, collectionId: `collection-${app}`, app, accountRef: `account-${app}`,
  producerId: 'fixture-reader', startedAt: at, finishedAt: at, status: 'complete' as const, reason: null,
  requiredQueryIds: [`${app}.read`], pages: [{ queryId: `${app}.read`, cursor: null, nextCursor: null,
    recordCount: 1, response: artifact(`${app}-page`), providerAttemptId: `${app}-attempt` }],
});
const incident = {
  schemaVersion: 2 as const, repositoryId: 'repository-1', issueId: 'issue-1', issueNumber: 7,
  canonicalUrl: 'https://github.com/example/fixture/issues/7', service: 'billing-api', environment: 'production',
};
const fingerprint = bindIncidentIdentity(incident, incident).incidentFingerprint;

function planInput(revision = 1, text = 'We are investigating e\u0301.\r\nNo recovery time is confirmed.') {
  const selected = { commitmentId: 'commitment-1', companyId: 'company-1', ownerId: 'owner-1',
    contactId: 'contact-1', mailbox: 'avery@example.test', dueAt, service: 'billing-api', reason: 'eligible' };
  const sourceRef = artifact('source-fact');
  const sourceFacts = [{ factId: 'fact-1', sourceRef, sourceField: 'issue.body', text: 'The incident is under investigation.' }];
  const assessment = { schemaVersion: 2 as const,
    facts: [{ claimId: 'analysis-claim', text: 'The incident is under investigation.', sourceFactIds: ['fact-1'] }],
    contradictions: [], unknowns: ['Recovery time'],
    candidateChange: { status: 'uncertain' as const, sourceFactIds: ['fact-1'], reason: 'No causal proof.' } };
  const proposal = { schemaVersion: 2 as const, entries: [{ commitmentId: selected.commitmentId, text,
    claims: [{ claimId: 'draft-claim', text: 'The incident is under investigation.', sourceFactIds: ['fact-1'] }] }] };
  const audit = { schemaVersion: 2 as const, verdict: 'pass' as const, entries: [{ commitmentId: selected.commitmentId,
    findings: [{ claimId: 'draft-claim', verdict: 'supported' as const, sourceFactIds: ['fact-1'], reason: 'Cited.' }],
    requiredFactFindings: [{ factId: 'fact-1', verdict: 'present' as const, reason: 'Present.' }] }] };
  const result = <T>(role: 'analyst' | 'drafter' | 'auditor', output: T) => ({
    schemaVersion: 2 as const, roleInvocationKey: roleInvocationKey('run-1', revision, role),
    attemptRefs: [`${role}-attempt`], firstOutputRef: artifact(`${role}-first`), status: 'success' as const,
    output, outputRef: artifact(`${role}-validated`), validationRef: artifact(`${role}-validation`),
  });
  const sources = (['github', 'hubspot'] as const).map(app => ({
    snapshotId: `snapshot-${app}`, app, accountRef: `account-${app}`, sourceIds: [`${app}-source`],
    capturedAt: at, relevantVersion: 'source-v1', artifact: artifact(`${app}-source`), receipt: collection(app),
  }));
  return {
    schemaVersion: 2 as const, runId: 'run-1', revision, createdAt: at, incidentFingerprint: fingerprint,
    incident, selection: { schemaVersion: 2 as const, policyVersion: 'selection-v1', evaluatedAt: at,
      sourceBundleRef: artifact('source-bundle'), sourceComplete: true as const, selected: [selected], excluded: [] },
    sources, sourceFacts, taskContract: { selectedCommitmentIds: [selected.commitmentId],
      requiredFacts: ['fact-1'], forbiddenClaims: ['Recovery is guaranteed'] },
    roleResults: { analyst: result('analyst', assessment), drafter: result('drafter', proposal),
      auditor: result('auditor', audit) }, logicalManifestHash: 'c'.repeat(64),
    slack: { channelId: 'incident-customer-impact', threadTs: '100.200' },
  };
}

test('canonical plan hashing preserves frozen JSON rules and normalizes approved text once', async () => {
  assert.equal(await canonicalDigest({ b: 2, a: 1 }), '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  assert.equal(normalizeApprovedText('e\u0301\r\nnext\rline '), 'é\nnext\nline ');
  assert.notEqual(await canonicalDigest([1, 2]), await canonicalDigest([2, 1]));
  await assert.rejects(canonicalDigest({ missing: undefined }), /invalid_canonical_json/);
  await assert.rejects(canonicalDigest(Number.NaN), /invalid_canonical_json/);
});

test('effect keys bind only versioned logical identity and reject mismatched app actions', async () => {
  const input = { incidentFingerprint, app: 'hubspot' as const,
    stableBusinessTargetId: 'commitment-1', actionType: 'task' as const };
  const key = await deriveEffectKey(input);
  assert.equal(key, await deriveEffectKey({ ...input }));
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(effectKeyMaterial(input)), true);
  assert.notEqual(key, await deriveEffectKey({ ...input, actionType: 'note' }));
  assert.notEqual(key, await deriveEffectKey({ ...input, stableBusinessTargetId: 'commitment-2' }));
  await assert.rejects(deriveEffectKey({ ...input, app: 'gmail' }), /effect_action_app_mismatch/);
});

test('freezes an exact immutable plan and provenance receipt from selected identities and approved bytes', async () => {
  const input = planInput();
  const before = structuredClone(input);
  const frozen = await freezePlan(input);
  assert.deepEqual(input, before);
  assert.deepEqual(frozen.plan.effects.map(effect => effect.kind), ['task', 'note', 'draft', 'comment', 'thread']);
  const draft = frozen.plan.effects.find(effect => effect.kind === 'draft')!;
  const note = frozen.plan.effects.find(effect => effect.kind === 'note')!;
  assert.deepEqual(note.payload.body[0], {
    type: 'text', text: `[PromiseGuard:${note.effectKey}] Approved customer update:\n`,
  });
  assert.equal(draft.payload.to, input.selection.selected[0].mailbox);
  assert.deepEqual(draft.payload.cc, []);
  assert.deepEqual(draft.payload.bcc, []);
  assert.equal(frozen.plan.contents[0].text, 'We are investigating é.\nNo recovery time is confirmed.');
  assert.equal(frozen.receipt.roleOutputs.find(output => output.role === 'drafter')?.firstOutputRef.artifactId, 'drafter-first');
  assert.equal(frozen.receipt.contentBindings[0].source, 'approved_plan');
  assert.equal(Object.isFrozen(frozen.plan.effects[0].payload), true);
  await assert.doesNotReject(verifyPlanIntegrity(frozen.plan));
  await assert.doesNotReject(verifyPlanFreezeReceipt(frozen.receipt, frozen.plan));
});

test('revisions change complete plan identity while stable logical effects survive body, source and owner edits', async () => {
  const original = await freezePlan(planInput());
  const revisedInput = planInput(2, 'The incident remains under investigation.');
  revisedInput.sources[0].relevantVersion = 'source-v2';
  revisedInput.sources[0].artifact = artifact('github-source-v2', 'd'.repeat(64));
  revisedInput.selection.selected[0].ownerId = 'owner-2';
  const revised = await freezePlan(revisedInput);
  assert.notEqual(revised.plan.planHash, original.plan.planHash);
  assert.deepEqual(revised.plan.effects.map(effect => effect.effectKey), original.plan.effects.map(effect => effect.effectKey));
  assert.notEqual(revised.plan.effects.find(effect => effect.kind === 'draft')?.requestDigest,
    original.plan.effects.find(effect => effect.kind === 'draft')?.requestDigest);
  assert.notEqual(revised.receipt.receiptHash, original.receipt.receiptHash);
});

test('mechanical claim validation rejects unknown citations, failed audit and revision-mismatched role output', async () => {
  const unknownCitation = planInput();
  unknownCitation.roleResults.drafter.output.entries[0].claims[0].sourceFactIds = ['missing-fact'];
  await assert.rejects(freezePlan(unknownCitation), /unknown_source_citation/);
  const blocked = planInput();
  (blocked.roleResults.auditor.output as { verdict: 'pass' | 'block' }).verdict = 'block';
  (blocked.roleResults.auditor.output.entries[0].findings[0] as {
    verdict: 'supported' | 'unsupported';
  }).verdict = 'unsupported';
  await assert.rejects(freezePlan(blocked), /audit_not_passed/);
  const wrongRevision = planInput();
  wrongRevision.roleResults.drafter.roleInvocationKey = roleInvocationKey('run-1', 2, 'drafter');
  await assert.rejects(freezePlan(wrongRevision), /role_revision_mismatch/);
  const forbidden = planInput(1, 'Recovery is guaranteed for this incident.');
  await assert.rejects(freezePlan(forbidden), /forbidden_claim/);
  const crossPlatformForbidden = planInput(1, 'Recovery\nis guaranteed for this incident.');
  crossPlatformForbidden.taskContract.forbiddenClaims = ['Recovery\r\nis guaranteed'];
  await assert.rejects(freezePlan(crossPlatformForbidden), /forbidden_claim/);
});

test('plan input cannot add a model-selected recipient or produce multi-recipient mail', async () => {
  const expanded = { ...planInput(), recipient: 'attacker@example.test' };
  await assert.rejects(freezePlan(expanded as ReturnType<typeof planInput>), /unrecognized_keys|Unrecognized key/);
  const multiple = planInput();
  multiple.selection.selected[0].mailbox = 'one@example.test,two@example.test';
  await assert.rejects(freezePlan(multiple));
});

test('resolves only plan-declared effect IDs and approved content with binding receipts', async () => {
  const { plan, receipt } = await freezePlan(planInput());
  const task = plan.effects.find(effect => effect.kind === 'task')!;
  const note = plan.effects.find(effect => effect.kind === 'note')!;
  const binding = { effectKey: task.effectKey, providerId: 'hubspot-task-1', bindingReceipt: artifact('task-binding') };
  const resolved = await resolvePlannedEffect(plan, note.effectKey, [binding]);
  assert.ok('taskId' in resolved.payload);
  assert.equal(resolved.payload.taskId, binding.providerId);
  assert.match(resolved.payload.body, /We are investigating é/);
  await assert.rejects(resolvePlannedEffect(plan, note.effectKey, []), /missing_effect_binding/);
  await assert.rejects(resolvePlannedEffect(plan, note.effectKey, [binding, binding]), /ambiguous_effect_binding/);
  await assert.rejects(resolvePlannedEffect(plan, note.effectKey, [binding, {
    effectKey: note.effectKey, providerId: 'hubspot-note-1', bindingReceipt: artifact('note-binding'),
  }]), /undeclared_effect_binding/);
  const tampered = structuredClone(plan);
  tampered.contents[0].text = 'Observed provider bytes must not define approved content.';
  await assert.rejects(resolvePlannedEffect(tampered, note.effectKey, [binding]), /content_digest_mismatch/);
  await assert.doesNotReject(verifyPlanFreezeReceipt(receipt, plan));
});

test('claim scope templates exclude the unverified final summary until full-run completion', async () => {
  const { plan } = await freezePlan(planInput());
  const artifacts = await createSuccessClaimScopeTemplate(plan, 'artifacts');
  const run = await createSuccessClaimScopeTemplate(plan, 'run');
  const thread = plan.effects.find(effect => effect.kind === 'thread')!;
  assert.equal(artifacts.effectKeys.includes(thread.effectKey), false);
  assert.equal(artifacts.finalSlackEffectKey, null);
  assert.equal(run.effectKeys.includes(thread.effectKey), true);
  assert.equal(run.finalSlackEffectKey, thread.effectKey);
  await assert.rejects(createSuccessClaimScopeTemplate({ ...plan, planHash: digest }, 'run'), /plan_digest_mismatch/);
});
