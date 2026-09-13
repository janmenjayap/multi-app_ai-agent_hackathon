import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';

import { createEvidenceCollector } from '../../src/server/evaluations/collector.js';
import { createCheckerExport } from '../../src/server/evaluations/export-checker.js';
import { createScenarioManifest, loadFixtureSuite, scenarioWorld } from '../../src/server/evaluations/manifest.js';
import { canonical } from '../../src/shared/domain.js';
import type { RestrictedArtifactRef } from '../../src/shared/domain.js';
import { LogicalManifestSchema } from '../../src/shared/evaluation.js';
import { EventV2Schema } from '../../src/shared/events.js';
import { digest } from '../../src/shared/reliability.js';
import { createFakeProviders } from '../fakes/providers.js';
import type { DeclaredSourceEdit } from '../fakes/providers.js';

const budgets = {
  timeoutMs: 1_000,
  totalMs: 30_000,
  maxAttempts: 1,
  maxPages: 100,
  maxRecords: 10_000,
  maxResponseBytes: 1_000_000,
};

test('collects every app through independent readers and does not trust a serialized copy', async () => {
  const suite = await loadFixtureSuite();
  const frozen = createScenarioManifest(suite, 'pg-f01-baseline');
  const world = scenarioWorld(suite, 'pg-f01-baseline');
  const providers = createFakeProviders({
    namespace: 'q02-collector',
    ownerId: 'q02-owner',
    world,
    pageSize: 1,
  });
  let nextId = 0;
  const collector = createEvidenceCollector({
    readers: providers.readers,
    identity: {
      version: 'q02-v1',
      processId: 'collector-process',
      bootId: 'collector-boot',
    },
    createId: purpose => `q02-${purpose}-${++nextId}`,
    writeArtifact: (artifactId, value): RestrictedArtifactRef => {
      const bytes = canonical(value);
      return {
        artifactId,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: Buffer.byteLength(bytes),
        mediaType: 'application/json',
      };
    },
  });

  const phase = await collector.collectPhase({
    manifest: frozen.manifest,
    phase: 's0',
    runId: 'run-q02',
    evaluationAttemptId: 'evaluation-q02',
    runtimeAttemptId: 'runtime-q02-s0',
    evidenceMode: 'synthetic_fixture',
    incident: world.github.technicalEvidence.incident,
    deadlineAt: '2026-09-13T17:36:00Z',
    budgets,
  });

  assert.equal(phase.status, 'complete');
  assert.deepEqual(new Set(phase.observations.map(observation => observation.receipt.app)),
    new Set(['github', 'hubspot', 'gmail', 'slack']));
  assert.ok(phase.observations.every(observation => observation.phase === 's0' && observation.receipt.status === 'complete'));
  assert.equal(collector.isTrustedPhase(phase), true);
  assert.equal(collector.isTrustedPhase(structuredClone(phase)), false);
});

test('joins complete S0 and S1 into a bound checker-v1 export without inventing effects', async () => {
  const suite = await loadFixtureSuite();
  const frozen = createScenarioManifest(suite, 'pg-f02-baseline');
  const manifest = LogicalManifestSchema.parse({ ...frozen.manifest,
    protectedRecords: frozen.manifest.protectedRecords.filter(record =>
      record.logicalId === 'company_beta' || record.logicalId === 'promise_102') });
  const world = scenarioWorld(suite, 'pg-f02-baseline');
  const providers = createFakeProviders({ namespace: 'q02-no-affected', ownerId: 'q02-owner', world, pageSize: 1 });
  let nextId = 0;
  const collector = createEvidenceCollector({
    readers: providers.readers,
    identity: { version: 'q02-v1', processId: 'collector-process', bootId: 'collector-boot' },
    createId: purpose => `q02-${purpose}-${++nextId}`,
    writeArtifact: (artifactId, value): RestrictedArtifactRef => {
      const bytes = canonical(value);
      return { artifactId, sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: Buffer.byteLength(bytes), mediaType: 'application/json' };
    },
  });
  const common = { manifest, runId: 'run-q02-empty', evaluationAttemptId: 'evaluation-q02-empty',
    evidenceMode: 'synthetic_fixture' as const, incident: world.github.technicalEvidence.incident,
    deadlineAt: '2026-09-13T17:36:00Z', budgets };
  const s0 = await collector.collectPhase({ ...common, phase: 's0', runtimeAttemptId: 'runtime-q02-empty-s0' });
  const s1 = await collector.collectPhase({ ...common, phase: 's1', runtimeAttemptId: 'runtime-q02-empty-s1' });

  const collected = collector.finalizeEvidence({ manifest, s0, s1,
    observedTerminalStatus: 'completed_no_affected_commitments', historyComplete: true });

  assert.equal(collected.checkerResult.result, 'passed');
  assert.equal(collected.checkerExportBinding.concreteCheckerExportHash, digest(collected.outcomeEvidence.checkerInput));
  assert.equal(collector.isTrustedOutcomeEvidence(collected.outcomeEvidence), true);
  assert.equal(collector.isTrustedOutcomeEvidence(structuredClone(collected.outcomeEvidence)), false);
});

