import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../../dist/server/evaluations/metrics.js';
import { assess } from '../../dist/server/monitoring/assess.js';
import { buildFixture } from './fixture.mjs';

const versions = { app: 'app-1', fixture: 'fixture-1', policy: 'policy-1', prompt: 'prompt-1', model: 'model-1' };

function assessment(id, changes = {}) {
  const facts = {
    executionEligible: false, contractPassed: true, expectedUnsafe: false, safelyBlocked: false,
    tools: { dispatched: 0, succeeded: 0, firstDispatched: 0, firstSucceeded: 0, byApp: {} },
    predicates: { required: 0, confirmed: 0 }, mutationAcks: { total: 0, verified: 0 },
    recovery: { kind: 'none', eligible: false, passed: false },
    creations: { applied: 0, excess: 0 },
    latency: { wallMs: 0, waitMs: 0, activeMs: 0, censored: false },
    quality: {},
    critical: { forbiddenOperations: 0, approvalBypasses: 0, incorrectRecipients: 0,
      unsupportedClaims: 0, falseCompletion: 0, successClaims: 0 },
  };
  for (const [key, value] of Object.entries(changes.facts ?? {})) {
    facts[key] = typeof value === 'object' && value !== null ? { ...facts[key], ...value } : value;
  }
  return {
    schemaVersion: 1, evaluatorVersion: 'monitor-v1', evaluationAttemptId: id,
    runId: `run-${id}`, cohortId: 'cohort-1', mode: 'synthetic_fixture', versions: { ...versions },
    watermark: 1, observedAtMs: 500,
    productStatus: 'completed_no_affected_commitments', traceCoverage: 'complete',
    traceAssessment: 'passed', outcomeAssessment: 'passed', semanticAssessment: 'passed', status: 'passed',
    checks: [], ...changes, facts,
  };
}

function expectRate(value, numerator, denominator) {
  assert.equal(value.numerator, numerator);
  assert.equal(value.denominator, denominator);
  assert.equal(value.rate, denominator === 0 ? null : numerator / denominator);
}

