import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { API_ROUTES, AssessmentReadSchema, AssessmentsViewSchema, CommandResultSchema,
  CreateRunCommandSchema, CursorSchema, EvaluationReadSchema, ReconcileRunCommandSchema,
  RedactedReferenceSchema, RunEventsPageSchema, RunViewSchema, TraceViewSchema,
  assertPublicProjection, type AssessmentSummaryView, type CommandResult,
  type RunView, type TraceAttemptView } from '../../shared/api.js';
import { IdSchema, canonical, type RestrictedArtifactRef } from '../../shared/domain.js';
import type { EventV2 } from '../../shared/events.js';
import { collectArtifactReferences, toPublicEvent } from '../observability/events.js';
import type { ApplicationRepository, StoredRun } from '../storage/repositories.js';
import { ApiRequestError, registerApiErrors, requireIncidentAccess, requireOperator, requireRunAccess,
  type ApiAuthOptions, type OperatorSession } from './auth.js';
import { probeReady } from './health.js';

export interface RunStateProjection extends Pick<RunView, 'statusReason' | 'stages' | 'commitments' | 'plan' | 'approval' | 'effects' | 'verifiedAt'> {
  incidentTitle: string;
  evaluationAttemptId: string;
  runtimeAttemptIds: readonly string[];
  ownerId: string;
}
export interface RunCommandDriver {
  accept(incidentUrl: string, operatorId: string): CommandResult | Promise<CommandResult>;
  reconcile(runId: string, expectedRevision: number, operatorId: string): CommandResult | Promise<CommandResult>;
  readState(runId: string): RunStateProjection | null;
}
export interface RunApiOptions {
  driver: RunCommandDriver;
  repository: ApplicationRepository;
  auth: ApiAuthOptions;
  monitorReady?: () => boolean;
  /** Q03 adapts its persisted receipt to F02. Absence cannot become a passing summary. */
  readAssessments?: (evaluationAttemptId: string, watermark: number, saved: Readonly<Record<string, unknown>>) => RunView['assessments'] | null;
  /** Q05 supplies a saved, authorized report projection. No report means unavailable. */
  readEvaluation?: (session: OperatorSession, runId?: string) => unknown;
}
const runParams = z.object({ id: IdSchema }).strict();
const pageQuery = z.object({ after: CursorSchema.optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).strict();
const cursorValue = z.object({ v: z.literal(2), runId: IdSchema, stream: z.enum(['events', 'trace']), sequence: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().max(100000).optional() }).strict();
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiRequestError('invalid_request');
  return parsed.data;
}
function cursor(runId: string, stream: 'events' | 'trace', sequence: number, offset?: number): string {
  return Buffer.from(JSON.stringify({ v: 2, runId, stream, sequence, ...(offset === undefined ? {} : { offset }) })).toString('base64url');
}
function afterCursor(value: string | undefined, run: StoredRun, stream: 'events' | 'trace'): { sequence: number; offset: number } {
  if (!value) return { sequence: 0, offset: 0 };
  try {
    const parsed = cursorValue.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (parsed.runId !== run.runId || parsed.stream !== stream || parsed.sequence > run.eventSequence ||
        (stream === 'events' && parsed.offset !== undefined) ||
        value !== cursor(parsed.runId, parsed.stream, parsed.sequence, parsed.offset)) throw new Error();
    return { sequence: parsed.sequence, offset: parsed.offset ?? 0 };
  } catch { throw new ApiRequestError('invalid_request'); }
}

