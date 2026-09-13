import { CollectionReceiptSchema, type ReadResult } from '../../../shared/domain.js';
import { AdapterError, toReadFailureReason, type ReadFailureReason } from './errors.js';
import type { BoundedRestOperation, TransportResult } from './transport.js';

export interface ProviderPage<T> {
  records: T[];
  nextCursor: string | null;
}

export interface PaginationOptions<T> {
  operation: BoundedRestOperation;
  collectionId: string;
  producerId: string;
  queryId: string;
  fetchPage(
    cursor: string | null,
    pageIndex: number,
    operation: BoundedRestOperation,
  ): Promise<TransportResult<ProviderPage<T>>>;
}

function incomplete<T>(
  options: PaginationOptions<T>,
  startedAt: string,
  pages: Array<{
    queryId: string;
    cursor: string | null;
    nextCursor: string | null;
    recordCount: number;
    response: NonNullable<TransportResult<unknown>['receipt']>['responseRef'];
    providerAttemptId: string;
  }>,
  records: T[],
  reason: ReadFailureReason,
): ReadResult<T[]> {
  const receipt = CollectionReceiptSchema.parse({
    schemaVersion: 2,
    collectionId: options.collectionId,
    app: options.operation.context.app,
    accountRef: options.operation.context.accountRef,
    producerId: options.producerId,
    startedAt,
    finishedAt: options.operation.currentAt(),
    status: 'incomplete',
    reason,
    requiredQueryIds: [options.queryId],
    pages,
  });
  return records.length > 0
    ? { status: 'incomplete', reason, partialData: records, receipt }
    : { status: 'incomplete', reason, receipt };
}

export async function paginate<T>(options: PaginationOptions<T>): Promise<ReadResult<T[]>> {
  const startedAt = options.operation.currentAt();
  const records: T[] = [];
  const pages: Array<{
    queryId: string;
    cursor: string | null;
    nextCursor: string | null;
    recordCount: number;
    response: NonNullable<TransportResult<unknown>['receipt']>['responseRef'];
    providerAttemptId: string;
  }> = [];
  const seenCursors = new Set<string | null>();
  let cursor: string | null = null;

  while (true) {
    if (pages.length >= options.operation.context.budgets.maxPages || options.operation.remainingMs() <= 0) {
      return incomplete(options, startedAt, pages, records, 'budget_exhausted');
    }
    if (seenCursors.has(cursor)) return incomplete(options, startedAt, pages, records, 'malformed_response');
    seenCursors.add(cursor);

    const result = await options.fetchPage(cursor, pages.length, options.operation);
    if (result.status === 'failure') {
      const reason = pages.length > 0 ? 'page_failed' : toReadFailureReason(result.error);
      return incomplete(options, startedAt, pages, records, reason);
    }
    const page = result.data;
    if (!Array.isArray(page.records) ||
        (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0 || page.nextCursor.length > 2048)) ||
        result.receipt.responseRef === null) {
      return incomplete(options, startedAt, pages, records, 'malformed_response');
    }

    pages.push({
      queryId: options.queryId,
      cursor,
      nextCursor: page.nextCursor,
      recordCount: page.records.length,
      response: result.receipt.responseRef,
      providerAttemptId: result.receipt.context.providerAttemptId,
    });
    const available = options.operation.context.budgets.maxRecords - records.length;
    records.push(...page.records.slice(0, Math.max(0, available)));
    if (page.records.length > available) return incomplete(options, startedAt, pages, records, 'budget_exhausted');
    if (page.nextCursor === null) {
      const receipt = CollectionReceiptSchema.parse({
        schemaVersion: 2,
        collectionId: options.collectionId,
        app: options.operation.context.app,
        accountRef: options.operation.context.accountRef,
        producerId: options.producerId,
        startedAt,
        finishedAt: options.operation.currentAt(),
        status: 'complete',
        reason: null,
        requiredQueryIds: [options.queryId],
        pages,
      });
      return { status: 'complete', data: records, receipt };
    }
    if (seenCursors.has(page.nextCursor)) {
      return incomplete(options, startedAt, pages, records, 'malformed_response');
    }
    cursor = page.nextCursor;
  }
}

export function providerPage<T>(value: unknown, parseRecord: (value: unknown) => T): ProviderPage<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdapterError('malformed_response', { providerOutcome: 'error', isRetryable: false });
  }
  const candidate = value as { records?: unknown; nextCursor?: unknown };
  if (!Array.isArray(candidate.records) ||
      (candidate.nextCursor !== null && typeof candidate.nextCursor !== 'string')) {
    throw new AdapterError('malformed_response', { providerOutcome: 'error', isRetryable: false });
  }
  return { records: candidate.records.map(parseRecord), nextCursor: candidate.nextCursor };
}