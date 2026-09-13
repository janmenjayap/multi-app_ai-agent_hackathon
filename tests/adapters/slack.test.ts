import assert from 'node:assert/strict';
import test from 'node:test';

import { createSlackAdapter } from '../../dist/server/adapters/slack.js';
import { createBoundedRestTransport } from '../../dist/server/adapters/common/transport.js';

const digest = 'a'.repeat(64);
const workspaceId = 'T123';
const channelId = 'C123';
const threadTs = '1789372800.100000';

function artifact(id, byteLength = 2) {
  return {
    artifactId: id,
    sha256: digest,
    byteLength,
    mediaType: 'application/json',
  };
}

function readContext(operation, overrides = {}) {
  return {
    schemaVersion: 2,
    runId: 'run-slack-1',
    evaluationAttemptId: 'evaluation-slack-1',
    runtimeAttemptId: 'runtime-slack-1',
    spanId: `span-${operation}`,
    app: 'slack',
    accountRef: 'slack-account-1',
    mode: 'rest',
    operation,
    logicalCallId: `call-${operation}`,
    providerAttemptId: `provider-${operation}`,
    deadlineAt: '2026-09-14T10:00:10.000Z',
    budgets: {
      timeoutMs: 1000,
      totalMs: 10000,
      maxAttempts: 1,
      maxPages: 5,
      maxRecords: 100,
      maxResponseBytes: 10000,
    },
    ...overrides,
  };
}

function coordinationContext(operation, marker = 'slack-marker-1', overrides = {}) {
  return readContext(operation, {
    marker,
    requestDigest: digest,
    ...overrides,
  });
}

function harness(fetch) {
  let monotonicMs = 100;
  let nextId = 1;
  const requests = [];
  const receipts = [];
  const transport = createBoundedRestTransport({
    fetch: async (input, init) => {
      requests.push({ input, init });
      return fetch(input, init);
    },
    clock: {
      wallNowMs: () => Date.parse('2026-09-14T10:00:00.000Z'),
      monotonicNowMs: () => monotonicMs++,
      sleep: async delayMs => { monotonicMs += delayMs; },
    },
    createProviderAttemptId: () => `generated-provider-${nextId++}`,
    createSpanId: () => `generated-span-${nextId++}`,
    storeResponse: input => artifact(`response-${receipts.length + 1}`, input.bytes.byteLength),
    storeReceipt: receipt => {
      receipts.push(receipt);
      return artifact(`receipt-${receipts.length}`);
    },
    observer: { onDispatch: () => {}, onResult: () => {}, onRetry: () => {} },
  });
  const adapter = createSlackAdapter({
    scope: { app: 'slack', accountRef: 'slack-account-1' },
    workspaceId,
    channelId,
    readerToken: 'reader-token',
    writerToken: 'writer-token',
    transport,
  });
  return { adapter, receipts, requests };
}

test('reads every reply page and preserves authority-relevant message metadata', async () => {
  let page = 0;
  const { adapter, requests } = harness(async () => {
    page += 1;
    if (page === 1) {
      return Response.json({
        ok: true,
        messages: [
          { ts: threadTs, bot_id: 'B123', text: 'review slack-marker-1' },
          {
            ts: '1789372801.200000',
            thread_ts: threadTs,
            user: 'U123',
            text: 'approve slack-marker-1',
            edited: { user: 'U123', ts: '1789372802.300000' },
          },
        ],
        response_metadata: { next_cursor: 'page-2' },
      });
    }
    return Response.json({
      ok: true,
      messages: [{
        subtype: 'message_deleted',
        hidden: true,
        deleted_ts: '1789372803.400000',
        previous_message: {
          ts: '1789372803.400000',
          thread_ts: threadTs,
          user: 'U456',
          text: 'rejected then deleted',
        },
      }],
      response_metadata: { next_cursor: '' },
    });
  });

  const result = await adapter.readApprovalThread(
    channelId,
    threadTs,
    readContext('slack.readApprovalThread'),
  );

  assert.equal(result.status, 'complete');
  assert.equal(result.data.length, 3);
  assert.equal(result.data[0].isBot, true);
  assert.equal(result.data[1].actorId, 'U123');
  assert.equal(result.data[1].editedAt, '2026-09-14T08:00:02.300Z');
  assert.equal(result.data[2].deleted, true);
  assert.equal(result.data[2].actorId, 'U456');
  assert.equal(result.data[2].threadTs, threadTs);
  assert.equal(result.receipt.pages.length, 2);
  assert.match(requests[1].input, /cursor=page-2/);
  assert.equal(new Headers(requests[0].init.headers).get('authorization'), 'Bearer reader-token');
});

