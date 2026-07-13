/**
 * HTTP API for the NiceHash daemon - the backend the dashboard binds to.
 *
 * Minimal Fastify surface that exposes the latest control-loop tick (from the
 * in-memory {@link NiceHashStateStore}) plus the owned-order ledger, and lets
 * the dashboard flip the run mode. Deliberately small and self-contained; the
 * full Braiins HTTP server is not reused.
 *
 * Routes:
 *   GET  /api/health                 - liveness + build number
 *   GET  /api/nicehash/status        - latest observed state + proposals/outcomes
 *   GET  /api/nicehash/orders        - owned-order ledger rows
 *   GET  /api/nicehash/history.csv   - order-mutation audit trail as CSV (Export button)
 *   GET  /api/nicehash/logs.csv      - decision + error log as CSV (Export button)
 *   POST /api/nicehash/run-mode      - { mode: DRY_RUN | LIVE | PAUSED }
 */

import fastifyCors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import { createNiceHashClient, NiceHashApiError } from '@hashrate-autopilot/nicehash-client';
import type { OrderBookEntry, OrderBookResponse } from '@hashrate-autopilot/nicehash-client';

import { NICEHASH_DASHBOARD_HTML } from './nicehash-dashboard-html.js';
import {
  formatHoldReason,
  formatRemaining,
  type HoldReason,
} from '../controller/nicehash/explain.js';
import {
  maskSettings,
  mergeSettings,
  settingsFromEnv,
  type NiceHashSettings,
} from '../controller/nicehash/settings.js';
import type { NiceHashStateStore } from '../controller/nicehash/state-store.js';
import type { NiceHashControllerConfig, Proposal, RunMode } from '../controller/nicehash/types.js';
import type { NiceHashTickResult, TickOutcome } from '../controller/nicehash/tick.js';
import type { NiceHashOrdersRepo } from '../state/repos/nicehash_orders.js';
import type { NiceHashSettingsRepo } from '../state/repos/nicehash_settings.js';
import type { NiceHashMetricsRepo } from '../state/repos/nicehash_tick_metrics.js';
import type { NiceHashEventsRepo } from '../state/repos/nicehash_order_events.js';
import type { NiceHashDecisionLogRepo } from '../state/repos/nicehash_decision_log.js';
import { probePool } from '../services/pool-health.js';
import { HashpriceOracle } from '../services/nicehash-hashprice.js';

export interface NiceHashHttpDeps {
  readonly store: NiceHashStateStore;
  readonly ledger: NiceHashOrdersRepo;
  readonly settingsRepo: NiceHashSettingsRepo;
  /** Controller config, or a getter resolved per request (live config edits). */
  readonly config: NiceHashControllerConfig | (() => NiceHashControllerConfig);
  readonly buildNumber: number;
  /**
   * Seconds between ticks - surfaced so the UI can show the next-tick countdown.
   * A getter is resolved per request so a live "Tick seconds" edit is reflected
   * in the countdown without a restart (the loop already re-reads it each cycle).
   */
  readonly tickSeconds: number | (() => number);
  /** Time-series + history sinks (charts, tiles, P&L, History page). */
  readonly metrics?: NiceHashMetricsRepo;
  readonly events?: NiceHashEventsRepo;
  readonly decisionLog?: NiceHashDecisionLogRepo;
  /** Latest network-hashprice estimate (BTC/EH/day), or null. */
  readonly hashprice?: () => number | null;
  /** Trigger an out-of-band controller tick (the "Run decision now" button). */
  readonly runNow?: () => Promise<{ ok: boolean; error?: string }>;
}

const RUN_MODES: readonly RunMode[] = ['DRY_RUN', 'LIVE', 'PAUSED'];

/**
 * Chart/summary time-range windows. Note `m` means MINUTES here (1m..30m) and the
 * month window is `30d` - this avoids the old `1m` ambiguity now that sub-minute
 * tick rates make short windows useful.
 */
const RANGE_MS: Record<string, number> = {
  '30s': 30_000,
  '1m': 60_000,
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 3600_000,
  '3h': 3 * 3600_000,
  '6h': 6 * 3600_000,
  '12h': 12 * 3600_000,
  '24h': 24 * 3600_000,
  '1w': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
  '1y': 365 * 24 * 3600_000,
  all: Infinity,
};

function sinceForRange(range: string): number {
  const ms = RANGE_MS[range] ?? RANGE_MS['24h']!;
  return ms === Infinity ? 0 : Date.now() - ms;
}

