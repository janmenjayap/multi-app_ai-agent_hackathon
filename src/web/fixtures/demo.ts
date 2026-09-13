import {
  ApiErrorSchema, PlanViewSchema, RunViewSchema, TraceViewSchema,
  type ApiError, type AssessmentSummaryView, type EffectView, type EvaluationSummaryView,
  type RunView, type StageView, type TraceView,
} from '../../shared/api.js';
import { PIPELINE_STAGE_IDS, RunIdSchema, immutable } from '../../shared/domain.js';

/** U01 browser-only examples, frozen against F02 and conventions v1.2.
 * Every receipt, identifier, label and result is invented; no provider or model ran.
 * Digest values identify display fixtures, not a persisted, integrity-checked plan.
 */
export interface ConsoleFixture {
  id: string;
  label: string;
  run?: RunView;
  trace?: TraceView;
  connection: 'synthetic' | 'offline' | 'reconnecting' | 'session_expired';
  error?: ApiError;
  notice?: string;
}

const CREATED_AT = '2026-09-14T09:00:00.000Z';
const UPDATED_AT = '2026-09-14T09:04:00.000Z';
const VERIFIED_AT = '2026-09-14T09:03:30.000Z';
const PLAN_HASH = 'a'.repeat(64);
const CONTENT_HASH = 'b'.repeat(64);
const BODY = 'Hi Maya,\n\nThe checkout API incident is affecting the production service covered by your Acme launch commitment. Our team is investigating. A recovery time has not been confirmed.\n\nWe will share another update after the next incident review.\n\nPromiseGuard demo team';
const RECIPIENT = 'maya@acme.example';
const SUBJECT = 'Acme launch commitment — checkout API incident update';
const COMMITMENT_ID = 'synthetic-acme-launch';

function reference(referenceId: string, label: string) {
  return { referenceId, label: `Synthetic · ${label}`, availability: 'available' as const,
    href: `/api/evidence/${referenceId}` };
}

const PLAN = PlanViewSchema.parse({
  revision: 1, planHash: PLAN_HASH,
  entries: [{ commitmentId: COMMITMENT_ID, companyId: 'synthetic-acme', ownerId: 'synthetic-owner-lee',
    recipient: RECIPIENT, subject: SUBJECT, body: BODY, draftOnly: true }],
  orderedEffectKeys: ['synthetic-acme-task', 'synthetic-acme-note', 'synthetic-acme-draft', 'synthetic-incident-comment', 'synthetic-summary-thread'],
  contents: [{ contentKey: 'synthetic-acme-update', text: BODY, sha256: CONTENT_HASH }],
  effects: [
    { effectKey: 'synthetic-acme-task', app: 'hubspot', kind: 'task', commitmentId: COMMITMENT_ID, requestDigest: '1'.repeat(64),
      payload: { companyId: 'synthetic-acme', commitmentId: COMMITMENT_ID, ownerId: 'synthetic-owner-lee',
        dueAt: '2026-09-14T12:00:00.000Z', status: 'NOT_STARTED', subject: 'Review Acme launch commitment',
        body: [{ type: 'text', text: 'Synthetic task: review checkout API incident impact with the Acme account owner.' }] } },
    { effectKey: 'synthetic-acme-note', app: 'hubspot', kind: 'note', commitmentId: COMMITMENT_ID, requestDigest: '2'.repeat(64),
      payload: { companyId: 'synthetic-acme', commitmentId: COMMITMENT_ID,
        taskId: { type: 'effect_id', effectKey: 'synthetic-acme-task' },
        body: [{ type: 'text', text: 'Synthetic note: checkout API degradation affects the production launch commitment.' }] } },
    { effectKey: 'synthetic-acme-draft', app: 'gmail', kind: 'draft', commitmentId: COMMITMENT_ID, requestDigest: '3'.repeat(64),
      payload: { to: RECIPIENT, cc: [], bcc: [], subject: SUBJECT, isDraft: true,
        body: [{ type: 'approved_content', planRevision: 1, contentKey: 'synthetic-acme-update' }] } },
    { effectKey: 'synthetic-incident-comment', app: 'github', kind: 'comment', commitmentId: null, requestDigest: '4'.repeat(64),
      payload: { repositoryId: 'synthetic-checkout', issueId: 'synthetic-issue-42',
        taskIds: [{ type: 'effect_id', effectKey: 'synthetic-acme-task' }],
        draftIds: [{ type: 'effect_id', effectKey: 'synthetic-acme-draft' }],
        body: [{ type: 'text', text: 'Synthetic incident comment linking the verified commitment task and draft.' }] } },
    { effectKey: 'synthetic-summary-thread', app: 'slack', kind: 'thread', commitmentId: null, requestDigest: '5'.repeat(64),
      payload: { channelId: 'SYNTHETIC_REVIEW', threadTs: 'synthetic-thread-42',
        body: [{ type: 'text', text: 'Synthetic final summary: task, note, Gmail draft and incident comment independently read back.' }] } },
  ],
});