test('keeps an unavailable provider scope incomplete', async () => {
  const suite = await loadFixtureSuite();
  const frozen = createScenarioManifest(suite, 'pg-f01-baseline');
  const world = scenarioWorld(suite, 'pg-f01-baseline');
  const providers = createFakeProviders({ namespace: 'q02-missing-scope', ownerId: 'q02-owner', world,
    missingScopes: ['gmail.listDrafts'] });
  let nextId = 0;
  const collector = createEvidenceCollector({
    readers: providers.readers,
    identity: { version: 'q02-v1', processId: 'collector-process', bootId: 'collector-boot' },
    createId: purpose => `q02-${purpose}-${++nextId}`,
    writeArtifact: (artifactId, value): RestrictedArtifactRef => {
      const bytes = canonical(value);
      return { artifactId, sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: Buffer.byteLength(bytes), mediaType: 'application/json' };
    },
  });

  const phase = await collector.collectPhase({ manifest: frozen.manifest, phase: 's0', runId: 'run-q02-missing',
    evaluationAttemptId: 'evaluation-q02-missing', runtimeAttemptId: 'runtime-q02-missing',
    evidenceMode: 'synthetic_fixture', incident: world.github.technicalEvidence.incident,
    deadlineAt: '2026-09-13T17:36:00Z', budgets });

  assert.equal(phase.status, 'incomplete');
  assert.ok(phase.gaps.includes('gmail:denied'));
});

