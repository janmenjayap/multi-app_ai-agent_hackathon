/// <reference path="../../src/shared/checker.d.ts" />
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { loadConfig } from '../../src/server/index.js';
import { ApplicationDatabase } from '../../src/server/storage/database.js';
import { ApplicationRepository } from '../../src/server/storage/repositories.js';
import { freezeModelConfiguration } from '../../src/server/agents/runtime.js';
import { ModelDispatchError, type ModelClient, type ModelMessage } from '../../src/server/agents/model.js';
import { auditSemantics, createAuditorDependencies } from '../../src/server/agents/auditor/index.js';
import { AUDITOR_PROMPT_VERSION, AUDITOR_OUTPUT_SCHEMA_VERSION, buildAuditorMessages } from '../../src/server/agents/auditor/prompt.js';
import { validateAuditVerdict } from '../../src/server/agents/auditor/validate.js';
import { AgentInvocationContextSchema, AuditorInputSchema, roleInvocationKey,
  type AgentInvocationContext, type AuditorInput, type AuditVerdict } from '../../src/shared/agents.js';
import { EvaluationAttemptRegistrationSchema } from '../../src/shared/evaluation.js';
import { ExecutionModeSchema, IncidentIdentitySchema, RunIdSchema, EvaluationAttemptIdSchema,
  RuntimeAttemptIdSchema, canonical } from '../../src/shared/domain.js';
import { digest } from '../../src/shared/reliability.js';

const at = '2026-09-14T10:00:00Z';
const startMs = Date.parse(at);
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) close();
});

// Independently authored synthetic labels and scripted outputs exercise wiring and
// grounding boundaries. They are not measurements of actual model audit quality.
const sound: AuditVerdict = { schemaVersion: 2, verdict: 'pass', entries: ['alpha', 'beta'].map(id => ({
  commitmentId: id,
  findings: [{ claimId: `${id}-status`, verdict: 'supported', sourceFactIds: ['incident-open'], reason: 'The original issue says the incident remains open.' }],
  requiredFactFindings: [{ factId: 'eta-unknown', verdict: 'present', reason: 'The customer text explicitly says recovery time is unknown.' }],
})) };