const PENDING: AssessmentSummaryView = {
  status: 'pending', coverage: 'unavailable', evaluatorVersion: null, assessmentRevision: null,
  observedAt: null, watermark: null, requiredCount: 5, confirmedCount: 0, humanLabelCount: null, gaps: [],
};
const UNREVIEWED: AssessmentSummaryView = { ...PENDING, status: 'unverified', requiredCount: 1, humanLabelCount: 0,
  gaps: [{ code: 'synthetic_no_human_labels', referenceId: 'synthetic-original-draft' }] };
const PASSED: AssessmentSummaryView = {
  ...PENDING, status: 'pass', coverage: 'complete', evaluatorVersion: 'monitor-v2', assessmentRevision: 1,
  observedAt: UPDATED_AT, watermark: 'synthetic-watermark-24', confirmedCount: 5,
};
const FAILED: AssessmentSummaryView = {
  ...PASSED, status: 'fail', confirmedCount: 4,
  gaps: [{ code: 'synthetic_expected_observed_mismatch', referenceId: 'synthetic-readback-draft' }],
};
const NOT_APPLICABLE: AssessmentSummaryView = { ...PENDING, status: 'na', coverage: 'not_applicable', requiredCount: 0 };

function stages(current: StageView['stageId'], status: StageView['status']): StageView[] {
  const position = PIPELINE_STAGE_IDS.indexOf(current);
  return PIPELINE_STAGE_IDS.map((stageId, i) => {
    const role = stageId === 'analyst' || stageId === 'drafter' || stageId === 'auditor' ? stageId : null;
    const hasStarted = i <= position && status !== 'queued';
    return { stageId, role, status: i < position ? 'succeeded' : i === position ? status : 'not_started',
      startedAt: hasStarted ? CREATED_AT : null, updatedAt: hasStarted ? UPDATED_AT : null,
      attemptCount: hasStarted ? 1 : 0,
      latestAttemptRef: hasStarted ? reference(`synthetic-stage-${stageId}`, `${stageId} stage receipt; simulated only`) : null,
      reason: i === position ? `synthetic_${status}` : null };
  });
}

const PLANNED_EFFECTS: EffectView[] = PLAN.effects.map(effect => ({
  effectKey: effect.effectKey, app: effect.app, kind: effect.kind, state: 'planned', outcome: 'unattempted',
  result: null, providerId: null, providerLink: null, verifiedAt: null, comparison: 'pending', readbackRef: null, comparisons: [],
}));
const LINKS = [
  'https://app.hubspot.com/contacts/999999999/tasks/synthetic-task-42',
  'https://app.hubspot.com/contacts/999999999/record/0-2/synthetic-acme',
  'https://mail.google.com/mail/u/0/#drafts/synthetic-draft-42',
  'https://github.com/promiseguard-synthetic/checkout/issues/42#issuecomment-424242',
  'https://app.slack.com/archives/SYNTHETIC_REVIEW/p424242',
];
const VERIFIED_EFFECTS: EffectView[] = PLANNED_EFFECTS.map((effect, i) => {
  const readbackRef = reference(`synthetic-readback-${effect.kind}`, `${effect.app} ${effect.kind} independent readback at ${VERIFIED_AT}`);
  const comparisons: EffectView['comparisons'] = effect.kind === 'draft' ? [
    { field: 'recipient', expected: RECIPIENT, observed: RECIPIENT, verdict: 'matched', evidenceRef: readbackRef },
    { field: 'cc', expected: [], observed: [], verdict: 'matched', evidenceRef: readbackRef },
    { field: 'bcc', expected: [], observed: [], verdict: 'matched', evidenceRef: readbackRef },
    { field: 'subject', expected: SUBJECT, observed: SUBJECT, verdict: 'matched', evidenceRef: readbackRef },
    { field: 'body', expected: BODY, observed: BODY, verdict: 'matched', evidenceRef: readbackRef },
    { field: 'draftOnly', expected: true, observed: true, verdict: 'matched', evidenceRef: readbackRef },
  ] : effect.kind === 'task' ? [
    { field: 'owner', expected: 'synthetic-owner-lee', observed: 'synthetic-owner-lee', verdict: 'matched', evidenceRef: readbackRef },
    { field: 'company', expected: 'synthetic-acme', observed: 'synthetic-acme', verdict: 'matched', evidenceRef: readbackRef },
    { field: 'commitment', expected: COMMITMENT_ID, observed: COMMITMENT_ID, verdict: 'matched', evidenceRef: readbackRef },
    { field: 'dueAt', expected: '2026-09-14T12:00:00.000Z', observed: '2026-09-14T12:00:00.000Z', verdict: 'matched', evidenceRef: readbackRef },
    { field: 'status', expected: 'NOT_STARTED', observed: 'NOT_STARTED', verdict: 'matched', evidenceRef: readbackRef },
  ] : [{ field: 'artifactCount', expected: 1, observed: 1, verdict: 'matched', evidenceRef: readbackRef }];
  return { ...effect, state: 'verified', outcome: 'applied', result: 'created',
    providerId: `synthetic-${effect.kind}-42`, providerLink: LINKS[i]!, verifiedAt: VERIFIED_AT,
    comparison: 'matched', readbackRef, comparisons };
});

