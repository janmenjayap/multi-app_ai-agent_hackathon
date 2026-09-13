import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { canonical } from '../../src/shared/domain.js';
import { EvaluationAttemptRegistrationSchema, OriginalOutputSchema, ReviewLabelSchema, SuiteEntrySchema,
  type OriginalOutput, type ReviewLabel } from '../../src/shared/evaluation.js';
import { digest } from '../../src/shared/reliability.js';
import { ApplicationAssessmentSchema, type ApplicationAssessment } from '../../src/server/monitoring/assess.js';
import { loadFixtureSuite, createScenarioManifest } from '../../src/server/evaluations/manifest.js';
import type { HarnessReport } from '../../src/server/evaluations/harness.js';
import { summarizeApplication } from '../../src/server/evaluations/metrics.js';
import { buildEvaluationReport, saveEvaluationReport, readEvaluationSummary,
  readEvaluationDetail } from '../../src/server/evaluations/report.js';

const suite = await loadFixtureSuite();
const startedAt = '2026-09-14T10:00:00.000Z';
const cutoffAt = '2026-09-14T10:10:00.000Z';
const observedAtMs = Date.parse(startedAt) + 100;
const artifact = (id: string) => ({ artifactId: id, sha256: digest(id), byteLength: 1, mediaType: 'application/json' as const });

/** Arithmetic fixtures use the complete frozen Q01 census; no model/provider calls occur. */
function harness(ids: string[] = []): HarnessReport {
  return { schemaVersion: 2, harnessVersion: 'scenario-harness-v1', suiteHash: suite.suiteHash,
    suiteId: suite.scenarios.suiteId, configuration: suite.scenarios.configuration,
    release: { source: 'q05-arithmetic-fixture', app: 'q05-fixture', model: 'mock', prompt: 'fixture', policy: 'fixture', schema: '2' },
    versions: suite.scenarios.versions, evaluatorVersion: 'monitor-v2', revision: 1,
    census: suite.scenarios.entries.map(entry => SuiteEntrySchema.parse(ids.includes(entry.suiteEntryId) ? {
      suiteEntryId: entry.suiteEntryId, disposition: 'attempted', evaluationAttemptId: `attempt-${entry.suiteEntryId}`, result: 'pending',
    } : { suiteEntryId: entry.suiteEntryId, disposition: 'not_run', reason: 'not_selected' })),
    frozenEntries: suite.scenarios.entries, diagnostics: [], targets: { families: 18, baselineRepetition: 42, live: [] },
    attempts: ids.map(id => ({ registration: EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2,
      runId: `run-${id}`, evaluationAttemptId: `attempt-${id}`, suiteEntryId: id,
      manifestHash: createScenarioManifest(suite, id).manifestHash, registeredAt: startedAt, dispatchAt: startedAt,
      preflightRef: artifact(`preflight-${id}`), s0Ref: artifact(`s0-${id}`), configuration: suite.scenarios.configuration,
      leg: suite.scenarios.entries.find(entry => entry.suiteEntryId === id)!.leg }),
      databasePath: '/restricted/private-fixture.sqlite', resultRef: null, productStatus: null, diagnostics: [] })),
  };
}

function assessment(report: HarnessReport, id: string): ApplicationAssessment {
  const registration = report.attempts.find(attempt => attempt.registration.suiteEntryId === id)!.registration;
  const entry = report.frozenEntries.find(entry => entry.suiteEntryId === id)!;
  return ApplicationAssessmentSchema.parse({ schemaVersion: 2, evaluatorVersion: 'monitor-v2',
    evaluationAttemptId: registration.evaluationAttemptId, runId: registration.runId, cohortId: report.suiteId,
    mode: report.configuration.evidenceMode, versions: report.versions, watermark: 1, observedAtMs,
    productStatus: entry.expectedTerminalStatus, traceCoverage: 'complete', traceAssessment: 'passed',
    outcomeAssessment: 'passed', semanticAssessment: entry.requiredRoles.length ? 'unverified' : 'passed',
    firstProposalAssessment: entry.requiredRoles.length ? 'unverified' : 'passed',
    status: entry.requiredRoles.length ? 'unverified' : 'passed', checks: [],
    claimFacts: { evaluatorVersion: 'monitor-v2', successClaims: [], prematureSuccessClaims: [],
      outcomeContradictedCompletionClaims: [], falseCompletion: [], classifications: [] },
    facts: { executionEligible: entry.executionEligible, contractPassed: !entry.requiredRoles.length,
      tools: { dispatched: 3, succeeded: 2, firstDispatched: 2, firstSucceeded: 1,
        byApp: { 'github:read': { dispatched: 3, succeeded: 2, firstDispatched: 2, firstSucceeded: 1 } } },
      critical: { forbiddenOperations: 0, approvalBypasses: 0 }, predicates: { required: 3, confirmed: 2 },
      mutationAcks: { total: 1, verified: 0 }, latency: { wallMs: 100, waitMs: 40, activeMs: 60, censored: true },
      quality: Object.fromEntries(entry.requiredRoles.map(role => [role, { firstOutputId: null, selectedOutputId: null,
        firstProposalAssessment: 'unverified', selectedPlanAssessment: 'unverified' }])) } });
}

