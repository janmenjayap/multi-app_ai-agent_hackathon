#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CollectPhaseInput, FinalizeEvidenceInput, createEvidenceCollector } from '../../src/server/evaluations/collector.js';

type EvidenceCollector = ReturnType<typeof createEvidenceCollector>;
type CollectedEvidence = ReturnType<EvidenceCollector['finalizeEvidence']>;

export interface CollectionRun {
  collector: EvidenceCollector;
  s0: CollectPhaseInput;
  beforeS1?: () => void | Promise<void>;
  s1: CollectPhaseInput;
  finalize: Omit<FinalizeEvidenceInput, 's0' | 's1'>;
  persist?: (evidence: CollectedEvidence) => void | Promise<void>;
}

export async function runCollection(run: CollectionRun) {
  const s0 = await run.collector.collectPhase(run.s0);
  if (s0.status !== 'complete') throw new Error(`s0_collection_incomplete:${s0.gaps.join(',')}`);
  await run.beforeS1?.();
  const s1 = await run.collector.collectPhase(run.s1);
  if (s1.status !== 'complete') throw new Error(`s1_collection_incomplete:${s1.gaps.join(',')}`);
  const evidence = run.collector.finalizeEvidence({ ...run.finalize, s0, s1 });
  await run.persist?.(evidence);
  return evidence;
}

async function main() {
  try {
    if (process.argv.length !== 3) throw new Error('usage: collect.ts <composition-module>');
    const module = await import(pathToFileURL(resolve(process.argv[2])).href) as {
      createCollectionRun?: () => CollectionRun | Promise<CollectionRun>;
    };
    if (typeof module.createCollectionRun !== 'function') throw new Error('composition_module_missing_createCollectionRun');
    const evidence = await runCollection(await module.createCollectionRun());
    const observations = evidence.outcomeEvidence.observations.map(observation => ({
      observationId: observation.observationId,
      phase: observation.phase,
      app: observation.receipt.app,
      accountRef: observation.receipt.accountRef,
      status: observation.receipt.status,
      reason: observation.receipt.reason,
      collectionId: observation.receipt.collectionId,
      startedAt: observation.receipt.startedAt,
      finishedAt: observation.receipt.finishedAt,
      pages: observation.receipt.pages.length,
    }));
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 2,
      checkerResult: evidence.checkerResult,
      checkerExportBinding: evidence.checkerExportBinding,
      observations,
    }, null, 2)}\n`);
    process.exitCode = evidence.checkerResult.result === 'passed' ? 0 : evidence.checkerResult.result === 'failed' ? 1 : 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'collection_failed'}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();