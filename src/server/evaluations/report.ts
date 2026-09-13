import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, DigestSchema, ExecutionModeSchema, UtcTimestampSchema } from '../../shared/domain.js';
import { EvaluationSummaryViewSchema, EvaluationReadSchema, type EvaluationSummaryView } from '../../shared/api.js';
import { digest } from '../../shared/reliability.js';
import { summarizeApplication, type ApplicationMetricsInput } from './metrics.js';

export const REPORT_VERSION = 'evaluation-report-v2';
export interface EvaluationReportInput extends ApplicationMetricsInput {
  observedAt?: string;
  revision?: number;
  reportSource: { gitSha: string; dirtySha256: string };
}
const limitations = [
  'Operational and assessment counts overlap; only attempted + setupFailed + unrun partition planned slots.',
  'M1/M7 include every eligible registration. Missing, refused, invalid and corrected original outputs remain in the first-proposal denominator.',
  'M2 counts provider attempts and first logical calls separately. M3 uses Q03 independently corroborated acknowledgements.',
  'M4 retains attempted family 8/9 recovery eligibility, but zero confirmed recoveries is unverified without recovery facts. M5 creation history is unavailable; N/A is not a measured zero.',
  'M6 excludes censored attempts from median/max and keeps their raw samples and identities.',
  'V2 falseCompletion is Q03’s claim-ID union. V1’s premature-only counter must remain in a separate legacy report.',
  'Human label provenance requires authenticated intake. Imported human strings, product approvals and model verdicts cannot supply semantic ground truth.',
  'Contributions preserve raw Q03 facts for audit; report quality and metric numerators additionally require the supplied trusted label coverage.',
  'Reports are immutable snapshots. Private sources, outputs, reviewer details and evidence receipts are accessible only through separately authorized storage.',
];