/** Walk only an already schema-validated public shape; private artifact bodies are never read. */
function redact<T>(value: T, session: OperatorSession): T {
  const walk = (current: unknown): unknown => {
    const ref = RedactedReferenceSchema.safeParse(current);
    if (ref.success) {
      if (ref.data.availability !== 'available') return ref.data;
      if (!session.allowedEvidenceIds?.includes(ref.data.referenceId))
        return { ...ref.data, availability: 'unauthorized', href: null };
      return ref.data;
    }
    if (Array.isArray(current)) return current.map(walk);
    if (current && typeof current === 'object') return Object.fromEntries(Object.entries(current).map(([key, child]) => [key, walk(child)]));
    return current;
  };
  const result = walk(value) as T;
  assertPublicProjection(result);
  return result;
}
function evidenceReference(ref: RestrictedArtifactRef | undefined) {
  return ref ? { referenceId: ref.artifactId, label: 'Restricted evidence', availability: 'unavailable' as const, href: null } : null;
}
function absentAssessment(code: string, status: 'pending' | 'unverified' = 'unverified'): AssessmentSummaryView {
  return { status, coverage: 'unavailable', evaluatorVersion: null, assessmentRevision: null, observedAt: null,
    watermark: null, requiredCount: 0, confirmedCount: 0, humanLabelCount: null, gaps: [{ code, referenceId: null }] };
}
function readAssessments(options: RunApiOptions, state: RunStateProjection): RunView['assessments'] {
  let missing = absentAssessment('monitor_unavailable');
  if (probeReady(options.monitorReady)) {
    try {
      const monitor = options.repository.database.monitor;
      const row = options.repository.database.connection.prepare('SELECT watermark FROM attempts WHERE evaluation_attempt_id=? AND schema_version=2')
        .get(state.evaluationAttemptId);
      const job = monitor.listJobsV2(state.evaluationAttemptId).find(item => item.watermark === Number(row?.watermark));
      const value = monitor.listAssessmentsV2(state.evaluationAttemptId).at(-1);
      if (job?.status === 'completed' && value?.watermark === Number(row?.watermark)) {
        const projected = options.readAssessments?.(state.evaluationAttemptId, job.watermark, value);
        if (projected) return AssessmentsViewSchema.parse(projected);
        missing = absentAssessment('assessment_projection_unavailable');
      } else {
        missing = job?.status === 'exhausted' ? absentAssessment('measurement_job_exhausted') :
          absentAssessment(row ? 'measurement_pending' : 'assessment_unavailable', row ? 'pending' : 'unverified');
      }
    } catch { /* Monitor failures must not hide durable product progress. */ }
  }
  return { trace: missing, outcome: missing, firstProposal: missing, selectedPlan: state.plan ? missing : null };
}

function readEvaluation(options: RunApiOptions, session: OperatorSession, runId?: string) {
  if (!options.readEvaluation || !probeReady(options.monitorReady)) return EvaluationReadSchema.parse({ schemaVersion: 2, availability: 'unavailable', report: null });
  try { return redact(EvaluationReadSchema.parse(options.readEvaluation(session, runId)), session); }
  catch { return EvaluationReadSchema.parse({ schemaVersion: 2, availability: 'unavailable', report: null }); }
}

export function readRunView(options: RunApiOptions, runId: string, session: OperatorSession): RunView {
  const run = options.repository.getRun(runId), state = options.driver.readState(runId);
  if (!run || !state) throw new ApiRequestError('not_found');
  requireRunAccess(session, run, state.ownerId);
  const report = readEvaluation(options, session, runId);
  const view = RunViewSchema.parse({ schemaVersion: 2, revision: 1, runId: run.runId,
    evaluationAttemptId: state.evaluationAttemptId, runtimeAttemptIds: state.runtimeAttemptIds,
    incident: { url: run.incident.canonicalUrl, title: state.incidentTitle, service: run.incident.service, environment: run.incident.environment },
    configuration: run.configuration, productStatus: run.status, statusReason: state.statusReason, stages: state.stages,
    commitments: state.commitments, plan: state.plan, approval: state.approval, effects: state.effects,
    assessments: readAssessments(options, state), report: report.report, reportAvailability: report.availability,
    createdAt: run.createdAt, updatedAt: run.updatedAt, verifiedAt: state.verifiedAt });
  const redacted = redact(view, session);
  // Persist content revisions independently of event sequences; assessment completion can change a view.
  const fingerprint = createHash('sha256').update(canonical(redacted)).digest('hex');
  redacted.revision = options.repository.getPublicRevision(runId, fingerprint);
  return redacted;
}

function allEvents(repository: ApplicationRepository, run: StoredRun): EventV2[] {
  const events: EventV2[] = [];
  let afterSequence = 0;
  while (afterSequence < run.eventSequence) {
    const page = repository.readEvents({ runId: run.runId, afterSequence, limit: 1000 });
    if (!page.length) break;
    events.push(...page.filter(event => event.sequence <= run.eventSequence));
    if (events.length > 100000) throw new ApiRequestError('unavailable');
    afterSequence = page.at(-1)!.sequence;
  }
  return events;
}

