import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { AgentInvocationContextSchema, ModelConfigurationSchema, parseAuditVerdict, parseDraftProposal,
  parseIncidentAssessment, parseRoleInput } from '../../src/shared/agents.js';
import type { AgentCallResult, AgentDependencies, AgentInvocationContext, AgentRole, AnalystInput,
  AuditorInput, DraftInput } from '../../src/shared/agents.js';
import { ModelAttemptIdSchema, canonical, immutable } from '../../src/shared/domain.js';
import type { RestrictedArtifactRef } from '../../src/shared/domain.js';
import { digest } from '../../src/shared/reliability.js';
import { FaultController } from '../fixtures/faults.js';
import type { FaultDirective } from '../fixtures/faults.js';

export type ScriptedModelAttempt = { output: unknown } | {
  failure: 'refusal' | 'timeout' | 'cancelled' | 'rate_limited' | 'transport_error' | 'authentication' | 'unsupported_model';
};
export interface ScriptedModelStep {
  role: AgentRole;
  /** Original and retry outputs are declared up front, independently of provider state. */
  attempts: readonly ScriptedModelAttempt[];
}
export interface FakeModelArtifact {
  ref: RestrictedArtifactRef;
  kind: 'output' | 'validation' | 'failure';
  evidenceMode: 'synthetic_fixture';
  content: unknown;
}
export interface FakeModelCall {
  role: AgentRole;
  roleInvocationKey: string;
  inputDigest: string;
  status: 'success' | 'failure';
  attemptRefs: readonly string[];
}

const configurationMaterial = {
  schemaVersion: 2 as const, modelConfigRef: 'q01-model-config-v1', mode: 'mock' as const,
  modelId: 'scripted-model-v1', budgets: {
    timeoutMs: 30000, roleBudgetMs: 90000, maxAttempts: 2, maxOutputTokens: 2000,
    maxInputChars: 24000, maxCommitments: 100,
  },
};
export const FAKE_MODEL_CONFIGURATION = immutable(ModelConfigurationSchema.parse({
  ...configurationMaterial, configDigest: digest(configurationMaterial),
}));
export const FAKE_MODEL_ROLE_ORDER = immutable(['analyst', 'drafter', 'auditor'] as const);

/** Fixed synthetic prose exercises schemas; it is neither approved content nor a human quality label. */
export const GOLDEN_MODEL_SCRIPT: readonly ScriptedModelStep[] = immutable([
  { role: 'analyst', attempts: [{ output: {
    schemaVersion: 2,
    facts: [
      { claimId: 'claim_incident', text: 'A production billing-api incident is open and affecting customers.', sourceFactIds: ['incident_billing_impact'] },
      { claimId: 'claim_commitment', text: 'Acme has an active billing migration commitment due on September 16, 2026 at 17:30 UTC.', sourceFactIds: ['acme_billing_commitment'] },
    ],
    contradictions: [], unknowns: ['The root cause, recovery time, and impact on the billing migration are not confirmed.'],
    candidateChange: { status: 'uncertain', sourceFactIds: ['candidate_deployment_only'], reason: 'The candidate deployment is a temporal association, not proof of causation.' },
  } }] },
  { role: 'drafter', attempts: [{ output: {
    schemaVersion: 2, entries: [{ commitmentId: 'promise_101',
      text: 'We are investigating a production billing-api incident affecting customers. The root cause, recovery time, and impact on your billing migration are not confirmed. Your billing migration is due on September 16, 2026 at 17:30 UTC. We propose an assigned follow-up to assess potential impact on your migration; this customer update is a draft for review.',
      claims: [
        { claimId: 'draft_incident', text: 'A production billing-api incident is affecting customers.', sourceFactIds: ['incident_billing_impact'] },
        { claimId: 'draft_unknowns', text: 'The root cause, recovery time, and migration impact are not confirmed.', sourceFactIds: ['cause_and_recovery_unknown'] },
        { claimId: 'draft_commitment', text: 'The billing migration is due on September 16, 2026 at 17:30 UTC.', sourceFactIds: ['acme_billing_commitment'] },
      ],
    }],
  } }] },
  { role: 'auditor', attempts: [{ output: {
    schemaVersion: 2, verdict: 'pass', entries: [{ commitmentId: 'promise_101',
      findings: [
        { claimId: 'draft_incident', verdict: 'supported', sourceFactIds: ['incident_billing_impact'], reason: 'The source describes customer impact from an open production incident.' },
        { claimId: 'draft_unknowns', verdict: 'supported', sourceFactIds: ['cause_and_recovery_unknown'], reason: 'The text preserves the explicit uncertainty.' },
        { claimId: 'draft_commitment', verdict: 'supported', sourceFactIds: ['acme_billing_commitment'], reason: 'The commitment and due time match the source fact.' },
      ],
      requiredFactFindings: [
        { factId: 'incident_billing_impact', verdict: 'present', reason: 'The draft names the affected service and incident.' },
        { factId: 'cause_and_recovery_unknown', verdict: 'present', reason: 'The draft states the unknown cause and recovery time.' },
        { factId: 'acme_billing_commitment', verdict: 'present', reason: 'The draft names the billing migration and its due time.' },
      ],
    }],
  } }] },
]);

