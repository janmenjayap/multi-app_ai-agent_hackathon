import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { statSync } from 'node:fs';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { CommandResultSchema, CreateRunCommandSchema, RunViewSchema, type CommandResult } from '../../shared/api.js';
import { ExecutionModeSchema, IncidentIdentitySchema, RunIdSchema, RuntimeAttemptIdSchema,
  EvaluationAttemptIdSchema, IdSchema, PIPELINE_STAGE_IDS, StageIdSchema, UtcTimestampSchema,
  type ExecutionMode, type IncidentIdentity, type RunStatus } from '../../shared/domain.js';
import { CompletionClaimSchema, EvaluationAttemptRegistrationSchema,
  type CompletionClaim, type EvaluationAttemptRegistration } from '../../shared/evaluation.js';
import { type EventContext, type EventPayload, type EventStamp } from '../observability/events.js';
import { ApplicationRepository, type ApplicationWriter } from '../storage/repositories.js';
import { type WorkflowCheckpoints } from '../storage/checkpoints.js';
import { WorkflowProjectionPatchSchema, WorkflowStateSchema, parseWorkflowState,
  type WorkflowProjectionPatch, type WorkflowState } from './state.js';

type StageId = z.infer<typeof StageIdSchema>;
type ClaimIdentity = 'schemaVersion' | 'claimId' | 'runId' | 'evaluationAttemptId' | 'runtimeAttemptId' | 'eventId' | 'sequence' | 'emittedAt';
type WithoutIdentity<T> = T extends CompletionClaim ? Omit<T, ClaimIdentity> : never;
export type CompletionProof = WithoutIdentity<CompletionClaim>;
type NodeCommit = { patch?: WorkflowProjectionPatch; persist?: (writer: ApplicationWriter) => void };
export type WorkflowNodeResult = NodeCommit & (
  | { kind: 'advance'; nextStage: StageId }
  | { kind: 'wait'; wakeAt: string; reason: string; awaitingApproval?: boolean; retry?: Extract<EventPayload, { kind: 'retry.scheduled' }> }
  | { kind: 'stop'; status: 'safely_blocked' | 'failed' | 'failed_partial'; reason: string }
  | { kind: 'complete'; proof: CompletionProof }
);
export interface WorkflowNodeContext {
  state: WorkflowState;
  eventContext: EventContext;
  signal: AbortSignal;
  /** Guarded, synchronous ledger work. No network operation belongs in this callback. */
  transaction<T>(action: (writer: ApplicationWriter) => T): T;
}
export type WorkflowNode = (context: WorkflowNodeContext) => Promise<WorkflowNodeResult>;
export interface PreparedWorkflowIdentity {
  runId: WorkflowState['runId'];
  evaluationAttemptId: WorkflowState['evaluationAttemptId'];
  runtimeAttemptId: WorkflowState['runtimeAttemptId'];
}
export interface PreparedWorkflow {
  /** Allocated by the driver before preflight; cannot be supplied by an API caller. */
  identity?: PreparedWorkflowIdentity;
  incident: IncidentIdentity;
  title: string;
  /** Prepared preflight/S0 receipts are persisted here; this callback cannot perform I/O. */
  register(writer: ApplicationWriter, identity: {
    runId: WorkflowState['runId']; evaluationAttemptId: WorkflowState['evaluationAttemptId'];
    runtimeAttemptId: WorkflowState['runtimeAttemptId']; at: string;
  }): EvaluationAttemptRegistration;
}
export interface WorkflowDriverOptions {
  repository: ApplicationRepository;
  checkpoints: WorkflowCheckpoints;
  configuration: ExecutionMode;
  /** Resolve provider-owned immutable IDs and prepare real receipts outside the transaction. */
  prepare(incidentUrl: string, operatorId: string, identity: PreparedWorkflowIdentity): Promise<PreparedWorkflow>;
  nodes: Partial<Record<StageId, WorkflowNode>>;
  /** B05/B08 inject read-only reconciliation here. No create operation is replayed automatically. */
  reconcile?: WorkflowNode;
  clock?: () => number;
  stageTimeoutMs?: number;
  runTimeoutMs?: number;
  pollMs?: number;
}
export class WorkflowCommandError extends Error {
  constructor(readonly code: 'forbidden' | 'not_found' | 'stale_revision' | 'unavailable' | 'conflict') { super(code); }
}
const graphState = Annotation.Root({ runId: Annotation<string>() });
const schedulers = new Map<string, WorkflowDriver>();
const nodeResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('advance'), nextStage: StageIdSchema }),
  z.object({ kind: z.literal('wait'), wakeAt: UtcTimestampSchema, reason: IdSchema, awaitingApproval: z.boolean().optional() }),
  z.object({ kind: z.literal('stop'), status: z.enum(['safely_blocked', 'failed', 'failed_partial']), reason: IdSchema }),
  z.object({ kind: z.literal('complete'), proof: z.unknown() }),
]);