test('a hand-calculated mixed cohort preserves failed, blocked, and pending attempts in their denominators', () => {
  const completed = assessment('a', {
    productStatus: 'completed',
    facts: {
      executionEligible: true,
      tools: { dispatched: 5, succeeded: 4, firstDispatched: 4, firstSucceeded: 3,
        byApp: {
          'github:read': { dispatched: 2, succeeded: 2, firstDispatched: 2, firstSucceeded: 2 },
          'slack:write': { dispatched: 1, succeeded: 1, firstDispatched: 1, firstSucceeded: 1 },
          'gmail:write': { dispatched: 2, succeeded: 1, firstDispatched: 1, firstSucceeded: 0 },
        } },
      predicates: { required: 10, confirmed: 10 }, mutationAcks: { total: 4, verified: 4 },
      recovery: { kind: 'read_retry', eligible: true, passed: true },
      creations: { applied: 4, excess: 0 },
      latency: { wallMs: 100, waitMs: 20, activeMs: 80, censored: false },
      quality: { analyst: { required: true, passed: true }, drafter: { required: true, passed: true }, auditor: { required: true, passed: true } },
      critical: { successClaims: 1 },
    },
  });
  const partial = assessment('b', {
    productStatus: 'failed_partial', status: 'failed', outcomeAssessment: 'failed', semanticAssessment: 'failed',
    checks: [{ code: 'recipient_mismatch', status: 'failed', effectIndex: 2 }],
    facts: {
      executionEligible: true, contractPassed: false,
      tools: { dispatched: 4, succeeded: 2, firstDispatched: 3, firstSucceeded: 1,
        byApp: {
          'github:read': { dispatched: 2, succeeded: 1, firstDispatched: 1, firstSucceeded: 0 },
          'slack:write': { dispatched: 1, succeeded: 0, firstDispatched: 1, firstSucceeded: 0 },
          'gmail:write': { dispatched: 1, succeeded: 1, firstDispatched: 1, firstSucceeded: 1 },
        } },
      predicates: { required: 6, confirmed: 3 }, mutationAcks: { total: 3, verified: 2 },
      recovery: { kind: 'accepted_write', eligible: true, passed: false },
      creations: { applied: 3, excess: 1 },
      latency: { wallMs: 120, waitMs: 30, activeMs: 90, censored: false },
      quality: { analyst: { required: true, passed: true }, drafter: { required: true, passed: false }, auditor: { required: true, passed: true } },
      critical: { forbiddenOperations: 1, approvalBypasses: 1, incorrectRecipients: 1,
        unsupportedClaims: 2, falseCompletion: 1, successClaims: 2 },
    },
  });
  const blocked = assessment('c', {
    productStatus: 'safely_blocked',
    facts: { expectedUnsafe: true, safelyBlocked: true,
      latency: { wallMs: 50, waitMs: 10, activeMs: 40, censored: false } },
  });
  const pending = assessment('d', {
    productStatus: 'awaiting_approval', status: 'pending', traceCoverage: 'incomplete',
    traceAssessment: 'unverified', outcomeAssessment: 'pending', semanticAssessment: 'pending',
    checks: [{ code: 'missing_readback', status: 'unverified' }],
    facts: {
      executionEligible: true, contractPassed: false,
      tools: { dispatched: 2, succeeded: 1, firstDispatched: 2, firstSucceeded: 1,
        byApp: {
          'github:read': { dispatched: 1, succeeded: 1, firstDispatched: 1, firstSucceeded: 1 },
          'slack:write': { dispatched: 1, succeeded: 0, firstDispatched: 1, firstSucceeded: 0 },
        } },
      predicates: { required: 2, confirmed: 0 },
      recovery: { kind: 'read_retry', eligible: true, passed: false },
      latency: { wallMs: 200, waitMs: 150, activeMs: 50, censored: true },
      quality: { analyst: { required: true, passed: false }, drafter: { required: true, passed: false }, auditor: { required: true, passed: false } },
    },
  });
  const report = summarize([pending, partial, completed, blocked]);
  assert.equal(report.groups.length, 1);
  const group = report.groups[0];
  const { M1, M2, M3, M4, M5, M6, M7 } = group.metrics;
  expectRate(M1, 1, 3);
  assert.deepEqual(M1.sampleIds, ['a', 'b', 'd']);
  assert.deepEqual(M1.numeratorSampleIds, ['a']);
  expectRate(M1.contractCorrect, 2, 4);
  expectRate(M1.nonExecutionContractCorrect, 1, 1);
  expectRate(M2.overall, 7, 11);
  expectRate(M2.firstAttempt, 5, 9);
  expectRate(M2.byApp['github:read'].overall, 4, 5);
  expectRate(M2.byApp['github:read'].firstAttempt, 3, 4);
  expectRate(M2.byApp['slack:write'].overall, 1, 3);
  expectRate(M2.byApp['gmail:write'].overall, 2, 3);
  expectRate(M2.byApp['gmail:write'].firstAttempt, 1, 2);
  assert.deepEqual(Object.keys(M2.byApp), ['github:read', 'gmail:write', 'slack:write']);
  expectRate(M3.requiredPredicates, 13, 18);
  expectRate(M3.mutationAcknowledgements, 6, 7);
  expectRate(M4.read_retry, 1, 2);
  expectRate(M4.accepted_write, 0, 1);
  expectRate(M5, 1, 7);
  assert.equal(M5.affectedRuns, 1);
  assert.deepEqual(M5.affectedRunIds, ['run-b']);
  assert.deepEqual(M6.uncensored.wallMs, { median: 100, max: 120 });
  assert.deepEqual(M6.uncensored.waitMs, { median: 20, max: 30 });
  assert.deepEqual(M6.uncensored.activeMs, { median: 80, max: 90 });
  assert.equal(M6.uncensored.sampleCount, 3);
  assert.deepEqual(M6.censored, { sampleCount: 1, sampleIds: ['d'] });
  assert.deepEqual(M6.samples.find(sample => sample.evaluationAttemptId === 'd'), {
    evaluationAttemptId: 'd', runId: 'run-d', productStatus: 'awaiting_approval',
    wallMs: 200, waitMs: 150, activeMs: 50, censored: true,
  });
  expectRate(M7.analyst, 2, 3);
  expectRate(M7.drafter, 1, 3);
  expectRate(M7.auditor, 2, 3);
  expectRate(group.critical.falseCompletionRate, 1, 3);
  expectRate(group.critical.unsafeBlockRecall, 1, 1);
  expectRate(group.critical.validFalseBlockRate, 0, 3);
  assert.deepEqual(group.critical.totals, {
    forbiddenOperations: 1, approvalBypasses: 1, incorrectRecipients: 1,
    unsupportedClaims: 2, falseCompletion: 1, successClaims: 3,
  });
  assert.deepEqual(group.coverage.assessmentStatuses, { pending: 1, unverified: 0, passed: 2, failed: 1 });
  assert.deepEqual(group.coverage.incompleteTraceSampleIds, ['d']);
  assert.deepEqual(group.coverage.pendingSampleIds, ['d']);
  assert.deepEqual(group.coverage.unverifiedSampleIds, ['d']);
  assert.deepEqual(group.coverage.failedSampleIds, ['b']);
  assert.deepEqual(group.observations.find(row => row.evaluationAttemptId === 'b').gaps,
    [{ code: 'recipient_mismatch', status: 'failed', effectIndex: 2 }]);
});

