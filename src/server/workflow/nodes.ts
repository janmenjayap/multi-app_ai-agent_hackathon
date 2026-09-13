import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { GitHubTechnicalEvidenceSchema, HubSpotCommitmentBundleSchema,
  type GitHubReader, type HubSpotReader, type ReadCallContext } from '../../shared/adapters.js';
import { AgentInvocationContextSchema, AnalystInputSchema, AuditorInputSchema, DraftInputSchema,
  IncidentAssessmentSchema, DraftProposalSchema, AuditVerdictSchema, SourceFactSchema,
  agentCallResultSchema, roleInvocationKey, type AgentDependencies, type AgentRole,
  type ModelConfigurationSchema } from '../../shared/agents.js';
import { PlanViewSchema } from '../../shared/api.js';
import { SelectionSchema, SnapshotRefSchema, readResultSchema, type RestrictedArtifactRef,
  type Selection, type SnapshotRef } from '../../shared/domain.js';
import { digest } from '../../shared/reliability.js';
import { analyzeIncident } from '../agents/analyst/index.js';
import { ANALYST_OUTPUT_SCHEMA_VERSION, ANALYST_PROMPT_VERSION } from '../agents/analyst/prompt.js';
import { draftCustomerUpdate } from '../agents/drafter/index.js';
import { DRAFTER_OUTPUT_SCHEMA_VERSION, DRAFTER_PROMPT_VERSION } from '../agents/drafter/prompt.js';
import { validateDraftProposal } from '../agents/drafter/validate.js';
import { auditSemantics } from '../agents/auditor/index.js';
import { AUDITOR_OUTPUT_SCHEMA_VERSION, AUDITOR_PROMPT_VERSION } from '../agents/auditor/prompt.js';
import { encodeRestrictedArtifact } from '../observability/redaction.js';
import { type ApplicationRepository } from '../storage/repositories.js';
import { bindIncidentIdentity } from '../policy/identity.js';
import { verifyObservedCollection, type RefreshedSources } from '../policy/freshness.js';
import { PlanTaskContractSchema } from '../policy/claims.js';
import { freezePlan } from '../policy/plan.js';
import { SelectionInputSchema, selectCommitments, type SelectionPolicyContext } from '../policy/selection.js';
import { approvalStamp } from './review.js';
import { type WorkflowNode, type WorkflowNodeContext } from './driver.js';
import { githubCommentMarker } from '../adapters/github.js';

type SourceFact = z.infer<typeof SourceFactSchema>;
export interface WorkflowNodesOptions {
  repository: ApplicationRepository;
  sourceReaders: { github: GitHubReader; hubspot: HubSpotReader };
  createReadContext(node: WorkflowNodeContext, operation: ReadCallContext['operation']): ReadCallContext;
  selectionPolicy(node: WorkflowNodeContext): Omit<SelectionPolicyContext, 'evaluatedAt' | 'pinnedIncident'>;
  modelConfigurations: Record<AgentRole, z.infer<typeof ModelConfigurationSchema>>;
  roleDependencies(node: WorkflowNodeContext, role: AgentRole): AgentDependencies;
  slack: { channelId: string; threadTs: string };
  logicalManifestHash(node: WorkflowNodeContext): string;
  taskContract?(sources: SourceFact[], selection: Selection): z.infer<typeof PlanTaskContractSchema>;
  approval: WorkflowNode;
  execute: WorkflowNode;
  verify: WorkflowNode;
  assess: WorkflowNode;
  clock?: () => number;
}

export function readWorkflowArtifact<T>(repository: ApplicationRepository, node: WorkflowNodeContext,
  key: string, schema: z.ZodType<T>): T {
  const ref = node.state.references[key];
  if (!ref) throw new Error('workflow_artifact_missing');
  return schema.parse(JSON.parse(repository.readArtifact(ref)));
}
export function workflowSelectionPolicy(options: WorkflowNodesOptions, node: WorkflowNodeContext): SelectionPolicyContext {
  return { ...options.selectionPolicy(node), evaluatedAt: new Date((options.clock ?? Date.now)()).toISOString(),
    pinnedIncident: options.repository.getRun(node.state.runId)!.incident };
}