function metric(result: ReturnType<typeof summarizeApplication>, id: string, dimension: string, role: string | null = null) {
  const found = result.metrics.find(row => row.metricId === id && row.dimension === dimension && row.role === role);
  assert.ok(found, `${id}/${dimension}/${role}`);
  return found;
}

test('full census retains registered missing results, setup failures and untouched slots without inflating attempts', () => {
  const report = harness(['pg-f01-baseline', 'pg-f02-baseline']);
  report.census[report.census.findIndex(entry => entry.suiteEntryId === 'pg-f03-baseline')] = {
    suiteEntryId: 'pg-f03-baseline', disposition: 'setup_failed', reason: 's0_failed', receiptRef: artifact('setup-failed'),
  };
  const result = summarizeApplication({ harness: report, assessments: [assessment(report, 'pg-f02-baseline')], cutoffAt });
  assert.deepEqual(result.counts, { planned: 92, registered: 2, attempted: 2, assessed: 1,
    passed: 1, failed: 0, pending: 1, unverified: 0, setupFailed: 1, unrun: 89 });
  assert.deepEqual([metric(result, 'M1', 'execution_attempts').numerator, metric(result, 'M1', 'execution_attempts').denominator], [0, 1]);
  assert.deepEqual([metric(result, 'M7', 'first_proposals', 'analyst').numerator,
    metric(result, 'M7', 'first_proposals', 'analyst').denominator], [0, 1]);
  assert.equal(result.slots.filter(slot => slot.family >= 1 && slot.family <= 18).length, 92);
  assert.ok(result.gaps.includes('assessment_missing_for_registered_attempt'));
  // A stale setup-failed census cannot erase an already durable registration.
  report.census[0] = { suiteEntryId: 'pg-f01-baseline', disposition: 'setup_failed', reason: 'stale_census', receiptRef: artifact('stale') };
  assert.equal(summarizeApplication({ harness: report, assessments: [], cutoffAt }).counts.attempted, 2);
});

test('measurement replay deduplicates attempts, keeps v1 separate and rejects conflicting modes; empty rates are N/A', () => {
  const report = harness(['pg-f02-baseline']);
  const original = assessment(report, 'pg-f02-baseline');
  const latest = structuredClone(original); latest.watermark = 2; latest.facts.tools.succeeded = 3;
  const result = summarizeApplication({ harness: report,
    assessments: [original, latest, latest, { ...original, schemaVersion: 1, evaluatorVersion: 'monitor-v1' }], cutoffAt });
  assert.equal(result.retainedAssessments, 1);
  assert.equal(result.supersededObservations, 2);
  assert.deepEqual([metric(result, 'M2', 'tool_attempts').numerator, metric(result, 'M2', 'tool_attempts').denominator], [3, 3]);
  assert.equal(result.excluded[0]?.reason, 'assessment_unavailable_or_other_version');
  assert.throws(() => summarizeApplication({ harness: report, assessments: [{ ...original, mode: 'imported_provider_snapshot' }], cutoffAt }), /cohort_mismatch/);
  const empty = summarizeApplication({ harness: harness(), assessments: [], cutoffAt });
  assert.ok(empty.metrics.every(row => row.numerator === 0 && row.denominator === 0 && row.value === null && row.availability === 'na'));
  assert.equal(empty.counts.unrun, 92);
});

