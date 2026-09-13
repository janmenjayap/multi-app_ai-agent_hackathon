import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import {
  HubSpotMappingSchema,
  createHubSpotAdapter,
} from '../../dist/server/adapters/hubspot.js';
import { createBoundedRestTransport } from '../../dist/server/adapters/common/transport.js';
import { TaskWriteSchema } from '../../dist/shared/adapters.js';
import { IdSchema } from '../../dist/shared/domain.js';

const HUBSPOT_API_URL = 'https://api.hubapi.com';
const MAX_MANIFEST_BYTES = 64 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');

const SmokeTaskSchema = TaskWriteSchema.extend({ marker: IdSchema }).superRefine((value, context) => {
  if (!value.subject.includes(value.marker) && !value.body.includes(value.marker)) {
    context.addIssue({ code: 'custom', message: 'task_marker_missing' });
  }
});
const SmokeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  accountRef: IdSchema,
  service: IdSchema,
  mapping: HubSpotMappingSchema,
  expected: z.object({
    commitmentId: IdSchema,
    protectedCommitmentId: IdSchema,
    companyId: IdSchema,
    contactId: IdSchema,
    ownerId: IdSchema,
  }).strict(),
  task: SmokeTaskSchema,
  note: z.object({
    marker: IdSchema,
    body: z.string().max(50000),
  }).strict().superRefine((value, context) => {
    if (!value.body.includes(value.marker)) context.addIssue({ code: 'custom', message: 'note_marker_missing' });
  }),
}).strict().superRefine((value, context) => {
  if (value.task.companyId !== value.expected.companyId ||
      value.task.commitmentId !== value.expected.commitmentId ||
      value.task.ownerId !== value.expected.ownerId) {
    context.addIssue({ code: 'custom', message: 'task_expectation_mismatch' });
  }
});

function usage() {
  return 'usage: hubspot.ts --manifest <private-json-path> --confirm-writes';
}

function parseArguments(argv) {
  if (argv.includes('--help')) return { help: true };
  const manifestIndex = argv.indexOf('--manifest');
  const manifestPath = manifestIndex >= 0 ? argv[manifestIndex + 1] : undefined;
  if (!manifestPath || !argv.includes('--confirm-writes')) throw new Error(usage());
  return { help: false, manifestPath };
}

function artifact(sequence, kind, bytes) {
  return {
    artifactId: `hubspot-smoke-${kind}-${sequence}`,
    sha256: digest(bytes),
    byteLength: bytes.byteLength,
    mediaType: 'application/json',
  };
}

function createTransport() {
  let responseSequence = 1;
  let receiptSequence = 1;
  return createBoundedRestTransport({
    fetch: globalThis.fetch,
    createProviderAttemptId: () => `smoke-provider-${randomUUID()}`,
    createSpanId: () => `smoke-span-${randomUUID()}`,
    storeResponse: input => artifact(responseSequence++, 'response', input.bytes),
    storeReceipt: receipt => {
      const bytes = Buffer.from(JSON.stringify(receipt));
      return artifact(receiptSequence++, 'receipt', bytes);
    },
    observer: { onDispatch: () => {}, onResult: () => {}, onRetry: () => {} },
  });
}

function contextFactory(accountRef) {
  let sequence = 1;
  const common = operation => {
    const current = sequence++;
    return {
      schemaVersion: 2,
      runId: 'hubspot-smoke-run',
      evaluationAttemptId: 'hubspot-smoke-evaluation',
      runtimeAttemptId: 'hubspot-smoke-runtime',
      spanId: `hubspot-smoke-span-${current}`,
      app: 'hubspot',
      accountRef,
      mode: 'rest',
      operation,
      logicalCallId: `hubspot-smoke-call-${current}`,
      providerAttemptId: `hubspot-smoke-provider-${current}`,
      deadlineAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      budgets: {
        timeoutMs: 15000,
        totalMs: 5 * 60 * 1000,
        maxAttempts: operation.startsWith('hubspot.create') ? 1 : 3,
        maxPages: 100,
        maxRecords: 10000,
        maxResponseBytes: 10 * 1024 * 1024,
      },
    };
  };
  return {
    read: operation => common(operation),
    write: (operation, effectKey, input) => ({
      ...common(operation),
      effectKey,
      requestDigest: digest(Buffer.from(JSON.stringify(input))),
      planHash: digest(Buffer.from('hubspot-smoke-plan')),
      approvalRef: 'hubspot-smoke-approval',
    }),
  };
}

