import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkEvidence } from '../../tools/reliability/check-evidence.mjs';

const example = new URL('../../tools/reliability/examples/happy-path.synthetic.json', import.meta.url);
const cli = fileURLToPath(new URL('../../tools/reliability/check-evidence.mjs', import.meta.url));
const fixture = JSON.parse(await readFile(example, 'utf8'));
const fresh = () => structuredClone(fixture);
const snapshot = (input, app) => input.snapshots.find(item => item.app === app);
const hasFailure = (input, code) => {
  const result = checkEvidence(input);
  assert.equal(result.result, 'failed');
  assert.ok(result.failures.some(failure => failure.code === code), JSON.stringify(result));
};
const safelyBlocked = () => {
  const input = fresh();
  input.expected.terminalStatus = input.observedTerminalStatus = 'safely_blocked';
  input.expected.effects = [];
  input.snapshots.forEach(item => { item.after = structuredClone(item.before); });
  input.ledger.events = [];
  return input;
};

test('synthetic happy path satisfies offline assertions only', () => {
  const report = checkEvidence(fresh());
  assert.equal(report.result, 'passed');
  assert.equal(report.scope, 'offline_evidence_assertions_only');
  assert.equal(report.evidenceKind, 'synthetic_fixture');
  assert.ok(report.assertions.total > 20);
});

test('a successful tool acknowledgement cannot hide a missing draft', () => {
  const input = fresh();
  snapshot(input, 'gmail').after = [];
  hasFailure(input, 'required_effect_missing_or_duplicated');
  hasFailure(input, 'ledger_effect_not_in_final_snapshot');
});

for (const [name, app, id, field, wrong] of [
  ['recipient', 'gmail', 'draft-1', 'to', 'wrong@example.invalid'],
  ['Cc recipient', 'gmail', 'draft-1', 'cc', ['extra@example.invalid']],
  ['Bcc recipient', 'gmail', 'draft-1', 'bcc', ['hidden@example.invalid']],
  ['body hash', 'gmail', 'draft-1', 'bodySha256', '0'.repeat(64)],
  ['subject', 'gmail', 'draft-1', 'subject', 'Unapproved subject'],
  ['owner', 'hubspot', 'task-1', 'ownerId', 'owner-unknown'],
  ['draft state', 'gmail', 'draft-1', 'isDraft', false],
]) {
  test(`rejects incorrect ${name} even with a verified event`, () => {
    const input = fresh();
    snapshot(input, app).after.find(record => record.id === id).fields[field] = wrong;
    hasFailure(input, 'required_field_mismatch');
  });
}

test('missing required field is different from an acceptable partial record', () => {
  const input = fresh();
  delete snapshot(input, 'gmail').after[0].fields.to;
  hasFailure(input, 'required_field_mismatch');
});

test('detects two active records for one logical effect', () => {
  const input = fresh();
  snapshot(input, 'gmail').after.push({ ...snapshot(input, 'gmail').after[0], id: 'draft-duplicate' });
  hasFailure(input, 'duplicate_active_effect');
});

test('detects a second applied create even when duplicate later disappears', () => {
  const input = fresh();
  input.ledger.events.push({ ...input.ledger.events.find(event => event.app === 'gmail'), providerId: 'draft-duplicate' });
  input.ledger.events.push({ operation: 'delete', actor: 'executor', app: 'gmail', effectKey: 'demo:inc42:promise101:draft', outcome: 'applied', providerId: 'draft-duplicate' });
  hasFailure(input, 'duplicate_applied_creation');
  hasFailure(input, 'forbidden_operation');
});

test('safe block with complete unchanged app snapshots passes', () => {
  assert.equal(checkEvidence(safelyBlocked()).result, 'passed');
});

test('safe block cannot authorize a Gmail write by adding it to expectations', () => {
  const input = fresh();
  input.expected.terminalStatus = input.observedTerminalStatus = 'safely_blocked';
  hasFailure(input, 'safe_state_allows_only_slack_effects');
});

test('protected unrelated commitment changes fail', () => {
  const input = fresh();
  snapshot(input, 'hubspot').after.find(record => record.id === 'commitment-102').fields.status = 'closed';
  hasFailure(input, 'protected_record_changed_or_missing');
  hasFailure(input, 'unexpected_new_or_changed_record');
});

for (const operation of ['send', 'delete', 'production_mutation']) {
  test(`forbidden ${operation} is visible even if final snapshots look unchanged`, () => {
    const input = fresh();
    input.ledger.events.push({ operation, actor: 'executor', app: 'gmail', effectKey: 'demo:inc42:promise101:draft', outcome: 'applied', providerId: 'draft-1' });
    hasFailure(input, 'forbidden_operation');
  });
}

test('replay reuses existing provider IDs without being counted as a duplicate', () => {
  const input = fresh();
  input.snapshots.forEach(item => { item.before = structuredClone(item.after); });
  input.ledger.events = input.ledger.events.map(event => event.operation === 'create' ? { ...event, operation: 'reuse', outcome: 'reused' } : event);
  assert.equal(checkEvidence(input).result, 'passed');
});

test('adoption of a discovered effect is not an applied creation', () => {
  const input = fresh();
  input.ledger.events = input.ledger.events.map(event => event.operation === 'create' && event.app === 'gmail' ? { ...event, operation: 'adopt', outcome: 'reused' } : event);
  assert.equal(checkEvidence(input).result, 'passed');
});

