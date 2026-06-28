/**
 * #241: boot-time backfill of synthetic tick_metrics rows across a
 * detected daemon-offline gap.
 *
 * Two problems this solves:
 *
 *   1. Difficulty-retarget markers: a retarget that happened *inside*
 *      the gap has no real tick_metrics row at its canonical time, so
 *      the chart's `prev vs next difficulty > 0.5%` marker detection
 *      finds the diff jump at the *first post-gap real tick*. The
 *      marker lands days late.
 *
 *   2. Pool-luck through the gap: `pool_luck_24h/7d/30d` lives in
 *      tick_metrics. With no rows in the gap, the chart linearly
 *      interpolates the luck line - so the operator sees a flat
 *      mauve segment across the gap even though pool_blocks_backfill
 *      has correctly populated pool blocks in the same window.
 *
 * Approach
 * --------
 *
 * Determine the set of retargets in the gap. With `bitcoindClient`
 * wired, walk back through every retarget height (mod 2016) from
 * chain tip until the block's canonical timestamp is before the gap;
 * each in-gap retarget contributes (canonical_time,
 * canonical_difficulty). Without bitcoindClient, if the pre/post
 * difficulty diff is > 0.5%, derive a single pseudo-retarget at the
 * latest retarget height's nearest-pool-block estimate (legacy
 * pre-bitcoind behavior preserved as a fallback so multi-retarget
 * cases can't be detected, but the most-recent one still surfaces).
 *
 * Then generate a synthetic tick every {@link SYNTHETIC_INTERVAL_MS}
 * across the gap, plus a tick at each retarget timestamp. Assign
 * each tick the difficulty as-of its time (= the difficulty of the
 * most recent retarget at-or-before that time, falling back to
 * prevTick's difficulty for ticks before any in-gap retarget).
 *
 * Bucket alignment (the gotcha)
 * -----------------------------
 *
 * The chart's `/api/metrics` endpoint AVG-aggregates rows into
 * server-side buckets sized per the visible range (5-min raw for
 * 24h, 30-min for 1w, 1h for 1m, 1d for 1y/all). The chart's
 * retarget-marker detector also has a sustained-check filter: a
 * detected diff jump is only accepted if the *next* non-null bucket
 * matches the current within 0.5% (suppresses spurious markers from
 * smoothed bucket transitions). If a bucket contains both pre and
 * post-retarget ticks, its AVG is intermediate, the sustained check
 * fails, and the marker is rejected. Empirical: 5-min synthetic
 * cadence + 30-min 1w bucket = 6 pre-retarget ticks averaged with 1
 * post-retarget canonical tick in the same bucket, AVG mostly
 * pre-retarget, sustained-check fails, marker invisible on the very
 * range the operator is most likely viewing.
 *
 * Fix: skip cadence synthetics whose 30-min bucket collides with
 * any retarget canonical's 30-min bucket. The canonical synthetic
 * is then alone in its 30-min bucket, AVG = newDiff exactly, the
 * adjacent bucket's AVG = prevDiff exactly (no mixed rows), step
 * crosses the 0.5% threshold cleanly and sustains. Works for 1w
 * (30-min) and 1m (1h) views; 1y / All (1d bucket) is too coarse
 * - the bucket containing canonical still mixes pre and post within
 * the day - and is a documented limitation.
 *
 * Idempotency
 * -----------
 *
 * Every run DELETEs `synthetic = 1` rows strictly inside the
 * detected gap before re-inserting. Re-runs replace stale entries
 * instead of accumulating them - and a previous boot's wrong-time
 * synthetic doesn't block re-detection (handled jointly by the
 * `synthetic = 0` filter on gap-boundary queries).
 */

import { sql, type Insertable, type Kysely, type Selectable } from 'kysely';

import type { BitcoindClient } from '@hashrate-autopilot/bitcoind-client';

import type { PoolBlocksRepo } from '../state/repos/pool_blocks.js';
import type { Database, TickMetricsTable } from '../state/types.js';

type TickMetricsRow = Selectable<TickMetricsTable>;

const RETARGET_INTERVAL = 2016;
const AVG_BLOCK_TIME_MS = 600_000;
const DIFFICULTY_THRESHOLD = 0.005;

/**
 * Synthetic tick cadence. 5 min is finer than the 1w / 1m chart
 * bucket sizes (30 min / 1h) so each bucket has multiple synthetics
 * to AVG, and the pool-luck line on the chart shows real step
 * changes when in-gap pool blocks enter / exit the 24h / 7d / 30d
 * windows. The retarget-bucket-skip below cleans up the bucket-AVG
 * collision so cadence-fineness doesn't dilute the marker.
 */
