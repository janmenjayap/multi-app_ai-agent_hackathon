/// <reference path="../../src/shared/checker.d.ts" />
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { loadConfig } from '../../src/server/index.js';
import { ApplicationDatabase } from '../../src/server/storage/database.js';
import { ApplicationRepository } from '../../src/server/storage/repositories.js';
import { AgentPersistenceError, RoleInvocationPendingError, freezeModelConfiguration, invokeRole } from '../../src/server/agents/runtime.js';
import { createModelClient, ModelDispatchError, type ModelClient, type ModelMessage } from '../../src/server/agents/model.js';
import { AgentInvocationContextSchema, AnalystInputSchema, IncidentAssessmentSchema,
  roleInvocationKey, type AgentInvocationContext, type AgentRole } from '../../src/shared/agents.js';
import { EvaluationAttemptRegistrationSchema } from '../../src/shared/evaluation.js';
import { ExecutionModeSchema, IncidentIdentitySchema, RunIdSchema, EvaluationAttemptIdSchema,
  RuntimeAttemptIdSchema, canonical } from '../../src/shared/domain.js';
import { EventBatchV2Schema } from '../../src/shared/events.js';
import { digest } from '../../src/shared/reliability.js';
import { runModelSmoke } from '../../tools/smoke/model.js';

const at = '2026-09-14T10:00:00Z';
const startMs = Date.parse(at);
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});

const assessment = IncidentAssessmentSchema.parse({ schemaVersion: 2,
  facts: [{ claimId: 'claim-1', text: 'The synthetic incident is open.', sourceFactIds: ['fact-1'] }],
  contradictions: [], unknowns: ['Recovery time is unknown.'],
  candidateChange: { status: 'uncertain', sourceFactIds: [], reason: 'No causal evidence.' },
});
const messages: readonly ModelMessage[] = [{ role: 'system', content: 'Return the requested synthetic fixture as structured JSON.' },
  { role: 'user', content: 'Assess the synthetic open incident.' }];

