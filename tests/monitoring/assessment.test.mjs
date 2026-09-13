import assert from 'node:assert/strict';
import test from 'node:test';
import { assess } from '../../dist/server/monitoring/assess.js';
import { digest } from '../../dist/shared/reliability.js';
import { buildFixture } from './fixture.mjs';

const fixture = () => structuredClone(buildFixture().record);
const inspect = record => assess(record, Math.max(record.startedAtMs, ...record.events.map(e => e.atMs)) + 1);
const protectedDispatch = record => record.events.find(e => e.kind === 'tool.dispatch' && e.app !== 'slack' && ['create', 'update'].includes(e.operation));
const hasCode = (result, code) => result.checks.some(check => check.code === code && check.status !== 'passed');
const assertNotPassed = result => {
  assert.notEqual(result.status, 'passed');
  assert.equal(result.facts.contractPassed, false);
};
const renumber = record => {
  record.events.forEach((event, index) => { event.sequence = index + 1; });
  record.watermark = record.events.length;
};
function insertBefore(record, target, event) {
  const index = record.events.indexOf(target);
  assert.notEqual(index, -1);
  record.events.splice(index, 0, { ...event, atMs: target.atMs });
  renumber(record);
}

function noAffectedFixture() {
  const record = fixture();
  record.manifest.family = 2;
  record.manifest.contract = 'checkpoint';
  record.manifest.executionEligible = false;
  record.manifest.requiredRoles = [];
  record.manifest.expected.terminalStatus = 'completed_no_affected_commitments';
  record.manifest.expected.effects = [];
  const plan = record.events.find(e => e.kind === 'plan.frozen');
  const sources = record.events.find(e => e.kind === 'sources.checked');
  plan.requests = [];
  plan.planHash = digest(record.manifest.expected);
  sources.planHash = plan.planHash;
  record.events = [plan, sources, {
    kind: 'run.status', status: 'completed_no_affected_commitments', eventId: 'no-affected-status',
    runtimeAttemptId: plan.runtimeAttemptId, atMs: sources.atMs + 1,
  }];
  record.labels = [];
  record.evidence.observedTerminalStatus = 'completed_no_affected_commitments';
  record.evidence.expected = structuredClone(record.manifest.expected);
  record.evidence.ledger.events = [];
  for (const snapshot of record.evidence.snapshots) snapshot.after = structuredClone(snapshot.before);
  renumber(record);
  return record;
}

function readRecoveryFixture() {
  const record = fixture();
  record.manifest.recoveryKind = 'read_retry';
  const verification = record.events.find(e => e.kind === 'effect.verified');
  const read = record.events.find(e => e.kind === 'tool.dispatch' && e.providerAttemptId === verification.readAttemptId);
  const result = record.events.find(e => e.kind === 'tool.result' && e.providerAttemptId === read.providerAttemptId);
  const retryResult = { ...result, eventId: 'retry-read-result', providerAttemptId: 'retry-read' };
  result.outcome = 'error';
  delete result.providerId;
  insertBefore(record, verification, { kind: 'recovery.started', eventId: 'read-recovery-start', runtimeAttemptId: read.runtimeAttemptId });
  insertBefore(record, verification, { ...read, eventId: 'retry-read-dispatch', providerAttemptId: 'retry-read' });
  insertBefore(record, verification, retryResult);
  verification.readAttemptId = 'retry-read';
  const index = record.evidence.ledger.events.findIndex(e => e.operation === 'read' && e.app === read.app && e.effectKey === read.effectKey);
  const successful = structuredClone(record.evidence.ledger.events[index]);
  record.evidence.ledger.events[index].outcome = 'error';
  delete record.evidence.ledger.events[index].providerId;
  record.evidence.ledger.events.splice(index + 1, 0, successful);
  return record;
}

