import assert from 'node:assert/strict';
import test from 'node:test';

import { createGitHubAdapter, GITHUB_API_VERSION } from '../../dist/server/adapters/github.js';
import { createBoundedRestTransport } from '../../dist/server/adapters/common/transport.js';

const digest = 'a'.repeat(64);
const observedAt = '2026-09-14T10:00:00.000Z';
const repository = {
  id: 10,
  full_name: 'acme/promiseguard',
};
const issue = {
  id: 20,
  number: 7,
  html_url: 'https://github.com/acme/promiseguard/issues/7',
  repository_url: 'https://api.github.com/repos/acme/promiseguard',
  title: 'Billing incident',
  body: 'service_id: billing\nenvironment: production\ncandidate_deployment: demo-sha',
  state: 'open',
  updated_at: observedAt,
  labels: [],
};

function artifact(id, byteLength = 2) {
  return { artifactId: id, sha256: digest, byteLength, mediaType: 'application/json' };
}

function comment(id, body, issueUrl = 'https://api.github.com/repos/acme/promiseguard/issues/7') {
  return {
    id,
    issue_url: issueUrl,
    body,
    updated_at: observedAt,
    user: { id: 30 },
  };
}

function readContext(operation, suffix) {
  return {
    schemaVersion: 2,
    runId: 'run-1',
    evaluationAttemptId: 'evaluation-1',
    runtimeAttemptId: 'runtime-1',
    spanId: `span-${suffix}`,
    app: 'github',
    accountRef: 'account-github',
    mode: 'rest',
    operation,
    logicalCallId: `call-${suffix}`,
    providerAttemptId: `provider-${suffix}`,
    deadlineAt: '2026-09-14T10:01:00.000Z',
    budgets: {
      timeoutMs: 1000,
      totalMs: 10000,
      maxAttempts: 1,
      maxPages: 10,
      maxRecords: 1000,
      maxResponseBytes: 100000,
    },
  };
}

function mutationContext(operation, suffix) {
  return {
    ...readContext(operation, suffix),
    effectKey: 'effect-comment',
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
    adapter: createGitHubAdapter({
      scope: { app: 'github', accountRef: 'account-github' },
      repository: 'acme/promiseguard',
      token: 'test-token',
      transport,
    }),
    requests,
  };
}

async function resolveFixture(adapter, suffix = 'resolve') {
  return adapter.resolveIncident(
    'https://github.com/acme/promiseguard/issues/7',
    readContext('github.resolveIncident', suffix),
  );
}

test('rejects an incident outside the configured repository without dispatch', async () => {
  const { adapter, requests } = harness(async () => {
    throw new Error('unexpected dispatch');
  });

  const result = await adapter.resolveIncident(
    'https://github.com/other/repository/issues/7',
    readContext('github.resolveIncident', 'wrong-scope'),
  );

  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'scope_mismatch');
  assert.equal(requests.length, 0);
});

test('enumerates every page and returns all exact-marker candidates', async () => {
  const marker = '<!-- promiseguard:effect-comment -->';
  const { adapter, requests } = harness(async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/repos/acme/promiseguard' && !parsed.pathname.endsWith('/issues/7')) {
      return Response.json(repository);
    }
    if (parsed.pathname === '/repos/acme/promiseguard/issues/7' && !parsed.pathname.endsWith('/comments')) {
      return Response.json(issue);
    }
    if (parsed.searchParams.get('page') === '1') {
      return Response.json([
        comment(101, `${marker}\nfirst`),
        comment(102, 'unrelated comment'),
      ], {
        headers: {
          link: '<https://api.github.com/repos/acme/promiseguard/issues/7/comments?per_page=100&page=2>; rel="next"',
        },
      });
    }
    return Response.json([comment(103, `${marker}\nsecond`)]);
  });
  const resolved = await resolveFixture(adapter);
  assert.equal(resolved.status, 'complete');

  const result = await adapter.findComments(
    resolved.data,
    marker,
    readContext('github.findComments', 'find'),
  );

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.data.map(candidate => candidate.id), ['101', '103']);
  assert.equal(result.receipt.pages.length, 2);
  assert.equal(requests.at(-1).init.headers['X-GitHub-Api-Version'], GITHUB_API_VERSION);
  assert.equal(requests.at(-1).init.headers.Authorization, 'Bearer test-token');
});

