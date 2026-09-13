import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';

import { createBoundedRestTransport } from '../../dist/server/adapters/common/transport.js';
import { createGmailAdapter } from '../../dist/server/adapters/gmail.js';

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function artifact(prefix, bytes) {
  return {
    artifactId: `${prefix}-${randomUUID()}`,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    mediaType: 'application/json',
  };
}

function callContext(operation, effectKey) {
  const suffix = randomUUID();
  const context = {
    schemaVersion: 2,
    runId: `smoke-run-${suffix}`,
    evaluationAttemptId: `smoke-evaluation-${suffix}`,
    runtimeAttemptId: `smoke-runtime-${suffix}`,
    spanId: `smoke-span-${suffix}`,
    app: 'gmail',
    accountRef: 'gmail-smoke',
    mode: 'rest',
    operation,
    logicalCallId: `smoke-call-${suffix}`,
    providerAttemptId: `smoke-provider-${suffix}`,
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    budgets: {
      timeoutMs: 15_000,
      totalMs: 120_000,
      maxAttempts: effectKey ? 1 : 2,
      maxPages: 100,
      maxRecords: 10_000,
      maxResponseBytes: 20_000_000,
    },
  };
  if (!effectKey) return context;
  return {
    ...context,
    effectKey,
    requestDigest: sha256(Buffer.from(`${operation}:${effectKey}`)),
    planHash: sha256(Buffer.from(`smoke-plan:${effectKey}`)),
    approvalRef: `smoke-approval-${suffix}`,
  };
}

function requireComplete(result, stage) {
  if (result.status !== 'complete') throw new Error(`${stage}_${result.reason}`);
  return result.data;
}

function requireApplied(result, stage) {
  if (result.status !== 'applied') throw new Error(`${stage}_${result.status}`);
  return result.providerId;
}

async function refreshAccessToken(environment) {
  const response = await globalThis.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requiredEnvironment(environment, 'PG_GMAIL_CLIENT_ID'),
      client_secret: requiredEnvironment(environment, 'PG_GMAIL_CLIENT_SECRET'),
      refresh_token: requiredEnvironment(environment, 'PG_GMAIL_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) throw new Error('gmail_oauth_refresh_failed');
  const body = await response.json();
  if (!body || typeof body.access_token !== 'string' || body.access_token.trim().length === 0) {
    throw new Error('gmail_oauth_response_invalid');
  }
  return body.access_token;
}

async function verifyMailbox(accessToken, expectedMailbox) {
  const response = await globalThis.fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error('gmail_profile_read_failed');
  const body = await response.json();
  if (!body || typeof body.emailAddress !== 'string' ||
      body.emailAddress.toLowerCase() !== expectedMailbox.toLowerCase()) {
    throw new Error('gmail_mailbox_identity_mismatch');
  }
}

export async function runGmailSmoke(environment = process.env) {
  if (environment.PG_GMAIL_SMOKE_MUTATIONS !== 'enabled') {
    return { schemaVersion: 1, provider: 'gmail', status: 'unrun', reason: 'mutation_confirmation_required' };
  }
  const mailbox = requiredEnvironment(environment, 'PG_GMAIL_MAILBOX');
  const accessToken = await refreshAccessToken(environment);
  await verifyMailbox(accessToken, mailbox);

  const transport = createBoundedRestTransport({
    fetch: globalThis.fetch,
    createProviderAttemptId: () => `smoke-provider-${randomUUID()}`,
    createSpanId: () => `smoke-span-${randomUUID()}`,
    storeResponse: input => artifact('gmail-response', input.bytes),
    storeReceipt: receipt => artifact('gmail-receipt', Buffer.from(JSON.stringify(receipt))),
    observer: { onDispatch: () => {}, onResult: () => {}, onRetry: () => {} },
  });
  const adapter = createGmailAdapter({
    scope: { app: 'gmail', accountRef: 'gmail-smoke' },
    accessToken,
    transport,
  });
  const effectKey = `gmail-smoke-${randomUUID()}`;
  const subject = `PromiseGuard disposable smoke ${effectKey}`;
  const draftInput = {
    to: mailbox,
    cc: [],
    bcc: [],
    subject,
    body: `PromiseGuard disposable Gmail adapter smoke.\n${effectKey}`,
    isDraft: true,
  };
  const draftId = requireApplied(await adapter.createDraft(
    draftInput,
    callContext('gmail.createDraft', effectKey),
  ), 'create');
  const readback = requireComplete(await adapter.getDraft(
    draftId,
    callContext('gmail.getDraft'),
  ), 'readback');
  if (!readback || readback.draftId !== draftId || readback.messageId.length === 0 ||
      readback.to.length !== 1 || readback.to[0].toLowerCase() !== mailbox.toLowerCase() ||
      readback.cc.length !== 0 || readback.bcc.length !== 0 || readback.subject !== subject ||
      readback.body !== draftInput.body || !readback.isDraft) {
    throw new Error('gmail_full_readback_mismatch');
  }
  const matches = requireComplete(await adapter.findDrafts(
    effectKey,
    callContext('gmail.findDrafts'),
  ), 'find');
  if (matches.length !== 1 || matches[0].draftId !== draftId) {
    throw new Error('gmail_marker_reconciliation_mismatch');
  }

  return {
    schemaVersion: 1,
    provider: 'gmail',
    status: 'passed',
    reason: null,
    draftId,
    messageId: readback.messageId,
    markerCandidateCount: matches.length,
    mailboxIdentityMatched: true,
  };
}

async function main() {
  const report = await runGmailSmoke();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'gmail_smoke_failed'}\n`);
    process.exitCode = 1;
  });
}