/** Reads run through provider observers; immutable normalized bytes are committed
 * before they can influence selection or a role. This is also B05's fresh reader. */
export async function readWorkflowSources(options: WorkflowNodesOptions, node: WorkflowNodeContext): Promise<RefreshedSources> {
  const incident = options.repository.getRun(node.state.runId)!.incident;
  node.signal.throwIfAborted();
  const githubContext = options.createReadContext(node, 'github.readTechnicalEvidence');
  const github = readResultSchema(GitHubTechnicalEvidenceSchema).parse(await options.sourceReaders.github
    .readTechnicalEvidence(incident, { ...githubContext, operation: 'github.readTechnicalEvidence' }));
  node.signal.throwIfAborted();
  const hubspotContext = options.createReadContext(node, 'hubspot.readCommitmentBundle');
  const hubspot = readResultSchema(HubSpotCommitmentBundleSchema).parse(await options.sourceReaders.hubspot
    .readCommitmentBundle(incident.service, { ...hubspotContext, operation: 'hubspot.readCommitmentBundle' }));
  node.signal.throwIfAborted();
  const checkedAt = new Date((options.clock ?? Date.now)()).toISOString();
  for (const [read, context] of [[github, githubContext], [hubspot, hubspotContext]] as const) {
    if (read.status === 'complete') verifyObservedCollection({ repository: options.repository,
      receipt: read.receipt, context, checkedAt, maxAgeMs: 300000 });
  }
  const input = node.transaction(writer => {
    const sources: SnapshotRef[] = [];
    for (const [app, read] of [['github', github], ['hubspot', hubspot]] as const) {
      if (read.status !== 'complete') continue;
      const artifact = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json', content: read.data });
      const sourceIds = app === 'github' ? [incident.issueId] : hubspot.status === 'complete'
        ? hubspot.data.commitments.map(row => row.id) : [];
      const snapshot = SnapshotRefSchema.parse({ snapshotId: randomUUID(), app, accountRef: read.receipt.accountRef,
        sourceIds: sourceIds.length ? sourceIds : [read.receipt.accountRef], capturedAt: read.receipt.finishedAt,
        relevantVersion: artifact.sha256, artifact, receipt: read.receipt });
      writer.saveSnapshot(snapshot); sources.push(snapshot);
    }
    const sourceBundleRef = writer.putArtifact({ artifactId: randomUUID(), mediaType: 'application/json',
      content: { schemaVersion: 2, sources, github, hubspot } });
    writer.appendEvent({ kind: 'sources.collected', complete: github.status === 'complete' && hubspot.status === 'complete',
      collectionRefs: [sourceBundleRef] }, approvalStamp(options.clock ?? Date.now));
    return SelectionInputSchema.parse({ schemaVersion: 2, incidentUrl: incident.canonicalUrl,
      github, hubspot, sources, sourceBundleRef });
  });
  return { input, githubContext, hubspotContext };
}

/** No CRM contact/recipient/owner authority is exposed to the analyst. */
export function projectSourceFacts(input: z.infer<typeof SelectionInputSchema>, selection?: Selection): SourceFact[] {
  if (input.github.status !== 'complete') throw new Error('source_incomplete');
  const sourceRef = input.sources.find(source => source.app === 'github')!.artifact;
  const data = input.github.data;
  const hubspotRef = input.sources.find(source => source.app === 'hubspot')?.artifact;
  const promises = input.hubspot.status === 'complete' && hubspotRef ? input.hubspot.data.commitments
    .filter(row => selection?.selected.some(selected => selected.commitmentId === row.id))
    .map(row => ({ factId: `fact-promise-${digest(row.id).slice(0, 16)}`, sourceRef: hubspotRef,
      sourceField: 'commitment.promise', text: row.promise })) : [];
  return z.array(SourceFactSchema).min(1).max(500).parse([
    { factId: 'fact-incident', sourceRef, sourceField: 'issue.body', text: data.body },
    ...data.comments.map(comment => ({ factId: `fact-comment-${digest(comment.id).slice(0, 16)}`,
      sourceRef, sourceField: 'issue.comments', text: comment.body })),
    ...data.changes.map(change => ({ factId: `fact-change-${digest(change.id).slice(0, 16)}`,
      sourceRef: change.sourceRef, sourceField: 'change.body', text: change.body })), ...promises,
  ]);
}

