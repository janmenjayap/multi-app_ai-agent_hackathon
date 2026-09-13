import {
  AccountScopeSchema,
  MutationOutcomeSchema,
  SlackMessageSchema,
  SlackWriteSchema,
  parseAdapterContext,
  type AccountScope,
  type AdapterCallContext,
  type AdapterOperation,
  type SlackAdapter,
} from '../../shared/adapters.js';
import { IdSchema, type MutationOutcome, type ReadResult } from '../../shared/domain.js';
import { AdapterError, parseRetryAfterMs, toReadFailureReason } from './common/errors.js';
import { paginate, type ProviderPage } from './common/pagination.js';
import type { BoundedRestOperation, BoundedRestTransport, TransportResult } from './common/transport.js';

const SLACK_API_BASE_URL = 'https://slack.com/api/';
const SLACK_PAGE_SIZE = '100';
const DENIED_ERRORS = new Set([
  'account_inactive',
  'ekm_access_denied',
  'invalid_auth',
  'missing_scope',
  'no_permission',
  'not_allowed_token_type',
  'not_authed',
  'org_login_required',
  'token_revoked',
]);
const RETRYABLE_ERRORS = new Set(['fatal_error', 'internal_error', 'service_unavailable']);

type SlackMessage = Extract<Awaited<ReturnType<SlackAdapter['readApprovalThread']>>, {
  status: 'complete';
}>['data'][number];
type SlackWrite = Parameters<SlackAdapter['postReview']>[0];

export interface SlackAdapterOptions {
  scope: AccountScope;
  workspaceId: string;
  channelId: string;
  readerToken: string;
  writerToken: string;
  transport: BoundedRestTransport;
}

type JsonObject = Record<string, unknown>;

function invalid(): AdapterError {
  return new AdapterError('invalid', { providerOutcome: 'invalid', isRetryable: false });
}

function malformed(): AdapterError {
  return new AdapterError('malformed_response', { providerOutcome: 'error', isRetryable: false });
}

function objectValue(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  return value as JsonObject;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function slackError(value: JsonObject, headers: Headers, wallNowMs: number): AdapterError {
  const code = optionalString(value.error);
  if (!code) return malformed();
  if (DENIED_ERRORS.has(code)) {
    return new AdapterError('denied', { providerOutcome: 'denied', isRetryable: false });
  }
  if (code === 'ratelimited') {
    return new AdapterError('rate_limited', {
      providerOutcome: 'rate_limited',
      isRetryable: true,
      retryAfterMs: parseRetryAfterMs(headers.get('retry-after'), wallNowMs) ?? undefined,
    });
  }
  if (RETRYABLE_ERRORS.has(code)) {
    return new AdapterError('provider_error', { providerOutcome: 'error', isRetryable: true });
  }
  return new AdapterError('invalid', { providerOutcome: 'invalid', isRetryable: false });
}

function slackEnvelope(value: unknown, headers: Headers, wallNowMs: number): JsonObject {
  const envelope = objectValue(value);
  if (envelope.ok === false) throw slackError(envelope, headers, wallNowMs);
  if (envelope.ok !== true) throw malformed();
  return envelope;
}

function slackTimestampToUtc(value: unknown): string | null {
  const timestamp = optionalString(value);
  if (timestamp === null) return null;
  const epochSeconds = Number(timestamp);
  if (!Number.isFinite(epochSeconds) || epochSeconds < 0) throw malformed();
  return new Date(epochSeconds * 1000).toISOString();
}

function normalizeMessage(
  value: unknown,
  workspaceId: string,
  channelId: string,
  observedAt: string,
  fallbackThreadTs?: string,
): SlackMessage {
  const outer = objectValue(value);
  const nested = outer.message && typeof outer.message === 'object' && !Array.isArray(outer.message)
    ? outer.message as JsonObject
    : outer;
  const previous = outer.previous_message && typeof outer.previous_message === 'object' && !Array.isArray(outer.previous_message)
    ? outer.previous_message as JsonObject
    : null;
  const source = nested === outer && previous ? previous : nested;
  const subtype = optionalString(outer.subtype) ?? optionalString(source.subtype);
  const isDeleted = outer.hidden === true || subtype === 'message_deleted' || subtype === 'tombstone';
  const messageTs = (isDeleted ? optionalString(outer.deleted_ts) : null) ??
    optionalString(source.ts) ?? optionalString(outer.ts);
  if (messageTs === null) throw malformed();
  const threadTs = optionalString(source.thread_ts) ?? fallbackThreadTs ?? messageTs;
  const actorId = optionalString(source.user) ?? optionalString(outer.user) ??
    optionalString(source.bot_id) ?? optionalString(source.app_id) ?? 'unknown_actor';
  const isBot = source.bot_profile !== undefined || optionalString(source.bot_id) !== null ||
    optionalString(source.app_id) !== null || subtype === 'bot_message';
  const edited = source.edited && typeof source.edited === 'object' && !Array.isArray(source.edited)
    ? source.edited as JsonObject
    : null;

  return SlackMessageSchema.parse({
    workspaceId,
    channelId,
    threadTs,
    messageTs,
    actorId,
    isBot,
    subtype,
    editedAt: slackTimestampToUtc(edited?.ts),
    deleted: isDeleted,
    body: typeof source.text === 'string' ? source.text : '',
    observedAt,
  });
}

function slackPage(
  value: unknown,
  headers: Headers,
  wallNowMs: number,
  normalize: (message: unknown) => SlackMessage,
): ProviderPage<SlackMessage> {
  const envelope = slackEnvelope(value, headers, wallNowMs);
  if (!Array.isArray(envelope.messages)) throw malformed();
  const responseMetadata = envelope.response_metadata === undefined
    ? {}
    : objectValue(envelope.response_metadata);
  const cursorValue = responseMetadata.next_cursor;
  if (cursorValue !== undefined && typeof cursorValue !== 'string') throw malformed();
  const nextCursor = typeof cursorValue === 'string' && cursorValue.length > 0 ? cursorValue : null;
  if (envelope.has_more === true && nextCursor === null) throw malformed();
  return { records: envelope.messages.map(normalize), nextCursor };
}

function headers(token: string, hasJsonBody = false): HeadersInit {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    ...(hasJsonBody ? { 'content-type': 'application/json; charset=utf-8' } : {}),
  };
}

