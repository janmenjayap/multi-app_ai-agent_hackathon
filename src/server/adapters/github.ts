import { z } from 'zod';

import {
  AccountScopeSchema,
  CommentWriteSchema,
  GitHubCommentSchema,
  GitHubTechnicalEvidenceSchema,
  MutationOutcomeSchema,
  parseAdapterContext,
  type AccountScope,
  type GitHubAdapter as GitHubAdapterContract,
} from '../../shared/adapters.js';
import {
  CollectionReceiptSchema,
  EffectKeySchema,
  GitHubIssueUrlSchema,
  IdSchema,
  IncidentIdentitySchema,
  normalizeBody,
  type CollectionReceipt,
  type IncidentIdentity,
  type MutationOutcome,
  type ReadResult,
} from '../../shared/domain.js';
import { AdapterError, toReadFailureReason, type ReadFailureReason } from './common/errors.js';
import { paginate } from './common/pagination.js';
import type {
  BoundedRestOperation,
  BoundedRestTransport,
  TransportFailure,
  TransportSuccess,
} from './common/transport.js';

export const GITHUB_API_VERSION = '2022-11-28';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_ACCEPT = 'application/vnd.github+json';
const GITHUB_PAGE_SIZE = 100;
const PRODUCER_ID = 'github-adapter-v1';

const GitHubProviderIdSchema = z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^[0-9]+$/),
]).transform(String).pipe(IdSchema);

const GitHubLabelSchema = z.union([
  z.string(),
  z.object({ name: z.string() }).passthrough(),
]);

const GitHubRepositoryResponseSchema = z.object({
  id: GitHubProviderIdSchema,
  full_name: z.string().min(3).max(300),
}).passthrough();

const GitHubIssueResponseSchema = z.object({
  id: GitHubProviderIdSchema,
  number: z.number().int().positive(),
  html_url: GitHubIssueUrlSchema,
  repository_url: z.url(),
  title: z.string().max(10000),
  body: z.string().max(100000).nullable(),
  state: z.enum(['open', 'closed']),
  updated_at: z.iso.datetime(),
  labels: z.array(GitHubLabelSchema).max(1000),
  pull_request: z.never().optional(),
}).passthrough();

const GitHubCommentResponseSchema = z.object({
  id: GitHubProviderIdSchema,
  issue_url: z.url(),
  body: z.string().max(100000),
  updated_at: z.iso.datetime(),
  user: z.object({ id: GitHubProviderIdSchema }).passthrough(),
}).passthrough();

const GitHubCommentListResponseSchema = z.array(GitHubCommentResponseSchema).max(10000);

type GitHubIssueResponse = z.infer<typeof GitHubIssueResponseSchema>;
type GitHubCommentResponse = z.infer<typeof GitHubCommentResponseSchema>;
type GitHubComment = z.infer<typeof GitHubCommentSchema>;
type GitHubTechnicalEvidence = z.infer<typeof GitHubTechnicalEvidenceSchema>;
type CommentWrite = z.infer<typeof CommentWriteSchema>;
type ResolveContext = Parameters<GitHubAdapterContract['resolveIncident']>[1];
type TechnicalEvidenceContext = Parameters<GitHubAdapterContract['readTechnicalEvidence']>[1];
type FindCommentsContext = Parameters<GitHubAdapterContract['findComments']>[2];
type GetCommentContext = Parameters<GitHubAdapterContract['getComment']>[1];
type CreateCommentContext = Parameters<GitHubAdapterContract['createComment']>[1];
type UpdateCommentContext = Parameters<GitHubAdapterContract['updateComment']>[2];

interface ReceiptPage {
  queryId: string;
  cursor: string | null;
  nextCursor: string | null;
  recordCount: number;
  response: NonNullable<TransportSuccess<unknown>['receipt']['responseRef']>;
  providerAttemptId: string;
}

export interface GitHubAdapterOptions {
  scope: AccountScope;
  repository: string;
  token: string;
  transport: BoundedRestTransport;
}