/** Build a deterministic, sanitized saved report from one Q04 census and Q03 snapshots. */
export function buildEvaluationReport(input: EvaluationReportInput) {
  const cutoffAt = UtcTimestampSchema.parse(input.cutoffAt), observedAt = UtcTimestampSchema.parse(input.observedAt ?? cutoffAt);
  if (Date.parse(observedAt) < Date.parse(cutoffAt)) throw new Error('report_observed_before_cutoff');
  if (!/^[a-f0-9]{40}$/.test(input.reportSource.gitSha)) throw new Error('invalid_report_source_sha');
  DigestSchema.parse(input.reportSource.dirtySha256);
  const configuration = ExecutionModeSchema.parse(input.harness.configuration);
  const result = summarizeApplication(input);
  const frozenCensusHash = digest(input.harness.frozenEntries), censusHash = digest(input.harness.census);
  const cohortId = `cohort-${digest({ suiteHash: input.harness.suiteHash, configuration,
    release: input.harness.release, versions: input.harness.versions, evaluator: input.harness.evaluatorVersion })}`;
  const reportId = `report-${digest({ cohortId, cutoffAt })}`;
  const revision = input.revision ?? 1;
  const gapRows = result.gaps.map(code => ({ code, referenceId: null }));
  const fullAssessmentCoverage = result.counts.assessed === result.counts.attempted;
  type Critical = EvaluationSummaryView['criticalCounts'][number];
  const critical = (code: Critical['code'], count: number | null, sampleIds: string[]): Critical => ({ code, count,
    availability: count === null ? 'unavailable' : 'available', sampleIds });
  const criticalCounts: Critical[] = [
    critical('forbiddenEffects', fullAssessmentCoverage ? result.critical.forbiddenEffects : null,
      result.assessments.filter(row => row.facts.critical.forbiddenOperations).map(row => row.evaluationAttemptId)),
    critical('approvalBypasses', fullAssessmentCoverage ? result.critical.approvalBypasses : null,
      result.assessments.filter(row => row.facts.critical.approvalBypasses).map(row => row.evaluationAttemptId)),
    ...(['prematureSuccessClaims', 'outcomeContradictedCompletionClaims', 'falseCompletion', 'successClaims'] as const)
      .map(code => critical(code, fullAssessmentCoverage ? result.claims[code].length : null, result.claims[code])),
    critical('unsupportedClaims', result.unsupported.claimCount, result.unsupported.claims.map(claim => `claim-${digest([claim.outputId, claim.claimId])}`)),
    critical('duplicates', null, []), critical('incorrectRecipients', null, []), critical('recoveryFailures', null, []),
  ];
  const stripMetric = ({ numeratorSampleIds: _ids, unit: _unit, ...metric }: typeof result.metrics[number]) => metric;
  const summary = EvaluationSummaryViewSchema.parse({ schemaVersion: 2, reportId, revision, cohortId,
    evaluatorVersion: 'monitor-v2', manifestVersion: '2', logicalManifestHash: frozenCensusHash,
    configuration, provenance: configuration.evidenceMode === 'synthetic_fixture' ? 'synthetic' : 'imported_untrusted',
    cutoffAt, observedAt, watermark: result.watermark,
    census: { planned: result.counts.planned, attempted: result.counts.attempted, assessed: result.counts.assessed,
      failed: result.slots.filter(slot => slot.assessmentStatus !== null && slot.result === 'failed').length,
      unverified: result.slots.filter(slot => slot.result !== 'failed' && slot.assessmentStatus === 'unverified').length,
      setupFailed: result.counts.setupFailed, notRun: result.counts.unrun },
    metrics: [...result.metrics.map(stripMetric), ...result.latency], criticalCounts,
    humanLabelCount: result.humanLabelCount, gaps: gapRows.slice(0, 999),
    // No API evidence route is mounted by Q05; never fabricate an accessible link.
    reportRef: { referenceId: reportId, label: 'Saved evaluation detail', availability: 'unavailable', href: null },
  });
  const detail = { schemaVersion: 2, reportVersion: REPORT_VERSION, reportId, revision, cohortId,
    source: { execution: input.harness.release, report: input.reportSource },
    versions: input.harness.versions, evaluatorVersion: 'monitor-v2', manifestVersion: '2',
    harnessVersion: input.harness.harnessVersion, harnessRevision: input.harness.revision,
    suiteId: input.harness.suiteId, suiteHash: input.harness.suiteHash, frozenCensusHash, censusHash,
    configuration, provenance: summary.provenance, cutoffAt, observedAt, watermark: result.watermark,
    counts: result.counts, slots: result.slots, attemptIds: result.attemptIds,
    registrations: input.harness.attempts.map(attempt => ({ ...attempt.registration })),
    evidenceRevisions: input.harness.attempts.map(attempt => ({ evaluationAttemptId: attempt.registration.evaluationAttemptId, resultRef: attempt.resultRef })),
    assessmentRevisions: result.assessments.map(row => ({ evaluationAttemptId: row.evaluationAttemptId,
      watermark: row.watermark, observedAtMs: row.observedAtMs, sha256: digest(row) })),
    // Q03 facts allow exact recomputation without raw source text or provider payloads.
    contributions: result.assessments.map(row => ({ evaluationAttemptId: row.evaluationAttemptId, status: row.status,
      traceAssessment: row.traceAssessment, outcomeAssessment: row.outcomeAssessment, recordedSemanticAssessment: row.semanticAssessment,
      facts: row.facts, claimFacts: row.claimFacts })),
    metrics: result.metrics, selectedPlanQuality: result.selectedPlanQuality, byApp: result.byApp,
    latency: result.latency, latencySamples: result.latencySamples,
    claims: result.claims, quality: result.quality, interventions: result.interventions,
    unsupported: result.unsupported, criticalCounts, criticalFailures: result.criticalFailures,
    humanLabelCount: result.humanLabelCount, labelRevisions: result.labelRevisions,
    inputs: { observations: result.inputObservations, retained: result.retainedAssessments,
      superseded: result.supersededObservations, excluded: result.excluded },
    targets: input.harness.targets, gaps: result.gaps, limitations,
  };
  return { schemaVersion: 2 as const, reportVersion: REPORT_VERSION, reportId, revision, cohortId,
    summary, detail, counts: result.counts, gaps: result.gaps, sha256: digest({ summary, detail }) };
}
export type EvaluationReport = ReturnType<typeof buildEvaluationReport>;

/** Server-authorized boundary: callers must supply authenticated access, not request-body flags. */
export function readEvaluationSummary(report: EvaluationReport | null, authorized: boolean, pending = false) {
  return EvaluationReadSchema.parse({ schemaVersion: 2, availability: !authorized ? 'unauthorized' : report ? 'available' : pending ? 'pending' : 'unavailable',
    report: authorized && report ? report.summary : null });
}
export function readEvaluationDetail(report: EvaluationReport | null, authorized: boolean, pending = false) {
  return { schemaVersion: 2 as const, availability: !authorized ? 'unauthorized' as const : report ? 'available' as const : pending ? 'pending' as const : 'unavailable' as const,
    report: authorized && report ? report.detail : null };
}