const SYNTHETIC_INTERVAL_MS = 5 * 60_000;

/**
 * Cadence-skip window around each canonical retarget. The 30-min
 * value matches the 1w chart preset's `bucketMs`; cadence ticks
 * inside the canonical's 30-min bucket are skipped so the AVG is
 * post-retarget only and the chart's sustained-check filter
 * accepts the marker.
 */
const RETARGET_SKIP_BUCKET_MS = 30 * 60_000;

/**
 * Skip "gaps" shorter than this. Normal poll variance from the
 * 60 s tick can leave a 2-3 min window where lastTick/prevTick
 * could plausibly bracket; we don't want to fill those with
 * synthetics.
 */
const MIN_GAP_MS = 10 * 60_000;

/**
 * Safety cap on retarget walk-back: if bitcoind returns plausible
 * timestamps every time, we stop at the first one before gapStart.
 * This guards against an unbounded loop if a degenerate response
 * arrives (very-stale node, time anomaly).
 */
const RETARGET_WALKBACK_CAP = 30;

/**
 * Only consider gaps in the last LOOKBACK_MS of history. The chart
 * shows at most 1y so older gaps aren't worth filling. Tied to
 * tick_metrics retention; if the operator's retention is shorter,
 * gaps older than retention get pruned with the rest.
 */
const LOOKBACK_MS = 365 * 24 * 60 * 60_000;

interface RetargetEntry {
  readonly height: number;
  readonly timeMs: number;
  readonly difficulty: number;
  /** 'bitcoind' = canonical from block header; 'estimate' = nearest-pool-block fallback. */
  readonly source: 'bitcoind' | 'estimate';
}

export interface GapBackfillDeps {
  readonly db: Kysely<Database>;
  readonly poolBlocksRepo: PoolBlocksRepo;
  /**
   * When wired, walk back canonical retarget times via bitcoind RPC
   * so multi-retarget gaps surface every marker. Without it, falls
   * back to a single pseudo-retarget at the latest retarget height's
   * nearest-pool-block estimate - same per-tick gap-fill, fewer
   * markers (typically 1 instead of N).
   */
  readonly bitcoindClient?: BitcoindClient;
  readonly log?: (msg: string) => void;
}

export async function runGapBackfill(deps: GapBackfillDeps): Promise<void> {
  const { db, log = () => {} } = deps;

  log(`[gap-backfill] starting; bitcoindClient=${deps.bitcoindClient ? 'available' : 'null (fallback path)'}`);

  // Find ALL gaps > MIN_GAP_MS in tick_metrics history (real rows
  // only - synthetic=0). Previously this function only looked at the
  // MOST RECENT inter-tick interval, which meant: once the daemon
  // had been running for a few minutes after an outage, the gap
  // between the latest two ticks was just ~60s of normal polling
  // and the function returned early - the historical outage gap
  // stayed invisible. Confirmed against operator's actual DB
  // (#241): 88h May 29->Jun 1 gap in the data, function logged
  // "gap 3.0 min < 10 min threshold; nothing to do" because it
  // only saw the last-tick-pair delta.
  const gaps = await findAllGaps(db, LOOKBACK_MS, log);
  if (gaps.length === 0) {
    log(`[gap-backfill] no gaps > ${MIN_GAP_MS / 60_000} min found in last ${LOOKBACK_MS / (24 * 3_600_000)}d of tick_metrics; nothing to do`);
    return;
  }

  log(`[gap-backfill] found ${gaps.length} gap(s) to process: ${gaps.map((g) => `${new Date(g.gapStart).toISOString().slice(0, 16)}+${(g.gapMs / 3_600_000).toFixed(1)}h`).join(', ')}`);

  for (const gap of gaps) {
    // eslint-disable-next-line no-await-in-loop
    await processGap({ ...deps, log }, gap);
  }
}

interface DetectedGap {
  readonly gapStart: number;
  readonly gapEnd: number;
  readonly gapMs: number;
  /** Tick at gapStart, full row, for template + difficulty. */
  readonly prevTick: TickMetricsRow;
  /** Tick at gapEnd, full row. */
  readonly lastTick: TickMetricsRow;
}

