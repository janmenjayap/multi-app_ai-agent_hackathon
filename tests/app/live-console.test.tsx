import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, RunEventsPage, RunEventView, RunView, TraceView } from '../../src/shared/api.js';
import { EvaluationAttemptIdSchema } from '../../src/shared/domain.js';
import { ConsoleApiError, createApiClient, type RunApiClient } from '../../src/web/api/client.js';
import { DEMO_FIXTURES } from '../../src/web/fixtures/demo.js';
import { useRun } from '../../src/web/hooks/useRun.js';

const STORAGE_KEY = 'promiseguard.run.v2';
const fixture = DEMO_FIXTURES.find(item => item.run?.productStatus === 'completed' && item.run.report !== null)!;
const baseline = () => structuredClone(fixture.run!);
const commandResult = (run: RunView, disposition: CommandResult['disposition'] = 'reopened'): CommandResult => ({
  schemaVersion: 2, commandId: 'test-command-1', runId: run.runId, revision: run.revision,
  productStatus: run.productStatus, disposition,
});
const event = (sequence: number, eventId = `test-event-${sequence}`): RunEventView => ({
  eventId, sequence, stageId: 'ingest', kind: 'stage.started', at: '2026-09-14T09:00:00.000Z', reference: null,
});
const page = (run: RunView, events: RunEventView[] = [], nextCursor = 'events_0'): RunEventsPage => ({
  schemaVersion: 2, runId: run.runId, runRevision: run.revision, events, nextCursor, hasMore: false,
});
const tracePage = (run: RunView): TraceView => ({
  schemaVersion: 2, runId: run.runId, runRevision: run.revision, evaluationAttemptId: run.evaluationAttemptId,
  assessment: run.assessments.trace, attempts: [], nextCursor: 'trace_0', hasMore: false,
});
function api(run = baseline()) {
  return {
    createRun: vi.fn<RunApiClient['createRun']>().mockResolvedValue(commandResult(run)),
    getRun: vi.fn<RunApiClient['getRun']>().mockResolvedValue(run),
    getEvents: vi.fn<RunApiClient['getEvents']>().mockResolvedValue(page(run)),
    getTrace: vi.fn<RunApiClient['getTrace']>().mockResolvedValue(tracePage(run)),
    reconcile: vi.fn<RunApiClient['reconcile']>().mockResolvedValue(commandResult(run, 'scheduled')),
  };
}
function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function flush() {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}
async function tick(ms = 100) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
function save(run: RunView, cursor?: string) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ runId: run.runId, ...(cursor ? { cursor } : {}) }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('durable live-console observer (controlled API, synthetic evidence)', () => {
  it('guards duplicate start and waits for persisted product state, without optimistic completion', async () => {
    const run = structuredClone(DEMO_FIXTURES.find(item => item.id === 'completed_pending_assessment')!.run!);
    const client = api(run), creation = defer<CommandResult>();
    client.createRun.mockReturnValueOnce(creation.promise);
    const { result } = renderHook(() => useRun({ client, pollIntervalMs: 100 }));
    act(() => { void result.current.start(run.incident.url); void result.current.start(run.incident.url); });
    expect(client.createRun).toHaveBeenCalledExactlyOnceWith(run.incident.url);
    expect(result.current.pending).toBe(true);
    expect(result.current.run).toBeNull();
    await act(async () => { creation.resolve(commandResult(run, 'created')); });
    await flush();
    expect(result.current.run?.runId).toBe(run.runId);
    expect(result.current.run?.productStatus).toBe('completed');
    expect(result.current.run?.assessments.firstProposal.humanLabelCount).toBe(0);
    expect(result.current.run?.assessments.firstProposal.status).toBe('unverified');
    expect(result.current.commandResult?.disposition).toBe('created');
    expect(result.current.pending).toBe(false);
  });

  it('never overlaps scheduled polling while a read is unresolved', async () => {
    const run = baseline(), client = api(run), reading = defer<RunView>();
    save(run);
    client.getRun.mockReturnValueOnce(reading.promise);
    const { result } = renderHook(() => useRun({ client, pollIntervalMs: 100 }));
    await tick(10_000);
    expect(client.getRun).toHaveBeenCalledTimes(1);
    expect(client.getEvents).not.toHaveBeenCalled();
    await act(async () => { reading.resolve(run); });
    await flush();
    expect(result.current.connection).toBe('connected');
    await tick();
    expect(client.getRun).toHaveBeenCalledTimes(2);
  });

  it('reopens the same run and cursor after unmount, aborting reads without issuing a command', async () => {
    const run = baseline(), client = api(run);
    save(run, 'saved_events');
    client.getEvents.mockResolvedValue(page(run, [event(8)], 'events_8'));
    const first = renderHook(() => useRun({ client, pollIntervalMs: 100 }));
    await flush();
    expect(client.getEvents).toHaveBeenCalledWith(run.runId, 'saved_events', expect.any(AbortSignal));
    expect(first.result.current.run?.evaluationAttemptId).toBe(run.evaluationAttemptId);
    expect(first.result.current.run?.runtimeAttemptIds).toEqual(run.runtimeAttemptIds);
    const readSignal = client.getRun.mock.calls[0]![1]!;
    first.unmount();
    expect(readSignal.aborted).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({ runId: run.runId, cursor: 'events_8' });
    client.getEvents.mockResolvedValue(page(run, [], 'events_8'));
    renderHook(() => useRun({ client, pollIntervalMs: 100 }));
    await flush();
    expect(client.getEvents).toHaveBeenLastCalledWith(run.runId, 'events_8', expect.any(AbortSignal));
    expect(client.getTrace).toHaveBeenLastCalledWith(run.runId, undefined, expect.any(AbortSignal));
    expect(client.createRun).not.toHaveBeenCalled();
    expect(client.reconcile).not.toHaveBeenCalled();
  });

  it('uses a linked run over another saved run and does not POST on reopen', async () => {
    const run = baseline(), client = api(run);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ runId: 'some-other-run', cursor: 'other_cursor' }));
    window.history.replaceState(null, '', `/?run=${run.runId}`);
    renderHook(() => useRun({ client }));
    await flush();
    expect(client.getRun).toHaveBeenCalledWith(run.runId, expect.any(AbortSignal));
    expect(client.getEvents).toHaveBeenCalledWith(run.runId, undefined, expect.any(AbortSignal));
    expect(client.createRun).not.toHaveBeenCalled();
  });

  it('deduplicates replayed events and rejects an unseen out-of-order event without advancing its cursor', async () => {
    const run = baseline(), client = api(run);
    save(run);
    client.getEvents.mockResolvedValueOnce(page(run, [event(1), event(2)], 'events_2'))
      .mockResolvedValueOnce(page(run, [event(2), event(3)], 'events_3'))
      .mockResolvedValue(page(run, [event(2, 'late-unseen-event')], 'events_bad'));
    const { result } = renderHook(() => useRun({ client, pollIntervalMs: 100 }));
    await flush();
    await tick();
    expect(result.current.events.map(item => item.sequence)).toEqual([1, 2, 3]);
    await tick();
    expect(result.current.error?.code).toBe('stale_response');
    expect(result.current.events.map(item => item.sequence)).toEqual([1, 2, 3]);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).cursor).toBe('events_3');
  });

  it.each(['run', 'report', 'assessment', 'evaluation identity', 'runtime identity'] as const)('rejects a stale %s while preserving the last known run', async kind => {
    const run = baseline(), stale = structuredClone(run), client = api(run);
    stale.revision += 1;
    if (kind === 'run') stale.revision = run.revision - 1;
    if (kind === 'report') stale.report!.revision -= 1;
    if (kind === 'evaluation identity') stale.evaluationAttemptId = EvaluationAttemptIdSchema.parse('foreign-evaluation');
    if (kind === 'runtime identity') stale.runtimeAttemptIds = [];
    if (kind === 'assessment') {
      run.assessments.trace.assessmentRevision = 3;
      stale.assessments.trace.assessmentRevision = 2;
    }
    save(run);
    client.getRun.mockResolvedValueOnce(run).mockResolvedValue(stale);
    const { result } = renderHook(() => useRun({ client, pollIntervalMs: 100 }));
    await flush();
    await tick();
    expect(result.current.error?.code).toBe('stale_response');
    expect(result.current.run).toEqual(run);
    expect(client.createRun).not.toHaveBeenCalled();
  });

  it('keeps report and assessment revision floors when an outage temporarily omits evidence', async () => {
    const run = baseline(), unavailable = baseline(), stale = baseline(), client = api(run);
    run.assessments.trace.assessmentRevision = 3;
    unavailable.revision += 1;
    unavailable.report = null;
    unavailable.reportAvailability = 'unavailable';
    unavailable.assessments.trace = { ...unavailable.assessments.trace, status: 'pending', coverage: 'unavailable',
      evaluatorVersion: null, assessmentRevision: null, observedAt: null, watermark: null, confirmedCount: 0 };
    stale.revision += 2;
    stale.report!.revision -= 1;
    stale.assessments.trace.assessmentRevision = 2;
    save(run);
    client.getRun.mockResolvedValueOnce(run).mockResolvedValueOnce(unavailable).mockResolvedValue(stale);
    client.getEvents.mockResolvedValueOnce(page(run)).mockResolvedValue(page(unavailable));
    client.getTrace.mockResolvedValueOnce(tracePage(run)).mockResolvedValue(tracePage(unavailable));
    const { result } = renderHook(() => useRun({ client, pollIntervalMs: 100 }));
    await flush();
    await tick();
    expect(result.current.run?.reportAvailability).toBe('unavailable');
    await tick();
    expect(result.current.error?.code).toBe('stale_response');
    expect(result.current.run).toEqual(unavailable);
  });

  it('retains completed product state during monitor outage and resumes with bounded read backoff', async () => {
    const run = baseline(), client = api(run);
    save(run);
    client.getTrace.mockResolvedValueOnce(tracePage(run)).mockRejectedValueOnce(new ConsoleApiError('unavailable'));
    const { result } = renderHook(() => useRun({ client, pollIntervalMs: 100 }));
    await flush();
    await tick();
    expect(result.current.error?.code).toBe('unavailable');
    expect(result.current.connection).toBe('reconnecting');
    expect(result.current.run).toEqual(run);
    expect(result.current.trace).toEqual(tracePage(run));
    await tick(199);
    expect(client.getRun).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(result.current.connection).toBe('connected');
    expect(result.current.error).toBeNull();
  });

  it.each([
    ['unauthenticated', 'session_expired'], ['forbidden', 'unauthorized'],
  ] as const)('stops after %s until an explicit reconnect, retaining run identity', async (code, connection) => {
    const run = baseline(), client = api(run);
    save(run);
    client.getRun.mockResolvedValueOnce(run).mockRejectedValueOnce(new ConsoleApiError(code));
    const { result } = renderHook(() => useRun({ client, pollIntervalMs: 100 }));
    await flush();
    await tick();
    expect(result.current.connection).toBe(connection);
    expect(result.current.run?.runId).toBe(run.runId);
    await tick(60_000);
    expect(client.getRun).toHaveBeenCalledTimes(2);
    act(() => { result.current.reconnect(); });
    await flush();
    expect(result.current.connection).toBe('connected');
    expect(client.createRun).not.toHaveBeenCalled();
  });

  it('sends one reconciliation at the observed revision and never retries an uncertain command', async () => {
    const run = structuredClone(DEMO_FIXTURES.find(item => item.run?.productStatus === 'failed_partial')!.run!), client = api(run);
    save(run);
    client.reconcile.mockRejectedValue(new ConsoleApiError('offline'));
    const { result } = renderHook(() => useRun({ client, pollIntervalMs: 100 }));
    await flush();
    await act(async () => { await Promise.all([result.current.reconcile(), result.current.reconcile()]); });
    expect(client.reconcile).toHaveBeenCalledExactlyOnceWith(run.runId, run.revision);
    expect(result.current.connection).toBe('offline');
    expect(result.current.run).toEqual(run);
    await tick(30_000);
    expect(result.current.error?.code).toBe('offline');
    expect(client.reconcile).toHaveBeenCalledTimes(1);
    expect(client.createRun).not.toHaveBeenCalled();
  });

  it('merges trace updates by stable attempt identity and rejects a foreign evaluation', async () => {
    const run = baseline(), client = api(run), originalTrace = structuredClone(fixture.trace!);
    const original = originalTrace.attempts.find(item => item.type === 'model')!;
    const running = { ...original, finishedAt: null, latencyMs: null, outcome: 'running' as const };
    save(run);
    client.getTrace.mockResolvedValueOnce({ ...tracePage(run), attempts: [running], nextCursor: 'trace_1' })
      .mockResolvedValueOnce({ ...tracePage(run), attempts: [original], nextCursor: 'trace_2' })
      .mockResolvedValue({ ...tracePage(run), evaluationAttemptId: EvaluationAttemptIdSchema.parse('different-evaluation'), nextCursor: 'trace_3' });
    const { result } = renderHook(() => useRun({ client, pollIntervalMs: 100 }));
    await flush();
    await tick();
    expect(result.current.trace?.attempts).toEqual([original]);
    await tick();
    expect(result.current.error?.code).toBe('stale_response');
    expect(result.current.trace?.attempts).toEqual([original]);
    expect(result.current.trace?.nextCursor).toBe('trace_2');
  });
});

