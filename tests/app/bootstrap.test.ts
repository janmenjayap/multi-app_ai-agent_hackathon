import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test, vi, type TestContext } from 'vitest';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import Database from 'better-sqlite3';
import { build } from 'vite';
import { z } from 'zod';
import { createApp, loadConfig } from '../../src/server/index.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// These deliberately unusable credentials only exercise local configuration.
// No live model or provider request is made by this bootstrap suite.
const modelEnvironment: NodeJS.ProcessEnv = {
  GEMINI_API_KEY: 'synthetic-gemini-secret-do-not-dispatch',
  GEMINI_MODEL: 'gemini-3.8-flash',
};
const providerEnvironment: NodeJS.ProcessEnv = {
  PG_GITHUB_TOKEN: 'synthetic-github-secret-do-not-dispatch',
  PG_GITHUB_REPOSITORY: 'bootstrap-fixture/disposable',
  PG_HUBSPOT_ACCESS_TOKEN: 'synthetic-hubspot-secret-do-not-dispatch',
  PG_HUBSPOT_PORTAL_ID: '123456789',
  PG_SLACK_BOT_TOKEN: 'synthetic-slack-bot-secret-do-not-dispatch',
  PG_SLACK_READER_TOKEN: 'synthetic-slack-reader-secret-do-not-dispatch',
  PG_SLACK_TEAM_ID: 'TBOOTSTRAP',
  PG_SLACK_CHANNEL_ID: 'CBOOTSTRAP',
  PG_SLACK_APPROVER_IDS: 'UBOOTSTRAP',
  PG_GMAIL_CLIENT_ID: 'synthetic-bootstrap-client.apps.googleusercontent.com',
  PG_GMAIL_CLIENT_SECRET: 'synthetic-gmail-client-secret-do-not-dispatch',
  PG_GMAIL_REFRESH_TOKEN: 'synthetic-gmail-refresh-secret-do-not-dispatch',
  PG_GMAIL_MAILBOX: 'bootstrap-fixture@example.invalid',
};
const fixtureEnvironment: NodeJS.ProcessEnv = { PG_FIXTURE_ID: 'f01-bootstrap-v1' };

async function temporaryDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'promiseguard-bootstrap-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('default startup is explicitly fixture-backed and health claims only bootstrap readiness', async t => {
  const app = await createApp({ env: fixtureEnvironment });
  t.onTestFinished(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: 'ok', scope: 'bootstrap', modelMode: 'mock', adapterMode: 'fake',
    fixtureId: fixtureEnvironment.PG_FIXTURE_ID,
  });
  for (const url of ['/api/runs', '/api/approve', '/api/effects', '/api/complete']) {
    const missing = await app.inject({ method: 'GET', url });
    assert.equal(missing.statusCode, 404, `${url} must not claim product functionality`);
  }
});

test('default configuration freezes the listener, model budgets and independent storage boundaries', () => {
  const config = loadConfig(fixtureEnvironment);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.deepEqual(config.model, {
    name: undefined,
    roles: { analyst: undefined, drafter: undefined, auditor: undefined },
    timeoutMs: 30_000, roleBudgetMs: 90_000, maxAttempts: 2,
    maxOutputTokens: 2_000, maxInputChars: 24_000,
  });
  assert.equal(new Set(Object.values(config.storage)).size, 3);
  assert.equal(config.storage.databasePath, resolve('.local/application.sqlite'));
  assert.equal(config.storage.checkpointPath, resolve('.local/checkpoints.sqlite'));
  assert.equal(config.storage.evidenceDir, resolve('.local/evidence'));
});

test('role-specific model overrides fall back to the default without requiring tracing credentials', () => {
  const config = loadConfig({
    ...fixtureEnvironment, ...modelEnvironment, PG_MODEL_MODE: 'live',
    GEMINI_MODEL_ANALYST: 'synthetic-analyst-model', GEMINI_MODEL_AUDITOR: 'synthetic-auditor-model',
  });
  assert.deepEqual(config.model.roles, {
    analyst: 'synthetic-analyst-model', drafter: modelEnvironment.GEMINI_MODEL,
    auditor: 'synthetic-auditor-model',
  });
});