/** Stride-downsample so a chart never receives more than ~maxPoints rows. */
function downsample<T>(rows: readonly T[], maxPoints = 1500): T[] {
  if (rows.length <= maxPoints) return [...rows];
  const stride = Math.ceil(rows.length / maxPoints);
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += stride) out.push(rows[i]!);
  const last = rows[rows.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** Shared numeric query-param coercion: blank/missing/non-finite -> undefined. */
function numParam(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Clamp a requested CSV export row count into `[1, max]`, defaulting to `def`. */
function clampCsvLimit(v: number | undefined, def: number, max: number): number {
  const n = v !== undefined && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(Math.max(n, 1), max);
}

/**
 * RFC 4180 field escaping for CSV export: any field containing a comma,
 * double-quote, CR or LF is wrapped in quotes with inner quotes doubled.
 * `null`/`undefined` become an empty field.
 */
function csvField(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** One CRLF-terminated CSV row from raw field values - the one shared helper
 *  both CSV export routes (`logs.csv`, `history.csv`) build rows with. */
function toCsvRow(fields: readonly unknown[]): string {
  return fields.map(csvField).join(',') + '\r\n';
}

/** UTC `YYYYMMDD-HHmmss` stamp used in CSV export filenames. */
function csvFilenameStamp(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-` +
    `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`
  );
}

/** Prepended to every CSV export body so Excel detects UTF-8 correctly. */
const CSV_BOM = '\uFEFF';

function proposalView(p: Proposal): { kind: string; reason: string } {
  return { kind: p.kind, reason: p.reason };
}

function outcomeView(
  o: TickOutcome,
  hold: HoldReason | null,
  nowMs: number,
): { kind: string; outcome: string; detail: string } {
  let detail =
    o.outcome === 'BLOCKED'
      ? o.reason
      : o.outcome === 'FAILED'
        ? o.error
        : 'note' in o
          ? (o.note ?? '')
          : '';
  // A gate-held edit carries a live countdown instead of the bare reason
  // code - computed per request so the dashboard's poll sees it tick.
  if (o.outcome === 'BLOCKED' && hold?.until != null) {
    if (o.reason === 'PRICE_DECREASE_COOLDOWN' && hold.kind === 'DECREASE_COOLDOWN') {
      detail = `waiting on NiceHash decrease cooldown, ~${formatRemaining(hold.until, nowMs)} remaining`;
    } else if (o.reason === 'EDIT_SETTLE' && hold.kind === 'EDIT_SETTLE_WAIT') {
      detail = `waiting on NiceHash change settle, ~${formatRemaining(hold.until, nowMs)} remaining`;
    }
  }
  return { kind: o.proposal.kind, outcome: o.outcome, detail };
}

function statusView(result: NiceHashTickResult | null, deps: NiceHashHttpDeps): unknown {
  const cfg = typeof deps.config === 'function' ? deps.config() : deps.config;
  const tickSeconds = typeof deps.tickSeconds === 'function' ? deps.tickSeconds() : deps.tickSeconds;
  const configView = {
    algorithm: cfg.algorithm,
    market: cfg.market,
    pool_id: cfg.pool_id,
    speed_unit: cfg.speed_display_unit ?? 'PH',
    target_speed_units: cfg.target_speed_units,
    overpay_btc_per_unit_day: cfg.overpay_btc_per_unit_day,
    max_price_btc_per_unit_day: cfg.max_price_btc_per_unit_day,
    refill_amount_btc: cfg.refill_amount_btc,
    refill_when_runway_hours: cfg.refill_when_runway_hours,
    nicehash_fee_pct: cfg.nicehash_fee_pct ?? 0,
    pool_fee_pct: cfg.pool_fee_pct ?? 0,
    dynamic_cap_enabled: cfg.dynamic_cap_enabled ?? false,
    dynamic_cap_buffer_btc: cfg.dynamic_cap_buffer_btc ?? 0,
  };
  if (!result) {
    return {
      run_mode: deps.store.getRunMode(),
      tick_at: null,
      tick_seconds: tickSeconds,
      build: deps.buildNumber,
      config: configView,
      market: null,
      balance_btc: null,
      owned_orders: [],
      unknown_orders: [],
      proposals: [],
      outcomes: [],
      next_action: null,
    };
  }
  const s = result.state;
  const nowMs = Date.now();
  const hold = result.hold_reason ?? null;
  return {
    run_mode: s.run_mode,
    tick_at: s.tick_at,
    tick_seconds: tickSeconds,
    build: deps.buildNumber,
    config: configView,
    // Only the fields the dashboard needs: the marginal (purple) + the next
    // filled tier (cyan, `filled_prices[1]` - the bottom of the contiguously
    // miner-bearing top of the book; null when the fill reaches the marginal)
    // for the tiles and chart; the rest of the ladder is omitted.
    market: s.market
      ? {
          anchor_price_btc: s.market.anchor_price_btc,
          next_filled_price_btc: s.market.filled_prices?.[1] ?? null,
          total_speed_units: s.market.total_speed_units,
          thin: s.market.thin,
        }
      : null,
    balance_btc: s.balance_btc,
    hashprice_btc_per_unit_day: s.hashprice_btc_per_unit_day,
    owned_orders: s.owned_orders,
    unknown_orders: s.unknown_orders,
    market_error: s.market_error ?? null,
    orders_error: s.orders_error ?? null,
    proposals: result.proposals.map(proposalView),
    outcomes: result.outcomes.map((o) => outcomeView(o, hold, nowMs)),
    // Why the bot is holding / what it's waiting on, with the countdown
    // rendered against THIS request's clock (live between the 3s polls).
    next_action: formatHoldReason(hold, nowMs),
  };
}

export async function createNiceHashHttpServer(deps: NiceHashHttpDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });

  app.get('/', async (_req, reply) => {
    reply.type('text/html').send(NICEHASH_DASHBOARD_HTML);
  });

  app.get('/api/health', async () => ({ ok: true, build: deps.buildNumber }));

  app.get('/api/nicehash/status', async () => statusView(deps.store.getLast(), deps));

  app.get('/api/nicehash/orders', async () => {
    const rows = await deps.ledger.list();
    return { orders: rows };
  });

  // Time series for the hashrate + price charts.
  app.get('/api/nicehash/metrics', async (req) => {
    const range = String((req.query as { range?: unknown })?.range ?? '24h');
    if (!deps.metrics) return { range, rows: [] };
    const rows = await deps.metrics.range(sinceForRange(range));
    return { range, rows: downsample(rows) };
  });

  // Order-mutation audit trail (History page), with optional filters.
  app.get('/api/nicehash/history', async (req) => {
    if (!deps.events) return { events: [] };
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const actions = q.action
      ? q.action.split(',').map((a) => a.trim().toUpperCase()).filter(Boolean)
      : undefined;
    const events = await deps.events.list({
      ...(actions && actions.length > 0 ? { actions } : {}),
      ...(q.order ? { orderIdContains: q.order } : {}),
      ...(numParam(q.since) !== undefined ? { sinceMs: numParam(q.since)! } : {}),
      ...(numParam(q.until) !== undefined ? { untilMs: numParam(q.until)! } : {}),
      ...(numParam(q.minDelta) !== undefined ? { minAbsDeltaPrice: numParam(q.minDelta)! } : {}),
      ...(numParam(q.limit) !== undefined ? { limit: numParam(q.limit)! } : {}),
      ...(numParam(q.offset) !== undefined ? { offset: numParam(q.offset)! } : {}),
    });
    return { events };
  });

  // CSV export of the order-mutation audit trail (History tab "Export CSV"),
  // same filters as /api/nicehash/history but with a much bigger row cap
  // (up to 10000, default 5000) for offline troubleshooting.
  app.get('/api/nicehash/history.csv', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const actions = q.action
      ? q.action.split(',').map((a) => a.trim().toUpperCase()).filter(Boolean)
      : undefined;
    const limit = clampCsvLimit(numParam(q.limit), 5000, 10000);
    const events = deps.events
      ? await deps.events.list(
          {
            ...(actions && actions.length > 0 ? { actions } : {}),
            ...(q.order ? { orderIdContains: q.order } : {}),
            ...(numParam(q.since) !== undefined ? { sinceMs: numParam(q.since)! } : {}),
            ...(numParam(q.until) !== undefined ? { untilMs: numParam(q.until)! } : {}),
            ...(numParam(q.minDelta) !== undefined ? { minAbsDeltaPrice: numParam(q.minDelta)! } : {}),
            limit,
            ...(numParam(q.offset) !== undefined ? { offset: numParam(q.offset)! } : {}),
          },
          10000,
        )
      : [];
    let csv = CSV_BOM + toCsvRow([
      'when_iso', 'when_ms', 'order_id', 'action', 'outcome',
      'price_before_btc', 'price_after_btc', 'delta_btc', 'amount_btc', 'reason',
    ]);
    for (const e of events) {
      const delta = e.price_before !== null && e.price_after !== null ? e.price_after - e.price_before : '';
      csv += toCsvRow([
        new Date(e.ts).toISOString(), e.ts, e.order_id ?? '', e.action, e.outcome,
        e.price_before ?? '', e.price_after ?? '', delta, e.amount_btc ?? '', e.reason ?? '',
      ]);
    }
    const filename = `nicehash-order-history-${csvFilenameStamp(new Date())}.csv`;
    reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(csv);
  });

  // Decision + error log (Logs page), with optional level filter.
  app.get('/api/nicehash/logs', async (req) => {
    if (!deps.decisionLog) return { logs: [] };
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const levels = q.level
      ? q.level.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean)
      : undefined;
    const logs = await deps.decisionLog.list({
      ...(levels && levels.length > 0 ? { levels } : {}),
      ...(numParam(q.since) !== undefined ? { sinceMs: numParam(q.since)! } : {}),
      ...(numParam(q.limit) !== undefined ? { limit: numParam(q.limit)! } : {}),
      ...(numParam(q.offset) !== undefined ? { offset: numParam(q.offset)! } : {}),
    });
    return { logs };
  });

  // CSV export of the decision + error log (Logs tab "Export CSV"), same
  // filters as /api/nicehash/logs but with a much bigger row cap (up to
  // 10000, default 5000) for offline troubleshooting.
  app.get('/api/nicehash/logs.csv', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const levels = q.level
      ? q.level.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean)
      : undefined;
    const limit = clampCsvLimit(numParam(q.limit), 5000, 10000);
    const logs = deps.decisionLog
      ? await deps.decisionLog.list(
          {
            ...(levels && levels.length > 0 ? { levels } : {}),
            ...(numParam(q.since) !== undefined ? { sinceMs: numParam(q.since)! } : {}),
            limit,
            ...(numParam(q.offset) !== undefined ? { offset: numParam(q.offset)! } : {}),
          },
          10000,
        )
      : [];
    let csv = CSV_BOM + toCsvRow(['when_iso', 'when_ms', 'level', 'mode', 'summary', 'detail']);
    for (const row of logs) {
      csv += toCsvRow([
        new Date(row.ts).toISOString(), row.ts, row.level, row.run_mode ?? '', row.message, row.detail ?? '',
      ]);
    }
    const filename = `nicehash-decision-log-${csvFilenameStamp(new Date())}.csv`;
    reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(csv);
  });

  // Summary tiles + profit & loss for a window.
  app.get('/api/nicehash/summary', async (req) => {
    const range = String((req.query as { range?: unknown })?.range ?? '24h');
    const since = sinceForRange(range);
    const [summary, current, lifetimeSpentBtc] = await Promise.all([
      deps.metrics?.summary(since) ?? Promise.resolve(null),
      deps.metrics?.latest() ?? Promise.resolve(null),
      deps.ledger.sumLifetimePayedBtc(),
    ]);
    return {
      range,
      since,
      summary,
      current,
      lifetime_spent_btc: lifetimeSpentBtc,
      hashprice_now: deps.hashprice?.() ?? null,
      run_mode: deps.store.getRunMode(),
    };
  });

  // "Run decision now" - trigger one out-of-band controller tick.
  app.post('/api/nicehash/run-now', async () => {
    if (!deps.runNow) return { ok: false, error: 'run-now is not available' };
    return deps.runNow();
  });

  app.post('/api/nicehash/run-mode', async (req, reply) => {
    const body = (req.body ?? {}) as { mode?: unknown };
    const mode = body.mode;
    if (typeof mode !== 'string' || !RUN_MODES.includes(mode as RunMode)) {
      return reply.code(400).send({ error: `mode must be one of ${RUN_MODES.join(', ')}` });
    }
    deps.store.setRunMode(mode as RunMode);
    // Persist so the run mode survives a restart (best-effort).
    const cur = await deps.settingsRepo.get();
    if (cur) await deps.settingsRepo.put({ ...cur, runMode: mode as RunMode });
    return { run_mode: deps.store.getRunMode() };
  });

  const currentSettings = async (): Promise<NiceHashSettings> => {
    const stored = await deps.settingsRepo.get();
    // Backfill any fields a stored row from an older version lacks.
    return stored ? mergeSettings(settingsFromEnv(), stored) : settingsFromEnv();
  };

  // Read settings (secret masked).
  app.get('/api/nicehash/config', async () => ({ config: maskSettings(await currentSettings()) }));

  // Update settings. Most changes apply on the next app restart; run mode is
  // applied live. Returns the masked, persisted settings.
  app.post('/api/nicehash/config', async (req) => {
    const patch = (req.body ?? {}) as Partial<Record<keyof NiceHashSettings, unknown>>;
    const merged = mergeSettings(await currentSettings(), patch);
    await deps.settingsRepo.put(merged);
    deps.store.setRunMode(merged.runMode); // run mode is applied immediately
    return {
      config: maskSettings(merged),
      note: 'Saved — applies live within one tick. (API key/secret/org and base URL still need a restart.)',
    };
  });

  // Connectivity test: probe every external dependency the bidder relies on
  // from the values currently in the form (merged onto the saved settings).
  // All probes are read-only and each is reported independently, so one
  // failure (e.g. no pool yet) never hides the status of the others:
  //   1. NiceHash API   - signed read path (time sync + algorithm + balance)
  //   2. Pool           - TCP reachability of the stratum endpoint
  //   3. Hashprice src  - the network-hashprice oracle returns a value
  //   4. BTC price src  - the BTC/USD oracle returns a price
  app.post('/api/nicehash/test', async (req) => {
    const patch = (req.body ?? {}) as Partial<Record<keyof NiceHashSettings, unknown>>;
    const s = mergeSettings(await currentSettings(), patch);
    type Check = { name: string; ok: boolean; skipped?: boolean; detail: string };
    const checks: Check[] = [];

    // 1. NiceHash signed read path.
    if (!s.apiKey || !s.apiSecret || !s.orgId) {
      checks.push({
        name: 'NiceHash API',
        ok: false,
        detail: 'API key, secret, and organization id are all required.',
      });
    } else {
      const client = createNiceHashClient({
        baseUrl: s.baseUrl,
        credentials: { apiKey: s.apiKey, apiSecret: s.apiSecret, orgId: s.orgId },
      });
      try {
        const clockOffsetMs = await client.syncTime();
        const algo = await client.getAlgorithmSetting(s.algorithm);
        let balanceStr: string;
        try {
          const bal = (await client.getAccountBalance(s.balanceCurrency)).available;
          balanceStr = `balance ${bal} ${s.balanceCurrency}`;
        } catch (err) {
          balanceStr = `balance read failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        const off = `${clockOffsetMs >= 0 ? '+' : ''}${clockOffsetMs}ms`;
        // Surface the live algorithm limits the bidder is bound by: the price
        // down-step (max a price decrease may move, per 10-min window) and the
        // minimum order amount / speed limit.
        const limits =
          `down-step ${algo.priceDownStep} · min-order ${algo.minimalOrderAmount} BTC` +
          ` · min-speed ${algo.minSpeedLimit}`;
        checks.push({
          name: 'NiceHash API',
          ok: true,
          detail: `${s.algorithm} ok · clock offset ${off} · marketFactor ${algo.marketFactor} · ${limits} · ${balanceStr}`,
        });
      } catch (err) {
        const detail =
          err instanceof NiceHashApiError
            ? `HTTP ${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        checks.push({ name: 'NiceHash API', ok: false, detail });
      }
    }

    // 2. Pool TCP reachability.
    if (!s.poolHost) {
      checks.push({ name: 'Pool', ok: false, skipped: true, detail: 'No pool host configured yet.' });
    } else {
      const probe = await probePool({ host: s.poolHost, port: s.poolPort });
      checks.push({
        name: 'Pool',
        ok: probe.reachable,
        detail: probe.reachable
          ? `${s.poolHost}:${s.poolPort} reachable (${probe.latency_ms}ms)`
          : `${s.poolHost}:${s.poolPort} unreachable: ${probe.error}`,
      });
    }

    // 3. Network-hashprice source.
    if (s.hashpriceSource === 'none') {
      checks.push({
        name: 'Hashprice source',
        ok: false,
        skipped: true,
        detail: 'Disabled (source = none).',
      });
    } else {
      try {
        const oracle = new HashpriceOracle({ source: s.hashpriceSource });
        const v = await oracle.refresh();
        checks.push(
          v !== null && v > 0
            ? { name: 'Hashprice source', ok: true, detail: `${s.hashpriceSource}: ${v.toFixed(8)} BTC/EH/day` }
            : { name: 'Hashprice source', ok: false, detail: `${s.hashpriceSource}: no value returned` },
        );
      } catch (err) {
        checks.push({
          name: 'Hashprice source',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 4. BTC price source (CoinGecko simple price).
    try {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
        { headers: { accept: 'application/json' } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { bitcoin?: { usd?: number } };
      const usd = j.bitcoin?.usd;
      checks.push(
        typeof usd === 'number' && usd > 0
          ? { name: 'BTC price source', ok: true, detail: `${s.priceSource}: $${usd.toLocaleString('en-US')}` }
          : { name: 'BTC price source', ok: false, detail: `${s.priceSource}: no price returned` },
      );
    } catch (err) {
      checks.push({
        name: 'BTC price source',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Overall "ok" ignores intentionally-skipped checks (no pool / source off).
    const ok = checks.every((c) => c.ok || c.skipped);
    return { ok, checks };
  });

  // Read-only diagnostic: dump the RAW NiceHash order-book entries + our raw
  // order objects, so we can see exactly which fields carry the per-order miner
  // count (orderbook) and the delivered speed (our orders), and their scale.
  // Used to reconcile our parsing with what the NiceHash UI shows.
  app.get('/api/nicehash/debug/raw', async () => {
    const s = await currentSettings();
    if (!s.apiKey || !s.apiSecret || !s.orgId) {
      return { error: 'API key, secret, and organization id are required.' };
    }
    const client = createNiceHashClient({
      baseUrl: s.baseUrl,
      credentials: { apiKey: s.apiKey, apiSecret: s.apiSecret, orgId: s.orgId },
    });
    const out: Record<string, unknown> = {};
    try {
      await client.syncTime();
    } catch {
      /* best effort */
    }
    try {
      // Walk the WHOLE book (price-descending). The orderBook caps each page at
      // ~100 orders, and zero-miner orders are interleaved above the marginal,
      // so we cannot stop at the first gap - the floor (cheapest order still
      // receiving hashrate) is the global lowest-priced order with miners.
      const PAGE_SIZE = 100;
      const MAX_PAGES = 30;
      const merged: OrderBookEntry[] = [];
      const seen = new Set<string>();
      let firstStats: OrderBookResponse['stats'][string] | null = null;
      let pagesFetched = 0;
      let totalPageCount: number | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const book = await client.getOrderBook(s.algorithm, { size: PAGE_SIZE, page });
        const stats = book.stats?.[s.priceCurrency] ?? Object.values(book.stats ?? {})[0] ?? null;
        if (page === 0) firstStats = stats;
        totalPageCount = stats?.pagination?.totalPageCount;
        const pageOrders = stats?.orders ?? [];
        pagesFetched = page + 1;
        let added = 0;
        for (const o of pageOrders) {
          const key = o.id ?? `${o.price}|${o.limit}|${o.type ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(o);
          added++;
        }
        if (added === 0) break;
        if (totalPageCount !== undefined && page + 1 >= totalPageCount) break;
        if (pageOrders.length < PAGE_SIZE) break;
      }
      const orders = merged.sort((a, b) => Number(b.price) - Number(a.price));
      const filled = orders.filter((o) => o.alive !== false && (o.rigsCount ?? 0) > 0);
      out.orderBook = {
        currency: s.priceCurrency,
        totalSpeed: firstStats?.totalSpeed,
        marketFactor: firstStats?.marketFactor,
        displayMarketFactor: firstStats?.displayMarketFactor,
        priceFactor: firstStats?.priceFactor,
        displayPriceFactor: firstStats?.displayPriceFactor,
        count: orders.length,
        pagesFetched,
        totalPageCount,
        // The marginal we anchor on: cheapest order still receiving hashrate.
        marginalFilledPrice: filled.length > 0 ? filled[filled.length - 1]!.price : null,
        // Raw entries with every field, so we can spot the miner-count field.
        topOrders: orders.slice(0, 15),
        cheapestOrders: orders.slice(-20),
      };
    } catch (err) {
      out.orderBookError = err instanceof Error ? err.message : String(err);
    }
    try {
      const my = await client.getMyOrders({ algorithm: s.algorithm, market: s.market });
      out.myOrders = my.list ?? [];
    } catch (err) {
      out.myOrdersError = err instanceof Error ? err.message : String(err);
    }
    return out;
  });

  return app;
}