describe('same-origin browser API contract (synthetic HTTP responses)', () => {
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });

  it('sends only command intent, same-origin credentials and CSRF, and validates cursor reads', async () => {
    const run = baseline();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(commandResult(run)))
      .mockResolvedValueOnce(response(commandResult(run, 'scheduled'))).mockResolvedValueOnce(response(page(run)));
    const client = createApiClient({ fetch: fetcher, getCsrfToken: () => 'session-csrf-value' });
    await client.createRun(run.incident.url);
    await client.reconcile(run.runId, run.revision);
    await client.getEvents(run.runId, 'cursor_7');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]).toEqual(['/api/runs', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': 'session-csrf-value' },
      body: JSON.stringify({ schemaVersion: 2, incidentUrl: run.incident.url }),
    })]);
    expect(fetcher.mock.calls[1]).toEqual([`/api/runs/${run.runId}/reconcile`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ schemaVersion: 2, expectedRevision: run.revision }),
    })]);
    expect(fetcher.mock.calls[2]).toEqual([`/api/runs/${run.runId}/events?after=cursor_7`, expect.objectContaining({
      method: 'GET', headers: { accept: 'application/json' },
    })]);
  });

  it('rejects absent CSRF and invalid incident intent before dispatch', async () => {
    const fetcher = vi.fn<typeof fetch>(), run = baseline();
    const client = createApiClient({ fetch: fetcher, getCsrfToken: () => null });
    await expect(client.createRun(run.incident.url)).rejects.toMatchObject({ code: 'csrf_failed' });
    await expect(client.createRun('https://example.com/not-an-incident')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not retry an uncertain create or expose raw network exceptions', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private-network-detail'));
    const client = createApiClient({ fetch: fetcher, getCsrfToken: () => 'csrf' });
    const error = await client.createRun(baseline().incident.url).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'offline' });
    expect(String(error)).not.toContain('private-network-detail');
    await tick(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([1, 3])('rejects unsupported schema %s and redacts the untrusted body', async schemaVersion => {
    const run = baseline();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ...run, schemaVersion, privatePath: 'private-value' }));
    const error = await createApiClient({ fetch: fetcher }).getRun(run.runId).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'invalid_response' });
    expect(String(error)).not.toContain('private-value');
  });

  it.each([[401, 'unauthenticated'], [403, 'forbidden']] as const)('preserves the stable %s error and correlation receipt', async (status, code) => {
    const apiError = { schemaVersion: 2, code, retryable: false, correlationId: 'test-error-correlation' };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(apiError, status));
    await expect(createApiClient({ fetch: fetcher }).getRun(baseline().runId)).rejects.toMatchObject({
      code, retryable: false, apiError,
    });
  });

  it('treats unauthorized report access as an API failure, not report unavailability', async () => {
    const run = baseline();
    run.report = null;
    run.reportAvailability = 'unauthorized';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(run));
    await expect(createApiClient({ fetch: fetcher }).getRun(run.runId)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