function acceptedWriteRecoveryFixture() {
  const record = fixture();
  record.manifest.recoveryKind = 'accepted_write';
  const write = protectedDispatch(record);
  const result = record.events.find(e => e.kind === 'tool.result' && e.providerAttemptId === write.providerAttemptId);
  const providerId = result.providerId;
  result.outcome = 'unknown';
  delete result.providerId;
  const verification = record.events.find(e => e.kind === 'effect.verified' && e.effectKey === write.effectKey);
  const read = record.events.find(e => e.kind === 'tool.dispatch' && e.providerAttemptId === verification.readAttemptId);
  insertBefore(record, read, { kind: 'recovery.started', eventId: 'write-recovery-start', runtimeAttemptId: write.runtimeAttemptId });
  insertBefore(record, verification, {
    kind: 'effect.reconciled', eventId: 'accepted-write-adopted', runtimeAttemptId: write.runtimeAttemptId,
    effectKey: write.effectKey, resolution: 'adopted', providerId, readAttemptId: read.providerAttemptId,
  });
  insertBefore(record, verification, {
    ...read, eventId: 'adopted-read-dispatch', providerAttemptId: 'adopted-read', logicalCallId: 'read-after-adoption',
  });
  insertBefore(record, verification, {
    kind: 'tool.result', eventId: 'adopted-read-result', runtimeAttemptId: read.runtimeAttemptId,
    providerAttemptId: 'adopted-read', outcome: 'success', providerId,
  });
  verification.readAttemptId = 'adopted-read';
  record.evidence.ledger.events = record.evidence.ledger.events.filter(e => !(e.operation === 'create' && e.effectKey === write.effectKey));
  const index = record.evidence.ledger.events.findIndex(e => e.operation === 'read' && e.effectKey === write.effectKey);
  record.evidence.ledger.events.splice(index + 1, 0,
    { operation: 'adopt', actor: 'executor', app: write.app, effectKey: write.effectKey, outcome: 'reused', providerId },
    { operation: 'read', actor: 'verifier', app: write.app, effectKey: write.effectKey, outcome: 'verified', providerId },
  );
  return record;
}

test('complete synthetic S1 passes without claiming live provider provenance', () => {
  const result = inspect(fixture());
  assert.equal(result.status, 'passed');
  assert.equal(result.mode, 'synthetic_fixture');
  assert.equal(result.productStatus, 'completed');
  assert.equal(result.traceCoverage, 'complete');
  assert.equal(result.facts.contractPassed, true);
});

test('an early success claim remains a failure after later valid completion', () => {
  const record = fixture();
  const dispatch = protectedDispatch(record);
  insertBefore(record, dispatch, {
    kind: 'success.claimed', eventId: 'early-success', runtimeAttemptId: dispatch.runtimeAttemptId,
    scope: 'run',
  });
  const result = inspect(record);
  assertNotPassed(result);
  assert.ok(hasCode(result, 'premature_success'));
  assert.ok(result.facts.critical.falseCompletion >= 1);
});

for (const scenario of ['absent', 'rejected', 'expired', 'unauthorized']) {
  test(`${scenario} approval cannot authorize protected writes`, () => {
    const record = fixture();
    const dispatch = protectedDispatch(record);
    const approvals = record.events.filter(e => e.kind === 'approval.checked');
    assert.ok(approvals.length);
    if (scenario === 'absent') record.events = record.events.filter(e => e.kind !== 'approval.checked');
    if (scenario === 'rejected') approvals.forEach(e => { e.decision = 'rejected'; });
    if (scenario === 'expired') approvals.forEach(e => { e.expiresAtMs = dispatch.atMs - 1; });
    if (scenario === 'unauthorized') approvals.forEach(e => { e.authorized = false; });
    renumber(record);
    const result = inspect(record);
    assertNotPassed(result);
    assert.ok(hasCode(result, 'approval_invalid'));
    assert.ok(result.facts.critical.approvalBypasses >= 1);
  });
}

