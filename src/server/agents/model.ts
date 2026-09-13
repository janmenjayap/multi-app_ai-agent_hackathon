import { AsyncLocalStorage } from 'node:async_hooks';
import { ChatOpenAI } from '@langchain/openai';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { CallbackManager } from '@langchain/core/callbacks/manager';
import { z } from 'zod';
import { AgentFailureCodeSchema, type AgentRole } from '../../shared/agents.js';
import type { AppConfig } from '../index.js';

export type AgentFailureCode = z.infer<typeof AgentFailureCodeSchema>;
export interface ModelMessage { role: 'system' | 'user'; content: string }
export interface RawModelResponse {
  body: string;
  status: number;
  requestId: string | null;
  retryAfterMs: number | null;
}
export interface ModelDispatchRequest<T> {
  role: AgentRole;
  modelAttemptId: string;
  messages: readonly ModelMessage[];
  outputSchema: z.ZodType<T>;
  schemaName: string;
  resolvedModelId: string;
  maxOutputTokens: number;
  abortSignal: AbortSignal;
}
export interface ModelDispatchResult {
  output: unknown;
  rawText: string | null;
  refused: boolean;
  incomplete: boolean;
  usage: { inputTokens: number; outputTokens: number } | null;
}
export interface ModelClient {
  readonly mode: 'mock' | 'live';
  dispatchStructured<T>(request: ModelDispatchRequest<T>,
    onRawResponse: (raw: RawModelResponse) => Promise<void>): Promise<ModelDispatchResult>;
}

/** Only registry codes cross this boundary; SDK messages/cause may contain private content. */
export class ModelDispatchError extends Error {
  constructor(readonly reason: AgentFailureCode, readonly retryable = false,
    readonly retryAfterMs: number | null = null) {
    super(`Model dispatch failed: ${reason}`);
    this.name = 'ModelDispatchError';
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function responseObject(raw: RawModelResponse): Record<string, unknown> | null {
  try { return object(JSON.parse(raw.body)); } catch { return null; }
}

/** Call only after the unchanged response body has been durably saved. */
export function inspectRawResponse(raw: RawModelResponse): Omit<ModelDispatchResult, 'output'> {
  const response = responseObject(raw);
  const text: string[] = [];
  let refused = false;
  let incomplete = response?.status !== undefined && response.status !== 'completed';
  if (Array.isArray(response?.output)) {
    for (const item of response.output) {
      const message = object(item);
      if (message?.type !== 'message') continue;
      if (message.status !== undefined && message.status !== 'completed') incomplete = true;
      if (!Array.isArray(message.content)) continue;
      for (const item of message.content) {
        const content = object(item);
        if (content?.type === 'refusal') {
          refused = true;
          if (typeof content.refusal === 'string') text.push(content.refusal);
        }
        if (content?.type === 'output_text' && typeof content.text === 'string') text.push(content.text);
      }
    }
  }
  const usage = object(response?.usage);
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;
  return {
    rawText: text.length ? text.join('') : null,
    refused,
    incomplete,
    usage: typeof inputTokens === 'number' && Number.isSafeInteger(inputTokens) && inputTokens >= 0 &&
      typeof outputTokens === 'number' && Number.isSafeInteger(outputTokens) && outputTokens >= 0
      ? { inputTokens, outputTokens } : null,
  };
}

function retryDelay(headers: Headers): number | null {
  const milliseconds = headers.get('retry-after-ms');
  const seconds = headers.get('retry-after');
  const delay = milliseconds !== null ? Number(milliseconds)
    : seconds !== null && /^\d+(?:\.\d+)?$/.test(seconds) ? Number(seconds) * 1000
    : seconds !== null ? Date.parse(seconds) - Date.now() : NaN;
  return Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : null;
}

function failure(error: unknown, raw: RawModelResponse | undefined, signal: AbortSignal): ModelDispatchError {
  if (error instanceof ModelDispatchError) return error;
  const name = object(error)?.name;
  if (signal.aborted) return new ModelDispatchError(
    object(signal.reason)?.name === 'TimeoutError' ? 'timeout' : 'cancelled', false);
  if (name === 'TimeoutError' || name === 'APIConnectionTimeoutError') return new ModelDispatchError('timeout', true);
  if (name === 'AbortError' || name === 'APIUserAbortError') return new ModelDispatchError('cancelled');
  const status = raw?.status;
  if (status === 401 || status === 403) return new ModelDispatchError('authentication');
  if (status === 404) return new ModelDispatchError('unsupported_model');
  if (status === 429) {
    const code = object(raw && responseObject(raw)?.error)?.code;
    const retryable = code !== 'insufficient_quota' && code !== 'billing_hard_limit_reached';
    return new ModelDispatchError('rate_limited', retryable, raw?.retryAfterMs ?? null);
  }
  if (status === 408) return new ModelDispatchError('timeout', true, raw?.retryAfterMs ?? null);
  if (status !== undefined && status >= 500) return new ModelDispatchError('transport_error', true, raw?.retryAfterMs ?? null);
  if (status !== undefined && status >= 400) return new ModelDispatchError('configuration_mismatch');
  if (raw) return new ModelDispatchError('output_invalid', true);
  return new ModelDispatchError('transport_error', true);
}

export function createModelClient(options: {
  config: AppConfig;
  mockClient?: ModelClient;
  fetch?: typeof globalThis.fetch;
}): ModelClient {
  const { config } = options;
  if (config.modelMode === 'mock') {
    if (options.mockClient?.mode !== 'mock') throw new ModelDispatchError('configuration_mismatch');
    // No OpenAI construction, key lookup, or transport fallback in fixture mode.
    return options.mockClient;
  }
  if (config.modelMode !== 'live' || !config.secrets.openaiApiKey?.trim() || !config.model.name?.trim() ||
      Object.values(config.model.roles).some(model => !model?.trim())) {
    throw new ModelDispatchError('configuration_mismatch');
  }
  const apiKey = config.secrets.openaiApiKey;
  const models = { ...config.model.roles };
  const limits = { ...config.model };
  const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== 'function') throw new ModelDispatchError('configuration_mismatch');
  // The pinned core shares this context with LangGraph and LangSmith. Clear the
  // caller's context, then create an untraced root rather than inheriting hooks.
  AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage());

