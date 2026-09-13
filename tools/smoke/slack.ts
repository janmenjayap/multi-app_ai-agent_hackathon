import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { createSlackAdapter } from '../../dist/server/adapters/slack.js';
import { createBoundedRestTransport } from '../../dist/server/adapters/common/transport.js';

const REQUIRED_ENVIRONMENT = [
  'PG_SLACK_BOT_TOKEN',
  'PG_SLACK_READER_TOKEN',
  'PG_SLACK_TEAM_ID',
  'PG_SLACK_CHANNEL_ID',
  'PG_SLACK_APPROVER_IDS',
] as const;
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function artifact(bytes: Uint8Array, prefix: string) {
  return {
    artifactId: `${prefix}-${randomUUID()}`,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    mediaType: 'application/json' as const,
  };
}

function positiveArgument(argv: string[], name: string, fallback: number): number {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error('invalid_smoke_arguments');
  return value;
}

function parseArguments(argv: string[]) {
  const waitSeconds = positiveArgument(argv, '--wait-seconds', 300);
  const pollSeconds = positiveArgument(argv, '--poll-seconds', 60);
  if (waitSeconds > 1800 || pollSeconds < 60 || pollSeconds > waitSeconds) {
    throw new Error('invalid_smoke_arguments');
  }
  return { waitSeconds, pollSeconds };
}

function environment() {
  const missing = REQUIRED_ENVIRONMENT.filter(name => !process.env[name]);
  if (missing.length > 0) return { status: 'unrun' as const, missing };
  const approverIds = process.env.PG_SLACK_APPROVER_IDS!.split(',').filter(Boolean);
  if (approverIds.length === 0 || approverIds.some(id => !/^[UW][A-Z0-9]+$/.test(id))) {
    throw new Error('invalid_slack_approvers');
  }
  return {
    status: 'ready' as const,
    botToken: process.env.PG_SLACK_BOT_TOKEN!,
    readerToken: process.env.PG_SLACK_READER_TOKEN!,
    workspaceId: process.env.PG_SLACK_TEAM_ID!,
    channelId: process.env.PG_SLACK_CHANNEL_ID!,
    approverIds: new Set(approverIds),
  };
}