export function createWorkflowNodes(options: WorkflowNodesOptions): Record<string, WorkflowNode> {
  const clock = options.clock ?? Date.now;
  const read = <T>(node: WorkflowNodeContext, key: string, schema: z.ZodType<T>) =>
    readWorkflowArtifact(options.repository, node, key, schema);
  const pending = new WeakMap<WorkflowNodeContext, { artifactId: string; mediaType: 'application/json'; content: unknown }[]>();
  const stageArtifact = (node: WorkflowNodeContext, content: unknown) => {
    const artifact = { artifactId: randomUUID(), mediaType: 'application/json' as const, content };
    const writes = pending.get(node) ?? []; writes.push(artifact); pending.set(node, writes);
    return encodeRestrictedArtifact(artifact).ref;
  };
  const save = (node: WorkflowNodeContext, key: string, content: unknown) => ({
    ...node.state.references, [key]: stageArtifact(node, content),
  });
  const sourceFacts = (node: WorkflowNodeContext) => read(node, 'sourceFacts', z.array(SourceFactSchema));
  const selection = (node: WorkflowNodeContext) => read(node, 'selection', SelectionSchema);
  const taskContract = (node: WorkflowNodeContext) => PlanTaskContractSchema.parse(options.taskContract?.(sourceFacts(node), selection(node)) ?? {
    selectedCommitmentIds: selection(node).selected.map(row => row.commitmentId), requiredFacts: sourceFacts(node).filter(fact => fact.factId === 'fact-incident' || fact.sourceField === 'commitment.promise').map(fact => fact.factId),
    forbiddenClaims: ['Recovery is guaranteed', 'approval has been granted', 'email has been sent'],
  });
  const context = (node: WorkflowNodeContext, role: AgentRole, input: unknown) => {
    const configuration = options.modelConfigurations[role];
    const versions = { analyst: [ANALYST_PROMPT_VERSION, ANALYST_OUTPUT_SCHEMA_VERSION],
      drafter: [DRAFTER_PROMPT_VERSION, DRAFTER_OUTPUT_SCHEMA_VERSION], auditor: [AUDITOR_PROMPT_VERSION, AUDITOR_OUTPUT_SCHEMA_VERSION] };
    return AgentInvocationContextSchema.parse({ schemaVersion: 2, runId: node.state.runId,
      evaluationAttemptId: node.state.evaluationAttemptId, runtimeAttemptId: node.state.runtimeAttemptId,
      planRevision: 1, role, roleInvocationKey: roleInvocationKey(node.state.runId, 1, role),
      snapshotBundleRef: selection(node).sourceBundleRef, inputDigest: digest(input), promptVersion: versions[role][0],
      outputSchemaVersion: versions[role][1], modelConfigRef: configuration.modelConfigRef,
      configDigest: configuration.configDigest, budgets: configuration.budgets,
      spanId: randomUUID(), parentSpanId: node.state.spanId,
      deadlineAt: new Date(Math.min(Date.parse(node.state.deadlineAt), Date.parse(node.state.stageDeadlineAt ?? node.state.deadlineAt),
        clock() + configuration.budgets.roleBudgetMs)).toISOString() });
  };
  const draftInput = (node: WorkflowNodeContext) => {
    const analyst = read(node, 'analystResult', agentCallResultSchema(IncidentAssessmentSchema));
    if (analyst.status !== 'success') throw new Error('analyst_result_required');
    const original = read(node, 'sourceInput', SelectionInputSchema);
    if (original.hubspot.status !== 'complete') throw new Error('source_incomplete');
    const bundle = original.hubspot.data;
    return DraftInputSchema.parse({ schemaVersion: 2, sources: sourceFacts(node), assessment: analyst.output,
      commitments: selection(node).selected.map(row => ({ commitmentId: row.commitmentId,
        customerContext: bundle.companies.find(company => company.id === row.companyId)!.name,
        promise: bundle.commitments.find(commitment => commitment.id === row.commitmentId)!.promise })) });
  };
  const nodes: Record<string, WorkflowNode> = {
    ingest: async node => {
      const { input } = await readWorkflowSources(options, node);
      const references = save(node, 'sourceInput', input);
      return { kind: 'advance', nextStage: 'select', patch: { references } };
    },
    select: async node => {
      const input = read(node, 'sourceInput', SelectionInputSchema);
      const decision = selectCommitments(input, workflowSelectionPolicy(options, node));
      const references = save(node, 'selectionDecision', decision);
      const evidence = references.selectionDecision;
      const evidenceRefs = [{ referenceId: evidence.artifactId, label: 'Selection evidence', availability: 'unavailable' as const, href: null }];
      if (decision.status === 'failed' || decision.status === 'safely_blocked') return { kind: 'stop', status: decision.status,
        reason: decision.reason, patch: { references, commitments: { status: decision.status === 'failed' ? 'incomplete' : 'blocked',
          policyVersion: decision.policyVersion, selected: [], excluded: [], evidenceRefs } } };
      const selected = SelectionSchema.parse(decision.selection);
      const stored = { ...references, selection: stageArtifact(node, selected),
        sourceFacts: stageArtifact(node, decision.status === 'selected' ? projectSourceFacts(input, selected) : []) };
      return { kind: 'advance', nextStage: decision.status === 'no_affected' ? 'verify' : 'analyst', patch: {
        references: stored, commitments: { status: decision.status === 'no_affected' ? 'empty' : 'selected',
          policyVersion: decision.policyVersion, selected: selected.selected.map(row => ({
            commitmentId: row.commitmentId, company: row.companyId, reason: row.reason })),
          excluded: selected.excluded, evidenceRefs } } };
    },
    analyst: async node => {
      const input = AnalystInputSchema.parse({ schemaVersion: 2, sources: sourceFacts(node).filter(fact => fact.sourceField !== 'commitment.promise') });
      const result = await analyzeIncident(input, context(node, 'analyst', input), options.roleDependencies(node, 'analyst'));
      node.signal.throwIfAborted();
      const references = save(node, 'analystResult', result);
      return result.status === 'success' ? { kind: 'advance', nextStage: 'drafter', patch: { references } }
        : { kind: 'stop', status: 'failed', reason: result.reason, patch: { references } };
    },
    drafter: async node => {
      const input = draftInput(node);
      const result = await draftCustomerUpdate(input, context(node, 'drafter', input), options.roleDependencies(node, 'drafter'));
      node.signal.throwIfAborted();
      const references = save(node, 'drafterResult', result);
      if (result.status !== 'success') return { kind: 'stop', status: 'failed', reason: result.reason, patch: { references } };
      // This guard precedes the blind auditor and cannot be overridden by its verdict.
      try {
        validateDraftProposal(result.output, input);
        const forbidden = taskContract(node).forbiddenClaims.map(text => text.toLowerCase());
        if (result.output.entries.some(entry => forbidden.some(text => entry.text.toLowerCase().includes(text))))
          throw new Error('forbidden_claim');
      } catch {
        return { kind: 'stop', status: 'safely_blocked', reason: 'proposal_guard_failed', patch: { references } };
      }
      return { kind: 'advance', nextStage: 'auditor', patch: { references } };
    },
    auditor: async node => {
      const analyst = read(node, 'analystResult', agentCallResultSchema(IncidentAssessmentSchema));
      const drafter = read(node, 'drafterResult', agentCallResultSchema(DraftProposalSchema));
      if (drafter.status !== 'success') throw new Error('draft_result_required');
      const input = AuditorInputSchema.parse({ schemaVersion: 2, sources: sourceFacts(node), proposal: drafter.output,
        taskContract: taskContract(node) });
      const result = await auditSemantics(input, context(node, 'auditor', input), options.roleDependencies(node, 'auditor'));
      node.signal.throwIfAborted();
      const references = save(node, 'auditorResult', result);
      if (result.status !== 'success') return { kind: 'stop', status: 'failed', reason: result.reason, patch: { references } };
      if (result.output.verdict !== 'pass') return { kind: 'stop', status: 'safely_blocked', reason: 'audit_not_passed', patch: { references } };
      const original = read(node, 'sourceInput', SelectionInputSchema);
      const incident = options.repository.getRun(node.state.runId)!.incident;
      const frozen = await freezePlan({ schemaVersion: 2, runId: node.state.runId, revision: 1,
        createdAt: new Date(clock()).toISOString(), incidentFingerprint: bindIncidentIdentity(incident, incident).incidentFingerprint,
        incident, selection: selection(node), sources: original.sources, sourceFacts: sourceFacts(node), taskContract: input.taskContract,
        roleResults: { analyst, drafter, auditor: result }, logicalManifestHash: options.logicalManifestHash(node), slack: options.slack });
      const plan = frozen.plan;
      const nextReferences = { ...references, plan: stageArtifact(node, plan), planFreeze: stageArtifact(node, frozen.receipt) };
      return { kind: 'advance', nextStage: 'approval', patch: { references: nextReferences,
        plan: PlanViewSchema.parse({ revision: plan.revision, planHash: plan.planHash, effects: plan.effects, contents: plan.contents,
          orderedEffectKeys: plan.effects.map(effect => effect.effectKey), entries: plan.selection.selected.map(row => {
            const effect = plan.effects.find(effect => effect.kind === 'draft' && effect.commitmentId === row.commitmentId)!;
            if (effect.kind !== 'draft') throw new Error('draft_missing');
            return { commitmentId: row.commitmentId, companyId: row.companyId, ownerId: row.ownerId,
              recipient: row.mailbox, subject: effect.payload.subject,
              body: effect.payload.body.map(part => part.type === 'text' ? part.text : part.type === 'approved_content'
                ? plan.contents.find(content => content.contentKey === part.contentKey)!.text : '').join(''), draftOnly: true };
          }) }), effects: plan.effects.map(effect => ({ effectKey: effect.effectKey, app: effect.app, kind: effect.kind,
            state: 'planned', outcome: 'unattempted', result: null, providerId: null, providerLink: null, verifiedAt: null,
            comparison: 'pending', readbackRef: null, comparisons: [] })) }, persist: writer => {
          writer.freezePlan(plan);
          writer.appendEvent({ kind: 'plan.frozen', planRevision: plan.revision, planHash: plan.planHash,
            planRef: nextReferences.plan }, approvalStamp(clock));
        } };
    },
    approval: options.approval, execute: options.execute, verify: options.verify, assess: options.assess,
  };
  return Object.fromEntries(Object.entries(nodes).map(([stage, handler]) => [stage, async (node: WorkflowNodeContext) => {
    const result = await handler(node);
    const writes = pending.get(node) ?? []; pending.delete(node);
    if (!writes.length) return result;
    return { ...result, persist: writer => {
      for (const artifact of writes) writer.putArtifact(artifact);
      result.persist?.(writer);
    } } as Awaited<ReturnType<WorkflowNode>>;
  }]));
}

