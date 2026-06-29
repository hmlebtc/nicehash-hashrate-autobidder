/**
 * NiceHash pricing-anchor computation - the buyer-competition analogue of
 * Braiins' `cheapestAskForDepth`.
 *
 * NiceHash has no ask book: there are only competing *buy* orders, and sellers
 * deliver their hashrate to the highest-priced live orders first. So the price
 * we must beat to get `target` delivered is the **marginal price** - the price
 * of the cheapest order that is *currently being filled*. NiceHash highlights
 * exactly this price in purple in its order book.
 *
 * We derive it from each competitor's `accepted_speed_units` (the speed it is
 * actually receiving), NOT its `limit` (its price-cap, which may be far larger
 * than what it draws). Placing a higher-priced order displaces the cheapest
 * filled orders and frees the hashrate they were getting, so to win `target`
 * we walk the *filled* orders cheapest -> dearest, accumulating their delivered
 * speed until it covers `target`; that order's price is the one to outbid.
 *
 * Using delivered speed (not the cap) is what fixes the "anchor pinned to the
 * top of the book" bug: an idle or over-capped high-priced order - a large
 * `limit` resting high but delivering ~nothing (e.g. a BUSINESS ceiling order)
 * - contributes 0 here and is ignored, instead of swallowing supply near the
 * top and dragging the anchor up.
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
  const target = Math.max(0, targetUnits);

  // Orders actually receiving hashrate define the live fill floor (NiceHash's
  // purple marginal). Walk them cheapest -> dearest, accumulating the speed
  // each delivers; the order at which the freed hashrate first covers `target`
  // is the price to beat. Idle / over-capped high orders draw 0 and drop out.
  const filled = valid
    .filter((o) => (o.accepted_speed_units ?? 0) > 0)
    .sort((a, b) => a.price_btc - b.price_btc);

  if (filled.length > 0) {
    let freed = 0;
    for (const o of filled) {
      freed += o.accepted_speed_units ?? 0;
      if (freed >= target) {
        return { anchor_price_btc: o.price_btc, total_speed_units: totalSpeedUnits, thin: false };
      }
    }
    // Even displacing every filled order can't free the full target: we cannot
    // win all of it. Outbid the dearest filled order to grab what supply allows.
    return {
      anchor_price_btc: filled[filled.length - 1]!.price_btc,
      total_speed_units: totalSpeedUnits,
      thin: true,
    };
  }

  // Nothing is being delivered to any competitor: no live competition to
  // outbid. With deliverable supply we can sit at the bottom of the book (or
  // the floor when the book is empty); with none, flag the market as thin.
  return {
    anchor_price_btc: lowest,
    total_speed_units: totalSpeedUnits,
    thin: !(totalSpeedUnits > 0),
  };
}