const BASE_RUN = RunViewSchema.parse({
  schemaVersion: 2, revision: 24, runId: 'synthetic-run-review', evaluationAttemptId: 'synthetic-evaluation-1',
  runtimeAttemptIds: ['synthetic-runtime-1'],
  incident: { url: 'https://github.com/promiseguard-synthetic/checkout/issues/42',
    title: '[Synthetic] Checkout API degradation threatens the Acme launch commitment', service: 'checkout-api', environment: 'production' },
  configuration: { schemaVersion: 2, modelMode: 'mock', providerMode: 'fake', evidenceMode: 'synthetic_fixture', fixtureId: 'synthetic-console-review' },
  productStatus: 'awaiting_approval', statusReason: 'synthetic_waiting_for_slack_review', stages: stages('approval', 'waiting'),
  commitments: { status: 'selected', policyVersion: 'synthetic-selection-v1',
    selected: [{ commitmentId: COMMITMENT_ID, company: 'Acme · synthetic company', reason: 'checkout_production_commitment_in_horizon' }],
    excluded: [{ commitmentId: 'synthetic-beta-analytics', reason: 'different_service_analytics_unaffected' }],
    evidenceRefs: [
      reference('synthetic-github-facts', 'GitHub: checkout-api is degraded in production; recovery time is unconfirmed. Retrieved 2026-09-14 09:00 UTC.'),
      reference('synthetic-hubspot-facts', 'HubSpot: Acme launch uses checkout-api; designated recipient maya@acme.example. Retrieved 2026-09-14 09:00 UTC.'),
      reference('synthetic-beta-facts', 'HubSpot: Beta analytics commitment uses another service and is excluded. Retrieval is complete.'),
    ] },
  plan: PLAN, approval: { status: 'waiting', planRevision: 1, planHash: PLAN_HASH,
    slackLink: 'https://app.slack.com/archives/SYNTHETIC_REVIEW/p424200', approver: null, decidedAt: null,
    expiresAt: '2026-09-14T10:00:00.000Z', invalidationReason: null },
  effects: PLANNED_EFFECTS, assessments: { trace: PENDING, outcome: PENDING, firstProposal: UNREVIEWED, selectedPlan: null },
  report: null, reportAvailability: 'pending', createdAt: CREATED_AT, updatedAt: UPDATED_AT, verifiedAt: null,
});

function run(id: string, changes: Partial<RunView> = {}): RunView {
  return RunViewSchema.parse({ ...structuredClone(BASE_RUN), runId: RunIdSchema.parse(`synthetic-run-${id}`),
    configuration: { ...BASE_RUN.configuration, fixtureId: `synthetic-console-${id}` }, ...changes });
}

const APPROVED = { ...BASE_RUN.approval!, status: 'approved' as const, approver: 'Synthetic reviewer Lee', decidedAt: '2026-09-14T09:02:00.000Z' };
const CORRECTED_PLAN = PlanViewSchema.parse({ ...PLAN, revision: 2, planHash: 'd'.repeat(64),
  effects: PLAN.effects.map(effect => effect.kind === 'draft' ? { ...effect, requestDigest: '6'.repeat(64),
    payload: { ...effect.payload, body: [{ type: 'approved_content', planRevision: 2, contentKey: 'synthetic-acme-update' }] },
  } : effect) });