async function requestJson(operation, token, path) {
  const result = await operation.request({
    url: new URL(path, HUBSPOT_API_URL),
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    decode: body => body,
  });
  if (result.status === 'failure') throw new Error(`preflight_${result.error.code}`);
  return result.data;
}

async function verifyProperties(operation, token, objectType, requiredNames) {
  const response = z.object({
    results: z.array(z.object({ name: z.string() }).passthrough()),
  }).passthrough().parse(await requestJson(operation, token, `/crm/v3/properties/${objectType}`));
  const available = new Set(response.results.map(property => property.name));
  if (requiredNames.some(name => !available.has(name))) throw new Error(`missing_${objectType}_property`);
}

async function verifyAssociationType(operation, token, fromType, toType, expected) {
  const response = z.object({
    results: z.array(z.object({
      category: z.string(),
      typeId: z.number().int().positive(),
    }).passthrough()),
  }).passthrough().parse(await requestJson(operation, token, `/crm/v4/associations/${fromType}/${toType}/labels`));
  if (!response.results.some(type =>
    type.category === expected.associationCategory && type.typeId === expected.associationTypeId)) {
    throw new Error(`missing_${fromType}_${toType}_association`);
  }
}

async function preflight(transport, contexts, token, mapping) {
  const operation = transport.begin(contexts.read('hubspot.readCommitmentBundle'));
  await verifyProperties(operation, token, 'tickets', Object.values(mapping.ticketProperties));
  await verifyProperties(operation, token, 'companies', Object.values(mapping.companyProperties));
  await verifyProperties(operation, token, 'contacts', [
    mapping.contactProperties.email,
    mapping.contactProperties.designated,
  ]);
  await verifyAssociationType(operation, token, 'tasks', 'companies', mapping.associationTypes.taskToCompany);
  await verifyAssociationType(operation, token, 'tasks', 'tickets', mapping.associationTypes.taskToCommitment);
  await verifyAssociationType(operation, token, 'notes', 'companies', mapping.associationTypes.noteToCompany);
  await verifyAssociationType(operation, token, 'notes', 'tickets', mapping.associationTypes.noteToCommitment);
  await verifyAssociationType(operation, token, 'notes', 'tasks', mapping.associationTypes.noteToTask);
}

function requireComplete(result, label) {
  if (result.status !== 'complete') throw new Error(`${label}_${result.reason}`);
  return result.data;
}