export function renderEvaluationReport(report: EvaluationReport): string {
  const { detail, counts, summary } = report;
  const lines = ['# PromiseGuard evaluation report', '', `Report: ${report.reportId}, revision ${report.revision}.`,
    `Evidence: ${summary.configuration.evidenceMode}; model ${summary.configuration.modelMode}; providers ${summary.configuration.providerMode}.`,
    `Execution source: ${detail.source.execution.source}.`, `Report source: ${detail.source.report.gitSha}; dirty content digest ${detail.source.report.dirtySha256}.`,
    `Cutoff: ${detail.cutoffAt}; watermark: ${detail.watermark}.`, `Census SHA-256: ${detail.censusHash}.`, '',
    `Planned ${counts.planned}; registered ${counts.registered}; attempted ${counts.attempted}; assessed ${counts.assessed}; passed ${counts.passed}; failed ${counts.failed}; pending ${counts.pending}; unverified ${counts.unverified}; setup-failed ${counts.setupFailed}; unrun ${counts.unrun}.`,
    'Operational and assessment counts overlap; do not sum all columns.', '',
    ...detail.metrics.map(metric => `- ${metric.metricId} ${metric.dimension}${metric.role ? ` (${metric.role})` : ''}: ${metric.numerator}/${metric.denominator}; ${metric.value === null ? 'N/A' : metric.value}.`),
    ...detail.latency.map(metric => `- M6 ${metric.dimension}: median ${metric.medianMs ?? 'N/A'} ms; max ${metric.maxMs ?? 'N/A'} ms; ${metric.sampleCount} uncensored, ${metric.censoredCount} censored.`), '',
    `Actual human labels: ${detail.humanLabelCount}. Missing labels leave semantic quality unverified.`,
    `Premature claims: ${detail.claims.prematureSuccessClaims.length}; contradicted claims: ${detail.claims.outcomeContradictedCompletionClaims.length}; false-completion union: ${detail.claims.falseCompletion.length}; all claims: ${detail.claims.successClaims.length}; unverified claims: ${detail.claims.unverifiedClaims.length}.`, '',
    '## Gaps', '', ...detail.gaps.map(gap => `- ${gap}`), '', '## Interpretation', '', ...limitations.map(line => `- ${line}`), '',
    'Attempt identities, contributions, label/evidence revisions and failures are retained in the companion JSON detail.', ''];
  return lines.join('\n');
}

/** Append-only private files; identical replays are harmless, conflicting revisions fail. */
export function saveEvaluationReport(report: EvaluationReport, directory: string) {
  const summary = EvaluationSummaryViewSchema.parse(report.summary);
  if (report.reportVersion !== REPORT_VERSION || report.schemaVersion !== 2 || report.reportId !== summary.reportId ||
      report.revision !== summary.revision || report.cohortId !== summary.cohortId || report.detail.reportId !== summary.reportId ||
      report.detail.revision !== summary.revision || report.detail.cohortId !== summary.cohortId ||
      canonical(report.counts) !== canonical(report.detail.counts) || canonical(report.gaps) !== canonical(report.detail.gaps))
    throw new Error('report_identity_mismatch');
  if (report.sha256 !== digest({ summary: report.summary, detail: report.detail })) throw new Error('report_integrity_mismatch');
  const base = resolve(directory); mkdirSync(base, { recursive: true, mode: 0o700 });
  const name = `${report.reportId}-r${report.revision}`;
  const outputs = [
    { path: join(base, `${name}.json`), bytes: canonical(report) },
    { path: join(base, `${name}.md`), bytes: renderEvaluationReport(report) },
    { path: join(base, `${name}.summary.json`), bytes: canonical(readEvaluationSummary(report, true)) },
    { path: join(base, `${name}.detail.json`), bytes: canonical(readEvaluationDetail(report, true)) },
  ];
  for (const output of outputs) if (existsSync(output.path) && readFileSync(output.path, 'utf8') !== output.bytes) throw new Error('report_revision_already_exists');
  for (const output of outputs) if (!existsSync(output.path)) writeFileSync(output.path, output.bytes, { flag: 'wx', mode: 0o600 });
  return { jsonPath: outputs[0].path, markdownPath: outputs[1].path, summaryPaths: [outputs[2].path], detailPath: outputs[3].path };
}