function fixture(env: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'promiseguard-auditor-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const database = new ApplicationDatabase(join(directory, 'application.sqlite'));
  cleanup.push(() => database.close());
  const repository = new ApplicationRepository(database);
  const config = loadConfig({ PG_MODEL_MODE: 'mock', PG_ADAPTER_MODE: 'fake', PG_FIXTURE_ID: 'a04-blind-fixture-v1',
    PG_MODEL_TIMEOUT_MS: '1000', PG_MODEL_ROLE_BUDGET_MS: '5000', PG_MODEL_MAX_ATTEMPTS: '2', ...env });
  const configuration = freezeModelConfiguration(config, 'auditor');
  const execution = ExecutionModeSchema.parse({ schemaVersion: 2, modelMode: 'mock', providerMode: 'fake',
    evidenceMode: 'synthetic_fixture', fixtureId: 'a04-blind-fixture-v1' });
  const incident = IncidentIdentitySchema.parse({ schemaVersion: 2, repositoryId: 'fixture-repository', issueId: 'fixture-issue',
    issueNumber: 1, canonicalUrl: 'https://github.com/fixture/project/issues/1', service: 'fixture-service', environment: 'test' });
  const eventContext = { producerVersion: 'a04-blind-fixture-v1', producerId: 'a04-test', runId: RunIdSchema.parse('a04-run'),
    evaluationAttemptId: EvaluationAttemptIdSchema.parse('a04-evaluation'), runtimeAttemptId: RuntimeAttemptIdSchema.parse('a04-runtime'),
    stage: 'auditor' as const, spanId: 'a04-stage', parentSpanId: null, causedBy: [] };
  const original = 'The incident remains open. Recovery time is unknown. A deployment occurred before the alert; causality is unconfirmed.';
  const source = repository.transaction(eventContext, tx => {
    tx.createRun({ runId: eventContext.runId, incident, configuration: execution, createdAt: at });
    const source = tx.putArtifact({ artifactId: 'source-original', mediaType: 'text/plain', content: original });
    tx.registerEvaluation(EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2,
      runId: eventContext.runId, evaluationAttemptId: eventContext.evaluationAttemptId, suiteEntryId: 'a04-blind-fixtures',
      manifestHash: digest({ fixture: 'a04-blind-fixture-v1' }), registeredAt: at, dispatchAt: at,
      preflightRef: source, s0Ref: source, configuration: execution, leg: 'baseline' }));
    tx.startRuntime({ runtimeAttemptId: eventContext.runtimeAttemptId, runId: eventContext.runId,
      evaluationAttemptId: eventContext.evaluationAttemptId, startedAt: at });
    tx.appendEvent({ kind: 'stage.started' }, { eventId: 'a04-stage-start', at, processId: 'fixture-process', bootId: 'fixture-boot', monotonicMs: 0 });
    return source;
  });
  const input = AuditorInputSchema.parse({ schemaVersion: 2,
    sources: [
      { factId: 'incident-open', sourceRef: source, sourceField: 'issue.body', text: 'The incident remains open.' },
      { factId: 'eta-unknown', sourceRef: source, sourceField: 'issue.body', text: 'Recovery time is unknown.' },
      { factId: 'deployment', sourceRef: source, sourceField: 'issue.comments', text: 'A deployment occurred before the alert; causality is unconfirmed.' },
    ],
    proposal: { schemaVersion: 2, entries: ['alpha', 'beta'].map(id => ({ commitmentId: id,
      text: 'The incident remains open. Recovery time is unknown.',
      claims: [{ claimId: `${id}-status`, text: 'The incident remains open.', sourceFactIds: ['incident-open'] }],
    })) },
    taskContract: { selectedCommitmentIds: ['alpha', 'beta'], requiredFacts: ['eta-unknown'], forbiddenClaims: ['A guaranteed recovery date.'] },
  });
  const context = AgentInvocationContextSchema.parse({ schemaVersion: 2,
    runId: eventContext.runId, evaluationAttemptId: eventContext.evaluationAttemptId, runtimeAttemptId: eventContext.runtimeAttemptId,
    planRevision: 1, role: 'auditor', roleInvocationKey: roleInvocationKey(eventContext.runId, 1, 'auditor'),
    snapshotBundleRef: source, inputDigest: digest(input), promptVersion: AUDITOR_PROMPT_VERSION,
    outputSchemaVersion: AUDITOR_OUTPUT_SCHEMA_VERSION, modelConfigRef: configuration.modelConfigRef,
    configDigest: configuration.configDigest, budgets: configuration.budgets,
    spanId: 'a04-model-span', parentSpanId: eventContext.spanId, deadlineAt: new Date(startMs + 60000).toISOString() });
  let elapsed = 0;
  const clock = { now: () => startMs + elapsed, monotonicNow: () => elapsed,
    sleep: async (ms: number) => { elapsed += ms; } };
  return { database, repository, configuration, input, context,
    call: (model: ModelClient, value: AuditorInput = input, changes: Partial<AgentInvocationContext> = {}) =>
      auditSemantics(value, { ...context, inputDigest: digest(value), ...changes },
        createAuditorDependencies({ repository, configuration, model, clock })),
  };
}

function scripted(steps: readonly { text: string; refused?: boolean }[]) {
  const requests: (readonly ModelMessage[])[] = [];
  const client: ModelClient = { mode: 'mock', async dispatchStructured(request, capture) {
    assert.equal(request.role, 'auditor');
    assert.equal(request.schemaName, 'auditor_v2');
    const step = steps[requests.length];
    assert.ok(step, 'No extra model dispatch is permitted by this fixture.');
    requests.push(structuredClone(request.messages));
    await capture({ body: JSON.stringify({ status: 'completed', output: [{ type: 'message', status: 'completed',
      content: [step.refused ? { type: 'refusal', refusal: step.text } : { type: 'output_text', text: step.text }] }] }),
    status: 200, requestId: 'synthetic-auditor-response', retryAfterMs: null });
    let output: unknown;
    try { output = JSON.parse(step.text); } catch { output = undefined; }
    return { output, rawText: step.text, refused: step.refused ?? false, incomplete: false, usage: null };
  } };
  return { client, requests };
}

