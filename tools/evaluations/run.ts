/// <reference path="../../src/shared/checker.d.ts" />
/** Compile: npm exec -- tsc -p tools/evaluations/tsconfig.json
 * Run: node .local/evaluation-build/tools/evaluations/run.js --suite core --output .local/q04
 * A nonzero result preserves all adverse evidence. --report never dispatches a graph.
 */
import { createHash } from 'node:crypto';
import { cp, readFile, readdir } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadFixtureSuiteFrom } from '../../src/server/evaluations/manifest.js';

export async function runScenarios(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { suite: { type: 'string', default: 'core' },
    entry: { type: 'string', multiple: true }, output: { type: 'string', default: '.local/q04' },
    report: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help) {
    process.stdout.write('Q04: --suite core|baseline|all --entry <frozen-suite-entry-id> --output <private-directory> --report\n');
    return;
  }
  if (!['core', 'baseline', 'all'].includes(values.suite!)) throw new Error('unknown_scenario_suite');
  const documents = await Promise.all(['world', 'scenarios', 'source-labels'].map(async name =>
    JSON.parse(await readFile(resolve('tests/fixtures', `${name}.json`), 'utf8'))));
  const suite = loadFixtureSuiteFrom({ world: documents[0], scenarios: documents[1], sourceLabels: documents[2] });
  const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  for (const [path, expected] of [['tests/fixtures/faults.ts', suite.scenarios.fakeContracts.faultsSha256],
    ['tests/fakes/model.ts', suite.scenarios.fakeContracts.modelSha256]]) {
    if (sha256(await readFile(resolve(path), 'utf8')) !== expected) throw new Error('frozen_fake_contract_changed');
  }
  // Include working implementation bytes so a source edit cannot silently join an old cohort.
  const codePaths = (await Promise.all(['src', 'tests/fakes', 'tests/fixtures', 'tools/reliability'].map(async directory =>
    (await readdir(resolve(directory), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
      .map(entry => relative(process.cwd(), join(entry.parentPath, entry.name)))))).flat();
  codePaths.push('src/server/evaluations/harness.ts', 'tools/evaluations/scenario-runtime.ts', 'tools/evaluations/run.ts');
  const sourceDigest = sha256((await Promise.all([...new Set(codePaths)].sort().map(async path =>
    `${path}:${sha256(await readFile(resolve(path), 'utf8'))}`))).join('\n'));
  const source = `source-sha256:${sourceDigest}`;
  if (import.meta.url.endsWith('.js')) {
    await cp(resolve('src/server/migrations'), new URL('../../src/server/migrations/', import.meta.url), { recursive: true });
    await cp(resolve('tools/reliability'), new URL('../reliability/', import.meta.url), { recursive: true });
  }
  const { createScenarioHarness, HARNESS_VERSION } = await import('../../src/server/evaluations/harness.js');
  const { createScenarioRuntime, scenarioRuntimeSupport, SCENARIO_RUNTIME_VERSION } = await import('./scenario-runtime.js');
  const harness = createScenarioHarness({ suite, directory: resolve(values.output!),
    release: { source, app: SCENARIO_RUNTIME_VERSION, model: 'q04-scripted-model-v1',
      prompt: 'analyst-prompt-v1_drafter-prompt-v1_auditor-prompt-v1', policy: 'selection-v1', schema: 'schema-v2' },
    runtimeFactory: createScenarioRuntime, support: scenarioRuntimeSupport });
  const first = ['pg-f01-baseline', 'pg-f02-baseline', 'pg-f03-baseline', 'pg-f06-baseline'];
  const selected = values.entry ?? (values.suite === 'core' ? first : [...first,
    ...suite.scenarios.entries.filter(entry => values.suite === 'all' || ['baseline', 'repetition'].includes(entry.leg))
      .map(entry => entry.suiteEntryId).filter(id => !first.includes(id))]);
  const report = values.report ? harness.report() : await harness.run(selected);
  process.stdout.write(`${JSON.stringify({ harnessVersion: HARNESS_VERSION, configuration: report.configuration,
    release: report.release, counts: report.counts, reportPath: report.reportPath,
    results: report.census.filter(entry => entry.disposition !== 'not_run'),
    notRunReasons: [...new Set(report.census.flatMap(entry => entry.disposition === 'not_run' ? [entry.reason] : []))],
    targets: report.targets, actualHumanReviews: 0,
    quality: 'unverified_without_independent_human_review' }, null, 2)}\n`);
  if (report.counts.failed || report.counts.setupFailed || report.counts.pending || report.counts.unverified) process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runScenarios(); }
  catch (error) {
    process.stderr.write(`Q04 harness failed: ${error instanceof Error ? error.message : 'unknown_error'}\n`);
    process.exitCode = 1;
  }
}