for (const modelMode of ['mock', 'live'] as const) {
  for (const adapterMode of ['fake', 'rest'] as const) {
    test(`model ${modelMode} and adapters ${adapterMode} are independent startup choices`, async t => {
      const synthetic = modelMode === 'mock' || adapterMode === 'fake';
      const env: NodeJS.ProcessEnv = {
        PG_MODEL_MODE: modelMode,
        PG_ADAPTER_MODE: adapterMode,
        ...(synthetic ? fixtureEnvironment : {}),
        ...(modelMode === 'live' ? modelEnvironment : {}),
        ...(adapterMode === 'rest' ? providerEnvironment : {}),
      };
      const dispatch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw new Error('bootstrap must not dispatch models or providers');
      });
      const app = await createApp({ env });
      t.onTestFinished(() => app.close());
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      assert.deepEqual(response.json(), {
        status: 'ok', scope: 'bootstrap', modelMode, adapterMode,
        fixtureId: synthetic ? fixtureEnvironment.PG_FIXTURE_ID : null,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(dispatch.mock.calls.length, 0);
    });

    if (modelMode === 'mock' || adapterMode === 'fake') {
      test(`${modelMode}/${adapterMode} refuses to start without an explicit fixture identity`, async () => {
        for (const fixtureId of [undefined, '', '   ']) {
          await assert.rejects(createApp({ env: {
            ...modelEnvironment, ...providerEnvironment,
            PG_MODEL_MODE: modelMode, PG_ADAPTER_MODE: adapterMode,
            PG_FIXTURE_ID: fixtureId,
          } }), /PG_FIXTURE_ID/);
        }
      });
    }
  }
}

for (const key of [...Object.keys(modelEnvironment), ...Object.keys(providerEnvironment)]) {
  test(`live startup rejects missing ${key} before constructing services`, async () => {
    const env: NodeJS.ProcessEnv = {
      ...modelEnvironment, ...providerEnvironment,
      PG_MODEL_MODE: 'live', PG_ADAPTER_MODE: 'rest',
    };
    delete env[key];
    let constructed = false;
    await assert.rejects(createApp({
      env,
      createServices: () => { constructed = true; return {}; },
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(key));
      for (const value of Object.values(env)) {
        if (value && value !== 'live' && value !== 'rest') {
          assert.ok(!error.message.includes(value), 'configuration errors must not echo environment values');
        }
      }
      return true;
    });
    assert.equal(constructed, false);
  });
}

test('invalid and unsupported transport/model modes fail without echoing the supplied value', () => {
  for (const [key, value] of [
    ['PG_MODEL_MODE', 'invalid-private-model-mode'],
    ['PG_ADAPTER_MODE', 'mcp'],
    ['PG_ADAPTER_MODE', 'invalid-private-adapter-mode'],
  ]) {
    assert.throws(() => loadConfig({ ...fixtureEnvironment, [key]: value }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(key));
      if (value.startsWith('invalid-private')) assert.ok(!error.message.includes(value));
      return true;
    });
  }
});

const budgetKeys = [
  'PG_MODEL_TIMEOUT_MS', 'PG_MODEL_ROLE_BUDGET_MS', 'PG_MODEL_MAX_ATTEMPTS',
  'PG_MODEL_MAX_OUTPUT_TOKENS', 'PG_MODEL_MAX_INPUT_CHARS',
];
for (const key of budgetKeys) {
  test(`${key} accepts positive integers and rejects invalid budget values`, () => {
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '3seconds', '9007199254740992', '']) {
      assert.throws(() => loadConfig({ ...fixtureEnvironment, [key]: value }), new RegExp(key));
    }
    assert.doesNotThrow(() => loadConfig({
      ...fixtureEnvironment, PG_MODEL_TIMEOUT_MS: '1', PG_MODEL_ROLE_BUDGET_MS: '1', [key]: '1',
    }));
  });
}

