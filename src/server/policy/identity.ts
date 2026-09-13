import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, IncidentIdentitySchema, canonical, immutable, parseIncidentIdentity } from '../../shared/domain.js';
import type { IncidentIdentity } from '../../shared/domain.js';

const RepositoryNameSchema = z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/).max(100);
export const AllowedRepositorySchema = z.object({
  owner: RepositoryNameSchema, name: RepositoryNameSchema, repositoryId: IdSchema,
}).strict();
export type AllowedRepository = z.infer<typeof AllowedRepositorySchema>;

/** Parse before dispatch. Immutable issueId must subsequently come from the scoped reader. */
export function parseIncidentIdentifier(input: unknown, allowedRepositories: readonly AllowedRepository[]) {
  // Match the original bytes: URL() alone silently repairs dot segments and backslashes.
  const match = typeof input === 'string' && input.length <= 2048
    ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)$/.exec(input) : null;
  if (!match) throw new Error('incident_identifier_invalid');
  const repositories = allowedRepositories.map(repository => AllowedRepositorySchema.parse(repository));
  const matches = repositories.filter(repository => repository.owner.toLowerCase() === match[1].toLowerCase() &&
    repository.name.toLowerCase() === match[2].toLowerCase());
  if (matches.length !== 1) throw new Error('incident_repository_not_allowed');
  const issueNumber = Number(match[3]);
  if (!Number.isSafeInteger(issueNumber)) throw new Error('incident_identifier_invalid');
  const repository = matches[0];
  return immutable({ schemaVersion: 2 as const, repositoryId: repository.repositoryId, issueNumber,
    canonicalUrl: `https://github.com/${repository.owner}/${repository.name}/issues/${issueNumber}` });
}

/** Same material as B01's durable run lookup; editable fields are deliberately absent. */
export function incidentRunIdentity(input: IncidentIdentity) {
  const incident = IncidentIdentitySchema.parse(input);
  return immutable({ schemaVersion: 2 as const, repositoryId: incident.repositoryId, issueId: incident.issueId });
}

/** B03 must use the initially pinned identity across every plan revision. */
export function bindIncidentIdentity(observedInput: IncidentIdentity, pinnedInput: IncidentIdentity | null = null) {
  const observedIncident = parseIncidentIdentity(observedInput);
  const incident = pinnedInput === null ? observedIncident : parseIncidentIdentity(pinnedInput);
  const reason = incident.repositoryId !== observedIncident.repositoryId || incident.issueId !== observedIncident.issueId ||
    incident.issueNumber !== observedIncident.issueNumber ? 'incident_identity_changed' :
    incident.service !== observedIncident.service || incident.environment !== observedIncident.environment
      ? 'incident_scope_changed' : null;
  return immutable({ schemaVersion: 2 as const, incident, observedIncident, runIdentity: incidentRunIdentity(incident),
    incidentFingerprint: createHash('sha256').update(canonical(incident)).digest('hex'), reason });
}
