import { z } from 'zod';

import {
  AccountScopeSchema,
  HubSpotCommitmentBundleSchema,
  HubSpotNoteSchema,
  HubSpotTaskSchema,
  NoteWriteSchema,
  TaskWriteSchema,
  parseAdapterContext,
  type AdapterCallContext,
  type HubSpotAdapter,
} from '../../shared/adapters.js';
import {
  CollectionReceiptSchema,
  IdSchema,
  MutationOutcomeSchema,
  readResultSchema,
  type CollectionReceipt,
  type MutationOutcome,
  type ReadResult,
} from '../../shared/domain.js';
import { AdapterError, type ReadFailureReason } from './common/errors.js';
import { paginate, type ProviderPage } from './common/pagination.js';
import type {
  BoundedRestOperation,
  BoundedRestTransport,
  TransportFailure,
  TransportResult,
} from './common/transport.js';

const HUBSPOT_API_URL = 'https://api.hubapi.com';
const PRODUCER_ID = 'hubspot-adapter-v1';
const MAX_RECEIPT_QUERIES = 100;
const OBJECT_PAGE_SIZE = 100;
const ASSOCIATION_PAGE_SIZE = 100;

const PropertyNameSchema = z.string().regex(/^[a-zA-Z0-9_]{1,160}$/);
const AssociationTypeSchema = z.object({
  associationCategory: z.enum(['HUBSPOT_DEFINED', 'USER_DEFINED', 'INTEGRATOR_DEFINED']),
  associationTypeId: z.number().int().positive(),
}).strict();

export const HubSpotMappingSchema = z.object({
  schemaVersion: z.literal(1),
  apiFamily: z.literal('v3_objects_v4_associations'),
  ticketProperties: z.object({
    service: PropertyNameSchema,
    status: PropertyNameSchema,
    dueAt: PropertyNameSchema,
    promise: PropertyNameSchema,
    ownerId: PropertyNameSchema,
  }).strict(),
  companyProperties: z.object({ name: PropertyNameSchema }).strict(),
  contactProperties: z.object({
    email: PropertyNameSchema,
    designated: PropertyNameSchema,
    designatedTrueValue: z.string(),
    designatedFalseValue: z.string().nullable(),
  }).strict(),
  taskType: z.string().min(1).max(160),
  associationTypes: z.object({
    taskToCompany: AssociationTypeSchema,
    taskToCommitment: AssociationTypeSchema,
    noteToCompany: AssociationTypeSchema,
    noteToCommitment: AssociationTypeSchema,
    noteToTask: AssociationTypeSchema,
  }).strict(),
}).strict();

export type HubSpotMapping = z.infer<typeof HubSpotMappingSchema>;

export interface HubSpotAdapterOptions {
  accountRef: string;
  accessToken: string;
  mapping: HubSpotMapping;
  transport: BoundedRestTransport;
}

