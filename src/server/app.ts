import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AppConfig } from './index.js';
import { ApplicationDatabase } from './storage/database.js';
import { ApplicationRepository } from './storage/repositories.js';
import { WorkflowCheckpoints } from './storage/checkpoints.js';
import { WorkflowDriver, type WorkflowDriverOptions } from './workflow/driver.js';
import { registerRunRoutes, type RunApiOptions } from './api/runs.js';
import { registerHealthRoutes } from './api/health.js';
import type { ApiAuthOptions } from './api/auth.js';

export interface WorkflowApplicationOptions {
  /** R01 supplies graph nodes, canonical incident resolution and prepared evidence. */
  workflow: Omit<WorkflowDriverOptions, 'repository' | 'checkpoints'>;
  auth: ApiAuthOptions;
  monitorReady?: () => boolean;
  readEvaluation?: RunApiOptions['readEvaluation'];
  readAssessments?: RunApiOptions['readAssessments'];
  webRoot?: string;
}

/** B04 composition seam. F01 still owns env parsing; R01 wires real providers/roles. */
export async function createWorkflowApp(config: AppConfig, options: WorkflowApplicationOptions): Promise<FastifyInstance> {
  if (options.workflow.configuration.modelMode !== config.modelMode ||
      options.workflow.configuration.providerMode !== config.adapterMode ||
      options.workflow.configuration.fixtureId !== config.fixtureId) throw new Error('workflow_configuration_mismatch');
  if (resolve(config.storage.databasePath) === resolve(config.storage.checkpointPath)) throw new Error('workflow_storage_paths_conflict');
  for (const path of [config.storage.databasePath, config.storage.checkpointPath]) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const database = new ApplicationDatabase(config.storage.databasePath);
  let checkpoints: WorkflowCheckpoints;
  try { checkpoints = new WorkflowCheckpoints(config.storage.checkpointPath, config.storage.databasePath); }
  catch (error) { database.close(); throw error; }
  const repository = new ApplicationRepository(database);
  let driver: WorkflowDriver;
  try { driver = new WorkflowDriver({ ...options.workflow, repository, checkpoints }); }
  catch (error) { checkpoints.close(); database.close(); throw error; }
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  app.addHook('onReady', async () => { await driver.start(); });
  app.addHook('preClose', async () => { await driver.stop(); });
  app.addHook('onClose', async () => {
    try { await driver.flush(); }
    finally { try { checkpoints.close(); } finally { database.close(); } }
  });
  registerRunRoutes(app, { driver, repository, auth: options.auth,
    monitorReady: options.monitorReady, readEvaluation: options.readEvaluation, readAssessments: options.readAssessments });
  registerHealthRoutes(app, { storageReady: () => driver.storageReady(), checkpointsReady: () => driver.checkpointsReady(),
    monitorReady: options.monitorReady });
  try {
    if (options.webRoot) await app.register(fastifyStatic, { root: resolve(options.webRoot), index: 'index.html' });
    await app.ready();
    return app;
  } catch (error) {
    try { await app.close(); }
    catch { throw new Error('workflow_startup_cleanup_failed'); }
    throw error;
  }
}
