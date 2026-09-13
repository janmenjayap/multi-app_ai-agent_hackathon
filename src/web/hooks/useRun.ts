import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acceptEventsPage, acceptRunView, assertPublicProjection, CursorSchema, TraceViewSchema,
  type CommandResult, type RunEventView, type RunView, type TraceView,
} from '../../shared/api.js';
import { canonical, RunIdSchema } from '../../shared/domain.js';
import { ConsoleApiError, createApiClient, type RunApiClient } from '../api/client.js';

const STORAGE_KEY = 'promiseguard.run.v2';
const MAX_BACKOFF_MS = 30_000;
type Connection = 'connected' | 'reconnecting' | 'offline' | 'session_expired' | 'unauthorized';
type SavedRun = { runId: string; cursor?: string };

function savedRun(): SavedRun | null {
  if (typeof window === 'undefined') return null;
  let saved: SavedRun | null = null;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (value && typeof value === 'object' && 'runId' in value && RunIdSchema.safeParse(value.runId).success) {
      saved = { runId: value.runId as string };
      if ('cursor' in value && CursorSchema.safeParse(value.cursor).success) saved.cursor = value.cursor as string;
    }
  } catch { /* Storage is optional; a URL can still reopen the durable run. */ }
  const fromUrl = new URL(window.location.href).searchParams.get('run');
  if (fromUrl && RunIdSchema.safeParse(fromUrl).success) return saved?.runId === fromUrl ? saved : { runId: fromUrl };
  return saved;
}

function remember(value: SavedRun) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* Private browsing may disable storage. */ }
  const url = new URL(window.location.href);
  url.searchParams.set('run', value.runId);
  window.history.replaceState(window.history.state, '', url);
}

function transportError(error: unknown): ConsoleApiError {
  return error instanceof ConsoleApiError ? error : new ConsoleApiError('invalid_response');
}

function attemptId(attempt: TraceView['attempts'][number]): string {
  return attempt.type === 'model' ? attempt.modelAttemptId : attempt.providerAttemptId;
}

function acceptTrace(previous: TraceView | null, run: RunView, incoming: TraceView, minimumRevision: number): TraceView {
  const page = TraceViewSchema.parse(incoming);
  assertPublicProjection(page);
  if (page.runId !== run.runId || page.evaluationAttemptId !== run.evaluationAttemptId ||
      page.runRevision < Math.max(run.revision, previous?.runRevision ?? 0, minimumRevision) ||
      (previous?.assessment.assessmentRevision && page.assessment.assessmentRevision &&
        page.assessment.assessmentRevision < previous.assessment.assessmentRevision) ||
      page.attempts.some(attempt => !run.runtimeAttemptIds.includes(attempt.runtimeAttemptId))) {
    throw new ConsoleApiError('stale_response');
  }
  const attempts = new Map((previous?.attempts ?? []).map(attempt => [attemptId(attempt), attempt]));
  for (const attempt of page.attempts) {
    const prior = attempts.get(attemptId(attempt));
    if (prior && (prior.type !== attempt.type || prior.runtimeAttemptId !== attempt.runtimeAttemptId ||
        prior.logicalCallId !== attempt.logicalCallId || prior.startedAt !== attempt.startedAt ||
        (prior.finishedAt !== null && attempt.finishedAt === null) ||
        (prior.type === 'model' && attempt.type === 'model' && (prior.role !== attempt.role || prior.modelVersion !== attempt.modelVersion ||
          prior.promptVersion !== attempt.promptVersion || prior.outputSchemaVersion !== attempt.outputSchemaVersion)))) {
      throw new ConsoleApiError('stale_response');
    }
    attempts.set(attemptId(attempt), attempt);
  }
  return { ...page, attempts: [...attempts.values()] };
}

