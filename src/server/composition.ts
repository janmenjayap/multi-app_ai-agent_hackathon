import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { AppConfig } from './index.js';
import { createModelClient, type ModelClient } from './agents/model.js';
import { ApplicationDatabase } from './storage/database.js';
import { ApplicationRepository, type ApplicationWriter } from './storage/repositories.js';
import { WorkflowCheckpoints } from './storage/checkpoints.js';
import { WorkflowDriver, type WorkflowDriverOptions, type WorkflowNodeContext } from './workflow/driver.js';
import { createBoundedRestTransport, type TransportObserver } from './adapters/common/transport.js';
import { createGitHubAdapter } from './adapters/github.js';
import { createHubSpotAdapter, type HubSpotMapping } from './adapters/hubspot.js';
import { createGmailAdapter } from './adapters/gmail.js';
import { createSlackAdapter } from './adapters/slack.js';
import { registerRunRoutes, type RunApiOptions } from './api/runs.js';
import { registerHealthRoutes } from './api/health.js';
import type { ApiAuthOptions } from './api/auth.js';
import { createEvidenceCollector } from './evaluations/collector.js';
import type { ProviderReaderSet } from './evaluations/provider-readers.js';
import { processApplicationJobs, type ApplicationMonitorOptions } from './monitoring/worker.js';
import { ApplicationAssessmentSchema } from './monitoring/assess.js';
import type { EventContext } from './observability/events.js';
import { encodeRestrictedArtifact } from './observability/redaction.js';
import { ProviderAttemptReceiptSchema, READ_OPERATIONS, type AdapterCallContext, type GitHubAdapter,
  type HubSpotAdapter, type GmailAdapter, type SlackAdapter, type ProviderAttemptReceipt } from '../shared/adapters.js';
import { EffectKeySchema, ExecutionModeSchema, ProviderAttemptIdSchema, RestrictedArtifactRefSchema, canonical, type MutationOutcome,
  type ReadResult, type RestrictedArtifactRef } from '../shared/domain.js';
import { assessmentDisplayState, type AssessmentSummaryView } from '../shared/api.js';
import { digest } from '../shared/reliability.js';

export interface CompositionProviders {
  adapters: { github: GitHubAdapter; hubspot: HubSpotAdapter; gmail: GmailAdapter; slack: SlackAdapter };
  readers: ProviderReaderSet;
  /** Synthetic fixtures retain their actual independent read bytes here. */
  readArtifact?: (artifactId: string) => string | null;
}

export interface CompositionServices {
  config: AppConfig;
  repository: ApplicationRepository;
  checkpoints: WorkflowCheckpoints;
  model: ModelClient;
  providers: CompositionProviders;
  clock: () => number;
  withExecutionObserver<T>(observer: TransportObserver, action: () => Promise<T>): Promise<T>;
  createCollector(node: WorkflowNodeContext): ReturnType<typeof createEvidenceCollector>;
}

export interface CompositionOptions {
  providers?: CompositionProviders;
  modelClient?: ModelClient;
  buildWorkflow(services: CompositionServices): Omit<WorkflowDriverOptions, 'repository' | 'checkpoints' | 'configuration'>;
  monitor?: ApplicationMonitorOptions | ((services: CompositionServices) => ApplicationMonitorOptions);
  auth?: ApiAuthOptions;
  clock?: () => number;
  fetch?: typeof globalThis.fetch;
  hubspotMapping?: HubSpotMapping;
  webRoot?: string;
}