test('preserves first-page candidates when a later page fails', async () => {
  const marker = '<!-- promiseguard:effect-comment -->';
  const { adapter } = harness(async url => {
    const parsed = new URL(url);
    if (parsed.pathname === '/repos/acme/promiseguard') return Response.json(repository);
    if (parsed.pathname === '/repos/acme/promiseguard/issues/7') return Response.json(issue);
    if (parsed.searchParams.get('page') === '1') {
      return Response.json([comment(101, marker)], {
        headers: {
          link: '<https://api.github.com/repos/acme/promiseguard/issues/7/comments?per_page=100&page=2>; rel="next"',
        },
      });
    }
    return Response.json({ message: 'temporary failure' }, { status: 500 });
  });
  const resolved = await resolveFixture(adapter, 'resolve-partial');
  assert.equal(resolved.status, 'complete');

  const result = await adapter.findComments(
    resolved.data,
    marker,
    readContext('github.findComments', 'find-partial'),
  );

  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'page_failed');
  assert.deepEqual(result.partialData.map(candidate => candidate.id), ['101']);
  assert.equal(result.receipt.pages.length, 1);
});

test('returns unknown and does not retry an uncertain comment create', async () => {
  let createCalls = 0;
  const { adapter } = harness(async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/repos/acme/promiseguard') return Response.json(repository);
    if (parsed.pathname === '/repos/acme/promiseguard/issues/7' && init.method === 'GET') return Response.json(issue);
    createCalls += 1;
    throw new TypeError('redacted network failure');
  });
  const resolved = await resolveFixture(adapter, 'resolve-unknown');
  assert.equal(resolved.status, 'complete');

  await assert.rejects(() => adapter.createComment({
    repositoryId: resolved.data.repositoryId,
    issueId: resolved.data.issueId,
    body: 'Engineering impact unknown.\r\n<!-- promiseguard:effect-comment -->',
  }, mutationContext('github.createComment', 'create-not-normalized')), /invalid/);
  assert.equal(createCalls, 0);

  const result = await adapter.createComment({
    repositoryId: resolved.data.repositoryId,
    issueId: resolved.data.issueId,
    body: 'Engineering impact unknown.\n<!-- promiseguard:effect-comment -->',
  }, mutationContext('github.createComment', 'create-unknown'));

  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'transport_error');
  assert.equal(createCalls, 1);
});

test('keeps a denied independent read separate from successful creation', async () => {
  const body = 'Engineering impact unknown.\n<!-- promiseguard:effect-comment -->';
  const { adapter } = harness(async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/repos/acme/promiseguard') return Response.json(repository);
    if (parsed.pathname === '/repos/acme/promiseguard/issues/7' && init.method === 'GET') return Response.json(issue);
    if (init.method === 'POST') return Response.json(comment(201, body), { status: 201 });
    return Response.json({ message: 'forbidden' }, { status: 403 });
  });
  const resolved = await resolveFixture(adapter, 'resolve-denied');
  assert.equal(resolved.status, 'complete');
  const created = await adapter.createComment({
    repositoryId: resolved.data.repositoryId,
    issueId: resolved.data.issueId,
    body,
  }, mutationContext('github.createComment', 'create-denied'));
  assert.equal(created.status, 'applied');

  const readback = await adapter.getComment(
    created.providerId,
    readContext('github.getComment', 'read-denied'),
  );

  assert.equal(readback.status, 'incomplete');
  assert.equal(readback.reason, 'denied');
});

test('reads a comment independently without a prior incident resolve', async () => {
  const { adapter } = harness(async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/issues/comments/201')) {
      return Response.json(comment(201, 'independent readback'));
    }
    if (parsed.pathname.endsWith('/issues/7')) return Response.json(issue);
    return Response.json(repository);
  });

  const result = await adapter.getComment('201', readContext('github.getComment', 'independent-read'));

  assert.equal(result.status, 'complete');
  assert.equal(result.data.id, '201');
  assert.equal(result.data.repositoryId, '10');
  assert.equal(result.data.issueId, '20');
  assert.equal(result.receipt.pages.length, 3);
});

test('updates only the resolved marked comment with exact approved bytes', async () => {
  const body = 'Updated impact remains uncertain.\n<!-- promiseguard:effect-comment -->';
  let patchRequest;
  const { adapter } = harness(async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/repos/acme/promiseguard') return Response.json(repository);
    if (parsed.pathname === '/repos/acme/promiseguard/issues/7') return Response.json(issue);
    patchRequest = { url, init };
    return Response.json(comment(201, body));
  });
  const resolved = await resolveFixture(adapter, 'resolve-update');
  assert.equal(resolved.status, 'complete');

  const result = await adapter.updateComment('201', {
    repositoryId: resolved.data.repositoryId,
    issueId: resolved.data.issueId,
    body,
  }, mutationContext('github.updateComment', 'update'));

  assert.equal(result.status, 'applied');
  assert.equal(result.providerId, '201');
  assert.equal(patchRequest.init.method, 'PATCH');
  assert.equal(new URL(patchRequest.url).pathname, '/repos/acme/promiseguard/issues/comments/201');
  assert.deepEqual(JSON.parse(patchRequest.init.body), { body });
});