interface RepositoryCoordinates {
  owner: string;
  name: string;
  fullName: string;
}

interface IncidentCoordinates extends RepositoryCoordinates {
  issueNumber: number;
  canonicalUrl: string;
}

interface IncidentMetadata {
  status: 'complete';
  service: string;
  environment: string;
}

interface MissingIncidentMetadata {
  status: 'incomplete';
  reason: 'missing_identity' | 'ambiguous_identity';
}

function repositoryCoordinates(value: string): RepositoryCoordinates {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match) throw new Error('invalid_github_repository');
  return { owner: match[1], name: match[2], fullName: `${match[1]}/${match[2]}` };
}

function incidentCoordinates(value: string): IncidentCoordinates {
  const parsed = GitHubIssueUrlSchema.parse(value);
  const path = new URL(parsed).pathname.split('/').filter(Boolean);
  return {
    owner: path[0],
    name: path[1],
    fullName: `${path[0]}/${path[1]}`,
    issueNumber: Number(path[3]),
    canonicalUrl: parsed,
  };
}

function apiIssueNumber(value: string, repository: RepositoryCoordinates): number {
  const url = new URL(value);
  const expectedPrefix = `/repos/${repository.owner}/${repository.name}/issues/`;
  if (url.origin !== GITHUB_API_ORIGIN || !url.pathname.toLowerCase().startsWith(expectedPrefix.toLowerCase()) || url.search || url.hash) {
    throw new AdapterError('malformed_response', { providerOutcome: 'error', isRetryable: false });
  }
  const suffix = url.pathname.slice(expectedPrefix.length);
  if (!/^[1-9][0-9]*$/.test(suffix)) {
    throw new AdapterError('malformed_response', { providerOutcome: 'error', isRetryable: false });
  }
  return Number(suffix);
}

function isRepositoryApiUrl(value: string, repository: RepositoryCoordinates): boolean {
  const url = new URL(value);
  return url.origin === GITHUB_API_ORIGIN &&
    url.pathname.toLowerCase() === `/repos/${repository.owner}/${repository.name}`.toLowerCase() &&
    !url.search && !url.hash;
}

function incidentMetadata(issue: GitHubIssueResponse): IncidentMetadata | MissingIncidentMetadata {
  const labels = issue.labels.map(label => typeof label === 'string' ? label : label.name);
  const labelValues = (prefix: string) => labels
    .filter(label => label.startsWith(prefix))
    .map(label => label.slice(prefix.length))
    .filter(value => IdSchema.safeParse(value).success);
  const bodyValues = (field: string) => [...(issue.body ?? '').matchAll(
    new RegExp(`^${field}:\\s*([a-zA-Z0-9_.:-]{1,160})\\s*$`, 'gm'),
  )].map(match => match[1]);
  const services = [...new Set([...labelValues('service:'), ...bodyValues('service_id')])];
  const environments = [...new Set([...labelValues('environment:'), ...bodyValues('environment')])];
  if (services.length === 0 || environments.length === 0) return { status: 'incomplete', reason: 'missing_identity' };
  if (services.length !== 1 || environments.length !== 1) return { status: 'incomplete', reason: 'ambiguous_identity' };
  return { status: 'complete', service: services[0], environment: environments[0] };
}

export function githubCommentMarker(effectKeyValue: string): string {
  return `<!-- promiseguard:${EffectKeySchema.parse(effectKeyValue)} -->`;
}

function parseGitHubCommentMarker(value: string): string {
  const match = /^<!-- promiseguard:([a-zA-Z0-9_.:-]{1,160}) -->$/.exec(value);
  if (!match) throw new AdapterError('invalid', { providerOutcome: 'invalid', isRetryable: false });
  return githubCommentMarker(match[1]);
}