const PropertyValueSchema = z.union([z.string(), z.null()]);
const HubSpotObjectSchema = z.object({
  id: IdSchema,
  properties: z.record(z.string(), PropertyValueSchema),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();
const HubSpotOwnerSchema = z.object({
  id: IdSchema,
  archived: z.boolean(),
}).passthrough();
const HubSpotPageSchema = z.object({
  results: z.array(z.unknown()),
  paging: z.object({
    next: z.object({ after: z.union([z.string(), z.number().int().nonnegative()]) }).passthrough(),
  }).passthrough().optional(),
}).passthrough();
const HubSpotAssociationPageSchema = z.object({
  results: z.array(z.object({
    toObjectId: z.union([z.string(), z.number().int().nonnegative()]),
  }).passthrough()),
  paging: z.object({
    next: z.object({ after: z.union([z.string(), z.number().int().nonnegative()]) }).passthrough(),
  }).passthrough().optional(),
}).passthrough();
const HubSpotCreateResponseSchema = z.object({ id: IdSchema }).passthrough();

type HubSpotObject = z.infer<typeof HubSpotObjectSchema>;
type HubSpotOwner = z.infer<typeof HubSpotOwnerSchema>;
type CommitmentBundle = z.infer<typeof HubSpotCommitmentBundleSchema>;
type HubSpotTask = z.infer<typeof HubSpotTaskSchema>;
type HubSpotNote = z.infer<typeof HubSpotNoteSchema>;
type BundleContext = Parameters<HubSpotAdapter['readCommitmentBundle']>[1];
type FindTaskContext = Parameters<HubSpotAdapter['findTasks']>[1];
type GetTaskContext = Parameters<HubSpotAdapter['getTask']>[1];
type FindNoteContext = Parameters<HubSpotAdapter['findNotes']>[1];
type GetNoteContext = Parameters<HubSpotAdapter['getNote']>[1];
type CreateTaskInput = Parameters<HubSpotAdapter['createTask']>[0];
type CreateTaskContext = Parameters<HubSpotAdapter['createTask']>[1];
type CreateNoteInput = Parameters<HubSpotAdapter['createNote']>[0];
type CreateNoteContext = Parameters<HubSpotAdapter['createNote']>[1];

function nextCursor(value: z.infer<typeof HubSpotPageSchema>['paging']): string | null {
  return value?.next ? String(value.next.after) : null;
}

function objectPage(value: unknown): ProviderPage<HubSpotObject> {
  const page = HubSpotPageSchema.parse(value);
  return {
    records: page.results.map(record => HubSpotObjectSchema.parse(record)),
    nextCursor: nextCursor(page.paging),
  };
}

function ownerPage(value: unknown): ProviderPage<HubSpotOwner> {
  const page = HubSpotPageSchema.parse(value);
  return {
    records: page.results.map(record => HubSpotOwnerSchema.parse(record)),
    nextCursor: nextCursor(page.paging),
  };
}

function associationPage(value: unknown): ProviderPage<string> {
  const page = HubSpotAssociationPageSchema.parse(value);
  return {
    records: page.results.map(record => IdSchema.parse(String(record.toObjectId))),
    nextCursor: nextCursor(page.paging),
  };
}

function requiredProperty(object: HubSpotObject, name: string): string {
  const value = object.properties[name];
  if (typeof value !== 'string') throw malformedResponse();
  return value;
}

function nullableProperty(object: HubSpotObject, name: string): string | null {
  const value = object.properties[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw malformedResponse();
  return value;
}

function nullableIdProperty(object: HubSpotObject, name: string): string | null {
  const value = nullableProperty(object, name);
  return value === null || value === '' ? null : IdSchema.parse(value);
}

function objectVersion(object: HubSpotObject): string {
  return IdSchema.parse(object.updatedAt ?? object.createdAt);
}

function malformedResponse(): AdapterError {
  return new AdapterError('malformed_response', {
    providerOutcome: 'error',
    isRetryable: false,
  });
}

function hubSpotUrl(path: string, query: Record<string, string | null> = {}): URL {
  const url = new URL(path, HUBSPOT_API_URL);
  for (const [name, value] of Object.entries(query)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return url;
}

function uniquePropertyList(names: string[]): string {
  return [...new Set(names)].join(',');
}

function hasMarker(value: string, marker: string): boolean {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-zA-Z0-9_.:-])${escaped}($|[^a-zA-Z0-9_.:-])`).test(value);
}

function mutationFailure(result: TransportFailure): MutationOutcome {
  if (!result.receiptRef) throw result.error;
  switch (result.error.code) {
    case 'denied':
      return MutationOutcomeSchema.parse({ status: 'not_applied', reason: 'denied', receipt: result.receiptRef });
    case 'rate_limited':
      return MutationOutcomeSchema.parse({ status: 'not_applied', reason: 'rate_limited', receipt: result.receiptRef });
    case 'invalid':
      return MutationOutcomeSchema.parse({ status: 'not_applied', reason: 'malformed_response', receipt: result.receiptRef });
    case 'timeout':
      return MutationOutcomeSchema.parse({ status: 'unknown', reason: 'timeout', receipt: result.receiptRef });
    case 'transport_error':
    case 'cancelled':
    case 'budget_exhausted':
      return MutationOutcomeSchema.parse({ status: 'unknown', reason: 'transport_error', receipt: result.receiptRef });
    default:
      return MutationOutcomeSchema.parse({ status: 'unknown', reason: 'malformed_response', receipt: result.receiptRef });
  }
}

class ReadCollection {
  private readonly receipts: CollectionReceipt[] = [];
  private readonly queryIds = new Set<string>();
  private failureReason: ReadFailureReason | null = null;

  constructor(
    private readonly operation: BoundedRestOperation,
    private readonly collectionId: string,
  ) {}

  get isComplete(): boolean {
    return this.failureReason === null;
  }

  fail(reason: ReadFailureReason): void {
    this.failureReason ??= reason;
  }

  async query<T>(
    queryId: string,
    fetchPage: (
      cursor: string | null,
      pageIndex: number,
      operation: BoundedRestOperation,
    ) => Promise<TransportResult<ProviderPage<T>>>,
  ): Promise<T[]> {
    if (!this.isComplete) return [];
    const parsedQueryId = IdSchema.parse(queryId);
    const pagesUsed = this.receipts.reduce((count, receipt) => count + receipt.pages.length, 0);
    const recordsUsed = this.receipts.reduce(
      (count, receipt) => count + receipt.pages.reduce((sum, page) => sum + page.recordCount, 0),
      0,
    );
    if (this.queryIds.size >= MAX_RECEIPT_QUERIES ||
        pagesUsed >= this.operation.context.budgets.maxPages ||
        recordsUsed >= this.operation.context.budgets.maxRecords) {
      this.fail('budget_exhausted');
      return [];
    }
    if (this.queryIds.has(parsedQueryId)) {
      this.fail('malformed_response');
      return [];
    }
    this.queryIds.add(parsedQueryId);
    const context: AdapterCallContext = {
      ...this.operation.context,
      budgets: {
        ...this.operation.context.budgets,
        maxPages: this.operation.context.budgets.maxPages - pagesUsed,
        maxRecords: this.operation.context.budgets.maxRecords - recordsUsed,
      },
    };
    const boundedOperation: BoundedRestOperation = {
      context,
      currentAt: () => this.operation.currentAt(),
      remainingMs: () => this.operation.remainingMs(),
      request: request => this.operation.request(request),
    };
    const result = await paginate({
      operation: boundedOperation,
      collectionId: this.collectionId,
      producerId: PRODUCER_ID,
      queryId: parsedQueryId,
      fetchPage,
    });
    this.receipts.push(result.receipt);
    if (result.status === 'incomplete') this.fail(result.reason);
    return result.status === 'complete' ? result.data : result.partialData ?? [];
  }

  finish<T>(schema: z.ZodType<T>, data: T, includePartialData = true): ReadResult<T> {
    let parsed: T | undefined;
    try {
      parsed = schema.parse(data);
    } catch {
      this.fail('malformed_response');
    }
    const firstReceipt = this.receipts[0];
    const lastReceipt = this.receipts.at(-1);
    if (!firstReceipt || !lastReceipt) throw malformedResponse();
    const receipt = CollectionReceiptSchema.parse({
      schemaVersion: 2,
      collectionId: this.collectionId,
      app: this.operation.context.app,
      accountRef: this.operation.context.accountRef,
      producerId: PRODUCER_ID,
      startedAt: firstReceipt.startedAt,
      finishedAt: lastReceipt.finishedAt,
      status: this.failureReason === null ? 'complete' : 'incomplete',
      reason: this.failureReason,
      requiredQueryIds: this.receipts.flatMap(item => item.requiredQueryIds),
      pages: this.receipts.flatMap(item => item.pages),
    });
    const value = this.failureReason === null
      ? { status: 'complete' as const, data: parsed as T, receipt }
      : {
          status: 'incomplete' as const,
          reason: this.failureReason,
          ...(parsed !== undefined && includePartialData ? { partialData: parsed } : {}),
          receipt,
        };
    return readResultSchema(schema).parse(value) as ReadResult<T>;
  }
}

class RestHubSpotAdapter implements HubSpotAdapter {
  readonly scope;
  readonly mode = 'rest' as const;
  private readonly accessToken: string;
  private readonly mapping: HubSpotMapping;
  private readonly transport: BoundedRestTransport;

  constructor(options: HubSpotAdapterOptions) {
    this.scope = AccountScopeSchema.parse({ app: 'hubspot', accountRef: options.accountRef });
    this.accessToken = z.string().min(1).max(8192).regex(/^[^\r\n]+$/).parse(options.accessToken);
    this.mapping = HubSpotMappingSchema.parse(options.mapping);
    this.transport = options.transport;
  }

  async readCommitmentBundle(_service: string, context: BundleContext): Promise<ReadResult<CommitmentBundle>> {
    IdSchema.parse(_service);
    const operation = this.begin(context, 'hubspot.readCommitmentBundle');
    const collection = new ReadCollection(operation, context.logicalCallId);
    const ticketPropertyNames = Object.values(this.mapping.ticketProperties);
    const tickets = await collection.query('tickets', (cursor, _pageIndex, currentOperation) =>
      currentOperation.request({
        url: hubSpotUrl('/crm/v3/objects/tickets', {
          limit: String(OBJECT_PAGE_SIZE),
          after: cursor,
          properties: uniquePropertyList(ticketPropertyNames),
          associations: 'companies,contacts',
          archived: 'false',
        }),
        method: 'GET',
        headers: this.headers(),
        decode: objectPage,
      }));

    const commitments: CommitmentBundle['commitments'] = [];
    const companyIds = new Set<string>();
    const contactIds = new Set<string>();
    for (const [index, ticket] of tickets.entries()) {
      const ticketCompanyIds = await this.readAssociations(collection, `ticket-companies-${index}`, 'tickets', ticket.id, 'companies');
      const ticketContactIds = await this.readAssociations(collection, `ticket-contacts-${index}`, 'tickets', ticket.id, 'contacts');
      try {
        const commitment = HubSpotCommitmentBundleSchema.shape.commitments.element.parse({
          id: ticket.id,
          companyIds: ticketCompanyIds,
          contactIds: ticketContactIds,
          ownerId: nullableIdProperty(ticket, this.mapping.ticketProperties.ownerId),
          service: nullableProperty(ticket, this.mapping.ticketProperties.service),
          status: nullableProperty(ticket, this.mapping.ticketProperties.status),
          dueAt: nullableProperty(ticket, this.mapping.ticketProperties.dueAt),
          promise: nullableProperty(ticket, this.mapping.ticketProperties.promise),
          version: objectVersion(ticket),
        });
        commitments.push(commitment);
        ticketCompanyIds.forEach(id => companyIds.add(id));
        ticketContactIds.forEach(id => contactIds.add(id));
      } catch {
        collection.fail('malformed_response');
      }
    }

    const companies: CommitmentBundle['companies'] = [];
    for (const [index, companyId] of [...companyIds].entries()) {
      const records = await this.readObject(collection, `company-${index}`, 'companies', companyId, [this.mapping.companyProperties.name]);
      if (!records[0]) {
        if (collection.isComplete) collection.fail('missing_identity');
        continue;
      }
      const companyContactIds = await this.readAssociations(collection, `company-contacts-${index}`, 'companies', companyId, 'contacts');
      try {
        companies.push(HubSpotCommitmentBundleSchema.shape.companies.element.parse({
          id: records[0].id,
          name: requiredProperty(records[0], this.mapping.companyProperties.name),
          contactIds: companyContactIds,
        }));
        companyContactIds.forEach(id => contactIds.add(id));
      } catch {
        collection.fail('malformed_response');
      }
    }

    const contacts: CommitmentBundle['contacts'] = [];
    for (const [index, contactId] of [...contactIds].entries()) {
      const records = await this.readObject(collection, `contact-${index}`, 'contacts', contactId, [
        this.mapping.contactProperties.email,
        this.mapping.contactProperties.designated,
      ]);
      if (records.length === 0 && collection.isComplete) collection.fail('missing_identity');
      if (records[0]) {
        try {
          const observed = records[0].properties[this.mapping.contactProperties.designated];
          let designated: boolean;
          if (observed === this.mapping.contactProperties.designatedTrueValue) designated = true;
          else if (observed === this.mapping.contactProperties.designatedFalseValue) designated = false;
          else throw malformedResponse();
          contacts.push(HubSpotCommitmentBundleSchema.shape.contacts.element.parse({
            id: records[0].id,
            email: nullableProperty(records[0], this.mapping.contactProperties.email),
            designated,
          }));
        } catch {
          collection.fail('malformed_response');
        }
      }
    }

    const owners: CommitmentBundle['owners'] = [];
    for (const [queryId, archived] of [['owners-active', false], ['owners-archived', true]] as const) {
      const records = await collection.query(queryId, (cursor, _pageIndex, currentOperation) =>
        currentOperation.request({
          url: hubSpotUrl('/crm/v3/owners', {
            limit: String(OBJECT_PAGE_SIZE),
            after: cursor,
            archived: String(archived),
          }),
          method: 'GET',
          headers: this.headers(),
          decode: ownerPage,
        }));
      for (const owner of records) owners.push({ id: owner.id, active: !owner.archived });
    }

    return collection.finish(HubSpotCommitmentBundleSchema, { commitments, companies, contacts, owners });
  }

  async findTasks(marker: string, context: FindTaskContext): Promise<ReadResult<HubSpotTask[]>> {
    const parsedMarker = IdSchema.parse(marker);
    const operation = this.begin(context, 'hubspot.findTasks');
    const collection = new ReadCollection(operation, context.logicalCallId);
    const records = await this.listObjects(collection, 'tasks', 'tasks', [
      'hubspot_owner_id', 'hs_timestamp', 'hs_task_status', 'hs_task_subject', 'hs_task_body', 'hs_lastmodifieddate',
    ]);
    const tasks: HubSpotTask[] = [];
    for (const [index, record] of records.entries()) {
      const subject = nullableProperty(record, 'hs_task_subject');
      const body = nullableProperty(record, 'hs_task_body');
      if (!hasMarker(subject ?? '', parsedMarker) && !hasMarker(body ?? '', parsedMarker)) continue;
      const companyIds = await this.readAssociations(collection, `task-companies-${index}`, 'tasks', record.id, 'companies');
      const commitmentIds = await this.readAssociations(collection, `task-tickets-${index}`, 'tasks', record.id, 'tickets');
      try {
        tasks.push(this.normalizeTask(record, companyIds, commitmentIds));
      } catch {
        collection.fail('malformed_response');
      }
    }
    return collection.finish(z.array(HubSpotTaskSchema), tasks);
  }

  async getTask(id: string, context: GetTaskContext): Promise<ReadResult<HubSpotTask | null>> {
    const taskId = IdSchema.parse(id);
    const operation = this.begin(context, 'hubspot.getTask');
    const collection = new ReadCollection(operation, context.logicalCallId);
    const records = await this.readObject(collection, 'task', 'tasks', taskId, [
      'hubspot_owner_id', 'hs_timestamp', 'hs_task_status', 'hs_task_subject', 'hs_task_body', 'hs_lastmodifieddate',
    ]);
    if (!records[0]) return collection.finish(HubSpotTaskSchema.nullable(), null, false);
    const companyIds = await this.readAssociations(collection, 'task-companies', 'tasks', taskId, 'companies');
    const commitmentIds = await this.readAssociations(collection, 'task-tickets', 'tasks', taskId, 'tickets');
    let task: HubSpotTask | null = null;
    try {
      task = this.normalizeTask(records[0], companyIds, commitmentIds);
    } catch {
      collection.fail('malformed_response');
    }
    return collection.finish(HubSpotTaskSchema.nullable(), task);
  }

  async findNotes(marker: string, context: FindNoteContext): Promise<ReadResult<HubSpotNote[]>> {
    const parsedMarker = IdSchema.parse(marker);
    const operation = this.begin(context, 'hubspot.findNotes');
    const collection = new ReadCollection(operation, context.logicalCallId);
    const records = await this.listObjects(collection, 'notes', 'notes', ['hs_note_body', 'hs_lastmodifieddate']);
    const notes: HubSpotNote[] = [];
    for (const [index, record] of records.entries()) {
      if (!hasMarker(nullableProperty(record, 'hs_note_body') ?? '', parsedMarker)) continue;
      const companyIds = await this.readAssociations(collection, `note-companies-${index}`, 'notes', record.id, 'companies');
      const commitmentIds = await this.readAssociations(collection, `note-tickets-${index}`, 'notes', record.id, 'tickets');
      const taskIds = await this.readAssociations(collection, `note-tasks-${index}`, 'notes', record.id, 'tasks');
      try {
        notes.push(this.normalizeNote(record, companyIds, commitmentIds, taskIds));
      } catch {
        collection.fail('malformed_response');
      }
    }
    return collection.finish(z.array(HubSpotNoteSchema), notes);
  }

  async getNote(id: string, context: GetNoteContext): Promise<ReadResult<HubSpotNote | null>> {
    const noteId = IdSchema.parse(id);
    const operation = this.begin(context, 'hubspot.getNote');
    const collection = new ReadCollection(operation, context.logicalCallId);
    const records = await this.readObject(collection, 'note', 'notes', noteId, ['hs_note_body', 'hs_lastmodifieddate']);
    if (!records[0]) return collection.finish(HubSpotNoteSchema.nullable(), null, false);
    const companyIds = await this.readAssociations(collection, 'note-companies', 'notes', noteId, 'companies');
    const commitmentIds = await this.readAssociations(collection, 'note-tickets', 'notes', noteId, 'tickets');
    const taskIds = await this.readAssociations(collection, 'note-tasks', 'notes', noteId, 'tasks');
    let note: HubSpotNote | null = null;
    try {
      note = this.normalizeNote(records[0], companyIds, commitmentIds, taskIds);
    } catch {
      collection.fail('malformed_response');
    }
    return collection.finish(HubSpotNoteSchema.nullable(), note);
  }

  async createTask(input: CreateTaskInput, context: CreateTaskContext): Promise<MutationOutcome> {
    const task = TaskWriteSchema.parse(input);
    const operation = this.begin(context, 'hubspot.createTask');
    const result = await operation.request({
      url: hubSpotUrl('/crm/v3/objects/tasks'),
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        properties: {
          hs_timestamp: task.dueAt,
          hubspot_owner_id: task.ownerId,
          hs_task_subject: task.subject,
          hs_task_body: task.body,
          hs_task_status: task.status,
          hs_task_type: this.mapping.taskType,
        },
        associations: [
          this.createAssociation(task.companyId, this.mapping.associationTypes.taskToCompany),
          this.createAssociation(task.commitmentId, this.mapping.associationTypes.taskToCommitment),
        ],
      }),
      decode: body => HubSpotCreateResponseSchema.parse(body),
    });
    if (result.status === 'failure') return mutationFailure(result);
    return MutationOutcomeSchema.parse({ status: 'applied', providerId: result.data.id, receipt: result.receiptRef });
  }

  async createNote(input: CreateNoteInput, context: CreateNoteContext): Promise<MutationOutcome> {
    const note = NoteWriteSchema.parse(input);
    const operation = this.begin(context, 'hubspot.createNote');
    const result = await operation.request({
      url: hubSpotUrl('/crm/v3/objects/notes'),
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        properties: {
          hs_timestamp: operation.currentAt(),
          hs_note_body: note.body,
        },
        associations: [
          this.createAssociation(note.companyId, this.mapping.associationTypes.noteToCompany),
          this.createAssociation(note.commitmentId, this.mapping.associationTypes.noteToCommitment),
          this.createAssociation(note.taskId, this.mapping.associationTypes.noteToTask),
        ],
      }),
      decode: body => HubSpotCreateResponseSchema.parse(body),
    });
    if (result.status === 'failure') return mutationFailure(result);
    return MutationOutcomeSchema.parse({ status: 'applied', providerId: result.data.id, receipt: result.receiptRef });
  }

  private begin(context: unknown, operation: AdapterCallContext['operation']): BoundedRestOperation {
    const parsed = parseAdapterContext(context, this.scope, operation);
    if (parsed.mode !== this.mode) throw new Error('adapter_mode_mismatch');
    return this.transport.begin(parsed);
  }

  private headers(hasBody = false): Record<string, string> {
    return {
      authorization: `Bearer ${this.accessToken}`,
      accept: 'application/json',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    };
  }

  private async listObjects(
    collection: ReadCollection,
    queryId: string,
    objectType: 'tasks' | 'notes',
    properties: string[],
  ): Promise<HubSpotObject[]> {
    return collection.query(queryId, (cursor, _pageIndex, operation) => operation.request({
      url: hubSpotUrl(`/crm/v3/objects/${objectType}`, {
        limit: String(OBJECT_PAGE_SIZE),
        after: cursor,
        properties: uniquePropertyList(properties),
        associations: objectType === 'tasks' ? 'companies,tickets' : 'companies,tickets,tasks',
        archived: 'false',
      }),
      method: 'GET',
      headers: this.headers(),
      decode: objectPage,
    }));
  }

  private async readObject(
    collection: ReadCollection,
    queryId: string,
    objectType: 'companies' | 'contacts' | 'tasks' | 'notes',
    objectId: string,
    properties: string[],
  ): Promise<HubSpotObject[]> {
    return collection.query(queryId, (_cursor, _pageIndex, operation) => operation.request({
      url: hubSpotUrl(`/crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}`, {
        properties: uniquePropertyList(properties),
        archived: 'false',
      }),
      method: 'GET',
      headers: this.headers(),
      acceptsStatus: status => status === 404 || (status >= 200 && status <= 299),
      decode: (body, response) => ({
        records: response.status === 404 ? [] : [HubSpotObjectSchema.parse(body)],
        nextCursor: null,
      }),
    }));
  }

  private async readAssociations(
    collection: ReadCollection,
    queryId: string,
    fromObjectType: 'tickets' | 'companies' | 'tasks' | 'notes',
    fromObjectId: string,
    toObjectType: 'companies' | 'contacts' | 'tickets' | 'tasks',
  ): Promise<string[]> {
    return collection.query(queryId, (cursor, _pageIndex, operation) => operation.request({
      url: hubSpotUrl(`/crm/v4/objects/${fromObjectType}/${encodeURIComponent(fromObjectId)}/associations/${toObjectType}`, {
        limit: String(ASSOCIATION_PAGE_SIZE),
        after: cursor,
      }),
      method: 'GET',
      headers: this.headers(),
      decode: associationPage,
    }));
  }

  private normalizeTask(record: HubSpotObject, companyIds: string[], commitmentIds: string[]): HubSpotTask {
    return HubSpotTaskSchema.parse({
      id: record.id,
      companyIds,
      commitmentIds,
      ownerId: nullableIdProperty(record, 'hubspot_owner_id'),
      dueAt: nullableProperty(record, 'hs_timestamp'),
      status: requiredProperty(record, 'hs_task_status'),
      subject: requiredProperty(record, 'hs_task_subject'),
      body: requiredProperty(record, 'hs_task_body'),
      version: objectVersion(record),
    });
  }

  private normalizeNote(record: HubSpotObject, companyIds: string[], commitmentIds: string[], taskIds: string[]): HubSpotNote {
    return HubSpotNoteSchema.parse({
      id: record.id,
      companyIds,
      commitmentIds,
      taskIds,
      body: requiredProperty(record, 'hs_note_body'),
      version: objectVersion(record),
    });
  }

  private createAssociation(toId: string, type: z.infer<typeof AssociationTypeSchema>) {
    return {
      to: { id: toId },
      types: [type],
    };
  }
}

export function createHubSpotAdapter(options: HubSpotAdapterOptions): HubSpotAdapter {
  return new RestHubSpotAdapter(options);
}