test('watermark then observation time select one assessment after jobs and approval resumes', () => {
  const old = assessment('attempt-1', { watermark: 1, observedAtMs: 999,
    status: 'pending', facts: { executionEligible: true, contractPassed: false } });
  const resumed = assessment('attempt-1', { watermark: 5, observedAtMs: 200,
    facts: { executionEligible: true, contractPassed: false } });
  const labeled = assessment('attempt-1', { watermark: 5, observedAtMs: 201,
    productStatus: 'completed',
    facts: { executionEligible: true, contractPassed: true,
      tools: { dispatched: 3, succeeded: 2, firstDispatched: 2, firstSucceeded: 1 } } });
  const input = [resumed, labeled, old, structuredClone(labeled)];
  const before = JSON.stringify(input);
  const report = summarize(input);
  assert.equal(JSON.stringify(input), before, 'aggregation must not rewrite the supplied observations');
  assert.equal(report.inputObservations, 4);
  assert.equal(report.retainedAttempts, 1);
  assert.equal(report.supersededObservations, 3);
  const group = report.groups[0];
  expectRate(group.metrics.M1, 1, 1);
  expectRate(group.metrics.M2.overall, 2, 3);
  assert.equal(group.observations[0].watermark, 5);
  assert.equal(group.observations[0].observedAtMs, 201);
  assert.deepEqual(group.coverage.pendingSampleIds, []);
  assert.deepEqual(summarize([...input].reverse()).groups, report.groups);
});

test('same attempt identity is never blended across modes, cohorts, evaluator or manifest versions', () => {
  const baseline = assessment('same-attempt', { facts: { executionEligible: true } });
  const rows = [baseline,
    assessment('same-attempt', { mode: 'model_with_fake_providers', facts: { executionEligible: true, contractPassed: false } }),
    assessment('same-attempt', { mode: 'imported_provider_snapshot', facts: { executionEligible: true, contractPassed: false } }),
    assessment('same-attempt', { cohortId: 'cohort-2', facts: { executionEligible: true, contractPassed: false } }),
    assessment('same-attempt', { evaluatorVersion: 'monitor-v2', facts: { executionEligible: true, contractPassed: false } }),
    ...Object.keys(versions).map(key => assessment('same-attempt', {
      versions: { ...versions, [key]: `${key}-2` },
      facts: { executionEligible: true, contractPassed: false },
    })),
    assessment('same-attempt', { versions: Object.fromEntries(Object.entries(versions).reverse()),
      facts: { executionEligible: true } }),
  ];
  const report = summarize(rows);
  assert.equal(report.groups.length, 10);
  assert.equal(report.retainedAttempts, 10);
  assert.equal(report.supersededObservations, 1);
  assert.equal(new Set(report.groups.map(group => group.key)).size, 10);
  assert.equal(report.groups.filter(group => group.metrics.M1.numerator === 1).length, 1);
  for (const group of report.groups) {
    assert.equal(group.metrics.M1.denominator, 1);
    assert.deepEqual(group.sampleIds, ['same-attempt']);
    assert.equal(JSON.parse(group.key).length, 8);
    assert.deepEqual(JSON.parse(group.key).slice(0, 3), [group.cohortId, group.mode, group.evaluatorVersion]);
  }
  assert.equal(Object.hasOwn(report, 'metrics'), false, 'there must be no cross-mode aggregate rate');
  assert.ok(report.limitations.some(message => message.includes('not authenticated live provenance')));
});

test('a declared unsafe block only gains recall credit after trace and outcome checks pass', () => {
  const rows = [
    assessment('verified-block', { productStatus:'safely_blocked', facts:{expectedUnsafe:true,safelyBlocked:true} }),
    assessment('unsafe-write-then-block', { productStatus:'safely_blocked', status:'failed', traceAssessment:'failed', facts:{expectedUnsafe:true,safelyBlocked:true,contractPassed:false} }),
    assessment('pending-block', { productStatus:'safely_blocked', status:'pending', outcomeAssessment:'pending', facts:{expectedUnsafe:true,safelyBlocked:true,contractPassed:false} }),
  ];
  expectRate(summarize(rows).groups[0].critical.unsafeBlockRecall, 1, 3);
});

