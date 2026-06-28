/**
 * NiceHash pricing-anchor computation - the buyer-competition analogue of
 * Braiins' `cheapestAskForDepth`.
 *
 * Braiins exposes ask-side *supply*; the controller found the cheapest price
 * with enough supply for the target and bid just above it. NiceHash is the
 * opposite shape: there is no ask book, only competing *buy* orders plus the
 * total deliverable speed in the market. Sellers deliver to the highest-priced
 * live orders first, so the price we must beat to get `target` delivered is the
 * **marginal price**: walk competitors from the highest price down, subtracting
 * the speed each would consume; the competitor at which the supply still left
 * would drop below `target` sets the price we have to outbid.
 *
 * The caller must pass *competitors only* (our own resting order excluded) and
 * the market's `totalSpeed`. The result feeds `decide()`, which adds the
 * overpay cushion and clamps to the safety ceiling.
 *
 * This is the one piece whose exact behaviour depends on NiceHash's
 * undocumented seller-allocation and wants live/testnet validation; the model
 * here is the documented best understanding and is bounded by the safety caps.
 */

import type { CompetingOrder, MarketAnchor } from './types.js';

export function computeMarketAnchor(
  competitors: readonly CompetingOrder[],
  totalSpeedUnits: number,
  targetUnits: number,
): MarketAnchor {
  const valid = competitors
    .filter(
      (o) =>
        Number.isFinite(o.price_btc) &&
        o.price_btc > 0 &&
        Number.isFinite(o.limit_units) &&
        o.limit_units >= 0,
    )
    .sort((a, b) => b.price_btc - a.price_btc);

  const highest = valid.length > 0 ? valid[0]!.price_btc : null;
  const lowest = valid.length > 0 ? valid[valid.length - 1]!.price_btc : null;

  // No deliverable supply: nothing to position against. Best effort is to sit
  // above the top of the book (thin).
  if (!(totalSpeedUnits > 0)) {
    return { anchor_price_btc: highest, total_speed_units: 0, thin: true };
  }

  // Target exceeds all supply: we can never get the full target, so bid above
  // the top to grab as much as exists (thin).
  if (targetUnits >= totalSpeedUnits) {
    return { anchor_price_btc: highest, total_speed_units: totalSpeedUnits, thin: true };
  }

  // Walk competitors high -> low, consuming supply. The competitor that would
  // push the remaining supply below `target` is the one to outbid.
  let remaining = totalSpeedUnits;
  for (const o of valid) {
    const consume = o.limit_units === 0 ? remaining : Math.min(o.limit_units, remaining);
    if (remaining - consume < targetUnits) {
      return { anchor_price_btc: o.price_btc, total_speed_units: totalSpeedUnits, thin: false };
    }
    remaining -= consume;
    if (remaining <= 0) {
      return { anchor_price_btc: o.price_btc, total_speed_units: totalSpeedUnits, thin: false };
    }
  }

  // Spare supply remains even after every competitor: we can be filled at the
  // bottom of the book. Sit just above the cheapest rival (or null with no
  // competitors - caller falls back to a floor).
  return { anchor_price_btc: lowest, total_speed_units: totalSpeedUnits, thin: false };
}
