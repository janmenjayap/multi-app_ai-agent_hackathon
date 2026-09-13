import { checkEvidence } from '../../../tools/reliability/check-evidence.mjs';
import type { MutationOutcome, ImmutablePlan } from '../../shared/domain.js';
import { canonical, immutable } from '../../shared/domain.js';
import { LogicalManifestSchema, parseCheckerExportBinding } from '../../shared/evaluation.js';
import type { ApprovedContentBinding, CheckerExportBinding, LogicalIdBinding, LogicalManifest } from '../../shared/evaluation.js';
import { EventV2Schema } from '../../shared/events.js';
import type { EventV2 } from '../../shared/events.js';
import { digest } from '../../shared/reliability.js';
import type { CollectedProviderRecord } from './provider-readers.js';

type App = LogicalManifest['effects'][number]['app'];
type TerminalStatus = LogicalManifest['expectedTerminalStatus'];
type CheckerOperation = 'read' | 'create' | 'update' | 'adopt' | 'reuse' | 'send' | 'delete' | 'production_mutation';
type CheckerOutcome = 'applied' | 'verified' | 'error' | 'reused' | 'blocked';

export interface CheckerLedgerEvent {
  app: App;
  actor: 'executor' | 'verifier' | 'human';
  operation: CheckerOperation;
  outcome: CheckerOutcome;
  effectKey: string | null;
  providerId?: string;
}

export interface CreateCheckerExportInput {
  manifest: LogicalManifest;
  observedTerminalStatus: TerminalStatus;
  s0: Readonly<Record<App, readonly CollectedProviderRecord[]>>;
  s1: Readonly<Record<App, readonly CollectedProviderRecord[]>>;
  idBindings: readonly LogicalIdBinding[];
  contentBindings?: readonly ApprovedContentBinding[];
  plan?: ImmutablePlan | null;
  events?: readonly EventV2[];
  readMutationOutcome?: (providerAttemptId: string) => MutationOutcome | null;
  operationHistory?: readonly CheckerLedgerEvent[];
  historyComplete: boolean;
}

function resolveExpected(value: unknown, field: string, ids: ReadonlyMap<string, string>,
  contents: readonly ApprovedContentBinding[]): unknown {
  if (Array.isArray(value)) return value.map(item => resolveExpected(item, field, ids, contents));
  if (!value || typeof value !== 'object') return value;
  if ('type' in value && value.type === 'effect_id' && 'effectKey' in value) {
    const providerId = ids.get(String(value.effectKey));
    if (!providerId) throw new Error('checker_export_id_binding_missing');
    return providerId;
  }
  if ('type' in value && value.type === 'approved_content') {
    const binding = contents.find(item => canonical(item.contentRef) === canonical(value));
    if (!binding) throw new Error('checker_export_content_binding_missing');
    return field === 'bodySha256' ? binding.contentDigest : binding.text;
  }
  throw new Error('checker_export_unknown_reference');
}

function operation(value: string): CheckerOperation | null {
  if (/\.(resolve|read|find|get|list)/.test(value)) return null;
  if (/\.create|\.post/.test(value)) return 'create';
  if (/\.update/.test(value)) return 'update';
  if (/\.send$/.test(value)) return 'send';
  if (/\.delete$/.test(value)) return 'delete';
  if (/\.production_mutation$/.test(value)) return 'production_mutation';
  return null;
}

