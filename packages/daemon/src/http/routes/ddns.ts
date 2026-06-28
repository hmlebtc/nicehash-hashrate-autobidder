/**
 * GET /api/ddns - public-IP + DDNS-updater diagnostics for the
 * dashboard's Pool & Payout card.
 *
 * Surfaces three things:
 *   - daemon_public_ip   - the daemon's view of its current public
 *                          IPv4, polled every 5 min from
 *                          api.ipify.org. Operator can compare this
 *                          against what `destination_pool_url`
 *                          resolves to (next field) to spot DDNS
 *                          drift visually.
 *   - pool_url_resolves_to - DNS A-record lookup on the hostname in
 *                            destination_pool_url. Cached in this
 *                            handler since DNS is cheap and
 *                            authoritative resolvers cache anyway.
 *   - ddns               - DDNS updater service snapshot (provider,
 *                          last status, last successful push, etc).
 *
 * No mutation here. Auth-gated by the global Basic Auth hook.
 */

import { promises as dns } from 'node:dns';

import type { FastifyInstance } from 'fastify';

import type { ConfigRepo } from '../../state/repos/config.js';
import type { DdnsSnapshot, DdnsUpdaterService } from '../../services/ddns-updater.js';
import type { PublicIpService } from '../../services/public-ip.js';
import type { IpChangeEventsRepo } from '../../state/repos/ip_change_events.js';
import { parsePoolUrl } from '../../services/pool-health.js';

export interface DdnsRouteDeps {
  readonly configRepo: ConfigRepo;
  readonly publicIpService: PublicIpService;
  readonly ddnsUpdater: DdnsUpdaterService;
  readonly ipChangeEventsRepo: IpChangeEventsRepo;
}

/** #250: the most recent observed public-IP rotation, or null if none recorded. */
export interface LastIpChange {
  readonly occurred_at: number;
  readonly old_ip: string | null;
  readonly new_ip: string;
}

export interface DdnsRouteResponse {
  readonly daemon_public_ip: string | null;
  readonly daemon_public_ip_checked_at: number | null;
  readonly daemon_public_ip_error: string | null;
  readonly pool_url_hostname: string | null;
  readonly pool_url_resolves_to: string | null;
  readonly pool_url_resolve_error: string | null;
  readonly ddns: DdnsSnapshot;
  /**
   * #250: when the daemon last observed the public IP actually change.
   * Distinct from `ddns.last_pushed_at`, which sawtooths on the hourly
   * keep-alive heartbeat and is NOT an IP-change signal. Null until the
   * first rotation is recorded.
   */
  readonly last_ip_change: LastIpChange | null;
  readonly checked_at: number;
}

export async function registerDdnsRoute(
  app: FastifyInstance,
  deps: DdnsRouteDeps,
): Promise<void> {
  app.get('/api/ddns', async (): Promise<DdnsRouteResponse> => {
    const ipSnap = deps.publicIpService.getSnapshot();
    const ddns = deps.ddnsUpdater.getSnapshot();
    const cfg = await deps.configRepo.get();
    const latestChange = await deps.ipChangeEventsRepo.latest();

    let pool_url_hostname: string | null = null;
    let pool_url_resolves_to: string | null = null;
    let pool_url_resolve_error: string | null = null;

    if (cfg?.destination_pool_url) {
      try {
        const { host } = parsePoolUrl(cfg.destination_pool_url);
        pool_url_hostname = host;
        // If host is already an IP literal, dns.lookup happily echoes
        // it back - that's fine, the dashboard will render the same
        // value in both rows and the operator sees what they typed.
        const resolved = await dns.lookup(host, { family: 4 });
        pool_url_resolves_to = resolved.address;
      } catch (err) {
        pool_url_resolve_error = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      daemon_public_ip: ipSnap.ip,
      daemon_public_ip_checked_at: ipSnap.checked_at,
      daemon_public_ip_error: ipSnap.error,
      pool_url_hostname,
      pool_url_resolves_to,
      pool_url_resolve_error,
      ddns,
      last_ip_change: latestChange
        ? {
            occurred_at: latestChange.occurred_at,
            old_ip: latestChange.old_ip,
            new_ip: latestChange.new_ip,
          }
        : null,
      checked_at: Date.now(),
    };
  });
}
