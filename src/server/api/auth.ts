import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorSchema, type ApiError } from '../../shared/api.js';
import { IdSchema, UtcTimestampSchema } from '../../shared/domain.js';
import { WorkflowCommandError } from '../workflow/driver.js';

/** A trusted server session resolver supplies all permissions; request bodies never do. */
export interface OperatorSession {
  operatorId: string;
  expiresAt: string;
  csrfToken: string;
  allowedRunIds: '*' | readonly string[];
  allowedRepositories: readonly string[];
  allowedEvidenceIds?: readonly string[];
  canCommand?: boolean;
}

export interface ApiAuthOptions {
  resolveSession(request: FastifyRequest): OperatorSession | null | Promise<OperatorSession | null>;
  clock?: () => number;
}

export class ApiRequestError extends Error {
  constructor(readonly code: ApiError['code']) { super(code); }
}

const statuses: Record<ApiError['code'], number> = {
  invalid_request: 400, unauthenticated: 401, forbidden: 403, not_found: 404,
  csrf_failed: 403, stale_revision: 409, conflict: 409, rate_limited: 429,
  unavailable: 503, internal_error: 500,
};

export function sendApiError(reply: FastifyReply, code: ApiError['code']) {
  const correlationId = randomUUID();
  return reply.header('cache-control', 'no-store').header('x-correlation-id', correlationId)
    .code(statuses[code]).send(ApiErrorSchema.parse({ schemaVersion: 2, code,
      retryable: ['unavailable', 'rate_limited'].includes(code), correlationId }));
}

export function registerApiErrors(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiRequestError || error instanceof WorkflowCommandError) return sendApiError(reply, error.code);
    if (error && typeof error === 'object' && 'statusCode' in error && [400, 413, 415].includes(Number(error.statusCode)))
      return sendApiError(reply, 'invalid_request');
    return sendApiError(reply, 'internal_error');
  });
  app.setNotFoundHandler((_request, reply) => sendApiError(reply, 'not_found'));
}

export async function requireOperator(request: FastifyRequest, options: ApiAuthOptions, command = false): Promise<OperatorSession> {
  const session = await options.resolveSession(request);
  const now = (options.clock ?? Date.now)();
  if (!session || !IdSchema.safeParse(session.operatorId).success ||
      !UtcTimestampSchema.safeParse(session.expiresAt).success || !Number.isFinite(now) || Date.parse(session.expiresAt) <= now)
    throw new ApiRequestError('unauthenticated');
  if (command) {
    if (session.canCommand === false) throw new ApiRequestError('forbidden');
    const token = request.headers['x-csrf-token'];
    if (typeof token !== 'string' || !session.csrfToken || token.length > 4096 || session.csrfToken.length > 4096)
      throw new ApiRequestError('csrf_failed');
    const provided = Buffer.from(token), expected = Buffer.from(session.csrfToken);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new ApiRequestError('csrf_failed');
  }
  return session;
}

export function requireIncidentAccess(session: OperatorSession, incidentUrl: string): void {
  const repository = new URL(incidentUrl).pathname.split('/').slice(1, 3).join('/').toLowerCase();
  if (!session.allowedRepositories.some(value => value.toLowerCase() === repository)) throw new ApiRequestError('forbidden');
}

export function requireRunAccess(session: OperatorSession, run: { runId: string; incident: { canonicalUrl: string } }, ownerId: string): void {
  requireIncidentAccess(session, run.incident.canonicalUrl);
  if (session.operatorId !== ownerId && session.allowedRunIds !== '*' && !session.allowedRunIds.includes(run.runId))
    throw new ApiRequestError('forbidden');
}