function eventLedger(input: CreateCheckerExportInput, ids: ReadonlyMap<string, string>): CheckerLedgerEvent[] {
  const events = (input.events ?? []).map(event => EventV2Schema.parse(event)).sort((left, right) => left.sequence - right.sequence);
  const endings = new Map(events.filter(event => event.kind === 'tool.result' || event.kind === 'tool.error')
    .map(event => [event.providerAttemptId, event]));
  const adoptions = events.filter((event): event is Extract<EventV2, { kind: 'effect.reconciled' }> =>
    event.kind === 'effect.reconciled' && event.resolution === 'adopted');
  const unknownDispatches = new Map<string, number>();
  const ledger: CheckerLedgerEvent[] = [...(input.operationHistory ?? [])].map(item => immutable({ ...item }));
  for (const dispatch of events) {
    if (dispatch.kind !== 'tool.dispatch') continue;
    const normalized = operation(dispatch.operation);
    if (!normalized) continue;
    const ending = endings.get(dispatch.providerAttemptId);
    if (!ending) throw new Error('checker_export_attempt_unresolved');
    if (ending.kind === 'tool.error') {
      if (ending.outcome === 'unknown') {
        if (!dispatch.effectKey || !adoptions.some(event => event.effectKey === dispatch.effectKey && event.sequence > ending.sequence))
          throw new Error('checker_export_unknown_write');
        unknownDispatches.set(dispatch.effectKey, (unknownDispatches.get(dispatch.effectKey) ?? 0) + 1);
        continue;
      }
      ledger.push({ app: dispatch.app, actor: 'executor',
        operation: normalized, outcome: 'error', effectKey: dispatch.effectKey });
      continue;
    }
    if (ending.transportOutcome !== 'response' || ending.providerOutcome === 'unknown') {
      if (!dispatch.effectKey || !adoptions.some(event => event.effectKey === dispatch.effectKey && event.sequence > ending.sequence))
        throw new Error('checker_export_unknown_write');
      unknownDispatches.set(dispatch.effectKey, (unknownDispatches.get(dispatch.effectKey) ?? 0) + 1);
      continue;
    }
    if (ending.providerOutcome !== 'success') {
      ledger.push({ app: dispatch.app, actor: 'executor', operation: normalized, outcome: 'error', effectKey: dispatch.effectKey });
      continue;
    }
    const outcome = input.readMutationOutcome?.(dispatch.providerAttemptId);
    if (!outcome) throw new Error('checker_export_mutation_outcome_missing');
    if (outcome?.status === 'unknown') throw new Error('checker_export_unknown_write');
    if (outcome?.status === 'not_applied') {
      ledger.push({ app: dispatch.app, actor: 'executor', operation: normalized, outcome: 'error', effectKey: dispatch.effectKey });
      continue;
    }
    const providerId = outcome.status === 'applied' ? outcome.providerId : undefined;
    if (!providerId) throw new Error('checker_export_provider_id_missing');
    ledger.push({ app: dispatch.app, actor: 'executor', operation: normalized, outcome: 'applied',
      effectKey: dispatch.effectKey, providerId });
  }
  if ([...unknownDispatches.values()].some(count => count !== 1)) throw new Error('checker_export_ambiguous_unknown_write');
  for (const reconciliation of events) if (reconciliation.kind === 'effect.reconciled' && reconciliation.resolution === 'adopted') {
    if (!reconciliation.providerId) throw new Error('checker_export_provider_id_missing');
    const effect = input.manifest.effects.find(candidate => candidate.effectKey === reconciliation.effectKey);
    if (!effect) throw new Error('checker_export_effect_missing');
    ledger.push({ app: effect.app, actor: 'executor', operation: 'adopt', outcome: 'reused',
      effectKey: effect.effectKey, providerId: reconciliation.providerId });
  }
  for (const binding of input.idBindings) ledger.push({ app: binding.app, actor: 'verifier', operation: 'read',
    outcome: 'verified', effectKey: binding.effectRef.effectKey, providerId: binding.matches[0].providerId });
  return ledger;
}

export function createCheckerExport(input: CreateCheckerExportInput) {
  const manifest = LogicalManifestSchema.parse(input.manifest);
  if (!input.historyComplete) throw new Error('checker_export_history_incomplete');
  const providerIdentities = input.idBindings.map(binding => canonical([
    binding.app, binding.accountRef, binding.matches[0].providerId,
  ]));
  if (new Set(providerIdentities).size !== providerIdentities.length) throw new Error('checker_export_ambiguous_provider_identity');
  const ids = new Map(input.idBindings.map(binding => [binding.effectRef.effectKey, binding.matches[0].providerId]));
  const contents = input.contentBindings ?? [];
  const checkerInput = {
    schemaVersion: 1,
    evidenceKind: manifest.mode,
    scenarioId: manifest.suiteEntryId,
    observedTerminalStatus: input.observedTerminalStatus,
    expected: {
      terminalStatus: manifest.expectedTerminalStatus,
      effects: manifest.effects.map(effect => ({ app: effect.app, effectKey: effect.effectKey, required: true,
        requiredFields: Object.fromEntries(Object.entries(effect.requiredFields)
          .map(([field, value]) => [field, resolveExpected(value, field, ids, contents)])) })),
      protectedRecords: manifest.protectedRecords.map(record => ({ app: record.app, id: record.logicalId })),
    },
    snapshots: (['github', 'hubspot', 'slack', 'gmail'] as const).map(app => ({ app, complete: true,
      before: input.s0[app], after: input.s1[app] })),
    ledger: { complete: true, events: eventLedger({ ...input, manifest }, ids) },
  };
  const bindingInput = {
    schemaVersion: 2 as const,
    logicalManifestHash: digest(manifest),
    planHash: input.plan?.planHash ?? null,
    contentBindings: contents,
    idBindings: input.idBindings,
    concreteCheckerExportHash: digest(checkerInput),
    checkerVersion: 'checker-v1' as const,
  };
  const binding: CheckerExportBinding = parseCheckerExportBinding(bindingInput, manifest, digest(manifest), input.plan ?? null);
  return immutable({ checkerInput, binding, result: checkEvidence(checkerInput) });
}