test('keeps page-one replies when Slack denies page two through ok false', async () => {
  let page = 0;
  const { adapter, receipts } = harness(async () => {
    page += 1;
    return page === 1
      ? Response.json({
          ok: true,
          messages: [{ ts: threadTs, user: 'U123', text: 'parent' }],
          response_metadata: { next_cursor: 'page-2' },
        })
      : Response.json({ ok: false, error: 'missing_scope' });
  });

  const result = await adapter.readApprovalThread(
    channelId,
    threadTs,
    readContext('slack.readApprovalThread'),
  );

  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'page_failed');
  assert.equal(result.partialData.length, 1);
  assert.equal(result.receipt.pages.length, 1);
  assert.equal(receipts[1].httpStatus, 200);
  assert.equal(receipts[1].providerOutcome, 'denied');
});

test('returns every duplicate marker match without interpreting actors', async () => {
  const { adapter } = harness(async () => Response.json({
    ok: true,
    messages: [
      { ts: '1789372801.000000', user: 'U123', text: 'review slack-marker-1' },
      { ts: '1789372802.000000', bot_id: 'B123', text: 'duplicate slack-marker-1' },
      { ts: '1789372803.000000', user: 'U456', text: 'unrelated' },
    ],
    response_metadata: { next_cursor: '' },
  }));

  const result = await adapter.findReview('slack-marker-1', readContext('slack.findReview'));

  assert.equal(result.status, 'complete');
  assert.equal(result.data.length, 2);
  assert.deepEqual(result.data.map(message => message.isBot), [false, true]);
});

test('reports an acknowledged but absent summary as a complete null read', async () => {
  const { adapter, requests } = harness(async () => Response.json({
    ok: true,
    messages: [],
    response_metadata: { next_cursor: '' },
  }));

  const result = await adapter.readSummary(
    channelId,
    '1789372809.000000',
    readContext('slack.readSummary'),
  );

  assert.equal(result.status, 'complete');
  assert.equal(result.data, null);
  const url = new URL(requests[0].input);
  assert.equal(url.pathname, '/api/conversations.history');
  assert.equal(url.searchParams.get('inclusive'), 'true');
  assert.equal(url.searchParams.get('oldest'), '1789372809.000000');
});

test('posts and updates exact marked coordination messages with the writer token', async () => {
  const responses = [
    { ok: true, channel: channelId, ts: '1789372810.000000' },
    { ok: true, channel: channelId, ts: '1789372810.000000' },
  ];
  const { adapter, requests, receipts } = harness(async () => Response.json(responses.shift()));

  const posted = await adapter.postReview(
    { channelId, threadTs: null, body: 'review slack-marker-1' },
    coordinationContext('slack.postReview'),
  );
  const updated = await adapter.updateSummary(
    '1789372810.000000',
    { channelId, threadTs, body: 'summary slack-marker-1' },
    coordinationContext('slack.updateSummary'),
  );

  assert.equal(posted.status, 'applied');
  assert.equal(posted.providerId, '1789372810.000000');
  assert.equal(updated.status, 'applied');
  assert.deepEqual(receipts.map(receipt => receipt.context.operation), [
    'slack.postReview',
    'slack.updateSummary',
  ]);
  assert.equal(new URL(requests[0].input).pathname, '/api/chat.postMessage');
  assert.equal(new URL(requests[1].input).pathname, '/api/chat.update');
  assert.equal(new Headers(requests[0].init.headers).get('authorization'), 'Bearer writer-token');
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    channel: channelId,
    text: 'summary slack-marker-1',
    ts: '1789372810.000000',
  });
});

test('distinguishes definitive Slack refusal from an uncertain coordination write', async () => {
  const denied = harness(async () => Response.json({ ok: false, error: 'not_authed' }));
  const deniedResult = await denied.adapter.postReview(
    { channelId, threadTs: null, body: 'review slack-marker-1' },
    coordinationContext('slack.postReview'),
  );

  assert.equal(deniedResult.status, 'not_applied');
  assert.equal(deniedResult.reason, 'denied');

  const uncertain = harness(async () => { throw new TypeError('redacted network failure'); });
  const uncertainResult = await uncertain.adapter.postSummary(
    { channelId, threadTs, body: 'summary slack-marker-1' },
    coordinationContext('slack.postSummary'),
  );

  assert.equal(uncertainResult.status, 'unknown');
  assert.equal(uncertainResult.reason, 'transport_error');
  assert.equal(uncertain.requests.length, 1);
});

test('rejects a wrong channel or missing marker before dispatch', async () => {
  const { adapter, requests } = harness(async () => Response.json({
    ok: true,
    channel: channelId,
    ts: threadTs,
  }));

  await assert.rejects(() => adapter.readApprovalThread(
    'C-WRONG',
    threadTs,
    readContext('slack.readApprovalThread'),
  ), /invalid/);
  await assert.rejects(() => adapter.postReview(
    { channelId, threadTs: null, body: 'review without binding' },
    coordinationContext('slack.postReview'),
  ), /invalid/);
  assert.equal(requests.length, 0);
});