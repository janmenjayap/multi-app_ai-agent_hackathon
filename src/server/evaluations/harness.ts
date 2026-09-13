import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ReadCallContextSchema } from '../../shared/adapters.js';
import { ExecutionModeSchema, RestrictedArtifactRefSchema, canonical, immutable,
  type ExecutionMode, type RestrictedArtifactRef } from '../../shared/domain.js';
import { EvaluationAttemptRegistrationSchema, SuiteEntrySchema,
  type EvaluationAttemptRegistration, type SuiteEntry } from '../../shared/evaluation.js';
import { digest } from '../../shared/reliability.js';
import { createEvidenceCollector, type CollectedProviderPhase } from './collector.js';
import { createScenarioManifest, type FixtureSuite, type ScenarioEntry } from './manifest.js';
import type { ProviderReaderSet } from './provider-readers.js';
import type { CheckerLedgerEvent } from './export-checker.js';
import type { PreparedWorkflow, PreparedWorkflowIdentity, WorkflowDriver } from '../workflow/driver.js';
import { ApplicationDatabase } from '../storage/database.js';
import { ApplicationRepository, type ApplicationWriter } from '../storage/repositories.js';
import { processApplicationJobs, readApplicationObservation, readApplicationReport } from '../monitoring/worker.js';

export const HARNESS_VERSION = 'scenario-harness-v1';
export const HARNESS_READ_BUDGETS = { timeoutMs: 5000, totalMs: 15000, maxAttempts: 1,
  maxPages: 100, maxRecords: 1000, maxResponseBytes: 1000000 };

export interface ScenarioPreparation {
  identity: PreparedWorkflowIdentity;
  incidentUrl: string;
  operatorId: string;
  runtime: { readers: ProviderReaderSet; readArtifact(id: string): string | null;
    clock(): number; world: FixtureSuite['world'] };
}
export interface ScenarioRuntime {
  services: { repository: ApplicationRepository; driver: WorkflowDriver };
  clock(): number;
  startRun(): Promise<{ runId: string }>;
  executeActorSchedule(runId: string): Promise<unknown>;
  close(): Promise<void>;
  /** Extra operator effects only; executor history is read from the durable event ledger. */
  operationHistory?(): readonly CheckerLedgerEvent[];
  historyComplete?(): boolean;
  diagnostics?(): unknown;
}
export interface ScenarioRuntimeOptions {
  suite: FixtureSuite;
  entry: ScenarioEntry;
  directory: string;
  prepare(input: ScenarioPreparation): Promise<PreparedWorkflow>;
}
export interface HarnessOptions {
  suite: FixtureSuite;
  directory: string;
  /** Actual source release and implementation versions, separate from the frozen oracle versions. */
  release: { source: string; app: string; model: string; prompt: string; policy: string; schema: string };
  configuration?: ExecutionMode;
  runtimeFactory(options: ScenarioRuntimeOptions): Promise<ScenarioRuntime>;
  support(entry: ScenarioEntry): { supported: boolean; reason?: string };
}
export interface HarnessAttempt {
  registration: EvaluationAttemptRegistration;
  databasePath: string;
  resultRef: RestrictedArtifactRef | null;
  productStatus: string | null;
  diagnostics: string[];
}
export interface HarnessReport {
  schemaVersion: 2;
  harnessVersion: typeof HARNESS_VERSION;
  suiteHash: string;
  suiteId: string;
  configuration: ExecutionMode;
  release: HarnessOptions['release'];
  versions: FixtureSuite['scenarios']['versions'];
  evaluatorVersion: 'monitor-v2';
  revision: number;
  census: SuiteEntry[];
  frozenEntries: readonly ScenarioEntry[];
  attempts: HarnessAttempt[];
  diagnostics: string[];
  targets: { families: 18; baselineRepetition: 42; live: { scenario: string; disposition: 'not_run'; reason: string }[] };
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown_harness_error';
  // Diagnostics must not leak provider bodies, URLs, keys, or model output.
  return /^[a-z][a-z0-9_:-]{0,180}$/.test(message) ? message : 'harness_operation_failed';
}

