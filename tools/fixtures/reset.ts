/** Operator-only cleanup of one fake namespace. Run npm run build:server before the native Node 24 CLI. */
import { createHash } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ResetFixtureOptions {
  namespace: string;
  ownerId: string;
  /** Required seed lease prevents an old cleanup request from deleting a replacement seed. */
  seedId: string;
  directory?: string;
  now?: () => string;
}

export async function resetFixture(options: ResetFixtureOptions) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/.test(options.namespace)) throw new Error('invalid_fixture_namespace');
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(options.ownerId) || !options.seedId) throw new Error('invalid_fixture_owner_or_lease');
  let contracts: typeof import('../../src/server/evaluations/manifest.js');
  let domain: typeof import('../../src/shared/domain.js');
  try {
    [contracts, domain] = await Promise.all([
      import(new URL('../../dist/server/evaluations/manifest.js', import.meta.url).href),
      import(new URL('../../dist/shared/domain.js', import.meta.url).href),
    ]);
  } catch (cause) { throw new Error('fixture_tools_require_npm_run_build_server', { cause }); }
  const directory = resolve(options.directory ?? join(tmpdir(), 'promiseguard-fake-fixtures'));
  const path = join(directory, `${options.namespace}.json`);
  const lockPath = join(directory, `${options.namespace}.lock`);
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('reset_requires_owned_regular_file');
    const seed = JSON.parse(await readFile(path, 'utf8'));
    if (seed.schemaVersion !== 2 || seed.providerMode !== 'fake' || seed.evidenceMode !== 'synthetic_fixture' ||
        seed.namespace !== options.namespace || seed.ownerId !== options.ownerId || seed.seedId !== options.seedId)
      throw new Error('fixture_namespace_ownership_mismatch');
    const world = contracts.FixtureWorldSchema.parse(seed.world);
    if (createHash('sha256').update(domain.canonical(world)).digest('hex') !== seed.worldDigest)
      throw new Error('fixture_world_digest_mismatch');
    const observedAt = options.now?.() ?? new Date().toISOString();
    domain.UtcTimestampSchema.parse(observedAt);
    await unlink(path);
    return Object.freeze({ namespace: options.namespace, seedId: options.seedId, ownerId: options.ownerId,
      action: 'reset' as const, stage: 'setup' as const, isScored: false, actorId: options.ownerId,
      observedAt, evidenceMode: 'synthetic_fixture' as const, removedPath: path });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [namespace, ownerId, seedId, directory] = process.argv.slice(2);
  if (!namespace || !ownerId || !seedId) throw new Error('usage: node tools/fixtures/reset.ts <namespace> <ownerId> <seedId> [directory]');
  const receipt = await resetFixture({ namespace, ownerId, seedId, directory });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
