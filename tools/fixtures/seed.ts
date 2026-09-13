/** Operator-only local fake seed. Run npm run build:server before the native Node 24 CLI. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface SeedFixtureOptions {
  namespace: string;
  ownerId: string;
  directory?: string;
  worldPath?: string;
  now?: () => string;
}

/** Exclusive creation refuses to overwrite any namespace, including one owned by the caller. */
export async function seedFixture(options: SeedFixtureOptions) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/.test(options.namespace)) throw new Error('invalid_fixture_namespace');
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(options.ownerId)) throw new Error('invalid_fixture_owner');
  const directory = resolve(options.directory ?? join(tmpdir(), 'promiseguard-fake-fixtures'));
  const worldPath = options.worldPath ?? fileURLToPath(new URL('../../tests/fixtures/world.json', import.meta.url));
  let contracts: typeof import('../../src/server/evaluations/manifest.js');
  let domain: typeof import('../../src/shared/domain.js');
  try {
    [contracts, domain] = await Promise.all([
      import(new URL('../../dist/server/evaluations/manifest.js', import.meta.url).href),
      import(new URL('../../dist/shared/domain.js', import.meta.url).href),
    ]);
  } catch (cause) { throw new Error('fixture_tools_require_npm_run_build_server', { cause }); }
  const world = contracts.FixtureWorldSchema.parse(JSON.parse(await readFile(worldPath, 'utf8')));
  const observedAt = options.now?.() ?? new Date().toISOString();
  domain.UtcTimestampSchema.parse(observedAt);
  const path = join(directory, `${options.namespace}.json`);
  await mkdir(dirname(path), { recursive: true });
  // A shared exclusive lock serializes seed and reset for this exact namespace only.
  const lockPath = join(directory, `${options.namespace}.lock`);
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    const seedId = randomUUID();
    const worldDigest = createHash('sha256').update(domain.canonical(world)).digest('hex');
    const setup = { action: 'seed', stage: 'setup', isScored: false, actorId: options.ownerId, observedAt };
    const document = { schemaVersion: 2, evidenceMode: 'synthetic_fixture', providerMode: 'fake',
      namespace: options.namespace, ownerId: options.ownerId, seedId, worldDigest, setup, world };
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(document, null, 2)}\n`); } finally { await file.close(); }
    return Object.freeze({ path, namespace: options.namespace, ownerId: options.ownerId, seedId, worldDigest,
      evidenceMode: 'synthetic_fixture' as const, setup: Object.freeze(setup) });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [namespace, ownerId, directory] = process.argv.slice(2);
  if (!namespace || !ownerId) throw new Error('usage: node tools/fixtures/seed.ts <namespace> <ownerId> [directory]');
  const receipt = await seedFixture({ namespace, ownerId, directory });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
