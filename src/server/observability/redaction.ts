import { createHash } from 'node:crypto';
import { canonical, immutable, RestrictedArtifactRefSchema, type RestrictedArtifactRef } from '../../shared/domain.js';

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'credentials',
  'apikey', 'accesstoken', 'refreshtoken', 'clientsecret', 'password', 'privatekey',
  'reasoning', 'privatereasoning', 'hiddenreasoning', 'chainofthought',
]);
const SECRET_PATTERN = /(?:\bBearer\s+\S+|\bBasic\s+[A-Za-z0-9+/=]+|\bsk-[A-Za-z0-9_-]{12,}|\bxox[baprs]-[A-Za-z0-9-]+|\bgh[pousr]_[A-Za-z0-9_]{12,}|\bgithub_pat_[A-Za-z0-9_]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

/** Reject credentials before persistence; do not silently edit original evidence. */
export function assertNoSecrets(value: unknown, knownSecrets: readonly string[] = []): void {
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 100) throw new Error('invalid_restricted_artifact');
    if (typeof item === 'string') {
      if (SECRET_PATTERN.test(item) || knownSecrets.some(secret => secret.length > 0 && item.includes(secret)))
        throw new Error('secret_in_evidence');
      return;
    }
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || ancestors.has(item) ||
        (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null))
      throw new Error('invalid_restricted_artifact');
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key === 'symbol')) throw new Error('invalid_restricted_artifact');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('invalid_restricted_artifact');
    }
    if (Array.isArray(item) && (keys.length !== item.length + 1 ||
        !Array.from({ length: item.length }, (_, index) => Object.hasOwn(item, index)).every(Boolean)))
      throw new Error('invalid_restricted_artifact');
    ancestors.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (FORBIDDEN_KEYS.has(key.replace(/[^a-z]/gi, '').toLowerCase())) throw new Error('secret_in_evidence');
      visit(key, depth + 1);
      visit(child, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
}

/** Exact text bytes or canonical JSON, restricted to local evidence readers. */
export function encodeRestrictedArtifact(input: {
  artifactId: string;
  mediaType: RestrictedArtifactRef['mediaType'];
  content: unknown;
  knownSecrets?: readonly string[];
}): { ref: RestrictedArtifactRef; bytes: Buffer } {
  assertNoSecrets(input.content, input.knownSecrets);
  if (input.mediaType !== 'application/json' && typeof input.content !== 'string')
    throw new Error('invalid_restricted_artifact');
  const bytes = Buffer.from(input.mediaType === 'application/json' ? canonical(input.content) : input.content as string, 'utf8');
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error('invalid_restricted_artifact');
  const parsed = RestrictedArtifactRefSchema.safeParse({ artifactId: input.artifactId,
    sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength, mediaType: input.mediaType });
  if (!parsed.success) throw new Error('invalid_restricted_artifact');
  assertNoSecrets(parsed.data, input.knownSecrets);
  return { ref: immutable(parsed.data), bytes };
}

/** Detect corruption or a substituted reference before returning restricted bytes. */
export function verifyRestrictedArtifact(ref: RestrictedArtifactRef, bytes: Uint8Array): void {
  const parsed = RestrictedArtifactRefSchema.safeParse(ref);
  if (!parsed.success || bytes.byteLength !== parsed.data.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== parsed.data.sha256)
    throw new Error('restricted_artifact_integrity_failed');
}
