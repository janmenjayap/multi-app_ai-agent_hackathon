import { z } from 'zod';
import { AdapterModeSchema, AppSchema, CountSchema, DigestSchema, EffectKeySchema, EvaluationAttemptIdSchema,
  IdSchema, IncidentIdentitySchema, MutationOutcomeSchema, ProviderAttemptIdSchema, RestrictedArtifactRefSchema,
  RunIdSchema, RuntimeAttemptIdSchema, UtcTimestampSchema, readResultSchema } from './domain.js';
import type { IncidentIdentity, MutationOutcome, ReadResult } from './domain.js';
export { AdapterModeSchema, MutationOutcomeSchema, readResultSchema } from './domain.js';

export const READ_OPERATIONS = ['github.resolveIncident', 'github.readTechnicalEvidence', 'github.findComments', 'github.getComment',
  'hubspot.readCommitmentBundle', 'hubspot.findTasks', 'hubspot.getTask', 'hubspot.findNotes', 'hubspot.getNote',
  'gmail.listDrafts', 'gmail.findDrafts', 'gmail.getDraft', 'slack.readApprovalThread', 'slack.getMessage', 'slack.findReview', 'slack.readSummary'] as const;
export const WRITE_OPERATIONS = ['hubspot.createTask', 'hubspot.createNote', 'gmail.createDraft', 'github.createComment', 'github.updateComment'] as const;
export const COORDINATION_OPERATIONS = ['slack.postReview', 'slack.updateReview', 'slack.postSummary', 'slack.updateSummary'] as const;
export const ReadOperationSchema = z.enum(READ_OPERATIONS);
export const ProtectedOperationSchema = z.enum(WRITE_OPERATIONS);
export const CoordinationOperationSchema = z.enum(COORDINATION_OPERATIONS);
export const AdapterOperationSchema = z.enum([...READ_OPERATIONS, ...WRITE_OPERATIONS, ...COORDINATION_OPERATIONS]);
export const AccountScopeSchema = z.object({ app: AppSchema, accountRef: IdSchema }).strict();
export const TransportBudgetsSchema = z.object({ timeoutMs: CountSchema.positive().max(300000),
  totalMs: CountSchema.positive().max(900000), maxAttempts: CountSchema.positive().max(10),
  maxPages: CountSchema.positive().max(1000), maxRecords: CountSchema.positive().max(100000),
  maxResponseBytes: CountSchema.positive().max(50000000),
}).strict().refine(v => v.timeoutMs <= v.totalMs, 'timeout_exceeds_call_budget');
const context = { schemaVersion: z.literal(2), runId: RunIdSchema, evaluationAttemptId: EvaluationAttemptIdSchema,
  runtimeAttemptId: RuntimeAttemptIdSchema, spanId: IdSchema, app: AppSchema, accountRef: IdSchema,
  mode: AdapterModeSchema, logicalCallId: IdSchema, providerAttemptId: ProviderAttemptIdSchema,
  deadlineAt: UtcTimestampSchema, budgets: TransportBudgetsSchema };
function validApp(v: {app: string; operation: string}) { return v.operation.startsWith(`${v.app}.`); }
export const ReadCallContextSchema = z.object({ ...context, operation: ReadOperationSchema }).strict().refine(validApp, 'operation_app_mismatch');
export const ProtectedCallContextSchema = z.object({ ...context, operation: ProtectedOperationSchema,
  effectKey: EffectKeySchema, requestDigest: DigestSchema, planHash: DigestSchema, approvalRef: IdSchema,
}).strict().refine(validApp, 'operation_app_mismatch').refine(v => v.budgets.maxAttempts === 1, 'mutation_retry_forbidden');
export const CoordinationCallContextSchema = z.object({ ...context, operation: CoordinationOperationSchema,
  marker: EffectKeySchema, requestDigest: DigestSchema,
}).strict().refine(validApp, 'operation_app_mismatch').refine(v => v.budgets.maxAttempts === 1, 'coordination_retry_requires_reconciliation');
export const AdapterCallContextSchema = z.union([ReadCallContextSchema, ProtectedCallContextSchema, CoordinationCallContextSchema]);
/** Called by an adapter against its constructor-bound scope before dispatch. */
export function parseAdapterContext(value: unknown, scope: AccountScope, operation: AdapterOperation): AdapterCallContext {
  const parsed = AdapterCallContextSchema.parse(value);
  const bound = AccountScopeSchema.parse(scope);
  if (parsed.app !== bound.app || parsed.accountRef !== bound.accountRef || parsed.operation !== operation) throw new Error('adapter_scope_mismatch');
  return parsed;
}
export const ProviderAttemptReceiptSchema = z.object({
  schemaVersion: z.literal(2), context: AdapterCallContextSchema,
  startedAt: UtcTimestampSchema, finishedAt: UtcTimestampSchema, transport: z.enum(['fake', 'rest']),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  transportOutcome: z.enum(['response', 'timeout', 'error']),
  providerOutcome: z.enum(['success', 'denied', 'rate_limited', 'invalid', 'error', 'unknown']),
  responseRef: RestrictedArtifactRefSchema.nullable(), errorCode: IdSchema.nullable(),
}).strict().superRefine((v, ctx) => {
  if (Date.parse(v.finishedAt) < Date.parse(v.startedAt) || v.transport !== v.context.mode ||
      (v.transportOutcome !== 'response' && (v.httpStatus !== null || v.providerOutcome === 'success')))
    ctx.addIssue({ code: 'custom', message: 'invalid_provider_receipt' });
});