/** One ledger and one B04 driver. Clients and authorization never enter graph state. */
export async function createComposition(config: AppConfig, options: CompositionOptions) {
  for (const path of [config.storage.databasePath, config.storage.checkpointPath])
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const database = new ApplicationDatabase(config.storage.databasePath);
  let checkpoints: WorkflowCheckpoints | undefined;
  try {
    checkpoints = new WorkflowCheckpoints(config.storage.checkpointPath, config.storage.databasePath);
    const repository = new ApplicationRepository(database), clock = options.clock ?? Date.now;
    const bootId = `composition-${randomUUID()}`;
    const stamp = (at = new Date(clock()).toISOString()) => ({ eventId: randomUUID(), at,
      processId: `process-${process.pid}`, bootId, monotonicMs: performance.now() });
    const calls = new AsyncLocalStorage<AdapterCallContext>();
    const execution = new AsyncLocalStorage<TransportObserver>();
    const pending = new Map<string, { ref: RestrictedArtifactRef; content: unknown }>();
    const receipts = new Map<string, ProviderAttemptReceipt>();
    const eventContext = (context: AdapterCallContext): EventContext => {
      const saved = repository.getWorkflow(context.runId)?.state as { stage?: EventContext['stage']; spanId?: string } | undefined;
      return { producerId: 'workflow-composition', producerVersion: 'composition-v1', runId: context.runId,
        evaluationAttemptId: context.evaluationAttemptId, runtimeAttemptId: context.runtimeAttemptId,
        stage: saved?.stage ?? 'ingest', spanId: context.spanId, parentSpanId: saved?.spanId ?? null, causedBy: [] };
    };
    const remember = (content: unknown, mediaType: RestrictedArtifactRef['mediaType'] = 'application/json') => {
      const encoded = encodeRestrictedArtifact({ artifactId: randomUUID(), mediaType, content });
      pending.set(encoded.ref.artifactId, { ref: encoded.ref, content });
      return encoded.ref;
    };
    const importArtifact = (writer: ApplicationWriter, ref: RestrictedArtifactRef): void => {
      try { writer.readArtifact(ref); return; } catch { /* Import the original bytes below. */ }
      const local = pending.get(ref.artifactId);
      const bytes = local ? null : options.providers?.readArtifact?.(ref.artifactId);
      if (!local && bytes == null) throw new Error('provider_artifact_unavailable');
      const content = local?.content ?? (ref.mediaType === 'application/json' ? JSON.parse(bytes!) : bytes);
      const actual = writer.putArtifact({ artifactId: ref.artifactId, mediaType: ref.mediaType, content });
      if (canonical(actual) !== canonical(ref)) throw new Error('provider_artifact_integrity_mismatch');
    };
    const importReferences = (writer: ApplicationWriter, value: unknown): void => {
      const ref = RestrictedArtifactRefSchema.safeParse(value);
      if (ref.success) { importArtifact(writer, ref.data); return; }
      if (Array.isArray(value)) value.forEach(child => importReferences(writer, child));
      else if (value && typeof value === 'object') Object.values(value).forEach(child => importReferences(writer, child));
    };
    const saveArtifact = (context: AdapterCallContext, ref: RestrictedArtifactRef) => {
      if (!repository.getRun(context.runId)) return;
      repository.transaction(eventContext(context), writer => {
        const content = pending.get(ref.artifactId)?.content;
        if (content !== undefined) importReferences(writer, content);
        importArtifact(writer, ref);
        writer.appendEvent({ kind: 'fault.recorded', faultId: randomUUID(), evidenceRef: ref }, stamp());
      });
    };
    const toolIdentity = (context: AdapterCallContext) => ({ app: context.app, operation: context.operation,
      logicalCallId: context.logicalCallId, providerAttemptId: context.providerAttemptId });
    const dispatch = (context: AdapterCallContext, startedAt: string) => {
      if (!repository.getRun(context.runId) || repository.getProviderAttempt(context.providerAttemptId)) return;
      repository.transaction(eventContext(context), writer => {
        const requestRef = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: { schemaVersion: 2, context } });
        writer.startProviderAttempt({ context, requestRef, startedAt });
        writer.appendEvent({ kind: 'tool.dispatch', ...toolIdentity(context), actor: 'marker' in context ? 'coordinator' : 'reader',
          effectKey: 'marker' in context ? EffectKeySchema.parse(context.marker) : null, requestDigest: 'requestDigest' in context ? context.requestDigest : null,
          planHash: null, approvalId: null }, stamp(startedAt));
      });
    };
    const finish = (context: AdapterCallContext, receipt: ProviderAttemptReceipt, ref: RestrictedArtifactRef, outcome: MutationOutcome | null) => {
      if (!repository.getRun(context.runId) || repository.getProviderAttempt(context.providerAttemptId)?.receipt) return;
      repository.transaction(eventContext(context), writer => {
        importReferences(writer, receipt); importArtifact(writer, ref); importReferences(writer, outcome);
        writer.recordProviderOutcome({ providerAttemptId: context.providerAttemptId, receipt, outcome });
        writer.appendEvent({ kind: 'tool.result', ...toolIdentity(context), transportOutcome: receipt.transportOutcome,
          providerOutcome: receipt.providerOutcome === 'success' ? 'success' : receipt.providerOutcome === 'unknown' ? 'unknown' : 'error',
          receiptRef: ref, latencyMs: Math.max(0, Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt)) }, stamp(receipt.finishedAt));
      });
    };
    const observer: TransportObserver = {
      async onDispatch(value) {
        if ('effectKey' in value.context) {
          const active = execution.getStore(); if (!active) throw new Error('execution_observer_missing');
          await active.onDispatch(value);
        } else dispatch(value.context, value.startedAt);
      },
      async onResult(value) {
        saveArtifact(value.context, value.receiptRef);
        receipts.set(value.context.providerAttemptId, value.receipt);
        if ('effectKey' in value.context) await execution.getStore()!.onResult(value);
        else if (!( 'marker' in value.context)) finish(value.context, value.receipt, value.receiptRef, null);
      },
      async onRetry(value) {
        if ('effectKey' in value.context) return execution.getStore()!.onRetry(value);
        if (!repository.getRun(value.context.runId)) return;
        repository.transaction(eventContext(value.context), writer => writer.appendEvent({ kind: 'retry.scheduled',
          target: { type: 'provider', providerAttemptId: value.context.providerAttemptId }, logicalCallId: value.context.logicalCallId,
          owner: 'provider_transport', reason: value.reason, delayMs: value.delayMs, remainingBudgetMs: value.remainingBudgetMs }, stamp()));
      },
    };
    const transport = createBoundedRestTransport({
      fetch: (url, init) => (options.fetch ?? globalThis.fetch)(url, init),
      clock: { wallNowMs: clock, monotonicNowMs: () => performance.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) },
      createProviderAttemptId: () => ProviderAttemptIdSchema.parse(randomUUID()), createSpanId: randomUUID, observer,
      storeResponse: input => remember(Buffer.from(input.bytes).toString('utf8'), 'text/plain'),
      storeReceipt: receipt => { const ref = remember(receipt); const context = calls.getStore(); if (context) saveArtifact(context, ref); return ref; },
    });
    let rawProviders = options.providers;
    if (!rawProviders) {
      if (config.adapterMode !== 'rest') throw new Error('workflow_fixture_providers_required');
      const mapping = options.hubspotMapping ?? config.hubspotMapping;
      if (!mapping) throw new Error('workflow_hubspot_mapping_required');
      const fetchToken = async (refreshToken: string) => {
        const response = await (options.fetch ?? globalThis.fetch)('https://oauth2.googleapis.com/token', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.secrets.gmailClientId!,
            client_secret: config.secrets.gmailClientSecret!, refresh_token: refreshToken }),
        });
        if (!response.ok) throw new Error('gmail_authorization_unavailable');
        return z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
      };
      const createClients = async (readOnly: boolean) => {
        const github = createGitHubAdapter({ scope: { app: 'github', accountRef: `github-${digest(config.accounts.githubRepository)}` },
          repository: config.accounts.githubRepository!, token: (readOnly ? config.secrets.githubReaderToken : null) ?? config.secrets.githubToken!, transport });
        const hubspot = createHubSpotAdapter({ accountRef: config.accounts.hubspotPortalId!, mapping,
          accessToken: (readOnly ? config.secrets.hubspotReaderToken : null) ?? config.secrets.hubspotAccessToken!, transport });
        const slack = createSlackAdapter({ scope: { app: 'slack', accountRef: config.accounts.slackTeamId! },
          workspaceId: config.accounts.slackTeamId!, channelId: config.accounts.slackChannelId!,
          writerToken: config.secrets.slackBotToken!, readerToken: config.secrets.slackReaderToken!, transport });
        const gmail = createGmailAdapter({ scope: { app: 'gmail', accountRef: `gmail-${digest(config.accounts.gmailMailbox)}` },
          accessToken: await fetchToken((readOnly ? config.secrets.gmailReaderRefreshToken : null) ?? config.secrets.gmailRefreshToken!), transport });
        return { github, hubspot, slack, gmail };
      };
      const adapters = await createClients(false), readerClients = await createClients(true);
      rawProviders = { adapters, readers: readerClients };
    }
    for (const app of ['github', 'hubspot', 'gmail', 'slack'] as const) {
      if (rawProviders.adapters[app].mode !== config.adapterMode || rawProviders.readers[app].mode !== config.adapterMode ||
          canonical(rawProviders.adapters[app].scope) !== canonical(rawProviders.readers[app].scope)) throw new Error('provider_configuration_mismatch');
    }
    const wrap = <T extends object>(client: T, readOnly: boolean): T => {
      const result: Record<string, unknown> = {};
      for (const name of ['mode', 'scope']) result[name] = (client as Record<string, unknown>)[name];
      const app = (client as { scope: { app: string } }).scope.app;
      const methods = [...READ_OPERATIONS, 'hubspot.createTask', 'hubspot.createNote', 'gmail.createDraft',
        'github.createComment', 'github.updateComment', 'slack.postReview', 'slack.updateReview', 'slack.postSummary', 'slack.updateSummary'];
      for (const operation of methods.filter(operation => operation.startsWith(`${app}.`))) {
        if (readOnly && !(READ_OPERATIONS as readonly string[]).includes(operation)) continue;
        const name = operation.split('.')[1], method = (client as Record<string, unknown>)[name];
        if (typeof method !== 'function') continue;
        result[name] = async (...args: unknown[]) => {
          const context = args.at(-1) as AdapterCallContext;
          return calls.run(context, async () => {
            if (context.mode === 'rest') {
              const value = await method.apply(client, args);
              if ('marker' in context) { const outcome = value as MutationOutcome;
                const receipt = receipts.get(context.providerAttemptId); if (!receipt) throw new Error('provider_receipt_missing');
                finish(context, receipt, outcome.receipt, outcome); }
              return value;
            }
            const startedAt = new Date(clock()).toISOString();
            const isRead = (READ_OPERATIONS as readonly string[]).includes(operation);
            if (!isRead) await observer.onDispatch({ context, startedAt, monotonicMs: performance.now() });
            const raw = await method.apply(client, args);
            if (isRead) {
              const value = structuredClone(raw) as ReadResult<unknown>;
              value.receipt.collectionId = context.logicalCallId;
              for (const [index, page] of value.receipt.pages.entries()) {
                const child = { ...context, providerAttemptId: index === 0 ? context.providerAttemptId : ProviderAttemptIdSchema.parse(randomUUID()),
                  spanId: index === 0 ? context.spanId : randomUUID() };
                page.providerAttemptId = child.providerAttemptId;
                const receipt = ProviderAttemptReceiptSchema.parse({ schemaVersion: 2, context: child,
                  startedAt: value.receipt.startedAt, finishedAt: value.receipt.finishedAt, transport: 'fake', httpStatus: null,
                  transportOutcome: 'response', providerOutcome: 'success', responseRef: page.response, errorCode: null });
                const ref = remember(receipt); dispatch(child, receipt.startedAt); finish(child, receipt, ref, null);
              }
              if (value.status === 'incomplete') {
                const child = { ...context,
                  providerAttemptId: value.receipt.pages.length ? ProviderAttemptIdSchema.parse(randomUUID()) : context.providerAttemptId,
                  spanId: value.receipt.pages.length ? randomUUID() : context.spanId };
                const timedOut = value.reason === 'timeout';
                const receipt = ProviderAttemptReceiptSchema.parse({ schemaVersion: 2, context: child,
                  startedAt: value.receipt.startedAt, finishedAt: value.receipt.finishedAt, transport: 'fake', httpStatus: null,
                  transportOutcome: timedOut ? 'timeout' : 'response', providerOutcome: timedOut ? 'unknown' : value.reason === 'denied' ? 'denied' : 'error',
                  responseRef: null, errorCode: value.reason });
                const ref = remember(receipt); dispatch(child, receipt.startedAt); finish(child, receipt, ref, null);
              }
              if (repository.getRun(context.runId)) repository.transaction(eventContext(context), writer => {
                importReferences(writer, value);
                const ref = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: value });
                writer.appendEvent({ kind: 'fault.recorded', faultId: randomUUID(), evidenceRef: ref }, stamp());
              });
              return value;
            }
            const outcome = raw as MutationOutcome;
            const receipt = ProviderAttemptReceiptSchema.parse({ schemaVersion: 2, context, startedAt,
              finishedAt: new Date(clock()).toISOString(), transport: 'fake', httpStatus: null,
              transportOutcome: 'response', providerOutcome: outcome.status === 'applied' ? 'success' : outcome.status === 'unknown' ? 'unknown' : 'error',
              responseRef: outcome.receipt, errorCode: outcome.status === 'applied' ? null : outcome.reason });
            const receiptRef = remember(receipt); saveArtifact(context, receiptRef);
            await observer.onResult({ context, receipt, receiptRef, latencyMs: Math.max(0, clock() - Date.parse(startedAt)),
              requestDigest: 'requestDigest' in context ? context.requestDigest : null, responseDigest: null, providerRequestId: null });
            const normalized = { ...outcome, receipt: receiptRef };
            if (!('effectKey' in context)) finish(context, receipt, receiptRef, normalized);
            return normalized;
          });
        };
      }
      return Object.freeze(result) as T;
    };
    const providers: CompositionProviders = { adapters: {
      github: wrap(rawProviders.adapters.github, false), hubspot: wrap(rawProviders.adapters.hubspot, false),
      gmail: wrap(rawProviders.adapters.gmail, false), slack: wrap(rawProviders.adapters.slack, false),
    }, readers: { github: wrap(rawProviders.readers.github, true), hubspot: wrap(rawProviders.readers.hubspot, true),
      gmail: wrap(rawProviders.readers.gmail, true), slack: wrap(rawProviders.readers.slack, true) },
      readArtifact: artifactId => {
        const saved = pending.get(artifactId);
        return saved ? saved.ref.mediaType === 'application/json' ? canonical(saved.content) : String(saved.content)
          : rawProviders!.readArtifact?.(artifactId) ?? null;
      } };
    const collectors = new Map<string, { node: WorkflowNodeContext; collector: ReturnType<typeof createEvidenceCollector> }>();
    const services: CompositionServices = { config, repository, checkpoints,
      model: createModelClient({ config, mockClient: options.modelClient, fetch: options.fetch }), providers, clock,
      withExecutionObserver: (observer, action) => execution.run(observer, action),
      createCollector: node => {
        const previous = collectors.get(node.state.runId);
        if (previous) { previous.node = node; return previous.collector; }
        const entry = { node } as { node: WorkflowNodeContext; collector: ReturnType<typeof createEvidenceCollector> };
        entry.collector = createEvidenceCollector({ readers: providers.readers,
          identity: { version: 'collector-v1', processId: `process-${process.pid}`, bootId }, createId: () => randomUUID(),
          writeArtifact: (artifactId, value) => entry.node.transaction(writer => {
            importReferences(writer, value);
            const ref = writer.putArtifact({ artifactId, mediaType: 'application/json', content: value });
            writer.appendEvent({ kind: 'fault.recorded', faultId: randomUUID(), evidenceRef: ref }, stamp()); return ref;
          }) });
        collectors.set(node.state.runId, entry); return entry.collector;
      },
    };
    const configuration = ExecutionModeSchema.parse({ schemaVersion: 2, modelMode: config.modelMode, providerMode: config.adapterMode,
      fixtureId: config.fixtureId, evidenceMode: config.modelMode === 'mock' ? 'synthetic_fixture' : config.adapterMode === 'fake' ? 'model_with_fake_providers' : 'imported_provider_snapshot' });
    const driver = new WorkflowDriver({ ...options.buildWorkflow(services), repository, checkpoints, configuration });
    const monitor = typeof options.monitor === 'function' ? options.monitor(services) : options.monitor;
    let monitorTimer: ReturnType<typeof setInterval> | undefined, monitorHealthy = !!monitor, closed = false;
    const assess = () => { if (!monitor) return; try { processApplicationJobs(repository, { ...monitor, clock, maxJobs: 100 }); monitorHealthy = true; }
      catch { monitorHealthy = false; } };
    return Object.assign(services, { driver, monitorReady: () => monitorHealthy,
      async start() { await driver.start(); if (monitor && !monitorTimer) { monitorTimer = setInterval(assess, 250); monitorTimer.unref(); assess(); } },
      async stop() { if (monitorTimer) clearInterval(monitorTimer); monitorTimer = undefined; await driver.stop(); },
      async flush() { await driver.flush(); assess(); },
      async close() { if (closed) return; closed = true; if (monitorTimer) clearInterval(monitorTimer); await driver.stop();
        try { checkpoints!.close(); } finally { database.close(); } },
    });
  } catch (error) { try { checkpoints?.close(); } finally { database.close(); } throw error; }
}