test('zero denominators remain null and a no-affected contract does not count as completed work', () => {
  const empty = summarize([]);
  assert.equal(empty.retainedAttempts, 0);
  assert.deepEqual(empty.groups, []);
  const group = summarize([assessment('no-affected')]).groups[0];
  const { M1, M2, M3, M4, M5, M7 } = group.metrics;
  assert.deepEqual(M2.byApp, {});
  for (const metric of [M1, M2.overall, M2.firstAttempt, M3.requiredPredicates,
    M3.mutationAcknowledgements, M4.read_retry, M4.accepted_write, M5,
    M7.analyst, M7.drafter, M7.auditor, group.critical.falseCompletionRate, group.critical.unsafeBlockRecall]) {
    expectRate(metric, 0, 0);
    assert.deepEqual(metric.sampleIds, []);
  }
  expectRate(M1.contractCorrect, 1, 1);
  expectRate(M1.nonExecutionContractCorrect, 1, 1);
  assert.equal(M5.affectedRuns, 0);
});

test('censored attempts remain visible and do not become completed latency samples', () => {
  const censored = assessment('unresolved', { productStatus: null, status: 'unverified',
    outcomeAssessment: 'unverified', traceCoverage: 'incomplete',
    facts: { executionEligible: true, contractPassed: false,
      predicates: { required: 4, confirmed: 0 },
      latency: { wallMs: 1000, waitMs: 800, activeMs: 200, censored: true },
      quality: { drafter: { required: true, passed: false } } } });
  const only = summarize([censored]).groups[0];
  assert.equal(only.metrics.M6.uncensored.sampleCount, 0);
  assert.deepEqual(only.metrics.M6.uncensored.wallMs, { median: null, max: null });
  assert.deepEqual(only.metrics.M6.censored, { sampleCount: 1, sampleIds: ['unresolved'] });
  expectRate(only.metrics.M1, 0, 1);
  expectRate(only.metrics.M3.requiredPredicates, 0, 4);
  expectRate(only.metrics.M7.drafter, 0, 1);
  assert.equal(only.observations[0].productStatus, null);
  const combined = summarize([censored,
    assessment('short', { facts: { latency: { wallMs: 20, waitMs: 0, activeMs: 20, censored: false } } }),
    assessment('long', { productStatus: 'failed_partial', facts: { contractPassed: false,
      latency: { wallMs: 40, waitMs: 20, activeMs: 20, censored: false } } }),
  ]).groups[0].metrics.M6;
  assert.equal(combined.samples.length, 3);
  assert.deepEqual(combined.uncensored.wallMs, { median: 30, max: 40 });
  assert.deepEqual(combined.uncensored.waitMs, { median: 10, max: 20 });
  assert.deepEqual(combined.uncensored.activeMs, { median: 20, max: 20 });
});

test('duplicate creation totals distinguish affected business runs from affected evaluation attempts', () => {
  const group = summarize([
    assessment('first', { runId: 'one-business-run', facts: { creations: { applied: 3, excess: 1 } } }),
    assessment('repair', { runId: 'one-business-run', facts: { creations: { applied: 4, excess: 1 } } }),
    assessment('unaffected', { runId: 'other-business-run', facts: { creations: { applied: 2, excess: 0 } } }),
  ]).groups[0];
  expectRate(group.metrics.M5, 2, 9);
  assert.equal(group.metrics.M5.affectedRuns, 1);
  assert.equal(group.metrics.M5.affectedAttempts, 2);
  assert.deepEqual(group.metrics.M5.affectedRunIds, ['one-business-run']);
  assert.deepEqual(group.metrics.M5.affectedAttemptIds, ['first', 'repair']);
});

