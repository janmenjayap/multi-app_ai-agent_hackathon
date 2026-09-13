import {
  AdapterCallContextSchema,
  ProviderAttemptReceiptSchema,
  READ_OPERATIONS,
  type AdapterCallContext,
  type ProviderAttemptReceipt,
} from '../../../shared/adapters.js';
import {
  canonical,
  ProviderAttemptIdSchema,
  RestrictedArtifactRefSchema,
  type ProviderAttemptId,
  type RestrictedArtifactRef,
} from '../../../shared/domain.js';
import {
  AdapterError,
  classifyHttpError,
  forMutation,
  normalizeThrownError,
} from './errors.js';

type Awaitable<T> = T | Promise<T>;
type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PATCH';
type RetryReason = 'timeout' | 'rate_limited' | 'transport_error' | 'output_invalid' | 'budget_exhausted';

export interface TransportClock {
  wallNowMs(): number;
  monotonicNowMs(): number;
  sleep(delayMs: number): Promise<void>;
}

export interface RestrictedArtifactInput {
  mediaType: 'application/json';
  bytes: Uint8Array;
}

export interface TransportDispatchObservation {
  context: AdapterCallContext;
  startedAt: string;
  monotonicMs: number;
}

export interface TransportResultObservation {
  context: AdapterCallContext;
  receipt: ProviderAttemptReceipt;
  receiptRef: RestrictedArtifactRef;
  latencyMs: number;
  requestDigest: string | null;
  responseDigest: string | null;
  providerRequestId: string | null;
}

export interface TransportRetryObservation {
  context: AdapterCallContext;
  reason: RetryReason;
  delayMs: number;
  remainingBudgetMs: number;
}

export interface TransportObserver {
  onDispatch(observation: TransportDispatchObservation): Awaitable<void>;
  onResult(observation: TransportResultObservation): Awaitable<void>;
  onRetry(observation: TransportRetryObservation): Awaitable<void>;
}

export interface BoundedTransportDependencies {
  fetch(input: string, init: RequestInit): Promise<Response>;
  clock: TransportClock;
  createProviderAttemptId(): ProviderAttemptId;
  createSpanId(): string;
  storeResponse(input: RestrictedArtifactInput): Awaitable<RestrictedArtifactRef>;
  storeReceipt(receipt: ProviderAttemptReceipt): Awaitable<RestrictedArtifactRef>;
  observer: TransportObserver;
  retryDelayMs?(attemptNumber: number, error: AdapterError): number;
}

export interface RestRequest<T> {
  url: string | URL;
  method: HttpMethod;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal;
  acceptsStatus?(status: number): boolean;
  decode(body: unknown, response: Pick<Response, 'headers' | 'status'>): T;
}

export interface TransportSuccess<T> {
  status: 'success';
  data: T;
  receipt: ProviderAttemptReceipt;
  receiptRef: RestrictedArtifactRef;
  latencyMs: number;
  providerRequestId: string | null;
}

export interface TransportFailure {
  status: 'failure';
  error: AdapterError;
  receipt: ProviderAttemptReceipt | null;
  receiptRef: RestrictedArtifactRef | null;
  latencyMs: number | null;
  providerRequestId: string | null;
}

export type TransportResult<T> = TransportSuccess<T> | TransportFailure;

export interface BoundedRestOperation {
  readonly context: AdapterCallContext;
  currentAt(): string;
  remainingMs(): number;
  request<T>(request: RestRequest<T>): Promise<TransportResult<T>>;
}

export interface BoundedRestTransport {
  begin(context: unknown): BoundedRestOperation;
}

export type ProviderReceiptSink = (receipt: ProviderAttemptReceipt) => Awaitable<RestrictedArtifactRef>;

const DEFAULT_CLOCK: TransportClock = {
  wallNowMs: () => Date.now(),
  monotonicNowMs: () => performance.now(),
  sleep: delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
};

function retryReason(error: AdapterError): RetryReason {
  switch (error.code) {
    case 'timeout':
    case 'rate_limited':
    case 'transport_error':
    case 'budget_exhausted':
      return error.code;
    default:
      return 'output_invalid';
  }
}

function requestDigest(context: AdapterCallContext): string | null {
  return 'requestDigest' in context ? context.requestDigest : null;
}

function assertRequestBoundary(context: AdapterCallContext, request: RestRequest<unknown>): URL {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new AdapterError('invalid', { providerOutcome: 'invalid', isRetryable: false });
  }
  const isRead = (READ_OPERATIONS as readonly string[]).includes(context.operation);
  if ((isRead && request.method !== 'GET' && request.method !== 'HEAD') ||
      (!isRead && request.method !== 'POST' && request.method !== 'PATCH')) {
    throw new AdapterError('invalid', { providerOutcome: 'invalid', isRetryable: false });
  }
  return url;
}