/** Q03's saved receipt is projected without promoting missing collection/labels. */
export const projectAssessments: NonNullable<RunApiOptions['readAssessments']> = (_id, watermark, saved) => {
  const parsed = ApplicationAssessmentSchema.safeParse(saved); if (!parsed.success) return null;
  const value = parsed.data;
  const summary = (state: 'pending' | 'unverified' | 'passed' | 'failed', required: number, confirmed: number,
    coverage: AssessmentSummaryView['coverage']): AssessmentSummaryView => {
    const gaps = state === 'passed' ? [] : value.checks.filter(check => check.status !== 'passed').map(check => ({ code: check.code, referenceId: null }));
    const pass = state === 'passed' && required > 0 && confirmed === required && coverage === 'complete';
    return { status: pass ? 'pass' : state === 'passed' ? 'unverified' : assessmentDisplayState(state), coverage,
      evaluatorVersion: 'monitor-v2', assessmentRevision: Math.max(1, watermark), observedAt: new Date(value.observedAtMs).toISOString(),
      watermark: String(watermark), requiredCount: required, confirmedCount: confirmed, humanLabelCount: null,
      gaps: pass ? [] : gaps.length ? gaps : [{ code: 'evidence_incomplete', referenceId: null }] };
  };
  const quality = Object.values(value.facts.quality);
  return { trace: summary(value.traceAssessment, 1, value.traceAssessment === 'passed' ? 1 : 0, value.traceCoverage),
    outcome: summary(value.outcomeAssessment, value.facts.predicates.required, value.facts.predicates.confirmed, value.outcomeAssessment === 'passed' ? 'complete' : 'incomplete'),
    firstProposal: summary(value.firstProposalAssessment, quality.length, quality.filter(item => item.firstProposalAssessment === 'passed').length, value.firstProposalAssessment === 'passed' ? 'complete' : 'incomplete'),
    selectedPlan: quality.length ? summary(value.semanticAssessment, quality.length, quality.filter(item => item.selectedPlanAssessment === 'passed').length, value.semanticAssessment === 'passed' ? 'complete' : 'incomplete') : null };
};

export async function createComposedApp(config: AppConfig, options: CompositionOptions) {
  const services = await createComposition(config, options);
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  app.addHook('onReady', () => services.start());
  app.addHook('preClose', () => services.stop());
  app.addHook('onClose', async () => { try { await services.flush(); } finally { await services.close(); } });
  registerRunRoutes(app, { driver: services.driver, repository: services.repository,
    auth: options.auth ?? { resolveSession: () => null }, monitorReady: services.monitorReady, readAssessments: projectAssessments });
  registerHealthRoutes(app, { storageReady: () => services.driver.storageReady(), checkpointsReady: () => services.driver.checkpointsReady(), monitorReady: services.monitorReady });
  try { if (options.webRoot) await app.register(fastifyStatic, { root: resolve(options.webRoot), index: 'index.html' });
    await app.ready(); return app;
  } catch (error) { await app.close(); throw error; }
}
