import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentInvocationContextSchema, AuditVerdictSchema, DraftProposalSchema, IncidentAssessmentSchema,
  agentCallResultSchema, type AgentInvocationContext } from '../../shared/agents.js';
import { AdapterCallContextSchema, ProviderAttemptReceiptSchema, type AdapterCallContext,
  type ProviderAttemptReceipt } from '../../shared/adapters.js';
import { EffectRecordSchema, ExecutionModeSchema, IdSchema, ImmutablePlanSchema, IncidentIdentitySchema,
  MutationOutcomeSchema, ProductStatusSchema, RestrictedArtifactRefSchema, SelectionSchema, SnapshotRefSchema,
  SlackDecisionSchema, UtcTimestampSchema, canonical, immutable, planHashMaterial, requestHashMaterial,
  normalizeBody, type EffectRecord, type ExecutionMode, type ImmutablePlan, type IncidentIdentity,
  type MutationOutcome, type RestrictedArtifactRef, type RunStatus, type SlackDecision, type SnapshotRef } from '../../shared/domain.js';
import { CompletionClaimSchema, CorrectionArtifactSchema, EvaluationAttemptRegistrationSchema,
  ImportedObservationSchema, OriginalOutputSchema, OutputHistorySchema, ReviewLabelSchema,
  parseReviewLabel, type CorrectionArtifact, type EvaluationAttemptRegistration,
  type ImportedObservation, type OriginalOutput, type ReviewLabel } from '../../shared/evaluation.js';
import { EventBatchV2Schema, EventV2Schema, type EventV2 } from '../../shared/events.js';
import { collectArtifactReferences, createCanonicalEvent, parseCanonicalEvent,
  type EventContext, type EventPayload, type EventStamp } from '../observability/events.js';
import { assertNoSecrets, encodeRestrictedArtifact, verifyRestrictedArtifact } from '../observability/redaction.js';
import { ApplicationDatabase } from './database.js';
import { parseMeasurementJobPolicy, type MeasurementJobPolicy } from './monitor-store.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const RunSchema = z.object({ schemaVersion: z.literal(2), runId: IdSchema,
  incident: IncidentIdentitySchema, configuration: ExecutionModeSchema, status: ProductStatusSchema,
  revision: z.number().int().nonnegative(), eventSequence: z.number().int().nonnegative(),
  createdAt: UtcTimestampSchema, updatedAt: UtcTimestampSchema }).strict();
export type StoredRun = z.infer<typeof RunSchema>;
const resultSchema = (role: AgentInvocationContext['role']) => agentCallResultSchema(
  role === 'analyst' ? IncidentAssessmentSchema : role === 'drafter' ? DraftProposalSchema : AuditVerdictSchema);

/** Restricted server-side repository. B04 creates authorized public projections. */
export class ApplicationRepository {
  constructor(readonly database: ApplicationDatabase) {}
  protected get sql() { return this.database.connection; }

