import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { createScenarioHarness, type HarnessAttempt } from '../../src/server/evaluations/harness.js';
import { loadFixtureSuite } from '../../src/server/evaluations/manifest.js';
import { createScenarioRuntime, scenarioRuntimeSupport } from '../../tools/evaluations/scenario-runtime.js';
import { OriginalOutputSchema } from '../../src/shared/evaluation.js';
import { EventV2Schema, type EventV2 } from '../../src/shared/events.js';
import { digest } from '../../src/shared/reliability.js';

const release = { source: 'q04-focused-test', app: 'r01', model: 'q04-scripted-model-v1',
  prompt: 'promiseguard-roles-v1', policy: 'selection-v1', schema: '2' };
const protectedWrite = (event: EventV2) => event.kind === 'tool.dispatch' && [
  'hubspot.createTask', 'hubspot.createNote', 'gmail.createDraft', 'github.createComment', 'slack.postSummary',
].includes(event.operation);

async function resultArtifact(directory: string, attempt: HarnessAttempt) {
  assert.ok(attempt.resultRef, attempt.diagnostics.join(','));
  const result = JSON.parse(await readFile(join(directory, 'artifacts', `${attempt.resultRef.artifactId}.json`), 'utf8'));
  assert.equal(digest(result), attempt.resultRef.sha256);
  return result;
}

test('synthetic graph executes golden, empty selection, safe block and stale approval with original evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'q04-core-'));
  try {
    const suite = await loadFixtureSuite();
    const harness = createScenarioHarness({ suite, directory, release,
      runtimeFactory: createScenarioRuntime, support: scenarioRuntimeSupport });
    const report = await harness.run(['pg-f01-baseline', 'pg-f02-baseline', 'pg-f03-baseline', 'pg-f06-baseline']);
    assert.equal(report.counts.planned, suite.scenarios.entries.length);
    assert.equal(report.counts.attempted, 4, JSON.stringify(report.diagnostics));
    assert.equal(report.counts.setupFailed, 0);
    assert.equal(report.counts.unrun, suite.scenarios.entries.length - 4);
    assert.equal(report.configuration.evidenceMode, 'synthetic_fixture');
    assert.equal(report.targets.baselineRepetition, 42);
    assert.ok(report.targets.live.every(entry => entry.disposition === 'not_run'));
    const expected = new Map([
      ['pg-f01-baseline', 'completed'], ['pg-f02-baseline', 'completed_no_affected_commitments'],
      ['pg-f03-baseline', 'safely_blocked'], ['pg-f06-baseline', 'failed_partial'],
    ]);
    for (const attempt of report.attempts) {
      const id = attempt.registration.suiteEntryId;
      assert.equal(attempt.productStatus, expected.get(id), `${id}:${attempt.diagnostics.join(',')}`);
      assert.match(attempt.registration.s0Ref.sha256, /^[a-f0-9]{64}$/);
      const result = await resultArtifact(directory, attempt);
      const events: EventV2[] = result.events.map((value: unknown) => EventV2Schema.parse(value));
      const outputs = (result.originalOutputs as unknown[]).map(value => OriginalOutputSchema.parse(value));
      const writes = events.filter(protectedWrite);
      assert.equal(result.actualHumanReviews, 0);
      assert.equal(result.labels.length, 0, 'synthetic Slack decisions never become human quality labels');
      if (id === 'pg-f01-baseline') {
        assert.deepEqual(outputs.map(output => output.role).sort(), ['analyst', 'auditor', 'drafter']);
        assert.ok(outputs.every(output => output.sourceDigests.length > 0 && output.firstOutputId === output.outputId));
        const approval = events.find(event => event.kind === 'approval.checked' && event.decision === 'approved');
        assert.ok(approval);
        assert.equal(writes.length, 5);
        assert.ok(writes.every(write => write.sequence > approval.sequence));
        assert.equal(new Set(events.flatMap(event => event.kind === 'effect.verified' && event.verdict === 'matched'
          ? [event.effectKey] : [])).size, 5);
      } else {
        assert.equal(writes.length, 0, `${id} cannot create protected artifacts`);
        if (id !== 'pg-f06-baseline') assert.equal(outputs.length, 0);
        else {
          // The current driver calls every execute-stage stop partial. Q04 must
          // preserve that actual mismatch rather than rewrite the frozen safe-block expectation.
          assert.equal(result.expectedTerminalStatus, 'safely_blocked');
          assert.ok(result.checks.some((check: { code: string; status: string }) =>
            check.code === 'expected_terminal_status' && check.status === 'failed'));
          const census = report.census.find(entry => entry.suiteEntryId === id);
          assert.ok(census?.disposition === 'attempted');
          assert.equal(census.result, 'failed');
        }
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);

test('concurrent starts and reopening preserve the complete census, S0 binding and one attempted denominator', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'q04-replay-'));
  try {
    const suite = await loadFixtureSuite();
    const options = { suite, directory, release, runtimeFactory: createScenarioRuntime, support: scenarioRuntimeSupport };
    const harness = createScenarioHarness(options);
    const first = await harness.run(['pg-f16-baseline', 'pg-f05-baseline', 'pg-f09-baseline']);
    assert.equal(first.counts.attempted, 1, JSON.stringify(first.diagnostics));
    assert.equal(first.attempts[0].productStatus, 'completed');
    for (const suiteEntryId of ['pg-f05-baseline', 'pg-f09-baseline']) {
      const unsupported = first.census.find(entry => entry.suiteEntryId === suiteEntryId);
      assert.ok(unsupported?.disposition === 'not_run');
      assert.notEqual(unsupported.reason, 'not_selected', 'requested unsupported contracts remain explicit unrun slots');
    }
    const result = await resultArtifact(directory, first.attempts[0]);
    const events: EventV2[] = result.events.map((value: unknown) => EventV2Schema.parse(value));
    assert.equal(events.filter(event => event.kind === 'model.attempt.started').length, 3);
    assert.equal(events.filter(protectedWrite).length, 5);
    assert.deepEqual(result.runtimeDiagnostics.gaps, []);
    assert.equal(result.runtimeDiagnostics.commandReceipts.length, 3);
    assert.ok(result.runtimeDiagnostics.commandReceipts.every((receipt: { runId: string }) =>
      receipt.runId === first.attempts[0].registration.runId));
    const second = await harness.run(['pg-f16-baseline']);
    const reopened = createScenarioHarness(options).report();
    assert.deepEqual(second.attempts, first.attempts);
    assert.deepEqual(reopened.attempts, first.attempts);
    assert.deepEqual(reopened.census, first.census);
    assert.deepEqual(reopened.counts, first.counts);
    const exported = JSON.parse(await readFile(reopened.reportPath, 'utf8'));
    assert.equal(exported.census.length, suite.scenarios.entries.length);
    assert.deepEqual(exported.attempts[0].registration.s0Ref, first.attempts[0].registration.s0Ref);
    assert.throws(() => createScenarioHarness({ ...options, release: { ...release, source: 'different-release' } }),
      /harness_cohort_identity_mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);
