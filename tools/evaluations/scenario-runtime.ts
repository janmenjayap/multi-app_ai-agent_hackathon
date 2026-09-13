/// <reference path="../../src/shared/checker.d.ts" />
/** Q04 executes the application graph; fixed model prose remains synthetic evidence. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../../src/server/index.js';
import { createComposition } from '../../src/server/composition.js';
import { createWorkflowDefinition } from '../../src/server/workflow/nodes.js';
import type { WorkflowNodeContext, PreparedWorkflow, PreparedWorkflowIdentity } from '../../src/server/workflow/driver.js';
import type { ExecutionNodeOptions } from '../../src/server/workflow/graph.js';
import { scenarioWorld, type FixtureSuite, type ScenarioEntry } from '../../src/server/evaluations/manifest.js';
import type { ProviderReaderSet } from '../../src/server/evaluations/provider-readers.js';
import type { CheckerLedgerEvent } from '../../src/server/evaluations/export-checker.js';
import { ModelDispatchError, type ModelClient, type ModelDispatchRequest } from '../../src/server/agents/model.js';
import { AnalystInputSchema, AuditorInputSchema, DraftInputSchema } from '../../src/shared/agents.js';
import { buildRequiredContentChecklist } from '../../src/server/agents/drafter/validate.js';
import { SlackMessageSchema } from '../../src/shared/adapters.js';
import { createFakeProviders, type DeclaredSourceEdit } from '../../tests/fakes/providers.js';
import { FAULT_SCRIPTS, FaultController, type FaultDirective, type FaultPoint } from '../../tests/fixtures/faults.js';

export const SCENARIO_RUNTIME_VERSION = 'q04-graph-runtime-v1';
export const SCENARIO_TRANSPORT_BUDGETS = { timeoutMs: 5000, totalMs: 15000, maxAttempts: 1,
  maxPages: 100, maxRecords: 1000, maxResponseBytes: 1000000 };

export function scenarioRuntimeSupport(entry: ScenarioEntry): { supported: boolean; reason?: string } {
  const rules = FAULT_SCRIPTS[entry.faultScriptId];
  if (!rules) return { supported: false, reason: 'unknown_fault_schedule' };
  if (entry.faultScriptId === 'interrupted_accepted_write') return { supported: false, reason: 'recovery_not_implemented' };
  if (entry.setup.preservePriorEffects) return { supported: false, reason: 'parent_state_not_bound' };
  if (entry.leg === 'repair') return { supported: false, reason: 'repair_parent_state_not_bound' };
  if (rules.some(rule => rule.kind === 'human_drift' || rule.operation === 'between_attempt_legs'))
    return { supported: false, reason: 'human_edit_schedule_not_implemented' };
  if (rules.some(rule => rule.operation === 'before_model_response'))
    return { supported: false, reason: 'prompt_variant_not_bound' };
  return { supported: true };
}

/** S0/preflight readers never consume graph faults; registration arms the schedule. */
class GraphFaultController extends FaultController {
  isRegistered = false;
  setupReaders = 0;
  override take(point: FaultPoint): Readonly<FaultDirective> | undefined {
    return this.isRegistered && this.setupReaders === 0 ? super.take(point) : undefined;
  }
}

