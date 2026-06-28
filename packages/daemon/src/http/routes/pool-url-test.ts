/**
 * POST /api/pool-url/test (#112)
 *
 * TCP-probes the host:port parsed from the pool URL the operator just
 * typed in the Config form. Mirrors the bitcoind/electrs/notifications
 * test pattern - validates UNSAVED values from the form before a save.
 *
 * Reuses the same probePool / parsePoolUrl primitives the daemon's
 * own pool-health monitor uses, so a green badge here means the same
 * thing as a healthy "Stratum up" indicator.
 */

import type { FastifyInstance } from 'fastify';

import { parsePoolUrl, probePool } from '../../services/pool-health.js';

export interface PoolUrlTestRequest {
  url?: string;
}

export interface PoolUrlTestResponse {
  ok: boolean;
  host?: string;
  port?: number;
  latency_ms?: number | null;
  error?: string;
}

export async function registerPoolUrlTestRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body?: PoolUrlTestRequest }>(
    '/api/pool-url/test',
    async (req): Promise<PoolUrlTestResponse> => {
      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      if (!url) return { ok: false, error: 'url is required' };

      let host: string;
      let port: number;
      try {
        ({ host, port } = parsePoolUrl(url));
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      const result = await probePool({ host, port, timeoutMs: 5_000 });
      if (result.reachable) {
        return { ok: true, host, port, latency_ms: result.latency_ms };
      }
      return {
        ok: false,
        host,
        port,
        error: result.error ?? 'unreachable',
      };
    },
  );
}