// Reads preserve actual fields, including bad/extra recipients, for independent comparison.
export const GitHubCommentSchema = z.object({ id: IdSchema, repositoryId: IdSchema, issueId: IdSchema,
  authorId: IdSchema, body: z.string().max(100000), updatedAt: UtcTimestampSchema, version: IdSchema }).strict();
export const GitHubTechnicalEvidenceSchema = z.object({ incident: IncidentIdentitySchema,
  title: z.string().max(10000), body: z.string().max(100000),
  comments: z.array(GitHubCommentSchema).max(10000),
  changes: z.array(z.object({ id: IdSchema, state: z.enum(['open', 'closed', 'merged']),
    title: z.string().max(10000), body: z.string().max(100000), sourceRef: RestrictedArtifactRefSchema }).strict()).max(1000),
}).strict();
export const HubSpotCommitmentBundleSchema = z.object({
  commitments: z.array(z.object({ id: IdSchema, companyIds: z.array(IdSchema).max(100),
    contactIds: z.array(IdSchema).max(100), ownerId: IdSchema.nullable(), service: z.string().nullable(),
    status: z.string().nullable(), dueAt: z.string().nullable(), promise: z.string().nullable(), version: IdSchema }).strict()).max(10000),
  companies: z.array(z.object({ id: IdSchema, name: z.string().max(10000), contactIds: z.array(IdSchema).max(100) }).strict()).max(10000),
  contacts: z.array(z.object({ id: IdSchema, email: z.string().nullable(), designated: z.boolean() }).strict()).max(10000),
  owners: z.array(z.object({ id: IdSchema, active: z.boolean() }).strict()).max(10000),
}).strict();
const associations = { companyIds: z.array(IdSchema).max(100), commitmentIds: z.array(IdSchema).max(100) };
export const HubSpotTaskSchema = z.object({ id: IdSchema, ...associations, ownerId: IdSchema.nullable(),
  dueAt: z.string().nullable(), status: z.string(), subject: z.string(), body: z.string(), version: IdSchema }).strict();
export const HubSpotNoteSchema = z.object({ id: IdSchema, ...associations, taskIds: z.array(IdSchema).max(100), body: z.string(), version: IdSchema }).strict();
export const GmailDraftSchema = z.object({ draftId: IdSchema, messageId: IdSchema, to: z.array(z.string()).max(100),
  cc: z.array(z.string()).max(100), bcc: z.array(z.string()).max(100), subject: z.string(), body: z.string(),
  isDraft: z.boolean(), rawMimeRef: RestrictedArtifactRefSchema, version: IdSchema }).strict();
export const SlackMessageSchema = z.object({ workspaceId: IdSchema, channelId: IdSchema,
  threadTs: IdSchema, messageTs: IdSchema, actorId: IdSchema, isBot: z.boolean(), subtype: IdSchema.nullable(),
  editedAt: UtcTimestampSchema.nullable(), deleted: z.boolean(), body: z.string(), observedAt: UtcTimestampSchema,
}).strict();
export const TaskWriteSchema = z.object({ companyId: IdSchema, commitmentId: IdSchema, ownerId: IdSchema,
  dueAt: UtcTimestampSchema, status: z.literal('NOT_STARTED'), subject: z.string().min(1).max(1000), body: z.string().max(50000) }).strict();
