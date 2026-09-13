import type { FastifyInstance } from 'fastify';
import { API_ROUTES, HealthViewSchema } from '../../shared/api.js';
import { sendApiError } from './auth.js';

export interface HealthOptions {
  storageReady(): boolean;
  checkpointsReady(): boolean;
  monitorReady?(): boolean;
}

export function probeReady(probe: (() => boolean) | undefined): boolean {
  try { return probe?.() === true; } catch { return false; }
}

export function registerHealthRoutes(app: FastifyInstance, options: HealthOptions): void {
  app.get(API_ROUTES.health, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!probeReady(options.storageReady) || !probeReady(options.checkpointsReady)) return sendApiError(reply, 'unavailable');
    return HealthViewSchema.parse({ schemaVersion: 2, ready: true, storage: 'ready', checkpoints: 'ready',
      monitor: probeReady(options.monitorReady) ? 'ready' : 'unavailable' });
  });
}
