import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { createBoundedRestTransport } from '../../dist/server/adapters/common/transport.js';
import { createGmailAdapter } from '../../dist/server/adapters/gmail.js';
import {
  encodeGmailRawMessage,
  parseGmailRawMessage,
} from '../../dist/server/adapters/gmail-mime.js';

const digest = 'a'.repeat(64);
const observedAt = '2026-09-14T10:00:00.000Z';

function artifact(id, byteLength = 2) {
  return { artifactId: id, sha256: digest, byteLength, mediaType: 'application/json' };
}

function rawDraft(id, mime, labelIds = ['DRAFT']) {
  return {
    id,
    message: {
      id: `message-${id}`,
      labelIds,
      historyId: `history-${id}`,
      raw: Buffer.from(mime, 'utf8').toString('base64url'),
    },
  };
}

function markedDraft(id, marker, overrides = {}) {
  const raw = encodeGmailRawMessage({
    to: 'primary@example.invalid',
    cc: [],
    bcc: [],
    subject: 'PromiseGuard update',
    body: 'Approved body.\nSecond line.',
    effectMarker: marker,
    ...overrides,
  });
  return {
    id,
    message: {
      id: `message-${id}`,
      labelIds: ['DRAFT'],
      historyId: `history-${id}`,
      raw,
    },
  };
}

function readContext(operation, suffix, budgetOverrides = {}) {
  return {
    schemaVersion: 2,
    runId: 'run-1',
    evaluationAttemptId: 'evaluation-1',
    runtimeAttemptId: 'runtime-1',
    spanId: `span-${suffix}`,
    app: 'gmail',
    accountRef: 'account-gmail',
    mode: 'rest',
    operation,
    logicalCallId: `call-${suffix}`,
    providerAttemptId: `provider-${suffix}`,
    deadlineAt: '2026-09-14T10:01:00.000Z',
    budgets: {
      timeoutMs: 1000,
      totalMs: 10000,
      maxAttempts: 1,
      maxPages: 20,
      maxRecords: 1000,
      maxResponseBytes: 100000,
      ...budgetOverrides,
    },
  };
}

function mutationContext(suffix, effectKey = 'effect-draft') {
  return {
    ...readContext('gmail.createDraft', suffix),
    effectKey,
    requestDigest: digest,
    planHash: digest,
    approvalRef: 'approval-1',
  };
}

function harness(fetchImplementation) {
  let nextAttempt = 1;
  let storedResponse = 1;
  let storedReceipt = 1;
  const requests = [];
  const transport = createBoundedRestTransport({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return fetchImplementation(url, init);
    },
    clock: {
      wallNowMs: () => Date.parse(observedAt),
      monotonicNowMs: () => 100,
      sleep: async () => {},
    },
    createProviderAttemptId: () => `generated-provider-${nextAttempt++}`,
    createSpanId: () => `generated-span-${nextAttempt}`,
    storeResponse: input => artifact(`response-${storedResponse++}`, input.bytes.byteLength),
    storeReceipt: () => artifact(`receipt-${storedReceipt++}`),
    observer: { onDispatch: () => {}, onResult: () => {}, onRetry: () => {} },
  });
  return {
    adapter: createGmailAdapter({
      scope: { app: 'gmail', accountRef: 'account-gmail' },
      accessToken: 'test-token',
      transport,
    }),
    requests,
  };
}

test('preserves repeated and folded recipients while decoding multipart text', () => {
  const body = Buffer.from('Approved body.\r\nSecond line.', 'utf8').toString('base64');
  const mime = [
    'To: Primary <primary@example.invalid>,',
    ' secondary@example.invalid',
    'To: duplicate@example.invalid',
    'Cc: copied@example.invalid',
    'Bcc: hidden@example.invalid',
    'Bcc: second-hidden@example.invalid',
    'Subject: =?UTF-8?B?UHJvbWlzZUd1YXJkIOKckw==?=',
    'X-PromiseGuard-Effect-Key: effect-draft',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="promiseguard-boundary"',
    '',
    '--promiseguard-boundary',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
    '--promiseguard-boundary',
    'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename="evidence.bin"',
    '',
    'ignored',
    '--promiseguard-boundary--',
  ].join('\r\n');

  const parsed = parseGmailRawMessage(Buffer.from(mime, 'utf8').toString('base64url'));

  assert.deepEqual(parsed.to, [
    'primary@example.invalid',
    'secondary@example.invalid',
    'duplicate@example.invalid',
  ]);
  assert.deepEqual(parsed.cc, ['copied@example.invalid']);
  assert.deepEqual(parsed.bcc, ['hidden@example.invalid', 'second-hidden@example.invalid']);
  assert.equal(parsed.subject, 'PromiseGuard ✓');
  assert.equal(parsed.body, 'Approved body.\nSecond line.');
  assert.deepEqual(parsed.effectMarkers, ['effect-draft']);
});

