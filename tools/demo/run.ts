/// <reference path="../../src/shared/checker.d.ts" />
/**
 * Simulated four-app demo; run from the repository root:
 * npm exec -- tsc -p tools/demo/tsconfig.json
 * node .local/demo-build/tools/demo/run.js
 * The real A01 runtime and guarded graph run against independent stateful fakes.
 * A simulated Slack reply is never counted as an actual human quality review.
 */
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../../src/server/index.js';
import { createComposition } from '../../src/server/composition.js';
import { createWorkflowDefinition } from '../../src/server/workflow/nodes.js';
import { createEvidenceCollector } from '../../src/server/evaluations/collector.js';
import { createScenarioManifest, loadFixtureSuiteFrom, scenarioWorld } from '../../src/server/evaluations/manifest.js';
import { buildRequiredContentChecklist } from '../../src/server/agents/drafter/validate.js';
import { AnalystInputSchema, AuditorInputSchema, DraftInputSchema } from '../../src/shared/agents.js';
import { ReadCallContextSchema } from '../../src/shared/adapters.js';
import { EvaluationAttemptRegistrationSchema, ReviewLabelSchema } from '../../src/shared/evaluation.js';
import { RestrictedArtifactRefSchema, canonical } from '../../src/shared/domain.js';
import { digest } from '../../src/shared/reliability.js';
import { createFakeProviders } from '../../tests/fakes/providers.js';
import { FaultController, FAULT_SCRIPTS } from '../../tests/fixtures/faults.js';
import type { ModelClient, ModelDispatchRequest } from '../../src/server/agents/model.js';
import type { PreparedWorkflow } from '../../src/server/workflow/driver.js';
import type { ApplicationWriter } from '../../src/server/storage/repositories.js';
import type { RestrictedArtifactRef } from '../../src/shared/domain.js';
import type { CollectedProviderPhase } from '../../src/server/evaluations/collector.js';

export const DEMO_BUDGETS = { timeoutMs: 5000, totalMs: 15000, maxAttempts: 1,
  maxPages: 100, maxRecords: 1000, maxResponseBytes: 1000000 };

