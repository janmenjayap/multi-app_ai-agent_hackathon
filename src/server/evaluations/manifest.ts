import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { GitHubTechnicalEvidenceSchema, HubSpotCommitmentBundleSchema, SlackMessageSchema, GmailDraftSchema } from '../../shared/adapters.js';
import { ModelBudgetsSchema } from '../../shared/agents.js';
import { CountSchema, DigestSchema, ExecutionModeSchema, IdSchema, RestrictedArtifactRefSchema, SelectionSchema,
  UtcTimestampSchema, canonical, immutable, sha256Text, verifyPlanIntegrity } from '../../shared/domain.js';
import type { ImmutablePlan, RestrictedArtifactRef } from '../../shared/domain.js';
import { CompletionClaimSchema, LogicalManifestSchema, parseApprovedContentBinding, parseCheckerExportBinding } from '../../shared/evaluation.js';
import type { ApprovedContentBinding, LogicalIdBinding, LogicalManifest } from '../../shared/evaluation.js';
import { digest } from '../../shared/reliability.js';

const shape = LogicalManifestSchema.shape;
const sourceEdit = z.object({ path: z.array(z.string().min(1)).min(2), value: z.json() }).strict();
export const ScenarioEntrySchema = z.object({
  suiteEntryId: IdSchema, family: shape.family, scenarioId: IdSchema, variantId: IdSchema,
  leg: z.enum(['baseline', 'repetition', 'variant', 'repair']), repetition: CountSchema,
  executionEligible: z.boolean(), expectedUnsafe: z.boolean(), expectedTerminalStatus: shape.expectedTerminalStatus,
  requiredRoles: shape.requiredRoles, faultScriptId: IdSchema, faultBoundary: IdSchema,
  parentSuiteEntryId: IdSchema.nullable(),
  setup: z.object({ preservePriorEffects: z.boolean(), sourceEdits: z.array(sourceEdit) }).strict(),
  expectedSelection: z.object({ commitmentIds: z.array(IdSchema), ownerId: IdSchema, recipient: z.email(), dueAt: UtcTimestampSchema }).strict(),
  stage: z.object({ actorKind: z.enum(['operator', 'fault']), actorId: IdSchema, requiresFreshApproval: z.boolean(),
    requiresFreshBaseline: z.boolean(), preserveOriginalHistory: z.literal(true) }).strict(),
  sourceAssertions: z.array(z.string().min(1)).min(1), outcomeAssertions: z.array(z.string().min(1)).min(1),
}).strict();
export const ScenarioCensusSchema = z.object({
  schemaVersion: z.literal(2), suiteId: IdSchema, conventionsVersion: z.literal('1.2'), fixtureId: IdSchema,
  frozenAt: UtcTimestampSchema, provenance: z.literal('synthetic_fixture'), baselineRepetitionTarget: z.literal(42),
  repeatedFamilies: z.tuple([z.literal(1), z.literal(3), z.literal(5), z.literal(6), z.literal(9), z.literal(12)]),
  configuration: ExecutionModeSchema,
  transports: z.object({ github: z.literal('fake'), hubspot: z.literal('fake'), gmail: z.literal('fake'), slack: z.literal('fake') }).strict(),
  budgets: shape.budgets, modelBudgets: ModelBudgetsSchema, versions: shape.versions,
  roleOrder: z.tuple([z.literal('analyst'), z.literal('drafter'), z.literal('auditor')]),
  outputSchemaVersion: IdSchema, claimWindow: shape.claimWindow, entries: z.array(ScenarioEntrySchema).min(42),
  fakeContracts: z.object({ providerPageSize: z.literal(1), faultsSha256: DigestSchema, modelSha256: DigestSchema }).strict(),
  handoff: z.object({ implementationId: z.literal('Q01'), baseSha: z.string().regex(/^[a-f0-9]{40}$/),
    prerequisiteF02Sha: z.string().regex(/^[a-f0-9]{40}$/), consumers: z.array(IdSchema), evidenceMode: z.literal('synthetic_fixture'),
    actualWorkflowAttempts: z.literal(0), actualModelCalls: z.literal(0), actualHumanReviews: z.literal(0), note: z.string() }).strict(),
}).strict().superRefine((suite, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (suite.configuration.modelMode !== 'mock' || suite.configuration.providerMode !== 'fake' ||
      suite.configuration.evidenceMode !== 'synthetic_fixture' || suite.configuration.fixtureId !== suite.fixtureId) fail('fixed_model_is_synthetic');
  const ids = suite.entries.map(e => e.suiteEntryId);
  if (new Set(ids).size !== ids.length) fail('duplicate_suite_entry');
  const slots = suite.entries.filter(e => e.leg === 'baseline' || e.leg === 'repetition');
  if (slots.length !== 42) fail('incomplete_baseline_census');
  for (let family = 1; family <= 18; family++) {
    const expected = suite.repeatedFamilies.includes(family as 1) ? [0, 1, 2, 3, 4] : [0];
    const rows = slots.filter(e => e.family === family);
    if (rows.length !== expected.length || expected.some(r => rows.filter(e => e.repetition === r &&
      e.leg === (r === 0 ? 'baseline' : 'repetition')).length !== 1)) fail('omitted_cohort_slot');
  }
  for (const entry of suite.entries) {
    if (entry.parentSuiteEntryId && !ids.includes(entry.parentSuiteEntryId)) fail('missing_parent_stage');
    if (entry.leg === 'repair' && (!entry.parentSuiteEntryId || !entry.stage.requiresFreshBaseline || entry.stage.actorKind !== 'operator')) fail('invalid_repair_stage');
    if (entry.executionEligible && (entry.expectedTerminalStatus !== 'completed' || entry.expectedUnsafe)) fail('invalid_execution_eligibility');
    if (entry.expectedTerminalStatus === 'completed_no_affected_commitments' &&
        (entry.expectedSelection.commitmentIds.length || entry.requiredRoles.length)) fail('invalid_no_affected_target');
  }
});

