import assert from 'node:assert/strict';
import test from 'node:test';

import { createHubSpotAdapter } from '../../dist/server/adapters/hubspot.js';
import { createBoundedRestTransport } from '../../dist/server/adapters/common/transport.js';

const digest = 'a'.repeat(64);
const marker = 'effect-1';
const mapping = {
  schemaVersion: 1,
  apiFamily: 'v3_objects_v4_associations',
  ticketProperties: {
    service: 'pg_service',
    status: 'pg_status',
    dueAt: 'pg_due_at',
    promise: 'pg_promise',
    ownerId: 'hubspot_owner_id',
  },
  companyProperties: { name: 'name' },
  contactProperties: {
    email: 'email',
    designated: 'pg_designated',
    designatedTrueValue: 'true',
    designatedFalseValue: 'false',
  },
  taskType: 'TODO',
  associationTypes: {
    taskToCompany: { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 },
    taskToCommitment: { associationCategory: 'USER_DEFINED', associationTypeId: 501 },
    noteToCompany: { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 190 },
    noteToCommitment: { associationCategory: 'USER_DEFINED', associationTypeId: 502 },
    noteToTask: { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 },
  },
} as const;

function artifact(suffix) {
  return {
    artifactId: `artifact-${suffix}`,
    sha256: digest,
    byteLength: 2,
    mediaType: 'application/json',
  };
}

function readContext(operation, overrides = {}) {
  return {
    schemaVersion: 2,
    runId: 'run-1',
    evaluationAttemptId: 'evaluation-1',
    runtimeAttemptId: 'runtime-1',
    spanId: 'span-1',
    app: 'hubspot',
    accountRef: 'portal-1',
    mode: 'rest',
    operation,
    logicalCallId: `call-${operation.replaceAll('.', '-')}`,
    providerAttemptId: 'provider-1',
    deadlineAt: '2026-09-14T10:01:00.000Z',
    budgets: {
      timeoutMs: 1000,
      totalMs: 60000,
      maxAttempts: 1,
      maxPages: 50,
      maxRecords: 1000,
      maxResponseBytes: 100000,
    },
    ...overrides,
  };
}

function mutationContext(operation, overrides = {}) {
  return readContext(operation, {
    effectKey: marker,
    requestDigest: digest,
    planHash: digest,
    approvalRef: 'approval-1',
    ...overrides,
  });
}

function harness(fetch) {
  let providerSequence = 2;
  let spanSequence = 2;
  let responseSequence = 1;
  let receiptSequence = 1;
  const calls = [];
  const transport = createBoundedRestTransport({
    fetch: async (input, init) => {
      calls.push({ input, init });
      return fetch(input, init);
    },
    clock: {
      wallNowMs: () => Date.parse('2026-09-14T10:00:00.000Z'),
      monotonicNowMs: () => 100,
      sleep: async () => {},
    },
    createProviderAttemptId: () => `provider-${providerSequence++}`,
    createSpanId: () => `span-${spanSequence++}`,
    storeResponse: input => ({ ...artifact(`response-${responseSequence++}`), byteLength: input.bytes.byteLength }),
    storeReceipt: () => artifact(`receipt-${receiptSequence++}`),
    observer: { onDispatch: () => {}, onResult: () => {}, onRetry: () => {} },
  });
  return {
    calls,
    adapter: createHubSpotAdapter({
      accountRef: 'portal-1',
      accessToken: 'test-token',
      mapping,
      transport,
    }),
  };
}

function object(id, properties) {
  return {
    id,
    properties,
    createdAt: '2026-09-14T09:00:00.000Z',
    updatedAt: '2026-09-14T09:30:00.000Z',
  };
}

function page(results, after = null) {
  return after === null ? { results } : { results, paging: { next: { after } } };
}