function readHeaders(token: string): HeadersInit {
  return {
    Accept: GITHUB_ACCEPT,
    Authorization: `Bearer ${token}`,
    'User-Agent': 'PromiseGuard',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

function writeHeaders(token: string): HeadersInit {
  return { ...readHeaders(token), 'Content-Type': 'application/json' };
}

function responsePage(
  queryId: string,
  cursor: string | null,
  nextCursor: string | null,
  recordCount: number,
  result: TransportSuccess<unknown>,
): ReceiptPage {
  const response = result.receipt.responseRef;
  if (!response) {
    throw new AdapterError('receipt_persistence_failed', { providerOutcome: 'unknown', isRetryable: false });
  }
  return {
    queryId,
    cursor,
    nextCursor,
    recordCount,
    response,
    providerAttemptId: result.receipt.context.providerAttemptId,
  };
}

function collectionReceipt(
  operation: BoundedRestOperation,
  startedAt: string,
  requiredQueryIds: string[],
  pages: ReceiptPage[],
  status: 'complete' | 'incomplete',
  reason: ReadFailureReason | null,
): CollectionReceipt {
  return CollectionReceiptSchema.parse({
    schemaVersion: 2,
    collectionId: operation.context.logicalCallId,
    app: 'github',
    accountRef: operation.context.accountRef,
    producerId: PRODUCER_ID,
    startedAt,
    finishedAt: operation.currentAt(),
    status,
    reason,
    requiredQueryIds,
    pages,
  });
}

function complete<T>(
  operation: BoundedRestOperation,
  startedAt: string,
  requiredQueryIds: string[],
  pages: ReceiptPage[],
  data: T,
): ReadResult<T> {
  return {
    status: 'complete',
    data,
    receipt: collectionReceipt(operation, startedAt, requiredQueryIds, pages, 'complete', null),
  };
}

function incomplete<T>(
  operation: BoundedRestOperation,
  startedAt: string,
  requiredQueryIds: string[],
  pages: ReceiptPage[],
  reason: ReadFailureReason,
  partialData?: T,
): ReadResult<T> {
  const receipt = collectionReceipt(operation, startedAt, requiredQueryIds, pages, 'incomplete', reason);
  return partialData === undefined
    ? { status: 'incomplete', reason, receipt }
    : { status: 'incomplete', reason, partialData, receipt };
}

function nextPageCursor(link: string | null, expectedPath: string): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(part);
    if (!match || !match[2].split(/\s+/).includes('next')) continue;
    const url = new URL(match[1]);
    const page = url.searchParams.get('page');
    if (url.origin !== GITHUB_API_ORIGIN || url.pathname !== expectedPath || !page || !/^[1-9][0-9]*$/.test(page)) {
      throw new AdapterError('malformed_response', { providerOutcome: 'error', isRetryable: false });
    }
    return page;
  }
  return null;
}

function mutationOutcome(result: TransportFailure): MutationOutcome {
  if (!result.receiptRef) throw result.error;
  if (result.error.providerOutcome === 'denied' || result.error.providerOutcome === 'rate_limited' || result.error.providerOutcome === 'invalid') {
    const reason = result.error.code === 'denied'
      ? 'denied'
      : result.error.code === 'rate_limited'
        ? 'rate_limited'
        : 'malformed_response';
    return MutationOutcomeSchema.parse({ status: 'not_applied', reason, receipt: result.receiptRef });
  }
  const reason = result.error.code === 'timeout' || result.error.code === 'malformed_response'
    ? result.error.code
    : 'transport_error';
  return MutationOutcomeSchema.parse({ status: 'unknown', reason, receipt: result.receiptRef });
}

export class RestGitHubAdapter implements GitHubAdapterContract {
  readonly scope: Readonly<AccountScope>;
  readonly mode = 'rest' as const;
  private readonly repository: RepositoryCoordinates;
  private readonly token: string;
  private readonly transport: BoundedRestTransport;
  private readonly knownIncidents = new Map<string, IncidentIdentity>();

