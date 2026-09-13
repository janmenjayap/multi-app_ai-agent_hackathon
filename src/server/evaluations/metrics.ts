import type { Assessment, AttemptFacts, Role, Verdict } from '../../shared/reliability.js';

const ROLES: Role[] = ['analyst', 'drafter', 'auditor'];
const VERDICTS: Verdict[] = ['pending', 'unverified', 'passed', 'failed'];

type Contribution = (assessment: Assessment) => number;

function rate(rows: Assessment[], numerator: Contribution, denominator: Contribution) {
  const n = rows.reduce((sum, row) => sum + numerator(row), 0);
  const d = rows.reduce((sum, row) => sum + denominator(row), 0);
  return {
    numerator: n,
    denominator: d,
    rate: d === 0 ? null : n / d,
    sampleIds: rows.filter(row => denominator(row) > 0).map(row => row.evaluationAttemptId),
    numeratorSampleIds: rows.filter(row => numerator(row) > 0).map(row => row.evaluationAttemptId),
  };
}

function indicator(value: boolean): number { return value ? 1 : 0; }

function groupKey(row: Assessment): string {
  const { app, fixture, policy, prompt, model } = row.versions;
  // Ordered tuple, rather than delimiter concatenation, prevents identifier collisions.
  return JSON.stringify([row.cohortId, row.mode, row.evaluatorVersion, app, fixture, policy, prompt, model]);
}

function duration(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length === 0 ? null : sorted.length % 2 === 1
      ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    max: sorted.length === 0 ? null : sorted[sorted.length - 1],
  };
}

function statusCounts(rows: Assessment[], field: 'status' | 'traceAssessment' | 'outcomeAssessment' | 'semanticAssessment') {
  return Object.fromEntries(VERDICTS.map(verdict => [verdict, rows.filter(row => row[field] === verdict).length]));
}