  return {
    mode: 'live',
    async dispatchStructured(request, onRawResponse) {
      if (!Object.hasOwn(models, request.role) || models[request.role] !== request.resolvedModelId ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(request.schemaName) ||
          !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 ||
          request.maxOutputTokens > limits.maxOutputTokens) throw new ModelDispatchError('configuration_mismatch');
      if (!request.messages.length || request.messages.some(message =>
        (message.role !== 'system' && message.role !== 'user') || typeof message.content !== 'string')) {
        throw new ModelDispatchError('input_invalid');
      }
      const messages = request.messages.map(({ role, content }) => ({ role, content }));
      if (JSON.stringify(messages).length > limits.maxInputChars) throw new ModelDispatchError('input_budget_exceeded');
      let savedRaw: RawModelResponse | undefined;
      let storageFailed = false;
      let dispatched = false;
      const capture: typeof globalThis.fetch = async (input, init) => {
        // Guard against a future SDK changing its hidden retry policy or routing.
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
        if (dispatched || url.href !== 'https://api.openai.com/v1/responses') {
          throw new ModelDispatchError('configuration_mismatch');
        }
        dispatched = true;
        const response = await transport(input, { ...init, redirect: 'error' });
        const raw = {
          body: await response.clone().text(), status: response.status,
          requestId: response.headers.get('x-request-id'), retryAfterMs: retryDelay(response.headers),
        };
        try { await onRawResponse(raw); }
        catch { storageFailed = true; throw new ModelDispatchError('transport_error'); }
        savedRaw = raw;
        return response;
      };
      try {
        request.abortSignal.throwIfAborted();
        const llm = new ChatOpenAI({
          apiKey, model: request.resolvedModelId, useResponsesApi: true,
          maxRetries: 0, maxTokens: request.maxOutputTokens, timeout: limits.timeoutMs,
          streaming: false, disableStreaming: true, streamUsage: false, verbose: false,
          callbacks: [], zdrEnabled: true,
          configuration: {
            apiKey, baseURL: 'https://api.openai.com/v1', maxRetries: 0,
            organization: null, project: null, logLevel: 'off', fetch: capture,
          },
        });
        // JSON schema is derived from the caller's F02 schema. Application/Zod
        // refinements remain runtime-owned validation after restricted capture.
        const structured = llm.withStructuredOutput(z.toJSONSchema(request.outputSchema), {
          name: request.schemaName, method: 'jsonSchema', strict: true, includeRaw: true,
        });
        const result = await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
          AsyncLocalStorageProviderSingleton.runWithConfig({ callbacks: [], tags: [], metadata: {} }, () => {
            // Environment-driven console/debug hooks cannot be disabled through
            // verbose:false in this pinned core. Detect them before any prompt
            // enters a runnable; optional export belongs to the redacted outbox.
            if (CallbackManager.configure([], [])?.handlers.length) {
              throw new ModelDispatchError('configuration_mismatch');
            }
            return structured.invoke(messages, { signal: request.abortSignal, callbacks: [], runName: request.role });
          }));
        if (!savedRaw) throw new ModelDispatchError('transport_error');
        return { output: result.parsed, ...inspectRawResponse(savedRaw) };
      } catch (error) {
        if (storageFailed) throw new ModelDispatchError('transport_error');
        if (savedRaw && savedRaw.status >= 200 && savedRaw.status < 300) {
          const inspected = inspectRawResponse(savedRaw);
          if (inspected.refused || inspected.incomplete) return { output: null, ...inspected };
        }
        // Schema construction errors are configuration failures, not repairable outputs.
        if (!dispatched && !request.abortSignal.aborted) throw new ModelDispatchError('configuration_mismatch');
        throw failure(error, savedRaw, request.abortSignal);
      }
    },
  };
}