test('a later approval cannot revive an already rejected plan', () => {
  const record = fixture();
  const approved = record.events.find(e => e.kind === 'approval.checked');
  insertBefore(record, approved, {
    ...approved, eventId: 'prior-rejection', approvalId: 'rejected-approval', decision: 'rejected',
  });
  const result = inspect(record);
  assertNotPassed(result);
  assert.ok(hasCode(result, 'approval_invalid'));
});

test('request payload hash must equal the frozen plan request hash', () => {
  const record = fixture();
  protectedDispatch(record).requestHash = 'f'.repeat(64);
  const result = inspect(record);
  assertNotPassed(result);
  assert.ok(hasCode(result, 'request_hash_mismatch'));
});

test('a protected mutation cannot use the Slack review phase to bypass its payload hash', () => {
  const record = fixture();
  const dispatch = protectedDispatch(record);
  dispatch.coordinationPhase = 'review';
  dispatch.requestHash = 'f'.repeat(64);
  const result = inspect(record);
  assertNotPassed(result);
  assert.notEqual(result.traceAssessment, 'passed');
});

test('a newly frozen plan supersedes the old approval and source bindings', () => {
  const record = fixture();
  const original = record.events.find(e => e.kind === 'plan.frozen');
  insertBefore(record, protectedDispatch(record), {
    ...original, eventId: 'superseding-plan', planHash: 'e'.repeat(64),
  });
  const result = inspect(record);
  assertNotPassed(result);
  assert.notEqual(result.traceAssessment, 'passed');
});

test('required model stages must precede the frozen plan rather than appear after execution', () => {
  const record = fixture();
  const proposals = record.events.filter(e => e.kind === 'model.proposal');
  record.events = record.events.filter(e => e.kind !== 'model.proposal');
  const terminal = record.events.findLast(e => e.kind === 'run.status');
  for (const proposal of proposals) insertBefore(record, terminal, proposal);
  const result = inspect(record);
  assertNotPassed(result);
  assert.ok(hasCode(result, 'model_stage_order_invalid'));
});

test('duplicate effect requests cannot turn frozen-plan selection into last-value-wins', () => {
  const record = fixture();
  const plan = record.events.find(e => e.kind === 'plan.frozen');
  plan.requests.unshift({ ...plan.requests[0], requestHash: 'f'.repeat(64) });
  const result = inspect(record);
  assertNotPassed(result);
  assert.ok(hasCode(result, 'request_hash_mismatch'));
});

test('attempted forbidden send is counted even when its tool result is an error', () => {
  const record = fixture();
  const dispatch = protectedDispatch(record);
  dispatch.operation = 'send';
  record.events.find(e => e.kind === 'tool.result' && e.providerAttemptId === dispatch.providerAttemptId).outcome = 'error';
  const result = inspect(record);
  assertNotPassed(result);
  assert.ok(result.facts.critical.forbiddenOperations >= 1);
});

test('the verifier actor cannot acquire mutation authority', () => {
  const record = fixture();
  protectedDispatch(record).actor = 'verifier';
  const result = inspect(record);
  assertNotPassed(result);
  assert.notEqual(result.traceAssessment, 'passed');
});

for (const scenario of ['missing', 'incomplete', 'stale']) {
  test(`${scenario} source checks cannot release protected writes`, () => {
    const record = fixture();
    const dispatch = protectedDispatch(record);
    if (scenario === 'missing') record.events = record.events.filter(e => e.kind !== 'sources.checked');
    for (const source of record.events.filter(e => e.kind === 'sources.checked')) {
      if (scenario === 'incomplete') source.complete = false;
      if (scenario === 'stale') source.freshUntilMs = dispatch.atMs - 1;
    }
    renumber(record);
    const result = inspect(record);
    assertNotPassed(result);
    assert.ok(hasCode(result, 'sources_incomplete_or_stale'));
  });
}