test('enumerates every page and fully reads every exact-marker candidate', async () => {
  const marker = 'effect-draft';
  const drafts = {
    'draft-1': markedDraft('draft-1', marker),
    'draft-2': markedDraft('draft-2', 'different-effect'),
    'draft-3': markedDraft('draft-3', marker, {
      cc: ['unexpected-cc@example.invalid'],
      bcc: ['unexpected-bcc@example.invalid'],
    }),
  };
  drafts['draft-3'].message.labelIds = ['SENT'];
  const { adapter, requests } = harness(async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/drafts') && !parsed.searchParams.has('pageToken')) {
      return Response.json({ drafts: [{ id: 'draft-1' }], nextPageToken: 'page-2' });
    }
    if (parsed.pathname.endsWith('/drafts')) {
      return Response.json({ drafts: [{ id: 'draft-2' }, { id: 'draft-3' }] });
    }
    const id = parsed.pathname.split('/').at(-1);
    return Response.json(drafts[id]);
  });

  const result = await adapter.findDrafts(
    marker,
    readContext('gmail.findDrafts', 'find'),
  );

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.data.map(draft => draft.draftId), ['draft-1', 'draft-3']);
  assert.deepEqual(result.data[1].cc, ['unexpected-cc@example.invalid']);
  assert.deepEqual(result.data[1].bcc, ['unexpected-bcc@example.invalid']);
  assert.equal(result.data[1].isDraft, false);
  assert.equal(result.receipt.pages.length, 5);
  assert.equal(requests.filter(request => new URL(request.url).pathname.includes('/drafts/')).length, 3);
  assert.equal(requests.some(request => new URL(request.url).searchParams.has('q')), false);
});

test('keeps fully read first-page drafts when a later list page fails', async () => {
  const marker = 'effect-draft';
  const { adapter } = harness(async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/drafts') && !parsed.searchParams.has('pageToken')) {
      return Response.json({ drafts: [{ id: 'draft-1' }], nextPageToken: 'page-2' });
    }
    if (parsed.pathname.endsWith('/drafts')) {
      return Response.json({ error: { code: 503 } }, { status: 503 });
    }
    return Response.json(markedDraft('draft-1', marker));
  });

  const result = await adapter.findDrafts(
    marker,
    readContext('gmail.findDrafts', 'partial'),
  );

  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'page_failed');
  assert.deepEqual(result.partialData.map(draft => draft.draftId), ['draft-1']);
});

test('creates exact draft MIME and never exposes send, update, or delete', async () => {
  let postedMime;
  const { adapter, requests } = harness(async (_url, init) => {
    postedMime = parseGmailRawMessage(JSON.parse(init.body).message.raw);
    return Response.json({ id: 'draft-created', message: { id: 'message-created' } }, { status: 201 });
  });

  const result = await adapter.createDraft({
    to: 'recipient@example.invalid',
    cc: [],
    bcc: [],
    subject: 'Approved update ✓',
    body: 'Approved body.\nSecond line.',
    isDraft: true,
  }, mutationContext('create'));

  assert.equal(result.status, 'applied');
  assert.equal(result.providerId, 'draft-created');
  assert.deepEqual(postedMime, {
    to: ['recipient@example.invalid'],
    cc: [],
    bcc: [],
    subject: 'Approved update ✓',
    body: 'Approved body.\nSecond line.',
    effectMarkers: ['effect-draft'],
  });
  assert.equal(new URL(requests[0].url).pathname, '/gmail/v1/users/me/drafts');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal('send' in adapter, false);
  assert.equal('updateDraft' in adapter, false);
  assert.equal('deleteDraft' in adapter, false);
});

test('does not retry an uncertain draft create', async () => {
  let calls = 0;
  const { adapter } = harness(async () => {
    calls += 1;
    throw new TypeError('redacted network failure');
  });

  const result = await adapter.createDraft({
    to: 'recipient@example.invalid',
    cc: [],
    bcc: [],
    subject: 'Approved update',
    body: 'Approved body.',
    isDraft: true,
  }, mutationContext('unknown'));

  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'transport_error');
  assert.equal(calls, 1);
});

test('reports missing draft state as an incomplete read', async () => {
  const response = rawDraft('draft-1', [
    'To: recipient@example.invalid',
    'Subject: Approved update',
    'X-PromiseGuard-Effect-Key: effect-draft',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Approved body.',
  ].join('\r\n'));
  delete response.message.labelIds;
  const { adapter } = harness(async () => Response.json(response));

  const result = await adapter.getDraft(
    'draft-1',
    readContext('gmail.getDraft', 'missing-state'),
  );

  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'malformed_response');
});