import type { CompositionServices } from '../composition.js';
import { createAnalystDependencies } from '../agents/analyst/index.js';
import { createDrafterDependencies } from '../agents/drafter/index.js';
import { createAuditorDependencies } from '../agents/auditor/index.js';
import { freezeModelConfiguration } from '../agents/runtime.js';
import { ReadCallContextSchema, type TransportBudgetsSchema } from '../../shared/adapters.js';
import { createApprovalService } from '../policy/approval.js';
import { type ApprovalPolicy } from './review.js';
import { type WorkflowDriverOptions } from './driver.js';
import { createExecutionNodes, type ExecutionNodeOptions } from './graph.js';
import { deriveEffectKey } from '../policy/effect-keys.js';
import type { AbsencePredicate } from '../verification/readback.js';

export interface WorkflowDefinitionOptions {
  prepare: WorkflowDriverOptions['prepare'];
  approvalPolicy: ApprovalPolicy;
  selectionPolicy: Omit<SelectionPolicyContext, 'evaluatedAt' | 'pinnedIncident'>;
  slack: { channelId: string; threadTs: string };
  budgets: z.infer<typeof TransportBudgetsSchema>;
  assess?: ExecutionNodeOptions['assess'];
  taskContract?: WorkflowNodesOptions['taskContract'];
  pollMs?: number;
  stageTimeoutMs?: number;
  runTimeoutMs?: number;
}

