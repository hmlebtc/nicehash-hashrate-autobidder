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

/**
 * Two miner-bearing tiers belong to the same "solid block" when they sit within
 * this many empty price levels of each other (empty levels between two tiers =
 * round(gap / step) - 1). A miner tier isolated from every other miner tier by a
 * WIDER gap than this - on both sides - is a lone straggler, not a real block: by
 * NiceHash's price priority everything above the marginal is being filled, but the
 * API under-reports miners on many tiers, so an isolated miner tier sitting below a
 * run of 0-miner tiers is noise. We anchor the next filled tier on the first solid
 * block above the marginal, skipping such stragglers.
 */
const SOLID_BLOCK_MAX_GAP_LEVELS = 2;

export function computeMarketAnchor(
  competitors: readonly CompetingOrder[],
  totalSpeedUnits: number,
  targetUnits: number,
  priceStepBtc = 0,
  // Retained for call-site compatibility; the ladder no longer clamps to the cap.
  _capBtc = 0,
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

  // The next filled tier = the cheapest miner tier above the marginal that STARTS A
  // SOLID BLOCK - one with another miner tier within SOLID_BLOCK_MAX_GAP_LEVELS on
  // at least one side (below, which may be the marginal, or above). A lone straggler
  // - a miner tier isolated by a wide 0-miner gap on BOTH sides - is skipped: the
  // API under-reports miners on tiers that are in fact filled, so an isolated miner
  // tier below a run of 0-miner tiers is noise, not the block the market is filling
  // into. `filled_prices[1]` is this tier (the cyan line, and the bid anchor when
  // "anchor on next filled tier" is on). Empty phantom slots and speed-only-no-miner
  // rows never appear here at all - they're not in `filled`. Without a known price
  // step we can't measure gaps, so we fall back to the literal next miner tier.
  let nextTier: number | null = null;
  for (let i = 1; i < minerTiers.length; i++) {
    const tier = minerTiers[i]!;
    if (priceStepBtc <= 0) {
      nextTier = tier; // no gap info: take the literal next miner tier
      break;
    }
    const emptyBelow = Math.round((tier - minerTiers[i - 1]!) / priceStepBtc) - 1;
    const upper = minerTiers[i + 1];
    const emptyAbove =
      upper !== undefined ? Math.round((upper - tier) / priceStepBtc) - 1 : Number.POSITIVE_INFINITY;
    if (emptyBelow <= SOLID_BLOCK_MAX_GAP_LEVELS || emptyAbove <= SOLID_BLOCK_MAX_GAP_LEVELS) {
      nextTier = tier; // has a miner tier close by -> starts a solid block
      break;
    }
    // else: lone straggler (wide gap on both sides) -> skip it
  }

  // Expose the marginal + the ladder from the chosen next tier up. No cap-clamp:
  // filled_prices is a faithful read of the miner-bearing book; the bid is capped
  // independently in decide().
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
