import { z } from 'zod';

import {
  AccountScopeSchema,
  DraftWriteSchema,
  GmailDraftSchema,
  MutationOutcomeSchema,
  parseAdapterContext,
  type AccountScope,
  type GmailAdapter as GmailAdapterContract,
} from '../../shared/adapters.js';
import {
  CollectionReceiptSchema,
  EffectKeySchema,
  IdSchema,
  normalizeBody,
  type CollectionReceipt,
  type MutationOutcome,
  type ReadResult,
} from '../../shared/domain.js';
import { AdapterError, toReadFailureReason, type ReadFailureReason } from './common/errors.js';
import { paginate } from './common/pagination.js';
import type {
  BoundedRestOperation,
  BoundedRestTransport,
  TransportFailure,
  TransportResult,
  TransportSuccess,
} from './common/transport.js';
import { encodeGmailRawMessage, parseGmailRawMessage } from './gmail-mime.js';

const GMAIL_API_ORIGIN = 'https://gmail.googleapis.com';
const GMAIL_API_ROOT = '/gmail/v1/users/me';
const GMAIL_PAGE_SIZE = 500;
const PRODUCER_ID = 'gmail-adapter-v1';

const GmailDraftStubSchema = z.object({ id: IdSchema }).passthrough();
const GmailDraftListResponseSchema = z.object({
  drafts: z.array(GmailDraftStubSchema).max(GMAIL_PAGE_SIZE).optional(),
  nextPageToken: z.string().min(1).max(2048).optional(),
}).passthrough();
const GmailDraftCreateResponseSchema = z.object({
  id: IdSchema,
  message: z.object({ id: IdSchema }).passthrough(),
}).passthrough();
const GmailDraftRawResponseSchema = z.object({
  id: IdSchema,
  message: z.object({
    id: IdSchema,
    labelIds: z.array(z.string().min(1).max(160)).max(100),
    historyId: IdSchema,
    raw: z.string().min(1),
  }).passthrough(),
}).passthrough();

type GmailDraft = z.infer<typeof GmailDraftSchema>;
type DraftWrite = z.infer<typeof DraftWriteSchema>;
type ListDraftsContext = Parameters<GmailAdapterContract['listDrafts']>[0];
type FindDraftsContext = Parameters<GmailAdapterContract['findDrafts']>[1];
type GetDraftContext = Parameters<GmailAdapterContract['getDraft']>[1];
type CreateDraftContext = Parameters<GmailAdapterContract['createDraft']>[1];

interface ReceiptPage {
  queryId: string;
  cursor: string | null;
  nextCursor: string | null;
  recordCount: number;
  response: NonNullable<TransportSuccess<unknown>['receipt']['responseRef']>;
  providerAttemptId: string;
}

interface ObservedDraft {
  draft: GmailDraft;
  effectMarkers: string[];
}

export interface GmailAdapterOptions {
  scope: AccountScope;
  accessToken: string;
  transport: BoundedRestTransport;
}

function responsePage(
  queryId: string,
  cursor: string | null,
  nextCursor: string | null,
  recordCount: number,
  result: TransportSuccess<unknown>,
): ReceiptPage {
  const response = result.receipt.responseRef;
  if (!response) {
    throw new AdapterError('receipt_persistence_failed', {
      providerOutcome: 'unknown',
      isRetryable: false,
    });
  }
  return {
    queryId,
    cursor,
    nextCursor,
    recordCount,
    response,
    providerAttemptId: result.receipt.context.providerAttemptId,
  };
}

function collectionReceipt(
  operation: BoundedRestOperation,
  startedAt: string,
  requiredQueryIds: string[],
  pages: ReceiptPage[],
  status: 'complete' | 'incomplete',
  reason: ReadFailureReason | null,
): CollectionReceipt {
  return CollectionReceiptSchema.parse({
    schemaVersion: 2,
    collectionId: operation.context.logicalCallId,
    app: 'gmail',
    accountRef: operation.context.accountRef,
    producerId: PRODUCER_ID,
    startedAt,
    finishedAt: operation.currentAt(),
    status,
    reason,
    requiredQueryIds,
    pages,
  });
}

function complete<T>(
  operation: BoundedRestOperation,
  startedAt: string,
  requiredQueryIds: string[],
  pages: ReceiptPage[],
  data: T,
): ReadResult<T> {
  return {
    status: 'complete',
    data,
    receipt: collectionReceipt(operation, startedAt, requiredQueryIds, pages, 'complete', null),
  };
}

function incomplete<T>(
  operation: BoundedRestOperation,
  startedAt: string,
  requiredQueryIds: string[],
  pages: ReceiptPage[],
  reason: ReadFailureReason,
  partialData?: T,
): ReadResult<T> {
  const receipt = collectionReceipt(operation, startedAt, requiredQueryIds, pages, 'incomplete', reason);
  return partialData === undefined
    ? { status: 'incomplete', reason, receipt }
    : { status: 'incomplete', reason, partialData, receipt };
}