function fixture(options: { env?: NodeJS.ProcessEnv; role?: AgentRole } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'promiseguard-agent-runtime-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'application.sqlite');
  const open = () => {
    const database = new ApplicationDatabase(path);
    cleanup.push(() => database.close());
    return { database, repository: new ApplicationRepository(database) };
  };
  const { database, repository } = open();
  const role = options.role ?? 'analyst';
  const config = loadConfig({ PG_MODEL_MODE: 'mock', PG_ADAPTER_MODE: 'fake', PG_FIXTURE_ID: 'a01-test-v1',
    PG_MODEL_TIMEOUT_MS: '1000', PG_MODEL_ROLE_BUDGET_MS: '5000', PG_MODEL_MAX_ATTEMPTS: '2',
    PG_MODEL_MAX_OUTPUT_TOKENS: '500', ...options.env });
  const configuration = freezeModelConfiguration(config, role);
  const execution = ExecutionModeSchema.parse({ schemaVersion: 2, modelMode: config.modelMode,
    providerMode: 'fake', evidenceMode: 'synthetic_fixture', fixtureId: 'a01-test-v1' });
  const incident = IncidentIdentitySchema.parse({ schemaVersion: 2, repositoryId: 'repository-1', issueId: 'issue-1',
    issueNumber: 1, canonicalUrl: 'https://github.com/fixture/project/issues/1', service: 'fixture-service', environment: 'test' });
  const eventContext = { producerVersion: 'a01-test-v1', producerId: 'a01-test', runId: RunIdSchema.parse('a01-run'),
    evaluationAttemptId: EvaluationAttemptIdSchema.parse('a01-evaluation'), runtimeAttemptId: RuntimeAttemptIdSchema.parse('a01-runtime'),
    stage: role, spanId: 'a01-stage', parentSpanId: null, causedBy: [] };
  const source = repository.transaction(eventContext, tx => {
    tx.createRun({ runId: eventContext.runId, incident, configuration: execution, createdAt: at });
    const source = tx.putArtifact({ artifactId: 'source-1', mediaType: 'text/plain', content: 'The synthetic incident is open.' });
    tx.registerEvaluation(EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2,
      runId: eventContext.runId, evaluationAttemptId: eventContext.evaluationAttemptId, suiteEntryId: 'a01-runtime-fixture',
      manifestHash: digest({ fixture: 'a01-test-v1' }), registeredAt: at, dispatchAt: at,
      preflightRef: source, s0Ref: source, configuration: execution, leg: 'baseline' }));
    tx.startRuntime({ runtimeAttemptId: eventContext.runtimeAttemptId, runId: eventContext.runId,
      evaluationAttemptId: eventContext.evaluationAttemptId, startedAt: at });
    tx.appendEvent({ kind: 'stage.started' }, { eventId: 'a01-stage-start', at, processId: 'fixture-process', bootId: 'fixture-boot', monotonicMs: 0 });
    return source;
  });
  const input = AnalystInputSchema.parse({ schemaVersion: 2, sources: [{ factId: 'fact-1', sourceRef: source,
    sourceField: 'body', text: 'The synthetic incident is open.' }] });
  const context = AgentInvocationContextSchema.parse({ schemaVersion: 2,
    runId: eventContext.runId, evaluationAttemptId: eventContext.evaluationAttemptId, runtimeAttemptId: eventContext.runtimeAttemptId,
    planRevision: 1, role, roleInvocationKey: roleInvocationKey(eventContext.runId, 1, role),
    snapshotBundleRef: source, inputDigest: digest(input), promptVersion: 'a01-fixture-prompt-v1', outputSchemaVersion: `${role}-v2`,
    modelConfigRef: configuration.modelConfigRef, configDigest: configuration.configDigest, budgets: configuration.budgets,
    spanId: 'a01-model-span', parentSpanId: eventContext.spanId, deadlineAt: new Date(startMs + 60000).toISOString() });
  let wall = startMs;
  let monotonic = 0;
  const clock = { now: () => wall, monotonicNow: () => monotonic,
    sleep: async (ms: number, signal: AbortSignal) => {
      if (signal.aborted) throw new Error('aborted');
      wall += ms; monotonic += ms;
    } };
  return { directory, path, open, database, repository, config, configuration, execution, eventContext, input, context, clock,
    advance: (ms: number, wallMs = ms) => { monotonic += ms; wall += wallMs; },
    events: () => repository.readEvents({ runId: context.runId }),
    call: (model: ModelClient, changes: Partial<AgentInvocationContext> = {}) => invokeRole(input,
      AgentInvocationContextSchema.parse({ ...context, ...changes }), IncidentAssessmentSchema,
      { repository, model, configuration, messages, clock }) };
}

function assertEventBindings(f: ReturnType<typeof fixture>) {
  EventBatchV2Schema.parse({ schemaVersion: 2, runId: f.context.runId,
    evaluationAttemptId: f.context.evaluationAttemptId, events: f.events() });
}

function responseBody(rawText: string, refused = false) {
  return JSON.stringify({ id: 'resp_synthetic', object: 'response', created_at: startMs / 1000,
    status: 'completed', model: 'fixture-model', output: [{ id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed',
      content: [refused ? { type: 'refusal', refusal: rawText } : { type: 'output_text', text: rawText, annotations: [] }] }],
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } });
}