async function findAllGaps(
  db: Kysely<Database>,
  lookbackMs: number,
  log: (msg: string) => void,
): Promise<DetectedGap[]> {
  // Pull every real (synthetic=0) tick in the lookback window with
  // non-null difficulty, walk consecutive pairs in JS to find gaps.
  // Doing the LAG in SQL works for SQLite but Kysely's window-function
  // typing fights us in places; the JS walk is faster to reason about
  // and the row count is bounded (one tick per minute × lookback days
  // = a few hundred K at most, well under the few-second budget).
  const sinceMs = Date.now() - lookbackMs;
  const rows = await db
    .selectFrom('tick_metrics')
    .select(['tick_at', 'network_difficulty'])
    .where('synthetic', '=', 0)
    .where('tick_at', '>=', sinceMs)
    .where('network_difficulty', 'is not', null)
    .orderBy('tick_at', 'asc')
    .execute();

  const gapPairs: Array<{ prevAt: number; nextAt: number }> = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1]!;
    const next = rows[i]!;
    if (next.tick_at - prev.tick_at > MIN_GAP_MS) {
      gapPairs.push({ prevAt: prev.tick_at, nextAt: next.tick_at });
    }
  }

  if (gapPairs.length === 0) return [];

  // Fetch the full rows for each gap boundary (need template fields
  // for the synthetic insertion).
  const results: DetectedGap[] = [];
  for (const pair of gapPairs) {
    // eslint-disable-next-line no-await-in-loop
    const prevTick = await db
      .selectFrom('tick_metrics')
      .selectAll()
      .where('synthetic', '=', 0)
      .where('tick_at', '=', pair.prevAt)
      .limit(1)
      .executeTakeFirst();
    // eslint-disable-next-line no-await-in-loop
    const lastTick = await db
      .selectFrom('tick_metrics')
      .selectAll()
      .where('synthetic', '=', 0)
      .where('tick_at', '=', pair.nextAt)
      .limit(1)
      .executeTakeFirst();
    if (!prevTick || !lastTick) {
      log(`[gap-backfill] WARN: missing boundary tick for gap ${new Date(pair.prevAt).toISOString()}->${new Date(pair.nextAt).toISOString()}, skipping`);
      continue;
    }
    if (prevTick.network_difficulty == null || lastTick.network_difficulty == null) continue;
    results.push({
      gapStart: pair.prevAt,
      gapEnd: pair.nextAt,
      gapMs: pair.nextAt - pair.prevAt,
      prevTick,
      lastTick,
    });
  }
  return results;
}

async function processGap(
  deps: GapBackfillDeps & { log: (msg: string) => void },
  gap: DetectedGap,
): Promise<void> {
  const { db, log } = deps;
  const { gapStart, gapEnd, gapMs, prevTick, lastTick } = gap;

  log(`[gap-backfill] processing gap: ${new Date(gapStart).toISOString()} -> ${new Date(gapEnd).toISOString()} (${(gapMs / 3_600_000).toFixed(1)}h); prevDiff=${prevTick.network_difficulty!.toExponential(3)}, lastDiff=${lastTick.network_difficulty!.toExponential(3)}`);

  // Always clear any stale synthetic rows in this gap before
  // re-inserting. Safe because real polled rows can't exist strictly
  // inside an outage - any row in (gapStart, gapEnd) with synthetic=1
  // is a previous run's insertion, possibly at a wrong-time estimate.
  const cleared = await db
    .deleteFrom('tick_metrics')
    .where('synthetic', '=', 1)
    .where('tick_at', '>', gapStart)
    .where('tick_at', '<', gapEnd)
    .executeTakeFirst();
  if (cleared.numDeletedRows > 0n) {
    log(`[gap-backfill] cleared ${cleared.numDeletedRows} stale synthetic tick(s) in this gap`);
  }

  const retargets = await collectRetargets({
    bitcoindClient: deps.bitcoindClient,
    poolBlocksRepo: deps.poolBlocksRepo,
    db,
    prevDiff: prevTick.network_difficulty!,
    lastDiff: lastTick.network_difficulty!,
    gapStart,
    gapEnd,
    log,
  });

  await insertSyntheticGapTicks({
    db,
    log,
    prevTick,
    gapStart,
    gapEnd,
    gapMs,
    retargets,
  });
}

/**
 * Backwards-compat alias for any external caller still importing the
 * previous name. Removed in a follow-up cleanup.
 *
 * @deprecated use runGapBackfill
 */
export const runRetargetBackfill = runGapBackfill;

interface CollectRetargetsArgs {
  readonly bitcoindClient: BitcoindClient | undefined;
  readonly poolBlocksRepo: PoolBlocksRepo;
  readonly db: Kysely<Database>;
  readonly prevDiff: number;
  readonly lastDiff: number;
  readonly gapStart: number;
  readonly gapEnd: number;
  readonly log: (msg: string) => void;
}