  transaction<T>(context: EventContext, action: (writer: ApplicationWriter) => T): T {
    if (action.constructor.name === 'AsyncFunction') throw new Error('async_application_transaction');
    return this.database.transaction(() => {
      const writer = new ApplicationWriter(this.database, context);
      try {
        const result = action(writer);
        if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) throw new Error();
        writer.finish();
        return result;
      } finally { writer.closeWriter(); }
    });
  }

  getRun(runId: string): StoredRun | null {
    const row = this.sql.prepare('SELECT * FROM runs WHERE run_id = ?').get(IdSchema.parse(runId));
    if (!row) return null;
    return immutable(RunSchema.parse({ schemaVersion: 2, runId: row.run_id,
      incident: JSON.parse(String(row.incident_json)), configuration: JSON.parse(String(row.configuration_json)),
      status: row.status, revision: row.revision, eventSequence: row.event_sequence,
      createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  listRuns(statuses: RunStatus[] = ['queued', 'running', 'awaiting_approval', 'failed_partial']): StoredRun[] {
    const parsed = z.array(ProductStatusSchema).min(1).max(8).parse(statuses);
    return this.sql.prepare(`SELECT run_id FROM runs WHERE status IN (${parsed.map(() => '?').join(',')}) ORDER BY created_at`)
      .all(...parsed).map(row => this.getRun(String(row.run_id))!);
  }

  getEvaluation(evaluationAttemptId: string): EvaluationAttemptRegistration | null {
    const row = this.sql.prepare('SELECT manifest_json FROM attempts WHERE evaluation_attempt_id=? AND schema_version=2').get(evaluationAttemptId);
    return row ? immutable(EvaluationAttemptRegistrationSchema.parse(JSON.parse(String(row.manifest_json)))) : null;
  }

  getSnapshot(snapshotId: string): SnapshotRef | null {
    const row = this.sql.prepare('SELECT snapshot_json FROM snapshots WHERE snapshot_id=?').get(snapshotId);
    return row ? immutable(SnapshotRefSchema.parse(JSON.parse(String(row.snapshot_json)))) : null;
  }

  listApprovals(runId: string, planRevision: number): SlackDecision[] {
    return this.sql.prepare('SELECT decision_json FROM approvals WHERE run_id=? AND plan_revision=? ORDER BY rowid').all(runId, planRevision)
      .map(row => immutable(SlackDecisionSchema.parse(JSON.parse(String(row.decision_json)))));
  }

  getObservation(observationId: string): ImportedObservation | null {
    const row = this.sql.prepare('SELECT observation_json FROM observations WHERE observation_id=?').get(observationId);
    return row ? immutable(ImportedObservationSchema.parse(JSON.parse(String(row.observation_json)))) : null;
  }

  listReviewLabels(outputId: string): ReviewLabel[] {
    return this.sql.prepare('SELECT label_json FROM review_labels WHERE output_id=? ORDER BY rowid').all(outputId)
      .map(row => immutable(ReviewLabelSchema.parse(JSON.parse(String(row.label_json)))));
  }

  readEvents(input: { runId: string; afterSequence?: number; limit?: number }): EventV2[] {
    IdSchema.parse(input.runId);
    const after = z.number().int().nonnegative().parse(input.afterSequence ?? 0);
    const limit = z.number().int().min(1).max(1000).parse(input.limit ?? 100);
    return this.sql.prepare(`SELECT e.event_json FROM events e JOIN event_contexts c
      ON e.evaluation_attempt_id=c.evaluation_attempt_id AND e.event_id=c.event_id
      WHERE c.run_id=? AND c.sequence>? ORDER BY c.sequence LIMIT ?`).all(input.runId, after, limit)
      .map(row => parseCanonicalEvent(JSON.parse(String(row.event_json))));
  }

  readArtifact(ref: RestrictedArtifactRef): string {
    const parsed = RestrictedArtifactRefSchema.parse(ref);
    const row = this.sql.prepare('SELECT * FROM restricted_artifacts WHERE artifact_id=?').get(parsed.artifactId);
    if (!row || row.media_type !== parsed.mediaType || row.content_digest !== parsed.sha256 || row.byte_length !== parsed.byteLength)
      throw new Error('restricted_artifact_not_found');
    const bytes = row.content;
    if (!(bytes instanceof Uint8Array)) throw new Error('restricted_artifact_integrity_failed');
    verifyRestrictedArtifact(parsed, bytes);
    return Buffer.from(bytes).toString('utf8');
  }

  getEffect(effectKey: string): EffectRecord | null {
    const row = this.sql.prepare('SELECT record_json FROM effects WHERE effect_key=?').get(IdSchema.parse(effectKey));
    return row ? immutable(EffectRecordSchema.parse(JSON.parse(String(row.record_json)))) : null;
  }

  getPlan(runId: string, revision: number): ImmutablePlan | null {
    const row = this.sql.prepare('SELECT plan_json FROM plans WHERE run_id=? AND plan_revision=?').get(runId, revision);
    return row ? immutable(ImmutablePlanSchema.parse(JSON.parse(String(row.plan_json)))) : null;
  }

  getRole(key: string) {
    const row = this.sql.prepare('SELECT context_json FROM role_invocations WHERE role_invocation_key=?').get(key);
    if (!row) return null;
    const context = AgentInvocationContextSchema.parse(JSON.parse(String(row.context_json)));
    const result = this.sql.prepare('SELECT result_json FROM role_results WHERE role_invocation_key=?').get(key);
    const attempts = this.sql.prepare(`SELECT model_attempt_id, runtime_attempt_id, started_at FROM model_attempts
      WHERE role_invocation_key=? ORDER BY rowid`).all(key).map(a => ({
      modelAttemptId: String(a.model_attempt_id), runtimeAttemptId: String(a.runtime_attempt_id), startedAt: String(a.started_at),
    }));
    return immutable({ context, attempts, result: result ? resultSchema(context.role).parse(JSON.parse(String(result.result_json))) : null });
  }

  listOutputs(key: string): readonly OriginalOutput[] {
    return immutable(OutputHistorySchema.parse(this.sql.prepare(`SELECT output_json FROM original_outputs
      WHERE role_invocation_key=? ORDER BY rowid`).all(key).map(row => JSON.parse(String(row.output_json)))));
  }

  getProviderAttempt(providerAttemptId: string) {
    const row = this.sql.prepare(`SELECT p.context_json,p.started_at,r.receipt_json,r.outcome_json
      FROM provider_attempts p LEFT JOIN provider_results r USING(provider_attempt_id) WHERE provider_attempt_id=?`).get(providerAttemptId);
    return row ? immutable({ context: AdapterCallContextSchema.parse(JSON.parse(String(row.context_json))),
      startedAt: UtcTimestampSchema.parse(row.started_at),
      receipt: row.receipt_json ? ProviderAttemptReceiptSchema.parse(JSON.parse(String(row.receipt_json))) : null,
      outcome: row.outcome_json ? MutationOutcomeSchema.parse(JSON.parse(String(row.outcome_json))) : null }) : null;
  }
}

/** A capability invalidated at transaction exit; no network or model client is held here. */
export class ApplicationWriter extends ApplicationRepository {
  #active = true;
  #dirty = false;
  #events: EventV2[] = [];
  #required = new Set<string>();
  constructor(database: ApplicationDatabase, readonly context: EventContext) { super(database); }
  #write(): void {
    if (!this.#active || !this.sql.isTransaction) throw new Error('inactive_application_writer');
    this.#dirty = true;
  }
  #scope(value: { runId: string; evaluationAttemptId?: string; runtimeAttemptId?: string }): void {
    if (value.runId !== this.context.runId || (value.evaluationAttemptId && value.evaluationAttemptId !== this.context.evaluationAttemptId) ||
        (value.runtimeAttemptId && value.runtimeAttemptId !== this.context.runtimeAttemptId)) throw new Error('storage_identity_mismatch');
  }
  #refs(value: unknown): void {
    const visit = (item: unknown): void => {
      const parsed = RestrictedArtifactRefSchema.safeParse(item);
      if (parsed.success) {
        const owner = this.sql.prepare('SELECT run_id FROM restricted_artifacts WHERE artifact_id=?').get(parsed.data.artifactId);
        if (owner?.run_id !== this.context.runId) throw new Error('artifact_scope_mismatch');
        this.readArtifact(parsed.data);
      } else if (Array.isArray(item)) item.forEach(visit);
      else if (item && typeof item === 'object') Object.values(item).forEach(visit);
    };
    assertNoSecrets(value); visit(value);
  }
  closeWriter(): void { this.#active = false; }
  finish(): void {
    if ((this.#dirty && !this.#events.length) || this.#required.size) throw new Error('missing_canonical_event');
  }

  createRun(input: { runId: string; incident: IncidentIdentity; configuration: ExecutionMode; createdAt: string }): StoredRun {
    this.#write(); this.#scope(input);
    const incident = IncidentIdentitySchema.parse(input.incident), config = ExecutionModeSchema.parse(input.configuration);
    const at = UtcTimestampSchema.parse(input.createdAt);
    const existing = this.sql.prepare('SELECT run_id FROM runs WHERE repository_id=? AND issue_id=?').get(incident.repositoryId, incident.issueId);
    if (existing) {
      if (existing.run_id !== input.runId) throw new Error('incident_already_registered');
      if (canonical(this.getRun(input.runId)?.configuration) !== canonical(config)) throw new Error('configuration_mismatch');
      return this.getRun(input.runId)!;
    }
    this.sql.prepare(`INSERT INTO runs(run_id,repository_id,issue_id,incident_digest,incident_json,configuration_json,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'queued',?,?)`).run(IdSchema.parse(input.runId), incident.repositoryId, incident.issueId,
      hash(canonical({ schemaVersion: 2, repositoryId: incident.repositoryId, issueId: incident.issueId })), canonical(incident), canonical(config), at, at);
    return this.getRun(input.runId)!;
  }

  putArtifact(input: Parameters<typeof encodeRestrictedArtifact>[0]): RestrictedArtifactRef {
    this.#write();
    const { ref, bytes } = encodeRestrictedArtifact(input);
    const existing = this.sql.prepare('SELECT run_id FROM restricted_artifacts WHERE artifact_id=?').get(ref.artifactId);
    if (existing) { this.#refs(ref); return ref; }
    this.sql.prepare('INSERT INTO restricted_artifacts VALUES(?,?,?,?,?,?)')
      .run(ref.artifactId, this.context.runId, ref.sha256, ref.byteLength, ref.mediaType, bytes);
    return ref;
  }

  registerEvaluation(input: EvaluationAttemptRegistration, policy: MeasurementJobPolicy = {
    leaseMs: 30000, maxAttempts: 3, baseBackoffMs: 1000, maxBackoffMs: 30000,
  }): void {
    this.#write(); const registration = EvaluationAttemptRegistrationSchema.parse(input); this.#scope(registration); this.#refs(registration);
    if (canonical(this.getRun(registration.runId)?.configuration) !== canonical(registration.configuration)) throw new Error('configuration_mismatch');
    const existing = this.sql.prepare('SELECT manifest_json,schema_version FROM attempts WHERE evaluation_attempt_id=?').get(registration.evaluationAttemptId);
    if (existing) {
      if (existing.schema_version !== 2 || existing.manifest_json !== canonical(registration)) throw new Error('evaluation_attempt_conflict');
      const stored = this.sql.prepare('SELECT * FROM measurement_policies WHERE evaluation_attempt_id=?').get(registration.evaluationAttemptId);
      const frozen = parseMeasurementJobPolicy(policy);
      if (!stored || stored.lease_ms !== frozen.leaseMs || stored.max_attempts !== frozen.maxAttempts ||
          stored.base_backoff_ms !== frozen.baseBackoffMs || stored.max_backoff_ms !== frozen.maxBackoffMs) throw new Error('measurement_policy_conflict');
      return;
    }
    this.sql.prepare(`INSERT INTO attempts(evaluation_attempt_id,run_id,manifest_json,started_at_ms,schema_version)
      VALUES(?,?,?,?,2)`).run(registration.evaluationAttemptId, registration.runId, canonical(registration), Date.parse(registration.registeredAt));
    const frozen = parseMeasurementJobPolicy(policy);
    this.sql.prepare('INSERT INTO measurement_policies VALUES(?,?,?,?,?)').run(registration.evaluationAttemptId,
      frozen.leaseMs, frozen.maxAttempts, frozen.baseBackoffMs, frozen.maxBackoffMs);
  }

  startRuntime(input: { runtimeAttemptId: string; runId: string; evaluationAttemptId: string; startedAt: string }): void {
    this.#write(); this.#scope(input);
    const attempt = this.sql.prepare('SELECT run_id,schema_version FROM attempts WHERE evaluation_attempt_id=?').get(input.evaluationAttemptId);
    if (attempt?.run_id !== input.runId || attempt.schema_version !== 2) throw new Error('evaluation_attempt_conflict');
    this.sql.prepare('INSERT INTO runtime_attempts VALUES(?,?,?,?)').run(IdSchema.parse(input.runtimeAttemptId), input.runId,
      input.evaluationAttemptId, UtcTimestampSchema.parse(input.startedAt));
  }

  setRunStatus(status: RunStatus): void {
    this.#write(); ProductStatusSchema.parse(status);
    if (!this.getRun(this.context.runId)) throw new Error('run_not_found');
    this.sql.prepare('UPDATE runs SET status=? WHERE run_id=?').run(status, this.context.runId);
    this.#required.add(`status:${status}`);
  }

  saveSnapshot(input: SnapshotRef): void {
    this.#write(); const snapshot = SnapshotRefSchema.parse(input); this.#refs(snapshot);
    this.sql.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?)').run(snapshot.snapshotId, this.context.runId,
      snapshot.app, snapshot.accountRef, snapshot.relevantVersion, snapshot.capturedAt, canonical(snapshot));
  }

  freezePlan(input: ImmutablePlan): void {
    this.#write(); const plan = ImmutablePlanSchema.parse(input); this.#scope(plan); this.#refs(plan);
    if (plan.contents.some(c => c.text !== normalizeBody(c.text) || hash(c.text) !== c.sha256) ||
        plan.effects.some(e => hash(canonical(requestHashMaterial(e, plan.contents))) !== e.requestDigest) ||
        hash(canonical(planHashMaterial(plan))) !== plan.planHash) throw new Error('plan_integrity_failed');
    if (canonical(plan.incident) !== canonical(this.getRun(plan.runId)?.incident)) throw new Error('incident_conflict');
    const latest = this.sql.prepare('SELECT MAX(plan_revision) AS revision FROM plans WHERE run_id=?').get(plan.runId);
    if (plan.revision !== Number(latest?.revision ?? 0) + 1) throw new Error('plan_revision_conflict');
    for (const snapshot of plan.sources) {
      const row = this.sql.prepare('SELECT snapshot_json FROM snapshots WHERE snapshot_id=? AND run_id=?').get(snapshot.snapshotId, plan.runId);
      if (row?.snapshot_json !== canonical(snapshot)) throw new Error('missing_source_snapshot');
    }
    this.sql.prepare('INSERT INTO plans VALUES(?,?,?,?,?)').run(randomUUID(), plan.runId, plan.revision, plan.planHash, canonical(plan));
    this.#required.add(`plan:${plan.revision}:${plan.planHash}`);
    for (const effect of plan.effects) {
      const existing = this.getEffect(effect.effectKey);
      if (existing) {
        if (existing.runId !== plan.runId || (existing.state !== 'planned' && existing.requestDigest !== effect.requestDigest)) throw new Error('effect_identity_conflict');
        if (existing.state === 'planned') {
          const record = EffectRecordSchema.parse({ ...existing, requestDigest: effect.requestDigest });
          this.sql.prepare('UPDATE effects SET plan_revision=?,request_digest=?,record_json=? WHERE effect_key=?')
            .run(plan.revision, effect.requestDigest, canonical(record), effect.effectKey);
          this.sql.prepare('INSERT INTO effect_history(effect_key,record_json) VALUES(?,?)').run(effect.effectKey, canonical(record));
        }
      } else {
        const record = EffectRecordSchema.parse({ schemaVersion: 2, runId: plan.runId, effectKey: effect.effectKey,
          state: 'planned', requestDigest: effect.requestDigest, claimId: null, providerId: null, outcome: null, verificationRef: null });
        this.sql.prepare('INSERT INTO effects VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), effect.effectKey, plan.runId, plan.revision,
          effect.requestDigest, 'planned', null, null, canonical(record));
        this.sql.prepare('INSERT INTO effect_history(effect_key,record_json) VALUES(?,?)').run(effect.effectKey, canonical(record));
      }
    }
  }

  recordApproval(input: SlackDecision): void {
    this.#write(); const decision = SlackDecisionSchema.parse(input); this.#scope(decision); this.#refs(decision);
    if (this.getPlan(decision.runId, decision.planRevision)?.planHash !== decision.planHash) throw new Error('approval_plan_mismatch');
    if (decision.decision === 'approved' && this.sql.prepare(`SELECT 1 FROM approvals
      WHERE run_id=? AND plan_revision=? AND decision='rejected'`).get(decision.runId, decision.planRevision)) throw new Error('plan_rejected');
    this.sql.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,?)').run(decision.approvalId, decision.runId,
      decision.planRevision, decision.planHash, decision.workspaceId, decision.channelId, decision.decisionMessageTs, decision.decision, canonical(decision));
    this.#required.add(`approval:${decision.approvalId}`);
  }

  claimRole(input: AgentInvocationContext): boolean {
    if (!this.#active || !this.sql.isTransaction) throw new Error('inactive_application_writer');
    const context = AgentInvocationContextSchema.parse(input); this.#scope(context); this.#refs(context);
    const existing = this.getRole(context.roleInvocationKey);
    if (existing) {
      const frozen = (v: AgentInvocationContext) => ({ inputDigest: v.inputDigest, configDigest: v.configDigest,
        promptVersion: v.promptVersion, outputSchemaVersion: v.outputSchemaVersion, modelConfigRef: v.modelConfigRef,
        budgets: v.budgets, snapshotBundleRef: v.snapshotBundleRef, deadlineAt: v.deadlineAt, evaluationAttemptId: v.evaluationAttemptId });
      if (canonical(frozen(context)) !== canonical(frozen(existing.context))) throw new Error('role_context_conflict');
      return false;
    }
    this.#write();
    this.sql.prepare('INSERT INTO role_invocations VALUES(?,?,?,?,?,?)').run(randomUUID(), context.roleInvocationKey,
      context.runId, context.planRevision, context.role, canonical(context));
    return true;
  }

  startModelAttempt(input: { modelAttemptId: string; roleInvocationKey: string; startedAt: string }): void {
    this.#write(); const role = this.getRole(input.roleInvocationKey);
    if (!role || role.result) throw new Error('role_not_dispatchable');
    this.#scope({ runId: role.context.runId, evaluationAttemptId: role.context.evaluationAttemptId });
    const at = UtcTimestampSchema.parse(input.startedAt);
    if (role.attempts.length >= role.context.budgets.maxAttempts || Date.parse(at) >= Date.parse(role.context.deadlineAt) ||
        (role.attempts.length && Date.parse(at) - Date.parse(role.attempts[0].startedAt) >= role.context.budgets.roleBudgetMs)) throw new Error('model_budget_exhausted');
    for (const attempt of role.attempts) {
      if (!this.sql.prepare('SELECT 1 FROM original_outputs WHERE model_attempt_id=?').get(attempt.modelAttemptId) &&
          !this.sql.prepare(`SELECT event_json FROM events WHERE evaluation_attempt_id=?`).all(this.context.evaluationAttemptId)
            .some(row => { const event = parseCanonicalEvent(JSON.parse(String(row.event_json)));
              return event.kind === 'model.attempt.error' && event.modelAttemptId === attempt.modelAttemptId; }))
        throw new Error('model_attempt_unresolved');
    }
    this.sql.prepare('INSERT INTO model_attempts VALUES(?,?,?,?)').run(IdSchema.parse(input.modelAttemptId), input.roleInvocationKey, this.context.runtimeAttemptId, at);
    this.#required.add(`model-start:${input.modelAttemptId}`);
  }

  recordOutput(input: OriginalOutput): void {
    this.#write(); const output = OriginalOutputSchema.parse(input); this.#scope(output); this.#refs(output);
    const role = this.getRole(output.roleInvocationKey);
    const attempt = role?.attempts.find(a => a.modelAttemptId === output.modelAttemptId);
    if (!role || !attempt || attempt.runtimeAttemptId !== output.runtimeAttemptId || Date.parse(output.receivedAt) < Date.parse(attempt.startedAt) ||
        output.role !== role.context.role || output.planRevision !== role.context.planRevision ||
        output.inputDigest !== role.context.inputDigest || output.configDigest !== role.context.configDigest ||
        output.promptVersion !== role.context.promptVersion || output.outputSchemaVersion !== role.context.outputSchemaVersion) throw new Error('output_attempt_mismatch');
    OutputHistorySchema.parse([...this.listOutputs(output.roleInvocationKey), output]);
    this.sql.prepare('INSERT INTO original_outputs VALUES(?,?,?,?,?,?,?)').run(output.outputId, output.modelAttemptId,
      output.roleInvocationKey, output.firstOutputId, output.previousOutputId, output.receivedAt, canonical(output));
    this.#required.add(`model-result:${output.modelAttemptId}`);
  }

  saveRoleResult(input: { roleInvocationKey: string; result: unknown }): void {
    this.#write(); const role = this.getRole(input.roleInvocationKey);
    if (!role) throw new Error('role_not_found');
    this.#scope({ runId: role.context.runId, evaluationAttemptId: role.context.evaluationAttemptId });
    const result = resultSchema(role.context.role).parse(input.result); this.#refs(result);
    const outputs = this.listOutputs(input.roleInvocationKey);
    if (result.roleInvocationKey !== input.roleInvocationKey || canonical(result.attemptRefs) !== canonical(role.attempts.map(a => a.modelAttemptId)) ||
        canonical(result.firstOutputRef) !== canonical(outputs[0]?.rawOutput ?? null)) throw new Error('role_result_binding_mismatch');
    if (result.status === 'success') {
      const last = outputs.at(-1);
      if (!last || last.validationStatus !== 'valid' || canonical(result.outputRef) !== canonical(last.rawOutput) ||
          canonical(JSON.parse(this.readArtifact(result.outputRef))) !== canonical(result.output)) throw new Error('role_output_not_validated');
    }
    if (role.attempts.some(attempt => !outputs.some(output => output.modelAttemptId === attempt.modelAttemptId) &&
        !this.sql.prepare('SELECT event_json FROM events WHERE evaluation_attempt_id=?').all(role.context.evaluationAttemptId)
          .some(row => { const event = parseCanonicalEvent(JSON.parse(String(row.event_json)));
            return event.kind === 'model.attempt.error' && event.modelAttemptId === attempt.modelAttemptId; }))) throw new Error('model_attempt_unresolved');
    this.sql.prepare('INSERT INTO role_results VALUES(?,?,?)').run(randomUUID(), input.roleInvocationKey, canonical(result));
  }

  startProviderAttempt(input: { context: AdapterCallContext; requestRef: RestrictedArtifactRef; startedAt: string }): void {
    const context = AdapterCallContextSchema.parse(input.context);
    if ('effectKey' in context || ('marker' in context &&
        (!['slack.postReview', 'slack.updateReview'].includes(context.operation) || this.getEffect(context.marker))))
      throw new Error('effect_claim_required');
    this.#startProviderAttempt({ ...input, context });
  }

  #startProviderAttempt(input: { context: AdapterCallContext; requestRef: RestrictedArtifactRef; startedAt: string }): void {
    this.#write(); const context = AdapterCallContextSchema.parse(input.context); this.#scope(context); this.#refs(input.requestRef);
    if (context.mode !== this.getRun(context.runId)?.configuration.providerMode) throw new Error('transport_mode_mismatch');
    if (context.spanId !== this.context.spanId || Date.parse(input.startedAt) >= Date.parse(context.deadlineAt))
      throw new Error('provider_context_mismatch');
    if ('marker' in context && ['slack.postReview', 'slack.updateReview'].includes(context.operation)) {
      const prior = this.sql.prepare('SELECT provider_attempt_id,context_json FROM provider_attempts WHERE run_id=? AND app=\'slack\'').all(context.runId);
      for (const row of prior) {
        const previous = AdapterCallContextSchema.parse(JSON.parse(String(row.context_json)));
        if (!('marker' in previous) || previous.marker !== context.marker) continue;
        const attempt = this.getProviderAttempt(String(row.provider_attempt_id));
        if (!attempt?.receipt || attempt.receipt.providerOutcome === 'unknown' || attempt.outcome?.status === 'unknown' ||
            (context.operation === 'slack.postReview' && attempt.outcome?.status !== 'not_applied'))
          throw new Error('coordination_requires_reconciliation');
      }
    }
    const effectKey = 'effectKey' in context ? context.effectKey :
      'marker' in context && this.getEffect(context.marker) ? context.marker : null;
    this.sql.prepare('INSERT INTO provider_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(context.providerAttemptId,
      context.runId, context.runtimeAttemptId, context.logicalCallId, effectKey,
      context.app, context.accountRef, context.mode, input.requestRef.artifactId, canonical(context), UtcTimestampSchema.parse(input.startedAt));
    this.#required.add(`provider-start:${context.providerAttemptId}`);
  }

  claimEffect(input: { effectKey: string; claimId: string; context: AdapterCallContext; requestRef: RestrictedArtifactRef; startedAt: string }): boolean {
    if (!this.#active || !this.sql.isTransaction) throw new Error('inactive_application_writer');
    const context = AdapterCallContextSchema.parse(input.context);
    this.#scope(context); const effect = this.getEffect(input.effectKey);
    if (!effect || effect.runId !== context.runId || !('requestDigest' in context) || effect.requestDigest !== context.requestDigest ||
        ('effectKey' in context ? context.effectKey : 'marker' in context ? context.marker : null) !== input.effectKey) throw new Error('effect_context_mismatch');
    if (effect.state !== 'planned') return false;
    this.#write();
    if (this.sql.prepare(`SELECT 1 FROM effects WHERE run_id=? AND state='inflight'`).get(context.runId)) throw new Error('run_has_unresolved_effect');
    const planRow = this.sql.prepare('SELECT plan_revision FROM effects WHERE effect_key=?').get(input.effectKey)!;
    const plan = this.getPlan(context.runId, Number(planRow.plan_revision))!;
    const index = plan.effects.findIndex(item => item.effectKey === input.effectKey);
    const planned = plan.effects[index];
    const operations = { task: ['hubspot.createTask'], note: ['hubspot.createNote'], draft: ['gmail.createDraft'],
      comment: ['github.createComment', 'github.updateComment'], thread: ['slack.postSummary', 'slack.updateSummary'] };
    if (!planned || planned.app !== context.app || !operations[planned.kind].includes(context.operation))
      throw new Error('effect_operation_mismatch');
    if (plan.effects.slice(0, index).some(item => this.getEffect(item.effectKey)?.state !== 'verified'))
      throw new Error('prior_effect_not_verified');
    if ('planHash' in context) {
      const approvalRow = this.sql.prepare('SELECT decision_json FROM approvals WHERE approval_id=?').get(context.approvalRef);
      const approval = approvalRow ? SlackDecisionSchema.parse(JSON.parse(String(approvalRow.decision_json))) : null;
      if (context.planHash !== plan.planHash || !approval || approval.decision !== 'approved' || approval.planHash !== plan.planHash ||
          approval.runId !== context.runId || Date.parse(input.startedAt) >= Date.parse(approval.expiresAt) ||
          this.sql.prepare(`SELECT 1 FROM approvals WHERE run_id=? AND plan_revision=? AND decision='rejected'`).get(context.runId, plan.revision)) throw new Error('approval_not_active');
    }
    this.#startProviderAttempt(input);
    const record = EffectRecordSchema.parse({ ...effect, state: 'inflight', claimId: IdSchema.parse(input.claimId) });
    this.#updateEffect(record);
    return true;
  }

  #updateEffect(record: EffectRecord): void {
    const parsed = EffectRecordSchema.parse(record);
    this.sql.prepare('UPDATE effects SET state=?,claim_id=?,provider_id=?,record_json=? WHERE effect_key=?')
      .run(parsed.state, parsed.claimId, parsed.providerId, canonical(parsed), parsed.effectKey);
    this.sql.prepare('INSERT INTO effect_history(effect_key,record_json) VALUES(?,?)').run(parsed.effectKey, canonical(parsed));
  }

  recordProviderOutcome(input: { providerAttemptId: string; outcome: MutationOutcome | null; receipt: ProviderAttemptReceipt }): void {
    this.#write(); const receipt = ProviderAttemptReceiptSchema.parse(input.receipt); this.#scope(receipt.context); this.#refs(receipt);
    const attempt = this.getProviderAttempt(input.providerAttemptId);
    if (!attempt || attempt.receipt || canonical(attempt.context) !== canonical(receipt.context) || receipt.startedAt !== attempt.startedAt) throw new Error('provider_attempt_mismatch');
    const outcome = input.outcome === null ? null : MutationOutcomeSchema.parse(input.outcome); this.#refs(outcome);
    const effectKey = 'effectKey' in attempt.context ? attempt.context.effectKey : 'marker' in attempt.context ? attempt.context.marker : null;
    if (effectKey && this.getEffect(effectKey)) {
      if (!outcome) throw new Error('missing_mutation_outcome');
      const effect = this.getEffect(effectKey)!;
      if (effect.runId !== receipt.context.runId || effect.state !== 'inflight') throw new Error('effect_not_inflight');
      if (outcome.status === 'applied' && receipt.providerOutcome !== 'success') throw new Error('provider_outcome_mismatch');
      if (outcome.status === 'not_applied' && receipt.providerOutcome === 'unknown') throw new Error('provider_outcome_mismatch');
      this.#updateEffect({ ...effect, state: outcome.status === 'applied' ? 'applied' : 'inflight',
        providerId: outcome.status === 'applied' ? outcome.providerId : null, outcome });
    }
    this.sql.prepare('INSERT INTO provider_results VALUES(?,?,?,?)').run(randomUUID(), input.providerAttemptId,
      outcome ? canonical(outcome) : null, canonical(receipt));
    this.#required.add(`provider-result:${input.providerAttemptId}`);
  }

  recordObservation(input: ImportedObservation): void {
    this.#write(); const observation = ImportedObservationSchema.parse(input); this.#scope(observation); this.#refs(observation);
    this.sql.prepare('INSERT INTO observations VALUES(?,?,?,?)').run(observation.observationId,
      observation.runId, observation.evaluationAttemptId, canonical(observation));
  }

  reconcileEffect(input: { event: Extract<EventV2, { kind: 'effect.reconciled' }>; observationId: string; outcome: MutationOutcome }): void {
    this.#write(); const event = EventV2Schema.parse(input.event), outcome = MutationOutcomeSchema.parse(input.outcome);
    if (event.kind !== 'effect.reconciled') throw new Error('invalid_reconciliation');
    this.#scope(event); this.#refs(event); this.#refs(outcome);
    const effect = this.getEffect(event.effectKey), read = this.getProviderAttempt(event.readAttemptId);
    const row = this.sql.prepare('SELECT observation_json FROM observations WHERE observation_id=?').get(input.observationId);
    const observation = row ? ImportedObservationSchema.parse(JSON.parse(String(row.observation_json))) : null;
    const page = observation?.receipt.pages.find(item => item.providerAttemptId === event.readAttemptId);
    const writeRow = this.sql.prepare('SELECT context_json FROM provider_attempts WHERE effect_key=? ORDER BY rowid DESC LIMIT 1').get(event.effectKey);
    const write = writeRow ? AdapterCallContextSchema.parse(JSON.parse(String(writeRow.context_json))) : null;
    if (!effect || effect.runId !== event.runId || effect.state !== 'inflight' || !read?.receipt || !observation || !page || !write ||
        observation.runId !== event.runId || observation.evaluationAttemptId !== event.evaluationAttemptId ||
        read.context.runId !== event.runId || read.context.evaluationAttemptId !== event.evaluationAttemptId ||
        read.context.app !== write.app || read.context.accountRef !== write.accountRef || 'requestDigest' in read.context ||
        observation.receipt.app !== read.context.app || observation.receipt.accountRef !== read.context.accountRef ||
        observation.phase === 's0' || observation.receipt.status !== 'complete' ||
        read.receipt.providerOutcome !== 'success' || canonical(page.response) !== canonical(read.receipt.responseRef) ||
        Date.parse(read.receipt.finishedAt) > Date.parse(event.at) || Date.parse(observation.receipt.finishedAt) > Date.parse(event.at))
      throw new Error('reconciliation_readback_missing');
    if ((event.resolution === 'adopted' && (outcome.status !== 'applied' || outcome.providerId !== event.providerId)) ||
        (event.resolution === 'not_applied' && (outcome.status !== 'not_applied' || event.providerId !== null)) ||
        (['unresolved', 'conflict'].includes(event.resolution) && (outcome.status !== 'unknown' || event.providerId !== null)))
      throw new Error('reconciliation_outcome_mismatch');
    this.#updateEffect({ ...effect, state: outcome.status === 'applied' ? 'applied' : 'inflight',
      providerId: outcome.status === 'applied' ? outcome.providerId : null, outcome });
    this.sql.prepare('INSERT INTO reconciliations VALUES(?,?,?,?,?)').run(event.eventId, event.runId, event.effectKey,
      input.observationId, canonical({ schemaVersion: 2, event, observationId: input.observationId, outcome }));
    this.#required.add(`reconciliation:${event.eventId}`);
  }

  recordVerification(input: { observationId: string; event: Extract<EventV2, { kind: 'effect.verified' }>; providerId: string }): void {
    this.#write(); const event = EventV2Schema.parse(input.event);
    if (event.kind !== 'effect.verified') throw new Error('invalid_verification');
    this.#scope(event); this.#refs(event);
    const effect = this.getEffect(event.effectKey), read = this.getProviderAttempt(event.readAttemptId);
    const observationRow = this.sql.prepare('SELECT observation_json FROM observations WHERE observation_id=?').get(input.observationId);
    const observation = observationRow ? ImportedObservationSchema.parse(JSON.parse(String(observationRow.observation_json))) : null;
    const page = observation?.receipt.pages.find(p => p.providerAttemptId === event.readAttemptId);
    if (!effect || effect.runId !== event.runId || effect.providerId !== input.providerId || !observation || !read?.receipt || !page ||
        observation.runId !== event.runId || observation.evaluationAttemptId !== event.evaluationAttemptId ||
        read.context.runId !== event.runId || read.context.evaluationAttemptId !== event.evaluationAttemptId ||
        observation.receipt.app !== read.context.app || observation.receipt.accountRef !== read.context.accountRef ||
        observation.phase === 's0' || observation.receipt.status !== 'complete' ||
        canonical(page.response) !== canonical(read.receipt.responseRef) ||
        Date.parse(read.receipt.finishedAt) > Date.parse(event.at) || Date.parse(observation.receipt.finishedAt) > Date.parse(event.at))
      throw new Error('verification_readback_missing');
    const planRow = this.sql.prepare('SELECT plan_json FROM plans WHERE run_id=? AND plan_digest=?').get(event.runId, event.planHash);
    const plan = planRow ? ImmutablePlanSchema.parse(JSON.parse(String(planRow.plan_json))) : null;
    const planned = plan?.effects.find(item => item.effectKey === event.effectKey);
    const operations = { task: ['hubspot.getTask'], note: ['hubspot.getNote'], draft: ['gmail.getDraft'],
      comment: ['github.getComment'], thread: ['slack.readSummary', 'slack.getMessage'] };
    const write = this.sql.prepare('SELECT context_json FROM provider_attempts WHERE effect_key=? ORDER BY rowid DESC LIMIT 1').get(event.effectKey);
    const writeContext = write ? AdapterCallContextSchema.parse(JSON.parse(String(write.context_json))) : null;
    if (!planned || planned.kind !== event.artifactKind || planned.app !== read.context.app ||
        planned.requestDigest !== effect.requestDigest || !operations[planned.kind].includes(read.context.operation) ||
        writeContext?.accountRef !== read.context.accountRef) throw new Error('verification_plan_mismatch');
    if (event.verdict === 'matched' && read.receipt.providerOutcome !== 'success') throw new Error('verification_readback_missing');
    this.sql.prepare('INSERT INTO verifications VALUES(?,?,?,?,?,?)').run(event.verificationId, event.runId,
      event.effectKey, input.observationId, event.readAttemptId, canonical({ schemaVersion: 2, event, providerId: input.providerId }));
    if (event.verdict === 'matched') {
      if (effect.state !== 'applied') throw new Error('effect_not_applied');
      this.#updateEffect({ ...effect, state: 'verified', verificationRef: event.receiptRef });
    }
    this.#required.add(`verification:${event.verificationId}`);
  }

  recordCorrection(input: CorrectionArtifact): void {
    this.#write(); const correction = CorrectionArtifactSchema.parse(input); this.#scope(correction); this.#refs(correction);
    const first = this.sql.prepare('SELECT output_json FROM original_outputs WHERE output_id=?').get(correction.firstOutputId);
    const original = first ? OriginalOutputSchema.parse(JSON.parse(String(first.output_json))) : null;
    if (!original || original.runId !== this.context.runId || original.firstOutputId !== original.outputId ||
        original.evaluationAttemptId !== correction.evaluationAttemptId || Date.parse(correction.correctedAt) < Date.parse(original.receivedAt)) throw new Error('missing_original_output');
    const previous = this.sql.prepare('SELECT correction_json FROM corrections WHERE first_output_id=? ORDER BY rowid DESC LIMIT 1').get(correction.firstOutputId);
    const previousCorrection = previous ? CorrectionArtifactSchema.parse(JSON.parse(String(previous.correction_json))) : null;
    if (correction.previousArtifactId !== (previousCorrection?.correctionId ?? original.outputId) ||
        (previousCorrection && Date.parse(correction.correctedAt) < Date.parse(previousCorrection.correctedAt))) throw new Error('invalid_correction_history');
    this.sql.prepare('INSERT INTO corrections VALUES(?,?,?,?,?)').run(correction.correctionId, correction.runId,
      correction.firstOutputId, correction.previousArtifactId, canonical(correction));
  }

  recordReviewLabel(input: ReviewLabel): void {
    this.#write(); const label = ReviewLabelSchema.parse(input); this.#scope(label); this.#refs(label);
    const output = this.sql.prepare('SELECT output_json FROM original_outputs WHERE output_id=?').get(label.outputId);
    if (!output) throw new Error('missing_original_output');
    const prior = this.sql.prepare('SELECT label_json FROM review_labels WHERE output_id=?').all(label.outputId).map(row => JSON.parse(String(row.label_json)));
    parseReviewLabel(label, JSON.parse(String(output.output_json)), prior);
    this.sql.prepare('INSERT INTO review_labels VALUES(?,?,?,?,?)').run(label.labelId, label.runId, label.outputId, label.supersedesLabelId, canonical(label));
  }

  #validateEvent(event: EventV2): void {
    if (event.kind === 'run.status') {
      if (this.getRun(event.runId)?.status !== event.status) throw new Error('event_status_mismatch');
      if (event.status === 'completed' || event.status === 'completed_no_affected_commitments') {
        const claims = this.sql.prepare('SELECT claim_json FROM completion_claims WHERE run_id=?').all(event.runId)
          .map(row => CompletionClaimSchema.parse(JSON.parse(String(row.claim_json))));
        const scope = event.status === 'completed' ? 'run' : 'no_affected';
        const latestPlan = this.sql.prepare('SELECT plan_digest FROM plans WHERE run_id=? ORDER BY plan_revision DESC LIMIT 1').get(event.runId);
        if (!claims.some(claim => claim.scope === scope && claim.evaluationAttemptId === event.evaluationAttemptId &&
            (claim.scope === 'no_affected' ? !latestPlan : claim.planHash === latestPlan?.plan_digest) &&
            claim.sequence < event.sequence && Date.parse(claim.emittedAt) <= Date.parse(event.at)))
          throw new Error('completion_claim_missing');
        if (scope === 'no_affected' && (this.sql.prepare('SELECT 1 FROM effects WHERE run_id=?').get(event.runId) ||
            this.sql.prepare(`SELECT 1 FROM model_attempts m JOIN runtime_attempts r USING(runtime_attempt_id) WHERE r.run_id=?`).get(event.runId)))
          throw new Error('no_affected_history_conflict');
      }
    }
    if ('modelAttemptId' in event) {
      const role = this.getRole(event.roleInvocationKey);
      const attempt = role?.attempts.find(item => item.modelAttemptId === event.modelAttemptId);
      if (!role || !attempt || attempt.runtimeAttemptId !== event.runtimeAttemptId || role.context.runId !== event.runId ||
          role.context.evaluationAttemptId !== event.evaluationAttemptId || role.context.role !== event.role ||
          role.context.planRevision !== event.planRevision) throw new Error('event_model_attempt_mismatch');
      if (event.kind === 'model.attempt.started' && (event.inputDigest !== role.context.inputDigest ||
          event.configDigest !== role.context.configDigest || event.promptVersion !== role.context.promptVersion ||
          event.outputSchemaVersion !== role.context.outputSchemaVersion)) throw new Error('event_model_context_mismatch');
      if (event.kind === 'model.attempt.result') {
        const output = this.listOutputs(event.roleInvocationKey).find(item => item.modelAttemptId === event.modelAttemptId);
        const validation = output?.parseStatus === 'refused' ? 'refused' : output?.validationStatus === 'valid' ? 'valid' : 'invalid';
        if (!output || canonical(output.rawOutput) !== canonical(event.outputRef) || event.validation !== validation)
          throw new Error('event_model_output_mismatch');
      }
    }
    if ('providerAttemptId' in event) {
      const attempt = this.getProviderAttempt(event.providerAttemptId);
      if (!attempt || attempt.context.runId !== event.runId || attempt.context.evaluationAttemptId !== event.evaluationAttemptId ||
          attempt.context.runtimeAttemptId !== event.runtimeAttemptId || attempt.context.spanId !== event.spanId ||
          attempt.context.app !== event.app || attempt.context.operation !== event.operation ||
          attempt.context.logicalCallId !== event.logicalCallId) throw new Error('event_provider_attempt_mismatch');
      const context = attempt.context;
      if (event.kind === 'tool.dispatch') {
        const effectKey = 'effectKey' in context ? context.effectKey : 'marker' in context ? context.marker : null;
        if (event.effectKey !== effectKey || event.requestDigest !== ('requestDigest' in context ? context.requestDigest : null) ||
            event.planHash !== ('planHash' in context ? context.planHash : null) ||
            event.approvalId !== ('approvalRef' in context ? context.approvalRef : null) ||
            ('effectKey' in context && event.actor !== 'executor') || ('marker' in context && event.actor !== 'coordinator'))
          throw new Error('event_dispatch_context_mismatch');
      } else {
        if (!attempt.receipt) throw new Error('event_provider_result_missing');
        if (event.kind === 'tool.result') {
          const outcome = attempt.receipt.providerOutcome === 'success' ? 'success' :
            attempt.receipt.providerOutcome === 'unknown' ? 'unknown' : 'error';
          const referenceMatches = canonical(event.receiptRef) === canonical(attempt.receipt.responseRef) ||
            canonical(event.receiptRef) === canonical(attempt.outcome?.receipt) ||
            this.readArtifact(event.receiptRef) === canonical(attempt.receipt);
          if (event.transportOutcome !== attempt.receipt.transportOutcome || event.providerOutcome !== outcome || !referenceMatches)
            throw new Error('event_provider_result_mismatch');
        } else if (event.kind === 'tool.error' && (event.errorCode !== attempt.receipt.errorCode ||
            (attempt.outcome && event.outcome !== attempt.outcome.status))) throw new Error('event_provider_error_mismatch');
      }
    }
    if (event.kind === 'plan.frozen') {
      const plan = this.getPlan(event.runId, event.planRevision);
      if (!plan || plan.planHash !== event.planHash || canonical(JSON.parse(this.readArtifact(event.planRef))) !== canonical(plan))
        throw new Error('event_plan_mismatch');
    }
    if (event.kind === 'approval.checked' && ['approved', 'rejected'].includes(event.decision)) {
      const row = this.sql.prepare('SELECT decision_json FROM approvals WHERE approval_id=?').get(event.approvalId);
      const decision = row ? SlackDecisionSchema.parse(JSON.parse(String(row.decision_json))) : null;
      if (!decision || decision.runId !== event.runId || decision.planRevision !== event.planRevision ||
          decision.planHash !== event.planHash || decision.decision !== event.decision)
        throw new Error('event_approval_mismatch');
    }
    if (event.kind === 'effect.verified') {
      const row = this.sql.prepare('SELECT verification_json FROM verifications WHERE verification_id=?').get(event.verificationId);
      if (!row || canonical(JSON.parse(String(row.verification_json)).event) !== canonical(event))
        throw new Error('event_verification_mismatch');
    }
    if (event.kind === 'effect.reconciled') {
      const row = this.sql.prepare('SELECT record_json FROM reconciliations WHERE event_id=?').get(event.eventId);
      if (!row || canonical(JSON.parse(String(row.record_json)).event) !== canonical(event))
        throw new Error('event_reconciliation_mismatch');
    }
  }

  appendEvent(payload: EventPayload, stamp?: EventStamp): EventV2 {
    this.#write(); const run = this.getRun(this.context.runId);
    if (!run) throw new Error('run_not_found');
    const event = createCanonicalEvent({ context: this.context, payload, sequence: run.eventSequence + 1, stamp });
    for (const ref of collectArtifactReferences(event)) this.#refs(ref);
    this.#validateEvent(event);
    const previous = this.sql.prepare('SELECT event_json FROM events WHERE evaluation_attempt_id=? ORDER BY sequence')
      .all(event.evaluationAttemptId).map(row => JSON.parse(String(row.event_json)));
    EventBatchV2Schema.parse({ schemaVersion: 2, runId: event.runId, evaluationAttemptId: event.evaluationAttemptId, events: [...previous, event] });
    const clock = this.sql.prepare('SELECT MAX(monotonic_ms) AS last FROM event_contexts WHERE process_id=? AND boot_id=?').get(event.processId, event.bootId);
    if (clock?.last !== null && clock?.last !== undefined && event.monotonicMs < Number(clock.last)) throw new Error('clock_regression');
    if (event.kind === 'success.claimed') {
      const claim = CompletionClaimSchema.parse(event.claim);
      if (claim.scope !== 'no_affected') {
        const plan = ImmutablePlanSchema.parse(JSON.parse(this.readArtifact(claim.planRef)));
        if (plan.runId !== claim.runId || plan.planHash !== claim.planHash ||
            canonical(this.getPlan(claim.runId, plan.revision)) !== canonical(plan) ||
            claim.effectKeys.some(key => !plan.effects.some(effect => effect.effectKey === key)) ||
            (claim.scope === 'run' && canonical([...claim.effectKeys].sort()) !== canonical(plan.effects.map(effect => effect.effectKey).sort())))
          throw new Error('claim_plan_scope_mismatch');
        for (const verification of claim.verifications) {
          const row = this.sql.prepare('SELECT verification_json FROM verifications WHERE verification_id=? AND run_id=?').get(verification.verificationId, claim.runId);
          if (!row) throw new Error('claim_verification_missing');
          const saved = JSON.parse(String(row.verification_json));
          if (saved.event.effectKey !== verification.effectKey || saved.event.planHash !== claim.planHash ||
              saved.event.evaluationAttemptId !== claim.evaluationAttemptId || saved.event.artifactKind !== verification.kind ||
              saved.event.verdict !== 'matched' || saved.event.at !== verification.observedAt ||
              canonical(saved.event.receiptRef) !== canonical(verification.receipt)) throw new Error('claim_verification_mismatch');
          const observed = this.sql.prepare('SELECT sequence FROM event_contexts WHERE event_id=? AND run_id=?').get(saved.event.eventId, claim.runId);
          if (!observed || Number(observed.sequence) >= event.sequence || this.getEffect(verification.effectKey)?.state !== 'verified')
            throw new Error('claim_verification_not_yet_available');
        }
      } else {
        if (this.sql.prepare('SELECT 1 FROM plans WHERE run_id=?').get(claim.runId) ||
            this.sql.prepare('SELECT 1 FROM effects WHERE run_id=?').get(claim.runId) ||
            this.sql.prepare('SELECT 1 FROM approvals WHERE run_id=?').get(claim.runId) ||
            this.sql.prepare(`SELECT 1 FROM model_attempts m JOIN runtime_attempts r USING(runtime_attempt_id) WHERE r.run_id=?`).get(claim.runId))
          throw new Error('no_affected_history_conflict');
        const calls = this.sql.prepare('SELECT context_json FROM provider_attempts WHERE run_id=?').all(claim.runId)
          .map(row => AdapterCallContextSchema.parse(JSON.parse(String(row.context_json))));
        if (calls.some(call => 'requestDigest' in call)) throw new Error('no_affected_history_conflict');
        const selection = SelectionSchema.parse(JSON.parse(this.readArtifact(claim.selection.receipt)));
        this.#refs(selection);
        if (selection.selected.length || selection.policyVersion !== claim.selection.policyVersion ||
            Date.parse(selection.evaluatedAt) > Date.parse(claim.emittedAt)) throw new Error('no_affected_selection_mismatch');
        const snapshots = this.sql.prepare('SELECT snapshot_json FROM snapshots WHERE run_id=?').all(claim.runId)
          .map(row => SnapshotRefSchema.parse(JSON.parse(String(row.snapshot_json))));
        const observations = this.sql.prepare('SELECT observation_json FROM observations WHERE run_id=? AND evaluation_attempt_id=?')
          .all(claim.runId, claim.evaluationAttemptId).map(row => ImportedObservationSchema.parse(JSON.parse(String(row.observation_json))));
        for (const receipt of claim.sourceReceipts) {
          if (![...snapshots, ...observations].some(source => canonical(source.receipt) === canonical(receipt)))
            throw new Error('no_affected_source_missing');
          for (const page of receipt.pages) {
            const read = this.getProviderAttempt(page.providerAttemptId);
            if (!read?.receipt || read.context.runId !== claim.runId || read.context.evaluationAttemptId !== claim.evaluationAttemptId ||
                read.context.app !== receipt.app || read.context.accountRef !== receipt.accountRef ||
                read.receipt.providerOutcome !== 'success' || canonical(read.receipt.responseRef) !== canonical(page.response))
              throw new Error('no_affected_source_missing');
          }
        }
        for (const absence of claim.absenceEvidence) {
          if (!observations.some(observation => observation.phase !== 's0' && observation.receipt.status === 'complete' &&
              Date.parse(observation.receipt.finishedAt) <= Date.parse(claim.emittedAt) &&
              [observation.objectsRef, ...observation.receipt.pages.map(page => page.response)]
                .some(ref => canonical(ref) === canonical(absence.receipt)))) throw new Error('no_affected_absence_missing');
        }
      }
      this.sql.prepare('INSERT INTO completion_claims VALUES(?,?,?,?)').run(claim.claimId, claim.runId, event.eventId, canonical(claim));
    }
    this.sql.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(event.evaluationAttemptId, event.eventId, event.sequence, Date.parse(event.at), canonical(event));
    this.sql.prepare('INSERT INTO event_contexts VALUES(?,?,?,?,?,?,?,?)').run(event.eventId, event.runId, event.runtimeAttemptId,
      event.evaluationAttemptId, event.sequence, event.processId, event.bootId, event.monotonicMs);
    this.sql.prepare('UPDATE runs SET revision=revision+1,event_sequence=?,updated_at=? WHERE run_id=?').run(event.sequence, event.at, event.runId);
    this.sql.prepare('UPDATE attempts SET watermark=watermark+1 WHERE evaluation_attempt_id=? AND schema_version=2').run(event.evaluationAttemptId);
    const row = this.sql.prepare('SELECT watermark FROM attempts WHERE evaluation_attempt_id=? AND schema_version=2').get(event.evaluationAttemptId);
    if (!row) throw new Error('evaluation_attempt_not_registered');
    this.database.monitor.enqueueInTransaction(event.evaluationAttemptId, Number(row.watermark), Date.parse(event.at), 'monitor-v2');
    if (event.kind === 'run.status') this.#required.delete(`status:${event.status}`);
    if (event.kind === 'model.attempt.started') this.#required.delete(`model-start:${event.modelAttemptId}`);
    if (event.kind === 'model.attempt.result') this.#required.delete(`model-result:${event.modelAttemptId}`);
    if (event.kind === 'tool.dispatch') this.#required.delete(`provider-start:${event.providerAttemptId}`);
    if (event.kind === 'tool.result' || event.kind === 'tool.error') this.#required.delete(`provider-result:${event.providerAttemptId}`);
    if (event.kind === 'effect.verified') this.#required.delete(`verification:${event.verificationId}`);
    if (event.kind === 'effect.reconciled') this.#required.delete(`reconciliation:${event.eventId}`);
    if (event.kind === 'plan.frozen') this.#required.delete(`plan:${event.planRevision}:${event.planHash}`);
    if (event.kind === 'approval.checked') this.#required.delete(`approval:${event.approvalId}`);
    this.#events.push(event);
    return event;
  }
}
