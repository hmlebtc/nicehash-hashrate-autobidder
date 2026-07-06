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
 * "Multiple consecutive orders of 0 miners" = a run of at least this many empty
 * price levels between two filled tiers. Prices are quantized to the market's
 * price step, so the empty levels between two filled tiers = round(gap / step) - 1.
 * A run this long marks a real gap in the book (the boundary between the marginal's
 * block and the next block); a shorter gap is just the marginal's own cluster.
 */
const EMPTY_GAP_LEVELS = 2;

export function computeMarketAnchor(
  competitors: readonly CompetingOrder[],
  totalSpeedUnits: number,
  targetUnits: number,
  priceStepBtc = 0,
  capBtc = 0,
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

  // The fill ladder ABOVE the marginal, built from price position - every valid
  // order priced at/above the marginal, not just the ones the API tagged with
  // rigs/speed. NiceHash delivers hashrate in strict *descending* price order, so
  // any live order priced above the marginal is itself being filled (it sits
  // ahead of the marginal in the delivery queue). We can't rely on the per-order
  // rigs/speed signal up here: the order-book API reports it too sparsely, so a
  // large, obviously-filled block (e.g. NiceHash's UI shows ~9,800 miners) can
  // come back with 0/undefined rigs AND speed. A rigs/speed-only ladder drops
  // that block, skips the real next tier, and reports the next *detectable* tier
  // further up - which then clamps onto the cap and reads as a phantom next tier.
  // Price position never drops a real block. (The marginal above is still found
  // via rigs/speed - only the tiers above it switch to price position.)
  const tiers = [...new Set(valid.filter((o) => o.price_btc >= marginal).map((o) => o.price_btc))].sort(
    (a, b) => a - b,
  );

  // The "next filled tier" we anchor on. By default the next distinct tier (a
  // simple de-dupe of the marginal). When we know the price step, we instead jump
  // any gap of >= EMPTY_GAP_LEVELS empty price levels: walk up through the tiers
  // that hug the marginal (small gaps) and stop at the first tier sitting above a
  // real gap - the next block a human reads off the order book, past the run of
  // 0-miner levels. Falls back to the next distinct tier on a contiguous book.
  let nextTier: number | null = tiers.length > 1 ? tiers[1]! : null;
  if (priceStepBtc > 0 && tiers.length > 1) {
    let jumped: number | null = null;
    for (let i = 1; i < tiers.length; i++) {
      const emptyLevels = Math.round((tiers[i]! - tiers[i - 1]!) / priceStepBtc) - 1;
      if (emptyLevels >= EMPTY_GAP_LEVELS) {
        jumped = tiers[i]!;
        break;
      }
    }
    nextTier = jumped ?? tiers[1]!;
  }

  // Expose the marginal + the ladder from the chosen next tier up (tiers between
  // the marginal and next tier are the marginal's own cluster - not "the next
  // tier" - so they're dropped from the ladder). `filled_prices[1]` = next tier.
  //
  // Bound the ladder at our bidding ceiling when one is supplied: we never bid
  // above the cap, so a next tier sitting above it is out of reach. This collapses
  // a far book jump (e.g. a momentarily contiguous low book whose first real
  // >= EMPTY_GAP_LEVELS gap sits ~0.05 up the book) back onto the cap, so the
  // reported next filled tier - and the bid it anchors - stays pinned at the cap
  // instead of charting an absurd price we could never actually pay.
  // Prices carrying real activity (an order that rests volume, wins miners, or
  // delivers speed) - as opposed to an empty/cancelled 0-volume slot that still
  // shows up in the book. Used only to rein the above-cap next tier below.
  const realTierPrices = new Set(
    valid
      .filter((o) => o.limit_units > 0 || (o.rigs_count ?? 0) > 0 || (o.accepted_speed_units ?? 0) > 0)
      .map((o) => o.price_btc),
  );

  let ladder = nextTier !== null ? tiers.filter((p) => p >= nextTier!) : [];
  if (capBtc > 0 && capBtc > marginal) {
    // Cap sits *within* the book (above the marginal): an out-of-reach next tier
    // collapses onto the cap so the reported tier - and the bid it anchors - stays
    // pinned at the cap instead of charting an absurd price we could never pay.
    ladder = ladder.map((p) => Math.min(p, capBtc)).filter((p) => p > marginal);
  } else if (capBtc > 0 && marginal >= capBtc && nextTier !== null) {
    // The WHOLE filled book is above the cap (the market is priced past our
    // break-even). We can't clamp to the cap - it sits below the marginal, so the
    // clamp above would drop every tier and blank the next tier. But we also must
    // not let the gap-jump overshoot onto a far straggler: when the low book is
    // momentarily contiguous below a wide empty gap, the jump lands ~0.05 up the
    // book (the "blue line shoots to 0.49xx" artifact). Rein the next tier to the
    // nearest order above the marginal that has *real activity* (volume, miners,
    // or delivered speed) so the tile tracks the market's next real step, not a
    // phantom far tier. The bid is capped in decide() regardless - display-only.
    const nearestReal = tiers.find((p) => p > marginal && realTierPrices.has(p));
    ladder = nearestReal !== undefined ? tiers.filter((p) => p >= nearestReal) : [];
  }
  const filledPrices = [marginal, ...ladder].filter((p, i, a) => i === 0 || p !== a[i - 1]!);

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
