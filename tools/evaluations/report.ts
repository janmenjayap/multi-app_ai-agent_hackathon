/// <reference path="../../src/shared/checker.d.ts" />
/** Compile: npm exec -- tsc -p tools/evaluations/tsconfig.json
 * Run: node .local/evaluation-build/tools/evaluations/report.js --input .local/q04 --output .local/q05
 * Reads saved evidence only; reporting never starts/resumes a workflow or trusts imported human labels.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, readFile, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { canonical, ExecutionModeSchema, RestrictedArtifactRefSchema, UtcTimestampSchema,
  type RestrictedArtifactRef } from '../../src/shared/domain.js';
import { EvaluationAttemptRegistrationSchema, LogicalManifestSchema, OriginalOutputSchema, ReviewLabelSchema, SuiteEntrySchema,
  type OriginalOutput, type ReviewLabel } from '../../src/shared/evaluation.js';
import type { HarnessReport } from '../../src/server/evaluations/harness.js';
import { createScenarioManifest, loadFixtureSuiteFrom } from '../../src/server/evaluations/manifest.js';

const execute = promisify(execFile);
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('q05_invalid_saved_evidence');
  return value as Record<string, unknown>;
}

/** The Git revision plus hashes of changed bytes identify the reporting implementation without logging source. */
async function sourceIdentity() {
  const git = (...args: string[]) => execute('git', args, { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
  const [head, tracked, untracked] = await Promise.all([
    git('rev-parse', 'HEAD'), git('diff', '--binary', 'HEAD', '--'),
    git('ls-files', '--others', '--exclude-standard', '-z'),
  ]);
  const paths = untracked.stdout.split('\0').filter(path => path &&
    !['node_modules', 'dist', '.local', '.git'].includes(path.split('/')[0])).sort();
  const files = await Promise.all(paths.map(async path => {
    const absolute = resolve(path), stat = await lstat(absolute);
    const content = stat.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute);
    return { path, sha256: sha256(content), mode: stat.mode & 0o777, kind: stat.isSymbolicLink() ? 'symlink' : 'file' };
  }));
  const gitSha = head.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(gitSha)) throw new Error('q05_invalid_source_revision');
  return { gitSha, dirtySha256: sha256(canonical({ trackedDiffSha256: sha256(tracked.stdout), untracked: files })) };
}

async function readArtifact(directory: string, value: RestrictedArtifactRef) {
  const ref = RestrictedArtifactRefSchema.parse(value);
  if (ref.mediaType !== 'application/json' || ref.artifactId !== `q04-${ref.sha256}`)
    throw new Error('q05_invalid_artifact_reference');
  const bytes = await readFile(join(directory, 'artifacts', `${ref.artifactId}.json`));
  if (bytes.length !== ref.byteLength || sha256(bytes) !== ref.sha256)
    throw new Error('q05_artifact_integrity_mismatch');
  return object(JSON.parse(bytes.toString('utf8')));
}