test('synthetic trust-adapter behavior preserves a failed first draft after correction and rejects untrusted human-shaped labels', () => {
  const report = harness(['pg-f01-baseline']);
  const row = assessment(report, 'pg-f01-baseline');
  row.status = 'passed'; row.semanticAssessment = 'passed'; row.firstProposalAssessment = 'failed'; row.facts.contractPassed = true;
  const outputs: OriginalOutput[] = [], labels: ReviewLabel[] = [];
  for (const role of ['analyst', 'drafter', 'auditor'] as const) {
    const firstId = `original-${role}`;
    for (let n = 0; n < (role === 'drafter' ? 2 : 1); n++) {
      const output = OriginalOutputSchema.parse({ schemaVersion: 2, runId: row.runId, evaluationAttemptId: row.evaluationAttemptId,
        runtimeAttemptId: 'synthetic-runtime', outputId: n ? 'corrected-drafter' : firstId, firstOutputId: firstId,
        previousOutputId: n ? firstId : null, role, roleInvocationKey: canonical([row.runId, 1, role]), planRevision: 1,
        modelAttemptId: `model-${role}-${n}`, inputDigest: digest('input'), sourceDigests: [digest('source')], configDigest: digest('config'),
        promptVersion: 'fixture', modelVersion: 'mock', outputSchemaVersion: '2', receivedAt: startedAt,
        rawOutput: artifact(`raw-${role}-${n}`), parseStatus: 'valid', validationStatus: 'valid', correctionReason: n ? 'Unsupported ETA removed' : null });
      outputs.push(output);
      const bad = role === 'drafter' && n === 0;
      labels.push(ReviewLabelSchema.parse({ schemaVersion: 2, labelId: `label-${output.outputId}`, runId: row.runId,
        evaluationAttemptId: row.evaluationAttemptId, outputId: output.outputId, role, outputDigest: output.rawOutput.sha256,
        sourceDigests: output.sourceDigests, reviewer: { kind: 'human', reviewerId: 'synthetic-trust-adapter', interactionRef: artifact('synthetic-interaction') },
        reason: 'Synthetic adapter contract fixture only; not evidence of actual human review', reviewedAt: new Date(observedAtMs).toISOString(),
        grounding: !bad, completeness: true, decision: true, handoff: true,
        findings: [{ claimId: 'recovery-eta', judgment: bad ? 'unsupported' : 'supported', reason: 'Frozen source comparison fixture', sourceDigests: output.sourceDigests }],
        supersedesLabelId: null }));
      row.facts.quality[role] = { firstOutputId: firstId, selectedOutputId: output.outputId,
        firstProposalAssessment: role === 'drafter' ? 'failed' : 'passed', selectedPlanAssessment: 'passed' };
    }
  }
  const input = { harness: report, assessments: [row], cutoffAt, originalOutputs: outputs, labels };
  const untrusted = summarizeApplication(input);
  assert.equal(untrusted.humanLabelCount, 0);
  assert.equal(metric(untrusted, 'M1', 'execution_attempts').numerator, 0);
  assert.equal(metric(untrusted, 'M7', 'first_proposals', 'analyst').numerator, 0);
  const trusted = summarizeApplication({ ...input, isTrustedReview: label => labels.includes(label) });
  assert.equal(metric(trusted, 'M1', 'execution_attempts').numerator, 1);
  assert.deepEqual([metric(trusted, 'M7', 'first_proposals', 'drafter').numerator,
    metric(trusted, 'M7', 'first_proposals', 'drafter').denominator], [0, 1]);
  assert.equal(trusted.selectedPlanQuality.find(value => value.role === 'drafter')!.numerator, 1);
  assert.equal(trusted.unsupported.claimCount, 1);
  assert.deepEqual(trusted.interventions.regeneratedOutputIds, ['corrected-drafter']);
  // A later actual-review boundary verdict cannot inherit a stale passing assessment.
  const earlierAnalystLabel = labels.find(label => label.role === 'analyst')!;
  const correction = ReviewLabelSchema.parse({ ...earlierAnalystLabel, labelId: 'superseding-analyst-failure',
    grounding: false, supersedesLabelId: earlierAnalystLabel.labelId,
    findings: earlierAnalystLabel.findings.map(finding => ({ ...finding, judgment: 'unsupported' })) });
  const revisedLabels = [...labels, correction];
  const revised = summarizeApplication({ ...input, labels: revisedLabels, isTrustedReview: label => revisedLabels.includes(label) });
  assert.equal(metric(revised, 'M1', 'execution_attempts').numerator, 0);
  assert.equal(metric(revised, 'M7', 'first_proposals', 'analyst').numerator, 0);
  assert.notEqual(revised.quality[0]!.roles.analyst.firstProposalAssessment, 'passed');
  assert.equal(revised.unsupported.claimCount, 2);
  const failedCensus = structuredClone(report);
  const attemptedSlot = failedCensus.census.find(entry => entry.suiteEntryId === 'pg-f01-baseline')!;
  if (attemptedSlot.disposition !== 'attempted') throw new Error('expected_attempted_fixture');
  attemptedSlot.result = 'failed';
  const censusFailure = summarizeApplication({ ...input, harness: failedCensus, isTrustedReview: label => labels.includes(label) });
  assert.equal(censusFailure.counts.failed, 1);
  assert.equal(metric(censusFailure, 'M1', 'execution_attempts').numerator, 0);
  const fixtures = labels.map(label => ({ ...label, reviewer: { kind: 'fixture' as const, fixtureId: 'fixture-only' } }));
  assert.equal(summarizeApplication({ ...input, labels: fixtures, isTrustedReview: () => true }).humanLabelCount, 0);
});