function traceAttempts(events: EventV2[], options: RunApiOptions, status: StoredRun['status']): Array<{ sequence: number; attempt: TraceAttemptView }> {
  const attempts = new Map<string, { sequence: number; attempt: TraceAttemptView }>();
  const protectedAttempts = new Set<string>();
  for (const event of events) {
    if (event.kind === 'model.attempt.started') attempts.set(event.modelAttemptId, { sequence: event.sequence, attempt: {
      type: 'model', runtimeAttemptId: event.runtimeAttemptId, logicalCallId: event.logicalCallId, modelAttemptId: event.modelAttemptId,
      role: event.role, startedAt: event.at, finishedAt: null, latencyMs: null, reference: null, outcome: 'running',
      modelVersion: event.modelVersion, promptVersion: event.promptVersion, outputSchemaVersion: event.outputSchemaVersion, originalOutputRef: null } });
    if (event.kind === 'tool.dispatch') {
      if (event.actor === 'executor' || event.actor === 'coordinator') protectedAttempts.add(event.providerAttemptId);
      const persisted = options.repository.getProviderAttempt(event.providerAttemptId);
      // No configured transport string is substituted for an actual attempt receipt.
      if (persisted) attempts.set(event.providerAttemptId, { sequence: event.sequence, attempt: {
        type: 'provider', runtimeAttemptId: event.runtimeAttemptId, logicalCallId: event.logicalCallId,
        providerAttemptId: event.providerAttemptId, app: event.app, operation: event.operation,
        transport: persisted.context.mode, startedAt: event.at, finishedAt: null, latencyMs: null, reference: null,
        transportOutcome: 'pending', providerOutcome: 'pending', reconciliation: 'not_required', readbackRef: null } });
    }
    const id = 'modelAttemptId' in event ? event.modelAttemptId : 'providerAttemptId' in event ? event.providerAttemptId : null;
    const existing = id ? attempts.get(id) : undefined;
    if (existing && existing.attempt.type === 'model' && (event.kind === 'model.attempt.result' || event.kind === 'model.attempt.error')) {
      existing.sequence = event.sequence; existing.attempt.finishedAt = event.at; existing.attempt.latencyMs = event.latencyMs;
      existing.attempt.outcome = event.kind === 'model.attempt.result' ? event.validation : 'error';
      if (event.kind === 'model.attempt.result') existing.attempt.originalOutputRef = evidenceReference(event.outputRef);
    }
    if (existing && existing.attempt.type === 'provider' && (event.kind === 'tool.result' || event.kind === 'tool.error')) {
      existing.sequence = event.sequence; existing.attempt.finishedAt = event.at;
      existing.attempt.latencyMs = event.kind === 'tool.result' ? event.latencyMs : null;
      existing.attempt.transportOutcome = event.kind === 'tool.result' ? event.transportOutcome : event.errorCode === 'timeout' ? 'timeout' : 'error';
      existing.attempt.providerOutcome = event.kind === 'tool.result' ? event.providerOutcome : event.outcome === 'unknown' ? 'unknown' : 'error';
      existing.attempt.reconciliation = existing.attempt.providerOutcome === 'unknown' ? 'pending' : 'not_required';
      if (event.kind === 'tool.result') existing.attempt.reference = evidenceReference(event.receiptRef);
    }
    if (event.kind === 'effect.reconciled' || event.kind === 'effect.verified') {
      const dispatch = events.findLast(candidate => candidate.kind === 'tool.dispatch' && candidate.effectKey === event.effectKey &&
        candidate.sequence < event.sequence && (candidate.actor === 'executor' || candidate.actor === 'coordinator'));
      const target = dispatch?.kind === 'tool.dispatch' ? attempts.get(dispatch.providerAttemptId) : undefined;
      if (target?.attempt.type === 'provider') {
        target.sequence = event.sequence; target.attempt.readbackRef = evidenceReference(event.receiptRef);
        if (event.kind === 'effect.reconciled') target.attempt.reconciliation = event.resolution;
      }
    }
  }
  if (!['queued', 'running', 'awaiting_approval'].includes(status)) {
    const terminalSequence = events.filter(event => event.kind === 'run.status').at(-1)?.sequence ?? 0;
    for (const item of attempts.values()) if (item.attempt.finishedAt === null) {
      item.sequence = Math.max(item.sequence, terminalSequence);
      if (item.attempt.type === 'model') item.attempt.outcome = 'unknown';
      else {
        item.attempt.transportOutcome = 'unknown'; item.attempt.providerOutcome = 'unknown';
        if (protectedAttempts.has(item.attempt.providerAttemptId) && item.attempt.reconciliation === 'not_required')
          item.attempt.reconciliation = 'pending';
      }
    }
  }
  return [...attempts.values()].sort((a, b) => a.sequence - b.sequence);
}

