import { DigestSchema, canonical, normalizeBody, sha256Text } from '../../shared/domain.js';

export const PLAN_CANONICAL_POLICY_VERSION = 'plan-canonical-v1';

export function normalizeApprovedText(text: string): string {
  return normalizeBody(text);
}

function assertCanonicalJson(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid_canonical_json');
    return;
  }
  if (typeof value !== 'object') throw new Error('invalid_canonical_json');
  if (seen.has(value)) throw new Error('cyclic_canonical_json');
  seen.add(value);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new Error('invalid_canonical_json');
  for (const child of Array.isArray(value) ? value : Object.values(value)) assertCanonicalJson(child, seen);
  seen.delete(value);
}

export async function canonicalDigest(value: unknown): Promise<string> {
  assertCanonicalJson(value, new WeakSet());
  return DigestSchema.parse(await sha256Text(canonical(value)));
}