function mutationOutcome(result: TransportFailure): MutationOutcome {
  if (!result.receiptRef) throw result.error;
  if (['denied', 'rate_limited', 'invalid'].includes(result.error.providerOutcome)) {
    const reason = result.error.code === 'denied'
      ? 'denied'
      : result.error.code === 'rate_limited'
        ? 'rate_limited'
        : 'malformed_response';
    return MutationOutcomeSchema.parse({ status: 'not_applied', reason, receipt: result.receiptRef });
  }
  const reason = result.error.code === 'timeout' || result.error.code === 'malformed_response'
    ? result.error.code
    : 'transport_error';
  return MutationOutcomeSchema.parse({ status: 'unknown', reason, receipt: result.receiptRef });
}

export function gmailEffectMarker(effectKey: string): string {
  return EffectKeySchema.parse(effectKey);
}

export class RestGmailAdapter implements GmailAdapterContract {
  readonly scope: Readonly<AccountScope>;
  readonly mode = 'rest' as const;
  private readonly accessToken: string;
  private readonly transport: BoundedRestTransport;

  constructor(options: GmailAdapterOptions) {
    const scope = AccountScopeSchema.parse(options.scope);
    if (scope.app !== 'gmail') throw new Error('gmail_scope_required');
    if (options.accessToken.trim().length === 0 || /[\r\n]/.test(options.accessToken)) {
      throw new Error('gmail_access_token_required');
    }
    this.scope = Object.freeze(scope);
    this.accessToken = options.accessToken;
    this.transport = options.transport;
  }

  async listDrafts(context: ListDraftsContext): Promise<ReadResult<GmailDraft[]>> {
    const result = await this.collectDrafts(context, 'gmail.listDrafts');
    return this.projectDrafts(result);
  }

  async findDrafts(markerValue: string, context: FindDraftsContext): Promise<ReadResult<GmailDraft[]>> {
    const marker = gmailEffectMarker(markerValue);
    const result = await this.collectDrafts(context, 'gmail.findDrafts');
    const select = (drafts: ObservedDraft[]) => drafts
      .filter(candidate => candidate.effectMarkers.includes(marker))
      .map(candidate => candidate.draft);
    return result.status === 'complete'
      ? { ...result, data: select(result.data) }
      : result.partialData
        ? { ...result, partialData: select(result.partialData) }
        : { status: 'incomplete', reason: result.reason, receipt: result.receipt };
  }

  async getDraft(idValue: string, context: GetDraftContext): Promise<ReadResult<GmailDraft | null>> {
    const id = IdSchema.parse(idValue);
    const parsedContext = parseAdapterContext(context, this.scope, 'gmail.getDraft');
    const operation = this.transport.begin(parsedContext);
    const startedAt = operation.currentAt();
    const requiredQueryIds = ['draft'];
    const result = await this.fetchDraft(id, operation, true);
    if (result.status === 'failure') {
      return incomplete<GmailDraft | null>(
        operation, startedAt, requiredQueryIds, [], toReadFailureReason(result.error),
      );
    }
    const pages = [responsePage('draft', null, null, result.data ? 1 : 0, result)];
    const draft = result.data ? this.normalizeDraft(result.data, result) : null;
    return complete(operation, startedAt, requiredQueryIds, pages, draft?.draft ?? null);
  }

  async createDraft(inputValue: DraftWrite, context: CreateDraftContext): Promise<MutationOutcome> {
    const input = DraftWriteSchema.parse(inputValue);
    if (input.body !== normalizeBody(input.body)) {
      throw new AdapterError('invalid', { providerOutcome: 'invalid', isRetryable: false });
    }
    const parsedContext = parseAdapterContext(context, this.scope, 'gmail.createDraft');
    const operation = this.transport.begin(parsedContext);
    const raw = encodeGmailRawMessage({
      ...input,
      effectMarker: gmailEffectMarker(context.effectKey),
    });
    const result = await operation.request({
      url: this.apiUrl('/drafts'),
      method: 'POST',
      headers: this.writeHeaders(),
      body: JSON.stringify({ message: { raw } }),
      decode: body => GmailDraftCreateResponseSchema.parse(body),
    });
    if (result.status === 'failure') return mutationOutcome(result);
    return MutationOutcomeSchema.parse({
      status: 'applied',
      providerId: result.data.id,
      receipt: result.receiptRef,
    });
  }