async function authenticatedWorkspace(token: string): Promise<string> {
  const response = await fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUTH_RESPONSE_BYTES) {
    throw new Error('slack_auth_response_too_large');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_AUTH_RESPONSE_BYTES) throw new Error('slack_auth_response_too_large');
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('slack_auth_malformed_response');
  }
  const value = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  if (!response.ok || value?.ok !== true || typeof value.team_id !== 'string') {
    throw new Error('slack_auth_failed');
  }
  return value.team_id;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const configuration = environment();
  if (configuration.status === 'unrun') {
    process.stdout.write(`${JSON.stringify({
      provider: 'slack',
      status: 'unrun',
      reason: `missing_configuration:${configuration.missing.join(',')}`,
    })}\n`);
    return;
  }
  const { waitSeconds, pollSeconds } = parseArguments(process.argv.slice(2));
  const [writerWorkspace, readerWorkspace] = await Promise.all([
    authenticatedWorkspace(configuration.botToken),
    authenticatedWorkspace(configuration.readerToken),
  ]);
  if (writerWorkspace !== configuration.workspaceId || readerWorkspace !== configuration.workspaceId) {
    throw new Error('slack_workspace_mismatch');
  }

  let sequence = 0;
  const receipts = [];
  const transport = createBoundedRestTransport({
    fetch,
    createProviderAttemptId: () => `slack-provider-${randomUUID()}`,
    createSpanId: () => `slack-span-${randomUUID()}`,
    storeResponse: input => artifact(input.bytes, 'slack-response'),
    storeReceipt: receipt => {
      receipts.push(receipt);
      return artifact(new TextEncoder().encode(JSON.stringify(receipt)), 'slack-receipt');
    },
    observer: { onDispatch: () => {}, onResult: () => {}, onRetry: () => {} },
  });
  const adapter = createSlackAdapter({
    scope: { app: 'slack', accountRef: configuration.workspaceId },
    workspaceId: configuration.workspaceId,
    channelId: configuration.channelId,
    readerToken: configuration.readerToken,
    writerToken: configuration.botToken,
    transport,
  });
  const runId = `slack-smoke-${randomUUID()}`;
  const evaluationAttemptId = `slack-evaluation-${randomUUID()}`;
  const runtimeAttemptId = `slack-runtime-${randomUUID()}`;
  const marker = `promiseguard-slack-smoke-${randomUUID()}`;

  function context(operation: string) {
    sequence += 1;
    return {
      schemaVersion: 2,
      runId,
      evaluationAttemptId,
      runtimeAttemptId,
      spanId: `slack-span-${randomUUID()}`,
      app: 'slack',
      accountRef: configuration.workspaceId,
      mode: 'rest',
      operation,
      logicalCallId: `slack-call-${sequence}-${randomUUID()}`,
      providerAttemptId: `slack-provider-${randomUUID()}`,
      deadlineAt: new Date(Date.now() + 120000).toISOString(),
      budgets: {
        timeoutMs: 15000,
        totalMs: 120000,
        maxAttempts: operation.startsWith('slack.read') || operation === 'slack.findReview' ? 2 : 1,
        maxPages: 10,
        maxRecords: 1000,
        maxResponseBytes: 2_000_000,
      },
    };
  }

  function coordinationContext(operation: string, body: string) {
    return {
      ...context(operation),
      marker,
      requestDigest: sha256(body),
    };
  }

  const reviewBody = [
    'PromiseGuard disposable Slack adapter smoke.',
    `Marker: ${marker}`,
    'Reply in this thread from a configured human approver to continue.',
  ].join('\n');
  const posted = await adapter.postReview(
    { channelId: configuration.channelId, threadTs: null, body: reviewBody },
    coordinationContext('slack.postReview', reviewBody),
  );
  if (posted.status !== 'applied') throw new Error('slack_review_post_failed');

  const found = await adapter.findReview(marker, context('slack.findReview'));
  if (found.status !== 'complete' || found.data.length !== 1 ||
      found.data[0].messageTs !== posted.providerId || found.data[0].body !== reviewBody) {
    throw new Error('slack_review_readback_failed');
  }

  process.stdout.write('Slack smoke thread posted; add one reply from a configured human approver.\n');
  const waitDeadline = Date.now() + waitSeconds * 1000;
  let humanReplyObserved = false;
  while (Date.now() <= waitDeadline) {
    const thread = await adapter.readApprovalThread(
      configuration.channelId,
      posted.providerId,
      context('slack.readApprovalThread'),
    );
    if (thread.status !== 'complete') throw new Error('slack_thread_read_incomplete');
    humanReplyObserved = thread.data.some(message =>
      message.messageTs !== posted.providerId &&
      !message.isBot &&
      !message.deleted &&
      configuration.approverIds.has(message.actorId));
    if (humanReplyObserved) break;
    if (Date.now() + pollSeconds * 1000 > waitDeadline) break;
    await sleep(pollSeconds * 1000);
  }
  if (!humanReplyObserved) throw new Error('slack_human_reply_not_observed');

  const updatedBody = [
    'PromiseGuard disposable Slack adapter smoke updated after reply retrieval.',
    `Marker: ${marker}`,
  ].join('\n');
  const updated = await adapter.updateReview(
    posted.providerId,
    { channelId: configuration.channelId, threadTs: null, body: updatedBody },
    coordinationContext('slack.updateReview', updatedBody),
  );
  if (updated.status !== 'applied' || updated.providerId !== posted.providerId) {
    throw new Error('slack_review_update_failed');
  }
  const readback = await adapter.getMessage(
    configuration.channelId,
    posted.providerId,
    context('slack.getMessage'),
  );
  if (readback.status !== 'complete' || readback.data?.body !== updatedBody) {
    throw new Error('slack_update_readback_failed');
  }

  process.stdout.write(`${JSON.stringify({
    provider: 'slack',
    status: 'passed',
    checks: {
      writerWorkspaceAuthenticated: true,
      readerWorkspaceAuthenticated: true,
      reviewPosted: true,
      reviewFoundIndependently: true,
      allowedHumanReplyObserved: true,
      reviewUpdated: true,
      updateReadBackIndependently: true,
      terminalReceiptsRecorded: receipts.length > 0,
    },
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('slack_smoke_failed\n');
    process.exitCode = 1;
  });
}