  constructor(options: GitHubAdapterOptions) {
    const scope = AccountScopeSchema.parse(options.scope);
    if (scope.app !== 'github') throw new Error('github_scope_required');
    if (options.token.trim().length === 0) throw new Error('github_token_required');
    this.scope = Object.freeze(scope);
    this.repository = repositoryCoordinates(options.repository);
    this.token = options.token;
    this.transport = options.transport;
  }

  async resolveIncident(url: string, context: ResolveContext): Promise<ReadResult<IncidentIdentity>> {
    const parsedContext = parseAdapterContext(context, this.scope, 'github.resolveIncident');
    const requested = incidentCoordinates(url);
    const operation = this.transport.begin(parsedContext);
    const startedAt = operation.currentAt();
    const requiredQueryIds = ['repository', 'incident'];
    const pages: ReceiptPage[] = [];
    if (requested.fullName.toLowerCase() !== this.repository.fullName.toLowerCase()) {
      return incomplete(operation, startedAt, requiredQueryIds, pages, 'scope_mismatch');
    }

    const repositoryResult = await operation.request({
      url: this.apiUrl(`/repos/${this.repository.owner}/${this.repository.name}`),
      method: 'GET',
      headers: readHeaders(this.token),
      decode: body => GitHubRepositoryResponseSchema.parse(body),
    });
    if (repositoryResult.status === 'failure') {
      return incomplete(operation, startedAt, requiredQueryIds, pages, toReadFailureReason(repositoryResult.error));
    }
    pages.push(responsePage('repository', null, null, 1, repositoryResult));
    if (repositoryResult.data.full_name.toLowerCase() !== this.repository.fullName.toLowerCase()) {
      return incomplete(operation, startedAt, requiredQueryIds, pages, 'scope_mismatch');
    }

    const issueResult = await operation.request({
      url: this.apiUrl(`/repos/${this.repository.owner}/${this.repository.name}/issues/${requested.issueNumber}`),
      method: 'GET',
      headers: readHeaders(this.token),
      decode: body => GitHubIssueResponseSchema.parse(body),
    });
    if (issueResult.status === 'failure') {
      return incomplete(operation, startedAt, requiredQueryIds, pages, toReadFailureReason(issueResult.error));
    }
    pages.push(responsePage('incident', null, null, 1, issueResult));
    if (!this.isExpectedIssue(issueResult.data, requested.issueNumber)) {
      return incomplete(operation, startedAt, requiredQueryIds, pages, 'scope_mismatch');
    }
    const metadata = incidentMetadata(issueResult.data);
    if (metadata.status === 'incomplete') {
      return incomplete(operation, startedAt, requiredQueryIds, pages, metadata.reason);
    }

    const incident = IncidentIdentitySchema.parse({
      schemaVersion: 2,
      repositoryId: repositoryResult.data.id,
      issueId: issueResult.data.id,
      issueNumber: issueResult.data.number,
      canonicalUrl: issueResult.data.html_url,
      service: metadata.service,
      environment: metadata.environment,
    });
    this.rememberIncident(incident);
    return complete(operation, startedAt, requiredQueryIds, pages, incident);
  }

