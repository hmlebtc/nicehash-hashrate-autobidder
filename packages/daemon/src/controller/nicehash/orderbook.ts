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

  // Orders currently receiving hashrate. Prefer the "Miners" count (`rigs_count`);
  // fall back to `accepted_speed_units` only when no rig counts are reported.
  const byRigs = valid.filter((o) => (o.rigs_count ?? 0) > 0);
  const bySpeed = valid.filter((o) => (o.accepted_speed_units ?? 0) > 0);
  const filled = byRigs.length > 0 ? byRigs : bySpeed;

  if (filled.length === 0) {
    // Nothing is being delivered to any competitor: no live competition to
    // outbid. With deliverable supply we can sit at the bottom of the book (or
    // the floor when the book is empty); with none, flag the market as thin.
    return {
      anchor_price_btc: lowest,
      total_speed_units: totalSpeedUnits,
      thin: !(totalSpeedUnits > 0),
      filled_prices: [],
    };
  }

  // NiceHash returns *individual* orders, so the marginal (and every other) price
  // is usually shared by many orders. Collapse into distinct price tiers.
  const tiers = [...new Set(filled.map((o) => o.price_btc))].sort((a, b) => a - b);
  const marginal = tiers[0]!; // cheapest filled tier = the marginal (NiceHash purple)

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
  let ladder = nextTier !== null ? tiers.filter((p) => p >= nextTier!) : [];
  // Only clamp the ladder when the cap sits *within* the book (above the
  // marginal): then an out-of-reach next tier collapses onto the cap. When the
  // WHOLE filled book is above the cap (marginal >= cap - the market is priced
  // past our break-even), clamping would drop every tier onto the cap and then
  // the `p > marginal` filter removes them all, blanking the next tier. In that
  // case we keep the real tiers so the dashboard still shows where the market is
  // filling (the bid is capped independently in decide(), so this is display-only).
  if (capBtc > 0 && capBtc > marginal) {
    ladder = ladder.map((p) => Math.min(p, capBtc)).filter((p) => p > marginal);
  }
  const filledPrices = [marginal, ...ladder].filter((p, i, a) => i === 0 || p !== a[i - 1]!);

  return {
    anchor_price_btc: marginal,
    total_speed_units: totalSpeedUnits,
    // "Thin" only when the target plainly exceeds the whole market's supply -
    // a best-effort flag; we still anchor at the floor and grab what we can.
    thin: totalSpeedUnits > 0 && targetUnits >= totalSpeedUnits,
    filled_prices: filledPrices,
  };
}