function endpoint(method: string, parameters: Record<string, string | null>): URL {
  const url = new URL(method, SLACK_API_BASE_URL);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return url;
}

function collectionId(context: AdapterCallContext): string {
  return context.logicalCallId;
}

function filterReadResult<T, U>(result: ReadResult<T[]>, project: (records: T[]) => U): ReadResult<U> {
  if (result.status === 'complete') {
    return { status: 'complete', data: project(result.data), receipt: result.receipt };
  }
  return result.partialData === undefined
    ? { status: 'incomplete', reason: result.reason, receipt: result.receipt }
    : { status: 'incomplete', reason: result.reason, partialData: project(result.partialData), receipt: result.receipt };
}

function unknownMutationReason(error: AdapterError): Extract<MutationOutcome, { status: 'unknown' }>['reason'] {
  if (error.code === 'timeout' || error.code === 'malformed_response') return error.code;
  return 'transport_error';
}

function mutationOutcome(result: TransportResult<string>): MutationOutcome {
  if (result.status === 'success') {
    return MutationOutcomeSchema.parse({
      status: 'applied',
      providerId: result.data,
      receipt: result.receiptRef,
    });
  }
  if (result.receiptRef === null) throw result.error;
  if (['denied', 'rate_limited', 'invalid'].includes(result.error.providerOutcome)) {
    return MutationOutcomeSchema.parse({
      status: 'not_applied',
      reason: toReadFailureReason(result.error),
      receipt: result.receiptRef,
    });
  }
  return MutationOutcomeSchema.parse({
    status: 'unknown',
    reason: unknownMutationReason(result.error),
    receipt: result.receiptRef,
  });
}