function createScenarioModel(faults: FaultController) {
  const calls: { role: string; modelAttemptId: string; messages: ModelDispatchRequest<unknown>['messages'] }[] = [];
  const client: ModelClient = { mode: 'mock', async dispatchStructured(request, onRawResponse) {
    request.abortSignal.throwIfAborted();
    calls.push({ role: request.role, modelAttemptId: request.modelAttemptId, messages: structuredClone(request.messages) });
    const fault = faults.take({ target: 'model', operation: request.role, phase: 'invoke' });
    if (fault?.kind === 'timeout') throw new ModelDispatchError('timeout', true);
    if (fault?.kind === 'unavailable' || fault?.kind === 'tool_error') throw new ModelDispatchError('transport_error', true);
    const text = request.messages.find(message => message.role === 'user')?.content ?? '';
    const projection: unknown = JSON.parse(text.slice(text.indexOf('{')));
    let output: unknown;
    if (request.role === 'analyst') {
      const input = AnalystInputSchema.parse(projection), source = input.sources[0]!;
      output = { schemaVersion: 2, facts: [{ claimId: 'fixture-impact', text: source.text,
        sourceFactIds: [fault?.kind === 'invalid_citation' ? 'nonexistent_source_fact' : source.factId] }],
        contradictions: [], unknowns: ['Cause and recovery time remain unconfirmed.'],
        candidateChange: { status: 'uncertain', sourceFactIds: [source.factId], reason: 'A candidate change does not establish causation.' } };
    } else if (request.role === 'drafter') {
      const input = DraftInputSchema.parse((projection as { input: unknown }).input);
      output = { schemaVersion: 2, entries: buildRequiredContentChecklist(input).map((required, index) => {
        const source = input.sources.find(fact => required.impact[0]!.sourceFactIds.includes(fact.factId))!;
        const content = fault?.kind === 'false_claim' ? 'The billing-api incident has been resolved and the migration is guaranteed on time.'
          : fault?.kind === 'missing_content' ? 'We are investigating the billing-api incident.'
          : [source.text, required.customerContext, required.promise, ...required.uncertainty,
            ...required.contradictions, required.nextStep].filter(Boolean).join('\n');
        return { commitmentId: required.commitmentId, text: content,
          claims: [{ claimId: `fixture-impact-${index}`, text: fault ? content : source.text, sourceFactIds: [source.factId] }] };
      }) };
    } else {
      const input = AuditorInputSchema.parse(projection);
      const blocked = ['auditor_false_block', 'auditor_unsupported_claim', 'auditor_missing_content'].includes(fault?.kind ?? '');
      output = { schemaVersion: 2, verdict: blocked ? 'block' : 'pass', entries: input.proposal.entries.map(entry => ({
        commitmentId: entry.commitmentId, findings: entry.claims.map(claim => ({ claimId: claim.claimId,
          verdict: fault?.kind === 'auditor_unsupported_claim' ? 'unsupported' : 'supported', sourceFactIds: claim.sourceFactIds,
          reason: blocked ? 'Predeclared synthetic audit fault.' : 'Synthetic fixture quotes the original source.' })),
        requiredFactFindings: input.taskContract.requiredFacts.map(factId => ({ factId,
          verdict: fault?.kind === 'auditor_missing_content' ? 'missing' : 'present',
          reason: blocked ? 'Predeclared synthetic finding.' : 'Source text is included in the fixture draft.' })),
      })) };
    }
    const refused = fault?.kind === 'refusal';
    const rawText = fault?.kind === 'malformed_output' ? '{invalid JSON' : JSON.stringify(output);
    await onRawResponse({ body: JSON.stringify({ status: 'completed', output: [{ type: 'message', status: 'completed',
      content: refused ? [{ type: 'refusal', refusal: 'Predeclared synthetic refusal.' }] : [{ type: 'output_text', text: rawText }] }],
      usage: { input_tokens: 100, output_tokens: 100 } }), status: 200, requestId: `synthetic-${randomUUID()}`, retryAfterMs: null });
    return { output: refused ? null : output, rawText, refused, incomplete: false,
      usage: { inputTokens: 100, outputTokens: 100 } };
  } };
  return { client, calls };
}

export interface ScenarioRuntimePreparation {
  identity: PreparedWorkflowIdentity;
  incidentUrl: string;
  operatorId: string;
  runtime: { readers: ProviderReaderSet; readArtifact(artifactId: string): string | null;
    clock(): number; world: ReturnType<typeof scenarioWorld> };
}
export interface ScenarioRuntimeOptions {
  suite: FixtureSuite;
  entry: ScenarioEntry;
  directory: string;
  prepare(input: ScenarioRuntimePreparation): Promise<PreparedWorkflow>;
  assess?: ExecutionNodeOptions['assess'];
  /** Explicit validated configuration enables actual model/fake-provider runs; no fallback. */
  config?: AppConfig;
  modelClient?: ModelClient;
}