const COMPLETE: Partial<RunView> = { productStatus: 'completed', statusReason: 'synthetic_product_readback_complete',
  stages: stages('assess', 'running'), approval: APPROVED, effects: VERIFIED_EFFECTS, verifiedAt: VERIFIED_AT };
const VERIFIED_ASSESSMENTS: RunView['assessments'] = { trace: PASSED, outcome: PASSED,
  firstProposal: { ...PASSED, requiredCount: 1, confirmedCount: 1, humanLabelCount: 1 }, selectedPlan: PASSED };

function report(id: string, changes: Partial<EvaluationSummaryView> = {}): EvaluationSummaryView {
  return {
    schemaVersion: 2, reportId: `synthetic-report-${id}`, revision: 3, cohortId: 'synthetic-u01-display-cohort',
    evaluatorVersion: 'monitor-v2', manifestVersion: '2', logicalManifestHash: 'c'.repeat(64),
    configuration: BASE_RUN.configuration, provenance: 'synthetic', cutoffAt: UPDATED_AT, observedAt: UPDATED_AT,
    watermark: 'synthetic-watermark-24', census: { planned: 1, attempted: 1, assessed: 1, failed: 0, unverified: 1, setupFailed: 0, notRun: 0 },
    metrics: [
      { metricId: 'M1', dimension: 'execution', role: null, numerator: 1, denominator: 1, value: 1, availability: 'available', sampleIds: ['synthetic-evaluation-1'] },
      { metricId: 'M7', dimension: 'original_proposal', role: 'drafter', numerator: 0, denominator: 0, value: null, availability: 'na', sampleIds: [] },
    ],
    criticalCounts: [{ code: 'duplicates', count: 0, availability: 'available', sampleIds: [] },
      { code: 'forbiddenEffects', count: 0, availability: 'available', sampleIds: [] },
      { code: 'approvalBypasses', count: 0, availability: 'available', sampleIds: [] },
      { code: 'falseCompletion', count: null, availability: 'unavailable', sampleIds: [] },
      { code: 'recoveryFailures', count: null, availability: 'unavailable', sampleIds: [] }],
    humanLabelCount: 0, gaps: [{ code: 'synthetic_no_human_labels', referenceId: 'synthetic-original-draft' }],
    reportRef: reference(`synthetic-report-${id}`, 'saved report example; counts are simulated, never measured'), ...changes,
  };
}

function trace(view: RunView): TraceView {
  const attempts: TraceView['attempts'] = [];
  for (const stage of view.stages) {
    if (!stage.attemptCount || !stage.role || stage.status === 'skipped') continue;
    attempts.push({ type: 'model', runtimeAttemptId: view.runtimeAttemptIds[0]!, logicalCallId: `synthetic-call-${stage.role}`,
      modelAttemptId: `synthetic-model-${stage.role}-1`, role: stage.role,
      outcome: stage.status === 'running' ? 'running' : stage.status === 'failed' ? 'refused' : 'valid',
      modelVersion: 'synthetic-mock-v1', promptVersion: `synthetic-${stage.role}-v1`, outputSchemaVersion: '2',
      startedAt: CREATED_AT, finishedAt: stage.status === 'running' ? null : UPDATED_AT,
      latencyMs: stage.status === 'running' ? null : 1200,
      reference: reference(`synthetic-model-${stage.role}-1`, 'simulated model attempt; no model was invoked'),
      originalOutputRef: stage.status === 'running' ? null : reference(`synthetic-original-${stage.role}`, 'original unedited mock proposal; never overwritten by correction') });
  }
  for (const effect of view.effects.filter(effect => effect.outcome !== 'unattempted')) {
    const isUnknown = effect.outcome === 'unknown';
    attempts.push({ type: 'provider', runtimeAttemptId: view.runtimeAttemptIds[0]!, logicalCallId: `synthetic-call-${effect.kind}`,
      providerAttemptId: `synthetic-provider-${effect.kind}-1`, app: effect.app,
      operation: `${effect.result === 'reused' ? 'reconcile' : 'create'}_${effect.kind}`,
      transport: 'fake', transportOutcome: isUnknown ? 'timeout' : 'response',
      providerOutcome: isUnknown ? 'unknown' : effect.outcome === 'not_applied' ? 'error' : 'success',
      reconciliation: effect.comparison === 'conflict' ? 'conflict' : effect.result === 'reused' ? 'adopted' : isUnknown ? 'unresolved' : 'not_required', startedAt: CREATED_AT,
      finishedAt: UPDATED_AT, latencyMs: isUnknown ? null : 180,
      reference: reference(`synthetic-provider-${effect.kind}-1`, 'simulated provider attempt; no external call occurred'), readbackRef: effect.readbackRef });
  }
  return TraceViewSchema.parse({ schemaVersion: 2, runId: view.runId, runRevision: view.revision,
    evaluationAttemptId: view.evaluationAttemptId, assessment: view.assessments.trace, attempts,
    nextCursor: 'synthetic_trace_end', hasMore: false });
}