async function collectRetargets(args: CollectRetargetsArgs): Promise<readonly RetargetEntry[]> {
  const { bitcoindClient, poolBlocksRepo, db, prevDiff, lastDiff, gapStart, gapEnd, log } = args;

  const maxHeight = await poolBlocksRepo.maxHeight();
  if (maxHeight == null) {
    log(`[gap-backfill] pool_blocks empty - cannot determine chain tip; no retarget metadata available`);
    return [];
  }
  const startHeight = Math.floor(maxHeight / RETARGET_INTERVAL) * RETARGET_INTERVAL;

  if (bitcoindClient) {
    const retargets: RetargetEntry[] = [];
    let h = startHeight;
    for (let n = 0; n < RETARGET_WALKBACK_CAP && h > 0; n += 1) {
      let timeMs: number;
      let difficulty: number;
      try {
        // eslint-disable-next-line no-await-in-loop
        const hashResp = await bitcoindClient.batch<string>([
          { method: 'getblockhash', params: [h] },
        ]);
        const blockHash = hashResp[0];
        if (!blockHash) break;
        // Second round-trip for the header. Can't batch with the hash
        // call because the header request depends on the hash result.
        // eslint-disable-next-line no-await-in-loop
        const headerResp = await bitcoindClient.batch<{ time: number; difficulty: number }>([
          { method: 'getblockheader', params: [blockHash, true] },
        ]);
        const header = headerResp[0];
        if (!header) break;
        timeMs = header.time * 1000;
        difficulty = header.difficulty;
      } catch (err) {
        log(`[gap-backfill] bitcoind lookup for retarget block ${h} failed (${(err as Error).message}); aborting walk-back`);
        break;
      }
      if (timeMs < gapStart) break;
      if (timeMs <= gapEnd) {
        retargets.push({ height: h, timeMs, difficulty, source: 'bitcoind' });
      }
      h -= RETARGET_INTERVAL;
    }
    retargets.sort((a, b) => a.timeMs - b.timeMs);
    log(`[gap-backfill] bitcoind walk-back found ${retargets.length} in-gap retarget(s): ${retargets.map((r) => `${r.height}@${new Date(r.timeMs).toISOString()}(diff=${r.difficulty.toExponential(3)})`).join(', ') || '(none)'}`);
    return retargets;
  }

  // No bitcoind: derive a single pseudo-retarget at the latest
  // retarget height's nearest-pool-block estimate. Only if the pre vs
  // post difficulty actually changed; otherwise the gap straddled no
  // retarget and there's nothing to mark.
  if (Math.abs(lastDiff - prevDiff) / prevDiff < DIFFICULTY_THRESHOLD) {
    log(`[gap-backfill] no bitcoind + no difficulty change > ${DIFFICULTY_THRESHOLD * 100}%; no retarget metadata`);
    return [];
  }
  const nearestBlock = await db
    .selectFrom('pool_blocks')
    .select(['height', 'timestamp_ms'])
    .orderBy(sql`ABS(height - ${startHeight})`)
    .limit(1)
    .executeTakeFirst();
  if (!nearestBlock) {
    log(`[gap-backfill] no bitcoind + no pool_block near retarget height ${startHeight}; no retarget metadata`);
    return [];
  }
  const estimatedMs = nearestBlock.timestamp_ms - (nearestBlock.height - startHeight) * AVG_BLOCK_TIME_MS;
  if (estimatedMs <= gapStart || estimatedMs >= gapEnd) {
    log(`[gap-backfill] no bitcoind + estimated retarget at ${new Date(estimatedMs).toISOString()} falls outside gap; no retarget metadata`);
    return [];
  }
  const pseudo: RetargetEntry = {
    height: startHeight,
    timeMs: estimatedMs,
    difficulty: lastDiff,
    source: 'estimate',
  };
  log(`[gap-backfill] no bitcoind + estimated single retarget: ${pseudo.height}@${new Date(pseudo.timeMs).toISOString()}(diff=${pseudo.difficulty.toExponential(3)}, source=estimate)`);
  return [pseudo];
}

interface InsertSyntheticsArgs {
  readonly db: Kysely<Database>;
  readonly log: (msg: string) => void;
  readonly prevTick: TickMetricsRow;
  readonly gapStart: number;
  readonly gapEnd: number;
  readonly gapMs: number;
  readonly retargets: readonly RetargetEntry[];
}