export async function createScenarioRuntime(options: ScenarioRuntimeOptions) {
  const support = scenarioRuntimeSupport(options.entry);
  if (!support.supported) throw new Error(support.reason);
  const { suite, entry } = options;
  const world = scenarioWorld(suite, entry.suiteEntryId);
  const namespace = `q04-${randomUUID()}`, ownerId = 'synthetic-scenario-operator';
  const owner = { namespace, ownerId };
  let now = Date.parse(world.clockAt), activeStage: string | null = null;
  const clock = () => now, iso = () => new Date(now).toISOString();
  const faults = new GraphFaultController(FAULT_SCRIPTS[entry.faultScriptId]);
  const declaredEdits: DeclaredSourceEdit[] = faults.rules.filter(rule => rule.kind === 'source_edit').map(rule => {
    const fields = rule.fields ?? {};
    const isCommitment = typeof fields.commitmentId === 'string';
    const sourceFields = isCommitment ? Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'commitmentId'))
      : { incident: fields, incidentFields: fields, body: world.github.technicalEvidence.body.replace(/```json\n[^]*?\n```/,
        `\`\`\`json\n${JSON.stringify({ incidentId: world.github.technicalEvidence.incident.issueId,
          service: world.github.technicalEvidence.incident.service, environment: world.github.technicalEvidence.incident.environment,
          ...world.github.incidentFields, ...fields })}\n\`\`\``) };
    return { editId: rule.faultId, stage: 'source_edit', actorId: rule.actorId!, observedAt: rule.observedAt!,
      target: isCommitment ? 'commitment' : 'incident', recordId: isCommitment ? String(fields.commitmentId) : world.github.technicalEvidence.incident.issueId,
      fields: sourceFields };
  });
  const fake = createFakeProviders({ namespace, ownerId, world, now: iso, pageSize: 1, faults, declaredEdits });
  const model = createScenarioModel(faults);
  const config = options.config ?? loadConfig({ PG_MODEL_MODE: 'mock', PG_ADAPTER_MODE: 'fake', PG_FIXTURE_ID: world.fixtureId,
    PG_DATABASE_PATH: join(options.directory, 'application.sqlite'), PG_CHECKPOINT_PATH: join(options.directory, 'checkpoints.sqlite'),
    PG_EVIDENCE_DIR: join(options.directory, 'evidence'), PG_MODEL_MAX_ATTEMPTS: String(suite.scenarios.modelBudgets.maxAttempts),
    PG_MODEL_MAX_INPUT_CHARS: String(suite.scenarios.modelBudgets.maxInputChars) });
  if (config.adapterMode !== 'fake' || config.fixtureId !== world.fixtureId) throw new Error('scenario_runtime_requires_scoped_fake_providers');
  if (config.modelMode === 'live' && faults.rules.some(rule => rule.target === 'model'))
    throw new Error('synthetic_model_fault_cannot_establish_live_model_behavior');
  if (options.modelClient && options.modelClient.mode !== config.modelMode) throw new Error('scenario_model_mode_mismatch');
  if (config.modelMode === 'mock' && options.modelClient) throw new Error('custom_mock_model_not_frozen');
  const commandReceipts: Awaited<ReturnType<Awaited<ReturnType<typeof createComposition>>['driver']['accept']>>[] = [];
  const actorActions: { faultId: string | null; boundary: string; at: string; action: string }[] = [];
  const diagnostics: string[] = [];
  function applyBoundary(boundary: 'after_source_snapshot' | 'before_protected_write') {
    const fault = faults.at(boundary);
    if (!fault) return;
    if (fault.kind === 'source_edit') {
      now = Math.max(now, Date.parse(fault.observedAt!));
      fake.operator.applyDeclaredEdit(fault.faultId, 'source_edit', owner);
    } else if (fault.kind === 'approval_override' && typeof fault.fields?.elapsedMs === 'number') {
      now += fault.fields.elapsedMs;
    } else throw new Error('unsupported_runtime_boundary');
    actorActions.push({ faultId: fault.faultId, boundary, at: iso(), action: fault.kind });
  }
  const workflowReaders = { ...fake.readers, github: { ...fake.readers.github,
    async readTechnicalEvidence(...args: Parameters<typeof fake.readers.github.readTechnicalEvidence>) {
      if (activeStage === 'execute' && faults.setupReaders === 0) applyBoundary('before_protected_write');
      return fake.readers.github.readTechnicalEvidence(...args);
    } } };
  const preparationRuntime = { readers: fake.readers, readArtifact: fake.observer.readArtifact, clock, world };
  let services: Awaited<ReturnType<typeof createComposition>>;
  async function open() {
    const created = await createComposition(config, { clock,
      ...(config.modelMode === 'mock' ? { modelClient: model.client } : options.modelClient ? { modelClient: options.modelClient } : {}),
      providers: { adapters: fake.adapters, readers: workflowReaders, readArtifact: fake.observer.readArtifact },
      buildWorkflow(composition) {
        const definition = createWorkflowDefinition(composition, {
          prepare: async (incidentUrl, operatorId, identity) => {
            faults.setupReaders += 1;
            try {
              const prepared = await options.prepare({ identity, incidentUrl, operatorId, runtime: preparationRuntime });
              return { ...prepared, register(writer, identity) {
                const registration = prepared.register(writer, identity);
                faults.isRegistered = true;
                return registration;
              } };
            } finally { faults.setupReaders -= 1; }
          },
          budgets: SCENARIO_TRANSPORT_BUDGETS,
          approvalPolicy: { schemaVersion: 2, workspaceId: world.slack.workspaceId, channelId: world.slack.channelId,
            reviewActorId: 'promiseguard_fake_bot', authorizedActorIds: [world.slack.approverId],
            ttlMs: world.policy.approvalTtlMs, sourceFreshnessMs: world.policy.sourceFreshnessMs,
            slackFreshnessMs: 30000, pollMs: 100, budgets: SCENARIO_TRANSPORT_BUDGETS },
          slack: { channelId: world.slack.channelId, threadTs: `${Math.floor(now / 1000)}.000000` },
          selectionPolicy: { schemaVersion: 2, allowedRepositories: [{ owner: 'promiseguard-fixture', name: 'payments',
            repositoryId: world.github.technicalEvidence.incident.repositoryId }], supportedServices: ['billing-api', 'analytics-api'],
            githubScope: { accountRef: world.accounts.github, requiredQueryIds: ['github.readTechnicalEvidence'] },
            hubspotScope: { accountRef: world.accounts.hubspot, requiredQueryIds: ['hubspot.readCommitmentBundle'] } },
          assess: options.assess, runTimeoutMs: suite.scenarios.budgets.wallMs,
        });
        for (const [stage, handler] of Object.entries(definition.nodes)) {
          if (!handler) continue;
          definition.nodes[stage as keyof typeof definition.nodes] = async (node: WorkflowNodeContext) => {
            activeStage = stage;
            try {
              if (stage === 'execute') {
                const fault = faults.at('before_atomic_effect_claim');
                if (fault?.kind === 'concurrent_replay') {
                  // Both submissions reach accept together while the first run is
                  // paused before its first effect claim. The real driver owns deduplication.
                  let release!: () => void;
                  const barrier = new Promise<void>(resolve => { release = resolve; });
                  const submissions = [0, 1].map(async () => { await barrier;
                    return services.driver.accept(world.github.technicalEvidence.incident.canonicalUrl, ownerId); });
                  release(); commandReceipts.push(...await Promise.all(submissions));
                  actorActions.push({ faultId: fault.faultId, boundary: 'before_atomic_effect_claim', at: iso(), action: 'concurrent_replay' });
                }
              }
              const result = await handler(node);
              if (stage === 'ingest') applyBoundary('after_source_snapshot');
              return result;
            } finally { activeStage = null; }
          };
        }
        return definition;
      } });
    await created.start();
    return created;
  }
  services = await open();
  let closed = false;
  let actorScheduled = false;
  const runtime = {
    get services() { return services; }, fake, model, faults, world, suite, namespace, ownerId, directory: options.directory,
    readers: fake.readers, readArtifact: fake.observer.readArtifact, clock, commandReceipts, actorActions,
    advance(ms = 101) { if (!Number.isFinite(ms) || ms < 0) throw new Error('invalid_clock_advance'); now += ms; },
    async tick() { await services.driver.tick(); },
    async startRun() {
      const result = await services.driver.accept(world.github.technicalEvidence.incident.canonicalUrl, ownerId);
      commandReceipts.push(result); await services.driver.tick(); return result;
    },
    async restart() { await services.close(); services = await open(); },
    async executeActorSchedule(runId: string) {
      if (actorScheduled) return;
      actorScheduled = true;
      if (services.repository.getRun(runId)?.status === 'awaiting_approval') {
        const plan = services.repository.getPlan(runId, 1);
        if (!plan) throw new Error('scenario_plan_missing');
        const review = fake.observer.snapshot().slack.messages.find(message => message.body.includes(`promiseguard-review-${plan.planHash}`));
        if (!review) throw new Error('scenario_review_missing');
        const fault = faults.at('awaiting_approval');
        const fields = fault?.fields ?? {};
        const decisions = Array.isArray(fields.decisions) ? fields.decisions : [fields.decision ?? 'approve'];
        const count = typeof fields.duplicateCount === 'number' ? fields.duplicateCount : 1;
        for (const decision of decisions) for (let index = 0; index < count; index++) {
          now += 1;
          const observedAt = iso();
          const messageTs = `${Math.floor(now / 1000)}.${String(now % 1000 * 1000).padStart(6, '0')}`;
          const message = SlackMessageSchema.parse({ workspaceId: fields.workspaceId ?? world.slack.workspaceId,
            channelId: fields.channelId ?? world.slack.channelId, threadTs: fields.threadTs ?? review.threadTs,
            messageTs: fields.outOfOrder ? '1.000000' : messageTs,
            actorId: fields.actorId ?? world.slack.approverId, isBot: fields.isBot ?? false, subtype: null,
            editedAt: fields.editedAt ?? null, deleted: fields.deleted ?? false, observedAt,
            body: `${decision} ${runId} ${fields.hashPrefix ?? plan.planHash}` });
          fake.operator.appendFixtureMessage(message, owner);
        }
        actorActions.push({ faultId: fault?.faultId ?? null, boundary: 'awaiting_approval', at: iso(), action: 'synthetic_slack_decision' });
        runtime.advance(); await runtime.tick();
      }
      const replay = faults.at('before_replay_reconciliation');
      if (replay?.kind === 'replay') {
        const writesBefore = fake.observer.history().length, callsBefore = model.calls.length;
        const result = await runtime.startRun();
        if (result.runId !== runId || fake.observer.history().length !== writesBefore || model.calls.length !== callsBefore)
          diagnostics.push('replay_changed_run_or_created_effects');
        actorActions.push({ faultId: replay.faultId, boundary: 'before_replay_reconciliation', at: iso(), action: 'replay' });
      }
    },
    operationHistory(): readonly CheckerLedgerEvent[] {
      return fake.observer.history().filter(row => row.stage !== 'setup' && row.actorId !== 'promiseguard_fake_bot')
        .map(row => ({ app: row.app, actor: 'human' as const, operation: row.action === 'create' ? 'create' as const : 'update' as const,
          outcome: 'applied' as const, effectKey: row.marker, providerId: row.recordId }));
    },
    historyComplete() { return fake.observer.history().every((row, index) => row.sequence === index + 1); },
    diagnostics() {
      const faultTrace = faults.trace();
      const encountered = new Set(faultTrace.map(row => row.faultId).filter(Boolean));
      const unencounteredFaultIds = faults.rules.filter(rule => !encountered.has(rule.faultId)).map(rule => rule.faultId);
      return { gaps: [...diagnostics, ...unencounteredFaultIds.map(id => `fault_boundary_unreached:${id}`)],
        unencounteredFaultIds, faultTrace, runtimeVersion: SCENARIO_RUNTIME_VERSION, modelMode: config.modelMode, providerMode: config.adapterMode,
        modelCalls: config.modelMode === 'mock' ? model.calls.map(({ role, modelAttemptId }) => ({ role, modelAttemptId })) : null,
        actorActions: [...actorActions], commandReceipts: [...commandReceipts], providerHistory: fake.observer.history() };
    },
    async close() { if (!closed) { closed = true; await services.close(); } },
  };
  return runtime;
}
export type ScenarioRuntime = Awaited<ReturnType<typeof createScenarioRuntime>>;
