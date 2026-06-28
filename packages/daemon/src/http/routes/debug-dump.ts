/**
 * GET /api/debug/dump (#179)
 *
 * Single-curl diagnostics endpoint. Bundles tick_metrics, pool_blocks,
 * alerts, bid_events, reward_events, whitelisted config, and daemon
 * info into one JSON response.
 *
 * Gated behind `config.debug_api_enabled` (default OFF). Returns 404
 * when disabled so the endpoint doesn't advertise its existence.
 */

import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../../config/schema.js';
import type { AxeOSPoller } from '../../services/axeos-poller.js';
import type { AlertsRepo } from '../../state/repos/alerts.js';
import type { BidEventsRepo } from '../../state/repos/bid_events.js';
import type { BraiinsDepositsRepo } from '../../state/repos/braiins_deposits.js';
import type { ConfigRepo } from '../../state/repos/config.js';
import type { DecisionsRepo } from '../../state/repos/decisions.js';
import type { IpChangeEventsRepo } from '../../state/repos/ip_change_events.js';
import type { OwnedBidsRepo } from '../../state/repos/owned_bids.js';
import type { PoolBlocksRepo } from '../../state/repos/pool_blocks.js';
import type { RewardEventsRepo } from '../../state/repos/reward_events.js';
import type { RuntimeStateRepo } from '../../state/repos/runtime_state.js';
import type { SoloMinersRepo } from '../../state/repos/solo_miners.js';
import type { TickMetricsRepo } from '../../state/repos/tick_metrics.js';
import { BUILD } from './build.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DebugDumpDeps {
  readonly configRepo: ConfigRepo;
  readonly tickMetricsRepo: TickMetricsRepo;
  readonly poolBlocksRepo: PoolBlocksRepo;
  readonly alertsRepo: AlertsRepo;
  readonly bidEventsRepo: BidEventsRepo;
  readonly rewardEventsRepo: RewardEventsRepo;
  readonly runtimeRepo: RuntimeStateRepo;
  readonly soloMinersRepo: SoloMinersRepo;
  readonly axeOSPoller: AxeOSPoller;
  readonly ownedBidsRepo: OwnedBidsRepo;
  readonly decisionsRepo: DecisionsRepo;
  readonly ipChangeEventsRepo: IpChangeEventsRepo;
  readonly braiinsDepositsRepo: BraiinsDepositsRepo;
}

// ---------------------------------------------------------------------------
// Config whitelist - only these fields are included in the dump.
// Everything else (tokens, passwords, credentials) is omitted entirely.
// ---------------------------------------------------------------------------

const SAFE_CONFIG_FIELDS: ReadonlySet<keyof AppConfig> = new Set([
  'target_hashrate_ph',
  'minimum_floor_hashrate_ph',
  'destination_pool_url',
  'destination_pool_worker_name',
  'max_bid_sat_per_eh_day',
  'max_overpay_vs_hashprice_sat_per_eh_day',
  'overpay_sat_per_eh_day',
  'bid_budget_sat',
  'wallet_runway_alert_days',
  'below_floor_alert_after_minutes',
  'zero_hashrate_loud_alert_after_minutes',
  'pool_outage_blip_tolerance_seconds',
  'datum_unreachable_alert_after_minutes',
  'sustained_paused_alert_after_minutes',
  'api_outage_alert_after_minutes',
  'marketplace_empty_alert_after_minutes',
  'handover_window_minutes',
  'btc_payout_address',
  'electrs_host',
  'electrs_port',
  'boot_mode',
  'spent_scope',
  'btc_price_source',
  'cheap_target_hashrate_ph',
  'cheap_threshold_pct',
  'cheap_sustained_window_minutes',
  'payout_source',
  'tick_metrics_retention_days',
  'decisions_uneventful_retention_days',
  'decisions_eventful_retention_days',
  'alerts_retention_days',
  'chart_max_markers',
  'datum_api_url',
  'block_explorer_url_template',
  'block_explorer_tx_url_template',
  'braiins_hashrate_smoothing_minutes',
  'datum_hashrate_smoothing_minutes',
  'braiins_price_smoothing_minutes',
  'show_effective_rate_on_price_chart',
  'show_share_log_on_hashrate_chart',
  'block_found_sound',
  'telegram_instance_label',
  'notifications_muted',
  'notification_retry_interval_minutes',
  'notification_disabled_event_classes',
  'notify_on_pool_block_credit',
  'notify_on_braiins_deposit',
  // #226: payout-lifecycle Telegram toggles.
  'notify_on_payout_initiated',
  'notify_on_payout_confirmed',
  'notification_locale',
  // #227 follow-up: display format preferences (number separators + date layout).
  'display_number_locale',
  'display_date_layout',
  'solo_mining_enabled',
  'solo_overheating_threshold_celsius',
  'solo_zero_hashrate_alert_after_minutes',
  'solo_share_rejection_threshold_pct',
  'solo_share_rejection_window_minutes',
  'include_historical_payouts',
  'historical_payouts_offset_sat',
  'debug_api_enabled',
]);

const ALL_TABLES = [
  // Time-series (windowed by `hours`)
  'tick_metrics',
  'pool_blocks',
  'alert_events',
  'bid_events',
  'reward_events',
  'decisions',
  'ip_change_events',
  'solo_miner_samples',
  'solo_best_diff_events',
  // Lookup / state (always full snapshot)
  'app_config',
  'daemon_info',
  'solo_miners',
  'solo_miner_snapshot',
  'owned_bids',
  'braiins_deposits',
  'runtime_state',
] as const;