export const NoteWriteSchema = z.object({ companyId: IdSchema, commitmentId: IdSchema, taskId: IdSchema, body: z.string().max(50000) }).strict();
export const DraftWriteSchema = z.object({ to: z.email(), cc: z.array(z.email()).max(0), bcc: z.array(z.email()).max(0),
  subject: z.string().min(1).max(1000).regex(/^[^\r\n]+$/), body: z.string().max(50000), isDraft: z.literal(true) }).strict();
export const CommentWriteSchema = z.object({ repositoryId: IdSchema, issueId: IdSchema, body: z.string().max(50000) }).strict();
export const SlackWriteSchema = z.object({ channelId: IdSchema, threadTs: IdSchema.nullable(), body: z.string().min(1).max(40000) }).strict();

/** Optional mapping metadata only. It neither enables MCP nor grants approval. */
export const McpOperationBindingSchema = z.object({
  schemaVersion: z.literal(2), operation: AdapterOperationSchema, classification: z.enum(['read', 'protected_write', 'coordination']),
  serverIdentity: IdSchema, protocolVersion: IdSchema, capabilities: z.array(IdSchema).max(30),
  toolName: IdSchema, inputSchemaDigest: DigestSchema, outputSchemaDigest: DigestSchema,
  argumentMappingRef: RestrictedArtifactRefSchema, resultMappingRef: RestrictedArtifactRefSchema,
  pagination: z.enum(['none', 'cursor', 'page']), accountScope: AccountScopeSchema,
  mappingRevision: CountSchema.positive(),
  credentialRef: IdSchema, providerIdFields: z.array(IdSchema).min(1).max(20), normalizationVersion: IdSchema,
}).strict().superRefine((v, ctx) => {
  const classification = (READ_OPERATIONS as readonly string[]).includes(v.operation) ? 'read' :
    (WRITE_OPERATIONS as readonly string[]).includes(v.operation) ? 'protected_write' : 'coordination';
  if (classification !== v.classification || !v.operation.startsWith(`${v.accountScope.app}.`))
    ctx.addIssue({ code: 'custom', message: 'mcp_binding_capability_mismatch' });
});