export function registerRunRoutes(app: FastifyInstance, options: RunApiOptions): void {
  registerApiErrors(app);
  const authorize = async (request: FastifyRequest, reply: FastifyReply, command = false) => {
    reply.header('cache-control', 'no-store');
    return requireOperator(request, options.auth, command);
  };
  const commandResult = (result: CommandResult, session: OperatorSession) => {
    const view = readRunView(options, result.runId, session);
    return CommandResultSchema.parse({ ...result, revision: view.revision, productStatus: view.productStatus });
  };
  app.post(API_ROUTES.createRun, async (request, reply) => {
    const session = await authorize(request, reply, true);
    const command = input(CreateRunCommandSchema, request.body);
    requireIncidentAccess(session, command.incidentUrl);
    const existing = options.repository.database.connection.prepare("SELECT run_id FROM runs WHERE json_extract(incident_json,'$.canonicalUrl')=?").get(command.incidentUrl);
    if (existing) readRunView(options, String(existing.run_id), session);
    const result = await options.driver.accept(command.incidentUrl, session.operatorId);
    reply.code(202);
    return commandResult(result, session);
  });
  app.get(API_ROUTES.run, async (request, reply) => {
    const session = await authorize(request, reply);
    return readRunView(options, input(runParams, request.params).id, session);
  });
  app.post(API_ROUTES.reconcile, async (request, reply) => {
    const session = await authorize(request, reply, true), runId = input(runParams, request.params).id;
    const command = input(ReconcileRunCommandSchema, request.body), view = readRunView(options, runId, session);
    if (command.expectedRevision !== view.revision) throw new ApiRequestError('stale_revision');
    const storedRevision = options.repository.getRun(runId)!.revision;
    const result = await options.driver.reconcile(runId, storedRevision, session.operatorId);
    reply.code(202);
    return commandResult(result, session);
  });
  app.get(API_ROUTES.events, async (request, reply) => {
    const session = await authorize(request, reply), runId = input(runParams, request.params).id;
    const view = readRunView(options, runId, session), run = options.repository.getRun(runId)!;
    const query = input(pageQuery, request.query), after = afterCursor(query.after, run, 'events').sequence;
    const fetched = options.repository.readEvents({ runId, afterSequence: after, limit: query.limit + 1 });
    const events = fetched.slice(0, query.limit).map(event => ({ ...toPublicEvent(event), reference: evidenceReference(collectArtifactReferences(event)[0]) }));
    return redact(RunEventsPageSchema.parse({ schemaVersion: 2, runId, runRevision: view.revision, events,
      nextCursor: cursor(runId, 'events', events.at(-1)?.sequence ?? after), hasMore: fetched.length > query.limit }), session);
  });
  app.get(API_ROUTES.assessments, async (request, reply) => {
    const session = await authorize(request, reply), view = readRunView(options, input(runParams, request.params).id, session);
    return AssessmentReadSchema.parse({ schemaVersion: 2, runId: view.runId, runRevision: view.revision, assessments: view.assessments });
  });
  app.get(API_ROUTES.trace, async (request, reply) => {
    const session = await authorize(request, reply), runId = input(runParams, request.params).id;
    const view = readRunView(options, runId, session), run = options.repository.getRun(runId)!;
    const query = input(pageQuery, request.query), after = afterCursor(query.after, run, 'trace');
    let previousSequence = -1, offset = 0;
    const allAttempts = traceAttempts(allEvents(options.repository, run), options, run.status).map(item => {
      offset = item.sequence === previousSequence ? offset + 1 : 1; previousSequence = item.sequence;
      return { ...item, offset };
    });
    const attempts = allAttempts.filter(item => item.sequence > after.sequence || (item.sequence === after.sequence && item.offset > after.offset));
    const page = attempts.slice(0, query.limit), hasMore = attempts.length > query.limit;
    return redact(TraceViewSchema.parse({ schemaVersion: 2, runId, runRevision: view.revision,
      evaluationAttemptId: view.evaluationAttemptId, assessment: view.assessments.trace, attempts: page.map(item => item.attempt),
      nextCursor: hasMore ? cursor(runId, 'trace', page.at(-1)!.sequence, page.at(-1)!.offset) :
        cursor(runId, 'trace', run.eventSequence, allAttempts.filter(item => item.sequence === run.eventSequence).length), hasMore }), session);
  });
  for (const route of [API_ROUTES.latestEvaluation, API_ROUTES.metrics]) app.get(route, async (request, reply) => {
    const session = await authorize(request, reply);
    return readEvaluation(options, session);
  });
}