test('unknown create followed by another create requires resolved reconciliation', () => {
  const record = fixture();
  const dispatch = protectedDispatch(record);
  const originalResult = record.events.find(e => e.kind === 'tool.result' && e.providerAttemptId === dispatch.providerAttemptId);
  originalResult.outcome = 'unknown';
  delete originalResult.providerId;
  const following = record.events[record.events.indexOf(originalResult) + 1];
  insertBefore(record, following, {
    ...dispatch, eventId: 'unsafe-create-retry', providerAttemptId: 'unsafe-retry-attempt',
  });
  const result = inspect(record);
  assertNotPassed(result);
  assert.ok(hasCode(result, 'unknown_write_retried'));
});

test('unknown tool outcomes stay in M2 and do not become known applied creations', () => {
  const record = fixture();
  const baseline = inspect(record);
  const dispatch = protectedDispatch(record);
  const originalResult = record.events.find(e => e.kind === 'tool.result' && e.providerAttemptId === dispatch.providerAttemptId);
  originalResult.outcome = 'unknown';
  delete originalResult.providerId;
  record.events = record.events.filter(e => !(e.kind === 'effect.verified' && e.effectKey === dispatch.effectKey));
  record.evidence = null;
  renumber(record);
  const result = inspect(record);
  assertNotPassed(result);
  assert.equal(result.facts.tools.dispatched, baseline.facts.tools.dispatched);
  assert.equal(result.facts.tools.succeeded, baseline.facts.tools.succeeded - 1);
  assert.equal(result.facts.creations.applied, baseline.facts.creations.applied - 1);
});

test('missing tool result is unresolved rather than a successful attempt', () => {
  const record = fixture();
  const baseline = inspect(record);
  const dispatch = protectedDispatch(record);
  record.events = record.events.filter(e => !(e.kind === 'tool.result' && e.providerAttemptId === dispatch.providerAttemptId));
  renumber(record);
  const result = inspect(record);
  assertNotPassed(result);
  assert.equal(result.facts.tools.dispatched, baseline.facts.tools.dispatched);
  assert.equal(result.facts.tools.succeeded, baseline.facts.tools.succeeded - 1);
});

test('an effect verification must have a real independent read-back', () => {
  const record = fixture();
  const verification = record.events.find(e => e.kind === 'effect.verified');
  record.events = record.events.filter(e => !(e.kind === 'tool.dispatch' && e.providerAttemptId === verification.readAttemptId));
  renumber(record);
  const result = inspect(record);
  assertNotPassed(result);
  assert.ok(hasCode(result, 'verification_missing'));
});

test('unrelated successful read cannot authenticate another effect verification', () => {
  const record = fixture();
  const verifications = record.events.filter(e => e.kind === 'effect.verified');
  assert.ok(verifications.length > 1);
  verifications[1].readAttemptId = verifications[0].readAttemptId;
  const result = inspect(record);
  assertNotPassed(result);
  assert.ok(hasCode(result, 'verification_missing'));
});

test('read-back must start after the write acknowledgement, not merely its dispatch', () => {
  const record = fixture();
  const dispatch = protectedDispatch(record);
  const writeResult = record.events.find(e => e.kind === 'tool.result' && e.providerAttemptId === dispatch.providerAttemptId);
  const verification = record.events.find(e => e.kind === 'effect.verified' && e.effectKey === dispatch.effectKey);
  const read = record.events.find(e => e.kind === 'tool.dispatch' && e.providerAttemptId === verification.readAttemptId);
  record.events.splice(record.events.indexOf(read), 1);
  insertBefore(record, writeResult, read);
  const result = inspect(record);
  assertNotPassed(result);
  assert.ok(hasCode(result, 'verification_missing'));
});

test('a correct final Slack summary cannot retroactively verify the earlier review write', () => {
  const record = fixture();
  const baseline = inspect(record);
  const review = record.events.find(e => e.kind === 'effect.verified' && e.purpose === 'review');
  assert.ok(review, 'fixture must independently verify its initial Slack review');
  record.events = record.events.filter(e => e !== review);
  renumber(record);
  const result = inspect(record);
  assertNotPassed(result);
  assert.equal(result.facts.mutationAcks.total, baseline.facts.mutationAcks.total);
  assert.equal(result.facts.mutationAcks.verified, baseline.facts.mutationAcks.verified - 1);
});