function scripted(steps: readonly ({ text: string; refused?: boolean; before?: () => void | Promise<void> } |
  { reason: ConstructorParameters<typeof ModelDispatchError>[0]; retryable: boolean; retryAfterMs?: number; before?: () => void | Promise<void> })[]) {
  let calls = 0;
  const client: ModelClient = {
    mode: 'mock',
    async dispatchStructured(request, capture) {
      const step = steps[calls++];
      assert.ok(step, 'The runtime exceeded the supplied attempt script.');
      assert.equal(request.role, 'analyst');
      await step.before?.();
      if ('reason' in step) throw new ModelDispatchError(step.reason, step.retryable, step.retryAfterMs ?? null);
      await capture({ body: responseBody(step.text, step.refused), status: 200, requestId: 'synthetic-request', retryAfterMs: null });
      let output: unknown;
      try { output = JSON.parse(step.text); } catch { output = undefined; }
      return { output, rawText: step.text, refused: step.refused ?? false, incomplete: false,
        usage: { inputTokens: 11, outputTokens: 7 } };
    },
  };
  return { client, calls: () => calls };
}

test('a malformed first output remains exact and immutable when a bounded repair succeeds', async () => {
  const f = fixture();
  const first = ' {"privateFixture":"synthetic@example.test",\r\n"broken":';
  const repaired = `\n${JSON.stringify(assessment, null, 2)}\n`;
  const model = scripted([{ text: first }, { text: repaired }]);
  const result = await f.call(model.client);
  assert.equal(result.status, 'success');
  assert.equal(model.calls(), 2);
  assert.equal(result.attemptRefs.length, 2);
  assert.equal(new Set(result.attemptRefs).size, 2);
  const outputs = f.repository.listOutputs(f.context.roleInvocationKey);
  assert.equal(outputs.length, 2);
  assert.equal(outputs[0]!.parseStatus, 'malformed');
  assert.equal(outputs[1]!.validationStatus, 'valid');
  assert.equal(outputs[1]!.firstOutputId, outputs[0]!.outputId);
  assert.equal(outputs[1]!.previousOutputId, outputs[0]!.outputId);
  assert.equal(f.repository.readArtifact(outputs[0]!.rawOutput), first);
  assert.equal(f.repository.readArtifact(outputs[1]!.rawOutput), repaired);
  assert.deepEqual(result.firstOutputRef, outputs[0]!.rawOutput);
  assert.equal(canonical(f.events()).includes('synthetic@example.test'), false);
  assert.equal(f.events().filter(e => e.kind === 'retry.scheduled').length, 1);
  assertEventBindings(f);
  f.database.close();
  assert.equal(f.open().repository.readArtifact(outputs[0]!.rawOutput), first);
});

test('refusal is retained as the first output and never repaired automatically', async () => {
  const f = fixture();
  const text = 'I cannot produce that synthetic response.';
  const model = scripted([{ text, refused: true }, { text: canonical(assessment) }]);
  const result = await f.call(model.client);
  assert.equal(result.status, 'failure');
  if (result.status === 'failure') assert.equal(result.reason, 'refusal');
  assert.equal(model.calls(), 1);
  const [output] = f.repository.listOutputs(f.context.roleInvocationKey);
  assert.equal(output!.parseStatus, 'refused');
  assert.equal(f.repository.readArtifact(output!.rawOutput), text);
  assert.equal(f.events().some(e => e.kind === 'retry.scheduled'), false);
  assertEventBindings(f);
});

test('nonretryable authentication errors remain categorized with no invented original output', async () => {
  const f = fixture();
  const model = scripted([{ reason: 'authentication', retryable: false }]);
  const result = await f.call(model.client);
  assert.equal(result.status, 'failure');
  if (result.status === 'failure') assert.equal(result.reason, 'authentication');
  assert.equal(model.calls(), 1);
  assert.equal(result.firstOutputRef, null);
  assert.deepEqual(f.repository.listOutputs(f.context.roleInvocationKey), []);
  assertEventBindings(f);
});

test('role validation rejects a structurally valid citation to a missing source', async () => {
  const f = fixture({ env: { PG_MODEL_MAX_ATTEMPTS: '1' } });
  const bad = { ...assessment, facts: [{ ...assessment.facts[0]!, sourceFactIds: ['missing-fact'] }] };
  const model = scripted([{ text: canonical(bad) }]);
  const result = await f.call(model.client);
  assert.equal(result.status, 'failure');
  if (result.status === 'failure') assert.equal(result.reason, 'output_invalid');
  const [output] = f.repository.listOutputs(f.context.roleInvocationKey);
  assert.equal(output!.parseStatus, 'valid');
  assert.equal(output!.validationStatus, 'invalid');
});