/** Responds to real role prompts; no network call or model-quality evidence is implied. */
export function createDemoModel(options: { auditorBlock?: boolean } = {}) {
  const calls: { role: string; messages: ModelDispatchRequest<unknown>['messages'] }[] = [];
  const client: ModelClient = { mode: 'mock', async dispatchStructured(request, onRawResponse) {
    const text = request.messages.find(message => message.role === 'user')?.content ?? '';
    const projection: unknown = JSON.parse(text.slice(text.indexOf('{')));
    calls.push({ role: request.role, messages: structuredClone(request.messages) });
    let output: unknown;
    if (request.role === 'analyst') {
      const input = AnalystInputSchema.parse(projection), source = input.sources[0]!;
      output = { schemaVersion: 2, facts: [{ claimId: 'fixture-impact', text: source.text, sourceFactIds: [source.factId] }],
        contradictions: [], unknowns: ['Cause and recovery time remain unconfirmed.'],
        candidateChange: { status: 'uncertain', sourceFactIds: [source.factId], reason: 'A candidate change does not establish causation.' } };
    } else if (request.role === 'drafter') {
      const input = DraftInputSchema.parse((projection as { input: unknown }).input);
      const checklist = buildRequiredContentChecklist(input);
      output = { schemaVersion: 2, entries: checklist.map((required, index) => {
        const source = input.sources.find(fact => required.impact[0]!.sourceFactIds.includes(fact.factId))!;
        return { commitmentId: required.commitmentId,
          text: [source.text, required.customerContext, required.promise, ...required.uncertainty,
            ...required.contradictions, required.nextStep].filter(Boolean).join('\n'),
          claims: [{ claimId: `fixture-impact-${index}`, text: source.text, sourceFactIds: [source.factId] }] };
      }) };
    } else {
      const input = AuditorInputSchema.parse(projection);
      output = { schemaVersion: 2, verdict: options.auditorBlock ? 'block' : 'pass', entries: input.proposal.entries.map(entry => ({
        commitmentId: entry.commitmentId,
        findings: entry.claims.map(claim => ({ claimId: claim.claimId,
          verdict: options.auditorBlock ? 'unsupported' : 'supported', sourceFactIds: claim.sourceFactIds,
          reason: options.auditorBlock ? 'Declared synthetic audit rejection.' : 'Synthetic fixture quotes the original source.' })),
        requiredFactFindings: input.taskContract.requiredFacts.map(factId => ({ factId,
          verdict: 'present', reason: 'The complete source quotation is included in the fixture text.' })),
      })) };
    }
    const rawText = JSON.stringify(output);
    await onRawResponse({ body: JSON.stringify({ responseId: `synthetic-${randomUUID()}`, modelVersion: 'synthetic-model',
      candidates: [{ content: { role: 'model', parts: [{ text: rawText }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, totalTokenCount: 200 } }),
      status: 200, requestId: `synthetic-${randomUUID()}`, retryAfterMs: null });
    return { output, rawText, refused: false, incomplete: false, usage: { inputTokens: 100, outputTokens: 100 } };
  } };
  return { client, calls };
}

export interface DemoOptions {
  directory?: string;
  suiteEntryId?: string;
  faultScript?: keyof typeof FAULT_SCRIPTS;
  auditorBlock?: boolean;
  monitorOutage?: boolean;
}

/** The fixture owner and independent observer never enter graph/model state. */
export async function createDemoHarness(options: DemoOptions = {}) {
  if (import.meta.url.endsWith('.js')) await cp(resolve('src/server/migrations'),
    new URL('../../src/server/migrations/', import.meta.url), { recursive: true });
  const documents = await Promise.all(['world', 'scenarios', 'source-labels'].map(async name =>
    JSON.parse(await readFile(resolve('tests/fixtures', `${name}.json`), 'utf8'))));
  const suite = loadFixtureSuiteFrom({ world: documents[0], scenarios: documents[1], sourceLabels: documents[2] });
  const suiteEntryId = options.suiteEntryId ?? 'pg-f01-baseline';
  const frozen = createScenarioManifest(suite, suiteEntryId);
  const world = scenarioWorld(suite, suiteEntryId);
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'promiseguard-r01-demo-'));
  const namespace = `r01-${randomUUID()}`, ownerId = 'simulated-demo-operator';
  let now = Date.parse(world.clockAt);
  const clock = () => now, iso = () => new Date(now).toISOString();
  const faults = new FaultController(FAULT_SCRIPTS[options.faultScript ?? 'golden_path']);
  const fake = createFakeProviders({ namespace, ownerId, world, now: iso, pageSize: 1, faults });
  const model = createDemoModel({ auditorBlock: options.auditorBlock });
  const config = loadConfig({ PG_MODEL_MODE: 'mock', PG_ADAPTER_MODE: 'fake', PG_FIXTURE_ID: world.fixtureId,
    PG_DATABASE_PATH: join(directory, 'application.sqlite'), PG_CHECKPOINT_PATH: join(directory, 'checkpoints.sqlite'),
    PG_EVIDENCE_DIR: join(directory, 'evidence'), PG_MODEL_MAX_ATTEMPTS: '1', PG_MODEL_MAX_INPUT_CHARS: '100000' });
  const captured = new Map<string, { ref: RestrictedArtifactRef; content: unknown }>();
  const collector = createEvidenceCollector({ readers: fake.readers,
    identity: { version: 'r01-demo-v1', processId: 'simulated-collector', bootId: `collector-${randomUUID()}` },
    createId: () => randomUUID(), writeArtifact(artifactId, value) {
      const ref: RestrictedArtifactRef = { artifactId, mediaType: 'application/json', sha256: digest(value), byteLength: Buffer.byteLength(canonical(value)) };
      captured.set(artifactId, { ref, content: value }); return ref;
    } });
  const preparations: { suiteEntryId: string; s0Hash: string; registeredRunId: string | null }[] = [];
  const phases = new Map<string, { s0: CollectedProviderPhase; s1?: CollectedProviderPhase }>();
  const assessmentGaps = new Map<string, string>();

  function persistReferences(writer: ApplicationWriter, value: unknown, seen = new Set<string>()) {
    const reference = RestrictedArtifactRefSchema.safeParse(value);
    if (reference.success && !seen.has(reference.data.artifactId)) {
      const ref = reference.data; seen.add(ref.artifactId);
      const saved = captured.get(ref.artifactId);
      const bytes = saved ? null : fake.observer.readArtifact(ref.artifactId);
      if (!saved && bytes === null) throw new Error('demo_evidence_artifact_missing');
      const content = saved?.content ?? (ref.mediaType === 'application/json' ? JSON.parse(bytes!) : bytes!);
      const persisted = writer.putArtifact({ artifactId: ref.artifactId, mediaType: ref.mediaType, content });
      if (persisted.sha256 !== ref.sha256 || persisted.byteLength !== ref.byteLength) throw new Error('demo_evidence_digest_changed');
      persistReferences(writer, content, seen);
    } else if (Array.isArray(value)) value.forEach(child => persistReferences(writer, child, seen));
    else if (value && typeof value === 'object') Object.values(value).forEach(child => persistReferences(writer, child, seen));
  }

  async function prepare(incidentUrl: string, operatorId: string,
    identity: { runId: string; evaluationAttemptId: string; runtimeAttemptId: string }): Promise<PreparedWorkflow> {
    if (operatorId !== ownerId) throw new Error('demo_operator_scope_mismatch');
    const context = ReadCallContextSchema.parse({ schemaVersion: 2, ...identity,
      spanId: randomUUID(), logicalCallId: randomUUID(), providerAttemptId: randomUUID(),
      app: 'github', accountRef: world.accounts.github, mode: 'fake', operation: 'github.resolveIncident',
      deadlineAt: new Date(now + DEMO_BUDGETS.totalMs).toISOString(), budgets: DEMO_BUDGETS });
    const resolved = await fake.readers.github.resolveIncident(incidentUrl, context as typeof context & { operation: 'github.resolveIncident' });
    if (resolved.status !== 'complete' || !resolved.data) throw new Error('demo_preflight_failed');
    const s0 = await collector.collectPhase({ manifest: frozen.manifest, phase: 's0', ...identity,
      evidenceMode: 'synthetic_fixture', incident: resolved.data,
      deadlineAt: new Date(now + DEMO_BUDGETS.totalMs).toISOString(), budgets: DEMO_BUDGETS });
    if (s0.status !== 'complete') throw new Error(`demo_s0_incomplete:${s0.gaps.join(',')}`);
    phases.set(identity.runId, { s0 });
    const preflight = { schemaVersion: 2, suiteEntryId, evidenceMode: 'synthetic_fixture',
      status: 'complete', observedAt: iso(), resolved, accounts: world.accounts };
    const baseline = { schemaVersion: 2, suiteEntryId, capturedAt: iso(), phase: s0,
      // Setup reads keep the reserved application identities and precede graph dispatch.
      sourceOracleHash: digest(suite.sourceLabels), actualHumanReviews: 0 };
    const record = { suiteEntryId, s0Hash: digest(baseline), registeredRunId: null as string | null };
    preparations.push(record);
    return { incident: resolved.data, title: world.github.technicalEvidence.title, register(writer, identity) {
      persistReferences(writer, preflight); persistReferences(writer, baseline);
      const preflightRef = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: preflight });
      const s0Ref = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: baseline });
      if (s0Ref.sha256 !== record.s0Hash) throw new Error('demo_s0_changed_before_dispatch');
      record.registeredRunId = identity.runId;
      return EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2, runId: identity.runId,
        evaluationAttemptId: identity.evaluationAttemptId, suiteEntryId, manifestHash: frozen.manifestHash,
        registeredAt: identity.at, dispatchAt: identity.at, preflightRef, s0Ref,
        configuration: suite.scenarios.configuration, leg: 'baseline' });
    } };
  }

  const approvalPolicy = { schemaVersion: 2 as const, workspaceId: world.slack.workspaceId,
    channelId: world.slack.channelId, reviewActorId: 'promiseguard_fake_bot', authorizedActorIds: [world.slack.approverId],
    ttlMs: world.policy.approvalTtlMs, sourceFreshnessMs: world.policy.sourceFreshnessMs,
    slackFreshnessMs: 30000, pollMs: 100, budgets: DEMO_BUDGETS };
  async function open() {
    return createComposition(config, { clock, modelClient: model.client,
      providers: { ...fake, readArtifact: fake.observer.readArtifact },
      monitor: options.monitorOutage ? undefined : { resolveManifest(registration) {
        if (registration.manifestHash !== frozen.manifestHash) throw new Error('demo_manifest_mismatch');
        return frozen.manifest;
      } },
      buildWorkflow: services => createWorkflowDefinition(services, { prepare, approvalPolicy, budgets: DEMO_BUDGETS,
        slack: { channelId: world.slack.channelId, threadTs: `${Math.floor(now / 1000)}.000000` },
        selectionPolicy: { schemaVersion: 2, allowedRepositories: [{ owner: 'promiseguard-fixture', name: 'payments',
          repositoryId: world.github.technicalEvidence.incident.repositoryId }], supportedServices: ['billing-api', 'analytics-api'],
          githubScope: { accountRef: world.accounts.github, requiredQueryIds: ['github.readTechnicalEvidence'] },
          hubspotScope: { accountRef: world.accounts.hubspot, requiredQueryIds: ['hubspot.readCommitmentBundle'] } },
        assess: async node => {
          const pair = phases.get(node.state.runId);
          if (!pair) throw new Error('demo_s0_not_available_after_restart');
          pair.s1 = await collector.collectPhase({ manifest: frozen.manifest, phase: 's1', runId: node.state.runId,
            evaluationAttemptId: node.state.evaluationAttemptId, runtimeAttemptId: node.state.runtimeAttemptId,
            evidenceMode: 'synthetic_fixture', incident: services.repository.getRun(node.state.runId)!.incident,
            deadlineAt: new Date(now + DEMO_BUDGETS.totalMs).toISOString(), budgets: DEMO_BUDGETS });
          // Q01's prewritten exact content slots differ from B03's frozen keys. Keep
          // the original oracle unchanged and disclose the unresolved export join.
          const gap = pair.s1.status === 'complete' ? 'frozen_oracle_content_binding_unverified' : 's1_collection_incomplete';
          assessmentGaps.set(node.state.runId, gap);
          node.transaction(writer => {
            persistReferences(writer, pair.s1);
            for (const observation of pair.s1!.observations) writer.recordObservation(observation);
            const evidenceRef = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json',
              content: { schemaVersion: 2, suiteEntryId, s0Hash: digest(pair.s0), s1: pair.s1,
                outcomeAssessment: 'unverified', gaps: [gap] } });
            writer.appendEvent({ kind: 'fault.recorded', faultId: gap, evidenceRef }, { eventId: randomUUID(),
              at: iso(), processId: 'simulated-collector', bootId: 'r01-demo-collector', monotonicMs: performance.now() });
          });
        },
      }),
    });
  }
  let services = await open();
  await services.start();
  return {
    get services() { return services; }, fake, model, directory, world, suite, frozen, ownerId, namespace, preparations, collector, phases, assessmentGaps,
    clock, advance(ms = 101) { now += ms; },
    async tick() { await services.driver.tick(); },
    async startRun() {
      const result = await services.driver.accept(world.github.technicalEvidence.incident.canonicalUrl, ownerId);
      await services.driver.tick(); return result;
    },
    async restart() { await services.close(); services = await open(); await services.start(); },
    approve(runId: string) {
      const plan = services.repository.getPlan(runId, 1);
      if (!plan) throw new Error('demo_plan_missing');
      const review = fake.observer.snapshot().slack.messages.find(message => message.body.includes(`promiseguard-review-${plan.planHash}`));
      if (!review) throw new Error('demo_review_missing');
      now += 1;
      // Operator-only synthetic message: the report never labels this an actual human interaction.
      fake.operator.appendHumanMessage({ workspaceId: world.slack.workspaceId, channelId: world.slack.channelId,
        threadTs: review.threadTs, messageTs: `${Math.floor(now / 1000)}.${String(now % 1000 * 1000).padStart(6, '0')}`, actorId: world.slack.approverId,
        isBot: false, subtype: null, editedAt: null, deleted: false, observedAt: iso(),
        body: `approve ${runId} ${plan.planHash}` }, { namespace, ownerId });
    },
    async close() { await services.close(); if (!options.directory) await rm(directory, { recursive: true, force: true }); },
  };
}