  async readTechnicalEvidence(
    incidentValue: IncidentIdentity,
    context: TechnicalEvidenceContext,
  ): Promise<ReadResult<GitHubTechnicalEvidence>> {
    const incident = this.parseScopedIncident(incidentValue);
    const parsedContext = parseAdapterContext(context, this.scope, 'github.readTechnicalEvidence');
    const operation = this.transport.begin(parsedContext);
    const startedAt = operation.currentAt();
    const requiredQueryIds = ['incident', 'comments'];
    const pages: ReceiptPage[] = [];

    const issueResult = await operation.request({
      url: this.apiUrl(`/repos/${this.repository.owner}/${this.repository.name}/issues/${incident.issueNumber}`),
      method: 'GET',
      headers: readHeaders(this.token),
      decode: body => GitHubIssueResponseSchema.parse(body),
    });
    if (issueResult.status === 'failure') {
      return incomplete(operation, startedAt, requiredQueryIds, pages, toReadFailureReason(issueResult.error));
    }
    pages.push(responsePage('incident', null, null, 1, issueResult));
    if (!this.matchesIncident(issueResult.data, incident)) {
      return incomplete(operation, startedAt, requiredQueryIds, pages, 'scope_mismatch');
    }

    const commentsResult = await this.enumerateComments(incident, operation, 'comments');
    pages.push(...commentsResult.receipt.pages);
    const evidence = (comments: GitHubComment[]) => GitHubTechnicalEvidenceSchema.parse({
      incident,
      title: issueResult.data.title,
      body: issueResult.data.body ?? '',
      comments,
      changes: [],
    });
    this.rememberIncident(incident);
    if (commentsResult.status === 'incomplete') {
      return incomplete(
        operation,
        startedAt,
        requiredQueryIds,
        pages,
        commentsResult.reason,
        evidence(commentsResult.partialData ?? []),
      );
    }
    return complete(operation, startedAt, requiredQueryIds, pages, evidence(commentsResult.data));
  }

  async findComments(
    incidentValue: IncidentIdentity,
    markerValue: string,
    context: FindCommentsContext,
  ): Promise<ReadResult<GitHubComment[]>> {
    const incident = this.parseScopedIncident(incidentValue);
    const marker = parseGitHubCommentMarker(markerValue);
    const parsedContext = parseAdapterContext(context, this.scope, 'github.findComments');
    const operation = this.transport.begin(parsedContext);
    const result = await this.enumerateComments(incident, operation, 'comments');
    const matching = (comments: GitHubComment[]) => comments.filter(comment => comment.body.includes(marker));
    this.rememberIncident(incident);
    return result.status === 'complete'
      ? { ...result, data: matching(result.data) }
      : result.partialData
        ? { ...result, partialData: matching(result.partialData) }
        : result;
  }

  async getComment(idValue: string, context: GetCommentContext): Promise<ReadResult<GitHubComment | null>> {
    const id = GitHubProviderIdSchema.parse(idValue);
    const parsedContext = parseAdapterContext(context, this.scope, 'github.getComment');
    const operation = this.transport.begin(parsedContext);
    const startedAt = operation.currentAt();
    const pages: ReceiptPage[] = [];

    const commentResult = await operation.request({
      url: this.apiUrl(`/repos/${this.repository.owner}/${this.repository.name}/issues/comments/${id}`),
      method: 'GET',
      headers: readHeaders(this.token),
      acceptsStatus: status => status === 404 || (status >= 200 && status <= 299),
      decode: (body, response) => response.status === 404 ? null : GitHubCommentResponseSchema.parse(body),
    });
    if (commentResult.status === 'failure') {
      return incomplete(operation, startedAt, ['comment'], pages, toReadFailureReason(commentResult.error));
    }
    pages.push(responsePage('comment', null, null, commentResult.data === null ? 0 : 1, commentResult));
    if (commentResult.data === null) return complete(operation, startedAt, ['comment'], pages, null);

    let issueNumber: number;
    try {
      issueNumber = apiIssueNumber(commentResult.data.issue_url, this.repository);
    } catch {
      return incomplete(operation, startedAt, ['comment', 'comment-issue'], pages, 'scope_mismatch');
    }
    const issueResult = await operation.request({
      url: this.apiUrl(`/repos/${this.repository.owner}/${this.repository.name}/issues/${issueNumber}`),
      method: 'GET',
      headers: readHeaders(this.token),
      decode: body => GitHubIssueResponseSchema.parse(body),
    });
    if (issueResult.status === 'failure') {
      return incomplete(operation, startedAt, ['comment', 'comment-issue', 'comment-repository'], pages, toReadFailureReason(issueResult.error));
    }
    pages.push(responsePage('comment-issue', null, null, 1, issueResult));
    if (!this.isExpectedIssue(issueResult.data, issueNumber)) {
      return incomplete(operation, startedAt, ['comment', 'comment-issue', 'comment-repository'], pages, 'scope_mismatch');
    }

    const repositoryResult = await operation.request({
      url: this.apiUrl(`/repos/${this.repository.owner}/${this.repository.name}`),
      method: 'GET',
      headers: readHeaders(this.token),
      decode: body => GitHubRepositoryResponseSchema.parse(body),
    });
    if (repositoryResult.status === 'failure') {
      return incomplete(operation, startedAt, ['comment', 'comment-issue', 'comment-repository'], pages, toReadFailureReason(repositoryResult.error));
    }
    pages.push(responsePage('comment-repository', null, null, 1, repositoryResult));
    if (repositoryResult.data.full_name.toLowerCase() !== this.repository.fullName.toLowerCase()) {
      return incomplete(operation, startedAt, ['comment', 'comment-issue', 'comment-repository'], pages, 'scope_mismatch');
    }
    const comment = this.projectComment(commentResult.data, {
      repositoryId: repositoryResult.data.id,
      issueId: issueResult.data.id,
      issueNumber,
    });
    return complete(operation, startedAt, ['comment', 'comment-issue', 'comment-repository'], pages, comment);
  }