/** The browser observes durable server work. Closing it cancels reads only. */
export function useRun({ client: suppliedClient, pollIntervalMs = 2_000 }: { client?: RunApiClient; pollIntervalMs?: number } = {}) {
  const [defaultClient] = useState(createApiClient);
  const client = suppliedClient ?? defaultClient;
  const [initial] = useState(savedRun);
  const [runId, setRunId] = useState(initial?.runId ?? null);
  const target = useRef(initial);
  const [run, setRun] = useState<RunView | null>(null);
  const [trace, setTrace] = useState<TraceView | null>(null);
  const [events, setEvents] = useState<RunEventView[]>([]);
  const [connection, setConnection] = useState<Connection>('connected');
  const [error, setError] = useState<ConsoleApiError | null>(null);
  const [pending, setPending] = useState(false);
  const [commandResult, setCommandResult] = useState<CommandResult | null>(null);
  const [refresh, setRefresh] = useState(0);
  const runRef = useRef<RunView | null>(null);
  const traceRef = useRef<TraceView | null>(null);
  const eventMap = useRef(new Map<string, RunEventView>());
  const eventCursors = useRef(new Set<string>());
  const traceCursors = useRef(new Set<string>());
  const minimumRevision = useRef(0);
  // Outages can temporarily omit evidence; keep its revision floor in memory.
  const reportRevisions = useRef(new Map<string, number>());
  const reportCutoffs = useRef(new Map<string, number>());
  const assessmentRevisions = useRef(new Map<string, number>());
  const commandPending = useRef(false);
  const commandError = useRef<ConsoleApiError | null>(null);
  const authStopped = useRef(false);
  const mounted = useRef(false);
  const interval = Math.max(100, pollIntervalMs);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const fail = useCallback((cause: unknown) => {
    const next = transportError(cause);
    setError(next);
    if (next.code === 'unauthenticated') {
      authStopped.current = true;
      setConnection('session_expired');
    } else if (next.code === 'forbidden' || next.code === 'csrf_failed') {
      authStopped.current = true;
      setConnection('unauthorized');
    } else setConnection(next.code === 'offline' ? 'offline' : 'reconnecting');
    return next;
  }, []);

  useEffect(() => {
    if (!runId || authStopped.current) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const controller = new AbortController();
    const current = () => active && target.current?.runId === runId;
    const poll = async () => {
      let hasMore = false;
      try {
        const incoming = await client.getRun(runId, controller.signal);
        if (!current()) return;
        if (incoming.runId !== runId || incoming.revision < minimumRevision.current) throw new ConsoleApiError('stale_response');
        let nextRun: RunView;
        try { nextRun = acceptRunView(runRef.current, incoming); }
        catch { throw new ConsoleApiError('stale_response'); }
        if ((runRef.current?.evaluationAttemptId && nextRun.evaluationAttemptId !== runRef.current.evaluationAttemptId) ||
            runRef.current?.runtimeAttemptIds.some(id => !nextRun.runtimeAttemptIds.includes(id))) {
          throw new ConsoleApiError('stale_response');
        }
        if (nextRun.report && (nextRun.report.revision < (reportRevisions.current.get(nextRun.report.reportId) ?? 0) ||
            Date.parse(nextRun.report.cutoffAt) < (reportCutoffs.current.get(nextRun.report.cohortId) ?? 0))) {
          throw new ConsoleApiError('stale_response');
        }
        for (const [key, assessment] of Object.entries(nextRun.assessments)) {
          if (assessment?.assessmentRevision && assessment.assessmentRevision < (assessmentRevisions.current.get(key) ?? 0)) {
            throw new ConsoleApiError('stale_response');
          }
        }
        if (nextRun.report) {
          reportRevisions.current.set(nextRun.report.reportId, nextRun.report.revision);
          reportCutoffs.current.set(nextRun.report.cohortId, Date.parse(nextRun.report.cutoffAt));
        }
        for (const [key, assessment] of Object.entries(nextRun.assessments)) {
          if (assessment?.assessmentRevision) assessmentRevisions.current.set(key, assessment.assessmentRevision);
        }
        runRef.current = nextRun;
        minimumRevision.current = nextRun.revision;
        setRun(nextRun);

        const requestedCursor = target.current?.cursor;
        const incomingEvents = await client.getEvents(runId, requestedCursor, controller.signal);
        if (!current()) return;
        let page;
        try { page = acceptEventsPage({ runId: nextRun.runId, revision: minimumRevision.current }, incomingEvents); }
        catch { throw new ConsoleApiError('stale_response'); }
        if ((page.hasMore && (!page.events.length || page.nextCursor === requestedCursor)) ||
            (page.nextCursor !== requestedCursor && eventCursors.current.has(page.nextCursor))) throw new ConsoleApiError('stale_response');
        const nextEvents = new Map(eventMap.current);
        let lastSequence = [...nextEvents.values()].at(-1)?.sequence ?? 0;
        for (const event of page.events) {
          const previous = nextEvents.get(event.eventId);
          if (previous) {
            if (canonical(previous) !== canonical(event)) throw new ConsoleApiError('stale_response');
          } else {
            if (event.sequence <= lastSequence || page.nextCursor === requestedCursor) throw new ConsoleApiError('stale_response');
            nextEvents.set(event.eventId, event);
            lastSequence = event.sequence;
          }
        }
        eventMap.current = nextEvents;
        eventCursors.current.add(page.nextCursor);
        minimumRevision.current = Math.max(minimumRevision.current, page.runRevision);
        target.current = { runId, cursor: page.nextCursor };
        remember(target.current);
        setEvents([...nextEvents.values()]);
        hasMore = page.hasMore;

        const requestedTraceCursor = traceRef.current?.nextCursor;
        const tracePage = await client.getTrace(runId, requestedTraceCursor, controller.signal);
        if (!current()) return;
        if ((tracePage.hasMore && (!tracePage.attempts.length || tracePage.nextCursor === requestedTraceCursor)) ||
            (tracePage.nextCursor !== requestedTraceCursor && traceCursors.current.has(tracePage.nextCursor))) throw new ConsoleApiError('stale_response');
        const nextTrace = acceptTrace(traceRef.current, nextRun, tracePage, minimumRevision.current);
        traceRef.current = nextTrace;
        traceCursors.current.add(nextTrace.nextCursor);
        minimumRevision.current = Math.max(minimumRevision.current, nextTrace.runRevision);
        setTrace(nextTrace);
        hasMore ||= nextTrace.hasMore;
        failures = 0;
        // A successful read must not erase a command's authorization failure.
        if (!authStopped.current) {
          setConnection('connected');
          setError(commandError.current);
        }
      } catch (cause) {
        if (!current() || controller.signal.aborted || authStopped.current) return;
        fail(cause);
        failures += 1;
      } finally {
        if (current() && !authStopped.current) {
          const backoff = Math.min(MAX_BACKOFF_MS, interval * 2 ** Math.min(failures, 8));
          const delay = failures ? Math.min(MAX_BACKOFF_MS, backoff * (0.8 + Math.random() * 0.4)) : hasMore ? 0 : interval;
          timer = setTimeout(() => { void poll(); }, delay);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    };
  }, [client, runId, refresh, interval, fail]);

  const reconnect = useCallback(() => {
    authStopped.current = false;
    commandError.current = null;
    setConnection(target.current ? 'reconnecting' : 'connected');
    setError(null);
    setRefresh(value => value + 1);
  }, []);

  const command = useCallback(async (incidentUrl?: string) => {
    if (commandPending.current || authStopped.current) return;
    const existing = runRef.current;
    if (incidentUrl === undefined && (!existing || existing.productStatus !== 'failed_partial')) return;
    commandPending.current = true;
    commandError.current = null;
    setPending(true);
    setError(null);
    try {
      // No AbortSignal or automatic retry: loss of a response cannot prove the command failed.
      const result = incidentUrl === undefined
        ? await client.reconcile(existing!.runId, existing!.revision)
        : await client.createRun(incidentUrl);
      if (incidentUrl === undefined && (result.runId !== existing!.runId || result.revision < existing!.revision)) {
        throw new ConsoleApiError('stale_response');
      }
      if (target.current?.runId === result.runId && result.revision < minimumRevision.current) throw new ConsoleApiError('stale_response');
      if (!mounted.current) {
        if (incidentUrl !== undefined) remember({ runId: result.runId });
        return;
      }
      const isNewRun = target.current?.runId !== result.runId;
      if (isNewRun) {
        target.current = { runId: result.runId };
        runRef.current = null;
        traceRef.current = null;
        eventMap.current.clear();
        eventCursors.current.clear();
        traceCursors.current.clear();
        minimumRevision.current = result.revision;
        reportRevisions.current.clear();
        reportCutoffs.current.clear();
        assessmentRevisions.current.clear();
        setRun(null);
        setTrace(null);
        setEvents([]);
      } else minimumRevision.current = Math.max(minimumRevision.current, result.revision);
      remember(target.current!);
      setCommandResult(result);
      setRunId(result.runId);
      setConnection('reconnecting');
      setRefresh(value => value + 1);
    } catch (cause) {
      if (mounted.current) {
        commandError.current = transportError(cause);
        fail(commandError.current);
      }
    } finally {
      commandPending.current = false;
      if (mounted.current) setPending(false);
    }
  }, [client, fail]);

  const start = useCallback((incidentUrl: string) => command(incidentUrl), [command]);
  const reconcile = useCallback(() => command(), [command]);
  return { run, trace, events, connection, error, pending, commandResult, start, reconcile, reconnect };
}