export const FixtureWorldSchema = z.object({
  schemaVersion: z.literal(2), fixtureId: IdSchema, conventionsVersion: z.literal('1.2'), provenance: z.literal('synthetic_fixture'),
  clockAt: UtcTimestampSchema,
  policy: z.object({ impactHorizonHours: z.literal(72), approvalTtlMs: z.literal(600000), sourceFreshnessMs: z.literal(30000) }).strict(),
  accounts: z.object({ github: IdSchema, hubspot: IdSchema, gmail: IdSchema, slack: IdSchema }).strict(),
  github: z.object({ technicalEvidence: GitHubTechnicalEvidenceSchema,
    // Invalid typed source fields are deliberate policy fixtures, not valid incident authority.
    incidentFields: z.record(z.string(), z.json()) }).strict(),
  hubspot: HubSpotCommitmentBundleSchema,
  slack: z.object({ workspaceId: IdSchema, channelId: IdSchema, approverId: IdSchema, messages: z.array(SlackMessageSchema) }).strict(),
  gmail: z.object({ mailbox: IdSchema, drafts: z.array(GmailDraftSchema) }).strict(),
  ticketMappings: z.array(z.object({ commitmentId: IdSchema, ticketId: IdSchema }).strict()), protectedRecords: shape.protectedRecords,
}).strict();
const SourceOracleSchema = z.object({
  schemaVersion: z.literal(2), fixtureId: IdSchema, oracleVersion: IdSchema, worldFixtureId: IdSchema, conventionsVersion: z.literal('1.2'),
  provenance: z.object({ reviewer: z.object({ kind: z.literal('fixture'), fixtureId: IdSchema }).strict(),
    reviewerId: IdSchema, reviewedAt: UtcTimestampSchema, clockKind: z.literal('fixture_clock'), evidenceMode: z.literal('synthetic_fixture'),
    actualHumanReview: z.literal(false), humanReviewStatus: z.literal('pending'), independentOfGeneratedOutputs: z.literal(true),
    sourcePaths: z.array(z.string()).min(1), reason: z.string().min(1) }).strict(),
  sourceSnapshots: z.array(z.object({ snapshotId: IdSchema, app: z.enum(['github', 'hubspot']), accountRef: IdSchema,
    sourceIds: z.array(IdSchema).min(1), sourceDigest: DigestSchema, payloadPath: z.enum(['github', 'hubspot']),
    sourcePath: z.string(), digestRule: z.literal('sha256_of_shared_canonical_json'), capturedAt: UtcTimestampSchema,
    isSynthetic: z.literal(true) }).strict()).length(2),
  sourceFacts: shape.sourceFacts,
  forbiddenClaims: z.array(z.object({ claimId: IdSchema, assertion: z.string().min(1), reason: z.string().min(1) }).strict()).min(1),
  semanticInvariants: z.array(z.object({ invariantId: IdSchema, roles: shape.requiredRoles, requirement: z.string().min(1) }).strict()).min(1),
  selectionConstraints: z.record(z.string(), z.json()), allowedEffects: z.array(z.json()).min(5),
  effectConstraints: z.record(z.string(), z.json()), protectedRecords: shape.protectedRecords,
  protectedRecordConstraints: z.record(z.string(), z.json()),
  stageBoundaries: z.array(z.object({ boundaryId: IdSchema, stageId: IdSchema, actor: IdSchema, requirement: z.string() }).strict()).min(1),
  scenarioSourceRules: z.array(z.object({ family: shape.family, rule: z.string().min(1) }).strict()),
  reviewLabels: z.array(z.never()).length(0), reviewLabelRule: z.string().min(1),
}).strict();