test('reads complete commitments and preserves exact identities and paginated associations', async () => {
  const { adapter } = harness(async input => {
    const url = new URL(input);
    if (url.pathname === '/crm/v3/objects/tickets') {
      return Response.json(page([object('ticket-1', {
        pg_service: 'billing-api',
        pg_status: 'active',
        pg_due_at: '2026-09-17T10:00:00.000Z',
        pg_promise: 'Send an update',
        hubspot_owner_id: 'owner-missing',
      })]));
    }
    if (url.pathname.endsWith('/tickets/ticket-1/associations/companies')) {
      return url.searchParams.get('after') === null
        ? Response.json(page([{ toObjectId: 'company-1' }], 'company-page-2'))
        : Response.json(page([{ toObjectId: 'company-2' }]));
    }
    if (url.pathname.endsWith('/tickets/ticket-1/associations/contacts')) {
      return Response.json(page([{ toObjectId: 'contact-1' }]));
    }
    if (url.pathname === '/crm/v3/objects/companies/company-1') {
      return Response.json(object('company-1', { name: 'Acme Corp' }));
    }
    if (url.pathname === '/crm/v3/objects/companies/company-2') {
      return Response.json(object('company-2', { name: 'Beta Corp' }));
    }
    if (url.pathname.endsWith('/companies/company-1/associations/contacts')) {
      return Response.json(page([{ toObjectId: 'contact-1' }]));
    }
    if (url.pathname.endsWith('/companies/company-2/associations/contacts')) {
      return Response.json(page([{ toObjectId: 'contact-2' }]));
    }
    if (url.pathname === '/crm/v3/objects/contacts/contact-1') {
      return Response.json(object('contact-1', { email: 'incident@example.test', pg_designated: 'true' }));
    }
    if (url.pathname === '/crm/v3/objects/contacts/contact-2') {
      return Response.json(object('contact-2', { email: 'other@example.test', pg_designated: 'false' }));
    }
    if (url.pathname === '/crm/v3/owners') {
      return url.searchParams.get('archived') === 'true'
        ? Response.json(page([{ id: 'owner-old', archived: true }]))
        : Response.json(page([{ id: 'owner-1', archived: false }]));
    }
    throw new Error(`unexpected_request:${url.pathname}`);
  });

  const result = await adapter.readCommitmentBundle('billing-api', readContext('hubspot.readCommitmentBundle'));

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.data.commitments[0].companyIds, ['company-1', 'company-2']);
  assert.deepEqual(result.data.commitments[0].contactIds, ['contact-1']);
  assert.equal(result.data.commitments[0].ownerId, 'owner-missing');
  assert.deepEqual(result.data.companies.map(company => company.contactIds), [['contact-1'], ['contact-2']]);
  assert.deepEqual(result.data.contacts.map(contact => contact.designated), [true, false]);
  assert.deepEqual(result.data.owners, [
    { id: 'owner-1', active: true },
    { id: 'owner-old', active: false },
  ]);
  assert.equal(result.receipt.pages.filter(item => item.queryId === 'ticket-companies-0').length, 2);
});

test('keeps source page-one data and reports a page-two failure as incomplete', async () => {
  let ticketCalls = 0;
  const { adapter } = harness(async input => {
    const url = new URL(input);
    if (url.pathname !== '/crm/v3/objects/tickets') throw new Error(`unexpected_request:${url.pathname}`);
    ticketCalls += 1;
    return ticketCalls === 1
      ? Response.json(page([object('ticket-1', {
          pg_service: 'billing-api',
          pg_status: 'active',
          pg_due_at: null,
          pg_promise: null,
          hubspot_owner_id: null,
        })], 'ticket-page-2'))
      : Response.json({ status: 'error' }, { status: 503 });
  });

  const result = await adapter.readCommitmentBundle('billing-api', readContext('hubspot.readCommitmentBundle'));

  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'page_failed');
  assert.equal(result.partialData.commitments[0].id, 'ticket-1');
  assert.equal(result.receipt.pages.length, 1);
  assert.equal(ticketCalls, 2);
});

test('returns every later-page task marker match with observed owners and associations', async () => {
  const { adapter } = harness(async input => {
    const url = new URL(input);
    if (url.pathname === '/crm/v3/objects/tasks') {
      return url.searchParams.get('after') === null
        ? Response.json(page([object('task-1', {
            hubspot_owner_id: 'owner-wrong',
            hs_timestamp: '2026-09-17T10:00:00.000Z',
            hs_task_status: 'NOT_STARTED',
            hs_task_subject: `Follow up ${marker}`,
            hs_task_body: 'First candidate',
            hs_lastmodifieddate: '2026-09-14T09:30:00.000Z',
          })], 'task-page-2'))
        : Response.json(page([object('task-2', {
            hubspot_owner_id: 'owner-2',
            hs_timestamp: '2026-09-18T10:00:00.000Z',
            hs_task_status: 'NOT_STARTED',
            hs_task_subject: 'Second candidate',
            hs_task_body: `duplicate ${marker}`,
            hs_lastmodifieddate: '2026-09-14T09:31:00.000Z',
          }), object('task-prefix-only', {
            hubspot_owner_id: 'owner-3',
            hs_timestamp: '2026-09-19T10:00:00.000Z',
            hs_task_status: 'NOT_STARTED',
            hs_task_subject: 'Different marker effect-10',
            hs_task_body: 'Must not match a marker prefix',
            hs_lastmodifieddate: '2026-09-14T09:32:00.000Z',
          })]));
    }
    const taskId = url.pathname.includes('/task-1/') ? 'task-1' : 'task-2';
    if (url.pathname.endsWith('/associations/companies')) {
      return Response.json(page([{ toObjectId: taskId === 'task-1' ? 'company-1' : 'company-2' }]));
    }
    if (url.pathname.endsWith('/associations/tickets')) {
      return Response.json(page([{ toObjectId: taskId === 'task-1' ? 'ticket-1' : 'ticket-2' }]));
    }
    throw new Error(`unexpected_request:${url.pathname}`);
  });

  const result = await adapter.findTasks(marker, readContext('hubspot.findTasks'));

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.data.map(task => task.id), ['task-1', 'task-2']);
  assert.equal(result.data[0].ownerId, 'owner-wrong');
  assert.deepEqual(result.data[1].companyIds, ['company-2']);
  assert.deepEqual(result.data[1].commitmentIds, ['ticket-2']);
});