test('Q03 claim overlap counts once, later drift preserves emission truth, and uncorroborated/censored observations remain visible', () => {
  const report = harness(['pg-f02-baseline']);
  const row = assessment(report, 'pg-f02-baseline');
  row.status = 'failed'; row.outcomeAssessment = 'failed'; row.facts.contractPassed = false;
  row.checks = [{ code: 'later_drift', status: 'failed' }];
  row.claimFacts = { evaluatorVersion: 'monitor-v2', successClaims: ['both', 'correct-at-emission', 'unknown'],
    prematureSuccessClaims: ['both'], outcomeContradictedCompletionClaims: ['both'], falseCompletion: ['both'],
    classifications: [{ claimId: 'both', outcome: 'contradicted', evidenceRefs: [], gaps: [] },
      { claimId: 'correct-at-emission', outcome: 'confirmed', evidenceRefs: [], gaps: [] },
      { claimId: 'unknown', outcome: 'unverified', evidenceRefs: [], gaps: ['missing_claim_history'] }] };
  const result = summarizeApplication({ harness: report, assessments: [row, row], cutoffAt });
  assert.equal(result.claims.successClaims.length, 3);
  assert.deepEqual(result.claims.falseCompletion, ['both']);
  assert.deepEqual(result.claims.unverifiedClaims, ['unknown']);
  assert.equal(result.claims.classifications.find(claim => claim.claimId === 'correct-at-emission')!.outcome, 'confirmed');
  assert.deepEqual([metric(result, 'M3', 'mutation_acknowledgements').numerator,
    metric(result, 'M3', 'mutation_acknowledgements').denominator], [0, 1]);
  assert.equal(result.latencySamples[0]?.wallMs, 100);
  assert.ok(result.latency.every(value => value.sampleCount === 0 && value.censoredCount === 1 && value.medianMs === null));
  assert.equal(result.criticalFailures[0]?.code, 'later_drift');
});

test('saved summary and detail are deterministic, authorization-gated and exclude private source paths', () => {
  const census = harness(['pg-f02-baseline']);
  const input = { harness: census, assessments: [assessment(census, 'pg-f02-baseline')], cutoffAt, observedAt: cutoffAt,
    reportSource: { gitSha: 'a'.repeat(40), dirtySha256: digest('clean-fixture') } };
  const report = buildEvaluationReport(input);
  assert.deepEqual(buildEvaluationReport(input), report);
  const empty = buildEvaluationReport({ harness: harness(), assessments: [], cutoffAt, observedAt: cutoffAt,
    reportSource: { gitSha: 'a'.repeat(40), dirtySha256: digest('clean-fixture') } });
  assert.equal(empty.counts.unrun, 92);
  assert.equal(readEvaluationSummary(report, false).availability, 'unauthorized');
  assert.equal(readEvaluationDetail(report, false).availability, 'unauthorized');
  assert.equal(readEvaluationSummary(null, true).availability, 'unavailable');
  assert.equal(readEvaluationSummary(null, true, true).availability, 'pending');
  const allowed = readEvaluationSummary(report, true);
  assert.equal(allowed.availability, 'available');
  assert.ok(!JSON.stringify(allowed).includes('/restricted/'));
  assert.ok(!JSON.stringify(readEvaluationDetail(report, true)).includes('/restricted/'));
  const directory = mkdtempSync(join(tmpdir(), 'q05-report-test-'));
  try {
    const saved = saveEvaluationReport(report, directory);
    const again = saveEvaluationReport(report, directory);
    assert.deepEqual(saved, again);
    assert.deepEqual(JSON.parse(readFileSync(saved.jsonPath, 'utf8')), report);
    assert.equal(readFileSync(saved.summaryPaths[0]!, 'utf8'), canonical(allowed));
    assert.equal(readFileSync(saved.detailPath, 'utf8'), canonical(readEvaluationDetail(report, true)));
    assert.match(readFileSync(saved.markdownPath, 'utf8'), /synthetic_fixture/);
    const changed = buildEvaluationReport({ ...input, assessments: [] });
    assert.throws(() => saveEvaluationReport(changed, directory), /report_revision_already_exists/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