test('missing independent evidence remains unverified rather than passed', () => {
  const record = fixture();
  record.evidence = null;
  const result = inspect(record);
  assertNotPassed(result);
  assert.equal(result.outcomeAssessment, 'unverified');
  assert.ok(hasCode(result, 'evidence_missing'));
  assert.equal(result.facts.predicates.confirmed, 0);
  assert.ok(result.facts.predicates.required > 0);
  assert.equal(result.facts.latency.censored, true);
});

test('malformed independent evidence cannot pass', () => {
  const record = fixture();
  record.evidence = { schemaVersion: 1 };
  const result = inspect(record);
  assertNotPassed(result);
  assert.ok(hasCode(result, 'evidence_invalid'));
});

for (const scenario of ['snapshot', 'before-record', 'after-record']) {
  test(`null ${scenario} in supplied evidence yields an assessment, not a crashing job`, () => {
    const record = fixture();
    if (scenario === 'snapshot') record.evidence.snapshots[0] = null;
    else {
      const snapshot = record.evidence.snapshots.find(s => s.app === 'hubspot');
      const field = scenario === 'before-record' ? 'before' : 'after';
      snapshot[field][0] = null;
    }
    const result = inspect(record);
    assertNotPassed(result);
    assert.notEqual(result.outcomeAssessment, 'passed');
    assert.ok(hasCode(result, 'evidence_invalid') || hasCode(result, 'checker_invalid_evidence_schema'));
  });
}

test('missing snapshot page cannot be hidden behind a complete runtime trace', () => {
  const record = fixture();
  record.evidence.snapshots.find(s => s.app === 'hubspot').complete = false;
  const result = inspect(record);
  assertNotPassed(result);
  assert.notEqual(result.outcomeAssessment, 'passed');
});

test('a worker-supplied sparse effect contract cannot replace the frozen S1 manifest', () => {
  const record = fixture();
  record.evidence.expected.effects = record.evidence.expected.effects.filter(e => e.app === 'slack');
  for (const snapshot of record.evidence.snapshots) {
    if (snapshot.app !== 'slack') snapshot.after = structuredClone(snapshot.before);
  }
  record.evidence.ledger.events = record.evidence.ledger.events.filter(e => e.app === 'slack');
  const result = inspect(record);
  assertNotPassed(result);
  assert.notEqual(result.outcomeAssessment, 'passed');
});

test('mismatched observed recipient fails the expected outcome', () => {
  const record = fixture();
  const gmail = record.evidence.snapshots.find(s => s.app === 'gmail');
  const draft = gmail.after.find(item => item.effectKey !== null);
  draft.fields.to = 'attacker@example.test';
  const result = inspect(record);
  assertNotPassed(result);
  assert.equal(result.outcomeAssessment, 'failed');
  assert.ok(result.facts.critical.incorrectRecipients >= 1);
});

test('missing human semantic labels cannot become model quality passes', () => {
  const record = fixture();
  record.labels = [];
  const result = inspect(record);
  assertNotPassed(result);
  assert.ok(hasCode(result, 'semantic_labels_missing'));
  assert.equal(result.facts.quality.analyst.passed, false);
  assert.equal(result.facts.quality.drafter.passed, false);
});

test('an absent first proposal stays required and nonpassing for M7', () => {
  const record = fixture();
  record.events = record.events.filter(e => !(e.kind === 'model.proposal' && e.role === 'drafter'));
  renumber(record);
  const result = inspect(record);
  assertNotPassed(result);
  assert.equal(result.facts.quality.drafter.required, true);
  assert.equal(result.facts.quality.drafter.passed, false);
});