test('missing provider snapshot and incomplete ledger fail closed as invalid input', () => {
  const input = fresh();
  input.snapshots.pop();
  assert.equal(checkEvidence(input).result, 'invalid_input');
  const incomplete = fresh();
  incomplete.ledger.complete = false;
  assert.equal(checkEvidence(incomplete).result, 'invalid_input');
});

test('duplicate provider snapshots cannot substitute for missing Gmail evidence', () => {
  const input = fresh();
  input.snapshots[3] = structuredClone(input.snapshots[0]);
  assert.equal(checkEvidence(input).result, 'invalid_input');
});

test('missing expected Gmail fields and an empty assertion contract are invalid', () => {
  const input = fresh();
  delete input.expected.effects.find(effect => effect.app === 'gmail').requiredFields.bodySha256;
  assert.equal(checkEvidence(input).result, 'invalid_input');
  const empty = safelyBlocked();
  empty.expected.protectedRecords = [];
  assert.equal(checkEvidence(empty).result, 'invalid_input');
});

test('unexpected effects fail even when ledger and snapshots agree', () => {
  const input = fresh();
  snapshot(input, 'hubspot').after.push({ id: 'extra-task', effectKey: 'unauthorized', fields: { ownerId: 'owner-8' } });
  input.ledger.events.push({ operation: 'create', actor: 'executor', app: 'hubspot', effectKey: 'unauthorized', outcome: 'applied', providerId: 'extra-task' });
  hasFailure(input, 'unexpected_new_or_changed_record');
  hasFailure(input, 'undeclared_mutation_event');
});

test('snapshot presence alone does not count as declared independent readback', () => {
  const input = fresh();
  input.ledger.events = input.ledger.events.filter(event => !(event.app === 'gmail' && event.operation === 'read'));
  hasFailure(input, 'independent_readback_event_missing');
});

test('readback before the most recent action cannot verify the final effect', () => {
  const input = fresh();
  input.ledger.events.reverse();
  hasFailure(input, 'independent_readback_event_missing');
});

test('reuse cannot explain field changes to an existing record', () => {
  const input = fresh();
  const slack = snapshot(input, 'slack');
  slack.before = structuredClone(slack.after);
  slack.before[0].fields.verdict = 'awaiting_approval';
  input.ledger.events[0].operation = 'reuse';
  input.ledger.events[0].outcome = 'reused';
  hasFailure(input, 'mutation_evidence_missing');
});

test('repeated legitimate Slack updates are not duplicate creations', () => {
  const input = fresh();
  const slack = snapshot(input, 'slack');
  slack.before = structuredClone(slack.after);
  slack.before[0].fields.verdict = 'awaiting_approval';
  input.ledger.events[0].operation = 'update';
  input.ledger.events.unshift({ ...input.ledger.events[0] });
  assert.equal(checkEvidence(input).result, 'passed');
});

test('verifier actors cannot mutate even an allowed effect', () => {
  const input = fresh();
  input.ledger.events[0].actor = 'verifier';
  hasFailure(input, 'verifier_must_be_read_only');
});

test('executor cannot overwrite Gmail drafts', () => {
  const input = fresh();
  const gmail = snapshot(input, 'gmail');
  gmail.before = structuredClone(gmail.after);
  gmail.before[0].fields.subject = 'Earlier draft';
  input.ledger.events.find(event => event.app === 'gmail').operation = 'update';
  hasFailure(input, 'operation_not_allowed_for_app');
});

test('inconsistent operation/outcome labels fail schema validation', () => {
  const input = fresh();
  input.ledger.events[0].outcome = 'reused';
  assert.equal(checkEvidence(input).result, 'invalid_input');
});

test('false completed status with an expected safe block fails', () => {
  const input = safelyBlocked();
  input.observedTerminalStatus = 'completed';
  hasFailure(input, 'terminal_status_mismatch');
});

test('completed cannot pass with only protected records and no effects', () => {
  const input = safelyBlocked();
  input.expected.terminalStatus = input.observedTerminalStatus = 'completed';
  hasFailure(input, 'completed_requires_effects');
});

test('CLI returns 0/1/2 and never prints private payloads or input paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'promiseguard-evidence-'));
  try {
    const good = spawnSync(process.execPath, [cli, fileURLToPath(example)], { encoding: 'utf8' });
    assert.ifError(good.error);
    assert.equal(good.status, 0);
    const input = fresh();
    input.scenarioId = 'PRIVATE-SCENARIO';
    const draft = snapshot(input, 'gmail').after[0];
    draft.fields.to = 'secret-recipient@example.invalid';
    draft.fields.body = 'PRIVATE-BODY-TEXT';
    const path = join(directory, 'PRIVATE-FILENAME.json');
    await writeFile(path, JSON.stringify(input));
    const bad = spawnSync(process.execPath, [cli, path], { encoding: 'utf8' });
    assert.ifError(bad.error);
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).result, 'failed');
    assert.doesNotMatch(bad.stdout + bad.stderr, /secret-recipient|PRIVATE-|incident-contact|example\.invalid/);
    await writeFile(path, 'invalid PRIVATE-PAYLOAD');
    const malformed = spawnSync(process.execPath, [cli, path], { encoding: 'utf8' });
    assert.equal(malformed.status, 2);
    assert.doesNotMatch(malformed.stdout + malformed.stderr, /PRIVATE-|promiseguard-evidence-/);
    const missing = spawnSync(process.execPath, [cli, join(directory, 'PRIVATE-MISSING.json')], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
    assert.doesNotMatch(missing.stdout + missing.stderr, /PRIVATE-|promiseguard-evidence-/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
