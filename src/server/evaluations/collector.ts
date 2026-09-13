import { IdSchema, RestrictedArtifactRefSchema, UtcTimestampSchema, canonical, immutable } from '../../shared/domain.js';
import type { ImmutablePlan, IncidentIdentity, MutationOutcome, RestrictedArtifactRef } from '../../shared/domain.js';
import { ImportedObservationSchema, LogicalManifestSchema } from '../../shared/evaluation.js';
import type { ApprovedContentBinding, ImportedObservation, LogicalManifest } from '../../shared/evaluation.js';
import type { ReadCallContext } from '../../shared/adapters.js';
import type { EventV2 } from '../../shared/events.js';
import { digest } from '../../shared/reliability.js';
import { createCheckerExport } from './export-checker.js';
import type { CheckerLedgerEvent } from './export-checker.js';
import { projectProviderReads, readProviderPhase } from './provider-readers.js';
import type { CollectedProviderRecord, ProviderReaderSet } from './provider-readers.js';

export interface CollectorIdentity {
  version: string;
  processId: string;
  bootId: string;
}

export interface EvidenceCollectorOptions {
  readers: ProviderReaderSet;
  identity: CollectorIdentity;
  createId: (purpose: string) => string;
  writeArtifact: (artifactId: string, value: unknown) => RestrictedArtifactRef;
}

export interface CollectPhaseInput {
  manifest: LogicalManifest;
  phase: ImportedObservation['phase'];
  runId: string;
  evaluationAttemptId: string;
  runtimeAttemptId: string;
  evidenceMode: ImportedObservation['mode'];
  incident: IncidentIdentity;
  deadlineAt: string;
  budgets: ReadCallContext['budgets'];
}

export interface CollectedProviderPhase {
  readonly schemaVersion: 2;
  readonly manifestHash: string;
  readonly runId: string;
  readonly evaluationAttemptId: string;
  readonly runtimeAttemptId: string;
  readonly evidenceMode: ImportedObservation['mode'];
  readonly phase: ImportedObservation['phase'];
  readonly status: 'complete' | 'incomplete';
  readonly observations: readonly ImportedObservation[];
  readonly records: Readonly<Record<ReadCallContext['app'], readonly CollectedProviderRecord[]>>;
  readonly idBindings: readonly import('../../shared/evaluation.js').LogicalIdBinding[];
  readonly gaps: readonly string[];
}

export interface FinalizeEvidenceInput {
  manifest: LogicalManifest;
  s0: CollectedProviderPhase;
  s1: CollectedProviderPhase;
  observedTerminalStatus: LogicalManifest['expectedTerminalStatus'];
  plan?: ImmutablePlan | null;
  contentBindings?: readonly ApprovedContentBinding[];
  events?: readonly EventV2[];
  readMutationOutcome?: (providerAttemptId: string) => MutationOutcome | null;
  operationHistory?: readonly CheckerLedgerEvent[];
  historyComplete: boolean;
}

function verifyArtifact(refValue: RestrictedArtifactRef, value: unknown): RestrictedArtifactRef {
  const ref = RestrictedArtifactRefSchema.parse(refValue);
  const bytes = canonical(value);
  if (ref.mediaType !== 'application/json' || ref.sha256 !== digest(value) || ref.byteLength !== Buffer.byteLength(bytes))
    throw new Error('collector_artifact_integrity_mismatch');
  return ref;
}

