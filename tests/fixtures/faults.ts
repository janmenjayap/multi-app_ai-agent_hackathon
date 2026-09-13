import { canonical, immutable } from '../../src/shared/domain.js';

/** Operator-owned simulation controls. These are never application capabilities. */
export const FAULT_CONTRACT_VERSION = 'promiseguard-faults-v1';
export const STAGE_BOUNDARIES = [
  'before_graph_dispatch', 'after_source_snapshot', 'awaiting_approval', 'before_protected_write',
  'after_gmail_create_before_ledger_save', 'before_effect_readback', 'before_final_slack_readback',
  'before_replay_reconciliation', 'before_atomic_effect_claim', 'before_model_response',
  'between_attempt_legs',
] as const;

export type FaultKind = 'wrong_fields_ack' | 'page_two_failure' | 'accepted_unknown_write' |
  'duplicate_creation' | 'human_drift' | 'phantom_slack_success' | 'missing_scope' |
  'timeout' | 'tool_error' | 'rate_limited' | 'pagination_budget' | 'invisible_marker' |
  'malformed_output' | 'refusal' | 'unavailable' | 'invalid_citation' | 'false_claim' |
  'missing_content' | 'auditor_false_block' | 'auditor_unsupported_claim' | 'auditor_missing_content' |
  'source_edit' | 'approval_override' | 'concurrent_replay' | 'replay';

export interface FaultPoint {
  target: 'provider' | 'model' | 'stage';
  operation: string;
  phase: 'read' | 'write' | 'invoke' | 'before' | 'after';
  /** Provider pagination is one-based; failure on page 2 preserves page 1. */
  page?: number;
}
export interface FaultDirective {
  faultId: string;
  kind: FaultKind;
  fields?: Record<string, unknown>;
  actorId?: string;
  observedAt?: string;
}
export interface FaultRule extends FaultPoint, FaultDirective {
  /** Encounter count is local to this named selector, never global tool order. */
  occurrence?: number;
  repeat?: number | 'always';
}
export interface FaultEncounter {
  sequence: number;
  point: Readonly<FaultPoint>;
  faultId: string | null;
}

export class FaultController {
  readonly rules: readonly Readonly<FaultRule>[];
  private readonly counts = new Map<string, number>();
  private readonly encounters: FaultEncounter[] = [];

  constructor(rules: readonly FaultRule[] = []) {
    if (new Set(rules.map(rule => rule.faultId)).size !== rules.length) throw new Error('duplicate_fault_id');
    for (const rule of rules) {
      if (!Number.isSafeInteger(rule.occurrence ?? 1) || (rule.occurrence ?? 1) < 1 ||
          (rule.repeat !== undefined && rule.repeat !== 'always' && (!Number.isSafeInteger(rule.repeat) || rule.repeat < 1)) ||
          (rule.page !== undefined && (!Number.isSafeInteger(rule.page) || rule.page < 1))) throw new Error('invalid_fault_boundary');
    }
    this.rules = immutable(structuredClone(rules));
  }

  take(point: FaultPoint): Readonly<FaultDirective> | undefined {
    const matches = this.rules.filter(rule => rule.target === point.target && rule.operation === point.operation &&
      rule.phase === point.phase && (rule.page === undefined || rule.page === point.page));
    const due = matches.filter(rule => {
      const count = (this.counts.get(rule.faultId) ?? 0) + 1;
      this.counts.set(rule.faultId, count);
      const first = rule.occurrence ?? 1;
      return count >= first && (rule.repeat === 'always' || count < first + (rule.repeat ?? 1));
    });
    // Two simultaneous behaviors need two explicitly named boundaries.
    if (due.length > 1) throw new Error('ambiguous_fault_boundary');
    const rule = due[0];
    this.encounters.push(immutable({ sequence: this.encounters.length + 1, point: structuredClone(point), faultId: rule?.faultId ?? null }));
    if (!rule) return undefined;
    const { faultId, kind, fields, actorId, observedAt } = rule;
    return immutable({ faultId, kind, ...(fields ? { fields } : {}), ...(actorId ? { actorId } : {}), ...(observedAt ? { observedAt } : {}) });
  }

  at(boundary: typeof STAGE_BOUNDARIES[number], phase: 'before' | 'after' = 'after'): Readonly<FaultDirective> | undefined {
    return this.take({ target: 'stage', operation: boundary, phase });
  }

  trace(): readonly Readonly<FaultEncounter>[] { return immutable(structuredClone(this.encounters)); }
  /** A new independent controller reproduces the script from its first encounter. */
  replay(): FaultController { return new FaultController(this.rules); }
  assertReplay(trace: readonly FaultEncounter[]): void {
    if (canonical(this.trace()) !== canonical(trace)) throw new Error('fault_replay_mismatch');
  }
}