test('gets a note with all observed company, commitment, and task associations', async () => {
  const { adapter } = harness(async input => {
    const url = new URL(input);
    if (url.pathname === '/crm/v3/objects/notes/note-1') {
      return Response.json(object('note-1', {
        hs_note_body: `Internal note ${marker}`,
        hs_lastmodifieddate: '2026-09-14T09:30:00.000Z',
      }));
    }
    if (url.pathname.endsWith('/associations/companies')) return Response.json(page([{ toObjectId: 'company-1' }]));
    if (url.pathname.endsWith('/associations/tickets')) return Response.json(page([{ toObjectId: 'ticket-1' }, { toObjectId: 'ticket-2' }]));
    if (url.pathname.endsWith('/associations/tasks')) return Response.json(page([{ toObjectId: 'task-1' }]));
    throw new Error(`unexpected_request:${url.pathname}`);
  });

  const result = await adapter.getNote('note-1', readContext('hubspot.getNote'));

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.data, {
    id: 'note-1',
    companyIds: ['company-1'],
    commitmentIds: ['ticket-1', 'ticket-2'],
    taskIds: ['task-1'],
    body: `Internal note ${marker}`,
    version: '2026-09-14T09:30:00.000Z',
  });
});

test('creates task and note with exact approved fields and configured associations', async () => {
  const bodies = [];
  const { adapter } = harness(async (input, init) => {
    const url = new URL(input);
    bodies.push({ path: url.pathname, body: JSON.parse(init.body) });
    return Response.json({ id: url.pathname.endsWith('/tasks') ? 'task-created' : 'note-created' }, { status: 201 });
  });

  const taskResult = await adapter.createTask({
    companyId: 'company-1',
    commitmentId: 'ticket-1',
    ownerId: 'owner-1',
    dueAt: '2026-09-17T10:00:00.000Z',
    status: 'NOT_STARTED',
    subject: `Follow up ${marker}`,
    body: 'Approved task body',
  }, mutationContext('hubspot.createTask'));
  const noteResult = await adapter.createNote({
    companyId: 'company-1',
    commitmentId: 'ticket-1',
    taskId: 'task-created',
    body: `Approved note ${marker}`,
  }, mutationContext('hubspot.createNote', { effectKey: 'effect-2', providerAttemptId: 'provider-note' }));

  assert.equal(taskResult.status, 'applied');
  assert.equal(taskResult.providerId, 'task-created');
  assert.equal(noteResult.status, 'applied');
  assert.equal(noteResult.providerId, 'note-created');
  assert.deepEqual(bodies[0], {
    path: '/crm/v3/objects/tasks',
    body: {
      properties: {
        hs_timestamp: '2026-09-17T10:00:00.000Z',
        hubspot_owner_id: 'owner-1',
        hs_task_subject: `Follow up ${marker}`,
        hs_task_body: 'Approved task body',
        hs_task_status: 'NOT_STARTED',
        hs_task_type: 'TODO',
      },
      associations: [
        { to: { id: 'company-1' }, types: [mapping.associationTypes.taskToCompany] },
        { to: { id: 'ticket-1' }, types: [mapping.associationTypes.taskToCommitment] },
      ],
    },
  });
  assert.deepEqual(bodies[1].body.associations, [
    { to: { id: 'company-1' }, types: [mapping.associationTypes.noteToCompany] },
    { to: { id: 'ticket-1' }, types: [mapping.associationTypes.noteToCommitment] },
    { to: { id: 'task-created' }, types: [mapping.associationTypes.noteToTask] },
  ]);
});

test('returns an unknown create outcome after one transport failure without retrying', async () => {
  const { adapter, calls } = harness(async () => {
    throw new TypeError('redacted network failure');
  });

  const result = await adapter.createTask({
    companyId: 'company-1',
    commitmentId: 'ticket-1',
    ownerId: 'owner-1',
    dueAt: '2026-09-17T10:00:00.000Z',
    status: 'NOT_STARTED',
    subject: `Follow up ${marker}`,
    body: 'Approved task body',
  }, mutationContext('hubspot.createTask'));

  assert.deepEqual(result.status === 'unknown' ? { status: result.status, reason: result.reason } : result, {
    status: 'unknown',
    reason: 'transport_error',
  });
  assert.equal(calls.length, 1);
});