// This pin binds the complete reviewed fixture, including every safety variant.
// Changing the oracle is an explicit versioned review, never a reaction to execution.
export const Q01_SUITE_HASH = 'a58137ad7a59377cdc110af3c917b8edecc295c280dac6d2a3bd6ae2026def77';
const issuedSuites = new WeakSet<object>();
export function loadFixtureSuiteFrom(input: { world: unknown; scenarios: unknown; sourceLabels: unknown }) {
  const world = FixtureWorldSchema.parse(input.world);
  const scenarios = ScenarioCensusSchema.parse(input.scenarios);
  const sourceLabels = SourceOracleSchema.parse(input.sourceLabels);
  if (world.fixtureId !== scenarios.fixtureId || world.fixtureId !== sourceLabels.worldFixtureId) throw new Error('fixture_identity_mismatch');
  for (const snapshot of sourceLabels.sourceSnapshots) {
    if (snapshot.app !== snapshot.payloadPath || snapshot.accountRef !== world.accounts[snapshot.app] ||
        snapshot.sourceDigest !== digest(world[snapshot.payloadPath])) throw new Error('source_snapshot_digest_mismatch');
  }
  if (new Set(sourceLabels.sourceSnapshots.map(s => s.app)).size !== 2 || sourceLabels.sourceFacts.some(f =>
    !sourceLabels.sourceSnapshots.some(s => s.sourceDigest === f.sourceDigest))) throw new Error('incomplete_source_oracle');
  const suiteHash = digest({ world, scenarios, sourceLabels });
  if (suiteHash !== Q01_SUITE_HASH) throw new Error('frozen_suite_changed');
  const suite = immutable({ world, scenarios, sourceLabels, suiteHash });
  issuedSuites.add(suite);
  return suite;
}
export type FixtureSuite = ReturnType<typeof loadFixtureSuiteFrom>;
export type ScenarioEntry = z.infer<typeof ScenarioEntrySchema>;
export async function loadFixtureSuite() {
  const [world, scenarios, sourceLabels] = await Promise.all(['world', 'scenarios', 'source-labels'].map(async name =>
    JSON.parse(await readFile(new URL(`../../../tests/fixtures/${name}.json`, import.meta.url), 'utf8'))));
  const suite = loadFixtureSuiteFrom({ world, scenarios, sourceLabels });
  for (const [path, expected] of [['tests/fixtures/faults.ts', suite.scenarios.fakeContracts.faultsSha256],
    ['tests/fakes/model.ts', suite.scenarios.fakeContracts.modelSha256]]) {
    if (await sha256Text(await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8')) !== expected) throw new Error('frozen_fake_contract_changed');
  }
  return suite;
}
function entryFor(suite: FixtureSuite, suiteEntryId: string) {
  if (!issuedSuites.has(suite)) throw new Error('untrusted_or_mutable_suite');
  const entry = suite.scenarios.entries.find(e => e.suiteEntryId === suiteEntryId);
  if (!entry) throw new Error('unknown_suite_entry');
  return entry;
}
/** Applies only predeclared setup edits. Runtime/operator history belongs to the harness. */
export function scenarioWorld(suite: FixtureSuite, suiteEntryId: string) {
  const world = structuredClone(suite.world);
  for (const edit of entryFor(suite, suiteEntryId).setup.sourceEdits) {
    if (!['github', 'hubspot'].includes(edit.path[0]) || edit.path.some(p => ['__proto__', 'prototype', 'constructor'].includes(p))) throw new Error('invalid_source_edit');
    let target: unknown = world;
    for (const key of edit.path.slice(0, -1)) {
      if (typeof target !== 'object' || target === null || !Object.hasOwn(target, key)) throw new Error('unknown_source_edit_path');
      target = (target as Record<string, unknown>)[key];
    }
    const key = edit.path.at(-1)!;
    if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) throw new Error('unknown_source_edit_path');
    (target as Record<string, unknown>)[key] = structuredClone(edit.value);
  }
  // Keep the fenced typed source block aligned, except the explicit conflicting-field fixture.
  const entry = entryFor(suite, suiteEntryId);
  if (entry.variantId !== 'conflicting_incident_field') {
    const incident = world.github.technicalEvidence.incident;
    const fields = { incidentId: incident.issueId, service: incident.service, environment: incident.environment, ...world.github.incidentFields };
    world.github.technicalEvidence.body = world.github.technicalEvidence.body.replace(/```json\n[^]*?\n```/, `\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``);
  }
  return immutable(FixtureWorldSchema.parse(world));
}
export function freezeManifest(value: unknown) {
  const manifest = LogicalManifestSchema.parse(value);
  const frozen = immutable({ manifest, manifestHash: digest(manifest) });
  issuedManifests.add(frozen);
  return frozen;
}
export type FrozenManifest = ReturnType<typeof freezeManifest>;
const issuedManifests = new WeakSet<FrozenManifest>();
const manifestScopes = new WeakMap<FrozenManifest, { accounts: FixtureSuite['world']['accounts']; sourceDigest: string;
  sourceDigests: { github: string; hubspot: string }; incident: FixtureSuite['world']['github']['technicalEvidence']['incident'] }>();
export function assertFrozenManifest(value: FrozenManifest): void {
  LogicalManifestSchema.parse(value.manifest);
  if (!issuedManifests.has(value) || value.manifestHash !== digest(value.manifest)) throw new Error('mutable_or_changed_manifest');
}
export function createScenarioManifest(suite: FixtureSuite, suiteEntryId: string): FrozenManifest {
  const entry = entryFor(suite, suiteEntryId), world = scenarioWorld(suite, suiteEntryId);
  const revision = entry.leg === 'repair' ? 2 : 1;
  const kinds = ['task', 'note', 'draft', 'comment', 'thread'] as const;
  const incidentFingerprint = digest(world.github.technicalEvidence.incident);
  const apps = { task: 'hubspot', note: 'hubspot', draft: 'gmail', comment: 'github', thread: 'slack' };
  const keys = Object.fromEntries(kinds.map(kind => [kind, digest({ schemaVersion: 2, policyVersion: suite.scenarios.versions.policy,
    incidentFingerprint, app: apps[kind], stableBusinessTargetId: kind === 'thread' ? incidentFingerprint :
      kind === 'comment' ? world.github.technicalEvidence.incident.issueId : 'promise_101', actionType: kind })]));
  const id = (kind: string) => ({ type: 'effect_id', effectKey: keys[kind] });
  const content = (kind: string) => ({ type: 'approved_content', planRevision: revision, contentKey: `${kind}_body` });
  const sourceFacts = suite.sourceLabels.sourceFacts.filter(f => suite.sourceLabels.sourceSnapshots.some(s =>
    s.sourceDigest === f.sourceDigest && digest(world[s.payloadPath]) === s.sourceDigest));
  // Variant facts come from the frozen setup and independently authored assertions, never observations.
  for (const [i, assertion] of entry.sourceAssertions.entries()) sourceFacts.push({
    factId: `${entry.suiteEntryId}_assertion_${i}`, sourceDigest: digest({ github: world.github, hubspot: world.hubspot }), assertion,
  });
  const { ownerId, recipient, dueAt } = entry.expectedSelection;
  const allEffects = [
    { effectKey: keys.task, app: 'hubspot', accountRef: world.accounts.hubspot, kind: 'task',
      requiredFields: { companyId: 'company_acme', commitmentId: 'promise_101', ownerId, dueAt, status: 'NOT_STARTED' } },
    { effectKey: keys.note, app: 'hubspot', accountRef: world.accounts.hubspot, kind: 'note',
      requiredFields: { companyId: 'company_acme', commitmentId: 'promise_101', taskId: id('task'), bodySha256: content('note') } },
    { effectKey: keys.draft, app: 'gmail', accountRef: world.accounts.gmail, kind: 'draft',
      requiredFields: { to: recipient, cc: [], bcc: [], subject: `[PromiseGuard ${keys.draft}] Billing migration follow-up`, bodySha256: content('draft'), isDraft: true } },
    { effectKey: keys.comment, app: 'github', accountRef: world.accounts.github, kind: 'comment',
      requiredFields: { repositoryId: world.github.technicalEvidence.incident.repositoryId, incidentId: world.github.technicalEvidence.incident.issueId,
        taskIds: [id('task')], draftIds: [id('draft')], bodySha256: content('comment') } },
    { effectKey: keys.thread, app: 'slack', accountRef: world.accounts.slack, kind: 'thread',
      requiredFields: { channelId: world.slack.channelId, taskIds: [id('task')], noteIds: [id('note')], draftIds: [id('draft')], commentId: id('comment'), bodySha256: content('thread'), verdict: 'completed' } },
  ];
  // Required partial-state artifacts are fixed by the fault boundary, not whichever writes happened.
  const partialKinds: Record<string, string[]> = {
    permission_denial: ['task', 'note'], incorrect_result: ['task', 'note', 'draft'],
    body_tampering: ['task', 'note', 'draft'], wrong_task_owner: ['task'],
    phantom_slack_success: ['task', 'note', 'draft', 'comment', 'thread'],
    accepted_write_invisible: ['task', 'note', 'draft'], duplicate_creations: ['task', 'note', 'draft'],
    approval_expired_mid_batch: ['task'], source_drift_after_partial_progress: ['task'],
  };
  const effects = entry.expectedTerminalStatus === 'completed' ? allEffects :
    allEffects.filter(effect => partialKinds[entry.faultScriptId]?.includes(effect.kind));
  const frozen = freezeManifest({ schemaVersion: 2, manifestId: `${suiteEntryId}-manifest`, cohortId: suite.scenarios.suiteId,
    suiteEntryId, family: entry.family, mode: suite.scenarios.configuration.evidenceMode, frozenAt: suite.scenarios.frozenAt,
    executionEligible: entry.executionEligible, expectedUnsafe: entry.expectedUnsafe, variantId: entry.variantId,
    repetition: entry.repetition, faultIds: [entry.faultScriptId], budgets: suite.scenarios.budgets, versions: suite.scenarios.versions,
    requiredRoles: entry.requiredRoles, expectedTerminalStatus: entry.expectedTerminalStatus, effects, sourceFacts,
    protectedRecords: world.protectedRecords,
    forbiddenEffects: ['send_email', 'delete', 'production_mutation', 'extra_recipient', 'unapproved_write', 'duplicate_create'],
    claimWindow: suite.scenarios.claimWindow });
  manifestScopes.set(frozen, { accounts: world.accounts, sourceDigest: digest({ github: world.github, hubspot: world.hubspot }),
    sourceDigests: { github: digest(world.github), hubspot: digest(world.hubspot) }, incident: world.github.technicalEvidence.incident });
  return frozen;
}

export type ApprovedPlanReceipt = Readonly<{ manifestHash: string; plan: ImmutablePlan; planReceipt: RestrictedArtifactRef;
  boundAt: string; firstDispatchAt: string; contentBindings: ApprovedContentBinding[] }>;
// Only receipts issued by this module can resolve text; imported/provider objects cannot impersonate them.
const issuedApprovals = new WeakSet<ApprovedPlanReceipt>();
export async function bindApprovedPlan(frozen: FrozenManifest, value: unknown, receiptValue: unknown,
  boundAt: string, firstDispatchAt: string): Promise<ApprovedPlanReceipt> {
  assertFrozenManifest(frozen);
  if (frozen.manifest.expectedTerminalStatus === 'completed_no_affected_commitments') throw new Error('no_affected_requires_no_plan');
  UtcTimestampSchema.parse(boundAt); UtcTimestampSchema.parse(firstDispatchAt);
  const plan = await verifyPlanIntegrity(value), planReceipt = RestrictedArtifactRefSchema.parse(receiptValue);
  const scope = manifestScopes.get(frozen);
  if (!scope || canonical(plan.incident) !== canonical(scope.incident) ||
      (['github', 'hubspot'] as const).some(app => !plan.sources.some(s => s.app === app &&
        s.accountRef === scope.accounts[app] && s.artifact.sha256 === scope.sourceDigests[app]))) throw new Error('plan_source_scope_mismatch');
  if (Date.parse(boundAt) >= Date.parse(firstDispatchAt) || Date.parse(plan.createdAt) > Date.parse(boundAt) ||
      Date.parse(frozen.manifest.frozenAt) > Date.parse(plan.createdAt)) throw new Error('content_binding_after_dispatch');
  if (planReceipt.sha256 !== digest(plan) || planReceipt.byteLength !== Buffer.byteLength(canonical(plan)) ||
      planReceipt.mediaType !== 'application/json') throw new Error('invalid_approved_plan_receipt');
  if (frozen.manifest.expectedTerminalStatus === 'completed' && plan.effects.length !== frozen.manifest.effects.length)
    throw new Error('plan_manifest_effect_mismatch');
  const contentBindings: ApprovedContentBinding[] = [];
  for (const effect of frozen.manifest.effects) {
    const planned = plan.effects.find(e => e.effectKey === effect.effectKey);
    if (!planned || planned.kind !== effect.kind || planned.app !== effect.app) throw new Error('plan_manifest_effect_mismatch');
    for (const [field, expected] of Object.entries(effect.requiredFields)) {
      if (expected && typeof expected === 'object' && !Array.isArray(expected) && expected.type === 'approved_content') {
        if (!planned.payload.body.some(p => p.type === 'approved_content' && canonical(p) === canonical(expected))) throw new Error('content_not_in_approved_effect');
        const content = plan.contents.find(c => c.contentKey === expected.contentKey);
        if (!content) throw new Error('missing_approved_content');
        if (!contentBindings.some(b => canonical(b.contentRef) === canonical(expected))) contentBindings.push(parseApprovedContentBinding({
          schemaVersion: 2, contentRef: expected, source: 'approved_plan', planHash: plan.planHash, planReceipt,
          text: content.text, contentDigest: content.sha256,
        }, plan));
      } else {
        // Summary link sets/verdict are template predicates, resolved later using frozen ID slots.
        if (planned.kind === 'thread' && ['taskIds', 'noteIds', 'draftIds', 'commentId', 'verdict'].includes(field)) continue;
        const payload = planned.payload as Record<string, unknown>;
        const actual = payload[field === 'incidentId' ? 'issueId' : field];
        if (canonical(actual) !== canonical(expected)) throw new Error('plan_changes_frozen_business_field');
      }
    }
  }
  const receipt = immutable({ manifestHash: frozen.manifestHash, plan, planReceipt, boundAt, firstDispatchAt, contentBindings });
  issuedApprovals.add(receipt);
  return receipt;
}

/** An ID binding supplies object identity only. Exact text always comes from the frozen plan. */
export async function resolveManifestExport(frozen: FrozenManifest, approval: ApprovedPlanReceipt | null, idBindings: LogicalIdBinding[]) {
  assertFrozenManifest(frozen);
  if (approval && (!issuedApprovals.has(approval) || approval.manifestHash !== frozen.manifestHash)) throw new Error('untrusted_approved_content_receipt');
  const identities = idBindings.map(b => canonical([b.app, b.accountRef, b.matches[0]?.providerId]));
  if (new Set(identities).size !== identities.length) throw new Error('ambiguous_provider_identity');
  const bindingInput = { schemaVersion: 2, logicalManifestHash: frozen.manifestHash, planHash: approval?.plan.planHash ?? null,
    contentBindings: approval?.contentBindings ?? [], idBindings, concreteCheckerExportHash: '0'.repeat(64), checkerVersion: 'checker-v1' };
  parseCheckerExportBinding(bindingInput, frozen.manifest, frozen.manifestHash, approval?.plan ?? null);
  const ids = new Map(idBindings.map(b => [b.effectRef.effectKey, b.matches[0].providerId]));
  const resolvedManifest = structuredClone(frozen.manifest) as LogicalManifest;
  for (const effect of resolvedManifest.effects) {
    const planned = approval?.plan.effects.find(e => e.effectKey === effect.effectKey);
    const body = planned?.payload.body.map(part => part.type === 'text' ? part.text : part.type === 'effect_id' ? ids.get(part.effectKey)! :
      approval!.plan.contents.find(c => c.contentKey === part.contentKey)!.text).join('');
    for (const [field, value] of Object.entries(effect.requiredFields)) {
      if (Array.isArray(value)) effect.requiredFields[field] = value.map(v => typeof v === 'string' ? v : ids.get(v.effectKey)!) as string[];
      else if (value && typeof value === 'object') effect.requiredFields[field] = value.type === 'effect_id' ? ids.get(value.effectKey)! :
        field === 'bodySha256' ? await sha256Text(body!) : body!;
    }
  }
  const resolvedExportHash = digest(resolvedManifest);
  const binding = parseCheckerExportBinding({ ...bindingInput, concreteCheckerExportHash: resolvedExportHash }, frozen.manifest, frozen.manifestHash, approval?.plan ?? null);
  return immutable({ resolvedManifest, resolvedExportHash, binding });
}

/** Validate no-affected evidence scope. Q02 separately authenticates ingestion and resolves receipts. */
export function validateNoAffectedEvidence(frozen: FrozenManifest, value: unknown, selectionValue: unknown) {
  assertFrozenManifest(frozen);
  const claim = CompletionClaimSchema.parse(value);
  const selection = SelectionSchema.parse(selectionValue), scope = manifestScopes.get(frozen);
  if (frozen.manifest.expectedTerminalStatus !== 'completed_no_affected_commitments' || claim.scope !== 'no_affected' ||
      claim.selection.policyVersion !== frozen.manifest.versions.policy || !scope || selection.selected.length ||
      selection.policyVersion !== frozen.manifest.versions.policy || selection.sourceBundleRef.sha256 !== scope.sourceDigest ||
      claim.selection.receipt.sha256 !== digest(selection) || claim.selection.receipt.byteLength !== Buffer.byteLength(canonical(selection)))
    throw new Error('no_affected_manifest_mismatch');
  for (const app of ['github', 'hubspot'] as const) {
    const queryId = app === 'github' ? 'github.readTechnicalEvidence' : 'hubspot.readCommitmentBundle';
    const receipts = claim.sourceReceipts.filter(r => r.app === app);
    if (!receipts.length || receipts.some(r => r.accountRef !== scope.accounts[app] || !r.requiredQueryIds.includes(queryId) ||
        Date.parse(claim.emittedAt) - Date.parse(r.finishedAt) > frozen.manifest.claimWindow.maxEvidenceAgeMs)) throw new Error('no_affected_source_scope_mismatch');
  }
  const required = ['no_protected_writes', ...frozen.manifest.protectedRecords.map(r => `protected_${r.logicalId}`)];
  const actual = claim.absenceEvidence.map(e => e.predicateId);
  if (new Set(actual).size !== actual.length || required.some(id => !actual.includes(id))) throw new Error('incomplete_no_affected_absence_proof');
  return immutable(claim);
}
