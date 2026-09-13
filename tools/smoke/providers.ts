import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PROVIDERS = ['github', 'hubspot', 'slack', 'gmail'] as const;
type Provider = typeof PROVIDERS[number];
type SmokeMode = 'fake' | 'rest';

export interface ProviderSmokeManifestEntry {
  accountRef: string;
  capabilities: string[];
  credentialEnv: string[];
}

export interface ProviderSmokeManifest {
  schemaVersion: 1;
  mode: SmokeMode;
  providers: Partial<Record<Provider, ProviderSmokeManifestEntry>>;
}

export interface ProviderSmokeResult {
  provider: Provider;
  status: 'passed' | 'failed' | 'unrun';
  reason: string | null;
}

export interface ProviderSmokeCheck {
  run(input: {
    mode: SmokeMode;
    accountRef: string;
    capabilities: readonly string[];
  }): Promise<{ status: 'passed' | 'failed'; reason?: string }>;
}

export interface ProviderSmokeReport {
  schemaVersion: 1;
  mode: SmokeMode;
  results: ProviderSmokeResult[];
  counts: { passed: number; failed: number; unrun: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseEntry(provider: Provider, value: unknown): ProviderSmokeManifestEntry {
  if (!isRecord(value) || typeof value.accountRef !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(value.accountRef) ||
      !Array.isArray(value.capabilities) || value.capabilities.length === 0 ||
      value.capabilities.some(capability => typeof capability !== 'string' || !capability.startsWith(`${provider}.`)) ||
      new Set(value.capabilities).size !== value.capabilities.length ||
      !Array.isArray(value.credentialEnv) ||
      value.credentialEnv.some(name => typeof name !== 'string' || !/^PG_[A-Z0-9_]+$/.test(name)) ||
      new Set(value.credentialEnv).size !== value.credentialEnv.length) {
    throw new Error(`invalid_${provider}_smoke_manifest`);
  }
  return {
    accountRef: value.accountRef,
    capabilities: [...value.capabilities] as string[],
    credentialEnv: [...value.credentialEnv] as string[],
  };
}

export function parseProviderSmokeManifest(value: unknown): ProviderSmokeManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || (value.mode !== 'fake' && value.mode !== 'rest') ||
      !isRecord(value.providers)) {
    throw new Error('invalid_provider_smoke_manifest');
  }
  const unknownProviders = Object.keys(value.providers).filter(provider => !(PROVIDERS as readonly string[]).includes(provider));
  if (unknownProviders.length > 0 || Object.keys(value.providers).length === 0) {
    throw new Error('invalid_provider_smoke_manifest');
  }
  const providers: ProviderSmokeManifest['providers'] = {};
  for (const provider of PROVIDERS) {
    if (value.providers[provider] !== undefined) providers[provider] = parseEntry(provider, value.providers[provider]);
  }
  if (value.mode === 'rest' && Object.values(providers).some(entry => entry?.credentialEnv.length === 0)) {
    throw new Error('rest_smoke_credentials_required');
  }
  return { schemaVersion: 1, mode: value.mode, providers };
}

function safeReason(reason: string | undefined, fallback: string): string {
  return reason && /^[a-zA-Z0-9_.:-]{1,160}$/.test(reason) ? reason : fallback;
}

export async function runProviderSmokes(
  manifestValue: unknown,
  checks: Partial<Record<Provider, ProviderSmokeCheck>> = {},
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProviderSmokeReport> {
  const manifest = parseProviderSmokeManifest(manifestValue);
  const results: ProviderSmokeResult[] = [];
  for (const provider of PROVIDERS) {
    const entry = manifest.providers[provider];
    if (!entry) continue;
    const missingCredentialNames = manifest.mode === 'rest'
      ? entry.credentialEnv.filter(name => !environment[name])
      : [];
    if (missingCredentialNames.length > 0) {
      results.push({
        provider,
        status: 'unrun',
        reason: `missing_credentials:${missingCredentialNames.sort().join(',')}`,
      });
      continue;
    }
    const check = checks[provider];
    if (!check) {
      results.push({ provider, status: 'unrun', reason: 'provider_check_not_registered' });
      continue;
    }
    try {
      const result = await check.run({
        mode: manifest.mode,
        accountRef: entry.accountRef,
        capabilities: entry.capabilities,
      });
      results.push({
        provider,
        status: result.status,
        reason: result.status === 'passed' ? null : safeReason(result.reason, 'provider_check_failed'),
      });
    } catch {
      results.push({ provider, status: 'failed', reason: 'provider_check_failed' });
    }
  }
  return {
    schemaVersion: 1,
    mode: manifest.mode,
    results,
    counts: {
      passed: results.filter(result => result.status === 'passed').length,
      failed: results.filter(result => result.status === 'failed').length,
      unrun: results.filter(result => result.status === 'unrun').length,
    },
  };
}

function parseArguments(argv: string[]): { manifestPath: string; mode: SmokeMode } {
  const manifestIndex = argv.indexOf('--manifest');
  const modeIndex = argv.indexOf('--mode');
  const manifestPath = manifestIndex >= 0 ? argv[manifestIndex + 1] : undefined;
  const mode = modeIndex >= 0 ? argv[modeIndex + 1] : undefined;
  if (!manifestPath || (mode !== 'fake' && mode !== 'rest')) {
    throw new Error('usage: providers.ts --manifest <path> --mode <fake|rest>');
  }
  return { manifestPath, mode };
}

async function main(): Promise<void> {
  const { manifestPath, mode } = parseArguments(process.argv.slice(2));
  const bytes = await readFile(manifestPath);
  if (bytes.byteLength > 64 * 1024) throw new Error('provider_smoke_manifest_too_large');
  const manifest = parseProviderSmokeManifest(JSON.parse(bytes.toString('utf8')));
  if (manifest.mode !== mode) throw new Error('provider_smoke_mode_mismatch');
  const report = await runProviderSmokes(manifest);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.counts.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'provider_smoke_failed'}\n`);
    process.exitCode = 1;
  });
}