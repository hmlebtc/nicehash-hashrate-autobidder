/**
 * POST /api/datum/test (#112)
 *
 * Probes the Datum Gateway stats API at the URL the operator just
 * typed in the form. Reuses the same DatumService poll() the daemon
 * runs on every tick, so a successful test means observe() will get
 * the same data when the config is saved.
 *
 * Reports back: connections, hashrate_ph, or the error string.
 */

import type { FastifyInstance } from 'fastify';

import { DatumService } from '../../services/datum.js';

export interface DatumTestRequest {
  url?: string;
}

export interface DatumTestResponse {
  ok: boolean;
  connections?: number | null;
  hashrate_ph?: number | null;
  error?: string;
}

export async function registerDatumTestRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body?: DatumTestRequest }>(
    '/api/datum/test',
    async (req): Promise<DatumTestResponse> => {
      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      if (!url) return { ok: false, error: 'url is required' };
      try {
        // Sanity check URL syntax before handing it to the service so
        // bad inputs surface as a clean error rather than a parse-fail
        // deep inside fetch.
        new URL(url);
      } catch {
        return { ok: false, error: 'invalid URL' };
      }

      const service = new DatumService({ apiUrl: url, timeoutMs: 5_000 });
      const result = await service.poll();
      if (result.reachable) {
        return {
          ok: true,
          connections: result.connections,
          hashrate_ph: result.hashrate_ph,
        };
      }
      return { ok: false, error: result.error ?? 'unreachable' };
    },
  );
}