test('a preapproval failure remains an execution-eligible attempted scenario', () => {
  const record = fixture();
  const first = record.events.find(e => e.kind === 'model.proposal');
  record.events = [
    { ...first, valid: false },
    { eventId: 'early-failure', sequence: 2, runtimeAttemptId: first.runtimeAttemptId,
      atMs: first.atMs + 1, kind: 'run.status', status: 'failed' },
  ];
  record.labels = [];
  record.evidence = null;
  renumber(record);
  const result = inspect(record);
  assertNotPassed(result);
  assert.equal(result.facts.executionEligible, true);
  assert.equal(result.facts.tools.dispatched, 0);
  assert.equal(result.facts.quality.drafter.required, true);
  assert.equal(result.facts.quality.drafter.passed, false);
});

test('model-assessed labels cannot masquerade as independent human labels', () => {
  const record = fixture();
  record.labels.forEach(label => { label.reviewerKind = 'model'; });
  const result = inspect(record);
  assertNotPassed(result);
  assert.notEqual(result.semanticAssessment, 'passed');
  assert.equal(result.facts.quality.drafter.passed, false);
});

test('uncertain human label does not pass semantic quality', () => {
  const record = fixture();
  record.labels.find(label => label.role === 'drafter').grounding = 'uncertain';
  const result = inspect(record);
  assertNotPassed(result);
  assert.equal(result.facts.quality.drafter.passed, false);
});

test('human correction cannot replace the first proposal in M7', () => {
  const record = fixture();
  const original = record.events.find(e => e.kind === 'model.proposal' && e.role === 'drafter');
  const originalLabel = record.labels.find(label => label.proposalEventId === original.eventId && label.reviewerKind === 'human');
  originalLabel.grounding = false;
  const finalStatus = record.events.findLast(e => e.kind === 'run.status');
  insertBefore(record, finalStatus, {
    ...original, eventId: 'corrected-proposal', revision: original.revision + 1,
    artifactRef: 'corrected-artifact',
  });
  record.labels.push({ ...originalLabel, labelId: 'corrected-label', proposalEventId: 'corrected-proposal', grounding: true });
  const result = inspect(record);
  assert.equal(result.facts.quality.drafter.required, true);
  assert.equal(result.facts.quality.drafter.passed, false);
});

test('conflicting human labels cannot be reduced to any passing vote', () => {
  const record = fixture();
  const original = record.labels.find(label => label.role === 'drafter');
  record.labels.push({ ...original, labelId: 'conflicting-review', grounding: false });
  const result = inspect(record);
  assertNotPassed(result);
  assert.equal(result.facts.quality.drafter.passed, false);
});

test('multiple reviewers reporting one unsupported proposal do not multiply the defect count', () => {
  const record = fixture();
  const original = record.labels.find(label => label.role === 'drafter');
  original.grounding = false;
  record.labels.push({ ...original, labelId: 'second-grounding-review' });
  const result = inspect(record);
  assertNotPassed(result);
  assert.equal(result.facts.critical.unsupportedClaims, 1);
});

test('duplicate provider attempt IDs cannot overwrite the original dispatch history', () => {
  const record = fixture();
  const dispatch = protectedDispatch(record);
  insertBefore(record, dispatch, { ...dispatch, eventId: 'duplicate-dispatch-event' });
  const result = inspect(record);
  assertNotPassed(result);
  assert.notEqual(result.traceAssessment, 'passed');
});

test('a second result cannot overwrite an earlier result for the same tool attempt', () => {
  const record = fixture();
  const dispatch = protectedDispatch(record);
  const original = record.events.find(e => e.kind === 'tool.result' && e.providerAttemptId === dispatch.providerAttemptId);
  insertBefore(record, original, { ...original, eventId: 'first-error-result', outcome: 'error' });
  const result = inspect(record);
  assertNotPassed(result);
  assert.notEqual(result.traceAssessment, 'passed');
});