test('a sound whole-set draft passes with fresh blind messages and immutable input/output evidence', async () => {
  const f = fixture();
  const model = scripted([{ text: canonical(sound) }]);
  const result = await f.call(model.client);
  assert.equal(result.status, 'success');
  if (result.status === 'success') assert.deepEqual(result.output, sound);
  assert.equal(model.requests.length, 1);
  const messages = model.requests[0]!;
  assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
  assert.equal(messages[1]!.content, canonical(f.input));
  assert.equal(messages[0]!.content.includes(f.input.sources[2]!.text), false);
  const second = await buildAuditorMessages(f.input);
  assert.notEqual(second, await buildAuditorMessages(f.input));
  assert.deepEqual(messages, second);
  const [output] = f.repository.listOutputs(f.context.roleInvocationKey);
  assert.equal(output!.promptVersion, AUDITOR_PROMPT_VERSION);
  assert.equal(output!.outputSchemaVersion, AUDITOR_OUTPUT_SCHEMA_VERSION);
  assert.equal(output!.inputDigest, digest(f.input));
  assert.deepEqual(output!.sourceDigests, f.input.sources.map(source => source.sourceRef.sha256));
  assert.equal(f.repository.readArtifact(output!.rawOutput), canonical(sound));
  const inputEvent = f.repository.readEvents({ runId: f.context.runId }).find(event =>
    event.kind === 'fault.recorded' && event.faultId.startsWith('role-input-'));
  assert.ok(inputEvent && inputEvent.kind === 'fault.recorded');
  const receipt = JSON.parse(f.repository.readArtifact(inputEvent.evidenceRef));
  assert.deepEqual(receipt.input, f.input);
  assert.deepEqual(receipt.messages, messages);
});

test('a known but irrelevant citation remains auditable and a scripted unsupported finding blocks', async () => {
  const f = fixture();
  const input = structuredClone(f.input);
  input.proposal.entries[0]!.text = 'Recovery is guaranteed by Friday. Recovery time is unknown.';
  input.proposal.entries[0]!.claims[0] = { claimId: 'alpha-status', text: 'Recovery is guaranteed by Friday.', sourceFactIds: ['deployment'] };
  const verdict = structuredClone(sound);
  verdict.verdict = 'block';
  verdict.entries[0]!.findings[0] = { claimId: 'alpha-status', verdict: 'unsupported', sourceFactIds: ['deployment', 'eta-unknown'],
    reason: 'The cited deployment establishes no recovery deadline, and the source says recovery time is unknown.' };
  const model = scripted([{ text: canonical(verdict) }]);
  const result = await f.call(model.client, input);
  assert.equal(result.status, 'success');
  if (result.status === 'success') assert.deepEqual(result.output, verdict);
  assert.equal(model.requests.length, 1);
  assert.deepEqual(JSON.parse(model.requests[0]![1]!.content).proposal, input.proposal);
});

test('omitting required uncertainty blocks and an uncertain audit stays uncertain', async () => {
  for (const kind of ['omitted', 'uncertain'] as const) {
    const f = fixture();
    const input = structuredClone(f.input);
    const verdict = structuredClone(sound);
    if (kind === 'omitted') {
      input.proposal.entries[0]!.text = 'The incident remains open.';
      verdict.verdict = 'block';
      verdict.entries[0]!.requiredFactFindings[0] = { factId: 'eta-unknown', verdict: 'missing', reason: 'The required unknown recovery time is omitted.' };
    } else {
      verdict.verdict = 'uncertain';
      verdict.entries[0]!.findings[0] = { claimId: 'alpha-status', verdict: 'uncertain', sourceFactIds: ['incident-open'], reason: 'The source status is not conclusive.' };
    }
    const result = await f.call(scripted([{ text: canonical(verdict) }]).client, input);
    assert.equal(result.status, 'success');
    if (result.status === 'success') assert.deepEqual(result.output, verdict);
  }
});

