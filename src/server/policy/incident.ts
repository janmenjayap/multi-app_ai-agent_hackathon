import { z } from 'zod';
import { GitHubTechnicalEvidenceSchema } from '../../shared/adapters.js';
import { IdSchema, UtcTimestampSchema, immutable } from '../../shared/domain.js';

/** Policy fields from the fixed issue template, never inferred from surrounding prose. */
const IncidentFieldsSchema = z.object({
  incidentId: IdSchema, service: IdSchema, environment: IdSchema,
  state: z.enum(['open', 'closed']), startedAt: UtcTimestampSchema, customerImpact: z.boolean(),
});

/** Compare validated UTC timestamps without losing sub-millisecond precision. */
export function compareUtcTimestamps(left: string, right: string): number {
  const seconds = Math.floor(Date.parse(left) / 1000) - Math.floor(Date.parse(right) / 1000);
  if (seconds) return Math.sign(seconds);
  const leftFraction = /\.(\d+)Z$/.exec(left)?.[1] ?? '';
  const rightFraction = /\.(\d+)Z$/.exec(right)?.[1] ?? '';
  const length = Math.max(leftFraction.length, rightFraction.length);
  const a = leftFraction.padEnd(length, '0');
  const b = rightFraction.padEnd(length, '0');
  return a < b ? -1 : a > b ? 1 : 0;
}

function hasDuplicateFields(json: string): boolean {
  const keys = new Set<string>();
  let depth = 0;
  // Tokenize strings as units so braces and escaped field names inside prose
  // cannot affect key detection. JSON syntax has already been checked below.
  for (const token of json.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/g)) {
    if (token[0] === '{' || token[0] === '[') depth++;
    else if (token[0] === '}' || token[0] === ']') depth--;
    else if (depth === 1 && /^\s*:/.test(json.slice(token.index + token[0].length))) {
      const key: string = JSON.parse(token[0]);
      if (keys.has(key)) return true;
      keys.add(key);
    }
  }
  return false;
}

/**
 * I02 must normalize current provider state into this single structured template,
 * retaining original bytes in its receipt. In particular an old body saying open
 * is not evidence that the provider issue is still open. Q01's incidentFields are
 * projected into this template by the test adapter boundary, not by the selector.
 */
export function validateIncident(input: unknown, evaluatedAt: string) {
  const evidence = GitHubTechnicalEvidenceSchema.safeParse(input);
  const clock = UtcTimestampSchema.safeParse(evaluatedAt);
  if (!evidence.success || !clock.success)
    return immutable({ schemaVersion: 2 as const, status: 'safely_blocked' as const, reason: 'incident_fields_invalid' });
  const blocks = [...evidence.data.body.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (blocks.length !== 1)
    return immutable({ schemaVersion: 2 as const, status: 'safely_blocked' as const, reason: 'incident_fields_invalid' });
  let raw: unknown;
  try { raw = JSON.parse(blocks[0][1]); } catch {
    return immutable({ schemaVersion: 2 as const, status: 'safely_blocked' as const, reason: 'incident_fields_invalid' });
  }
  if (hasDuplicateFields(blocks[0][1]))
    return immutable({ schemaVersion: 2 as const, status: 'safely_blocked' as const, reason: 'incident_fields_invalid' });
  const fields = IncidentFieldsSchema.safeParse(raw);
  if (!fields.success)
    return immutable({ schemaVersion: 2 as const, status: 'safely_blocked' as const, reason: 'incident_fields_invalid' });
  const incident = evidence.data.incident;
  const reason = fields.data.incidentId !== incident.issueId || fields.data.service !== incident.service ||
    fields.data.environment !== incident.environment ? 'incident_fields_invalid' :
    fields.data.state !== 'open' ? 'incident_closed' :
    fields.data.environment !== 'production' ? 'incident_nonproduction' :
    !fields.data.customerImpact ? 'incident_no_customer_impact' :
    compareUtcTimestamps(fields.data.startedAt, clock.data) > 0 ? 'incident_future' : null;
  if (reason) return immutable({ schemaVersion: 2 as const, status: 'safely_blocked' as const, reason });
  return immutable({ schemaVersion: 2 as const, status: 'valid' as const, reason: 'incident_valid', fields: fields.data });
}