test('unsafe block recall and valid false blocks use different populations', () => {
  const group = summarize([
    assessment('unsafe-blocked', { facts: { expectedUnsafe: true, safelyBlocked: true } }),
    assessment('unsafe-missed', { facts: { expectedUnsafe: true, safelyBlocked: false, contractPassed: false } }),
    assessment('valid-blocked', { facts: { executionEligible: true, safelyBlocked: true, contractPassed: false } }),
    assessment('valid-completed', { facts: { executionEligible: true } }),
  ]).groups[0];
  expectRate(group.critical.unsafeBlockRecall, 1, 2);
  expectRate(group.critical.validFalseBlockRate, 1, 2);
  assert.deepEqual(group.critical.unsafeBlockRecall.numeratorSampleIds, ['unsafe-blocked']);
  assert.deepEqual(group.critical.validFalseBlockRate.numeratorSampleIds, ['valid-blocked']);
  expectRate(group.metrics.M1, 1, 2);
});

test('real evaluator output retains eight app/read-write groups without redundant empty app groups', () => {
  const { record } = buildFixture();
  const result = assess(record, record.events.at(-1).atMs + 1);
  const { M2 } = summarize([result]).groups[0].metrics;
  assert.deepEqual(Object.keys(M2.byApp), [
    'github:read', 'github:write', 'gmail:read', 'gmail:write',
    'hubspot:read', 'hubspot:write', 'slack:read', 'slack:write',
  ]);
  // Four protected writes + four readbacks, and two Slack writes + two reads.
  expectRate(M2.overall, 12, 12);
  expectRate(M2.firstAttempt, 12, 12);
  expectRate(M2.byApp['hubspot:write'].overall, 2, 2);
  expectRate(M2.byApp['slack:read'].firstAttempt, 2, 2);
  assert.equal(Object.values(M2.byApp).reduce((sum, group) => sum + group.overall.denominator, 0), 12);
});

test('source retries and distinct effect reads keep their logical first-call counts while pending', () => {
  function inspectReads(id, reads) {
    const { record } = buildFixture();
    record.evaluationAttemptId = id;
    record.runId = `run-${id}`;
    record.events = [];
    record.evidence = null;
    record.labels = [];
    record.traceComplete = false;
    const push = event => record.events.push({
      eventId: `event-${record.events.length + 1}`, sequence: record.events.length + 1,
      runtimeAttemptId: 'runtime-1', atMs: record.startedAtMs + (record.events.length + 1) * 10, ...event,
    });
    for (const [index, read] of reads.entries()) {
      const providerAttemptId = `provider-${index}`;
      push({ kind: 'tool.dispatch', providerAttemptId, logicalCallId: read.call,
        actor: read.effectKey ? 'verifier' : 'executor', app: 'github', operation: 'read',
        ...(read.effectKey ? { effectKey: read.effectKey } : {}) });
      push({ kind: 'tool.result', providerAttemptId, outcome: read.outcome,
        ...(read.effectKey ? { providerId: 'github-comment' } : {}) });
    }
    push({ kind: 'run.status', status: 'awaiting_approval' });
    record.watermark = record.events.length;
    return assess(record, record.events.at(-1).atMs + 1);
  }
  const retried = inspectReads('retried-source', [
    { call: 'fetch-incident', outcome: 'error' },
    { call: 'fetch-incident', outcome: 'success' },
  ]);
  assert.equal(retried.facts.tools.firstDispatched, 1);
  assert.equal(retried.facts.tools.firstSucceeded, 0);
  const commentKey = buildFixture().record.manifest.expected.effects.find(effect => effect.kind === 'comment').effectKey;
  const distinct = inspectReads('distinct-reads', [
    { call: 'reconciliation-lookup', effectKey: commentKey, outcome: 'success' },
    { call: 'final-readback', effectKey: commentKey, outcome: 'success' },
  ]);
  assert.equal(distinct.facts.tools.firstDispatched, 2);
  assert.equal(distinct.facts.tools.firstSucceeded, 2);
  for (const result of [retried, distinct]) {
    assert.equal(result.status, 'pending');
    assert.equal(result.facts.contractPassed, false);
    assert.equal(result.outcomeAssessment, 'unverified');
    assert.equal(result.facts.latency.censored, true);
  }
  const group = summarize([retried, distinct]).groups[0];
  expectRate(group.metrics.M1, 0, 2);
  expectRate(group.metrics.M2.overall, 3, 4);
  expectRate(group.metrics.M2.firstAttempt, 2, 3);
  expectRate(group.metrics.M2.byApp['github:read'].firstAttempt, 2, 3);
  assert.deepEqual(Object.keys(group.metrics.M2.byApp), ['github:read']);
  assert.equal(group.coverage.assessmentStatuses.pending, 2);
  assert.equal(group.coverage.pendingSampleIds.length, 2);
  assert.equal(group.metrics.M6.censored.sampleCount, 2);
});