/** One scheduler/process per application file. Multi-process execution requires a fenced lease design. */
export class WorkflowDriver {
  readonly repository: ApplicationRepository;
  readonly options: WorkflowDriverOptions;
  readonly bootId = `workflow-boot-${randomUUID()}`;
  readonly #clock: () => number;
  readonly #configuration: ExecutionMode;
  readonly #stageTimeoutMs: number;
  readonly #runTimeoutMs: number;
  readonly #pollMs: number;
  readonly #graph;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;
  #draining: Promise<void> | null = null;
  #controller: AbortController | null = null;
  #activeRun: string | null = null;
  #prepared = new Map<string, Promise<PreparedWorkflow>>();
  #lingering = new Set<string>();
  #ready = false;

  constructor(options: WorkflowDriverOptions) {
    this.options = options;
    this.repository = options.repository;
    this.#clock = options.clock ?? Date.now;
    this.#configuration = ExecutionModeSchema.parse(options.configuration);
    this.#stageTimeoutMs = z.number().int().min(1).max(300000).parse(options.stageTimeoutMs ?? 30000);
    this.#runTimeoutMs = z.number().int().min(1).max(86400000).parse(options.runTimeoutMs ?? 3600000);
    this.#pollMs = z.number().int().min(1).max(60000).parse(options.pollMs ?? 250);
    this.#graph = new StateGraph(graphState)
      .addNode('dispatch', async ({ runId }) => { await this.#step(runId); return { runId }; })
      .addEdge(START, 'dispatch')
      .addConditionalEdges('dispatch', ({ runId }) =>
        this.#running && this.readState(runId)?.scheduleStatus === 'queued' ? 'dispatch' : END)
      .compile({ checkpointer: options.checkpoints.saver });
  }

  #at(): string { return new Date(this.#clock()).toISOString(); }
  #stamp(): EventStamp { return { eventId: randomUUID(), at: this.#at(), processId: `process-${process.pid}`,
    bootId: this.bootId, monotonicMs: performance.now() }; }
  #context(state: WorkflowState): EventContext { return { producerVersion: 'workflow-v2', producerId: 'workflow-driver',
    runId: state.runId, evaluationAttemptId: state.evaluationAttemptId, runtimeAttemptId: state.runtimeAttemptId,
    stage: state.stage, spanId: state.spanId, parentSpanId: null, causedBy: state.lastEventId ? [state.lastEventId] : [] }; }
  #store(writer: ApplicationWriter, state: WorkflowState): void {
    const value = parseWorkflowState(state);
    const run = writer.getRun(value.runId)!;
    const absent = { status: 'unverified', coverage: 'unavailable', evaluatorVersion: null, assessmentRevision: null,
      observedAt: null, watermark: null, requiredCount: 0, confirmedCount: 0, humanLabelCount: null, gaps: [] };
    // Prevent committing a product state that cannot be represented honestly by F02.
    RunViewSchema.parse({ schemaVersion: 2, revision: run.revision, runId: run.runId,
      evaluationAttemptId: value.evaluationAttemptId, runtimeAttemptIds: value.runtimeAttemptIds,
      incident: { url: run.incident.canonicalUrl, title: value.incidentTitle, service: run.incident.service, environment: run.incident.environment },
      configuration: run.configuration, productStatus: run.status, statusReason: value.statusReason,
      stages: value.stages, commitments: value.commitments, plan: value.plan, approval: value.approval, effects: value.effects,
      assessments: { trace: absent, outcome: absent, firstProposal: absent, selectedPlan: null },
      report: null, reportAvailability: 'unavailable', createdAt: run.createdAt, updatedAt: run.updatedAt, verifiedAt: value.verifiedAt });
    writer.saveWorkflow({ runId: value.runId, ownerId: value.ownerId, evaluationAttemptId: value.evaluationAttemptId,
      runtimeAttemptId: value.runtimeAttemptId, state: value, scheduleStatus: value.scheduleStatus,
      wakeAt: value.wakeAt, deadlineAt: value.deadlineAt, updatedAt: this.#at() });
  }
  #emit(writer: ApplicationWriter, state: WorkflowState, payload: EventPayload): void {
    state.lastEventId = writer.appendEvent(payload, this.#stamp()).eventId;
  }
  #status(writer: ApplicationWriter, state: WorkflowState, status: RunStatus): void {
    writer.setRunStatus(status); this.#emit(writer, state, { kind: 'run.status', status });
  }
  #updateStage(state: WorkflowState, status: WorkflowState['stages'][number]['status'], reason: string | null = null): void {
    const stage = state.stages.find(value => value.stageId === state.stage)!;
    stage.status = status; stage.updatedAt = this.#at(); stage.reason = reason;
  }
  readState(runId: string): WorkflowState | null {
    const stored = this.repository.getWorkflow(runId);
    return stored ? parseWorkflowState(stored.state) : null;
  }
  storageReady(): boolean {
    try { this.repository.database.connection.prepare('SELECT 1 FROM workflow_invocations LIMIT 1').get(); return true; }
    catch { return false; }
  }
  checkpointsReady(): boolean {
    try { return this.#ready && !!this.options.checkpoints.saver.db.prepare('SELECT 1').get(); }
    catch { return false; }
  }

  async start(): Promise<void> {
    if (this.#running) return;
    if (!this.storageReady()) throw new WorkflowCommandError('unavailable');
    const file = String(this.repository.database.connection.prepare('PRAGMA database_list').get()?.file ?? '');
    const identity = file ? statSync(file) : null;
    const path = identity ? `${identity.dev}:${identity.ino}` : ':memory:';
    if (schedulers.has(path) && schedulers.get(path) !== this) throw new WorkflowCommandError('conflict');
    if (schedulers.get(path) === this) throw new WorkflowCommandError('conflict');
    schedulers.set(path, this);
    try {
      this.#ready = await this.options.checkpoints.ready();
      if (!this.storageReady() || !this.#ready) throw new WorkflowCommandError('unavailable');
      this.#running = true;
    } catch (error) { if (schedulers.get(path) === this) schedulers.delete(path); throw error; }
    this.#timer = setInterval(() => { this.#kick(); }, this.#pollMs);
    this.#timer.unref(); this.#kick();
  }
  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#controller?.abort();
    await this.#draining;
    for (const [path, driver] of schedulers) if (driver === this) schedulers.delete(path);
  }
  async flush(): Promise<void> { await this.#draining; }
  #kick(): void {
    if (!this.#running || this.#draining) return;
    // Timers, never HTTP promises, own execution; disconnects cannot cancel accepted work.
    this.#draining = new Promise<void>(resolve => setImmediate(resolve))
      .then(() => this.#drain()).finally(() => { this.#draining = null; });
    void this.#draining.catch(() => { this.#ready = false; });
  }
  /** Useful for deterministic scheduler clocks/tests; does not manufacture a run or graph node. */
  async tick(): Promise<void> { this.#kick(); await this.#draining; }

  async accept(incidentUrl: string, operatorId: string): Promise<CommandResult> {
    CreateRunCommandSchema.parse({ schemaVersion: 2, incidentUrl }); IdSchema.parse(operatorId);
    if (!this.storageReady() || !this.checkpointsReady()) throw new WorkflowCommandError('unavailable');
    const preparationKey = JSON.stringify([incidentUrl, operatorId]);
    let pending = this.#prepared.get(preparationKey);
    if (!pending) {
      const identity = { runId: RunIdSchema.parse(randomUUID()),
        evaluationAttemptId: EvaluationAttemptIdSchema.parse(randomUUID()),
        runtimeAttemptId: RuntimeAttemptIdSchema.parse(randomUUID()) };
      pending = this.options.prepare(incidentUrl, operatorId, Object.freeze(identity))
        .then(prepared => ({ ...prepared, identity }));
      this.#prepared.set(preparationKey, pending);
    }
    let prepared: PreparedWorkflow;
    try { prepared = await pending; }
    finally { if (this.#prepared.get(preparationKey) === pending) this.#prepared.delete(preparationKey); }
    const incident = IncidentIdentitySchema.parse(prepared.incident);
    const requestedRepository = new URL(incidentUrl).pathname.split('/').slice(1, 3).join('/').toLowerCase();
    const resolvedRepository = new URL(incident.canonicalUrl).pathname.split('/').slice(1, 3).join('/').toLowerCase();
    if (requestedRepository !== resolvedRepository) throw new WorkflowCommandError('forbidden');
    const existing = this.repository.findRunByIncident(incident.repositoryId, incident.issueId);
    if (existing) {
      const state = this.readState(existing.runId);
      if (!state) throw new WorkflowCommandError('conflict');
      if (state.ownerId !== operatorId) throw new WorkflowCommandError('forbidden');
      return this.#result(state, 'reopened');
    }
    const { runId, evaluationAttemptId, runtimeAttemptId } = prepared.identity!;
    const at = this.#at();
    const state = WorkflowStateSchema.parse({ schemaVersion: 2, runId, ownerId: operatorId, evaluationAttemptId,
      runtimeAttemptId, runtimeAttemptIds: [runtimeAttemptId], commandId: randomUUID(), incidentTitle: prepared.title,
      stage: 'ingest', spanId: randomUUID(), lastEventId: randomUUID(), bootId: null, spanOpen: false, waitId: null,
      deadlineAt: new Date(this.#clock() + this.#runTimeoutMs).toISOString(), stageDeadlineAt: null,
      stageTimeoutMs: this.#stageTimeoutMs, wakeAt: at, scheduleStatus: 'queued', statusReason: null,
      stages: PIPELINE_STAGE_IDS.map(stageId => ({ stageId, role: ['analyst', 'drafter', 'auditor'].includes(stageId) ? stageId : null,
        status: stageId === 'ingest' ? 'queued' : 'not_started', startedAt: null, updatedAt: null, attemptCount: 0, latestAttemptRef: null, reason: null })),
      commitments: { status: 'pending', policyVersion: null, selected: [], excluded: [], evidenceRefs: [] },
      plan: null, approval: null, effects: [], verifiedAt: null, references: {} });
    const context = { ...this.#context(state), causedBy: [] };
    this.repository.transaction(context, writer => {
      writer.createRun({ runId, incident, configuration: this.#configuration, createdAt: at });
      const registration = EvaluationAttemptRegistrationSchema.parse(prepared.register(writer, { runId, evaluationAttemptId, runtimeAttemptId, at }));
      writer.registerEvaluation(registration);
      writer.startRuntime({ runId, evaluationAttemptId, runtimeAttemptId, startedAt: at });
      // Acceptance has its own closed span; the first actual graph stage starts outside HTTP.
      this.#emit(writer, state, { kind: 'stage.started' });
      this.#status(writer, state, 'queued');
      this.#emit(writer, state, { kind: 'stage.finished', outcome: 'succeeded' });
      writer.saveCommand({ commandId: state.commandId, runId, operatorId, kind: 'create', expectedRevision: null, acceptedAt: at });
      this.#store(writer, state);
    });
    this.#kick(); return this.#result(state, 'created');
  }
  #result(state: WorkflowState, disposition: CommandResult['disposition']): CommandResult {
    const run = this.repository.getRun(state.runId)!;
    return CommandResultSchema.parse({ schemaVersion: 2, commandId: state.commandId,
      runId: run.runId, revision: run.revision, productStatus: run.status, disposition });
  }
  async reconcile(runId: string, expectedRevision: number, operatorId: string): Promise<CommandResult> {
    const state = this.readState(runId);
    if (!state) throw new WorkflowCommandError('not_found');
    if (state.ownerId !== operatorId) throw new WorkflowCommandError('forbidden');
    if (this.repository.getRun(runId)!.revision !== expectedRevision) throw new WorkflowCommandError('stale_revision');
    if (state.scheduleStatus !== 'stopped') return this.#result(state, 'already_scheduled');
    if (!this.options.reconcile || this.#lingering.has(runId) || state.runtimeAttemptIds.length >= 1000 || this.repository.getRun(runId)!.status !== 'failed_partial')
      return this.#result(state, 'not_eligible');
    const next = structuredClone(state);
    next.commandId = randomUUID(); next.runtimeAttemptId = RuntimeAttemptIdSchema.parse(randomUUID());
    next.runtimeAttemptIds.push(next.runtimeAttemptId); next.bootId = this.bootId; next.stage = 'verify'; next.spanId = randomUUID(); next.spanOpen = false;
    next.scheduleStatus = 'queued'; next.wakeAt = this.#at(); next.statusReason = 'reconcile_requested';
    if (this.#clock() >= Date.parse(next.deadlineAt)) return this.#result(state, 'not_eligible');
    this.repository.transaction(this.#context(next), writer => {
      writer.startRuntime({ runId: next.runId, evaluationAttemptId: next.evaluationAttemptId, runtimeAttemptId: next.runtimeAttemptId, startedAt: this.#at() });
      this.#emit(writer, next, { kind: 'stage.started' });
      this.#status(writer, next, 'queued');
      this.#emit(writer, next, { kind: 'stage.finished', outcome: 'succeeded' });
      writer.saveCommand({ commandId: next.commandId, runId, operatorId, kind: 'reconcile', expectedRevision, acceptedAt: this.#at() });
      this.#store(writer, next);
    });
    this.#kick(); return this.#result(next, 'scheduled');
  }

  async #drain(): Promise<void> {
    if (!this.#running || !this.#ready) return;
    for (const runId of this.repository.listEligibleWorkflow(this.#at())) {
      if (!this.#running) break;
      this.#activeRun = runId;
      try {
        await this.#graph.invoke({ runId }, { configurable: { thread_id: runId, checkpoint_ns: '' }, recursionLimit: 1000, durability: 'sync' });
      } catch {
        // The application ledger is ahead of (or equal to) the graph checkpoint.
        // Do not replay here after a checkpoint failure. A restart re-reads the ledger.
        this.#ready = false; break;
      } finally { this.#activeRun = null; }
    }
  }
  #begin(previous: WorkflowState): WorkflowState {
    const state = structuredClone(previous);
    const isRestart = state.bootId !== null && state.bootId !== this.bootId;
    if (state.spanOpen && state.waitId) {
      this.repository.transaction(this.#context(state), writer => {
        this.#emit(writer, state, { kind: 'wait.ended', waitId: state.waitId! });
        state.waitId = null; state.scheduleStatus = 'queued'; state.wakeAt = new Date(Math.min(this.#clock(), Date.parse(state.deadlineAt))).toISOString();
        if (isRestart) { this.#emit(writer, state, { kind: 'stage.finished', outcome: 'skipped' }); state.spanOpen = false; }
        this.#store(writer, state);
      });
    }
    if (isRestart) {
      state.runtimeAttemptId = RuntimeAttemptIdSchema.parse(randomUUID());
      state.runtimeAttemptIds.push(state.runtimeAttemptId);
      state.spanOpen = false;
    }
    if (!state.spanOpen) state.spanId = randomUUID();
    this.repository.transaction(this.#context(state), writer => {
      if (isRestart) writer.startRuntime({ runId: state.runId, evaluationAttemptId: state.evaluationAttemptId,
        runtimeAttemptId: state.runtimeAttemptId, startedAt: this.#at() });
      if (!state.spanOpen) {
        this.#emit(writer, state, { kind: 'stage.started' }); state.spanOpen = true;
        const stage = state.stages.find(value => value.stageId === state.stage)!;
        stage.attemptCount++; stage.startedAt ??= this.#at();
      }
      state.bootId = this.bootId; state.scheduleStatus = 'running'; state.wakeAt = null;
      state.stageDeadlineAt = new Date(Math.min(Date.parse(state.deadlineAt), this.#clock() + state.stageTimeoutMs)).toISOString();
      this.#updateStage(state, 'running'); this.#status(writer, state, 'running'); this.#store(writer, state);
    });
    return state;
  }
  async #step(runId: string): Promise<void> {
    const previous = this.readState(runId);
    if (!previous || previous.scheduleStatus === 'stopped' || !this.#running) return;
    const state = this.#begin(previous);
    // An interrupted node may have dispatched a model/provider call. Preserve its
    // unresolved original span and require explicit reconciliation, never a blind replay.
    if (previous.scheduleStatus === 'running') { this.#fail(state, 'interrupted_stage', true); return; }
    if (this.#clock() >= Date.parse(state.deadlineAt)) { this.#fail(state, 'budget_exhausted', false); return; }
    const node = state.statusReason === 'reconcile_requested' ? this.options.reconcile : this.options.nodes[state.stage];
    if (!node) { this.#fail(state, 'node_unavailable', false, 'safely_blocked'); return; }
    const controller = new AbortController(); this.#controller = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error('cancelled'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      timeout = setTimeout(() => { controller.abort(); }, Math.max(1, Date.parse(state.stageDeadlineAt!) - this.#clock()));
    });
    const running = Promise.resolve().then(() => node({ state: parseWorkflowState(state), eventContext: this.#context(state), signal: controller.signal,
      transaction: action => {
        const current = this.readState(runId);
        if (controller.signal.aborted || current?.runtimeAttemptId !== state.runtimeAttemptId ||
            current.spanId !== state.spanId || current.scheduleStatus !== 'running') throw new Error('stale_workflow_invocation');
        return this.repository.transaction(this.#context(state), action);
      } }));
    this.#lingering.add(runId);
    void running.then(() => this.#lingering.delete(runId), () => this.#lingering.delete(runId));
    try {
      const result = await Promise.race([running, cancelled]);
      nodeResultSchema.parse(result);
      this.#finish(state, result);
    } catch {
      this.#fail(state, controller.signal.aborted ? (this.#running ? 'stalled' : 'interrupted_stage') : 'node_failed', controller.signal.aborted);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
      controller.abort();
      this.#controller = null;
    }
  }
  #partial(state: WorkflowState): boolean {
    return state.stage === 'execute' || state.stage === 'verify' ||
      !!this.repository.database.connection.prepare("SELECT 1 FROM effects WHERE run_id=? AND state!='planned' LIMIT 1").get(state.runId);
  }
  #fail(state: WorkflowState, reason: string, unresolved: boolean, status?: 'safely_blocked'): void {
    const next = structuredClone(state);
    this.repository.transaction(this.#context(next), writer => {
      if (!unresolved) { this.#emit(writer, next, { kind: 'stage.finished', outcome: status ? 'blocked' : 'failed' }); next.spanOpen = false; }
      next.scheduleStatus = 'stopped'; next.wakeAt = null; next.waitId = null; next.statusReason = reason;
      this.#updateStage(next, unresolved ? 'unknown' : status ? 'blocked' : 'failed', reason);
      this.#status(writer, next, this.#partial(next) ? 'failed_partial' : status ?? 'failed'); this.#store(writer, next);
    });
  }
  #finish(state: WorkflowState, result: WorkflowNodeResult): void {
    const next = structuredClone(state);
    if (result.patch) Object.assign(next, WorkflowProjectionPatchSchema.parse(result.patch));
    this.repository.transaction(this.#context(next), writer => {
      if (result.persist?.constructor.name === 'AsyncFunction') throw new Error('async_node_persistence');
      const persisted: unknown = result.persist?.(writer);
      if (persisted && (typeof persisted === 'object' || typeof persisted === 'function') && 'then' in persisted)
        throw new Error('async_node_persistence');
      if (result.kind === 'wait') {
        const wakeAt = UtcTimestampSchema.parse(result.wakeAt);
        if (Date.parse(wakeAt) <= this.#clock() || Date.parse(wakeAt) > Date.parse(next.deadlineAt)) throw new Error('invalid_wait_deadline');
        if (result.awaitingApproval && (next.stage !== 'approval' || !next.plan || next.approval?.status !== 'waiting')) throw new Error('approval_wait_missing_plan');
        if (result.retry) this.#emit(writer, next, result.retry);
        next.waitId = randomUUID(); next.wakeAt = wakeAt; next.scheduleStatus = 'waiting'; next.statusReason = result.reason;
        next.stageDeadlineAt = null; this.#updateStage(next, 'waiting', result.reason);
        this.#emit(writer, next, { kind: 'wait.started', waitId: next.waitId, reason: result.reason });
        this.#status(writer, next, result.awaitingApproval ? 'awaiting_approval' : 'running');
      } else {
        this.#emit(writer, next, { kind: 'stage.finished', outcome: result.kind === 'stop' ? result.status === 'safely_blocked' ? 'blocked' : 'failed' : 'succeeded' });
        next.spanOpen = false; next.waitId = null; next.statusReason = null;
        this.#updateStage(next, result.kind === 'stop' ? result.status === 'safely_blocked' ? 'blocked' : 'failed' : 'succeeded');
        if (result.kind === 'advance') {
          // R01 may branch from complete empty selection directly to verification.
          if (PIPELINE_STAGE_IDS.indexOf(result.nextStage) <= PIPELINE_STAGE_IDS.indexOf(next.stage)) throw new Error('nonforward_workflow_stage');
          for (const skipped of next.stages.slice(PIPELINE_STAGE_IDS.indexOf(next.stage) + 1, PIPELINE_STAGE_IDS.indexOf(result.nextStage))) {
            skipped.status = 'skipped'; skipped.updatedAt = this.#at();
          }
          next.stage = result.nextStage; next.scheduleStatus = 'queued'; next.wakeAt = this.#at(); next.stageDeadlineAt = null;
          this.#status(writer, next, 'running');
        } else if (result.kind === 'stop') {
          next.scheduleStatus = 'stopped'; next.wakeAt = null; next.statusReason = result.reason;
          this.#status(writer, next, this.#partial(next) ? 'failed_partial' : result.status);
        } else {
          const stamp = this.#stamp();
          const claim = CompletionClaimSchema.parse({ ...result.proof, schemaVersion: 2, claimId: randomUUID(), runId: next.runId,
            evaluationAttemptId: next.evaluationAttemptId, runtimeAttemptId: next.runtimeAttemptId,
            eventId: stamp.eventId, sequence: writer.getRun(next.runId)!.eventSequence + 1, emittedAt: stamp.at });
          if (claim.scope === 'artifacts') throw new Error('run_completion_requires_full_scope');
          next.lastEventId = writer.appendEvent({ kind: 'success.claimed', claim }, stamp).eventId;
          next.scheduleStatus = 'stopped'; next.wakeAt = null; next.verifiedAt = claim.emittedAt;
          this.#status(writer, next, claim.scope === 'no_affected' ? 'completed_no_affected_commitments' : 'completed');
        }
      }
      this.#store(writer, next);
    });
  }
}
