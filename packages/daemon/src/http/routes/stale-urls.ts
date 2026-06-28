/**
 * GET  /api/stale-urls           - list of active owned bids whose
 *                                  dest_url's host:port differs from the
 *                                  current `config.destination_pool_url`.
 * POST /api/stale-urls/cancel    - cancel a specific stale-URL bid by id.
 *                                  Next decision tick will create a fresh
 *                                  bid with the new URL via the existing
 *                                  CREATE_BID gate.
 *
 * Detection is deterministic and offline: no Braiins API call needed for
 * the GET. The dest_url was persisted at create time (#113 / migration
 * 0069), and Braiins's API does not allow editing dest_upstream after
 * creation, so the local value is authoritative.
 *
 * Comparison is on hostname:port only (case-insensitive on the host).
 * Anything else about the URL (scheme, path, query) is ignored - hostname
 * and port are the bits Braiins routes on, and an IP-only DDNS update
 * for the same hostname must NOT trigger the warning (miners re-resolve
 * on reconnect, the bid stays valid).
 */

import type { FastifyInstance } from 'fastify';

import { BraiinsApiError, type BraiinsClient } from '@hashrate-autopilot/braiins-client';

import type { ConfigRepo } from '../../state/repos/config.js';
import type { OwnedBidsRepo } from '../../state/repos/owned_bids.js';
import { parsePoolUrl } from '../../services/pool-health.js';

/**
 * Statuses we treat as "still consuming budget" - the URL on these
 * bids is what's actively routing miners. Everything else is terminal
 * and irrelevant for the banner.
 */
const ACTIVE_STATUSES = new Set([
  'BID_STATUS_CREATED',
  'BID_STATUS_ACTIVE',
  // Empty / null status surfaces during the brief window between
  // POST and the first observe sync. Treat as active so we don't
  // miss a freshly-created bid the operator just edited the URL on.
  null,
  '',
]);

export interface StaleUrlBid {
  readonly bid_id: string;
  readonly created_at: number;
  readonly old_host_port: string;
  readonly new_host_port: string;
  readonly amount_sat: number | null;
  readonly amount_consumed_sat: number;
  readonly unconsumed_sat: number | null;
  readonly status: string | null;
}

export interface StaleUrlsResponse {
  readonly stale: readonly StaleUrlBid[];
  readonly current_destination_pool_url: string;
  readonly current_host_port: string | null;
  readonly checked_at: number;
}

export interface StaleUrlsRouteDeps {
  readonly configRepo: ConfigRepo;
  readonly ownedBidsRepo: OwnedBidsRepo;
  readonly braiinsClient: BraiinsClient;
}

/**
 * Parse a stratum URL to a `host:port` string for comparison. Returns
 * null if the URL is unparseable (treated as "we can't compare, skip").
 * Hostname is lowercased so case differences don't trigger false alarms.
 */
function toHostPort(url: string): string | null {
  try {
    const { host, port } = parsePoolUrl(url);
    return `${host.toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}

export async function registerStaleUrlsRoute(
  app: FastifyInstance,
  deps: StaleUrlsRouteDeps,
): Promise<void> {
  app.get('/api/stale-urls', async (): Promise<StaleUrlsResponse> => {
    const cfg = await deps.configRepo.get();
    const currentUrl = cfg?.destination_pool_url ?? '';
    const currentHostPort = currentUrl ? toHostPort(currentUrl) : null;

    if (!currentHostPort) {
      return {
        stale: [],
        current_destination_pool_url: currentUrl,
        current_host_port: null,
        checked_at: Date.now(),
      };
    }

    const owned = await deps.ownedBidsRepo.list();
    const stale: StaleUrlBid[] = [];
    for (const bid of owned) {
      if (bid.abandoned) continue;
      if (!ACTIVE_STATUSES.has(bid.last_known_status)) continue;
      // Pre-migration rows have NULL dest_url; we don't know what URL
      // they were created with, so we can't say. Skip rather than
      // alarm. Natural turnover (this bid finishes, next bid carries
      // the column) handles backfill.
      if (!bid.dest_url) continue;

      const oldHostPort = toHostPort(bid.dest_url);
      if (!oldHostPort) continue;
      if (oldHostPort === currentHostPort) continue;

      const amount = bid.amount_sat;
      const consumed = bid.amount_consumed_sat;
      const unconsumed =
        amount !== null && Number.isFinite(amount) && Number.isFinite(consumed)
          ? Math.max(0, amount - consumed)
          : null;

      stale.push({
        bid_id: bid.braiins_order_id,
        created_at: bid.created_at,
        old_host_port: oldHostPort,
        new_host_port: currentHostPort,
        amount_sat: amount,
        amount_consumed_sat: consumed,
        unconsumed_sat: unconsumed,
        status: bid.last_known_status,
      });
    }

    return {
      stale,
      current_destination_pool_url: currentUrl,
      current_host_port: currentHostPort,
      checked_at: Date.now(),
    };
  });

  app.post<{ Body?: { bid_id?: string } }>(
    '/api/stale-urls/cancel',
    async (req, reply) => {
      const bidId = typeof req.body?.bid_id === 'string' ? req.body.bid_id.trim() : '';
      if (!bidId) {
        reply.status(400);
        return { ok: false, error: 'bid_id is required' };
      }

      const bid = await deps.ownedBidsRepo.findById(bidId);
      if (!bid) {
        reply.status(404);
        return { ok: false, error: 'bid not found in owned_bids' };
      }
      if (bid.abandoned || !ACTIVE_STATUSES.has(bid.last_known_status)) {
        reply.status(409);
        return { ok: false, error: `bid is not active (status=${bid.last_known_status})` };
      }

      try {
        await deps.braiinsClient.cancelBid({ order_id: bidId });
        await deps.ownedBidsRepo.markCancelled(bidId);
        return { ok: true };
      } catch (err) {
        // #295: the bid may have already been deleted at Braiins (the
        // operator cancelled it manually, or it closed). A cancel of a
        // non-existent order then fails and leaves the operator stuck.
        // Treat "order not found" as already-gone: clear the ledger row
        // so the banner and the decision loop recover. The next tick's
        // self-heal would catch this too, but handle it inline so the
        // button gives immediate, correct feedback.
        if (
          err instanceof BraiinsApiError &&
          (err.status === 404 ||
            /not.?found|does not exist|no such|already (cancel|complet)/i.test(
              err.grpcMessage ?? '',
            ))
        ) {
          await deps.ownedBidsRepo.markCancelled(bidId);
          return { ok: true, already_gone: true };
        }
        reply.status(502);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