test('a role budget cannot be shorter than the timeout for one model attempt', () => {
  assert.throws(() => loadConfig({
    ...fixtureEnvironment, PG_MODEL_TIMEOUT_MS: '30000', PG_MODEL_ROLE_BUDGET_MS: '29999',
  }), /PG_MODEL_ROLE_BUDGET_MS/);
});

test('the application listener port must be an integer in the TCP port range', () => {
  for (const value of ['0', '-1', '65536', '3000.5', 'invalid-private-port', '']) {
    assert.throws(() => loadConfig({ ...fixtureEnvironment, PG_PORT: value }), /PG_PORT/);
  }
  for (const value of ['1', '65535']) {
    assert.doesNotThrow(() => loadConfig({ ...fixtureEnvironment, PG_PORT: value }));
  }
});

test('application data, graph checkpoints and evidence have separate configured paths', () => {
  assert.doesNotThrow(() => loadConfig({
    ...fixtureEnvironment, PG_DATABASE_PATH: './data/bootstrap-app.sqlite',
    PG_CHECKPOINT_PATH: './data/bootstrap-graph.sqlite', PG_EVIDENCE_DIR: './data/bootstrap-evidence',
  }));
  for (const [left, right] of [
    ['PG_DATABASE_PATH', 'PG_CHECKPOINT_PATH'],
    ['PG_DATABASE_PATH', 'PG_EVIDENCE_DIR'],
    ['PG_CHECKPOINT_PATH', 'PG_EVIDENCE_DIR'],
  ]) {
    assert.throws(() => loadConfig({
      ...fixtureEnvironment, [left]: './data/bootstrap-collision', [right]: resolve('data/bootstrap-collision'),
    }), /PG_DATABASE_PATH|PG_CHECKPOINT_PATH|PG_EVIDENCE_DIR/);
  }
});

test('production serves the built browser HTML and referenced JavaScript on the same origin', async t => {
  const env = { ...fixtureEnvironment, ...modelEnvironment, ...providerEnvironment, NODE_ENV: 'production' };
  const app = await createApp({ env });
  t.onTestFinished(() => app.close());
  const html = await app.inject({ method: 'GET', url: '/' });
  assert.equal(html.statusCode, 200);
  assert.match(html.headers['content-type'] ?? '', /text\/html/);
  assert.match(html.body, /id="root"/);
  const scripts = [...html.body.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.length > 0, 'the production build must reference a browser script');
  for (const script of scripts) {
    assert.match(script, /^\/assets\/.+\.js$/, 'browser JavaScript must come from this origin');
    const asset = await app.inject({ method: 'GET', url: script });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers['content-type'] ?? '', /(?:javascript|ecmascript)/);
    assert.ok(asset.body.length > 0);
    for (const secret of Object.values({ ...modelEnvironment, ...providerEnvironment })) {
      assert.ok(secret && !asset.body.includes(secret), 'browser assets must not include server environment values');
      assert.ok(secret && !html.body.includes(secret), 'browser HTML must not include server environment values');
    }
  }
  const health = await app.inject({ method: 'GET', url: '/api/health' });
  for (const secret of Object.values({ ...modelEnvironment, ...providerEnvironment })) {
    assert.ok(secret && !health.body.includes(secret), 'health must not include server environment values');
  }
  for (const path of ['/src/server/index.ts', '/.env', '/api/not-implemented']) {
    assert.equal((await app.inject({ method: 'GET', url: path })).statusCode, 404);
  }
});

test('a missing production build reports how to build it before constructing services', async t => {
  const directory = await temporaryDirectory(t);
  let constructed = false;
  await assert.rejects(createApp({
    env: { ...fixtureEnvironment, NODE_ENV: 'production' },
    webRoot: directory,
    createServices: () => { constructed = true; return {}; },
  }), /build:web|npm run build|browser.*build/i);
  assert.equal(constructed, false);
});