  private async collectDrafts(
    context: ListDraftsContext | FindDraftsContext,
    operationName: 'gmail.listDrafts' | 'gmail.findDrafts',
  ): Promise<ReadResult<ObservedDraft[]>> {
    const parsedContext = parseAdapterContext(context, this.scope, operationName);
    const operation = this.transport.begin(parsedContext);
    const startedAt = operation.currentAt();
    const listing = await paginate({
      operation,
      collectionId: operation.context.logicalCallId,
      producerId: PRODUCER_ID,
      queryId: 'draft-list',
      fetchPage: cursor => operation.request({
        url: this.listUrl(cursor),
        method: 'GET',
        headers: this.readHeaders(),
        decode: body => {
          const parsed = GmailDraftListResponseSchema.parse(body);
          return {
            records: parsed.drafts ?? [],
            nextCursor: parsed.nextPageToken ?? null,
          };
        },
      }),
    });
    const stubs = listing.status === 'complete' ? listing.data : listing.partialData ?? [];
    const pages = [...listing.receipt.pages] as ReceiptPage[];
    const requiredQueryIds = stubs.length > 0 ? ['draft-list', 'draft-details'] : ['draft-list'];
    const drafts: ObservedDraft[] = [];

    for (let index = 0; index < stubs.length; index += 1) {
      if (pages.length >= operation.context.budgets.maxPages || operation.remainingMs() <= 0) {
        return incomplete(operation, startedAt, requiredQueryIds, pages, 'budget_exhausted', drafts);
      }
      const result = await this.fetchDraft(stubs[index].id, operation, false);
      if (result.status === 'failure') {
        return incomplete(operation, startedAt, requiredQueryIds, pages, toReadFailureReason(result.error), drafts);
      }
      const cursor = index === 0 ? null : `draft-${index}`;
      const nextCursor = index + 1 < stubs.length ? `draft-${index + 1}` : null;
      pages.push(responsePage('draft-details', cursor, nextCursor, 1, result));
      if (!result.data) {
        return incomplete(operation, startedAt, requiredQueryIds, pages, 'malformed_response', drafts);
      }
      drafts.push(this.normalizeDraft(result.data, result));
    }

    if (listing.status === 'incomplete') {
      return incomplete(operation, startedAt, requiredQueryIds, pages, listing.reason, drafts);
    }
    return complete(operation, startedAt, requiredQueryIds, pages, drafts);
  }

  private projectDrafts(result: ReadResult<ObservedDraft[]>): ReadResult<GmailDraft[]> {
    if (result.status === 'complete') {
      return { ...result, data: result.data.map(candidate => candidate.draft) };
    }
    return result.partialData
      ? { ...result, partialData: result.partialData.map(candidate => candidate.draft) }
      : { status: 'incomplete', reason: result.reason, receipt: result.receipt };
  }

  private fetchDraft(
    id: string,
    operation: BoundedRestOperation,
    acceptMissing: boolean,
  ): Promise<TransportResult<z.infer<typeof GmailDraftRawResponseSchema> | null>> {
    return operation.request({
      url: this.apiUrl(`/drafts/${encodeURIComponent(id)}?format=raw`),
      method: 'GET',
      headers: this.readHeaders(),
      acceptsStatus: status => status >= 200 && status <= 299 || (acceptMissing && status === 404),
      decode: (body, response) => response.status === 404
        ? null
        : GmailDraftRawResponseSchema.parse(body),
    });
  }

  private normalizeDraft(
    response: z.infer<typeof GmailDraftRawResponseSchema>,
    result: TransportSuccess<unknown>,
  ): ObservedDraft {
    const rawMimeRef = result.receipt.responseRef;
    if (!rawMimeRef) {
      throw new AdapterError('receipt_persistence_failed', {
        providerOutcome: 'unknown',
        isRetryable: false,
      });
    }
    const parsed = parseGmailRawMessage(response.message.raw);
    return {
      draft: GmailDraftSchema.parse({
        draftId: response.id,
        messageId: response.message.id,
        to: parsed.to,
        cc: parsed.cc,
        bcc: parsed.bcc,
        subject: parsed.subject,
        body: parsed.body,
        isDraft: response.message.labelIds.includes('DRAFT'),
        rawMimeRef,
        version: response.message.historyId,
      }),
      effectMarkers: parsed.effectMarkers,
    };
  }

  private readHeaders(): HeadersInit {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.accessToken}`,
    };
  }

  private writeHeaders(): HeadersInit {
    return { ...this.readHeaders(), 'Content-Type': 'application/json' };
  }

  private listUrl(pageToken: string | null): URL {
    const url = this.apiUrl('/drafts');
    url.searchParams.set('maxResults', String(GMAIL_PAGE_SIZE));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    return url;
  }

  private apiUrl(path: string): URL {
    return new URL(`${GMAIL_API_ROOT}${path}`, GMAIL_API_ORIGIN);
  }
}

export function createGmailAdapter(options: GmailAdapterOptions): GmailAdapterContract {
  return new RestGmailAdapter(options);
}