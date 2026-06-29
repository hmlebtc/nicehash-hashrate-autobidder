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

  // The marginal price = the cheapest order currently receiving hashrate
  // (NiceHash's purple). Prefer the "Miners" count (`rigs_count`); fall back to
  // `accepted_speed_units` only when no rig counts are reported at all.
  const byRigs = valid.filter((o) => (o.rigs_count ?? 0) > 0);
  const bySpeed = valid.filter((o) => (o.accepted_speed_units ?? 0) > 0);
  const filled = byRigs.length > 0 ? byRigs : bySpeed;
  // The fill ladder: ascending prices of every order currently winning hashrate.
  const filledPrices = filled.map((o) => o.price_btc).sort((a, b) => a - b);

  if (filledPrices.length > 0) {
    return {
      anchor_price_btc: filledPrices[0]!, // cheapest filled = marginal (purple)
      total_speed_units: totalSpeedUnits,
      // "Thin" only when the target plainly exceeds the whole market's supply -
      // a best-effort flag; we still anchor at the floor and grab what we can.
      thin: totalSpeedUnits > 0 && targetUnits >= totalSpeedUnits,
      filled_prices: filledPrices,
    };
  }

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