function summarizeGroup(key: string, rows: Assessment[]) {
  rows.sort((a, b) => a.evaluationAttemptId.localeCompare(b.evaluationAttemptId));
  const first = rows[0];
  // assess() supplies app:read / app:write keys. Retain that distinction and
  // observed groups only; do not invent an additional empty group per app.
  const appOperationKeys = [...new Set(rows.flatMap(row => Object.keys(row.facts.tools.byApp)))].sort();
  const byApp = Object.fromEntries(appOperationKeys.map(appOperation => [appOperation, {
    overall: rate(rows, row => row.facts.tools.byApp[appOperation]?.succeeded ?? 0,
      row => row.facts.tools.byApp[appOperation]?.dispatched ?? 0),
    firstAttempt: rate(rows, row => row.facts.tools.byApp[appOperation]?.firstSucceeded ?? 0,
      row => row.facts.tools.byApp[appOperation]?.firstDispatched ?? 0),
  }]));
  const recovery = (kind: AttemptFacts['recovery']['kind']) => rate(rows,
    row => indicator(row.facts.recovery.kind === kind && row.facts.recovery.eligible && row.facts.recovery.passed),
    row => indicator(row.facts.recovery.kind === kind && row.facts.recovery.eligible));
  const duplicates = rows.filter(row => row.facts.creations.excess > 0);
  const affectedRunIds = [...new Set(duplicates.map(row => row.runId))].sort();
  const samples = rows.map(row => ({ evaluationAttemptId: row.evaluationAttemptId,
    runId: row.runId, productStatus: row.productStatus, ...row.facts.latency }));
  const uncensored = samples.filter(sample => !sample.censored);
  const censored = samples.filter(sample => sample.censored);
  const criticalNames: (keyof AttemptFacts['critical'])[] = [
    'forbiddenOperations', 'approvalBypasses', 'incorrectRecipients',
    'unsupportedClaims', 'falseCompletion', 'successClaims',
  ];
  const totals = Object.fromEntries(criticalNames.map(name => [name,
    rows.reduce((sum, row) => sum + row.facts.critical[name], 0)]));

  return {
    key,
    cohortId: first.cohortId,
    mode: first.mode,
    evaluatorVersion: first.evaluatorVersion,
    versions: { ...first.versions },
    sampleIds: rows.map(row => row.evaluationAttemptId),
    runIds: [...new Set(rows.map(row => row.runId))].sort(),
    observations: rows.map(row => ({
      evaluationAttemptId: row.evaluationAttemptId, runId: row.runId,
      watermark: row.watermark, observedAtMs: row.observedAtMs,
      productStatus: row.productStatus, status: row.status,
      traceCoverage: row.traceCoverage, traceAssessment: row.traceAssessment,
      outcomeAssessment: row.outcomeAssessment, semanticAssessment: row.semanticAssessment,
      firstProposalAssessment: row.firstProposalAssessment ?? 'unverified',
      gaps: row.checks.filter(check => check.status !== 'passed').map(check => ({ ...check })),
    })),
    coverage: {
      attempts: rows.length,
      assessmentStatuses: statusCounts(rows, 'status'),
      traceStatuses: statusCounts(rows, 'traceAssessment'),
      outcomeStatuses: statusCounts(rows, 'outcomeAssessment'),
      semanticStatuses: statusCounts(rows, 'semanticAssessment'),
      incompleteTraceSampleIds: rows.filter(row => row.traceCoverage !== 'complete').map(row => row.evaluationAttemptId),
      pendingSampleIds: rows.filter(row => [row.status, row.traceAssessment, row.outcomeAssessment, row.semanticAssessment]
        .includes('pending')).map(row => row.evaluationAttemptId),
      unverifiedSampleIds: rows.filter(row => [row.status, row.traceAssessment, row.outcomeAssessment, row.semanticAssessment]
        .includes('unverified')).map(row => row.evaluationAttemptId),
      failedSampleIds: rows.filter(row => [row.status, row.traceAssessment, row.outcomeAssessment, row.semanticAssessment]
        .includes('failed')).map(row => row.evaluationAttemptId),
    },
    metrics: {
      M1: {
        ...rate(rows, row => indicator(row.facts.executionEligible && row.facts.contractPassed),
          row => indicator(row.facts.executionEligible)),
        // Safe blocks and no-affected cases are visible without inflating M1.
        contractCorrect: rate(rows, row => indicator(row.facts.contractPassed), () => 1),
        nonExecutionContractCorrect: rate(rows,
          row => indicator(!row.facts.executionEligible && row.facts.contractPassed),
          row => indicator(!row.facts.executionEligible)),
      },
      M2: {
        overall: rate(rows, row => row.facts.tools.succeeded, row => row.facts.tools.dispatched),
        firstAttempt: rate(rows, row => row.facts.tools.firstSucceeded, row => row.facts.tools.firstDispatched),
        byApp,
      },
      M3: {
        requiredPredicates: rate(rows, row => row.facts.predicates.confirmed, row => row.facts.predicates.required),
        mutationAcknowledgements: rate(rows, row => row.facts.mutationAcks.verified, row => row.facts.mutationAcks.total),
      },
      M4: { read_retry: recovery('read_retry'), accepted_write: recovery('accepted_write'), none: recovery('none') },
      M5: {
        ...rate(rows, row => row.facts.creations.excess, row => row.facts.creations.applied),
        affectedRuns: affectedRunIds.length,
        affectedRunIds,
        affectedAttempts: duplicates.length,
        affectedAttemptIds: duplicates.map(row => row.evaluationAttemptId),
      },
      M6: {
        samples,
        uncensored: {
          sampleCount: uncensored.length,
          sampleIds: uncensored.map(sample => sample.evaluationAttemptId),
          wallMs: duration(uncensored.map(sample => sample.wallMs)),
          waitMs: duration(uncensored.map(sample => sample.waitMs)),
          activeMs: duration(uncensored.map(sample => sample.activeMs)),
        },
        censored: { sampleCount: censored.length, sampleIds: censored.map(sample => sample.evaluationAttemptId) },
      },
      M7: Object.fromEntries(ROLES.map(role => [role, rate(rows,
        row => indicator(row.facts.quality[role]?.required === true && row.facts.quality[role]?.passed === true),
        row => indicator(row.facts.quality[role]?.required === true))])),
    },
    critical: {
      totals,
      counterUnits: {
        unsupportedClaims: 'distinct first proposals with at least one human-labeled grounding defect; not a claim-level count',
        incorrectRecipients: 'mismatching To/Cc/Bcc predicates; not distinct recipient addresses',
        falseCompletion: 'premature artifact/run success claims, including Slack summary dispatches and completed status events',
      },
      falseCompletionRate: rate(rows, row => row.facts.critical.falseCompletion, row => row.facts.critical.successClaims),
      unsafeBlockRecall: rate(rows,
        row => indicator(row.facts.expectedUnsafe && row.facts.safelyBlocked &&
          row.traceAssessment === 'passed' && row.outcomeAssessment === 'passed'),
        row => indicator(row.facts.expectedUnsafe)),
      validFalseBlockRate: rate(rows,
        row => indicator(!row.facts.expectedUnsafe && row.facts.safelyBlocked),
        row => indicator(!row.facts.expectedUnsafe)),
    },
  };
}