  async createComment(inputValue: CommentWrite, context: CreateCommentContext): Promise<MutationOutcome> {
    const input = this.parseCommentWrite(inputValue, context.effectKey);
    const incident = this.requireKnownIncident(input);
    const parsedContext = parseAdapterContext(context, this.scope, 'github.createComment');
    const operation = this.transport.begin(parsedContext);
    const result = await operation.request({
      url: this.apiUrl(`/repos/${this.repository.owner}/${this.repository.name}/issues/${incident.issueNumber}/comments`),
      method: 'POST',
      headers: writeHeaders(this.token),
      body: JSON.stringify({ body: input.body }),
      decode: body => GitHubCommentResponseSchema.parse(body),
    });
    if (result.status === 'failure') return mutationOutcome(result);
    this.projectComment(result.data, incident);
    return MutationOutcomeSchema.parse({ status: 'applied', providerId: result.data.id, receipt: result.receiptRef });
  }

  async updateComment(
    idValue: string,
    inputValue: CommentWrite,
    context: UpdateCommentContext,
  ): Promise<MutationOutcome> {
    const id = GitHubProviderIdSchema.parse(idValue);
    const input = this.parseCommentWrite(inputValue, context.effectKey);
    const incident = this.requireKnownIncident(input);
    const parsedContext = parseAdapterContext(context, this.scope, 'github.updateComment');
    const operation = this.transport.begin(parsedContext);
    const result = await operation.request({
      url: this.apiUrl(`/repos/${this.repository.owner}/${this.repository.name}/issues/comments/${id}`),
      method: 'PATCH',
      headers: writeHeaders(this.token),
      body: JSON.stringify({ body: input.body }),
      decode: body => GitHubCommentResponseSchema.parse(body),
    });
    if (result.status === 'failure') return mutationOutcome(result);
    if (result.data.id !== id) {
      throw new AdapterError('malformed_response', { providerOutcome: 'unknown', isRetryable: false });
    }
    this.projectComment(result.data, incident);
    return MutationOutcomeSchema.parse({ status: 'applied', providerId: result.data.id, receipt: result.receiptRef });
  }