test('changed input digest, model configuration, and complete-input limits fail before dispatch', async () => {
  for (const gate of ['digest', 'configuration', 'input_limit'] as const) {
    const f = fixture({ env: gate === 'input_limit' ? { PG_MODEL_MAX_INPUT_CHARS: '10' } : {} });
    const model = scripted([]);
    const result = await f.call(model.client, gate === 'digest' ? { inputDigest: digest('other-input') } :
      gate === 'configuration' ? { configDigest: digest('other-config') } : {});
    assert.equal(result.status, 'failure');
    if (result.status === 'failure') assert.equal(result.reason,
      gate === 'configuration' ? 'configuration_mismatch' : gate === 'input_limit' ? 'input_budget_exceeded' : 'input_invalid');
    assert.equal(model.calls(), 0);
    assert.equal(f.events().some(e => e.kind === 'model.attempt.started'), false);
  }
});

test('concurrent reentry cannot dispatch another owner and reopening reuses the validated result', async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const model = scripted([{ text: canonical(assessment), before: async () => { entered(); await hold; } }]);
  const firstCall = f.call(model.client);
  await started;
  await assert.rejects(() => f.call(model.client), RoleInvocationPendingError);
  release();
  const result = await firstCall;
  assert.equal(result.status, 'success');
  f.database.close();
  const { repository } = f.open();
  const resumedRuntime = RuntimeAttemptIdSchema.parse('a01-runtime-resumed');
  repository.transaction({ ...f.eventContext, runtimeAttemptId: resumedRuntime, spanId: 'resumed-stage' }, tx => {
    tx.startRuntime({ runtimeAttemptId: resumedRuntime, runId: f.context.runId,
      evaluationAttemptId: f.context.evaluationAttemptId, startedAt: at });
    tx.appendEvent({ kind: 'stage.started' }, { eventId: 'resumed-stage-start', at, processId: 'resume-process', bootId: 'resume-boot', monotonicMs: 0 });
  });
  const resumed = await invokeRole(f.input, { ...f.context, runtimeAttemptId: resumedRuntime,
    spanId: 'resumed-model-span', parentSpanId: 'resumed-stage' }, IncidentAssessmentSchema,
  { repository, model: model.client, configuration: f.configuration, messages, clock: f.clock });
  assert.deepEqual(resumed, result);
  assert.equal(model.calls(), 1);
  const mismatch = await invokeRole(f.input, { ...f.context, promptVersion: 'changed-prompt' }, IncidentAssessmentSchema,
    { repository, model: model.client, configuration: f.configuration, messages, clock: f.clock });
  assert.equal(mismatch.status, 'failure');
  if (mismatch.status === 'failure') assert.equal(mismatch.reason, 'configuration_mismatch');
  assert.equal(model.calls(), 1);
});