/** Optional actual operator review is interactive; imported label JSON cannot create this receipt. */
export async function reviewOriginalOutputs(harness: Awaited<ReturnType<typeof createDemoHarness>>, runId: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('human_review_requires_interactive_terminal');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const reviewerId = (await terminal.question('Your reviewer identity: ')).trim();
    const repository = harness.services.repository;
    const originals = ['analyst', 'drafter', 'auditor'].flatMap(role => repository.listOutputs(canonical([runId, 1, role])));
    for (const original of originals) {
      process.stdout.write(`\n${original.role} original output ${original.outputId}\n${repository.readArtifact(original.rawOutput)}\n`);
      process.stdout.write(`Original source digests: ${original.sourceDigests.join(', ')}\n`);
      const sourceBundle = repository.getRole(original.roleInvocationKey)!.context.snapshotBundleRef;
      process.stdout.write(`Original source bundle:\n${repository.readArtifact(sourceBundle)}\n`);
      const answer = (await terminal.question('After reviewing those original sources, enter pass, fail, or skip: ')).trim();
      if (answer === 'skip') continue;
      if (answer !== 'pass' && answer !== 'fail') throw new Error('human_review_invalid_decision');
      const reason = (await terminal.question('Explain your source-based judgment: ')).trim();
      const reviewedAt = new Date().toISOString();
      const state = harness.services.driver.readState(runId)!;
      repository.transaction({ producerVersion: 'r01-demo-v1', producerId: 'operator-review', runId: state.runId,
        evaluationAttemptId: state.evaluationAttemptId, runtimeAttemptId: state.runtimeAttemptId,
        stage: 'assess', spanId: `human-review-${randomUUID()}`, parentSpanId: null, causedBy: [] }, writer => {
        const stamp = () => ({ eventId: randomUUID(), at: reviewedAt, processId: `process-${process.pid}`,
          bootId: 'interactive-review', monotonicMs: performance.now() });
        writer.appendEvent({ kind: 'stage.started' }, stamp());
        const interactionRef = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: {
          kind: 'interactive_terminal_review', reviewerId, outputId: original.outputId, outputDigest: original.rawOutput.sha256,
          sourceDigests: original.sourceDigests, answer, reason, reviewedAt,
        } });
        writer.recordReviewLabel(ReviewLabelSchema.parse({ schemaVersion: 2, labelId: randomUUID(), runId,
          evaluationAttemptId: state.evaluationAttemptId, outputId: original.outputId, role: original.role,
          outputDigest: original.rawOutput.sha256, sourceDigests: original.sourceDigests,
          reviewer: { kind: 'human', reviewerId, interactionRef }, reviewedAt, reason,
          grounding: answer === 'pass', completeness: answer === 'pass', decision: 'uncertain', handoff: 'uncertain',
          findings: [], supersedesLabelId: null }));
        writer.appendEvent({ kind: 'fault.recorded', faultId: 'human-review-receipt', evidenceRef: interactionRef }, stamp());
        writer.appendEvent({ kind: 'stage.finished', outcome: 'succeeded' }, stamp());
      });
    }
  } finally { terminal.close(); }
}