test('the production browser build excludes server secrets, including VITE-prefixed values', async t => {
  const directory = await temporaryDirectory(t);
  const markers = {
    GEMINI_API_KEY: 'F01_BUILD_PRIVATE_GEMINI_71d9cf',
    PG_GITHUB_TOKEN: 'F01_BUILD_PRIVATE_GITHUB_28a1ec',
    VITE_GEMINI_API_KEY: 'F01_BUILD_PRIVATE_VITE_GEMINI_43e0ba',
  };
  for (const [name, value] of Object.entries(markers)) vi.stubEnv(name, value);
  const output = await build({
    configFile: resolve('vite.config.ts'),
    build: { outDir: directory },
    logLevel: 'silent',
  });
  const emitted = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = emitted.filter(entry => entry.isFile());
  assert.ok(files.some(entry => entry.name === 'index.html'));
  assert.ok(files.some(entry => entry.name.endsWith('.js')));
  for (const entry of files) {
    const contents = await readFile(join(entry.parentPath, entry.name), 'utf8');
    for (const value of Object.values(markers)) assert.ok(!contents.includes(value));
  }
  const bundles = Array.isArray(output) ? output : [output];
  for (const bundle of bundles) {
    assert.ok('output' in bundle, 'the build must produce browser assets');
    for (const chunk of bundle.output) {
      if (chunk.type !== 'chunk') continue;
      for (const moduleId of Object.keys(chunk.modules)) {
        assert.doesNotMatch(moduleId, /\/src\/server\/|\/(?:fastify|better-sqlite3|@langchain)\//);
      }
    }
  }
});

test('injected lifecycle starts once, then stops scheduling, flushes and closes in order', async t => {
  const events: string[] = [];
  const app = await createApp({
    env: fixtureEnvironment,
    createServices: async config => {
      assert.deepEqual(config, loadConfig(fixtureEnvironment));
      events.push('construct');
      return {
        start: async () => { await Promise.resolve(); events.push('start'); },
        stop: async () => { await Promise.resolve(); events.push('stop'); },
        flush: async () => { await Promise.resolve(); events.push('flush'); },
        close: async () => { await Promise.resolve(); events.push('close'); },
      };
    },
  });
  t.onTestFinished(() => app.close());
  assert.deepEqual(events, ['construct', 'start']);
  await app.ready();
  await app.ready();
  assert.deepEqual(events, ['construct', 'start']);
  await app.close();
  assert.deepEqual(events, ['construct', 'start', 'stop', 'flush', 'close']);
});

test('shutdown still closes injected resources when flushing fails', async () => {
  const events: string[] = [];
  const app = await createApp({
    env: fixtureEnvironment,
    createServices: () => ({
      stop: () => { events.push('stop'); },
      flush: () => { events.push('flush'); throw new Error('bootstrap-test-flush-failed'); },
      close: () => { events.push('close'); },
    }),
  });
  await app.ready();
  await assert.rejects(app.close(), /bootstrap-test-flush-failed/);
  assert.deepEqual(events, ['stop', 'flush', 'close']);
});

test('shutdown still flushes and closes resources when stopping scheduling fails', async () => {
  const events: string[] = [];
  const failure = new Error('bootstrap-test-stop-failed');
  const app = await createApp({
    env: fixtureEnvironment,
    createServices: () => ({
      stop: () => { events.push('stop'); throw failure; },
      flush: () => { events.push('flush'); },
      close: () => { events.push('close'); },
    }),
  });
  await assert.rejects(app.close(), error => error === failure);
  assert.deepEqual(events, ['stop', 'flush', 'close']);
});

test('startup failure is surfaced and injected resources are automatically closed', async () => {
  const events: string[] = [];
  await assert.rejects(createApp({
    env: fixtureEnvironment,
    createServices: () => ({
      start: () => { throw new Error('bootstrap-test-start-failed'); },
      stop: () => { events.push('stop'); },
      flush: () => { events.push('flush'); },
      close: () => { events.push('close'); },
    }),
  }), /bootstrap-test-start-failed/);
  assert.deepEqual(events, ['stop', 'flush', 'close']);
});

test('startup and cleanup failures both survive with the startup error retained as the cause', async () => {
  const events: string[] = [];
  const startupFailure = new Error('bootstrap-test-start-failed');
  const flushFailure = new Error('bootstrap-test-flush-failed');
  await assert.rejects(createApp({
    env: fixtureEnvironment,
    createServices: () => ({
      start: () => { throw startupFailure; },
      stop: () => { events.push('stop'); },
      flush: () => { events.push('flush'); throw flushFailure; },
      close: () => { events.push('close'); },
    }),
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, startupFailure);
    assert.deepEqual(error.errors, [startupFailure, flushFailure]);
    return true;
  });
  assert.deepEqual(events, ['stop', 'flush', 'close']);
});

test('service construction errors fail startup instead of substituting fixture clients', async () => {
  await assert.rejects(createApp({
    env: fixtureEnvironment,
    createServices: () => { throw new Error('bootstrap-test-construction-failed'); },
  }), /bootstrap-test-construction-failed/);
});

test('the selected SQLite driver persists a disposable application database across reopen', async t => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, 'application.sqlite');
  const database = new Database(path);
  try {
    database.exec('CREATE TABLE bootstrap_smoke (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    database.prepare('INSERT INTO bootstrap_smoke (id, value) VALUES (?, ?)').run('fixture', 'persisted');
  } finally {
    database.close();
  }
  const reopened = new Database(path);
  try {
    assert.deepEqual(reopened.prepare('SELECT id, value FROM bootstrap_smoke').all(), [
      { id: 'fixture', value: 'persisted' },
    ]);
  } finally {
    reopened.close();
  }
});