test('rationale, confidence, history, and verdict hints are rejected before model dispatch', async () => {
  const f = fixture();
  const leaks = [
    { ...f.input, analystRationale: 'SECRET_ANALYST_REASONING' },
    { ...f.input, assessment: { rationale: 'SECRET_ANALYST_REASONING' } },
    { ...f.input, history: [{ role: 'assistant', content: 'SECRET_SHARED_HISTORY' }] },
    { ...f.input, desiredVerdict: 'pass' },
    { ...f.input, priorVerdict: sound },
    { ...f.input, proposal: { ...f.input.proposal, confidence: 0.99 } },
    { ...f.input, proposal: { ...f.input.proposal, entries: f.input.proposal.entries.map(entry => ({ ...entry, rationale: 'SECRET_DRAFTER_REASONING' })) } },
    { ...f.input, taskContract: { ...f.input.taskContract, desiredVerdict: 'pass' } },
  ];
  const model = scripted([]);
  for (const input of leaks) {
    const result = await f.call(model.client, input as AuditorInput);
    assert.equal(result.status, 'failure');
    if (result.status === 'failure') assert.equal(result.reason, 'input_invalid');
  }
  assert.equal(model.requests.length, 0);
  assert.equal(f.repository.getRole(f.context.roleInvocationKey), null);
});

test('invalid selected sets and source references fail before dispatch', async () => {
  const f = fixture();
  const variants: AuditorInput[] = [];
  for (const kind of ['missing_entry', 'extra_entry', 'unknown_claim_source', 'unknown_required_fact', 'duplicate_required_fact'] as const) {
    const input = structuredClone(f.input);
    if (kind === 'missing_entry') input.proposal.entries.pop();
    if (kind === 'extra_entry') input.proposal.entries.push({ commitmentId: 'extra', text: 'Extra scope.', claims: [] });
    if (kind === 'unknown_claim_source') input.proposal.entries[0]!.claims[0]!.sourceFactIds = ['unknown-source'];
    if (kind === 'unknown_required_fact') input.taskContract.requiredFacts = ['unknown-source'];
    if (kind === 'duplicate_required_fact') input.taskContract.requiredFacts.push('eta-unknown');
    variants.push(input);
  }
  const model = scripted([]);
  for (const input of variants) {
    const result = await f.call(model.client, input);
    assert.equal(result.status, 'failure');
    if (result.status === 'failure') assert.equal(result.reason, 'input_invalid');
  }
  assert.equal(model.requests.length, 0);
});

test('validation requires exact selected, claim, and required-fact coverage with meaningful cited reasons', () => {
  const f = fixture();
  const changes: ((verdict: AuditVerdict) => void)[] = [
    verdict => { verdict.entries.pop(); },
    verdict => { verdict.entries[1] = structuredClone(verdict.entries[0]!); },
    verdict => { verdict.entries[0]!.findings = []; },
    verdict => { verdict.entries[0]!.findings[0]!.claimId = 'beta-status'; },
    verdict => { verdict.entries[0]!.requiredFactFindings = []; },
    verdict => { verdict.entries[0]!.requiredFactFindings[0]!.factId = 'deployment'; },
    verdict => { verdict.entries[0]!.findings[0]!.sourceFactIds = ['unknown-source']; },
    verdict => { verdict.entries[0]!.findings[0]!.sourceFactIds = []; },
    verdict => { verdict.entries[0]!.findings[0]!.sourceFactIds = ['incident-open', 'incident-open']; },
    verdict => { verdict.entries[0]!.findings[0]!.reason = ' \n '; },
    verdict => { verdict.entries[0]!.requiredFactFindings[0]!.reason = ' \t '; },
    verdict => { verdict.entries[0]!.findings[0]!.verdict = 'unsupported'; },
    verdict => { verdict.entries[0]!.requiredFactFindings[0]!.verdict = 'missing'; },
  ];
  for (const change of changes) {
    const verdict = structuredClone(sound);
    change(verdict);
    assert.throws(() => validateAuditVerdict(verdict, f.input));
  }
  assert.deepEqual(validateAuditVerdict(sound, f.input), sound);
});

test('required refusal and invalid output remain recorded failures with no silent pass', async () => {
  const invalid = structuredClone(sound);
  invalid.entries[0]!.findings[0]!.sourceFactIds = ['unknown-source'];
  for (const item of [
    { text: 'Synthetic refusal.', refused: true, reason: 'refusal', parseStatus: 'refused' },
    { text: canonical(invalid), reason: 'output_invalid', parseStatus: 'valid' },
    { text: '{malformed', reason: 'budget_exhausted', parseStatus: 'malformed' },
  ] as const) {
    const f = fixture({ PG_MODEL_MAX_ATTEMPTS: '1' });
    const model = scripted([item]);
    const result = await f.call(model.client);
    assert.equal(result.status, 'failure');
    if (result.status === 'failure') assert.equal(result.reason, item.reason);
    assert.equal(model.requests.length, 1);
    const [output] = f.repository.listOutputs(f.context.roleInvocationKey);
    assert.equal(output!.parseStatus, item.parseStatus);
    assert.equal(f.repository.readArtifact(output!.rawOutput), item.text);
    assert.deepEqual(result.firstOutputRef, output!.rawOutput);
    assert.equal(f.repository.getRole(f.context.roleInvocationKey)!.result!.status, 'failure');
  }
});