export function createEvidenceCollector(options: EvidenceCollectorOptions) {
  const identity = {
    version: IdSchema.parse(options.identity.version),
    processId: IdSchema.parse(options.identity.processId),
    bootId: IdSchema.parse(options.identity.bootId),
  };
  const issuedPhases = new WeakSet<object>();
  const issuedOutcomes = new WeakSet<object>();
  const artifact = (purpose: string, value: unknown) => {
    const artifactId = IdSchema.parse(options.createId(`artifact-${purpose}`));
    return verifyArtifact(options.writeArtifact(artifactId, value), value);
  };

  async function collectPhase(input: CollectPhaseInput): Promise<CollectedProviderPhase> {
    const manifest = LogicalManifestSchema.parse(input.manifest);
    UtcTimestampSchema.parse(input.deadlineAt);
    const reads = await readProviderPhase({
      readers: options.readers,
      manifest,
      runId: input.runId,
      evaluationAttemptId: input.evaluationAttemptId,
      runtimeAttemptId: input.runtimeAttemptId,
      incident: input.incident,
      deadlineAt: input.deadlineAt,
      budgets: input.budgets,
      createId: options.createId,
    });
    const observations = reads.map(read => {
      const data = read.result.status === 'complete' ? read.result.data : read.result.partialData ?? null;
      const scope = { schemaVersion: 2, phase: input.phase, app: read.app, purpose: read.purpose,
        effectKey: read.effectKey, accountRef: read.result.receipt.accountRef };
      return ImportedObservationSchema.parse({
        schemaVersion: 2,
        observationId: options.createId(`${input.phase}-${read.app}-observation`),
        runId: input.runId,
        evaluationAttemptId: input.evaluationAttemptId,
        runtimeAttemptId: input.runtimeAttemptId,
        mode: input.evidenceMode,
        phase: input.phase,
        receipt: read.result.receipt,
        scopeRef: artifact(`${input.phase}-${read.app}-scope`, scope),
        producer: { producerId: read.result.receipt.producerId, ...identity },
        objectsRef: artifact(`${input.phase}-${read.app}-objects`, data),
      });
    });
    const projection = await projectProviderReads(reads, observations, manifest);
    const gaps = [...projection.collectionGaps, ...projection.bindingGaps];
    const phase = immutable<CollectedProviderPhase>({
      schemaVersion: 2,
      manifestHash: digest(manifest),
      runId: input.runId,
      evaluationAttemptId: input.evaluationAttemptId,
      runtimeAttemptId: input.runtimeAttemptId,
      evidenceMode: input.evidenceMode,
      phase: input.phase,
      status: projection.collectionGaps.length ? 'incomplete' : 'complete',
      observations,
      records: projection.records,
      idBindings: projection.idBindings,
      gaps,
    });
    issuedPhases.add(phase);
    return phase;
  }

  function finalizeEvidence(input: FinalizeEvidenceInput) {
    const manifest = LogicalManifestSchema.parse(input.manifest);
    const manifestHash = digest(manifest);
    for (const [expectedPhase, phase] of [['s0', input.s0], ['s1', input.s1]] as const) {
      if (!issuedPhases.has(phase) || phase.phase !== expectedPhase || phase.status !== 'complete' ||
          phase.manifestHash !== manifestHash || phase.runId !== input.s0.runId ||
          phase.evaluationAttemptId !== input.s0.evaluationAttemptId || phase.evidenceMode !== manifest.mode)
        throw new Error('collector_phase_binding_mismatch');
    }
    const exported = createCheckerExport({
      manifest,
      observedTerminalStatus: input.observedTerminalStatus,
      s0: input.s0.records,
      s1: input.s1.records,
      idBindings: input.s1.idBindings,
      contentBindings: input.contentBindings,
      plan: input.plan,
      events: input.events,
      readMutationOutcome: input.readMutationOutcome,
      operationHistory: input.operationHistory,
      historyComplete: input.historyComplete,
    });
    const outcomeEvidence = immutable({ observations: [...input.s0.observations, ...input.s1.observations],
      checkerInput: exported.checkerInput });
    for (const phase of ['s0', 's1'] as const) for (const app of ['github', 'hubspot', 'gmail', 'slack'] as const) {
      if (!outcomeEvidence.observations.some(observation => observation.phase === phase && observation.receipt.app === app))
        throw new Error('collector_scope_incomplete');
    }
    issuedOutcomes.add(outcomeEvidence);
    return immutable({ outcomeEvidence, checkerExportBinding: exported.binding, checkerResult: exported.result });
  }

  return Object.freeze({
    collectPhase,
    finalizeEvidence,
    isTrustedPhase: (value: unknown): value is CollectedProviderPhase =>
      typeof value === 'object' && value !== null && issuedPhases.has(value),
    isTrustedOutcomeEvidence: (value: unknown): boolean =>
      typeof value === 'object' && value !== null && issuedOutcomes.has(value),
  });
}