async function insertSyntheticGapTicks(args: InsertSyntheticsArgs): Promise<void> {
  const { db, log, prevTick, gapStart, gapEnd, gapMs, retargets } = args;

  // Buckets to skip for cadence synthetics. Each retarget canonical
  // is alone in its 30-min bucket so the bucket AVG = newDiff exactly
  // and the chart's sustained-check accepts the marker.
  const skipBuckets = new Set<number>();
  for (const r of retargets) {
    skipBuckets.add(Math.floor(r.timeMs / RETARGET_SKIP_BUCKET_MS));
  }

  const timestamps = new Set<number>();
  for (let t = gapStart + SYNTHETIC_INTERVAL_MS; t < gapEnd; t += SYNTHETIC_INTERVAL_MS) {
    if (skipBuckets.has(Math.floor(t / RETARGET_SKIP_BUCKET_MS))) continue;
    timestamps.add(t);
  }
  for (const r of retargets) timestamps.add(r.timeMs);
  if (timestamps.size === 0) return;

  const ordered = Array.from(timestamps).sort((a, b) => a - b);

  // Difficulty as-of each timestamp: the post-retarget difficulty of
  // the most recent retarget at-or-before T, falling back to
  // prevTick's last-pre-gap difficulty for ticks before any in-gap
  // retarget.
  const prevDiff = prevTick.network_difficulty;
  const sortedRetargets = [...retargets].sort((a, b) => a.timeMs - b.timeMs);
  const diffForTimestamp = (t: number): number | null => {
    let diff: number | null = prevDiff;
    for (const r of sortedRetargets) {
      if (r.timeMs <= t) diff = r.difficulty;
      else break;
    }
    return diff;
  };

  // Build the inserts. Strip operator-status fields (delivered_ph,
  // bid prices, balances, oracle reading) - the operator was offline
  // and inheriting the template's last-pre-gap values would falsely
  // imply the daemon was up. Keep config snapshots (target/floor,
  // deadband, run/action mode) because they really were in effect
  // throughout the gap. pool_blocks_*_count, pool_hashrate_ph_avg_*,
  // pool_luck_*, paid_total_sat all stay null - runPoolLuckRecompute
  // fills them immediately after this service.
  const rows: Insertable<TickMetricsTable>[] = ordered.map((t) => ({
    tick_at: t,
    delivered_ph: 0,
    target_ph: prevTick.target_ph,
    floor_ph: prevTick.floor_ph,
    owned_bid_count: 0,
    unknown_bid_count: 0,
    our_primary_price_sat_per_eh_day: null,
    best_bid_sat_per_eh_day: null,
    best_ask_sat_per_eh_day: null,
    fillable_ask_sat_per_eh_day: null,
    hashprice_sat_per_eh_day: null,
    max_bid_sat_per_eh_day: null,
    available_balance_sat: null,
    total_balance_sat: null,
    datum_hashrate_ph: null,
    ocean_hashrate_ph: null,
    share_log_pct: null,
    spend_sat: null,
    primary_bid_consumed_sat: null,
    network_difficulty: diffForTimestamp(t),
    estimated_block_reward_sat: null,
    pool_hashrate_ph: null,
    pool_active_workers: null,
    braiins_total_deposited_sat: null,
    braiins_total_spent_sat: null,
    ocean_unpaid_sat: null,
    paid_total_sat: null,
    btc_usd_price: null,
    btc_usd_price_source: null,
    primary_bid_last_pause_reason: null,
    primary_bid_fee_paid_sat: null,
    primary_bid_fee_rate_pct: null,
    bid_edit_deadband_pct: prevTick.bid_edit_deadband_pct,
    pool_blocks_24h_count: null,
    pool_blocks_7d_count: null,
    pool_hashrate_ph_avg_24h: null,
    pool_hashrate_ph_avg_7d: null,
    pool_luck_24h: null,
    pool_luck_7d: null,
    pool_luck_30d: null,
    pool_blocks_30d_count: null,
    pool_hashrate_ph_avg_30d: null,
    braiins_reachable: 0,
    run_mode: prevTick.run_mode,
    action_mode: prevTick.action_mode,
    synthetic: 1,
  }));

  // SQLite's default parameter cap is 999. Each row uses ~42 params,
  // so 20 rows per batch (840 params) stays comfortably below.
  const BATCH = 20;
  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.insertInto('tick_metrics').values(rows.slice(i, i + BATCH)).execute();
  }
  /* eslint-enable no-await-in-loop */

  const gapHrs = (gapMs / 3_600_000).toFixed(1);
  log(`[gap-backfill] inserted ${rows.length} synthetic tick(s) across ${gapHrs}h gap; ${retargets.length} retarget(s) embedded${retargets.length > 0 ? ` (sources: ${retargets.map((r) => r.source).join(',')})` : ''}`);
}