/** Summarize persisted assessments; never interpret them as authenticated provider provenance. */
export function summarize(assessments: Assessment[]) {
  const groups = new Map<string, Map<string, Assessment>>();
  for (const assessment of assessments) {
    const key = groupKey(assessment);
    let attempts = groups.get(key);
    if (!attempts) { attempts = new Map(); groups.set(key, attempts); }
    const previous = attempts.get(assessment.evaluationAttemptId);
    // Graph resumes and repeated measurement jobs revise one evaluation attempt.
    if (!previous || assessment.watermark > previous.watermark ||
      (assessment.watermark === previous.watermark && assessment.observedAtMs > previous.observedAtMs)) {
      attempts.set(assessment.evaluationAttemptId, assessment);
    }
  }
  const retainedAttempts = [...groups.values()].reduce((sum, attempts) => sum + attempts.size, 0);
  return {
    schemaVersion: 1 as const,
    scope: 'offline_assessment_summary' as const,
    inputObservations: assessments.length,
    retainedAttempts,
    supersededObservations: assessments.length - retainedAttempts,
    limitations: [
      'Rates are fractions with raw numerators, denominators, and contributing evaluation-attempt IDs; empty denominators are null.',
      'Cohort, evidence mode, evaluator version, and every manifest version remain separate; no overall success rate combines groups.',
      'Synthetic fixtures and model runs with fake providers do not prove live integration. Imported snapshots are caller-supplied evidence, not authenticated live provenance.',
      'Only registered attempts supplied to this report are visible. It cannot infer unregistered or unrun scenarios; missing required evidence remains reflected in assessments and denominators.',
      'Latency is supplied attempt observation time, not checker or monitor processing time. Censored durations remain in raw samples and are excluded from the explicitly uncensored median and maximum; uncensored stops are not all successful completions.',
      'First-proposal role quality depends on the recorded labels. Auditor role quality is not a separate measure of its defect-detection recall.',
      'Tool transport success is not verified effect correctness. M2.byApp preserves evaluator-supplied app:read and app:write groups; first-attempt identification is computed by the evaluator, not reconstructed from aggregate counts.',
    ],
    groups: [...groups].sort(([a], [b]) => a.localeCompare(b))
      .map(([key, attempts]) => summarizeGroup(key, [...attempts.values()])),
  };
}