function responseRequestId(headers: Headers): string | null {
  for (const name of ['x-request-id', 'x-github-request-id', 'x-hubspot-correlation-id', 'x-slack-req-id']) {
    const value = headers.get(name);
    if (value) return value.slice(0, 160);
  }
  return null;
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AdapterError('malformed_response', { providerOutcome: 'unknown', isRetryable: false });
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new AdapterError('response_too_large', { providerOutcome: 'unknown', isRetryable: false });
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new AdapterError('response_too_large', { providerOutcome: 'unknown', isRetryable: false });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

class RestOperation implements BoundedRestOperation {
  readonly context: AdapterCallContext;
  private readonly startedWallMs: number;
  private readonly startedMonotonicMs: number;
  private readonly deadlineMonotonicMs: number;
  private readonly usedAttemptIds = new Set<string>();
  private readonly usedSpanIds = new Set<string>();
  private dispatchedAttempts = 0;
  private responseBytes = 0;

  constructor(context: AdapterCallContext, private readonly dependencies: BoundedTransportDependencies) {
    this.context = context;
    this.startedWallMs = dependencies.clock.wallNowMs();
    this.startedMonotonicMs = dependencies.clock.monotonicNowMs();
    const wallBudgetMs = Math.max(0, Date.parse(context.deadlineAt) - this.startedWallMs);
    this.deadlineMonotonicMs = this.startedMonotonicMs + Math.min(context.budgets.totalMs, wallBudgetMs);
  }

  remainingMs(): number {
    return Math.max(0, Math.floor(this.deadlineMonotonicMs - this.dependencies.clock.monotonicNowMs()));
  }

  currentAt(): string {
    return this.projectedAt(this.dependencies.clock.monotonicNowMs());
  }

  async request<T>(request: RestRequest<T>): Promise<TransportResult<T>> {
    const url = assertRequestBoundary(this.context, request);
    const isRead = (READ_OPERATIONS as readonly string[]).includes(this.context.operation);
    let lastFailure: TransportFailure | null = null;

    for (let attemptNumber = 1; attemptNumber <= this.context.budgets.maxAttempts; attemptNumber += 1) {
      if (this.remainingMs() <= 0) return this.budgetFailure(lastFailure);
      const result = await this.dispatch({ ...request, url }, isRead);
      if (result.status === 'success') return result;
      lastFailure = result;
      if (!isRead || !result.error.isRetryable || attemptNumber === this.context.budgets.maxAttempts) return result;

      const delayMs = Math.max(0, Math.ceil(result.error.retryAfterMs ??
        (this.dependencies.retryDelayMs?.(attemptNumber, result.error) ?? Math.min(250 * (2 ** (attemptNumber - 1)), 5000))));
      const remainingBudgetMs = this.remainingMs();
      if (delayMs >= remainingBudgetMs) return this.budgetFailure(lastFailure);
      await this.dependencies.observer.onRetry({
        context: result.receipt?.context ?? this.context,
        reason: retryReason(result.error),
        delayMs,
        remainingBudgetMs,
      });
      await this.dependencies.clock.sleep(delayMs);
    }

    return this.budgetFailure(lastFailure);
  }

  private budgetFailure(previous: TransportFailure | null): TransportFailure {
    return {
      status: 'failure',
      error: new AdapterError('budget_exhausted', { providerOutcome: 'unknown', isRetryable: false }),
      receipt: previous?.receipt ?? null,
      receiptRef: previous?.receiptRef ?? null,
      latencyMs: previous?.latencyMs ?? null,
      providerRequestId: previous?.providerRequestId ?? null,
    };
  }

  private nextContext(): AdapterCallContext {
    const providerAttemptId = this.dispatchedAttempts === 0
      ? this.context.providerAttemptId
      : ProviderAttemptIdSchema.parse(this.dependencies.createProviderAttemptId());
    const spanId = this.dispatchedAttempts === 0 ? this.context.spanId : this.dependencies.createSpanId();
    if (this.usedAttemptIds.has(providerAttemptId) || this.usedSpanIds.has(spanId)) {
      throw new AdapterError('invalid', { providerOutcome: 'invalid', isRetryable: false });
    }
    this.usedAttemptIds.add(providerAttemptId);
    this.usedSpanIds.add(spanId);
    this.dispatchedAttempts += 1;
    return AdapterCallContextSchema.parse({ ...this.context, providerAttemptId, spanId });
  }

  private projectedAt(monotonicMs: number): string {
    return new Date(this.startedWallMs + Math.max(0, monotonicMs - this.startedMonotonicMs)).toISOString();
  }

  private async dispatch<T>(request: RestRequest<T> & { url: URL }, isRead: boolean): Promise<TransportResult<T>> {
    const context = this.nextContext();
    const startedMonotonicMs = this.dependencies.clock.monotonicNowMs();
    const startedAt = this.projectedAt(startedMonotonicMs);
    try {
      await this.dependencies.observer.onDispatch({ context, startedAt, monotonicMs: startedMonotonicMs });
    } catch {
      throw new AdapterError('receipt_persistence_failed', { providerOutcome: 'unknown', isRetryable: false });
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let wasTimedOut = false;
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) abortFromCaller();
    else request.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeoutMs = Math.max(1, Math.min(this.context.budgets.timeoutMs, this.remainingMs()));
    timeoutHandle = setTimeout(() => {
      wasTimedOut = true;
      controller.abort();
    }, timeoutMs);

    let response: Response | null = null;
    let responseRef: RestrictedArtifactRef | null = null;
    let providerRequestId: string | null = null;
    let data: T | undefined;
    let error: AdapterError | null = null;
    try {
      response = await this.dependencies.fetch(request.url.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      providerRequestId = responseRequestId(response.headers);
      const remainingResponseBytes = this.context.budgets.maxResponseBytes - this.responseBytes;
      const bytes = await readBoundedBody(response, remainingResponseBytes);
      this.responseBytes += bytes.byteLength;
      try {
        responseRef = RestrictedArtifactRefSchema.parse(await this.dependencies.storeResponse({
          mediaType: 'application/json',
          bytes,
        }));
      } catch {
        error = new AdapterError('receipt_persistence_failed', { providerOutcome: 'unknown', isRetryable: false });
      }
      if (!error && !(request.acceptsStatus?.(response.status) ?? (response.status >= 200 && response.status <= 299))) {
        error = classifyHttpError(response.status, response.headers.get('retry-after'), this.startedWallMs);
      }
      if (!error) {
        try {
          data = request.decode(parseJson(bytes), response);
        } catch (cause) {
          error = cause instanceof AdapterError
            ? cause
            : new AdapterError('malformed_response', { providerOutcome: 'unknown', isRetryable: false });
        }
      }
    } catch (cause) {
      error = normalizeThrownError(cause, wasTimedOut);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      request.signal?.removeEventListener('abort', abortFromCaller);
    }

    if (error && !isRead) error = forMutation(error);
    const finishedMonotonicMs = this.dependencies.clock.monotonicNowMs();
    const latencyMs = Math.max(0, Math.ceil(finishedMonotonicMs - startedMonotonicMs));
    const receipt = ProviderAttemptReceiptSchema.parse({
      schemaVersion: 2,
      context,
      startedAt,
      finishedAt: this.projectedAt(finishedMonotonicMs),
      transport: 'rest',
      httpStatus: response?.status ?? null,
      transportOutcome: response ? 'response' : error?.code === 'timeout' ? 'timeout' : 'error',
      providerOutcome: error?.providerOutcome ?? 'success',
      responseRef,
      errorCode: error?.code ?? null,
    });

    let receiptRef: RestrictedArtifactRef;
    try {
      receiptRef = RestrictedArtifactRefSchema.parse(await this.dependencies.storeReceipt(receipt));
      await this.dependencies.observer.onResult({
        context,
        receipt,
        receiptRef,
        latencyMs,
        requestDigest: requestDigest(context),
        responseDigest: responseRef?.sha256 ?? null,
        providerRequestId,
      });
    } catch {
      throw new AdapterError('receipt_persistence_failed', { providerOutcome: 'unknown', isRetryable: false });
    }

    if (error) return { status: 'failure', error, receipt, receiptRef, latencyMs, providerRequestId };
    return { status: 'success', data: data as T, receipt, receiptRef, latencyMs, providerRequestId };
  }
}

export function createBoundedRestTransport(
  dependencies: Omit<BoundedTransportDependencies, 'clock'> & { clock?: TransportClock },
): BoundedRestTransport {
  const resolved = { ...dependencies, clock: dependencies.clock ?? DEFAULT_CLOCK };
  return {
    begin(context: unknown) {
      const parsed = AdapterCallContextSchema.parse(context);
      if (parsed.mode !== 'rest') {
        throw new AdapterError('invalid', { providerOutcome: 'invalid', isRetryable: false });
      }
      return new RestOperation(parsed, resolved);
    },
  };
}

export function createIdempotentReceiptSink(store: ProviderReceiptSink): ProviderReceiptSink {
  const delivered = new Map<string, { fingerprint: string; result: Promise<RestrictedArtifactRef> }>();
  return async receiptValue => {
    const receipt = ProviderAttemptReceiptSchema.parse(receiptValue);
    const providerAttemptId = receipt.context.providerAttemptId;
    const fingerprint = canonical(receipt);
    const existing = delivered.get(providerAttemptId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new AdapterError('receipt_persistence_failed', { providerOutcome: 'unknown', isRetryable: false });
      }
      return existing.result;
    }
    const result = Promise.resolve(store(receipt)).then(value => RestrictedArtifactRefSchema.parse(value));
    delivered.set(providerAttemptId, { fingerprint, result });
    try {
      return await result;
    } catch (error) {
      delivered.delete(providerAttemptId);
      throw error;
    }
  };
}