type TableName = (typeof ALL_TABLES)[number];

function parseTableFilter(raw: string | undefined): Set<TableName> {
  if (!raw || raw.trim() === '') return new Set(ALL_TABLES);
  const requested = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is TableName =>
      (ALL_TABLES as readonly string[]).includes(t),
    );
  return new Set(requested.length > 0 ? requested : ALL_TABLES);
}

function whitelistConfig(cfg: AppConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SAFE_CONFIG_FIELDS) {
    if (key in cfg) out[key] = cfg[key];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function registerDebugDumpRoute(
  app: FastifyInstance,
  deps: DebugDumpDeps,
): Promise<void> {
  app.get<{ Querystring: { hours?: string; tables?: string } }>(
    '/api/debug/dump',
    async (req, reply) => {
      const cfg = await deps.configRepo.get();
      if (!cfg?.debug_api_enabled) {
        return reply.code(404).send({ error: 'not found' });
      }

      const now = Date.now();
      const rawHours = parseInt(req.query.hours ?? '24', 10);
      const hours = Math.max(1, Math.min(168, Number.isFinite(rawHours) ? rawHours : 24));
      const sinceMs = now - hours * 60 * 60 * 1000;

      const tables = parseTableFilter(req.query.tables);

      const response: Record<string, unknown> = {
        generated_at: new Date(now).toISOString(),
        generated_at_ms: now,
        hours,
        tables_included: [...tables],
      };

      if (tables.has('tick_metrics')) {
        response.tick_metrics = await deps.tickMetricsRepo.listSince(sinceMs);
      }

      if (tables.has('pool_blocks')) {
        response.pool_blocks = await deps.poolBlocksRepo.listSince(sinceMs);
      }

      if (tables.has('alert_events')) {
        response.alert_events = await deps.alertsRepo.list({
          since_ms: sinceMs,
          limit: 10_000,
        });
      }

      if (tables.has('bid_events')) {
        response.bid_events = await deps.bidEventsRepo.listSince(sinceMs);
      }

      if (tables.has('reward_events')) {
        response.reward_events = await deps.rewardEventsRepo.listSince(sinceMs);
      }

      if (tables.has('app_config')) {
        response.app_config = cfg ? whitelistConfig(cfg) : null;
      }

      if (tables.has('daemon_info')) {
        const runtime = await deps.runtimeRepo.get();
        response.daemon_info = {
          build: BUILD.build,
          git_sha: BUILD.hash,
          app_version: BUILD.version,
          uptime_seconds: Math.round(process.uptime()),
          node_version: process.version,
          platform: `${process.platform}/${process.arch}`,
          run_mode: runtime?.run_mode ?? null,
          action_mode: runtime?.action_mode ?? null,
          last_tick_at: runtime?.last_tick_at ?? null,
        };
      }

      // Static state - always returns the full current snapshot, no
      // hours window. Each table here is small enough that paying the
      // full transfer is fine even at the longest `hours=168` range.

      if (tables.has('solo_miners')) {
        response.solo_miners = await deps.soloMinersRepo.list();
      }

      if (tables.has('solo_miner_snapshot')) {
        // Latest in-memory poller readings (what the Status page
        // renders). Includes `reachable`, `error`, per-device hashrate
        // / temp / stratum config - everything we'd otherwise have to
        // ask the operator to fetch via `/api/solo-miners` for a
        // solo-mining bug.
        response.solo_miner_snapshot = deps.axeOSPoller.getSnapshot();
      }

      if (tables.has('owned_bids')) {
        // Every Braiins bid the daemon currently considers ours (live
        // + cancelled + still-cached). The `chart_color_overrides`
        // blob doesn't live here so this is operationally safe to
        // dump verbatim.
        response.owned_bids = await deps.ownedBidsRepo.list();
      }

      if (tables.has('runtime_state')) {
        response.runtime_state = await deps.runtimeRepo.get();
      }

      if (tables.has('braiins_deposits')) {
        // Settle ~weekly, so the full list stays bounded even for
        // long-running installs.
        response.braiins_deposits = await deps.braiinsDepositsRepo.listAll();
      }

      // Time-series tables (windowed by `hours`).

      if (tables.has('decisions')) {
        // Controller decisions are dense (~1/min × `hours`). At
        // `hours=24` the upper bound is 1,440 rows; at the operator-
        // facing `hours=168` ceiling it's 10,080. The repo only
        // exposes `listRecent(limit)` so cap at 60×hours to stay
        // close to one-row-per-tick.
        response.decisions = await deps.decisionsRepo.listRecent(60 * hours);
      }

      if (tables.has('ip_change_events')) {
        response.ip_change_events = await deps.ipChangeEventsRepo.listSince(sinceMs);
      }

      if (tables.has('solo_miner_samples')) {
        // Per-device per-tick samples. High volume on a multi-Bitaxe
        // fleet (3 devices × 1/min × `hours` = 4,320 rows at 24h).
        // Operator opts in via the `tables=` filter when they
        // actually need the time-series, otherwise this is the most
        // expensive payload in the bundle.
        response.solo_miner_samples = await deps.soloMinersRepo.samplesSince(sinceMs);
      }

      if (tables.has('solo_best_diff_events')) {
        response.solo_best_diff_events = await deps.soloMinersRepo.bestDiffEventsSince(sinceMs);
      }

      return response;
    },
  );
}
