/**
 * NiceHash pricing-anchor computation - the buyer-competition analogue of
 * Braiins' `cheapestAskForDepth`.
 *
 * NiceHash has no ask book: there are only competing *buy* orders, and sellers
 * deliver their hashrate to the highest-priced live orders first. The price we
 * must beat is therefore the **marginal price** - the price of the *cheapest
 * order that is currently receiving hashrate*. NiceHash highlights exactly this
 * price in purple in its order book. Bidding a hair above it jumps the queue
 * ahead of everything priced lower, and in any liquid market that is enough to
 * win a normal target; how much we actually draw is then bounded by our own
 * order limit, not by the anchor.
 *
 * We detect "currently receiving hashrate" via each competitor's `rigs_count`
 * (NiceHash's "Miners" column) - the reliable signal that an order is being
 * filled. (The orderbook's per-order `accepted_speed_units` is sparsely
 * reported and undercounts badly, so it's only a fallback when no rig counts
 * are present.) Keying off live delivery - not the order's `limit` price-cap -
 * is what keeps an idle or over-capped high-priced order (a large `limit`
 * resting high but mining nothing, e.g. a BUSINESS ceiling order) from dragging
 * the anchor to the top of the book: it simply isn't a filled order.
 *
 * We deliberately do NOT try to "accumulate" the target across the cheapest
 * filled orders. In a deep market that walks the anchor far up the book (and
 * relies on per-order delivered-speed accuracy we don't have); it also bids
 * well above the floor, which is the opposite of what the operator wants. The
 * floor + the operator's overpay cushion is the right bid; the fixed/dynamic
 * ceiling still caps the worst case.
 *
 * The caller must pass *competitors only* (our own resting order excluded) and
 * the market's `totalSpeed`. The result feeds `decide()`, which adds the
 * overpay cushion and clamps to the safety ceiling.
 */

import type { CompetingOrder, MarketAnchor } from './types.js';