export type AdapterMode = z.infer<typeof AdapterModeSchema>;
export type AccountScope = z.infer<typeof AccountScopeSchema>;
export type AdapterOperation = z.infer<typeof AdapterOperationSchema>;
export type AdapterCallContext = z.infer<typeof AdapterCallContextSchema>;
export type ReadCallContext = z.infer<typeof ReadCallContextSchema>;
export type ProtectedCallContext = z.infer<typeof ProtectedCallContextSchema>;
export type CoordinationCallContext = z.infer<typeof CoordinationCallContextSchema>;
type ReadContext<Op extends z.infer<typeof ReadOperationSchema>> = ReadCallContext & { operation: Op };
type WriteContext<Op extends z.infer<typeof ProtectedOperationSchema>> = ProtectedCallContext & { operation: Op };
type CoordinationContext<Op extends z.infer<typeof CoordinationOperationSchema>> = CoordinationCallContext & { operation: Op };
type RecordOf<T extends z.ZodType> = z.infer<T>;
interface ScopedAdapter { readonly scope: Readonly<AccountScope>; readonly mode: AdapterMode }
export interface GitHubReader extends ScopedAdapter {
  resolveIncident(url: string, context: ReadContext<'github.resolveIncident'>): Promise<ReadResult<IncidentIdentity>>;
  readTechnicalEvidence(incident: IncidentIdentity, context: ReadContext<'github.readTechnicalEvidence'>): Promise<ReadResult<RecordOf<typeof GitHubTechnicalEvidenceSchema>>>;
  findComments(incident: IncidentIdentity, marker: string, context: ReadContext<'github.findComments'>): Promise<ReadResult<RecordOf<typeof GitHubCommentSchema>[]>>;
  getComment(id: string, context: ReadContext<'github.getComment'>): Promise<ReadResult<RecordOf<typeof GitHubCommentSchema> | null>>;
}
export interface HubSpotReader extends ScopedAdapter {
  readCommitmentBundle(service: string, context: ReadContext<'hubspot.readCommitmentBundle'>): Promise<ReadResult<RecordOf<typeof HubSpotCommitmentBundleSchema>>>;
  findTasks(marker: string, context: ReadContext<'hubspot.findTasks'>): Promise<ReadResult<RecordOf<typeof HubSpotTaskSchema>[]>>;
  getTask(id: string, context: ReadContext<'hubspot.getTask'>): Promise<ReadResult<RecordOf<typeof HubSpotTaskSchema> | null>>;
  findNotes(marker: string, context: ReadContext<'hubspot.findNotes'>): Promise<ReadResult<RecordOf<typeof HubSpotNoteSchema>[]>>;
  getNote(id: string, context: ReadContext<'hubspot.getNote'>): Promise<ReadResult<RecordOf<typeof HubSpotNoteSchema> | null>>;
}
export interface GmailReader extends ScopedAdapter {
  listDrafts(context: ReadContext<'gmail.listDrafts'>): Promise<ReadResult<RecordOf<typeof GmailDraftSchema>[]>>;
  findDrafts(marker: string, context: ReadContext<'gmail.findDrafts'>): Promise<ReadResult<RecordOf<typeof GmailDraftSchema>[]>>;
  getDraft(id: string, context: ReadContext<'gmail.getDraft'>): Promise<ReadResult<RecordOf<typeof GmailDraftSchema> | null>>;
}
export interface SlackReader extends ScopedAdapter {
  readApprovalThread(channelId: string, threadTs: string, context: ReadContext<'slack.readApprovalThread'>): Promise<ReadResult<RecordOf<typeof SlackMessageSchema>[]>>;
  getMessage(channelId: string, messageTs: string, context: ReadContext<'slack.getMessage'>): Promise<ReadResult<RecordOf<typeof SlackMessageSchema> | null>>;
  findReview(marker: string, context: ReadContext<'slack.findReview'>): Promise<ReadResult<RecordOf<typeof SlackMessageSchema>[]>>;
  readSummary(channelId: string, messageTs: string, context: ReadContext<'slack.readSummary'>): Promise<ReadResult<RecordOf<typeof SlackMessageSchema> | null>>;
}
export interface ProtectedWrites {
  createTask(input: RecordOf<typeof TaskWriteSchema>, context: WriteContext<'hubspot.createTask'>): Promise<MutationOutcome>;
  createNote(input: RecordOf<typeof NoteWriteSchema>, context: WriteContext<'hubspot.createNote'>): Promise<MutationOutcome>;
  createDraft(input: RecordOf<typeof DraftWriteSchema>, context: WriteContext<'gmail.createDraft'>): Promise<MutationOutcome>;
  createComment(input: RecordOf<typeof CommentWriteSchema>, context: WriteContext<'github.createComment'>): Promise<MutationOutcome>;
  updateComment(id: string, input: RecordOf<typeof CommentWriteSchema>, context: WriteContext<'github.updateComment'>): Promise<MutationOutcome>;
}
export interface SlackCoordinator {
  postReview(input: RecordOf<typeof SlackWriteSchema>, context: CoordinationContext<'slack.postReview'>): Promise<MutationOutcome>;
  updateReview(messageTs: string, input: RecordOf<typeof SlackWriteSchema>, context: CoordinationContext<'slack.updateReview'>): Promise<MutationOutcome>;
  postSummary(input: RecordOf<typeof SlackWriteSchema>, context: CoordinationContext<'slack.postSummary'>): Promise<MutationOutcome>;
  updateSummary(messageTs: string, input: RecordOf<typeof SlackWriteSchema>, context: CoordinationContext<'slack.updateSummary'>): Promise<MutationOutcome>;
}
export type GitHubAdapter = GitHubReader & Pick<ProtectedWrites, 'createComment' | 'updateComment'>;
export type HubSpotAdapter = HubSpotReader & Pick<ProtectedWrites, 'createTask' | 'createNote'>;
export type GmailAdapter = GmailReader & Pick<ProtectedWrites, 'createDraft'>;
export type SlackAdapter = SlackReader & SlackCoordinator;
export type ProviderAttemptReceipt = z.infer<typeof ProviderAttemptReceiptSchema>;
export type McpOperationBinding = z.infer<typeof McpOperationBindingSchema>;
