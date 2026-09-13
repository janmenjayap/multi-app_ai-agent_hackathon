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

/** Only registry codes cross this boundary; provider messages/causes may contain private content. */
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
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  const candidate = candidates.length === 1 ? object(candidates[0]) : null;
  const promptFeedback = object(response?.promptFeedback);
  const finishReason = typeof candidate?.finishReason === 'string' ? candidate.finishReason : null;
  const blockedReasons = new Set([
    'SAFETY', 'RECITATION', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII',
    'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'ESCALATION',
  ]);
  const text: string[] = [];
  let refused = typeof promptFeedback?.blockReason === 'string' &&
    promptFeedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED';
  let incomplete = raw.status < 200 || raw.status >= 300 || !candidate || finishReason !== 'STOP';
  if (finishReason && blockedReasons.has(finishReason)) refused = true;
  const content = object(candidate?.content);
  if (Array.isArray(content?.parts)) {
    for (const value of content.parts) {
      const part = object(value);
      if (part?.thought === true) continue;
      if (typeof part?.text === 'string') text.push(part.text);
      else if (part) incomplete = true;
    }
  }
  if (!text.length) incomplete = true;
  const usage = object(response?.usageMetadata);
  const inputTokens = usage?.promptTokenCount;
  const candidateTokens = usage?.candidatesTokenCount;
  const thoughtTokens = usage?.thoughtsTokenCount ?? 0;
  const validCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const outputTokens = validCount(candidateTokens) && validCount(thoughtTokens)
    ? candidateTokens + thoughtTokens : null;
  return {
    rawText: text.length ? text.join('') : null,
    refused,
    incomplete,
    usage: validCount(inputTokens) && outputTokens !== null && Number.isSafeInteger(outputTokens)
      ? { inputTokens, outputTokens } : null,
  };
}

const schemaKeys = new Set([
  '$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description',
  'enum', 'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum',
  'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required',
]);

function geminiSchemaNode(value: unknown): unknown {
  const source = object(value);
  if (!source) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === 'const') {
      if (!Object.hasOwn(source, 'enum')) result.enum = [child];
      continue;
    }
    if (!schemaKeys.has(key)) continue;
    if (key === 'properties' || key === '$defs') {
      const entries = object(child);
      if (entries) result[key] = Object.fromEntries(
        Object.entries(entries).map(([name, schema]) => [name, geminiSchemaNode(schema)]),
      );
    } else if (key === 'items' || (key === 'additionalProperties' && typeof child === 'object')) {
      result[key] = geminiSchemaNode(child);
    } else if (key === 'prefixItems' || key === 'anyOf' || key === 'oneOf') {
      if (Array.isArray(child)) result[key] = child.map(geminiSchemaNode);
    } else {
      result[key] = child;
    }
  }
  return result;
}

function geminiSchema<T>(schema: z.ZodType<T>, name: string): Record<string, unknown> {
  const normalized = object(geminiSchemaNode(z.toJSONSchema(schema)));
  if (!normalized) throw new ModelDispatchError('configuration_mismatch');
  return { ...normalized, title: name };
}

function retryDelay(headers: Headers): number | null {
  const milliseconds = headers.get('retry-after-ms');
  const seconds = headers.get('retry-after');
  const delay = milliseconds !== null ? Number(milliseconds)
    : seconds !== null && /^\d+(?:\.\d+)?$/.test(seconds) ? Number(seconds) * 1000
    : seconds !== null ? Date.parse(seconds) - Date.now() : NaN;
  return Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : null;
}

function errorFingerprint(raw: RawModelResponse | undefined): string {
  if (!raw) return '';
  const response = responseObject(raw);
  const error = object(response?.error);
  try {
    return JSON.stringify({ code: error?.code, status: error?.status, details: error?.details }).toUpperCase();
  } catch {
    return '';
  }
}

