import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AdapterError,
  classifyHttpError,
  forMutation,
  parseRetryAfterMs,
} from '../../dist/server/adapters/common/errors.js';
import { paginate } from '../../dist/server/adapters/common/pagination.js';
import {
  createBoundedRestTransport,
  createIdempotentReceiptSink,
} from '../../dist/server/adapters/common/transport.js';
import {
  parseProviderSmokeManifest,
  runProviderSmokes,
} from '../../tools/smoke/providers.ts';

const digest = 'a'.repeat(64);
const artifact = suffix => ({
  artifactId: `artifact-${suffix}`,
  sha256: digest,
  byteLength: 2,
  mediaType: 'application/json',
});

function readContext(overrides = {}) {
  return {
    schemaVersion: 2,
    runId: 'run-1',
    evaluationAttemptId: 'evaluation-1',
    runtimeAttemptId: 'runtime-1',
    spanId: 'span-1',
    app: 'slack',
    accountRef: 'account-1',
    mode: 'rest',
    operation: 'slack.readApprovalThread',
    logicalCallId: 'call-1',
    providerAttemptId: 'provider-1',
    deadlineAt: '2026-09-14T10:00:10.000Z',
    budgets: {
      timeoutMs: 1000,
      totalMs: 10000,
      maxAttempts: 2,
      maxPages: 10,
      maxRecords: 100,
      maxResponseBytes: 10000,
    },
    ...overrides,
  };
}

function mutationContext(overrides = {}) {
  return readContext({
    operation: 'slack.postReview',
    marker: 'effect-1',
    requestDigest: digest,
    budgets: { ...readContext().budgets, maxAttempts: 1 },
    ...overrides,
  });
}

function harness(fetch) {
  let monotonicMs = 100;
  let nextId = 2;
  const receipts = [];
  const retries = [];
  const dispatches = [];
  const transport = createBoundedRestTransport({
    fetch,
    clock: {
      wallNowMs: () => Date.parse('2026-09-14T10:00:00.000Z'),
      monotonicNowMs: () => monotonicMs,
      sleep: async delayMs => { monotonicMs += delayMs; },
    },
    createProviderAttemptId: () => `provider-${nextId++}`,
    createSpanId: () => `span-${nextId}`,
    storeResponse: input => ({ ...artifact(`response-${receipts.length}`), byteLength: input.bytes.byteLength }),
    storeReceipt: receipt => {
      receipts.push(receipt);
      return artifact(`receipt-${receipts.length}`);
    },
    observer: {
      onDispatch: dispatch => { dispatches.push(dispatch); },
      onResult: () => {},
      onRetry: retry => { retries.push(retry); },
    },
  });
  return { transport, receipts, retries, dispatches };
}

test('normalizes permanent denial without retrying', () => {
  const error = classifyHttpError(403, null, Date.parse('2026-09-14T10:00:00.000Z'));

  assert.equal(error.code, 'denied');
  assert.equal(error.providerOutcome, 'denied');
  assert.equal(error.isRetryable, false);
});

test('parses Retry-After seconds and dates from the injected wall clock', () => {
  const now = Date.parse('2026-09-14T10:00:00.000Z');

  assert.equal(parseRetryAfterMs('1.5', now), 1500);
  assert.equal(parseRetryAfterMs('Sun, 14 Sep 2026 10:00:02 GMT', now), 2000);
  assert.equal(parseRetryAfterMs('not-a-date', now), null);
});

test('keeps uncertain mutation failures terminal', () => {
  const error = forMutation(new AdapterError('transport_error', {
    providerOutcome: 'unknown',
    isRetryable: true,
  }));

  assert.equal(error.providerOutcome, 'unknown');
  assert.equal(error.isRetryable, false);
});

test('retries a bounded read with new provider attempt and span ids', async () => {
  let calls = 0;
  const { transport, receipts, retries, dispatches } = harness(async () => {
    calls += 1;
    if (calls === 1) return new Response('{}', { status: 503, headers: { 'retry-after': '1' } });
    return Response.json({ ok: true }, { headers: { 'x-slack-req-id': 'request-2' } });
  });

  const result = await transport.begin(readContext()).request({
    url: 'https://slack.com/api/conversations.replies',
    method: 'GET',
    decode: body => body,
  });

  assert.equal(result.status, 'success');
  assert.equal(calls, 2);
  assert.deepEqual(receipts.map(receipt => receipt.context.providerAttemptId), ['provider-1', 'provider-2']);
  assert.deepEqual(receipts.map(receipt => receipt.context.logicalCallId), ['call-1', 'call-1']);
  assert.deepEqual(dispatches.map(dispatch => dispatch.context.spanId), ['span-1', 'span-3']);
  assert.equal(retries[0].delayMs, 1000);
});