const provider = (faultId: string, operation: string, kind: FaultKind, phase: 'read' | 'write', extra: Partial<FaultRule> = {}): FaultRule =>
  ({ faultId, target: 'provider', operation, phase, kind, ...extra });
const stage = (faultId: string, operation: typeof STAGE_BOUNDARIES[number], kind: FaultKind, fields: Record<string, unknown> = {}): FaultRule =>
  ({ faultId, target: 'stage', operation, phase: 'after', kind, fields, actorId: 'fixture_fault_controller', observedAt: '2026-09-13T17:35:01Z' });
const model = (faultId: string, kind: FaultKind, role = 'analyst'): FaultRule =>
  ({ faultId, target: 'model', operation: role, phase: 'invoke', kind, repeat: 'always' });

const approval = (faultId: string, fields: Record<string, unknown>) => stage(faultId, 'awaiting_approval', 'approval_override', fields);

/** Frozen declarations, not execution records or evidence of covered scenarios. */
export const FAULT_SCRIPTS: Readonly<Record<string, readonly FaultRule[]>> = immutable({
  golden_path: [],
  // Source-only variants are fully declared by scenarios.json setup.sourceEdits.
  no_eligible_commitments: [],
  recipient_ambiguity: [],
  weak_causal_evidence: [],
  source_injection: [],
  unsupported_incident: [],
  missing_incident_field: [],
  conflicting_incident_field: [],
  nonproduction_incident: [],
  nonimpacting_incident: [],
  future_incident: [],
  missing_commitment_owner: [],
  overdue_commitment: [],
  out_of_horizon: [],
  horizon_start: [],
  horizon_end: [],
  source_order: [],
  prompt_paraphrase: [stage('prompt_paraphrase', 'before_model_response', 'source_edit', { promptVariant: 'independently_worded_equivalent_v1' })],
  duplicate_incident: [stage('duplicate_incident', 'before_replay_reconciliation', 'replay')],
  stale_approval: [stage('stale_approval', 'before_protected_write', 'source_edit', { commitmentId: 'promise_101', ownerId: 'owner_202' })],
  approval_expired: [stage('approval_expired', 'before_protected_write', 'approval_override', { elapsedMs: 600001 })],
  approval_expired_mid_batch: [{ ...stage('approval_expired_mid_batch', 'before_protected_write', 'approval_override', { elapsedMs: 600001 }), occurrence: 2 }],
  rejected_approval: [approval('rejected_approval', { decision: 'reject' })],
  transient_read_failure: [provider('transient_read_failure', 'github.readTechnicalEvidence', 'tool_error', 'read', { fields: { httpStatus: 503 } })],
  rate_limited_read: [provider('rate_limited_read', 'github.readTechnicalEvidence', 'rate_limited', 'read', { fields: { retryAfterMs: 1000 } })],
  rate_limit_over_budget: [provider('rate_limit_over_budget', 'github.readTechnicalEvidence', 'rate_limited', 'read', { repeat: 'always', fields: { retryAfterMs: 210001 } })],
  interrupted_accepted_write: [provider('interrupted_accepted_write', 'gmail.createDraft', 'accepted_unknown_write', 'write')],
  accepted_write_invisible: [provider('unresolved_write', 'gmail.createDraft', 'accepted_unknown_write', 'write'), provider('unresolved_marker', 'gmail.findDrafts', 'invisible_marker', 'read', { repeat: 'always' })],
  duplicate_creations: [provider('duplicate_creations', 'gmail.createDraft', 'duplicate_creation', 'write')],
  permission_denial: [provider('permission_denial', 'gmail.createDraft', 'missing_scope', 'write')],
  incorrect_result: [provider('incorrect_recipient', 'gmail.createDraft', 'wrong_fields_ack', 'write', { fields: { to: ['wrong@acme.example.test'] } })],
  body_tampering: [provider('body_tampering', 'gmail.createDraft', 'wrong_fields_ack', 'write', { fields: { body: 'The incident is resolved and the migration is guaranteed.' } })],
  wrong_task_owner: [provider('wrong_task_owner', 'hubspot.createTask', 'wrong_fields_ack', 'write', { fields: { ownerId: 'owner_202' } })],
  phantom_slack_success: [provider('phantom_slack_success', 'slack.postSummary', 'phantom_slack_success', 'write')],
  incident_service_edit: [stage('incident_service_edit', 'after_source_snapshot', 'source_edit', { service: 'analytics-api' })],
  incident_environment_edit: [stage('incident_environment_edit', 'after_source_snapshot', 'source_edit', { environment: 'staging' })],
  incomplete_source_retrieval: [provider('page_two_failure', 'hubspot.readCommitmentBundle', 'page_two_failure', 'read', { page: 2 })],
  pagination_budget_exhausted: [provider('pagination_budget_exhausted', 'hubspot.readCommitmentBundle', 'pagination_budget', 'read', { page: 2 })],
  source_timeout: [provider('source_timeout', 'hubspot.readCommitmentBundle', 'timeout', 'read', { repeat: 'always' })],
  freshness_read_unavailable: [provider('freshness_read_unavailable', 'github.readTechnicalEvidence', 'tool_error', 'read', { occurrence: 2, repeat: 'always' })],
  unauthorized_approval: [approval('unauthorized_approval', { actorId: 'unauthorized_actor' })],
  wrong_workspace: [approval('wrong_workspace', { workspaceId: 'other_workspace' })],
  wrong_channel: [approval('wrong_channel', { channelId: 'other_channel' })],
  wrong_thread: [approval('wrong_thread', { threadTs: 'other_thread' })],
  old_hash: [approval('old_hash', { hashPrefix: 'old_revision_hash' })],
  ambiguous_hash: [approval('ambiguous_hash', { hashPrefix: 'a' })],
  duplicate_approval: [approval('duplicate_approval', { duplicateCount: 2 })],
  out_of_order_approval: [approval('out_of_order_approval', { outOfOrder: true })],
  bot_approval: [approval('bot_approval', { isBot: true })],
  rejection_then_approval: [approval('rejection_then_approval', { decisions: ['reject', 'approve'] })],
  edited_approval: [approval('edited_approval', { editedAt: '2026-09-13T17:35:30Z' })],
  deleted_approval: [approval('deleted_approval', { deleted: true })],
  concurrent_replay: [stage('concurrent_replay', 'before_atomic_effect_claim', 'concurrent_replay', { submissions: 2 })],
  human_exact_match: [stage('human_exact_match', 'before_atomic_effect_claim', 'human_drift', { objectKind: 'task', match: 'exact' })],
  human_conflicting_match: [stage('human_conflicting_match', 'before_atomic_effect_claim', 'human_drift', { objectKind: 'task', match: 'conflicting', ownerId: 'owner_202' })],
  invalid_model_output: [model('invalid_model_output', 'malformed_output')],
  model_timeout: [model('model_timeout', 'timeout')],
  model_refusal: [model('model_refusal', 'refusal')],
  invalid_citation: [model('invalid_citation', 'invalid_citation')],
  false_claim_valid_citation: [model('false_claim_valid_citation', 'false_claim', 'drafter'), model('audit_false_claim', 'auditor_unsupported_claim', 'auditor')],
  missing_required_content: [model('missing_required_content', 'missing_content', 'drafter'), model('audit_missing_content', 'auditor_missing_content', 'auditor')],
  auditor_unavailable: [model('auditor_unavailable', 'unavailable', 'auditor')],
  auditor_false_block: [model('auditor_false_block', 'auditor_false_block', 'auditor')],
  source_drift_after_partial_progress: [{ ...stage('source_drift_after_partial_progress', 'before_protected_write', 'source_edit', { commitmentId: 'promise_101', ownerId: 'owner_202' }), occurrence: 2 }],
  contact_correction: [{ ...stage('contact_correction', 'between_attempt_legs', 'source_edit', { commitmentId: 'promise_101', designatedContactIds: ['contact_101'] }), actorId: 'fixture_operator' }],
  owner_correction: [{ ...stage('owner_correction', 'between_attempt_legs', 'source_edit', { commitmentId: 'promise_101', ownerId: 'owner_202', requireFreshApproval: true }), actorId: 'fixture_operator' }],
  permission_repair: [{ ...stage('permission_repair', 'between_attempt_legs', 'source_edit', { restoreScope: 'gmail.createDraft', requireFreshApproval: true }), actorId: 'fixture_operator' }],
  partial_owner_repair: [{ ...stage('partial_owner_repair', 'between_attempt_legs', 'human_drift', { objectKind: 'task', ownerId: 'owner_202', requireFreshApproval: true }), actorId: 'fixture_operator' }],
});

export function createFaultController(scriptId: string): FaultController {
  if (!Object.hasOwn(FAULT_SCRIPTS, scriptId)) throw new Error('unknown_fault_script');
  return new FaultController(FAULT_SCRIPTS[scriptId]);
}