function applyModelFault(attempt: ScriptedModelAttempt, fault: Readonly<FaultDirective> | undefined, role: AgentRole): ScriptedModelAttempt {
  if (!fault) return attempt;
  if (fault.kind === 'timeout') return { failure: 'timeout' };
  if (fault.kind === 'refusal') return { failure: 'refusal' };
  if (fault.kind === 'unavailable' || fault.kind === 'tool_error') return { failure: 'transport_error' };
  if (fault.kind === 'malformed_output') return { output: '{invalid JSON' };
  if (!('output' in attempt)) throw new Error('model_content_fault_requires_scripted_output');
  const output = structuredClone(attempt.output) as Record<string, unknown>;
  if (fault.kind === 'invalid_citation') {
    if (role === 'analyst') {
      output.facts = [{ claimId: 'invalid_citation', text: 'An incident exists.', sourceFactIds: ['nonexistent_source_fact'] }];
    } else if (role === 'drafter') {
      const entries = output.entries as { claims: unknown[] }[];
      entries[0].claims = [{ claimId: 'invalid_citation', text: 'An incident exists.', sourceFactIds: ['nonexistent_source_fact'] }];
    } else throw new Error('unsupported_model_fault_role');
  } else if (fault.kind === 'false_claim') {
    if (role !== 'drafter') throw new Error('unsupported_model_fault_role');
    const entries = output.entries as { text: string; claims: unknown[] }[];
    entries[0].text = 'The billing-api incident has been resolved and the migration is guaranteed on time.';
    entries[0].claims = [{ claimId: 'false_resolution', text: entries[0].text, sourceFactIds: ['incident_billing_impact'] }];
    // A real citation ID does not establish entailment. The auditor/script must judge the claim.
  } else if (fault.kind === 'auditor_false_block') {
    if (role !== 'auditor') throw new Error('unsupported_model_fault_role');
    output.verdict = 'block';
  } else if (fault.kind === 'auditor_unsupported_claim' || fault.kind === 'auditor_missing_content') {
    if (role !== 'auditor') throw new Error('unsupported_model_fault_role');
    const isFalseClaim = fault.kind === 'auditor_unsupported_claim';
    output.verdict = 'block';
    output.entries = [{ commitmentId: 'promise_101', findings: [{
      claimId: isFalseClaim ? 'false_resolution' : 'draft_incident',
      verdict: isFalseClaim ? 'unsupported' : 'supported', sourceFactIds: ['incident_billing_impact'],
      reason: isFalseClaim ? 'The source describes an open incident, not recovery or a guaranteed migration outcome.' : 'The source supports that the incident is being investigated.',
    }], requiredFactFindings: [
      { factId: 'incident_billing_impact', verdict: isFalseClaim ? 'missing' : 'present', reason: isFalseClaim ? 'The draft replaces the open incident with unsupported resolution.' : 'The draft names the billing-api incident.' },
      { factId: 'cause_and_recovery_unknown', verdict: 'missing', reason: 'The draft omits uncertainty about cause and recovery.' },
      { factId: 'acme_billing_commitment', verdict: 'missing', reason: 'The draft omits the commitment due time.' },
    ] }];
  } else if (fault.kind === 'missing_content') {
    if (role !== 'drafter') throw new Error('unsupported_model_fault_role');
    const entries = output.entries as { text: string; claims: unknown[] }[];
    entries[0].text = 'We are investigating the billing-api incident.';
    entries[0].claims = [{ claimId: 'draft_incident', text: entries[0].text, sourceFactIds: ['incident_billing_impact'] }];
  } else throw new Error('unsupported_model_fault');
  return { output };
}

/** Implements the existing F02 seam; no A01 runtime, network, provider cache, or real model is implied. */
export class FakeModel implements AgentDependencies {
  readonly mode = 'mock' as const;
  readonly evidenceMode = 'synthetic_fixture' as const;
  readonly configuration: Readonly<z.infer<typeof ModelConfigurationSchema>>;
  readonly script: readonly ScriptedModelStep[];
  private position = 0;
  private readonly records: FakeModelArtifact[] = [];
  private readonly calls: FakeModelCall[] = [];
  private readonly faults: FaultController;

  constructor(options: {
    steps?: readonly ScriptedModelStep[];
    configuration?: z.infer<typeof ModelConfigurationSchema>;
    faults?: FaultController;
  } = {}) {
    this.configuration = immutable(ModelConfigurationSchema.parse(options.configuration ?? FAKE_MODEL_CONFIGURATION));
    if (this.configuration.mode !== 'mock') throw new Error('fake_model_requires_mock_mode');
    this.script = immutable(structuredClone(options.steps ?? GOLDEN_MODEL_SCRIPT));
    if (this.script.some(step => !step.attempts.length || step.attempts.length > this.configuration.budgets.maxAttempts)) throw new Error('invalid_model_script_budget');
    this.faults = options.faults ?? new FaultController();
  }