test('a required-stage timeout aborts the model and remains a failure', async () => {
  vi.useFakeTimers();
  const f = fixture({ PG_MODEL_TIMEOUT_MS: '20', PG_MODEL_ROLE_BUDGET_MS: '20', PG_MODEL_MAX_ATTEMPTS: '1' });
  let calls = 0;
  let aborted = false;
  const model: ModelClient = { mode: 'mock', async dispatchStructured(request) {
    calls++;
    return new Promise((_resolve, reject) => {
      request.abortSignal.addEventListener('abort', () => { aborted = true; reject(new ModelDispatchError('cancelled')); }, { once: true });
    });
  } };
  const pending = f.call(model);
  await vi.advanceTimersByTimeAsync(25);
  const result = await pending;
  assert.equal(result.status, 'failure');
  if (result.status === 'failure') assert.equal(result.reason, 'timeout');
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.equal(result.firstOutputRef, null);
  assert.equal(f.repository.getRole(f.context.roleInvocationKey)!.result!.status, 'failure');
});

test('bounded schema repair preserves the exact first raw output and blind context', async () => {
  const f = fixture();
  const malformed = ' {"private":"fixture@example.test",\r\n"unfinished":';
  const model = scripted([{ text: malformed }, { text: canonical(sound) }]);
  const result = await f.call(model.client);
  assert.equal(result.status, 'success');
  assert.equal(model.requests.length, 2);
  assert.equal(result.attemptRefs.length, 2);
  assert.equal(new Set(result.attemptRefs).size, 2);
  assert.deepEqual(model.requests[1]!.slice(0, 2), model.requests[0]);
  assert.equal(canonical(model.requests[1]).includes('fixture@example.test'), false);
  const outputs = f.repository.listOutputs(f.context.roleInvocationKey);
  assert.equal(outputs[0]!.parseStatus, 'malformed');
  assert.equal(outputs[1]!.validationStatus, 'valid');
  assert.equal(outputs[1]!.firstOutputId, outputs[0]!.outputId);
  assert.equal(outputs[1]!.previousOutputId, outputs[0]!.outputId);
  assert.equal(f.repository.readArtifact(outputs[0]!.rawOutput), malformed);
  assert.deepEqual(result.firstOutputRef, outputs[0]!.rawOutput);
});

test('approval resume reuses the verdict and changed content requires a new revision', async () => {
  const f = fixture();
  const model = scripted([{ text: canonical(sound) }, { text: canonical(sound) }]);
  const first = await f.call(model.client);
  assert.equal(first.status, 'success');
  assert.deepEqual(await f.call(model.client), first);
  assert.equal(model.requests.length, 1);
  const changed = structuredClone(f.input);
  changed.proposal.entries[0]!.text += ' We will provide another update.';
  const stale = await f.call(model.client, changed, { inputDigest: f.context.inputDigest });
  assert.equal(stale.status, 'failure');
  if (stale.status === 'failure') assert.equal(stale.reason, 'input_invalid');
  const sameRevision = await f.call(model.client, changed);
  assert.equal(sameRevision.status, 'failure');
  if (sameRevision.status === 'failure') assert.equal(sameRevision.reason, 'configuration_mismatch');
  assert.equal(model.requests.length, 1);
  const next = await f.call(model.client, changed, { planRevision: 2,
    roleInvocationKey: roleInvocationKey(f.context.runId, 2, 'auditor'), spanId: 'a04-revision-two' });
  assert.equal(next.status, 'success');
  assert.equal(model.requests.length, 2);
  assert.equal(f.repository.listOutputs(f.context.roleInvocationKey).length, 1);
  assert.equal(f.repository.listOutputs(roleInvocationKey(f.context.runId, 2, 'auditor'))[0]!.inputDigest, digest(changed));
});