test('failed intent persistence prevents the first dispatch and failed raw persistence prevents repair', async () => {
  const intent = fixture();
  intent.database.connection.exec(`CREATE TEMP TRIGGER stop_intent BEFORE INSERT ON model_attempts
    BEGIN SELECT RAISE(ABORT, 'private intent failure'); END`);
  const never = scripted([]);
  await assert.rejects(() => intent.call(never.client), AgentPersistenceError);
  assert.equal(never.calls(), 0);
  assert.deepEqual(intent.repository.getRole(intent.context.roleInvocationKey)!.attempts, []);
  assert.equal(intent.repository.getRole(intent.context.roleInvocationKey)!.result, null);
  assert.equal(intent.events().some(e => e.kind === 'model.attempt.started'), false);

  const raw = fixture();
  const model = scripted([{ text: '{malformed', before: () => {
    raw.database.connection.exec(`CREATE TEMP TRIGGER stop_raw BEFORE INSERT ON restricted_artifacts
      BEGIN SELECT RAISE(ABORT, 'private raw failure'); END`);
  } }, { text: canonical(assessment) }]);
  await assert.rejects(() => raw.call(model.client), error => {
    assert.ok(error instanceof AgentPersistenceError);
    assert.equal(String(error).includes('private raw failure'), false);
    return true;
  });
  assert.equal(model.calls(), 1);
  assert.equal(raw.repository.getRole(raw.context.roleInvocationKey)!.result, null);
  assert.deepEqual(raw.repository.listOutputs(raw.context.roleInvocationKey), []);
  assert.equal(raw.events().some(e => e.kind === 'retry.scheduled'), false);
});

test('the monotonic role budget cannot be renewed by a wall-clock rollback', async () => {
  const f = fixture({ env: { PG_MODEL_ROLE_BUDGET_MS: '1000', PG_MODEL_TIMEOUT_MS: '1000' } });
  const model = scripted([{ reason: 'transport_error', retryable: true, retryAfterMs: 500, before: () => f.advance(600, -10000) },
    { text: canonical(assessment) }]);
  const result = await f.call(model.client);
  assert.equal(result.status, 'failure');
  if (result.status === 'failure') assert.equal(result.reason, 'budget_exhausted');
  assert.equal(model.calls(), 1);
  assert.equal(result.attemptRefs.length, 1);
});

test('a validator cannot publish success after consuming the remaining role budget', async () => {
  const f = fixture({ env: { PG_MODEL_TIMEOUT_MS: '1000', PG_MODEL_ROLE_BUDGET_MS: '1000' } });
  const model = scripted([{ text: canonical(assessment) }]);
  const result = await invokeRole(f.input, f.context, IncidentAssessmentSchema,
    { repository: f.repository, model: model.client, configuration: f.configuration, messages, clock: f.clock,
      validate: () => f.advance(1001) });
  assert.equal(result.status, 'failure');
  if (result.status === 'failure') assert.equal(result.reason, 'timeout');
  assert.equal(model.calls(), 1);
  assert.equal(f.repository.getRole(f.context.roleInvocationKey)!.result!.status, 'failure');
});

test('an expired role deadline fails before dispatch and cancellation aborts a waiting model', async () => {
  const expired = fixture();
  const never = scripted([]);
  const expiredResult = await expired.call(never.client, { deadlineAt: at });
  assert.equal(expiredResult.status, 'failure');
  if (expiredResult.status === 'failure') assert.equal(expiredResult.reason, 'budget_exhausted');
  assert.equal(never.calls(), 0);

  const f = fixture();
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let wasAborted = false;
  const client: ModelClient = { mode: 'mock', async dispatchStructured(request) {
    entered();
    return new Promise((_resolve, reject) => {
      request.abortSignal.addEventListener('abort', () => { wasAborted = true; reject(new ModelDispatchError('cancelled')); }, { once: true });
    });
  } };
  const call = invokeRole(f.input, f.context, IncidentAssessmentSchema,
    { repository: f.repository, model: client, configuration: f.configuration, messages, clock: f.clock, signal: controller.signal });
  await started;
  controller.abort();
  const result = await call;
  assert.equal(result.status, 'failure');
  if (result.status === 'failure') assert.equal(result.reason, 'cancelled');
  assert.equal(wasAborted, true);
  assertEventBindings(f);
});