function fixture(id: string, label: string, changes: Partial<RunView>, notice?: string): ConsoleFixture {
  const view = run(id, changes);
  return { id, label, run: view, trace: trace(view), connection: 'synthetic',
    notice: notice ?? 'Synthetic scenario. Model attempts, provider receipts and review labels are simulated; no external actions occurred.' };
}
function error(code: ApiError['code'], retryable = false): ApiError {
  return ApiErrorSchema.parse({ schemaVersion: 2, code, retryable, correlationId: `synthetic-error-${code}` });
}

const BEFORE_PLAN: Partial<RunView> = { plan: null, approval: null, effects: [], verifiedAt: null };
const PARTIAL_EFFECTS: EffectView[] = [VERIFIED_EFFECTS[0]!, VERIFIED_EFFECTS[1]!,
  { ...PLANNED_EFFECTS[2]!, state: 'inflight', outcome: 'unknown', comparison: 'missing_readback' },
  PLANNED_EFFECTS[3]!, PLANNED_EFFECTS[4]!];
const WRONG_RECIPIENT_EFFECTS: EffectView[] = VERIFIED_EFFECTS.map(effect => effect.kind === 'draft' ? {
  ...effect, comparison: 'mismatched', comparisons: effect.comparisons.map(comparison => comparison.field === 'recipient' ? {
    ...comparison, observed: 'unintended@beta.example', verdict: 'mismatched',
  } : comparison),
} : effect);

export const DEFAULT_FIXTURE_ID = 'awaiting_approval';