/** Single composition seam for the server and the scenario harness. */
export function createWorkflowDefinition(services: CompositionServices, options: WorkflowDefinitionOptions):
  Omit<WorkflowDriverOptions, 'repository' | 'checkpoints' | 'configuration'> {
  const { repository, clock, providers } = services;
  const configuration = { analyst: freezeModelConfiguration(services.config, 'analyst'),
    drafter: freezeModelConfiguration(services.config, 'drafter'), auditor: freezeModelConfiguration(services.config, 'auditor') };
  let nodesOptions: WorkflowNodesOptions;
  const execution = createExecutionNodes({ repository, providers, budgets: options.budgets, clock,
    withExecutionObserver: services.withExecutionObserver,
    approval: node => createApprovalService({ repository, slack: providers.adapters.slack, policy: options.approvalPolicy,
      clock, sourcePolicy: workflowSelectionPolicy(nodesOptions, node), readSources: () => readWorkflowSources(nodesOptions, node) }),
    protectedCommitments: node => {
      const input = readWorkflowArtifact(repository, node, 'sourceInput', SelectionInputSchema);
      const selection = readWorkflowArtifact(repository, node, 'selection', SelectionSchema);
      if (input.hubspot.status !== 'complete') return [];
      return input.hubspot.data.commitments.filter(row => selection.excluded.some(excluded => excluded.commitmentId === row.id));
    },
    noAffected: async (node, readback) => {
      const input = readWorkflowArtifact(repository, node, 'sourceInput', SelectionInputSchema);
      const selection = readWorkflowArtifact(repository, node, 'selection', SelectionSchema);
      const incident = repository.getRun(node.state.runId)!.incident;
      const refreshed = await readWorkflowSources(nodesOptions, node);
      const decision = selectCommitments(refreshed.input, workflowSelectionPolicy(nodesOptions, node));
      if (decision.status !== 'no_affected') throw new Error('empty_selection_changed');
      const predicates: AbsencePredicate[] = [];
      for (const [app, read, context] of [
        ['github', refreshed.input.github, refreshed.githubContext],
        ['hubspot', refreshed.input.hubspot, refreshed.hubspotContext],
      ] as const) predicates.push({ predicateId: `${app}-sources-unchanged`,
        read: async () => ({ context, result: read }),
        isAbsent: observed => digest(observed) === input.sources.find(source => source.app === app)?.artifact.sha256 });
      const fingerprint = bindIncidentIdentity(incident, incident).incidentFingerprint;
      const keys = async (app: 'github' | 'hubspot' | 'gmail' | 'slack', stableBusinessTargetId: string,
        actionType: 'task' | 'note' | 'draft' | 'comment' | 'thread') => deriveEffectKey({ incidentFingerprint: fingerprint, app, stableBusinessTargetId, actionType });
      const add = (predicateId: string, operation: ReadCallContext['operation'],
        read: (context: ReadCallContext) => Promise<unknown>) => {
        predicates.push({ predicateId, read: async () => {
          const context = readback.createContext({ operation, effectKey: null, purpose: 'scope' });
          const result = readResultSchema(z.unknown()).parse(await read(context));
          return { context, result };
        }, isAbsent: observed => Array.isArray(observed) && observed.length === 0 });
      };
      if (input.hubspot.status !== 'complete') throw new Error('source_incomplete');
      for (const commitment of input.hubspot.data.commitments) {
        const taskKey = await keys('hubspot', commitment.id, 'task');
        const noteKey = await keys('hubspot', commitment.id, 'note');
        const draftKey = await keys('gmail', commitment.id, 'draft');
        add(`absent-task-${taskKey}`, 'hubspot.findTasks', context => providers.readers.hubspot.findTasks(taskKey, { ...context, operation: 'hubspot.findTasks' }));
        add(`absent-note-${noteKey}`, 'hubspot.findNotes', context => providers.readers.hubspot.findNotes(noteKey, { ...context, operation: 'hubspot.findNotes' }));
        add(`absent-draft-${draftKey}`, 'gmail.findDrafts', context => providers.readers.gmail.findDrafts(draftKey, { ...context, operation: 'gmail.findDrafts' }));
      }
      const commentKey = await keys('github', incident.issueId, 'comment');
      const summaryKey = await keys('slack', fingerprint, 'thread');
      add('absent-impact-comment', 'github.findComments', context => providers.readers.github.findComments(incident,
        githubCommentMarker(commentKey), { ...context, operation: 'github.findComments' }));
      add('absent-slack-summary', 'slack.findReview', context => providers.readers.slack.findReview(summaryKey, { ...context, operation: 'slack.findReview' }));
      return { runId: node.state.runId, selection, selectionRef: node.state.references.selection,
        sourceReceipts: [refreshed.input.github.receipt, refreshed.input.hubspot.receipt], absencePredicates: predicates, recorder: readback.recorder };
    }, assess: options.assess,
  });
  nodesOptions = { repository, sourceReaders: providers.readers, clock,
    createReadContext: (node, operation) => {
      const app = operation.split('.')[0] as keyof typeof providers.readers;
      const reader = providers.readers[app];
      return ReadCallContextSchema.parse({ schemaVersion: 2, runId: node.state.runId,
        evaluationAttemptId: node.state.evaluationAttemptId, runtimeAttemptId: node.state.runtimeAttemptId,
        spanId: randomUUID(), app, accountRef: reader.scope.accountRef, mode: reader.mode,
        logicalCallId: randomUUID(), providerAttemptId: randomUUID(), operation,
        deadlineAt: new Date(Math.min(Date.parse(node.state.deadlineAt), clock() + options.budgets.totalMs)).toISOString(), budgets: options.budgets });
    }, selectionPolicy: () => options.selectionPolicy, modelConfigurations: configuration,
    roleDependencies: (node, role) => {
      const deps = { repository, model: services.model, configuration: configuration[role], signal: node.signal,
        clock: { now: clock, monotonicNow: services.config.modelMode === 'live' ? () => performance.now() : clock, sleep: async (ms: number, signal: AbortSignal) => {
          signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, ms)); signal.throwIfAborted();
        } } };
      return role === 'analyst' ? createAnalystDependencies(deps) : role === 'drafter'
        ? createDrafterDependencies(deps) : createAuditorDependencies(deps);
    }, slack: options.slack, logicalManifestHash: node => repository.getEvaluation(node.state.evaluationAttemptId)!.manifestHash,
    taskContract: options.taskContract, ...execution };
  return { prepare: options.prepare, nodes: createWorkflowNodes(nodesOptions), clock,
    pollMs: options.pollMs, stageTimeoutMs: options.stageTimeoutMs, runTimeoutMs: options.runTimeoutMs };
}