test('per-attempt timeout aborts a hanging model without hidden retries', async () => {
  vi.useFakeTimers();
  const f = fixture({ env: { PG_MODEL_TIMEOUT_MS: '20', PG_MODEL_ROLE_BUDGET_MS: '20', PG_MODEL_MAX_ATTEMPTS: '1' } });
  let calls = 0;
  let wasAborted = false;
  const client: ModelClient = { mode: 'mock', async dispatchStructured(request) {
    calls++;
    return new Promise((_resolve, reject) => {
      request.abortSignal.addEventListener('abort', () => { wasAborted = true; reject(new ModelDispatchError('cancelled')); }, { once: true });
    });
  } };
  const call = f.call(client);
  await vi.advanceTimersByTimeAsync(25);
  const result = await call;
  assert.equal(result.status, 'failure');
  if (result.status === 'failure') assert.equal(result.reason, 'timeout');
  assert.equal(calls, 1);
  assert.equal(wasAborted, true);
});

test('the real ChatOpenAI Responses path persists raw bytes before SDK parsing and exposes no tools or hidden retries', async () => {
  const f = fixture({ env: { PG_MODEL_MODE: 'live', OPENAI_API_KEY: 'synthetic-only-test-key',
    OPENAI_MODEL: 'fixture-model', OPENAI_MODEL_ANALYST: 'fixture-analyst', PG_MODEL_MAX_ATTEMPTS: '1' } });
  const raw = responseBody(`\n${JSON.stringify(assessment)}\n`);
  let fetches = 0;
  let parserReads = 0;
  const fetchStub: typeof fetch = async (input, init) => {
    fetches++;
    assert.equal(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'https://api.openai.com/v1/responses');
    assert.equal(init?.redirect, 'error');
    assert.equal(f.repository.getRole(f.context.roleInvocationKey)!.attempts.length, 1);
    assert.equal(f.events().filter(e => e.kind === 'model.attempt.started').length, 1);
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, 'fixture-analyst');
    assert.equal(request.max_output_tokens, 500);
    assert.equal(request.stream, false);
    assert.equal(request.store, false);
    assert.equal(request.include, undefined);
    assert.equal(request.reasoning, undefined);
    assert.equal(request.text.format.type, 'json_schema');
    assert.equal(request.text.format.strict, true);
    assert.equal(request.text.format.name, 'analyst_v2');
    assert.equal(request.tools === undefined || request.tools.length === 0, true);
    assert.equal(request.previous_response_id, undefined);
    assert.equal(request.conversation, undefined);
    const response = new Response(raw, { headers: { 'content-type': 'application/json', 'x-request-id': 'stub-request' } });
    const assertSaved = () => {
      parserReads++;
      const event = f.events().find(e => e.kind === 'fault.recorded' && e.faultId.startsWith('model-response-'));
      assert.ok(event && event.kind === 'fault.recorded', 'Raw receipt must be committed before the SDK reads its response.');
      const receipt = JSON.parse(f.repository.readArtifact(event.evidenceRef));
      assert.equal(f.repository.readArtifact(receipt.bodyRef), raw);
    };
    const json = response.json.bind(response), text = response.text.bind(response);
    response.json = async () => { assertSaved(); return json(); };
    response.text = async () => { assertSaved(); return text(); };
    return response;
  };
  const model = createModelClient({ config: f.config, fetch: fetchStub });
  const result = await f.call(model);
  assert.equal(result.status, 'success');
  assert.equal(fetches, 1);
  assert.ok(parserReads > 0);
  assert.equal(result.attemptRefs.length, 1);
  assertEventBindings(f);

  // A retryable HTTP failure still produces one HTTP dispatch per runtime attempt.
  const failed = fixture({ env: { PG_MODEL_MODE: 'live', OPENAI_API_KEY: 'synthetic-only-test-key',
    OPENAI_MODEL: 'fixture-model', PG_MODEL_MAX_ATTEMPTS: '1' } });
  let failures = 0;
  const failedResult = await failed.call(createModelClient({ config: failed.config, fetch: async () => {
    failures++;
    return new Response('{"error":{"message":"synthetic service failure","code":"server_error"}}',
      { status: 503, headers: { 'content-type': 'application/json' } });
  } }));
  assert.equal(failedResult.status, 'failure');
  assert.equal(failures, 1);
  assert.equal(failedResult.attemptRefs.length, 1);
});

