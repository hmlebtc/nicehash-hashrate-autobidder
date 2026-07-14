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

  // The next filled tier (STRICT contiguous-top-of-book rule, replacing the old
  // solid-block gap heuristic): the LOWEST price such that every order ROW above
  // it is filled. Sellers fill strictly by price priority, so the block that is
  // genuinely, provably consuming hashrate is the contiguous miner-bearing run
  // at the TOP of the book:
  //
  //   - Scan price levels descending. Zero-miner rows priced ABOVE the highest
  //     miner-bearing row are dead noise (price priority makes a genuinely
  //     unfilled order above a filled one impossible) - ignored.
  //   - From the highest miner-bearing row, walk down while every row is
  //     miner-bearing; stop before the first zero-miner row. Row-level
  //     strictness: ANY zero-miner row breaks the run, including one sharing a
  //     price with a miner-bearing row (a mixed price level taints the level -
  //     the guaranteed-filled region ends above it).
  //   - Next tier = the last (lowest) price of that run; it must sit strictly
  //     ABOVE the marginal, else there is no next tier (null).
  //
  // Miner tiers BELOW the run (e.g. an isolated 0.4791 island under a wall of
  // zero-miner rows) are real fills but not the block the market clears into -
  // anchoring there had the bid tracking the island while the actual clearing
  // block sat far above (2026-07 live case: island 0.4791 vs block 0.4820).
  // Strictness trade-off: the API under-reports miners on some genuinely filled
  // rows (the v0.6.38 finding), so a zero-miner row inside the real block pushes
  // the tier UP to the run above it - the cap still bounds the worst case.
  const isFilledRow =
    filledByRigs.length > 0
      ? (o: CompetingOrder): boolean => (o.rigs_count ?? 0) > 0
      : (o: CompetingOrder): boolean => (o.accepted_speed_units ?? 0) > 0;
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
  const levels = [...new Set(valid.map((o) => o.price_btc))].sort((a, b) => b - a); // descending
  let nextTier: number | null = null;
  let started = false;
  for (const level of levels) {
    const rows = valid.filter((o) => o.price_btc === level);
    const anyFilled = rows.some(isFilledRow);
    const allFilledOrUnconfirmed = rows.every((o) => isFilledRow(o) || isUnconfirmedZero(o));
    if (!started) {
      if (!anyFilled) continue; // dead noise above the highest miner-bearing row
      started = true;
      if (!allFilledOrUnconfirmed) break; // mixed top level: no clean run at all
      nextTier = level;
      continue;
    }
    if (!allFilledOrUnconfirmed) break; // first CONFIRMED zero-miner row ends the run
    nextTier = level;
  }
  if (nextTier !== null && nextTier <= marginal) nextTier = null; // must sit above the marginal

  // Expose the marginal + the ladder from the next tier up. No cap-clamp:
  // filled_prices is a faithful read of the miner-bearing book; the bid is capped
  // independently in decide(). When the run's bottom level holds only
  // unconfirmed-zero rows (no confirmed miners), the >= filter rounds the
  // EXPOSED tier up to the nearest CONFIRMED miner tier at-or-above it - the
  // tier the bot acts on is always a price where miners are provably present.
  const filledPrices =
    nextTier !== null ? [marginal, ...minerTiers.filter((p) => p >= nextTier!)] : [marginal];

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