  private async enumerateComments(
    incident: IncidentIdentity,
    operation: BoundedRestOperation,
    queryId: string,
  ): Promise<ReadResult<GitHubComment[]>> {
    const path = `/repos/${this.repository.owner}/${this.repository.name}/issues/${incident.issueNumber}/comments`;
    return paginate({
      operation,
      collectionId: operation.context.logicalCallId,
      producerId: PRODUCER_ID,
      queryId,
      fetchPage: (cursor, _pageIndex, currentOperation) => {
        const page = cursor ?? '1';
        if (!/^[1-9][0-9]*$/.test(page)) {
          throw new AdapterError('invalid', { providerOutcome: 'invalid', isRetryable: false });
        }
        const url = this.apiUrl(path);
        url.searchParams.set('per_page', String(GITHUB_PAGE_SIZE));
        url.searchParams.set('page', page);
        return currentOperation.request({
          url,
          method: 'GET',
          headers: readHeaders(this.token),
          decode: (body, response) => ({
            records: GitHubCommentListResponseSchema.parse(body)
              .map(comment => this.projectComment(comment, incident)),
            nextCursor: nextPageCursor(response.headers.get('link'), path),
          }),
        });
      },
    });
  }

  private projectComment(
    comment: GitHubCommentResponse,
    incident: Pick<IncidentIdentity, 'repositoryId' | 'issueId' | 'issueNumber'>,
  ): GitHubComment {
    if (apiIssueNumber(comment.issue_url, this.repository) !== incident.issueNumber) {
      throw new AdapterError('malformed_response', { providerOutcome: 'error', isRetryable: false });
    }
    return GitHubCommentSchema.parse({
      id: comment.id,
      repositoryId: incident.repositoryId,
      issueId: incident.issueId,
      authorId: comment.user.id,
      body: comment.body,
      updatedAt: comment.updated_at,
      version: comment.updated_at,
    });
  }

  private parseCommentWrite(inputValue: CommentWrite, marker: string): CommentWrite {
    const input = CommentWriteSchema.parse(inputValue);
    const expectedMarker = githubCommentMarker(marker);
    if (input.body !== normalizeBody(input.body) || input.body.indexOf(expectedMarker) < 0 ||
        input.body.indexOf(expectedMarker) !== input.body.lastIndexOf(expectedMarker)) {
      throw new AdapterError('invalid', { providerOutcome: 'invalid', isRetryable: false });
    }
    return input;
  }

  private requireKnownIncident(input: CommentWrite): IncidentIdentity {
    const incident = this.knownIncidents.get(this.incidentKey(input.repositoryId, input.issueId));
    if (!incident) {
      throw new AdapterError('invalid', { providerOutcome: 'invalid', isRetryable: false });
    }
    return incident;
  }

  private parseScopedIncident(value: IncidentIdentity): IncidentIdentity {
    const incident = IncidentIdentitySchema.parse(value);
    const coordinates = incidentCoordinates(incident.canonicalUrl);
    if (coordinates.fullName.toLowerCase() !== this.repository.fullName.toLowerCase() ||
        coordinates.issueNumber !== incident.issueNumber) {
      throw new AdapterError('invalid', { providerOutcome: 'invalid', isRetryable: false });
    }
    return incident;
  }

  private rememberIncident(incident: IncidentIdentity): void {
    this.knownIncidents.set(this.incidentKey(incident.repositoryId, incident.issueId), incident);
  }

  private incidentKey(repositoryId: string, issueId: string): string {
    return `${repositoryId}:${issueId}`;
  }

  private isExpectedIssue(issue: GitHubIssueResponse, issueNumber: number): boolean {
    const coordinates = incidentCoordinates(issue.html_url);
    return coordinates.fullName.toLowerCase() === this.repository.fullName.toLowerCase() &&
      coordinates.issueNumber === issueNumber &&
      issue.number === issueNumber &&
      isRepositoryApiUrl(issue.repository_url, this.repository);
  }

  private matchesIncident(issue: GitHubIssueResponse, incident: IncidentIdentity): boolean {
    return this.isExpectedIssue(issue, incident.issueNumber) &&
      issue.id === incident.issueId &&
      issue.html_url === incident.canonicalUrl;
  }

  private apiUrl(path: string): URL {
    return new URL(path, GITHUB_API_ORIGIN);
  }
}

export function createGitHubAdapter(options: GitHubAdapterOptions): GitHubAdapterContract {
  return new RestGitHubAdapter(options);
}