test('mock creation needs an explicit fixture client and invalid live setup fails before network access', async () => {
  const f = fixture();
  let fetches = 0;
  const network: typeof fetch = async () => { fetches++; throw new Error('Unexpected network call'); };
  const fixtureModel = scripted([{ text: canonical(assessment) }]);
  const client = createModelClient({ config: f.config, mockClient: fixtureModel.client, fetch: network });
  assert.equal((await f.call(client)).status, 'success');
  assert.throws(() => createModelClient({ config: f.config, fetch: network }), ModelDispatchError);
  assert.throws(() => createModelClient({ config: { ...f.config, modelMode: 'live' }, fetch: network }), ModelDispatchError);
  assert.equal(fetches, 0);
});

test('the smoke runner defaults to zero-network mock mode and persists one chosen role outside quality cohorts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'promiseguard-smoke-test-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let fetches = 0;
  for (const role of ['analyst', 'drafter', 'auditor']) {
    const summary: string[] = [];
    const exit = await runModelSmoke(['--receipt-dir', directory, '--role', role], {
      env: {}, fetch: async () => { fetches++; throw new Error('Unexpected network'); }, write: value => summary.push(value),
    });
    assert.equal(exit, 0);
    assert.equal(summary.length, 1);
    const result = JSON.parse(summary[0]!);
    const receipt = JSON.parse(readFileSync(result.receipt, 'utf8'));
    assert.equal(receipt.mode, 'mock');
    assert.equal(receipt.role, role);
    assert.equal(receipt.evidenceKind, 'compatibility_smoke');
    assert.equal(receipt.outsideQualityCohorts, true);
    assert.equal(receipt.attempts.length, 1);
    assert.equal(receipt.originalOutputs.length, 1);
    assert.equal(receipt.originalOutputs[0].role, role);
    assert.equal(receipt.semanticQuality, 'unrun');
    assert.equal(receipt.providerIntegration, 'unrun');
    assert.equal(receipt.usage, null);
    assert.equal(statSync(result.receipt).mode & 0o777, 0o600);
    assert.equal(summary[0]!.includes('under investigation'), false);
  }
  assert.equal(fetches, 0);
});

test('live smoke needs explicit configuration, dispatches one selected schema, and fails with a redacted refusal receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'promiseguard-live-smoke-test-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let fetches = 0;
  const summaries: string[] = [];
  const refusal = 'Private synthetic refusal prose must remain restricted.';
  const options = { write: (value: string) => summaries.push(value), fetch: (async (_input, init) => {
    fetches++;
    const request = JSON.parse(String(init?.body));
    assert.equal(request.text.format.name, 'auditor_v2');
    return new Response(responseBody(refusal, true), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch };
  assert.equal(await runModelSmoke(['--mode', 'live', '--role', 'auditor', '--receipt-dir', directory],
    { ...options, env: {} }), 1);
  assert.equal(fetches, 0);
  assert.equal(JSON.parse(summaries[0]!).reason, 'configuration_invalid');
  assert.equal(await runModelSmoke(['--mode', 'live', '--role', 'auditor', '--receipt-dir', directory],
    { ...options, env: { PG_MODEL_MODE: 'live', OPENAI_API_KEY: 'synthetic-only-test-key', OPENAI_MODEL: 'fixture-model' } }), 1);
  assert.equal(fetches, 1);
  const summary = JSON.parse(summaries.at(-1)!);
  assert.equal(summary.reason, 'refusal');
  const receipt = JSON.parse(readFileSync(summary.receipt, 'utf8'));
  assert.equal(receipt.attempts.length, 1);
  assert.equal(receipt.originalOutputs[0].parseStatus, 'refused');
  assert.equal(summaries.join('').includes(refusal), false);
  assert.equal(summaries.join('').includes('synthetic-only-test-key'), false);
});
