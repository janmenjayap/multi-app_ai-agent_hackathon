import type { z } from 'zod';
import {
  API_ROUTES, ApiErrorSchema, CommandResultSchema, CreateRunCommandSchema, CursorSchema,
  ReconcileRunCommandSchema, RunEventsPageSchema, RunViewSchema, TraceViewSchema,
  assertPublicProjection, type ApiError, type CommandResult, type RunEventsPage, type RunView, type TraceView,
} from '../../shared/api.js';
import { RunIdSchema } from '../../shared/domain.js';

export type ConsoleErrorCode = ApiError['code'] | 'offline' | 'invalid_response' | 'stale_response';
const MESSAGES: Record<ConsoleErrorCode, string> = {
  invalid_request: 'Enter a GitHub issue URL in a repository your operator session can access.',
  unauthenticated: 'Your operator session has expired. Sign in, then reconnect.',
  forbidden: 'You do not have access to this run or its evidence.',
  not_found: 'The requested run could not be found.',
  csrf_failed: 'The session could not be verified. Reload your authenticated session before issuing commands.',
  stale_revision: 'The run changed before this command was accepted. Refresh its status before trying again.',
  conflict: 'This command conflicts with the current run. Refresh its status before trying again.',
  rate_limited: 'Requests are temporarily limited. Reconnecting with bounded backoff.',
  unavailable: 'The service is temporarily unavailable. Last-known product state is retained.',
  internal_error: 'The request failed. Use the correlation ID for support.',
  offline: 'The server could not be reached. Last-known product state is retained.',
  invalid_response: 'The server returned an unsupported or inconsistent response. Last-known product state is retained.',
  stale_response: 'A stale response was ignored. The last accepted revision is still shown.',
};

/** Browser transport failures are distinct from the versioned server error contract. */
export class ConsoleApiError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: ConsoleErrorCode, readonly apiError?: ApiError) {
    super(MESSAGES[code]);
    this.name = 'ConsoleApiError';
    this.retryable = apiError?.retryable ?? ['offline', 'unavailable', 'rate_limited', 'stale_response'].includes(code);
  }
}

export interface RunApiClient {
  createRun(incidentUrl: string, signal?: AbortSignal): Promise<CommandResult>;
  getRun(runId: string, signal?: AbortSignal): Promise<RunView>;
  getEvents(runId: string, cursor?: string, signal?: AbortSignal): Promise<RunEventsPage>;
  getTrace(runId: string, cursor?: string, signal?: AbortSignal): Promise<TraceView>;
  reconcile(runId: string, expectedRevision: number, signal?: AbortSignal): Promise<CommandResult>;
}

export interface ApiClientOptions {
  fetch?: typeof globalThis.fetch;
  /** Supplied by the authenticated server shell, never persisted with a run. */
  getCsrfToken?: () => string | null;
  timeoutMs?: number;
}

export function createApiClient(options: ApiClientOptions = {}): RunApiClient {
  const fetcher = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const getCsrfToken = options.getCsrfToken ?? (() =>
    typeof document === 'undefined' ? null : document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? null);
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) throw new Error('invalid_api_timeout');

  async function request<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) {
      const csrf = getCsrfToken();
      if (!csrf || csrf.length > 4096) throw new ConsoleApiError('csrf_failed');
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = csrf;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, timeoutMs);
    try {
      const response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
        headers, signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      let value: unknown;
      try { value = await response.json(); }
      catch { throw new ConsoleApiError('invalid_response'); }
      if (!response.ok) {
        const parsed = ApiErrorSchema.safeParse(value);
        if (!parsed.success) throw new ConsoleApiError('invalid_response');
        throw new ConsoleApiError(parsed.data.code, parsed.data);
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ConsoleApiError('invalid_response');
      try { assertPublicProjection(parsed.data); }
      catch { throw new ConsoleApiError('invalid_response'); }
      return parsed.data;
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Read cancelled', 'AbortError');
      if (error instanceof ConsoleApiError) throw error;
      // Never expose raw network/provider exceptions or retry an uncertain command.
      throw new ConsoleApiError('offline');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  function runPath(route: string, runId: string) {
    const id = RunIdSchema.safeParse(runId);
    if (!id.success) throw new ConsoleApiError('invalid_request');
    return route.replace(':id', encodeURIComponent(id.data));
  }
  function pagePath(route: string, runId: string, cursor?: string) {
    const path = runPath(route, runId);
    if (cursor === undefined) return path;
    if (!CursorSchema.safeParse(cursor).success) throw new ConsoleApiError('invalid_request');
    return `${path}?after=${encodeURIComponent(cursor)}`;
  }

  return {
    async createRun(incidentUrl, signal) {
      const command = CreateRunCommandSchema.safeParse({ schemaVersion: 2, incidentUrl });
      if (!command.success) throw new ConsoleApiError('invalid_request');
      return request(API_ROUTES.createRun, CommandResultSchema, signal, command.data);
    },
    async getRun(runId, signal) {
      const run = await request(runPath(API_ROUTES.run, runId), RunViewSchema, signal);
      if (run.runId !== runId) throw new ConsoleApiError('invalid_response');
      if (run.reportAvailability === 'unauthorized' || run.report?.reportRef?.availability === 'unauthorized')
        throw new ConsoleApiError('forbidden');
      return run;
    },
    getEvents: (runId, cursor, signal) => request(pagePath(API_ROUTES.events, runId, cursor), RunEventsPageSchema, signal),
    getTrace: (runId, cursor, signal) => request(pagePath(API_ROUTES.trace, runId, cursor), TraceViewSchema, signal),
    async reconcile(runId, expectedRevision, signal) {
      const command = ReconcileRunCommandSchema.safeParse({ schemaVersion: 2, expectedRevision });
      if (!command.success) throw new ConsoleApiError('invalid_request');
      return request(runPath(API_ROUTES.reconcile, runId), CommandResultSchema, signal, command.data);
    },
  };
}