function exactIds(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}_association_mismatch`);
  }
}

async function runSmoke(manifest, token) {
  const transport = createTransport();
  const contexts = contextFactory(manifest.accountRef);
  const adapter = createHubSpotAdapter({
    accountRef: manifest.accountRef,
    accessToken: token,
    mapping: manifest.mapping,
    transport,
  });

  await preflight(transport, contexts, token, manifest.mapping);
  const bundle = requireComplete(
    await adapter.readCommitmentBundle(manifest.service, contexts.read('hubspot.readCommitmentBundle')),
    'source_read',
  );
  const commitment = bundle.commitments.find(item => item.id === manifest.expected.commitmentId);
  const protectedCommitment = bundle.commitments.find(item => item.id === manifest.expected.protectedCommitmentId);
  const company = bundle.companies.find(item => item.id === manifest.expected.companyId);
  const contact = bundle.contacts.find(item => item.id === manifest.expected.contactId);
  const owner = bundle.owners.find(item => item.id === manifest.expected.ownerId);
  if (!commitment || !protectedCommitment || !company || !contact?.designated || !owner?.active ||
      !commitment.companyIds.includes(company.id) || !commitment.contactIds.includes(contact.id) ||
      commitment.ownerId !== owner.id) {
    throw new Error('source_mapping_mismatch');
  }

  const taskInput = {
    companyId: manifest.task.companyId,
    commitmentId: manifest.task.commitmentId,
    ownerId: manifest.task.ownerId,
    dueAt: manifest.task.dueAt,
    status: manifest.task.status,
    subject: manifest.task.subject,
    body: manifest.task.body,
  };
  const taskOutcome = await adapter.createTask(
    taskInput,
    contexts.write('hubspot.createTask', manifest.task.marker, taskInput),
  );
  if (taskOutcome.status !== 'applied') throw new Error(`task_create_${taskOutcome.status}`);
  const task = requireComplete(
    await adapter.getTask(taskOutcome.providerId, contexts.read('hubspot.getTask')),
    'task_read',
  );
  if (!task || task.ownerId !== taskInput.ownerId || task.dueAt !== taskInput.dueAt ||
      task.status !== taskInput.status || task.subject !== taskInput.subject || task.body !== taskInput.body) {
    throw new Error('task_field_mismatch');
  }
  exactIds(task.companyIds, [taskInput.companyId], 'task_company');
  exactIds(task.commitmentIds, [taskInput.commitmentId], 'task_commitment');
  const taskMatches = requireComplete(
    await adapter.findTasks(manifest.task.marker, contexts.read('hubspot.findTasks')),
    'task_find',
  );
  if (taskMatches.length !== 1 || taskMatches[0].id !== task.id) throw new Error('task_marker_ambiguous');

  const noteInput = {
    companyId: manifest.expected.companyId,
    commitmentId: manifest.expected.commitmentId,
    taskId: task.id,
    body: manifest.note.body,
  };
  const noteOutcome = await adapter.createNote(
    noteInput,
    contexts.write('hubspot.createNote', manifest.note.marker, noteInput),
  );
  if (noteOutcome.status !== 'applied') throw new Error(`note_create_${noteOutcome.status}`);
  const note = requireComplete(
    await adapter.getNote(noteOutcome.providerId, contexts.read('hubspot.getNote')),
    'note_read',
  );
  if (!note || note.body !== noteInput.body) throw new Error('note_field_mismatch');
  exactIds(note.companyIds, [noteInput.companyId], 'note_company');
  exactIds(note.commitmentIds, [noteInput.commitmentId], 'note_commitment');
  exactIds(note.taskIds, [noteInput.taskId], 'note_task');
  const noteMatches = requireComplete(
    await adapter.findNotes(manifest.note.marker, contexts.read('hubspot.findNotes')),
    'note_find',
  );
  if (noteMatches.length !== 1 || noteMatches[0].id !== note.id) throw new Error('note_marker_ambiguous');

  return {
    schemaVersion: 1,
    provider: 'hubspot',
    status: 'passed',
    apiFamily: manifest.mapping.apiFamily,
    checks: [
      'property_mapping',
      'association_mapping',
      'source_and_protected_commitments',
      'task_create_get_find',
      'note_create_get_find',
    ],
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const token = process.env.PG_HUBSPOT_ACCESS_TOKEN;
  const accountRef = process.env.PG_HUBSPOT_PORTAL_ID;
  if (!token || !accountRef) throw new Error('missing_credentials');
  const bytes = await readFile(args.manifestPath);
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('hubspot_smoke_manifest_too_large');
  const manifest = SmokeManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (manifest.accountRef !== accountRef) throw new Error('hubspot_account_scope_mismatch');
  const report = await runSmoke(manifest, token);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const message = error instanceof Error && /^[a-zA-Z0-9_.:-]{1,160}$/.test(error.message)
      ? error.message
      : 'hubspot_smoke_failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}