import type { ReadResult } from '../../../shared/domain.js';
import type { ProviderAttemptReceipt } from '../../../shared/adapters.js';

export type AdapterErrorCode =
  | 'denied'
  | 'rate_limited'
  | 'invalid'
  | 'provider_error'
  | 'timeout'
  | 'transport_error'
  | 'malformed_response'
  | 'budget_exhausted'
  | 'response_too_large'
  | 'cancelled'
  | 'receipt_persistence_failed';

export type ReadFailureReason = Extract<ReadResult<never>, { status: 'incomplete' }>['reason'];

export interface AdapterErrorOptions {
  providerOutcome: ProviderAttemptReceipt['providerOutcome'];
  isRetryable: boolean;
  retryAfterMs?: number;
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly providerOutcome: ProviderAttemptReceipt['providerOutcome'];
  readonly isRetryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(code: AdapterErrorCode, options: AdapterErrorOptions) {
    super(code);
    this.name = 'AdapterError';
    this.code = code;
    this.providerOutcome = options.providerOutcome;
    this.isRetryable = options.isRetryable;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function parseRetryAfterMs(value: string | null, wallNowMs: number): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const retryAtMs = Date.parse(value);
  if (!Number.isFinite(retryAtMs)) return null;
  return Math.max(0, retryAtMs - wallNowMs);
}

export function classifyHttpError(status: number, retryAfter: string | null, wallNowMs: number): AdapterError {
  if (status === 401 || status === 403) {
    return new AdapterError('denied', { providerOutcome: 'denied', isRetryable: false });
  }
  if (status === 408) {
    return new AdapterError('timeout', { providerOutcome: 'unknown', isRetryable: true });
  }
  if (status === 429) {
    return new AdapterError('rate_limited', {
      providerOutcome: 'rate_limited',
      isRetryable: true,
      retryAfterMs: parseRetryAfterMs(retryAfter, wallNowMs) ?? undefined,
    });
  }
  if ([400, 404, 409, 422].includes(status)) {
    return new AdapterError('invalid', { providerOutcome: 'invalid', isRetryable: false });
  }
  return new AdapterError('provider_error', {
    providerOutcome: 'error',
    isRetryable: status >= 500 && status <= 599,
    retryAfterMs: status >= 500 && status <= 599
      ? parseRetryAfterMs(retryAfter, wallNowMs) ?? undefined
      : undefined,
  });
}

export function normalizeThrownError(error: unknown, wasTimedOut = false): AdapterError {
  if (error instanceof AdapterError) return error;
  if (wasTimedOut) return new AdapterError('timeout', { providerOutcome: 'unknown', isRetryable: true });
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new AdapterError('cancelled', { providerOutcome: 'unknown', isRetryable: false });
  }
  return new AdapterError('transport_error', { providerOutcome: 'unknown', isRetryable: true });
}

export function forMutation(error: AdapterError): AdapterError {
  const isDefinitive = ['denied', 'rate_limited', 'invalid'].includes(error.code);
  return new AdapterError(error.code, {
    providerOutcome: isDefinitive ? error.providerOutcome : 'unknown',
    isRetryable: false,
    retryAfterMs: error.retryAfterMs ?? undefined,
  });
}

export function toReadFailureReason(error: AdapterError): ReadFailureReason {
  switch (error.code) {
    case 'denied':
    case 'rate_limited':
    case 'timeout':
    case 'transport_error':
    case 'budget_exhausted':
    case 'malformed_response':
      return error.code;
    case 'response_too_large':
      return 'budget_exhausted';
    default:
      return 'transport_error';
  }
}