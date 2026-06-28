/**
 * GET /api/ip-changes?since=<ms>&until=<ms>
 *
 * #250: returns persisted public-IP change events (old -> new) inside
 * the given viewport, chronological. The dashboard overlays a marker on
 * the hashrate / price charts at each change time so the operator can
 * line an IP rotation up against a rejection-rate spike.
 *
 * Unlike bid events, IP changes are rare and high-signal, so there is
 * no per-range suppression - we always return whatever falls inside the
 * window. A bare `since=<ms>` (no until) is also accepted; with no
 * params at all we default to the last 24 h.
 */

import type { FastifyInstance } from 'fastify';

import type { HttpServerDeps } from '../server.js';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface IpChangeEventView {
  readonly id: number;
  readonly occurred_at: number;
  readonly old_ip: string | null;
  readonly new_ip: string;
}

export async function registerIpChangesRoute(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  app.get<{ Querystring: { since?: string; until?: string } }>(
    '/api/ip-changes',
    async (req): Promise<{ events: IpChangeEventView[] }> => {
      const parsedSince = Number.parseInt(req.query.since ?? '', 10);
      const parsedUntil = Number.parseInt(req.query.until ?? '', 10);

      const hasSince = Number.isFinite(parsedSince) && parsedSince > 0;
      const hasUntil = Number.isFinite(parsedUntil) && parsedUntil > 0;

      const sinceMs = hasSince ? parsedSince : Date.now() - DEFAULT_WINDOW_MS;
      const untilMs = hasUntil && parsedUntil > sinceMs ? parsedUntil : undefined;

      const rows = await deps.ipChangeEventsRepo.listSince(Math.max(0, sinceMs), untilMs);
      return {
        events: rows.map((r) => ({
          id: r.id,
          occurred_at: r.occurred_at,
          old_ip: r.old_ip,
          new_ip: r.new_ip,
        })),
      };
    },
  );
}