export function createSlackAdapter(options: SlackAdapterOptions): SlackAdapter {
  const scope = AccountScopeSchema.parse(options.scope);
  if (scope.app !== 'slack') throw invalid();
  const workspaceId = IdSchema.parse(options.workspaceId.trim());
  const channelId = IdSchema.parse(options.channelId.trim());
  if (!options.readerToken || !options.writerToken) throw invalid();

  function assertChannel(value: string): void {
    if (value !== channelId) throw invalid();
  }

  function begin(context: unknown, operation: AdapterOperation): BoundedRestOperation {
    return options.transport.begin(parseAdapterContext(context, scope, operation));
  }

  async function readHistory(
    context: AdapterCallContext,
    method: 'conversations.history' | 'conversations.replies',
    parameters: Record<string, string>,
    queryId: string,
    fallbackThreadTs?: string,
  ): Promise<ReadResult<SlackMessage[]>> {
    const operation = begin(context, context.operation);
    return paginate({
      operation,
      collectionId: collectionId(context),
      producerId: 'slack-adapter',
      queryId,
      fetchPage: (cursor, _pageIndex, currentOperation) => currentOperation.request({
        url: endpoint(method, { ...parameters, cursor }),
        method: 'GET',
        headers: headers(options.readerToken),
        decode: (body, response) => slackPage(
          body,
          response.headers,
          Date.parse(currentOperation.currentAt()),
          message => normalizeMessage(message, workspaceId, channelId, currentOperation.currentAt(), fallbackThreadTs),
        ),
      }),
    });
  }

  async function readMessage(
    context: AdapterCallContext,
    messageTs: string,
    queryId: string,
  ): Promise<ReadResult<SlackMessage | null>> {
    const parsedMessageTs = IdSchema.parse(messageTs);
    const result = await readHistory(context, 'conversations.history', {
      channel: channelId,
      oldest: parsedMessageTs,
      latest: parsedMessageTs,
      inclusive: 'true',
      limit: SLACK_PAGE_SIZE,
    }, queryId);
    return filterReadResult(result, messages => messages.find(message => message.messageTs === parsedMessageTs) ?? null);
  }

  async function coordinate(
    context: AdapterCallContext,
    method: 'chat.postMessage' | 'chat.update',
    inputValue: SlackWrite,
    messageTs?: string,
  ): Promise<MutationOutcome> {
    const input = SlackWriteSchema.parse(inputValue);
    assertChannel(input.channelId);
    if (!('marker' in context) || !input.body.includes(context.marker)) throw invalid();
    if (method === 'chat.update' && !messageTs) throw invalid();
    const operation = begin(context, context.operation);
    const result = await operation.request({
      url: endpoint(method, {}),
      method: 'POST',
      headers: headers(options.writerToken, true),
      body: JSON.stringify({
        channel: channelId,
        text: input.body,
        ...(method === 'chat.postMessage' && input.threadTs !== null ? { thread_ts: input.threadTs } : {}),
        ...(messageTs ? { ts: messageTs } : {}),
      }),
      decode: (body, response) => {
        const envelope = slackEnvelope(body, response.headers, Date.parse(operation.currentAt()));
        const responseChannel = optionalString(envelope.channel);
        const responseTs = optionalString(envelope.ts);
        if (responseChannel !== channelId || responseTs === null || (messageTs && responseTs !== messageTs)) throw malformed();
        return responseTs;
      },
    });
    return mutationOutcome(result);
  }

  const adapter: SlackAdapter = {
    scope: Object.freeze(scope),
    mode: 'rest',

    async readApprovalThread(requestedChannelId, threadTs, context) {
      assertChannel(requestedChannelId);
      const parsedThreadTs = IdSchema.parse(threadTs);
      const parsed = parseAdapterContext(context, scope, 'slack.readApprovalThread');
      return readHistory(parsed, 'conversations.replies', {
        channel: channelId,
        ts: parsedThreadTs,
        limit: SLACK_PAGE_SIZE,
      }, 'slack-approval-thread', parsedThreadTs);
    },

    async getMessage(requestedChannelId, messageTs, context) {
      assertChannel(requestedChannelId);
      const parsed = parseAdapterContext(context, scope, 'slack.getMessage');
      return readMessage(parsed, messageTs, 'slack-message');
    },

    async findReview(marker, context) {
      if (!marker || marker.length > 40000) throw invalid();
      const parsed = parseAdapterContext(context, scope, 'slack.findReview');
      const result = await readHistory(parsed, 'conversations.history', {
        channel: channelId,
        limit: SLACK_PAGE_SIZE,
      }, 'slack-review-history');
      return filterReadResult(result, messages => messages.filter(message => message.body.includes(marker)));
    },

    async readSummary(requestedChannelId, messageTs, context) {
      assertChannel(requestedChannelId);
      const parsed = parseAdapterContext(context, scope, 'slack.readSummary');
      return readMessage(parsed, messageTs, 'slack-summary');
    },

    async postReview(input, context) {
      const parsed = parseAdapterContext(context, scope, 'slack.postReview');
      return coordinate(parsed, 'chat.postMessage', input);
    },

    async updateReview(messageTs, input, context) {
      const parsed = parseAdapterContext(context, scope, 'slack.updateReview');
      return coordinate(parsed, 'chat.update', input, messageTs);
    },

    async postSummary(input, context) {
      const parsed = parseAdapterContext(context, scope, 'slack.postSummary');
      return coordinate(parsed, 'chat.postMessage', input);
    },

    async updateSummary(messageTs, input, context) {
      const parsed = parseAdapterContext(context, scope, 'slack.updateSummary');
      return coordinate(parsed, 'chat.update', input, messageTs);
    },
  };

  return adapter;
}