export async function reportEvaluations(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    input: { type: 'string', default: '.local/q04' }, output: { type: 'string', default: '.local/q05' },
    cutoff: { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    process.stdout.write('Q05: --input <saved-q04-directory> --output <private-report-directory> [--cutoff <UTC-timestamp>]\n' +
      'Reads saved census/result artifacts only. Default cutoff is the latest saved observation. Imported human labels remain untrusted.\n');
    return;
  }
  const inputDirectory = resolve(values.input!), outputDirectory = resolve(values.output!);
  if (inputDirectory === outputDirectory) throw new Error('q05_output_must_differ_from_input');
  const saved = object(JSON.parse(await readFile(join(inputDirectory, 'census.json'), 'utf8')));
  if (saved.schemaVersion !== 2 || saved.harnessVersion !== 'scenario-harness-v1' ||
      !Array.isArray(saved.attempts) || !Array.isArray(saved.census)) throw new Error('q05_invalid_harness_report');
  const harness = saved as unknown as HarnessReport;
  const documents = await Promise.all(['world', 'scenarios', 'source-labels'].map(async name =>
    JSON.parse(await readFile(resolve('tests/fixtures', `${name}.json`), 'utf8'))));
  const suite = loadFixtureSuiteFrom({ world: documents[0], scenarios: documents[1], sourceLabels: documents[2] });
  if (harness.suiteHash !== suite.suiteHash || harness.suiteId !== suite.scenarios.suiteId ||
      canonical(harness.versions) !== canonical(suite.scenarios.versions) ||
      canonical(harness.frozenEntries) !== canonical(suite.scenarios.entries)) throw new Error('q05_frozen_census_mismatch');
  harness.configuration = ExecutionModeSchema.parse(harness.configuration);
  harness.census = harness.census.map(entry => SuiteEntrySchema.parse(entry));
  const manifests = suite.scenarios.entries.map(entry => LogicalManifestSchema.parse({
    ...createScenarioManifest(suite, entry.suiteEntryId).manifest, mode: harness.configuration.evidenceMode,
  }));
  const manifestHashes = new Map(manifests.map(manifest => [manifest.suiteEntryId, sha256(canonical(manifest))]));
  const assessments: unknown[] = [], originalOutputs: OriginalOutput[] = [], labels: ReviewLabel[] = [];
  const timestamps: number[] = [];
  const timestamp = (value: unknown) => {
    const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(ms)) timestamps.push(ms);
  };
  // Setup receipts remain outside attempted denominators, but their saved time belongs to the observation window.
  for (const entry of harness.census) {
    if (entry.disposition !== 'setup_failed') continue;
    const setup = await readArtifact(inputDirectory, entry.receiptRef);
    if (setup.schemaVersion !== 2 || setup.suiteEntryId !== entry.suiteEntryId || setup.phase !== 'before_registration')
      throw new Error('q05_setup_identity_mismatch');
    timestamp(setup.observedAt);
  }
  for (const attempt of harness.attempts) {
    const registration = EvaluationAttemptRegistrationSchema.parse(attempt.registration);
    if (manifestHashes.get(registration.suiteEntryId) !== registration.manifestHash)
      throw new Error('q05_registered_manifest_mismatch');
    timestamp(registration.registeredAt);
    timestamp(registration.dispatchAt);
    if (!attempt.resultRef) continue;
    const result = await readArtifact(inputDirectory, attempt.resultRef);
    if (result.schemaVersion !== 2 || result.suiteEntryId !== registration.suiteEntryId ||
        canonical(result.registration) !== canonical(registration) || canonical(result.sourceRelease) !== canonical(harness.release))
      throw new Error('q05_result_identity_mismatch');
    const applicationReport = object(result.report);
    if (!Array.isArray(applicationReport.assessments) || !Array.isArray(result.originalOutputs) || !Array.isArray(result.labels))
      throw new Error('q05_invalid_result_report');
    timestamp(applicationReport.generatedAtMs);
    for (const assessment of applicationReport.assessments) {
      const row = object(assessment);
      if (row.evaluationAttemptId !== registration.evaluationAttemptId || row.runId !== registration.runId)
        throw new Error('q05_assessment_identity_mismatch');
      timestamp(row.observedAtMs);
      assessments.push(assessment);
    }
    for (const value of result.originalOutputs) {
      const output = OriginalOutputSchema.parse(value);
      if (output.evaluationAttemptId !== registration.evaluationAttemptId || output.runId !== registration.runId)
        throw new Error('q05_output_identity_mismatch');
      originalOutputs.push(output);
      timestamp(output.receivedAt);
    }
    for (const value of result.labels) {
      const label = ReviewLabelSchema.parse(value);
      if (label.evaluationAttemptId !== registration.evaluationAttemptId || label.runId !== registration.runId)
        throw new Error('q05_label_identity_mismatch');
      labels.push(label);
      timestamp(label.reviewedAt);
    }
  }
  const cutoffAt = UtcTimestampSchema.parse(values.cutoff ?? new Date(Math.max(0, ...timestamps)).toISOString());
  // TypeScript does not emit the existing .mjs checker imported by Q03's assessment schemas.
  if (import.meta.url.endsWith('.js'))
    await cp(resolve('tools/reliability'), new URL('../reliability/', import.meta.url), { recursive: true });
  const { buildEvaluationReport, saveEvaluationReport } = await import('../../src/server/evaluations/report.js');
  const report = buildEvaluationReport({ harness, manifests, assessments, originalOutputs, labels, cutoffAt,
    observedAt: cutoffAt, reportSource: await sourceIdentity() });
  const paths = await saveEvaluationReport(report, outputDirectory);
  process.stdout.write(`${JSON.stringify({ counts: report.counts, gaps: report.gaps.length,
    cutoffAt, ...paths }, null, 2)}\n`);
  if (report.counts.failed || report.counts.pending || report.counts.unverified ||
      report.counts.setupFailed || report.counts.unrun || report.gaps.length) process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await reportEvaluations(); }
  catch (error) {
    const reason = error instanceof Error && /^q05_[a-z_]+$/.test(error.message) ? error.message : 'q05_report_unavailable';
    process.stderr.write(`Q05 report failed: ${reason}\n`);
    process.exitCode = 1;
  }
}