/** One serial executor per output directory; every slot exists before the first provider read. */
export function createScenarioHarness(options: HarnessOptions) {
  const { suite } = options;
  const directory = resolve(options.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const configuration = ExecutionModeSchema.parse(options.configuration ?? suite.scenarios.configuration);
  const latestPath = join(directory, 'census.json');
  const lockPath = join(directory, 'harness.lock');
  function acquireLock() {
    try { writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(lockPath, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('harness_directory_locked');
      try { process.kill(pid, 0); throw new Error('harness_directory_locked'); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; }
      unlinkSync(lockPath);
      writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
    }
  }
  if (existsSync(lockPath)) {
    acquireLock(); unlinkSync(lockPath);
  }
  const initial: HarnessReport = { schemaVersion: 2, harnessVersion: HARNESS_VERSION,
    suiteHash: suite.suiteHash, suiteId: suite.scenarios.suiteId, configuration, release: options.release,
    versions: suite.scenarios.versions, evaluatorVersion: 'monitor-v2', revision: 0,
    census: suite.scenarios.entries.map(entry => ({ suiteEntryId: entry.suiteEntryId, disposition: 'not_run', reason: 'not_selected' })),
    frozenEntries: suite.scenarios.entries, attempts: [], diagnostics: [], targets: { families: 18, baselineRepetition: 42,
      live: ['golden', 'replay', 'stale_approval', 'draft_verification', 'safe_block'].map(scenario =>
        ({ scenario, disposition: 'not_run', reason: 'live_account_preflight_not_run' })) } };
  let state: HarnessReport = existsSync(latestPath) ? JSON.parse(readFileSync(latestPath, 'utf8')) : initial;
  if (state.harnessVersion !== HARNESS_VERSION || state.suiteHash !== suite.suiteHash ||
      canonical(state.release) !== canonical(options.release) || canonical(state.configuration) !== canonical(configuration))
    throw new Error('harness_cohort_identity_mismatch');
  state.census = state.census.map(entry => SuiteEntrySchema.parse(entry));
  if (canonical(state.census.map(entry => entry.suiteEntryId).sort()) !==
      canonical(suite.scenarios.entries.map(entry => entry.suiteEntryId).sort())) throw new Error('harness_census_incomplete');
  state.attempts.forEach(attempt => EvaluationAttemptRegistrationSchema.parse(attempt.registration));
  let running = false;
  const slot = (id: string) => state.census.findIndex(entry => entry.suiteEntryId === id);
  const caseDirectory = (id: string) => join(directory, id);
  function artifact(value: unknown): RestrictedArtifactRef {
    const bytes = canonical(value), sha256 = digest(value), artifactId = `q04-${sha256}`;
    const artifactDirectory = join(directory, 'artifacts');
    mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
    const path = join(artifactDirectory, `${artifactId}.json`);
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    else if (readFileSync(path, 'utf8') !== bytes) throw new Error('harness_artifact_integrity_mismatch');
    return { artifactId, sha256, byteLength: Buffer.byteLength(bytes), mediaType: 'application/json' };
  }
  function save() {
    if (existsSync(latestPath) && JSON.parse(readFileSync(latestPath, 'utf8')).revision !== state.revision)
      throw new Error('harness_census_changed_reopen_required');
    do { state.revision++; } while (existsSync(join(directory, `census-${state.revision}.json`)));
    const snapshot = canonical(state);
    writeFileSync(join(directory, `census-${state.revision}.json`), snapshot, { flag: 'wx', mode: 0o600 });
    const temporary = join(directory, `census-${randomUUID()}.tmp`);
    writeFileSync(temporary, snapshot, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, latestPath);
  }
  function reconcile(repository: ApplicationRepository, entry: ScenarioEntry) {
    const rows = repository.database.connection.prepare('SELECT manifest_json FROM attempts WHERE schema_version=2').all();
    if (rows.length > 1) throw new Error('harness_multiple_attempts_for_slot');
    const registration = rows[0] ? EvaluationAttemptRegistrationSchema.parse(JSON.parse(String(rows[0].manifest_json))) : null;
    if (!registration) return null;
    if (registration.suiteEntryId !== entry.suiteEntryId || canonical(registration.configuration) !== canonical(configuration))
      throw new Error('harness_registered_identity_mismatch');
    let attempt = state.attempts.find(item => item.registration.evaluationAttemptId === registration.evaluationAttemptId);
    if (attempt && canonical(attempt.registration) !== canonical(registration)) throw new Error('harness_registration_changed');
    if (!attempt) {
      if (state.attempts.some(item => item.registration.suiteEntryId === entry.suiteEntryId)) throw new Error('harness_attempt_identity_changed');
      attempt = { registration, databasePath: join(caseDirectory(entry.suiteEntryId), 'application.sqlite'),
        resultRef: null, productStatus: repository.getRun(registration.runId)?.status ?? null, diagnostics: ['registered_result_pending'] };
      state.attempts.push(attempt);
      state.census[slot(entry.suiteEntryId)] = { suiteEntryId: entry.suiteEntryId, disposition: 'attempted',
        evaluationAttemptId: registration.evaluationAttemptId, result: 'pending' };
    }
    return attempt;
  }
  // A crash after the DB transaction but before census publication remains an attempted sample.
  for (const entry of suite.scenarios.entries) {
    const path = join(caseDirectory(entry.suiteEntryId), 'application.sqlite');
    if (!existsSync(path)) continue;
    const database = new ApplicationDatabase(path);
    try { reconcile(new ApplicationRepository(database), entry); } finally { database.close(); }
  }
  acquireLock();
  try { save(); } finally { unlinkSync(lockPath); }

  async function execute(entry: ScenarioEntry) {
    const current = state.census[slot(entry.suiteEntryId)];
    // Reopening/resuming the harness never creates a new attempt or overwrites an adverse result.
    if (current.disposition !== 'not_run') return;
    const supported = options.support(entry);
    if (!supported.supported) {
      state.census[slot(entry.suiteEntryId)] = { suiteEntryId: entry.suiteEntryId, disposition: 'not_run',
        reason: supported.reason ?? 'schedule_not_supported' }; save(); return;
    }
    let runtime: ScenarioRuntime | undefined;
    let collector: ReturnType<typeof createEvidenceCollector> | undefined;
    let preparation: ScenarioPreparation | undefined;
    let s0: CollectedProviderPhase | undefined;
    let preparedWorkflow: PreparedWorkflow | undefined;
    let setupEvidence: unknown = null;
    const captured = new Map<string, { ref: RestrictedArtifactRef; value: unknown }>();
    const frozen = createScenarioManifest(suite, entry.suiteEntryId);
    const manifest = { ...frozen.manifest, mode: configuration.evidenceMode };
    const gaps: string[] = [];
    function persist(writer: ApplicationWriter, value: unknown, seen = new Set<string>()) {
      const parsed = RestrictedArtifactRefSchema.safeParse(value);
      if (parsed.success) {
        const ref = parsed.data;
        if (seen.has(ref.artifactId)) return;
        seen.add(ref.artifactId);
        const saved = captured.get(ref.artifactId);
        const bytes = saved ? null : preparation?.runtime.readArtifact(ref.artifactId);
        if (!saved && bytes == null) throw new Error('harness_evidence_artifact_missing');
        const content = saved ? saved.value : ref.mediaType === 'application/json' ? JSON.parse(bytes!) : bytes!;
        const actual = writer.putArtifact({ artifactId: ref.artifactId, mediaType: ref.mediaType, content });
        if (canonical(actual) !== canonical(ref)) throw new Error('harness_evidence_artifact_changed');
        persist(writer, content, seen);
      } else if (Array.isArray(value)) value.forEach(item => persist(writer, item, seen));
      else if (value && typeof value === 'object') Object.values(value).forEach(item => persist(writer, item, seen));
    }
    function archiveSetup(value: unknown) {
      const originals = new Map<string, { ref: RestrictedArtifactRef; bytes: string }>();
      const missingArtifactIds: string[] = [];
      function visit(child: unknown) {
        const reference = RestrictedArtifactRefSchema.safeParse(child);
        if (reference.success) {
          const ref = reference.data;
          if (originals.has(ref.artifactId)) return;
          const saved = captured.get(ref.artifactId);
          const bytes = saved ? canonical(saved.value) : preparation?.runtime.readArtifact(ref.artifactId);
          if (bytes == null) { missingArtifactIds.push(ref.artifactId); return; }
          originals.set(ref.artifactId, { ref, bytes });
          if (ref.mediaType === 'application/json') visit(JSON.parse(bytes));
        } else if (Array.isArray(child)) child.forEach(visit);
        else if (child && typeof child === 'object') Object.values(child).forEach(visit);
      }
      visit(value);
      return { value, originals: [...originals.values()], missingArtifactIds };
    }
    try {
      runtime = await options.runtimeFactory({ suite, entry, directory: caseDirectory(entry.suiteEntryId),
        async prepare(input) {
          if (preparedWorkflow) return preparedWorkflow;
          preparation = input;
          const { readers, world, clock } = input.runtime;
          for (const app of ['github', 'hubspot', 'gmail', 'slack'] as const) {
            if (readers[app].scope.accountRef !== world.accounts[app] || readers[app].mode !== configuration.providerMode)
              throw new Error('harness_preflight_scope_mismatch');
          }
          const context = ReadCallContextSchema.parse({ schemaVersion: 2, ...input.identity,
            spanId: randomUUID(), logicalCallId: randomUUID(), providerAttemptId: randomUUID(),
            app: 'github', accountRef: world.accounts.github, mode: configuration.providerMode, operation: 'github.resolveIncident',
            deadlineAt: new Date(clock() + HARNESS_READ_BUDGETS.totalMs).toISOString(), budgets: HARNESS_READ_BUDGETS });
          const resolved = await readers.github.resolveIncident(input.incidentUrl, { ...context, operation: 'github.resolveIncident' });
          setupEvidence = { resolved };
          if (resolved.status !== 'complete' || !resolved.data) throw new Error('harness_preflight_failed');
          collector = createEvidenceCollector({ readers, identity: { version: HARNESS_VERSION,
            processId: 'scenario-collector', bootId: randomUUID() }, createId: () => randomUUID(),
            writeArtifact(artifactId, value) {
              const ref: RestrictedArtifactRef = { artifactId, sha256: digest(value), mediaType: 'application/json', byteLength: Buffer.byteLength(canonical(value)) };
              captured.set(artifactId, { ref, value }); return ref;
            } });
          s0 = await collector.collectPhase({ manifest, phase: 's0', ...input.identity, evidenceMode: configuration.evidenceMode,
            incident: resolved.data, deadlineAt: context.deadlineAt, budgets: HARNESS_READ_BUDGETS });
          const preflight = { schemaVersion: 2, suiteEntryId: entry.suiteEntryId, configuration, release: options.release,
            observedAt: new Date(clock()).toISOString(), resolved, status: 'complete' };
          const baseline = { schemaVersion: 2, suiteEntryId: entry.suiteEntryId, suiteHash: suite.suiteHash, phase: s0 };
          setupEvidence = { preflight, baseline };
          artifact(archiveSetup(setupEvidence));
          if (s0.status !== 'complete') throw new Error('harness_s0_incomplete');
          const s0Hash = digest(baseline);
          preparedWorkflow = { incident: resolved.data, title: world.github.technicalEvidence.title, register(writer, identity) {
            persist(writer, preflight); persist(writer, baseline);
            const preflightRef = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: preflight });
            const s0Ref = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: baseline });
            if (s0Ref.sha256 !== s0Hash) throw new Error('harness_s0_changed_before_dispatch');
            return EvaluationAttemptRegistrationSchema.parse({ schemaVersion: 2, runId: identity.runId,
              evaluationAttemptId: identity.evaluationAttemptId, suiteEntryId: entry.suiteEntryId,
              manifestHash: digest(manifest), registeredAt: identity.at, dispatchAt: identity.at,
              preflightRef, s0Ref, configuration, leg: entry.leg });
          } };
          return preparedWorkflow;
        } });
      const accepted = await runtime.startRun();
      const attempt = reconcile(runtime.services.repository, entry);
      if (!attempt) throw new Error('harness_registration_missing');
      save();
      await runtime.executeActorSchedule(accepted.runId);
      const runtimeDiagnostics = runtime.diagnostics?.();
      if (runtimeDiagnostics && typeof runtimeDiagnostics === 'object' && 'gaps' in runtimeDiagnostics && Array.isArray(runtimeDiagnostics.gaps))
        gaps.push(...runtimeDiagnostics.gaps.filter((value): value is string => typeof value === 'string'));
      const repository = runtime.services.repository;
      const workflow = runtime.services.driver.readState(accepted.runId)!;
      const productStatus = repository.getRun(accepted.runId)!.status;
      attempt.productStatus = productStatus;
      const s1 = await collector!.collectPhase({ manifest, phase: 's1', runId: accepted.runId,
        evaluationAttemptId: attempt.registration.evaluationAttemptId, runtimeAttemptId: workflow.runtimeAttemptId,
        evidenceMode: configuration.evidenceMode, incident: repository.getRun(accepted.runId)!.incident,
        deadlineAt: new Date(runtime.clock() + HARNESS_READ_BUDGETS.totalMs).toISOString(), budgets: HARNESS_READ_BUDGETS });
      gaps.push(...s1.gaps);
      const monitor = { resolveManifest: () => manifest, clock: runtime.clock };
      const observation = readApplicationObservation(repository, attempt.registration.evaluationAttemptId, monitor);
      let final: ReturnType<ReturnType<typeof createEvidenceCollector>['finalizeEvidence']> | undefined;
      try {
        if (productStatus === 'queued' || productStatus === 'running') throw new Error('workflow_not_terminal');
        // Content references remain frozen. Missing joins are explicit gaps, never copies from S1.
        const plan = observation.plan;
        const planRef = workflow.references.plan;
        const contentBindings = manifest.effects.flatMap(effect => Object.values(effect.requiredFields).flatMap(value => {
          if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'approved_content') return [];
          const content = plan?.contents.find(item => item.contentKey === value.contentKey);
          return content && planRef ? [{ schemaVersion: 2 as const, contentRef: value, source: 'approved_plan' as const,
            planHash: plan!.planHash, planReceipt: planRef, text: content.text, contentDigest: content.sha256 }] : [];
        }));
        const uniqueBindings = [...new Map(contentBindings.map(binding => [canonical(binding.contentRef), binding])).values()];
        final = collector!.finalizeEvidence({ manifest, s0: s0!, s1, observedTerminalStatus: productStatus,
          plan, contentBindings: uniqueBindings, events: observation.events, readMutationOutcome: observation.readMutationOutcome,
          operationHistory: runtime.operationHistory?.(), historyComplete: runtime.historyComplete?.() ?? false });
      } catch (error) { gaps.push(errorCode(error)); }
      const checks: { code: string; status: 'passed' | 'failed' | 'unverified' }[] = [];
      checks.push({ code: 'expected_terminal_status', status: productStatus === entry.expectedTerminalStatus ? 'passed' :
        ['queued', 'running', 'awaiting_approval'].includes(productStatus) ? 'unverified' : 'failed' });
      for (const effect of manifest.effects) {
        const records = s1.records[effect.app].filter(record => record.effectKey === effect.effectKey);
        checks.push({ code: `required_${effect.kind}`, status: s1.status !== 'complete' ? 'unverified' : records.length === 1 ? 'passed' : 'failed' });
        if (records.length !== 1) continue;
        for (const [field, expected] of Object.entries(effect.requiredFields)) {
          if (expected && typeof expected === 'object' && (!Array.isArray(expected) || expected.some(value => typeof value === 'object'))) continue;
          checks.push({ code: `${effect.kind}_${field}`, status: canonical(records[0].fields[field] ?? null) === canonical(expected) ? 'passed' : 'failed' });
        }
      }
      // Provider IDs from dispatch only locate a fresh independent record. They
      // cannot repair the frozen oracle's unresolved logical identity bindings.
      for (const effect of observation.plan?.effects ?? []) {
        const dispatched = repository.getEffect(effect.effectKey);
        if (!dispatched?.providerId) continue;
        const records = s1.records[effect.app].filter(record => record.id === dispatched.providerId);
        checks.push({ code: `approved_required_${effect.kind}`, status: s1.status !== 'complete' ? 'unverified' :
          records.length === 1 ? 'passed' : 'failed' });
        if (records.length !== 1) continue;
        for (const [field, expected] of Object.entries(effect.payload)) {
          if (!['to', 'cc', 'bcc', 'subject', 'ownerId', 'dueAt', 'status', 'companyId', 'commitmentId'].includes(field)) continue;
          checks.push({ code: `approved_${effect.kind}_${field}`, status:
            canonical(records[0].fields[field] ?? null) === canonical(expected) ? 'passed' : 'failed' });
        }
      }
      const eventContext = { producerId: 'scenario-collector', producerVersion: HARNESS_VERSION,
        runId: workflow.runId, evaluationAttemptId: attempt.registration.evaluationAttemptId,
        runtimeAttemptId: workflow.runtimeAttemptId, stage: 'assess' as const, spanId: randomUUID(), parentSpanId: null, causedBy: [] };
      repository.transaction(eventContext, writer => {
        const stamp = () => ({ eventId: randomUUID(), at: new Date(runtime!.clock()).toISOString(), processId: 'scenario-collector',
          bootId: 'q04-collection', monotonicMs: performance.now() });
        writer.appendEvent({ kind: 'stage.started' }, stamp());
        persist(writer, s1);
        for (const item of s0!.observations) if (!writer.getObservation(item.observationId)) writer.recordObservation(item);
        for (const item of s1.observations) writer.recordObservation(item);
        const evidenceRef = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: { s1, gaps, checks } });
        writer.appendEvent({ kind: 'fault.recorded', faultId: 'q04-independent-collection', evidenceRef }, stamp());
        writer.appendEvent({ kind: 'stage.finished', outcome: 'succeeded' }, stamp());
      });
      const monitorOptions = { ...monitor, loadEvidence: () => final ? { outcomeEvidence: final.outcomeEvidence,
        checkerExportBinding: final.checkerExportBinding, isTrustedOutcome: collector!.isTrustedOutcomeEvidence } : {} };
      const jobs = processApplicationJobs(repository, { ...monitorOptions, maxJobs: 100 });
      const report = readApplicationReport(repository, monitorOptions);
      const assessment = report.assessments.find(item => item.evaluationAttemptId === attempt.registration.evaluationAttemptId);
      const original = readApplicationObservation(repository, attempt.registration.evaluationAttemptId, monitorOptions);
      const result: 'failed' | 'passed' | 'pending' | 'unverified' = checks.some(check => check.status === 'failed') || assessment?.status === 'failed' ? 'failed' :
        gaps.length || checks.some(check => check.status === 'unverified') ? 'unverified' : assessment?.status === 'passed' ? 'passed' :
          assessment?.status === 'pending' ? 'pending' : 'unverified';
      attempt.resultRef = artifact({ schemaVersion: 2, suiteEntryId: entry.suiteEntryId, registration: attempt.registration,
        sourceRelease: options.release, expectedTerminalStatus: entry.expectedTerminalStatus, productStatus,
        s0: attempt.registration.s0Ref, s1, checks, gaps, report, jobs, originalOutputs: original.originalOutputs,
        events: original.events, labels: original.labels, actualHumanReviews: original.labels?.filter(label => label.reviewer.kind === 'human').length ?? 0,
        runtimeDiagnostics: runtime.diagnostics?.() ?? null });
      attempt.diagnostics = [...new Set(gaps)];
      state.census[slot(entry.suiteEntryId)] = { suiteEntryId: entry.suiteEntryId, disposition: 'attempted',
        evaluationAttemptId: attempt.registration.evaluationAttemptId, result };
    } catch (error) {
      const reason = errorCode(error);
      const attempt = runtime ? reconcile(runtime.services.repository, entry) : null;
      if (attempt) {
        attempt.diagnostics.push(reason);
        state.census[slot(entry.suiteEntryId)] = { suiteEntryId: entry.suiteEntryId, disposition: 'attempted',
          evaluationAttemptId: attempt.registration.evaluationAttemptId, result: 'pending' };
      } else state.census[slot(entry.suiteEntryId)] = { suiteEntryId: entry.suiteEntryId, disposition: 'setup_failed', reason,
        receiptRef: artifact({ schemaVersion: 2, suiteEntryId: entry.suiteEntryId, reason, phase: 'before_registration',
          observedAt: new Date().toISOString(), evidence: archiveSetup(setupEvidence), s0: s0 ?? null }) };
      state.diagnostics.push(`${entry.suiteEntryId}:${reason}`);
    } finally {
      save();
      if (runtime) await runtime.close();
    }
  }
  function report() {
    const counts = { planned: state.census.length, attempted: 0, passed: 0, failed: 0, pending: 0, unverified: 0, setupFailed: 0, unrun: 0 };
    for (const entry of state.census) {
      if (entry.disposition === 'attempted') { counts.attempted++; counts[entry.result]++; }
      else if (entry.disposition === 'setup_failed') counts.setupFailed++;
      else counts.unrun++;
    }
    return immutable({ ...structuredClone(state), counts, reportPath: latestPath });
  }
  return { report, async run(entryIds?: string[]) {
    if (running) throw new Error('harness_already_running');
    const ids = entryIds ?? suite.scenarios.entries.map(entry => entry.suiteEntryId);
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => slot(id) < 0)) throw new Error('harness_invalid_selection');
    acquireLock();
    running = true;
    try {
      // Preserve the requested first four smoke cases, then stable frozen census order.
      for (const id of ids) await execute(suite.scenarios.entries.find(entry => entry.suiteEntryId === id)!);
      return report();
    } finally { running = false; unlinkSync(lockPath); }
  } };
}