async function main() {
  const harness = await createDemoHarness();
  try {
    const run = await harness.startRun();
    const waiting = harness.services.repository.getRun(run.runId)!.status;
    if (waiting !== 'awaiting_approval') throw new Error(`demo_expected_approval_wait:${waiting}`);
    await harness.restart();
    harness.approve(run.runId); harness.advance(); await harness.tick();
    const completed = harness.services.repository.getRun(run.runId)!.status;
    const beforeReplay = harness.fake.observer.history().length;
    const replay = await harness.startRun();
    const excessWrites = harness.fake.observer.history().length - beforeReplay;
    if (process.argv.includes('--review')) await reviewOriginalOutputs(harness, run.runId);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 2, evidenceMode: 'synthetic_fixture',
      liveProviders: false, actualHumanReviews: process.argv.includes('--review') ? 'see_review_receipts' : 0,
      runId: run.runId, suiteEntryId: harness.frozen.manifest.suiteEntryId, waiting, completed,
      replay: { disposition: replay.disposition, sameRun: replay.runId === run.runId, excessWrites },
      modelCalls: harness.model.calls.length, verifiedEffects: harness.services.driver.readState(run.runId)!.effects,
      independentCollection: { s0: harness.phases.get(run.runId)?.s0.status,
        s1: harness.phases.get(run.runId)?.s1?.status ?? 'unrun', gaps: [harness.assessmentGaps.get(run.runId)].filter(Boolean) },
      quality: 'unverified_without_independent_human_review', liveS1S2: 'unrun' }, null, 2)}\n`);
    if (completed !== 'completed' || excessWrites !== 0) process.exitCode = 1;
  } finally { await harness.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