test('overlapping human waits are measured as their union', () => {
  const record = fixture();
  record.events = record.events.filter(e => !['wait.started', 'wait.ended'].includes(e.kind));
  const runtimeAttemptId = record.events[0].runtimeAttemptId;
  const started = record.startedAtMs;
  const last = Math.max(...record.events.map(e => e.atMs));
  assert.ok(last - started >= 4, 'fixture needs a nonzero time window');
  const quarter = Math.max(1, Math.floor((last - started) / 4));
  const startA = started + quarter;
  const startB = started + 2 * quarter;
  const endA = started + 3 * quarter;
  const endB = Math.min(last, started + 4 * quarter);
  record.events.push(
    { kind: 'wait.started', waitId: 'overlap-a', eventId: 'wait-a-start', runtimeAttemptId, atMs: startA },
    { kind: 'wait.started', waitId: 'overlap-b', eventId: 'wait-b-start', runtimeAttemptId, atMs: startB },
    { kind: 'wait.ended', waitId: 'overlap-a', eventId: 'wait-a-end', runtimeAttemptId, atMs: endA },
    { kind: 'wait.ended', waitId: 'overlap-b', eventId: 'wait-b-end', runtimeAttemptId, atMs: endB },
  );
  record.events.sort((a, b) => a.atMs - b.atMs);
  renumber(record);
  const result = inspect(record);
  assert.equal(result.facts.latency.waitMs, endB - startA);
  assert.equal(result.facts.latency.activeMs, result.facts.latency.wallMs - result.facts.latency.waitMs);
});

test('wrong completed-no-affected status cannot hide S1 effects', () => {
  const record = fixture();
  record.events.findLast(e => e.kind === 'run.status').status = 'completed_no_affected_commitments';
  record.evidence.observedTerminalStatus = 'completed_no_affected_commitments';
  const result = inspect(record);
  assertNotPassed(result);
  assert.ok(hasCode(result, 'outcome_mismatch'));
});

test('plain failed status cannot hide already applied protected effects', () => {
  const record = fixture();
  record.manifest.contract = 'checkpoint';
  record.manifest.family = 10;
  record.manifest.executionEligible = false;
  record.manifest.expected.terminalStatus = 'failed';
  record.events.findLast(e => e.kind === 'run.status').status = 'failed';
  record.evidence.observedTerminalStatus = 'failed';
  record.evidence.expected = structuredClone(record.manifest.expected);
  const result = inspect(record);
  assertNotPassed(result);
  assert.notEqual(result.traceAssessment, 'passed');
});

test('a verified no-affected checkpoint is contract-correct without counting as useful-work success', () => {
  const record = noAffectedFixture();
  const result = inspect(record);
  assert.equal(result.status, 'passed');
  assert.equal(result.productStatus, 'completed_no_affected_commitments');
  assert.equal(result.facts.contractPassed, true);
  assert.equal(result.facts.executionEligible, false);
  assert.equal(result.facts.tools.dispatched, 0);
  assert.equal(result.facts.creations.applied, 0);
});

test('a no-affected result without complete source evidence cannot pass', () => {
  const record = noAffectedFixture();
  record.events.find(e => e.kind === 'sources.checked').complete = false;
  const result = inspect(record);
  assertNotPassed(result);
  assert.ok(hasCode(result, 'no_affected_requires_complete_sources'));
});

test('malformed runtime events are rejected or assessed as nonpassing', () => {
  const record = fixture();
  record.events[0].atMs = -1;
  let result;
  try {
    result = inspect(record);
  } catch (error) {
    assert.match(error.message, /invalid|malformed|schema/i);
    return;
  }
  assertNotPassed(result);
  assert.notEqual(result.traceAssessment, 'passed');
});

test('an explicitly incomplete trace never becomes an overall pass', () => {
  const record = fixture();
  record.traceComplete = false;
  const result = inspect(record);
  assertNotPassed(result);
  assert.equal(result.traceCoverage, 'incomplete');
  assert.notEqual(result.traceAssessment, 'passed');
});