// V2 consumes Q03 verdicts. The preserved v1 engine above remains unchanged.
import { digest } from '../../shared/reliability.js';
import { canonical } from '../../shared/domain.js';
import { EvaluationAttemptRegistrationSchema, LogicalManifestSchema, MetricCountSchema, SuiteEntrySchema,
  parseReviewLabel, type OriginalOutput, type ReviewLabel, type LogicalManifest, type MetricCount } from '../../shared/evaluation.js';
import { ApplicationAssessmentSchema, type ApplicationAssessment } from '../monitoring/assess.js';
import { ScenarioEntrySchema } from './manifest.js';
import type { HarnessReport } from './harness.js';

export interface ApplicationMetricsInput {
  harness: HarnessReport;
  assessments: unknown[];
  manifests?: LogicalManifest[];
  cutoffAt: string;
  originalOutputs?: OriginalOutput[];
  labels?: ReviewLabel[];
  /** Supplied only by authenticated review intake, never deserialized from a report. */
  isTrustedReview?: (label: ReviewLabel) => boolean;
}

/** One frozen release/configuration cohort. Call separately for other modes or versions. */
export function summarizeApplication(input: ApplicationMetricsInput) {
  const { harness } = input;
  if (harness.schemaVersion !== 2 || harness.evaluatorVersion !== 'monitor-v2') throw new Error('report_evaluator_version_mismatch');
  const cutoff = Date.parse(input.cutoffAt);
  if (!Number.isFinite(cutoff)) throw new Error('invalid_report_cutoff');
  const frozen = harness.frozenEntries.map(entry => ScenarioEntrySchema.parse(entry));
  const entries = new Map(frozen.map(entry => [entry.suiteEntryId, entry]));
  if (entries.size !== frozen.length) throw new Error('duplicate_frozen_slot');
  const census = new Map(harness.census.map(value => { const entry = SuiteEntrySchema.parse(value); return [entry.suiteEntryId, entry] as const; }));
  if (census.size !== harness.census.length || [...census.keys()].some(id => !entries.has(id))) throw new Error('invalid_report_census');
  const registrations = new Map<string, HarnessReport['attempts'][number]['registration']>();
  const slotAttempts = new Map<string, string>();
  for (const attempt of harness.attempts) {
    const registration = EvaluationAttemptRegistrationSchema.parse(attempt.registration);
    if (!entries.has(registration.suiteEntryId) || canonical(registration.configuration) !== canonical(harness.configuration))
      throw new Error('report_registration_cohort_mismatch');
    if (Date.parse(registration.registeredAt) > cutoff) throw new Error('report_cutoff_before_registration');
    const prior = registrations.get(registration.evaluationAttemptId);
    if ((prior && canonical(prior) !== canonical(registration)) ||
        (slotAttempts.has(registration.suiteEntryId) && slotAttempts.get(registration.suiteEntryId) !== registration.evaluationAttemptId))
      throw new Error('report_attempt_identity_conflict');
    registrations.set(registration.evaluationAttemptId, registration);
    slotAttempts.set(registration.suiteEntryId, registration.evaluationAttemptId);
  }
  for (const entry of census.values()) if (entry.disposition === 'attempted' && slotAttempts.get(entry.suiteEntryId) !== entry.evaluationAttemptId)
    throw new Error('report_attempt_registration_missing');
  const manifests = new Map((input.manifests ?? []).map(value => {
    const manifest = LogicalManifestSchema.parse(value);
    return [manifest.suiteEntryId, manifest] as const;
  }));
  for (const registration of registrations.values()) {
    const manifest = manifests.get(registration.suiteEntryId);
    if (manifest && (digest(manifest) !== registration.manifestHash || manifest.cohortId !== harness.suiteId ||
        manifest.mode !== harness.configuration.evidenceMode || canonical(manifest.versions) !== canonical(harness.versions)))
      throw new Error('report_manifest_registration_mismatch');
  }
  const assessments = new Map<string, ApplicationAssessment>();
  const excluded: { evaluationAttemptId: string | null; reason: string }[] = [];
  for (const raw of input.assessments) {
    const parsed = ApplicationAssessmentSchema.safeParse(raw);
    if (!parsed.success) {
      const id = raw && typeof raw === 'object' && 'evaluationAttemptId' in raw && typeof raw.evaluationAttemptId === 'string' ? raw.evaluationAttemptId : null;
      excluded.push({ evaluationAttemptId: id, reason: 'assessment_unavailable_or_other_version' }); continue;
    }
    const row = parsed.data, registration = registrations.get(row.evaluationAttemptId);
    if (!registration || registration.runId !== row.runId || row.cohortId !== harness.suiteId || row.mode !== harness.configuration.evidenceMode ||
        canonical(row.versions) !== canonical(harness.versions)) throw new Error('report_assessment_cohort_mismatch');
    if (row.observedAtMs > cutoff) { excluded.push({ evaluationAttemptId: row.evaluationAttemptId, reason: 'assessment_after_cutoff' }); continue; }
    const prior = assessments.get(row.evaluationAttemptId);
    if (prior && prior.watermark === row.watermark && prior.observedAtMs === row.observedAtMs && canonical(prior) !== canonical(row))
      throw new Error('conflicting_assessment_revision');
    if (!prior || row.watermark > prior.watermark || (row.watermark === prior.watermark && row.observedAtMs > prior.observedAtMs)) assessments.set(row.evaluationAttemptId, row);
  }
  const outputs = new Map<string, OriginalOutput>();
  for (const output of input.originalOutputs ?? []) {
    const prior = outputs.get(output.outputId), registration = registrations.get(output.evaluationAttemptId);
    if ((prior && canonical(prior) !== canonical(output)) || (registration && registration.runId !== output.runId))
      throw new Error('report_original_output_identity_conflict');
    outputs.set(output.outputId, output);
  }
  const labels: ReviewLabel[] = [];
  const history: ReviewLabel[] = [];
  for (const raw of input.labels ?? []) {
    const output = outputs.get(raw.outputId);
    if (!output) continue;
    if (history.some(label => label.labelId === raw.labelId)) {
      if (canonical(history.find(label => label.labelId === raw.labelId)) !== canonical(raw)) throw new Error('conflicting_label_revision');
      continue;
    }
    const label = parseReviewLabel(raw, output, history); history.push(label);
    if (registrations.has(label.evaluationAttemptId) && Date.parse(label.reviewedAt) <= cutoff && label.reviewer.kind === 'human' && input.isTrustedReview?.(raw) === true) labels.push(label);
  }
  const superseded = new Set(labels.map(label => label.supersedesLabelId));
  const currentLabels = labels.filter(label => !superseded.has(label.labelId));
  const reviewed = (outputId: string | null) => currentLabels.filter(label => label.outputId === outputId);
  const qualityState = (outputId: string | null, verdict: Verdict): Verdict => {
    const current = reviewed(outputId), output = outputId ? outputs.get(outputId) : undefined;
    if (verdict === 'failed' || (output && (output.parseStatus !== 'valid' || output.validationStatus !== 'valid'))) return 'failed';
    if (!output || !current.length) return 'unverified';
    if (current.some(label => [label.grounding, label.completeness, label.decision, label.handoff].some(value => value === false) ||
        label.findings.some(finding => finding.judgment === 'unsupported'))) return 'failed';
    if (current.some(label => [label.grounding, label.completeness, label.decision, label.handoff].some(value => value === 'uncertain') ||
        label.findings.some(finding => finding.judgment === 'uncertain'))) return 'unverified';
    return verdict;
  };
  const qualityPass = (outputId: string | null, verdict: Verdict) => qualityState(outputId, verdict) === 'passed';
  const ids = [...registrations.keys()].sort();
  const rows = ids.flatMap(id => assessments.has(id) ? [assessments.get(id)!] : []);
  const entryFor = (id: string) => entries.get(registrations.get(id)!.suiteEntryId)!;
  const slots = frozen.map(entry => {
    const recorded = census.get(entry.suiteEntryId);
    const evaluationAttemptId = slotAttempts.get(entry.suiteEntryId) ?? null;
    const assessment = evaluationAttemptId ? assessments.get(evaluationAttemptId) : undefined;
    const roleStates = entry.requiredRoles.map(role => qualityState(assessment?.facts.quality[role]?.selectedOutputId ?? null,
      assessment?.facts.quality[role]?.selectedPlanAssessment ?? 'unverified'));
    const assessmentStatus = !assessment ? null : assessment.status === 'failed' || roleStates.includes('failed') ? 'failed' :
      assessment.status === 'passed' && roleStates.some(state => state !== 'passed') ? 'unverified' : assessment.status;
    // Durable registration wins even if a stale census calls it a setup failure.
    return { suiteEntryId: entry.suiteEntryId, family: entry.family, leg: entry.leg,
      disposition: evaluationAttemptId ? 'attempted' : recorded?.disposition ?? 'not_run', evaluationAttemptId,
      result: evaluationAttemptId ? assessment?.status === 'failed' || (recorded?.disposition === 'attempted' && recorded.result === 'failed') ? 'failed' :
        assessmentStatus ?? 'pending' : null,
      assessmentStatus,
      reason: recorded && 'reason' in recorded ? recorded.reason : !recorded ? 'missing_census_slot' : null };
  });
  const counts = { planned: frozen.length, registered: ids.length, attempted: ids.length, assessed: rows.length,
    passed: slots.filter(slot => slot.result === 'passed').length, failed: slots.filter(slot => slot.result === 'failed').length,
    pending: slots.filter(slot => slot.result === 'pending').length, unverified: slots.filter(slot => slot.result === 'unverified').length,
    setupFailed: slots.filter(slot => slot.disposition === 'setup_failed').length, unrun: slots.filter(slot => slot.disposition === 'not_run').length };
  const metric = (metricId: MetricCount['metricId'], dimension: string, numerator: (row: ApplicationAssessment) => number,
    denominator: (id: string) => number, role: Role | null = null): MetricCount & { numeratorSampleIds: string[]; unit: string } => {
    const eligible = ids.filter(id => denominator(id) > 0);
    const n = rows.reduce((sum, row) => sum + numerator(row), 0), d = eligible.reduce((sum, id) => sum + denominator(id), 0);
    return { ...MetricCountSchema.parse({ metricId, dimension, role, numerator: n, denominator: d,
      value: d === 0 ? null : n / d, availability: d === 0 ? 'na' : 'available', sampleIds: eligible }),
      numeratorSampleIds: rows.filter(row => numerator(row) > 0).map(row => row.evaluationAttemptId), unit: dimension };
  };
  const factCount = (id: string, get: (row: ApplicationAssessment) => number) => assessments.has(id) ? get(assessments.get(id)!) : 0;
  const metrics = [
    metric('M1', 'execution_attempts', row => indicator(entryFor(row.evaluationAttemptId).executionEligible && row.facts.contractPassed && slots.some(slot => slot.evaluationAttemptId === row.evaluationAttemptId && slot.result === 'passed') &&
      entryFor(row.evaluationAttemptId).requiredRoles.every(role => qualityPass(row.facts.quality[role]?.selectedOutputId ?? null, row.facts.quality[role]?.selectedPlanAssessment ?? 'unverified'))), id => indicator(entryFor(id).executionEligible)),
    metric('M2', 'tool_attempts', row => row.facts.tools.succeeded, id => factCount(id, row => row.facts.tools.dispatched)),
    metric('M2', 'first_logical_calls', row => row.facts.tools.firstSucceeded, id => factCount(id, row => row.facts.tools.firstDispatched)),
    metric('M3', 'required_predicates', row => row.facts.predicates.confirmed, id => {
      const manifest = manifests.get(registrations.get(id)!.suiteEntryId);
      return manifest ? 1 + manifest.protectedRecords.length + manifest.effects.reduce((n, effect) => n + 2 + Object.keys(effect.requiredFields).length, 0)
        : factCount(id, row => row.facts.predicates.required);
    }),
    metric('M3', 'mutation_acknowledgements', row => row.facts.mutationAcks.verified, id => factCount(id, row => row.facts.mutationAcks.total)),
    ...['read_retry', 'accepted_write', 'none'].map(kind => metric('M4', kind, () => 0, id =>
      indicator(kind === 'read_retry' ? entryFor(id).family === 8 : kind === 'accepted_write' ? entryFor(id).family === 9 : false))),
    metric('M5', 'excess_applied_creations', () => 0, () => 0),
    ...ROLES.map(role => metric('M7', 'first_proposals', row => indicator(entryFor(row.evaluationAttemptId).requiredRoles.includes(role) &&
      qualityPass(row.facts.quality[role]?.firstOutputId ?? null, row.facts.quality[role]?.firstProposalAssessment ?? 'unverified')),
      id => indicator(entryFor(id).requiredRoles.includes(role)), role)),
  ];
  const selectedPlanQuality = ROLES.map(role => metric('M7', 'selected_proposals', row => indicator(entryFor(row.evaluationAttemptId).requiredRoles.includes(role) &&
    qualityPass(row.facts.quality[role]?.selectedOutputId ?? null, row.facts.quality[role]?.selectedPlanAssessment ?? 'unverified')),
    id => indicator(entryFor(id).requiredRoles.includes(role)), role));
  const byApp = Object.fromEntries([...new Set(rows.flatMap(row => Object.keys(row.facts.tools.byApp)))].sort().map(app => [app, {
    overall: metric('M2', app, row => row.facts.tools.byApp[app]?.succeeded ?? 0, id => factCount(id, row => row.facts.tools.byApp[app]?.dispatched ?? 0)),
    firstAttempt: metric('M2', app, row => row.facts.tools.byApp[app]?.firstSucceeded ?? 0, id => factCount(id, row => row.facts.tools.byApp[app]?.firstDispatched ?? 0)),
  }]));
  const latencySamples = rows.map(row => ({ evaluationAttemptId: row.evaluationAttemptId, ...row.facts.latency }));
  const uncensored = latencySamples.filter(sample => !sample.censored);
  const latency = (['wall', 'wait', 'active'] as const).map(dimension => {
    const values = duration(uncensored.map(sample => sample[`${dimension}Ms`]));
    return { metricId: 'M6' as const, dimension, role: null, availability: uncensored.length ? 'available' as const : 'na' as const,
      sampleCount: uncensored.length, censoredCount: latencySamples.filter(sample => sample.censored).length + ids.length - rows.length,
      medianMs: values.median, maxMs: values.max, sampleIds: uncensored.map(sample => sample.evaluationAttemptId) };
  });
  const claimRows = rows.flatMap(row => row.claimFacts.classifications.map(claim => ({ evaluationAttemptId: row.evaluationAttemptId, ...claim,
    premature: row.claimFacts.prematureSuccessClaims.includes(claim.claimId), falseCompletion: row.claimFacts.falseCompletion.includes(claim.claimId) })));
  // Claim IDs are globally unique; never blend conflicting assignments between attempts.
  if (new Set(claimRows.map(claim => claim.claimId)).size !== claimRows.length) throw new Error('report_claim_identity_conflict');
  const claimIds = (predicate: (claim: typeof claimRows[number]) => boolean) => claimRows.filter(predicate).map(claim => claim.claimId).sort();
  const claims = { successClaims: claimIds(() => true), prematureSuccessClaims: claimIds(claim => claim.premature),
    outcomeContradictedCompletionClaims: claimIds(claim => claim.outcome === 'contradicted'), falseCompletion: claimIds(claim => claim.falseCompletion),
    unverifiedClaims: claimIds(claim => claim.outcome === 'unverified'), classifications: claimRows };
  const originalIds = new Set(rows.flatMap(row => Object.values(row.facts.quality).flatMap(quality => quality.firstOutputId ? [quality.firstOutputId] : [])));
  const firstLabels = currentLabels.filter(label => originalIds.has(label.outputId));
  const unsupported = [...new Map(firstLabels.flatMap(label => label.findings.filter(f => f.judgment === 'unsupported')
    .map(finding => [canonical([label.outputId, finding.claimId]), { outputId: label.outputId, evaluationAttemptId: label.evaluationAttemptId,
      claimId: finding.claimId, labelId: label.labelId }] as const))).values()];
  const gaps = [...new Set([
    ...rows.flatMap(row => row.checks.filter(check => check.status !== 'passed').map(check => check.code)),
    ...excluded.map(entry => entry.reason), ...(slots.some(slot => slot.result === 'failed') ? ['census_contains_failed_attempts'] : []), ...slots.flatMap(slot => slot.reason ? [slot.reason] : []),
    ...(rows.length < ids.length ? ['assessment_missing_for_registered_attempt', 'tool_and_predicate_denominators_incomplete'] : []),
    ...(labels.length === 0 ? ['actual_human_labels_missing'] : []),
    'recovery_facts_unavailable_in_monitor_v2', 'creation_facts_unavailable_in_monitor_v2',
    'recipient_count_unavailable_in_monitor_v2', 'auditor_detection_labels_unavailable',
    ...(firstLabels.some(label => label.grounding === false && !label.findings.length) ? ['unsupported_claims_use_legacy_proposal_proxy'] : []),
  ])].sort();
  return { counts, slots, metrics, selectedPlanQuality, byApp, latency, latencySamples, claims,
    humanLabelCount: labels.length, labelIds: labels.map(label => label.labelId),
    labelRevisions: history.map(label => ({ labelId: label.labelId, digest: digest(label), outputId: label.outputId,
      supersedesLabelId: label.supersedesLabelId, trusted: labels.some(trusted => trusted.labelId === label.labelId) })),
    quality: rows.map(row => ({ evaluationAttemptId: row.evaluationAttemptId, roles: Object.fromEntries(Object.entries(row.facts.quality).map(([role, value]) =>
      [role, { ...value, firstProposalAssessment: qualityState(value.firstOutputId, value.firstProposalAssessment),
        selectedPlanAssessment: qualityState(value.selectedOutputId, value.selectedPlanAssessment) }])) })),
    interventions: { regeneratedOutputIds: [...outputs.values()].filter(output => registrations.has(output.evaluationAttemptId) && output.previousOutputId !== null).map(output => output.outputId),
      humanCorrections: null, auditorMisses: null, auditorFalseBlocks: null },
    unsupported: { claimCount: firstLabels.some(label => label.findings.length) ? unsupported.length : null, claims: unsupported,
      proposalProxy: new Set(firstLabels.filter(label => label.grounding === false).map(label => label.outputId)).size,
      unit: 'distinct outputId/claimId with actual human unsupported findings; proposalProxy is not a claim count' },
    critical: { forbiddenEffects: rows.reduce((n, row) => n + row.facts.critical.forbiddenOperations, 0),
      approvalBypasses: rows.reduce((n, row) => n + row.facts.critical.approvalBypasses, 0) },
    criticalFailures: rows.flatMap(row => row.checks.filter(check => check.status === 'failed').map(check => ({ evaluationAttemptId: row.evaluationAttemptId, ...check }))),
    assessments: rows, attemptIds: ids, excluded, gaps,
    watermark: digest(rows.map(row => [row.evaluationAttemptId, row.watermark, row.observedAtMs])),
    inputObservations: input.assessments.length, retainedAssessments: rows.length,
    supersededObservations: input.assessments.length - excluded.length - rows.length,
  };
}