export function computeMarketAnchor(
  competitors: readonly CompetingOrder[],
  totalSpeedUnits: number,
  targetUnits: number,
  /**
   * Order ids whose CURRENT rigs=0 reading is not yet confirmed (fewer than
   * two consecutive book reads at zero - the caller tracks the streaks across
   * ticks). Probe-verified (2026-07-14, 11 live samples): rig counts flicker
   * to 0 for a single read on rows with hundreds of rigs, and brand-new orders
   * spend 30-90s at rigs=0 while sellers migrate to them. An unconfirmed zero
   * row is exempted from breaking the contiguity run BELOW; everything else
   * (marginal, filled set, stats) stays a true read of the raw rigs data.
   */
  unconfirmedZeroIds: ReadonlySet<string> = new Set(),
  /**
   * Order ids in CONFIRMED-ZERO state whose CURRENT rigs>0 reading is not yet
   * confirmed (fewer than two consecutive nonzero reads - the symmetric side
   * of the debounce). Rig flicker goes both ways: the probe showed rows flip
   * 0 -> ~20 rigs for one read with speed 0 on both sides, which under a
   * zero-only debounce collapses the tier to the marginal instantly and then
   * costs ~4 ticks to recover. A recovering row still acts as a RUN-BREAKER
   * in the contiguity scan (never as filled) until its nonzero reading
   * confirms; the marginal, filled set and stats stay a true read of the raw
   * rigs data (the row IS rigs>0 raw).
   */
  unconfirmedNonzeroIds: ReadonlySet<string> = new Set(),
  /**
   * Dust threshold (speed-display units): rows with 0 < limit_units < this
   * are fully TRANSPARENT to the run scan - they never break it, never
   * extend it, never start it. A row that can absorb at most ~a thousandth
   * of the target says nothing about whether a full-size order fills at that
   * price; its fill state is pure noise for the floor (operator capture,
   * 2026-07-14: a limit-0.001 row at the marginal level genuinely toggled
   * zero/filled every 1-2 min and dithered the bid +-0.0001 endlessly).
   * limit_units === 0 means UNCAPPED on NiceHash and is never dust. Dust
   * rows still count in the RAW marginal / stats / minerTiers (the purple
   * display stays honest). 0 disables.
   */
  dustLimitUnits = 0,
): MarketAnchor {
  const valid = competitors.filter(
    (o) =>
      Number.isFinite(o.price_btc) &&
      o.price_btc > 0 &&
      Number.isFinite(o.limit_units) &&
      o.limit_units >= 0,
  );

  const prices = valid.map((o) => o.price_btc);
  const lowest = prices.length > 0 ? Math.min(...prices) : null;

  // Orders currently receiving hashrate. Miners (`rigs_count`) is the RELIABLE
  // per-order fill signal; delivered speed (`accepted_speed_units`) is noisy - the
  // book routinely reports a small residual speed on orders sitting *below* the
  // fill line (0 miners), a stale/boundary artifact. Trusting that residual speed
  // (an earlier speed-union rule did) drags the marginal far below NiceHash's
  // purple: e.g. a 0.4556 order showing 0.007 EH/s and 0 miners was read as the
  // marginal while the real block (41,850 miners) sat at 0.4606. So we PREFER
  // miners: when any order reports a miner count, the filled set is the
  // miner-bearing orders and speed-only stragglers are treated as noise. Only when
  // NO order reports miners anywhere (some ticks/markets omit the column) do we
  // fall back to delivered speed so a miner-less book still finds a floor.
  const filledByRigs = valid.filter((o) => (o.rigs_count ?? 0) > 0);
  const filled =
    filledByRigs.length > 0
      ? filledByRigs
      : valid.filter((o) => (o.accepted_speed_units ?? 0) > 0);

  if (filled.length === 0) {
    // Nothing is being delivered to any competitor: no live competition to
    // outbid. With deliverable supply we can sit at the bottom of the book (or
    // the floor when the book is empty); with none, flag the market as thin.
    return {
      anchor_price_btc: lowest,
      total_speed_units: totalSpeedUnits,
      thin: !(totalSpeedUnits > 0),
      filled_prices: [],
      median_price_btc: null,
      avg_price_btc: null,
    };
  }

  // Market price stats over the filled orders (for the MARKET chart). Median =
  // the middle filled-order price (a robust "typical" market price); avg =
  // speed-weighted, sum(price x speed) / sum(speed) - the effective price per
  // delivered EH (~ NiceHash's "Paying"), falling back to the unweighted mean
  // when no delivered speed is reported.
  const stats = marketPriceStats(filled);

  // The marginal (NiceHash purple) = the cheapest order in the filled set (miner-
  // bearing, or speed-bearing only when no miners are reported anywhere). This is
  // the one tier that genuinely needs the per-order signal: it's the boundary
  // between the filled and unfilled book, which price alone can't locate.
  const marginal = Math.min(...filled.map((o) => o.price_btc)); // cheapest filled = purple

  // Distinct MINER-bearing prices, ascending (`filled` is already miner-preferred,
  // or speed-fallback when no order reports miners anywhere). These are the tiers
  // actually winning hashrate; `minerTiers[0]` is the marginal.
  const minerTiers = [...new Set(filled.map((o) => o.price_btc))].sort((a, b) => a - b);

  // The BID-FLOOR anchor (run-bottom rule, v0.6.56 - generalizes the strict
  // next-filled-tier scan): the lowest price level of the contiguous
  // (debounced, dust-transparent) filled run at the TOP of the book. Sellers
  // fill strictly by price priority, so that run is the block the market
  // provably clears into - and its bottom is the one price the bid must stay
  // at-or-above to be IN the block:
  //
  //   - Scan price levels descending (dust rows removed first - see the
  //     dustLimitUnits param). Zero-miner rows priced ABOVE the highest
  //     miner-bearing row are dead noise (price priority makes a genuinely
  //     unfilled order above a filled one impossible) - ignored.
  //   - From the highest miner-bearing row, walk down while every row is
  //     miner-bearing (or an unconfirmed zero); stop before the first
  //     confirmed zero-miner row. Row-level strictness: ANY confirmed zero
  //     row breaks the run, including one sharing a price with a miner-bearing
  //     row (a mixed price level taints the level - the guaranteed-filled
  //     region ends above it).
  //   - The FLOOR = the run's bottom, rounded UP to the nearest non-dust
  //     confirmed miner tier. When the run stops above the cheapest fill this
  //     is the classic "next filled tier"; when the fill genuinely reaches the
  //     bottom of the book it EQUALS the marginal (no more null-collapse -
  //     the old "tier <= marginal -> null" rule made downstream code fall
  //     back to the RAW marginal, and a raw marginal has no island/debounce
  //     protection: a limit-0 island at 0.46 receiving a dribble walked the
  //     live bid 0.002 below the block, operator capture 2026-07-14 17:18Z).
  //
  // Miner tiers BELOW the run (islands under a confirmed-zero wall, e.g. that
  // 0.46 island, or the earlier 0.4791-island case) are real fills but not
  // the block the market clears into - by construction they can never be the
  // run bottom. Strictness trade-off unchanged: a confirmed zero row inside
  // the real block pushes the floor UP to the run above it - the cap still
  // bounds the worst case.
  const isFilledRow =
    filledByRigs.length > 0
      ? (o: CompetingOrder): boolean => (o.rigs_count ?? 0) > 0
      : (o: CompetingOrder): boolean => (o.accepted_speed_units ?? 0) > 0;
  // Dust: transparent to the scan (removed from the level walk entirely) but
  // a true part of the raw filled set above. limit 0 = uncapped, never dust.
  const isDust = (o: CompetingOrder): boolean =>
    dustLimitUnits > 0 && o.limit_units > 0 && o.limit_units < dustLimitUnits;
  // Zero-confirmation debounce (rigs mode only - the streaks are rig-based):
  // a rigs=0 row whose zero reading is not yet confirmed by two consecutive
  // reads does NOT break the run. It never counts as filled either - it can't
  // start the run, extend the marginal, or enter the stats/minerTiers; it is
  // merely transparent to the contiguity scan. Rows without an id can't be
  // tracked and stay strict (immediate breakers).
  const isUnconfirmedZero = (o: CompetingOrder): boolean =>
    filledByRigs.length > 0 &&
    (o.rigs_count ?? 0) === 0 &&
    o.id !== undefined &&
    unconfirmedZeroIds.has(o.id);
  // The symmetric side: a confirmed-zero row reading rigs>0 stays an effective
  // run-breaker until the nonzero reading confirms (two consecutive reads).
  // In the SCAN it behaves exactly like a confirmed zero row - never filled,
  // always a breaker - so a one-read nonzero flicker cannot extend the run
  // and collapse the tier to the marginal. Raw-truth scope: the row still
  // counts as filled in the marginal / stats / minerTiers (it IS rigs>0).
  const isRecoveringNonzero = (o: CompetingOrder): boolean =>
    filledByRigs.length > 0 &&
    (o.rigs_count ?? 0) > 0 &&
    o.id !== undefined &&
    unconfirmedNonzeroIds.has(o.id);
  const isScanFilled = (o: CompetingOrder): boolean => isFilledRow(o) && !isRecoveringNonzero(o);
  const scanRows = valid.filter((o) => !isDust(o)); // dust never breaks/extends/starts the run
  const levels = [...new Set(scanRows.map((o) => o.price_btc))].sort((a, b) => b - a); // descending
  let runBottom: number | null = null;
  let started = false;
  for (const level of levels) {
    const rows = scanRows.filter((o) => o.price_btc === level);
    const anyFilled = rows.some(isScanFilled);
    const allFilledOrUnconfirmed = rows.every((o) => isScanFilled(o) || isUnconfirmedZero(o));
    if (!started) {
      if (!anyFilled) continue; // dead noise above the highest miner-bearing row
      started = true;
      // The run starts at the highest miner-bearing level even when that
      // level is tainted by a confirmed zero row: the market provably clears
      // at least partially HERE, and there is nothing cleaner above. (The old
      // null-collapse made this case fall back to the raw marginal - one
      // tainted read could drop the bid onto an island. Upward moves are
      // still held by the hysteresis for two ticks.)
      runBottom = level;
      if (!allFilledOrUnconfirmed) break;
      continue;
    }
    if (!allFilledOrUnconfirmed) break; // first CONFIRMED zero-miner row ends the run
    runBottom = level;
  }
  // The floor = the run bottom rounded UP to the nearest NON-DUST confirmed
  // miner tier (the run bottom itself when it carries confirmed miners; the
  // tier above it when it holds only unconfirmed zeros - the price the bot
  // acts on is always one where full-size miners are provably present). The
  // run may extend below the marginal through transparent rows; the rounding
  // then lands back on the cheapest real fill. Null only when nothing
  // non-dust is filled at all (no run to anchor in).
  const nonDustTiers = [
    ...new Set(filled.filter((o) => !isDust(o)).map((o) => o.price_btc)),
  ].sort((a, b) => a - b);
  const floor = runBottom !== null ? (nonDustTiers.find((p) => p >= runBottom!) ?? null) : null;

  // Expose the marginal + the ladder from the floor up: filled_prices[1] IS
  // the floor anchor (it may EQUAL the marginal when the fill reaches the
  // bottom - dup entry, consumers read [0]/[1] only). No cap-clamp:
  // filled_prices is a faithful read of the miner-bearing book; the bid is
  // capped independently in decide().
  const filledPrices =
    floor !== null ? [marginal, ...minerTiers.filter((p) => p >= floor!)] : [marginal];

  return {
    anchor_price_btc: marginal,
    total_speed_units: totalSpeedUnits,
    // "Thin" only when the target plainly exceeds the whole market's supply -
    // a best-effort flag; we still anchor at the floor and grab what we can.
    thin: totalSpeedUnits > 0 && targetUnits >= totalSpeedUnits,
    filled_prices: filledPrices,
    median_price_btc: stats.median,
    avg_price_btc: stats.avg,
  };
}

/**
 * Median + speed-weighted-average price over a set of filled orders. Median is
 * the middle order's price; avg = sum(price x speed) / sum(speed), falling back
 * to the unweighted mean when no order reports delivered speed.
 */
function marketPriceStats(
  orders: readonly CompetingOrder[],
): { median: number | null; avg: number | null } {
  if (orders.length === 0) return { median: null, avg: null };
  const prices = orders.map((o) => o.price_btc).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 1 ? prices[mid]! : (prices[mid - 1]! + prices[mid]!) / 2;
  let weighted = 0;
  let weight = 0;
  for (const o of orders) {
    const s = o.accepted_speed_units ?? 0;
    if (s > 0) {
      weighted += o.price_btc * s;
      weight += s;
    }
  }
  const avg = weight > 0 ? weighted / weight : prices.reduce((a, b) => a + b, 0) / prices.length;
  return { median, avg };
}