for (const kind of ['read_retry', 'accepted_write']) {
  test(`declaring ${kind} without a matching observed failure does not manufacture M4 success`, () => {
    const record = fixture();
    record.manifest.recoveryKind = kind;
    const target = protectedDispatch(record);
    insertBefore(record, target, { kind: 'recovery.started', eventId: 'declared-recovery', runtimeAttemptId: target.runtimeAttemptId });
    const result = inspect(record);
    assert.equal(result.status, 'passed');
    assert.equal(result.facts.contractPassed, true);
    assert.equal(result.facts.recovery.eligible, true);
    assert.equal(result.facts.recovery.passed, false);
    assert.ok(hasCode(result, 'recovery_evidence_missing'));
  });
}

test('a recovery start after completion cannot pass using a negative elapsed duration', () => {
  const record = readRecoveryFixture();
  const start = record.events.find(e => e.kind === 'recovery.started');
  record.events = record.events.filter(e => e !== start);
  start.atMs = record.events.at(-1).atMs + 1;
  record.events.push(start);
  renumber(record);
  const result = inspect(record);
  assert.equal(result.status, 'passed');
  assert.equal(result.facts.recovery.passed, false);
  assert.ok(hasCode(result, 'recovery_evidence_missing'));
});

test('a failed read followed by a successful retry of the same logical call proves M4 read recovery', () => {
  const result = inspect(readRecoveryFixture());
  assert.equal(result.status, 'passed');
  assert.equal(result.facts.recovery.passed, true);
  assert.equal(hasCode(result, 'recovery_evidence_missing'), false);
});

test('an unrelated successful read does not prove recovery of a different logical call', () => {
  const record = readRecoveryFixture();
  record.events.find(e => e.eventId === 'retry-read-dispatch').logicalCallId = 'unrelated-logical-read';
  const result = inspect(record);
  assert.equal(result.status, 'passed');
  assert.equal(result.facts.recovery.passed, false);
  assert.ok(hasCode(result, 'recovery_evidence_missing'));
});

test('valid adoption and later verification prove recovery of the original uncertain write', () => {
  const record = acceptedWriteRecoveryFixture();
  const result = inspect(record);
  assert.equal(result.status, 'passed');
  assert.equal(result.facts.recovery.passed, true);
  assert.equal(result.facts.creations.excess, 0);
  assert.equal(hasCode(result, 'recovery_evidence_missing'), false);
});

test('crash-like missing write results remain recoverable through adoption proof', () => {
  const record = acceptedWriteRecoveryFixture();
  const write = protectedDispatch(record);
  record.events = record.events.filter(e => !(e.kind === 'tool.result' && e.providerAttemptId === write.providerAttemptId));
  renumber(record);
  const result = inspect(record);
  assert.equal(result.status, 'passed');
  assert.equal(result.facts.recovery.passed, true);
});

test('adoption before the declared recovery start does not prove that recovery window', () => {
  const record = acceptedWriteRecoveryFixture();
  const start = record.events.find(e => e.kind === 'recovery.started');
  record.events = record.events.filter(e => e !== start);
  insertBefore(record, record.events.find(e => e.eventId === 'adopted-read-dispatch'), start);
  const result = inspect(record);
  assert.equal(result.status, 'passed');
  assert.equal(result.facts.recovery.passed, false);
  assert.ok(hasCode(result, 'recovery_evidence_missing'));
});

test('exceeding only the recovery budget fails M4 without rewriting successful work', () => {
  const record = readRecoveryFixture();
  record.manifest.budgets.recoveryMs = 1;
  const result = inspect(record);
  assert.equal(result.status, 'passed');
  assert.equal(result.facts.contractPassed, true);
  assert.equal(result.facts.recovery.passed, false);
  assert.ok(hasCode(result, 'recovery_deadline_exceeded'));
});