test('the selected LangGraph/checkpointer pair persists and reopens graph state without clients', async t => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, 'checkpoints.sqlite');
  const state = Annotation.Root({ value: Annotation<string>() });
  const builder = new StateGraph(state)
    .addNode('bootstrap', () => ({ value: 'persisted fixture checkpoint' }))
    .addEdge(START, 'bootstrap')
    .addEdge('bootstrap', END);
  const config = { configurable: { thread_id: 'f01-bootstrap-fixture' } };
  const checkpointer = SqliteSaver.fromConnString(path);
  try {
    const graph = builder.compile({ checkpointer });
    assert.deepEqual(await graph.invoke({ value: 'initial fixture input' }, config), {
      value: 'persisted fixture checkpoint',
    });
  } finally {
    checkpointer.db.close();
  }
  const reopened = SqliteSaver.fromConnString(path);
  try {
    const graph = builder.compile({ checkpointer: reopened });
    const snapshot = await graph.getState(config);
    assert.deepEqual(snapshot.values, { value: 'persisted fixture checkpoint' });
    assert.deepEqual(snapshot.next, []);
    const checkpoint = await reopened.getTuple(config);
    assert.ok(checkpoint);
    const persisted = JSON.stringify(checkpoint);
    assert.ok(!persisted.includes('apiKey'));
    assert.ok(!persisted.includes('client_secret'));
    assert.ok(!persisted.includes('synthetic-gemini-secret'));
    assert.ok((await readFile(path)).byteLength > 0);
    assert.ok((await readdir(directory)).includes('checkpoints.sqlite'));
  } finally {
    reopened.db.close();
  }
});

test('LangChain prompts and Gemini-compatible JSON schemas are prepared locally', async () => {
  const schema = z.object({ status: z.literal('bootstrap'), fixtureId: z.string() }).strict();
  const prompt = ChatPromptTemplate.fromMessages([
    ['system', 'Return the bootstrap marker for the named fixture.'],
    ['human', '{fixtureId}'],
  ]);
  const messages = await prompt.formatMessages({ fixtureId: 'f01-bootstrap-v1' });
  assert.equal(messages[1].content, 'f01-bootstrap-v1');
  const jsonSchema = z.toJSONSchema(schema);
  assert.deepEqual(jsonSchema.required, ['status', 'fixtureId']);
  assert.deepEqual(schema.parse({ status: 'bootstrap', fixtureId: 'f01-bootstrap-v1' }), {
    status: 'bootstrap', fixtureId: 'f01-bootstrap-v1',
  });
  assert.throws(() => schema.parse({ status: 'unsupported-product-success' }));
});