function failure(error: unknown, raw: RawModelResponse | undefined, signal: AbortSignal): ModelDispatchError {
  if (error instanceof ModelDispatchError) return error;
  const name = object(error)?.name;
  if (signal.aborted) return new ModelDispatchError(
    object(signal.reason)?.name === 'TimeoutError' ? 'timeout' : 'cancelled', false);
  if (name === 'TimeoutError') return new ModelDispatchError('timeout', true);
  if (name === 'AbortError') return new ModelDispatchError('cancelled');
  const status = raw?.status;
  const fingerprint = errorFingerprint(raw);
  if (status === 401 || status === 403 || /API_KEY_INVALID|UNAUTHENTICATED/.test(fingerprint)) {
    return new ModelDispatchError('authentication');
  }
  if (status === 404) return new ModelDispatchError('unsupported_model');
  if (status === 429) {
    const dailyQuota = /PERDAY|DAILY|QUOTA_EXCEEDED/.test(fingerprint);
    return new ModelDispatchError('rate_limited', !dailyQuota, raw?.retryAfterMs ?? null);
  }
  if (status === 408 || status === 504) return new ModelDispatchError('timeout', true, raw?.retryAfterMs ?? null);
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
    // No Gemini key lookup or transport fallback in fixture mode.
    return options.mockClient;
  }
  if (config.modelMode !== 'live' || !config.secrets.geminiApiKey?.trim() || !config.model.name?.trim() ||
      Object.values(config.model.roles).some(model => !model?.trim())) {
    throw new ModelDispatchError('configuration_mismatch');
  }
  const apiKey = config.secrets.geminiApiKey;
  const models = { ...config.model.roles };
  const limits = { ...config.model };
  const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== 'function') throw new ModelDispatchError('configuration_mismatch');

  return {
    mode: 'live',
    async dispatchStructured(request, onRawResponse) {
      if (!Object.hasOwn(models, request.role) || models[request.role] !== request.resolvedModelId ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(request.schemaName) ||
          !/^[A-Za-z0-9._-]{1,128}$/.test(request.resolvedModelId) ||
          !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 ||
          request.maxOutputTokens > limits.maxOutputTokens) throw new ModelDispatchError('configuration_mismatch');
      if (!request.messages.length || request.messages.some(message =>
        (message.role !== 'system' && message.role !== 'user') || typeof message.content !== 'string')) {
        throw new ModelDispatchError('input_invalid');
      }
      const messages = request.messages.map(({ role, content }) => ({ role, content }));
      if (messages[0]?.role !== 'system' || messages.length < 2 ||
          messages.slice(1).some(message => message.role !== 'user')) {
        throw new ModelDispatchError('input_invalid');
      }
      if (JSON.stringify(messages).length > limits.maxInputChars) throw new ModelDispatchError('input_budget_exceeded');
      let savedRaw: RawModelResponse | undefined;
      let storageFailed = false;
      let dispatched = false;
      try {
        request.abortSignal.throwIfAborted();
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.resolvedModelId)}:generateContent`;
        const body = JSON.stringify({
          systemInstruction: { parts: [{ text: messages[0]!.content }] },
          contents: messages.slice(1).map(message => ({ role: 'user', parts: [{ text: message.content }] })),
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: geminiSchema(request.outputSchema, request.schemaName),
            candidateCount: 1,
            maxOutputTokens: request.maxOutputTokens,
          },
          store: false,
        });
        dispatched = true;
        const response = await transport(endpoint, {
          method: 'POST', redirect: 'error', signal: request.abortSignal, body,
          headers: { accept: 'application/json', 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        });
        const raw = { body: await response.text(), status: response.status,
          requestId: response.headers.get('x-request-id') ?? response.headers.get('x-goog-request-id'),
          retryAfterMs: retryDelay(response.headers) };
        try { await onRawResponse(raw); }
        catch { storageFailed = true; throw new ModelDispatchError('transport_error'); }
        savedRaw = raw;
        if (!response.ok) throw failure(undefined, raw, request.abortSignal);
        const inspected = inspectRawResponse(raw);
        let output: unknown = null;
        if (inspected.rawText !== null) {
          try { output = JSON.parse(inspected.rawText); }
          catch { /* Runtime records and repairs malformed role JSON. */ }
        }
        return { output, ...inspected };
      } catch (error) {
        if (storageFailed) throw new ModelDispatchError('transport_error');
        if (!dispatched && !request.abortSignal.aborted) throw new ModelDispatchError('configuration_mismatch');
        throw failure(error, savedRaw, request.abortSignal);
      }
    },
  };
}