  artifacts(): readonly Readonly<FakeModelArtifact>[] { return immutable(structuredClone(this.records)); }
  history(): readonly Readonly<FakeModelCall>[] { return immutable(structuredClone(this.calls)); }
  assertConsumed(): void { if (this.position !== this.script.length) throw new Error('model_script_not_consumed'); }

  private record(content: unknown, kind: FakeModelArtifact['kind'], key: string): RestrictedArtifactRef {
    const text = canonical(content);
    const ref: RestrictedArtifactRef = immutable({ artifactId: `fake-model-${key}-${this.records.length + 1}`,
      sha256: createHash('sha256').update(text).digest('hex'), byteLength: Buffer.byteLength(text), mediaType: 'application/json' });
    this.records.push(immutable({ ref, kind, evidenceMode: this.evidenceMode, content: structuredClone(content) }));
    return ref;
  }

  async invokeRole<T>(input: AnalystInput | DraftInput | AuditorInput, context: AgentInvocationContext,
    outputSchema: z.ZodType<T>): Promise<AgentCallResult<T>> {
    const ctx = AgentInvocationContextSchema.parse(context);
    const common = { schemaVersion: 2 as const, roleInvocationKey: ctx.roleInvocationKey,
      attemptRefs: [] as AgentCallResult<T>['attemptRefs'], firstOutputRef: null as RestrictedArtifactRef | null };
    if (ctx.modelConfigRef !== this.configuration.modelConfigRef || ctx.configDigest !== this.configuration.configDigest ||
        canonical(ctx.budgets) !== canonical(this.configuration.budgets)) {
      return immutable<AgentCallResult<T>>({ ...common, status: 'failure', reason: 'configuration_mismatch', artifactRefs: [] });
    }
    try { parseRoleInput(ctx.role, input, ctx); }
    catch { return immutable<AgentCallResult<T>>({ ...common, status: 'failure', reason: 'input_invalid', artifactRefs: [] }); }
    const step = this.script[this.position];
    if (!step) throw new Error('model_script_exhausted');
    if (step.role !== ctx.role) throw new Error('model_role_order_mismatch');
    this.position += 1;
    const key = digest({ roleInvocationKey: ctx.roleInvocationKey, call: this.position }).slice(0, 20);
    const artifactRefs: RestrictedArtifactRef[] = [];
    let reason: Extract<AgentCallResult<T>, { status: 'failure' }>['reason'] = 'output_invalid';
    // Fault repetition consumes the declared schema/transport budget without sleeping or dispatching a model.
    const maxAttempts = Math.min(ctx.budgets.maxAttempts, Math.floor(ctx.budgets.roleBudgetMs / ctx.budgets.timeoutMs));
    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      const fault = this.faults.take({ target: 'model', operation: ctx.role, phase: 'invoke' });
      const scripted = step.attempts[attemptIndex] ?? (fault ? step.attempts.at(-1)! : undefined);
      if (!scripted) break;
      common.attemptRefs.push(ModelAttemptIdSchema.parse(`fake-model-${key}-${attemptIndex + 1}`));
      const attempt = applyModelFault(scripted, fault, ctx.role);
      if ('failure' in attempt) {
        reason = attempt.failure;
        artifactRefs.push(this.record({ reason, modelMode: 'mock' }, 'failure', key));
        if (['refusal', 'cancelled', 'authentication', 'unsupported_model'].includes(reason)) break;
        continue;
      }
      const outputRef = this.record(attempt.output, 'output', key);
      artifactRefs.push(outputRef);
      common.firstOutputRef ??= outputRef;
      try {
        const output = outputSchema.parse(attempt.output);
        if (ctx.role === 'analyst') parseIncidentAssessment(output, input.sources);
        if (ctx.role === 'drafter') parseDraftProposal(output, (input as DraftInput).commitments.map(c => c.commitmentId), input.sources.map(f => f.factId));
        if (ctx.role === 'auditor') parseAuditVerdict(output, input as AuditorInput);
        const validationRef = this.record({ status: 'valid', outputRef, modelMode: 'mock', outputSchemaVersion: ctx.outputSchemaVersion }, 'validation', key);
        this.calls.push(immutable({ role: ctx.role, roleInvocationKey: ctx.roleInvocationKey, inputDigest: ctx.inputDigest,
          status: 'success', attemptRefs: [...common.attemptRefs] }));
        return immutable<AgentCallResult<T>>({ ...common, status: 'success', output, outputRef, validationRef });
      } catch {
        reason = 'output_invalid';
        artifactRefs.push(this.record({ status: 'invalid', outputRef, reason, modelMode: 'mock' }, 'validation', key));
      }
    }
    this.calls.push(immutable({ role: ctx.role, roleInvocationKey: ctx.roleInvocationKey, inputDigest: ctx.inputDigest,
      status: 'failure', attemptRefs: [...common.attemptRefs] }));
    // The shared result caps references at ten; the complete append-only artifact history remains available.
    return immutable<AgentCallResult<T>>({ ...common, status: 'failure', reason, artifactRefs: artifactRefs.slice(0, 10) });
  }
}

export function createFakeModel(options: ConstructorParameters<typeof FakeModel>[0] = {}): FakeModel { return new FakeModel(options); }