export const DEMO_FIXTURES: readonly ConsoleFixture[] = immutable([
  { id: 'no_run', label: 'No run selected', connection: 'synthetic', notice: 'Synthetic console preview. Select an example or enter a GitHub issue URL; no run has been selected.' },
  { id: 'validation_error', label: 'Command validation failure', connection: 'synthetic', error: error('invalid_request'),
    notice: 'Synthetic validation error. Enter a GitHub issue URL such as https://github.com/promiseguard-synthetic/checkout/issues/42.' },
  fixture('queued', 'Accepted · pending', { ...BEFORE_PLAN, productStatus: 'queued', statusReason: 'synthetic_command_accepted',
    stages: stages('ingest', 'queued'), commitments: { ...BASE_RUN.commitments, status: 'pending', selected: [], excluded: [], evidenceRefs: [], policyVersion: null } }),
  fixture('active_model', 'Active model stage', { ...BEFORE_PLAN, productStatus: 'running', statusReason: 'synthetic_analyst_running', stages: stages('analyst', 'running') }),
  fixture('active_provider', 'Active provider stage', { productStatus: 'running', statusReason: 'synthetic_provider_readback_running',
    approval: APPROVED, stages: stages('execute', 'running'), effects: [
      { ...VERIFIED_EFFECTS[0]!, state: 'applied', verifiedAt: null, comparison: 'pending', readbackRef: null, comparisons: [] }, ...PLANNED_EFFECTS.slice(1),
    ] }),
  fixture('awaiting_approval', 'Waiting for Slack approval', {}),
  fixture('approval_rejected', 'Slack approval rejected', { productStatus: 'safely_blocked',
    statusReason: 'synthetic_slack_approval_rejected', stages: stages('approval', 'blocked'),
    approval: { ...BASE_RUN.approval!, status: 'rejected', approver: 'Synthetic reviewer Lee', decidedAt: '2026-09-14T09:02:00.000Z' } },
  'Synthetic Slack rejection: the immutable plan remains available for review. All five effects are unattempted; a rejected decision grants no execution authority.'),
  fixture('approval_expired', 'Slack approval expired', { productStatus: 'safely_blocked',
    statusReason: 'synthetic_slack_approval_expired', stages: stages('approval', 'blocked'),
    approval: { ...BASE_RUN.approval!, status: 'expired', expiresAt: '2026-09-14T09:03:00.000Z' } },
  'Synthetic Slack approval window expired at 09:03 UTC. All five effects remain unattempted. Reopening this preview does not extend the approval window.'),
  fixture('approval_invalidated', 'Slack approval invalidated', { productStatus: 'safely_blocked',
    statusReason: 'synthetic_source_state_changed', stages: stages('approval', 'blocked'),
    approval: { ...APPROVED, status: 'invalidated', invalidationReason: 'synthetic_source_state_changed' } },
  'Synthetic source-state change invalidated the prior Slack approval before execution. The original plan and observed decision remain visible; all effects are unattempted.'),
  fixture('safely_blocked', 'Safely blocked · zero writes', { ...BEFORE_PLAN, productStatus: 'safely_blocked',
    statusReason: 'synthetic_missing_designated_recipient', stages: stages('select', 'blocked'),
    commitments: { ...BASE_RUN.commitments, status: 'blocked', selected: [] } },
  'Synthetic safe block: the designated recipient is missing. No plan, approval request or protected effect exists.'),
  fixture('incomplete_retrieval', 'Incomplete source retrieval', { ...BEFORE_PLAN, productStatus: 'failed',
    statusReason: 'synthetic_hubspot_page_failed', stages: stages('ingest', 'failed'),
    commitments: { ...BASE_RUN.commitments, status: 'incomplete', selected: [], excluded: [],
      evidenceRefs: [reference('synthetic-incomplete-collection', 'HubSpot retrieval is incomplete: the second commitments page failed. Selection cannot establish absence.')] } },
  'Synthetic source-page failure: commitment retrieval is incomplete. Empty displayed selection does not establish that no commitments are affected. No protected effects were attempted.'),
  fixture('failed', 'Model refused · no writes', { ...BEFORE_PLAN, productStatus: 'failed', statusReason: 'synthetic_drafter_refused', stages: stages('drafter', 'failed') }),
  fixture('failed_partial', 'Failed partial · accepted, unknown, unattempted', { productStatus: 'failed_partial', approval: APPROVED,
    statusReason: 'synthetic_draft_outcome_unknown', stages: stages('execute', 'failed'), effects: PARTIAL_EFFECTS },
  'Synthetic partial run: the HubSpot task and note were accepted and read back. Gmail draft outcome is unknown. GitHub comment and Slack summary were not attempted; reconciliation is required.'),
  fixture('conflicting_artifact', 'Failed partial · conflicting artifacts', { productStatus: 'failed_partial', approval: APPROVED,
    statusReason: 'synthetic_conflicting_draft_artifacts', stages: stages('execute', 'failed'),
    effects: PARTIAL_EFFECTS.map(effect => effect.kind === 'draft' ? { ...effect, comparison: 'conflict',
      readbackRef: reference('synthetic-draft-conflict', 'reconciliation found two candidate drafts; neither can be safely adopted'),
      comparisons: [{ field: 'artifactCount', expected: 1, observed: 2, verdict: 'mismatched',
        evidenceRef: reference('synthetic-draft-conflict', 'two matching candidates found during independent reconciliation') }],
    } : effect) },
  'Synthetic conflict: two candidate Gmail drafts prevent adoption of a unique approved artifact. The task and note remain accepted; later effects remain unattempted. No new draft may be created to resolve this ambiguity.'),
  fixture('reused_effect', 'Reconciled · existing artifact reused', { ...COMPLETE,
    effects: VERIFIED_EFFECTS.map(effect => effect.kind === 'draft' ? { ...effect, result: 'reused' } : effect) },
  'Synthetic reconciliation adopted the existing Gmail draft with the same provider ID and verified its fields. Reused means no additional draft was created; reliability assessment is still pending.'),
  fixture('completed_pending_assessment', 'Completed · assessment pending', COMPLETE,
    'Synthetic product readbacks are complete. Independent assessments remain pending and original proposal quality is unverified.'),
  fixture('completed_contradicted', 'Completed · wrong observed recipient', { ...COMPLETE, effects: WRONG_RECIPIENT_EFFECTS,
    stages: stages('assess', 'succeeded'), assessments: { ...BASE_RUN.assessments, trace: PASSED, outcome: FAILED } },
  'Synthetic completed product record with a contradicted independent outcome: expected maya@acme.example; observed unintended@beta.example. Completion is not an overall pass.'),
  fixture('completed_verified', 'Completed · independently verified example', { ...COMPLETE, stages: stages('assess', 'succeeded'),
    assessments: VERIFIED_ASSESSMENTS, reportAvailability: 'available', report: report('verified', {
      humanLabelCount: 1, census: { planned: 1, attempted: 1, assessed: 1, failed: 0, unverified: 0, setupFailed: 0, notRun: 0 }, gaps: [],
    }) }, 'Synthetic verified-state example. The passing assessments and one reviewer label are invented fixture data, not collected evidence or a real human review.'),
  fixture('no_affected', 'No affected commitments · absence verified', { ...BEFORE_PLAN, productStatus: 'completed_no_affected_commitments',
    statusReason: 'synthetic_complete_empty_selection_and_absence_verified', verifiedAt: VERIFIED_AT,
    commitments: { ...BASE_RUN.commitments, status: 'empty', selected: [],
      excluded: [{ commitmentId: COMMITMENT_ID, reason: 'outside_commitment_horizon' }, ...BASE_RUN.commitments.excluded],
      evidenceRefs: [...BASE_RUN.commitments.evidenceRefs, reference('synthetic-absence-readback', 'independent absence evidence: no task, note, draft, comment or summary created; protected records unchanged')] },
    stages: stages('assess', 'succeeded').map(stage => ['analyst', 'drafter', 'auditor', 'approval', 'execute'].includes(stage.stageId) ?
      { ...stage, status: 'skipped', attemptCount: 0, startedAt: null, updatedAt: null, latestAttemptRef: null, reason: 'synthetic_no_affected_commitments' } : stage),
    assessments: { trace: PASSED, outcome: PASSED, firstProposal: NOT_APPLICABLE, selectedPlan: null } },
  'Synthetic complete retrieval and independent absence evidence confirm no affected commitments. No model work, plan, approval, protected write or final Slack summary is required.'),
  fixture('report_pending', 'Saved report pending', { ...COMPLETE, reportAvailability: 'pending' }),
  fixture('report_unavailable', 'Saved report unavailable', { ...COMPLETE, reportAvailability: 'unavailable' },
    'Synthetic report-unavailable state. Product readback is retained; missing report data is not replaced with a passing result.'),
  fixture('zero_labels', 'Unverified · zero human labels', { ...COMPLETE, reportAvailability: 'available', report: report('zero-labels'),
    assessments: { ...BASE_RUN.assessments, trace: PASSED, outcome: PASSED } },
  'Synthetic label coverage: Unverified (0 reviewed). Original model quality is not established by product or process completion.'),
  fixture('zero_denominator', 'N/A · zero eligible metric denominator', { ...COMPLETE, reportAvailability: 'available', report: report('zero-denominator', {
    metrics: [{ metricId: 'M1', dimension: 'execution', role: null, numerator: 0, denominator: 0, value: null, availability: 'na', sampleIds: [] },
      { metricId: 'M6', dimension: 'recovery', role: null, sampleCount: 0, censoredCount: 0, availability: 'na', medianMs: null, maxMs: null, sampleIds: [] }],
  }) }, 'Synthetic saved counts: 0 / 0 renders N/A (0 eligible), never 0% or 100%. No metric is calculated in the browser.'),
  { ...fixture('offline', 'Offline · retained last-known run', {}, 'Synthetic offline state. Showing last-known revision 24 from 09:04 UTC; backend progress is unknown.'), connection: 'offline' },
  { ...fixture('reconnecting', 'Reconnecting · event replay', {}, 'Synthetic reconnect: duplicate events and older event pages are represented by this retained revision. No new model work or writes are implied.'), connection: 'reconnecting' },
  { ...fixture('stale_revision', 'Stale run revision rejected', {}, 'Synthetic stale projection: revision 23 was rejected; last-known revision 24 remains visible. This preview does not poll a backend.'), error: error('stale_revision', true) },
  { ...fixture('stale_report', 'Stale report revision rejected', { ...COMPLETE, reportAvailability: 'available', report: report('retained-report') },
    'Synthetic stale report: incoming revision 2 was rejected; saved revision 3 remains visible. This preview does not implement transport.'), error: error('stale_revision', true) },
  { id: 'unauthorized', label: 'Unauthorized run', connection: 'synthetic', error: error('forbidden'),
    notice: 'Synthetic authorization error. The requested run is not available to this operator; no run data is disclosed.' },
  { ...fixture('unauthorized_evidence', 'Unauthorized evidence reference', { commitments: { ...BASE_RUN.commitments,
    evidenceRefs: [{ referenceId: 'synthetic-restricted-source', label: 'Synthetic · restricted evidence reference', availability: 'unauthorized', href: null }] } },
    'Synthetic authorization error for a source reference. The redacted run remains readable; the restricted reference cannot be opened.'), error: error('forbidden') },
  { ...fixture('session_expired', 'Operator session expired', {}, 'Synthetic expired session. Retained redacted content is read-only; authenticate before commands or polling resume.'),
    connection: 'session_expired', error: error('unauthenticated') },
  fixture('monitor_unavailable', 'Backend ready · monitor unavailable', { ...COMPLETE, reportAvailability: 'unavailable',
    assessments: { ...BASE_RUN.assessments, trace: { ...PENDING, gaps: [{ code: 'synthetic_monitor_unavailable', referenceId: null }] } } },
  'Synthetic health state: backend storage and checkpoints are ready; monitor is temporarily unavailable. Product state remains completed and assessment remains pending.'),
  fixture('corrected_plan', 'Original proposal failed · corrected plan passed', { ...COMPLETE, stages: stages('assess', 'succeeded'),
    plan: CORRECTED_PLAN, approval: { ...APPROVED, planRevision: CORRECTED_PLAN.revision, planHash: CORRECTED_PLAN.planHash },
    assessments: { trace: PASSED, outcome: PASSED, firstProposal: { ...FAILED, requiredCount: 1, confirmedCount: 0, humanLabelCount: 1,
      gaps: [{ code: 'synthetic_original_claim_unsupported_recovery_time', referenceId: 'synthetic-original-drafter' }] }, selectedPlan: PASSED } },
  'Synthetic original draft falsely said “service will recover by noon.” The source gave no recovery time. The selected corrected plan passes; the original first proposal remains failed. The reviewer label is simulated.'),
  fixture('claim_contradiction', 'Claim-time contradiction', { ...COMPLETE, effects: WRONG_RECIPIENT_EFFECTS, stages: stages('assess', 'succeeded'),
    assessments: { ...BASE_RUN.assessments, trace: PASSED, outcome: FAILED }, reportAvailability: 'available', report: report('claim-contradiction', {
      criticalCounts: [{ code: 'successClaims', count: 1, availability: 'available', sampleIds: ['synthetic-claim-1'] },
        { code: 'outcomeContradictedCompletionClaims', count: 1, availability: 'available', sampleIds: ['synthetic-claim-1'] },
        { code: 'falseCompletion', count: 1, availability: 'available', sampleIds: ['synthetic-claim-1'] }],
      gaps: [{ code: 'synthetic_claim_time_recipient_contradiction', referenceId: 'synthetic-claim-1' }],
    }) }, 'Synthetic claim-time contradiction: the recipient was already wrong when completion was claimed. This is distinct from later provider drift.'),
  fixture('later_drift', 'Later provider drift', { ...COMPLETE, stages: stages('assess', 'succeeded'),
    effects: VERIFIED_EFFECTS.map(effect => effect.kind === 'draft' ? { ...effect, comparison: 'drift',
      readbackRef: reference('synthetic-later-readback', 'later independent observation at 09:04 UTC; product readback at 09:03:30 UTC remains recorded'),
      comparisons: effect.comparisons.map(comparison => comparison.field === 'subject' ? { ...comparison,
        observed: 'Synthetic later edit by another actor', verdict: 'mismatched',
        evidenceRef: reference('synthetic-later-readback', 'later subject edit observed at 09:04 UTC, after the completion claim'),
      } : comparison) } : effect),
    assessments: { ...BASE_RUN.assessments, trace: PASSED, outcome: { ...FAILED,
      gaps: [{ code: 'synthetic_drift_after_claim_window', referenceId: 'synthetic-later-readback' }] } } },
  'Synthetic later drift: readback matched at 09:03:30 UTC; a later subject edit was observed at 09:04 UTC. The original completion claim is not automatically reclassified as a claim-time contradiction.'),
  fixture('missing_provider_fields', 'Provider field unavailable · missing S1', { ...COMPLETE, effects: VERIFIED_EFFECTS.map(effect => effect.kind === 'draft' ? {
    ...effect, comparison: 'unverified', comparisons: effect.comparisons.map(comparison => comparison.field === 'recipient' ?
      { ...comparison, observed: null, verdict: 'unavailable', evidenceRef: null } : comparison),
  } : effect), assessments: { ...BASE_RUN.assessments, trace: PASSED, outcome: { ...PENDING, status: 'incomplete', coverage: 'incomplete',
    requiredCount: 5, confirmedCount: 4, gaps: [{ code: 'synthetic_missing_s1_recipient_field', referenceId: 'synthetic-readback-draft' }] } } },
  'Synthetic independent S1 snapshot is missing the recipient field. Expected recipient remains maya@acme.example; observed is unavailable, not an empty value or a match.'),
]);
