import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  createGitHubAdapter,
  githubCommentMarker,
} from '../../dist/server/adapters/github.js';
import { createBoundedRestTransport } from '../../dist/server/adapters/common/transport.js';

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
    app: 'github',
    accountRef: 'github-smoke',
    mode: 'rest',
    operation,
    logicalCallId: `smoke-call-${suffix}`,
    providerAttemptId: `smoke-provider-${suffix}`,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    budgets: {
      timeoutMs: 10_000,
      totalMs: 60_000,
      maxAttempts: effectKey ? 1 : 2,
      maxPages: 20,
      maxRecords: 2000,
      maxResponseBytes: 5_000_000,
    },
  };
  if (!effectKey) return context;
  const requestDigest = sha256(Buffer.from(`${operation}:${effectKey}`));
  return {
    ...context,
    effectKey,
    requestDigest,
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

export async function runGitHubSmoke(environment = process.env) {
  if (environment.PG_GITHUB_SMOKE_MUTATIONS !== 'enabled') {
    return { schemaVersion: 1, provider: 'github', status: 'unrun', reason: 'mutation_confirmation_required' };
  }
  const token = requiredEnvironment(environment, 'PG_GITHUB_TOKEN');
  const repository = requiredEnvironment(environment, 'PG_GITHUB_REPOSITORY');
  const incidentUrl = requiredEnvironment(environment, 'PG_GITHUB_INCIDENT_URL');
  const transport = createBoundedRestTransport({
    fetch: globalThis.fetch,
    createProviderAttemptId: () => `smoke-provider-${randomUUID()}`,
    createSpanId: () => `smoke-span-${randomUUID()}`,
    storeResponse: input => artifact('github-response', input.bytes),
    storeReceipt: receipt => artifact('github-receipt', Buffer.from(JSON.stringify(receipt))),
    observer: { onDispatch: () => {}, onResult: () => {}, onRetry: () => {} },
  });
  const adapter = createGitHubAdapter({
    scope: { app: 'github', accountRef: 'github-smoke' },
    repository,
    token,
    transport,
  });
  const incident = requireComplete(await adapter.resolveIncident(
    incidentUrl,
    callContext('github.resolveIncident'),
  ), 'resolve');
  requireComplete(await adapter.readTechnicalEvidence(
    incident,
    callContext('github.readTechnicalEvidence'),
  ), 'source_read');

  const effectKey = `github-smoke-${randomUUID()}`;
  const marker = githubCommentMarker(effectKey);
  const initialBody = `PromiseGuard disposable adapter smoke.\n${marker}`;
  const input = { repositoryId: incident.repositoryId, issueId: incident.issueId, body: initialBody };
  const commentId = requireApplied(await adapter.createComment(
    input,
    callContext('github.createComment', effectKey),
  ), 'create');
  const created = requireComplete(await adapter.getComment(
    commentId,
    callContext('github.getComment'),
  ), 'create_readback');
  if (!created || created.body !== initialBody) throw new Error('create_readback_mismatch');

  const updatedBody = `PromiseGuard disposable adapter smoke updated.\n${marker}`;
  requireApplied(await adapter.updateComment(
    commentId,
    { ...input, body: updatedBody },
    callContext('github.updateComment', effectKey),
  ), 'update');
  const matches = requireComplete(await adapter.findComments(
    incident,
    marker,
    callContext('github.findComments'),
  ), 'find');
  const updated = matches.filter(candidate => candidate.id === commentId && candidate.body === updatedBody);
  if (updated.length !== 1 || matches.length !== 1) throw new Error('marker_reconciliation_mismatch');

  return {
    schemaVersion: 1,
    provider: 'github',
    status: 'passed',
    reason: null,
    repositoryId: incident.repositoryId,
    issueId: incident.issueId,
    commentId,
    markerCandidateCount: matches.length,
  };
}

async function main() {
  const report = await runGitHubSmoke();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'github_smoke_failed'}\n`);
    process.exitCode = 1;
  });
}