test('treats a Slack-style HTTP 200 error as provider failure', async () => {
  const { transport, receipts } = harness(async () => Response.json({ ok: false, error: 'not_authed' }));

  const result = await transport.begin(readContext()).request({
    url: 'https://slack.com/api/conversations.replies',
    method: 'GET',
    decode: body => {
      if (!body.ok) throw new AdapterError('denied', { providerOutcome: 'denied', isRetryable: false });
      return body;
    },
  });

  assert.equal(result.status, 'failure');
  assert.equal(result.error.code, 'denied');
  assert.equal(receipts[0].httpStatus, 200);
  assert.equal(receipts[0].providerOutcome, 'denied');
});

test('does not retry an uncertain mutation', async () => {
  let calls = 0;
  const { transport } = harness(async () => {
    calls += 1;
    throw new TypeError('redacted network failure');
  });

  const result = await transport.begin(mutationContext()).request({
    url: 'https://slack.com/api/chat.postMessage',
    method: 'POST',
    body: '{}',
    decode: body => body,
  });

  assert.equal(result.status, 'failure');
  assert.equal(result.error.providerOutcome, 'unknown');
  assert.equal(result.error.isRetryable, false);
  assert.equal(calls, 1);
});

test('fails closed when the terminal receipt cannot be stored', async () => {
  const broken = createBoundedRestTransport({
    fetch: async () => Response.json({ ok: true }),
    clock: {
      wallNowMs: () => Date.parse('2026-09-14T10:00:00.000Z'),
      monotonicNowMs: () => 100,
      sleep: async () => {},
    },
    createProviderAttemptId: () => 'provider-2',
    createSpanId: () => 'span-2',
    storeResponse: () => artifact('response'),
    storeReceipt: () => { throw new Error('database unavailable'); },
    observer: { onDispatch: () => {}, onResult: () => {}, onRetry: () => {} },
  });

  await assert.rejects(() => broken.begin(readContext()).request({
    url: 'https://slack.com/api/conversations.replies',
    method: 'GET',
    decode: body => body,
  }), error => error instanceof AdapterError && error.code === 'receipt_persistence_failed');
});

test('keeps successful first-page evidence when page two fails', async () => {
  let calls = 0;
  const { transport } = harness(async () => {
    calls += 1;
    return calls === 1
      ? Response.json({ records: [{ id: 'message-1' }], nextCursor: 'cursor-2' })
      : Response.json({ error: 'internal_error' }, { status: 500 });
  });
  const operation = transport.begin(readContext({
    budgets: { ...readContext().budgets, maxAttempts: 1 },
  }));

  const result = await paginate({
    operation,
    collectionId: 'collection-1',
    producerId: 'adapter-core',
    queryId: 'approval-thread',
    fetchPage: (cursor, _pageIndex, currentOperation) => currentOperation.request({
      url: `https://slack.com/api/conversations.replies?cursor=${cursor ?? ''}`,
      method: 'GET',
      decode: body => body,
    }),
  });

  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'page_failed');
  assert.deepEqual(result.partialData, [{ id: 'message-1' }]);
  assert.equal(result.receipt.pages.length, 1);
  assert.equal(result.receipt.pages[0].nextCursor, 'cursor-2');
});

test('deduplicates identical receipt delivery and rejects conflicting reuse', async () => {
  let stores = 0;
  const sink = createIdempotentReceiptSink(async () => {
    stores += 1;
    return artifact(`deduplicated-${stores}`);
  });
  const receipt = {
    schemaVersion: 2,
    context: readContext(),
    startedAt: '2026-09-14T10:00:00.000Z',
    finishedAt: '2026-09-14T10:00:00.100Z',
    transport: 'rest',
    httpStatus: 200,
    transportOutcome: 'response',
    providerOutcome: 'success',
    responseRef: artifact('response'),
    errorCode: null,
  };

  const [first, duplicate] = await Promise.all([sink(receipt), sink(receipt)]);
  assert.deepEqual(first, duplicate);
  assert.equal(stores, 1);
  await assert.rejects(() => sink({ ...receipt, httpStatus: 201 }), AdapterError);
});

test('reports missing REST credentials as unrun without exposing values', async () => {
  const manifest = {
    schemaVersion: 1,
    mode: 'rest',
    providers: {
      slack: {
        accountRef: 'workspace-1',
        capabilities: ['slack.readApprovalThread'],
        credentialEnv: ['PG_SLACK_READER_TOKEN'],
      },
    },
  };

  const report = await runProviderSmokes(manifest, {}, {});

  assert.deepEqual(report.results, [{
    provider: 'slack',
    status: 'unrun',
    reason: 'missing_credentials:PG_SLACK_READER_TOKEN',
  }]);
  assert.equal(JSON.stringify(report).includes('workspace-1'), false);
});

test('rejects cross-provider smoke capabilities', () => {
  assert.throws(() => parseProviderSmokeManifest({
    schemaVersion: 1,
    mode: 'fake',
    providers: {
      gmail: {
        accountRef: 'mailbox-1',
        capabilities: ['gmail.createDraft', 'slack.postSummary'],
        credentialEnv: [],
      },
    },
  }), /invalid_gmail_smoke_manifest/);
});