test('binds five unique provider artifacts and exports their actual fields', async () => {
  const suite = await loadFixtureSuite();
  const frozen = createScenarioManifest(suite, 'pg-f01-baseline');
  const world = scenarioWorld(suite, 'pg-f01-baseline');
  const effects = Object.fromEntries(frozen.manifest.effects.map(effect => [effect.kind, effect]));
  const providerIds = { task: 'provider_task', note: 'provider_note', draft: 'provider_draft',
    comment: 'provider_comment', thread: 'provider_thread' };
  const bodies = {
    note: 'Observed note body.',
    draft: 'Observed draft body.',
    comment: `Observed links ${providerIds.task} and ${providerIds.draft}.`,
    thread: `Completed ${providerIds.task} ${providerIds.note} ${providerIds.draft} ${providerIds.comment}.`,
  };
  const textDigest = (value: string) => createHash('sha256').update(value).digest('hex');
  const manifestValue = structuredClone(frozen.manifest);
  for (const effect of manifestValue.effects) if ('bodySha256' in effect.requiredFields) {
    effect.requiredFields.bodySha256 = textDigest(bodies[effect.kind as keyof typeof bodies]);
  }
  manifestValue.protectedRecords = manifestValue.protectedRecords.filter(record =>
    record.logicalId === 'company_beta' || record.logicalId === 'promise_102');
  const manifest = LogicalManifestSchema.parse(manifestValue);
  const observedAt = '2026-09-13T17:35:05Z';
  const rawMimeRef = { artifactId: 'fixture-mime', sha256: textDigest('mime'), byteLength: 4,
    mediaType: 'message/rfc822' as const };
  const declaredEdits: DeclaredSourceEdit[] = [
    { editId: 'create-task', stage: 'source_edit', actorId: 'provider-history', observedAt,
      target: 'task', action: 'create', marker: effects.task.effectKey, recordId: providerIds.task,
      fields: { id: providerIds.task, companyIds: ['company_acme'], commitmentIds: ['promise_101'],
        ownerId: 'owner_101', dueAt: '2026-09-16T17:30:00Z', status: 'NOT_STARTED',
        subject: 'Observed follow-up', body: 'Observed task body.', version: 'task-v1' } },
    { editId: 'create-note', stage: 'source_edit', actorId: 'provider-history', observedAt,
      target: 'note', action: 'create', marker: effects.note.effectKey, recordId: providerIds.note,
      fields: { id: providerIds.note, companyIds: ['company_acme'], commitmentIds: ['promise_101'],
        taskIds: [providerIds.task], body: bodies.note, version: 'note-v1' } },
    { editId: 'create-draft', stage: 'source_edit', actorId: 'provider-history', observedAt,
      target: 'draft', action: 'create', marker: effects.draft.effectKey, recordId: providerIds.draft,
      fields: { draftId: providerIds.draft, messageId: 'provider_message', to: ['avery@acme.example.test'],
        cc: [], bcc: [], subject: `[PromiseGuard ${effects.draft.effectKey}] Billing migration follow-up`,
        body: bodies.draft, isDraft: true, rawMimeRef, version: 'draft-v1' } },
    { editId: 'create-comment', stage: 'source_edit', actorId: 'provider-history', observedAt,
      target: 'comment', action: 'create', marker: effects.comment.effectKey, recordId: providerIds.comment,
      fields: { id: providerIds.comment, repositoryId: world.github.technicalEvidence.incident.repositoryId,
        issueId: world.github.technicalEvidence.incident.issueId, authorId: 'provider-bot', body: bodies.comment,
        updatedAt: observedAt, version: 'comment-v1' } },
    { editId: 'create-thread', stage: 'source_edit', actorId: 'provider-history', observedAt,
      target: 'message', action: 'create', marker: effects.thread.effectKey, recordId: providerIds.thread,
      fields: { workspaceId: world.slack.workspaceId, channelId: world.slack.channelId,
        threadTs: providerIds.thread, messageTs: providerIds.thread, actorId: 'provider-bot', isBot: true,
        subtype: null, editedAt: null, deleted: false, body: bodies.thread, observedAt } },
  ];
  const providers = createFakeProviders({ namespace: 'q02-five-artifacts', ownerId: 'q02-owner', world,
    pageSize: 1, declaredEdits });
  let nextId = 0;
  const collector = createEvidenceCollector({
    readers: providers.readers,
    identity: { version: 'q02-v1', processId: 'collector-process', bootId: 'collector-boot' },
    createId: purpose => `q02-${purpose}-${++nextId}`,
    writeArtifact: (artifactId, value): RestrictedArtifactRef => {
      const bytes = canonical(value);
      return { artifactId, sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: Buffer.byteLength(bytes), mediaType: 'application/json' };
    },
  });
  const common = { manifest, runId: 'run-q02-five', evaluationAttemptId: 'evaluation-q02-five',
    evidenceMode: 'synthetic_fixture' as const, incident: world.github.technicalEvidence.incident,
    deadlineAt: '2026-09-13T17:36:00Z', budgets };
  const s0 = await collector.collectPhase({ ...common, phase: 's0', runtimeAttemptId: 'runtime-q02-five-s0' });
  for (const edit of declaredEdits) providers.operator.applyDeclaredEdit(edit.editId, edit.stage,
    { namespace: 'q02-five-artifacts', ownerId: 'q02-owner' });
  const s1 = await collector.collectPhase({ ...common, phase: 's1', runtimeAttemptId: 'runtime-q02-five-s1' });
  const operationHistory = manifest.effects.map(effect => ({ app: effect.app, actor: 'human' as const,
    operation: 'create' as const, outcome: 'applied' as const, effectKey: effect.effectKey,
    providerId: providerIds[effect.kind] }));

  const collected = collector.finalizeEvidence({ manifest, s0, s1, observedTerminalStatus: 'completed',
    operationHistory, historyComplete: true });

  assert.equal(s1.idBindings.length, 5);
  assert.equal(collected.checkerResult.result, 'passed');
  const duplicateBindings = structuredClone(s1.idBindings);
  duplicateBindings[1].matches[0].providerId = duplicateBindings[0].matches[0].providerId;
  assert.throws(() => createCheckerExport({ manifest, observedTerminalStatus: 'completed', s0: s0.records,
    s1: s1.records, idBindings: duplicateBindings, operationHistory, historyComplete: true }),
  /ambiguous_provider_identity/);
  const eventBase = { schemaVersion: 2 as const, producerVersion: 'q02-v1', producerId: 'runtime',
    runId: 'run-q02-five', evaluationAttemptId: 'evaluation-q02-five', runtimeAttemptId: 'runtime-q02-five-s1',
    stage: 'execute' as const, spanId: 'unknown-write-span', parentSpanId: null, processId: 'runtime-process',
    bootId: 'runtime-boot', monotonicMs: 1, causedBy: [] as string[] };
  const unknownWrite = [
    EventV2Schema.parse({ ...eventBase, kind: 'tool.dispatch', eventId: 'unknown-write-dispatch', sequence: 1,
      at: '2026-09-13T17:35:05Z', app: 'hubspot', operation: 'hubspot.createTask', logicalCallId: 'unknown-write',
      providerAttemptId: 'unknown-write-attempt', actor: 'executor', effectKey: effects.task.effectKey,
      requestDigest: 'a'.repeat(64), planHash: 'b'.repeat(64), approvalId: 'approval-q02' }),
    EventV2Schema.parse({ ...eventBase, kind: 'tool.result', eventId: 'unknown-write-result', sequence: 2,
      at: '2026-09-13T17:35:06Z', monotonicMs: 2, app: 'hubspot', operation: 'hubspot.createTask',
      logicalCallId: 'unknown-write', providerAttemptId: 'unknown-write-attempt', transportOutcome: 'timeout',
      providerOutcome: 'unknown', receiptRef: rawMimeRef, latencyMs: 1_000 }),
  ];
  assert.throws(() => createCheckerExport({ manifest, observedTerminalStatus: 'completed', s0: s0.records,
    s1: s1.records, idBindings: s1.idBindings, events: unknownWrite, operationHistory, historyComplete: true }),
  /unknown_write/);
});