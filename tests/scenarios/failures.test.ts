import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { createScenarioHarness, type HarnessOptions } from '../../src/server/evaluations/harness.js';
import { loadFixtureSuite } from '../../src/server/evaluations/manifest.js';
import { createScenarioRuntime, scenarioRuntimeSupport } from '../../tools/evaluations/scenario-runtime.js';
import { EventV2Schema, type EventV2 } from '../../src/shared/events.js';

const release = { source: 'q04-failure-test', app: 'r01', model: 'q04-scripted-model-v1',
  prompt: 'promiseguard-roles-v1', policy: 'selection-v1', schema: '2' };

test('wrong recipient, phantom Slack and incomplete source faults survive as attempted adverse evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'q04-faults-'));
  try {
    const suite = await loadFixtureSuite();
    const harness = createScenarioHarness({ suite, directory, release,
      runtimeFactory: createScenarioRuntime, support: scenarioRuntimeSupport });
    const report = await harness.run(['pg-f11-baseline', 'pg-f11-phantom_slack_success', 'pg-f14-baseline']);
    assert.equal(report.counts.attempted, 3, JSON.stringify(report.diagnostics));
    assert.equal(report.counts.setupFailed, 0, 'faults are armed after the independent S0 boundary');
    for (const attempt of report.attempts) {
      assert.ok(attempt.resultRef, attempt.diagnostics.join(','));
      const result = JSON.parse(await readFile(join(directory, 'artifacts', `${attempt.resultRef.artifactId}.json`), 'utf8'));
      const events: EventV2[] = result.events.map((value: unknown) => EventV2Schema.parse(value));
      assert.equal(events.filter(event => event.kind === 'success.claimed' && event.claim.scope === 'run').length, 0);
      assert.equal(attempt.productStatus, attempt.registration.suiteEntryId === 'pg-f14-baseline' ? 'failed' : 'failed_partial');
      if (attempt.registration.suiteEntryId === 'pg-f11-baseline') {
        assert.ok(result.checks.some((check: { code: string; status: string }) => check.code === 'approved_draft_to' && check.status === 'failed'),
          JSON.stringify({ checks: result.checks, records: result.s1.records.gmail }));
      }
      if (attempt.registration.suiteEntryId === 'pg-f11-phantom_slack_success') {
        assert.ok(result.checks.some((check: { code: string; status: string }) => check.code === 'required_thread' && check.status === 'failed'));
      }
      const census = report.census.find(entry => entry.suiteEntryId === attempt.registration.suiteEntryId);
      assert.ok(census?.disposition === 'attempted');
      assert.notEqual(census.result, 'passed');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);

test('S0 collection failure and missing receipt bytes stay setup-failed outside attempted denominators', async () => {
  const suite = await loadFixtureSuite();
  for (const fault of ['s0_read', 'missing_artifact'] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'q04-setup-failure-'));
    try {
      let s0Read = false;
      const runtimeFactory: HarnessOptions['runtimeFactory'] = options => createScenarioRuntime({ ...options,
        prepare: input => options.prepare({ ...input, runtime: { ...input.runtime,
          ...(fault === 'missing_artifact' ? { readArtifact: () => null } : {}),
          readers: { ...input.runtime.readers, gmail: { ...input.runtime.readers.gmail,
            async listDrafts(context) {
              s0Read = true;
              if (fault === 's0_read') throw new Error('injected_s0_read_failure');
              return input.runtime.readers.gmail.listDrafts(context);
            } } },
        } }),
      });
      const options = { suite, directory, release, runtimeFactory, support: scenarioRuntimeSupport };
      const harness = createScenarioHarness(options);
      const report = await harness.run(['pg-f01-baseline']);
      assert.equal(s0Read, true);
      assert.equal(report.counts.attempted, 0);
      assert.equal(report.counts.setupFailed, 1);
      assert.equal(report.attempts.length, 0);
      assert.equal(report.counts.unrun, suite.scenarios.entries.length - 1);
      const row = report.census.find(entry => entry.suiteEntryId === 'pg-f01-baseline');
      assert.ok(row?.disposition === 'setup_failed');
      assert.match(row.reason, fault === 's0_read' ? /s0_read_failure/ : /application_transaction_failed|evidence_artifact_missing/);
      assert.deepEqual((await harness.run(['pg-f01-baseline'])).counts, report.counts);
      assert.deepEqual(createScenarioHarness(options).report().census, report.census);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}, 30000);

test('a crash immediately after registration remains attempted and pending across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'q04-registered-crash-'));
  try {
    const suite = await loadFixtureSuite();
    const runtimeFactory: HarnessOptions['runtimeFactory'] = async options => {
      const runtime = await createScenarioRuntime(options);
      return { ...runtime, async startRun() {
        await runtime.services.driver.accept(runtime.world.github.technicalEvidence.incident.canonicalUrl, runtime.ownerId);
        throw new Error('injected_registered_start_failure');
      } };
    };
    const options = { suite, directory, release, runtimeFactory, support: scenarioRuntimeSupport };
    const report = await createScenarioHarness(options).run(['pg-f01-baseline']);
    assert.equal(report.counts.attempted, 1, JSON.stringify(report.diagnostics));
    assert.equal(report.counts.pending, 1);
    assert.equal(report.counts.setupFailed, 0);
    assert.equal(report.attempts[0].resultRef, null);
    assert.ok(report.attempts[0].diagnostics.includes('injected_registered_start_failure'));
    const reopened = createScenarioHarness(options);
    const again = await reopened.run(['pg-f01-baseline']);
    assert.deepEqual(again.attempts, report.attempts);
    assert.deepEqual(again.census, report.census);
    assert.equal(again.counts.attempted, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);
