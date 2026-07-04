/**
 * Pure decision function for the NiceHash control loop.
 *
 * Ported from the upstream Braiins controller (`controller/decide.ts`), which
 * keeps a single order alive and tracks the marketplace anchor + overpay
 * cushion, clamped to a safety ceiling. The NiceHash adaptations are:
 *
 *   - The anchor is the buyer-competition marginal price (see `orderbook.ts`),
 *     not Braiins' fillable ask.
 *   - Prices/speeds are BTC/unit/day and display-unit speeds, not sat/EH/day.
 *   - Orders escrow funds and drain, so there is a new REFILL_ORDER branch that
 *     tops the order up before its runway runs out (a Braiins bid had no
 *     escrow).
 *   - Edits go through `updatePriceAndLimit` (price and limit), mapped in
 *     `execute()`.
 *
 * Preserved from upstream: unknown-order -> PAUSE, keep-one-order (cancel
 * extras), price deadband to avoid edit spam, cheap-mode opportunistic
 * scale-up. The price-decrease cooldown / down-step clamp live in `gate.ts`.
 */

import { dynamicCapPrice, isActionableOrder, type NiceHashState, type Proposal } from './types.js';

function fmtPrice(btcPerUnitDay: number): string {
  return `${btcPerUnitDay.toFixed(8)} BTC/unit/day`;
}

/** Remaining runway of an order in hours at its current price × delivered speed. */
function runwayHours(availableBtc: number, priceBtc: number, speedUnits: number): number {
  if (availableBtc <= 0) return 0;
  const rateBtcPerDay = priceBtc * speedUnits;
  if (rateBtcPerDay <= 0) return Infinity;
  return (availableBtc / rateBtcPerDay) * 24;
}

export function decide(state: NiceHashState): readonly Proposal[] {
  // Unknown-order ambiguity trumps everything (mirrors upstream SPEC §9).
  if (state.unknown_orders.length > 0) {
    return [
      {
        kind: 'PAUSE',
        reason: `Unknown orders detected: ${state.unknown_orders.map((o) => o.order_id).join(', ')}`,
      },
    ];
  }

  const { config, owned_orders } = state;

  // Can't create or maintain an order without a registered pool.
  if (!config.pool_id) return [];

  // Need a market anchor to price anything.
  if (!state.market || state.market.anchor_price_btc === null) return [];

  // Hashprice is required when the dynamic cap is configured (don't silently
  // fall back to the fixed cap - that defeats the dynamic cap, per upstream #28).
  const hashprice = state.hashprice_btc_per_unit_day;
  const dynamicCapConfigured = config.max_overpay_vs_hashprice_btc_per_unit_day !== null;
  if (dynamicCapConfigured && hashprice === null) return [];

  const fixedCap = config.max_price_btc_per_unit_day;
  const premiumCap =
    dynamicCapConfigured && hashprice !== null
      ? hashprice + config.max_overpay_vs_hashprice_btc_per_unit_day!
      : null;
  let effectiveCap = premiumCap !== null ? Math.min(fixedCap, premiumCap) : fixedCap;

  // Dynamic price cap: the fee-adjusted, buffered hashprice - the most we can
  // pay and still keep the operator's profit buffer after NiceHash + pool fees.
  // Kept as a *backstop alongside* the fixed hard cap: effective cap = min(hard
  // cap, dynamic cap). Applies only when a hashprice is available, so a transient
  // oracle gap falls back to the hard cap rather than blocking bidding.
  const dynamicCap = config.dynamic_cap_enabled
    ? dynamicCapPrice(
        hashprice,
        config.nicehash_fee_pct,
        config.pool_fee_pct,
        config.dynamic_cap_buffer_btc,
      )
    : null;
  let cappedByDynamic = false;
  if (dynamicCap !== null && dynamicCap < effectiveCap) {
    effectiveCap = dynamicCap;
    cappedByDynamic = true;
  }

  const anchor = state.market.anchor_price_btc; // non-null per guard above
  const desired = anchor + config.overpay_btc_per_unit_day;
  const targetPrice = Math.min(desired, effectiveCap);
  const cappedByCeiling = desired > effectiveCap;

  // Cheap-mode opportunistic scale-up: when our bid is below cheap_threshold_pct%
  // of hashprice, grow the target speed. Controls speed only; pricing stays on
  // the anchor-tracking path.
  let effectiveTarget = config.target_speed_units;
  let cheapActive = false;
  if (
    config.cheap_threshold_pct > 0 &&
    config.cheap_target_speed_units > config.target_speed_units &&
    hashprice !== null &&
    hashprice > 0
  ) {
    const ourBid = anchor + config.overpay_btc_per_unit_day;
    if (ourBid < hashprice * (config.cheap_threshold_pct / 100)) {
      cheapActive = true;
      effectiveTarget = config.cheap_target_speed_units;
    }
  }
  const limitUnits = Math.max(config.min_speed_limit_units, effectiveTarget);

  // Deadband on EDIT_PRICE: only re-price when the move exceeds a fraction of
  // the overpay cushion (never below the price-down step the API would reject).
  const editDeadband = Math.max(
    config.price_down_step_btc,
    (config.overpay_btc_per_unit_day * config.price_edit_deadband_pct) / 100,
  );

  const capLabel = cappedByDynamic ? 'dynamic cap' : 'cap';
  const priceSuffix = cappedByCeiling
    ? ` (clamped to ${capLabel} ${fmtPrice(effectiveCap)})`
    : ` (anchor ${fmtPrice(anchor)} + overpay ${fmtPrice(config.overpay_btc_per_unit_day)})`;

  const actionable = owned_orders.filter(isActionableOrder);

  // No live order -> CREATE.
  if (actionable.length === 0) {
    let amountBtc: number;
    if (config.order_budget_btc <= 0) {
      // Use full available balance.
      if (state.balance_btc === null || state.balance_btc <= 0) return [];
      amountBtc = state.balance_btc;
    } else {
      amountBtc = config.order_budget_btc;
      if (state.balance_btc !== null) amountBtc = Math.min(amountBtc, state.balance_btc);
    }
    // Can't place below the NiceHash minimum.
    if (amountBtc < config.min_order_amount_btc) return [];

    return [
      {
        kind: 'CREATE_ORDER',
        price_btc: targetPrice,
        amount_btc: amountBtc,
        limit_units: limitUnits,
        pool_id: config.pool_id,
        reason: `create at ${fmtPrice(targetPrice)}${priceSuffix}${cheapActive ? ` · cheap mode ${effectiveTarget} units` : ''}`,
      },
    ];
  }

  const proposals: Proposal[] = [];

  // Keep one order - cancel extras (deterministic primary by id).
  const sorted = [...actionable].sort((a, b) => a.order_id.localeCompare(b.order_id));
  const [primary, ...extras] = sorted;
  if (!primary) return [];
  for (const extra of extras) {
    proposals.push({
      kind: 'CANCEL_ORDER',
      order_id: extra.order_id,
      reason: 'Multiple owned orders; keeping primary only',
    });
  }

  // Refill before the escrow runs dry. Use delivered speed when available
  // (it's what actually drains the order), else the configured limit.
  const drainSpeed = primary.accepted_speed_units > 0 ? primary.accepted_speed_units : primary.limit_units;
  const hours = runwayHours(primary.available_amount_btc, primary.price_btc, drainSpeed);
  if (
    config.refill_amount_btc > 0 &&
    hours < config.refill_when_runway_hours &&
    state.balance_btc !== null &&
    state.balance_btc > 0
  ) {
    const refill = Math.min(config.refill_amount_btc, state.balance_btc);
    if (refill >= config.min_order_amount_btc || refill === state.balance_btc) {
      proposals.push({
        kind: 'REFILL_ORDER',
        order_id: primary.order_id,
        amount_btc: refill,
        reason: `runway ${hours.toFixed(1)}h < ${config.refill_when_runway_hours}h; top up ${refill.toFixed(8)} BTC`,
      });
    }
  }

  // --- Floor-tracking price management --------------------------------------
  // The floor (anchor + overpay, capped) = `targetPrice` sits just above the
  // marginal (the cheapest order with miners), so it is the lowest bid that
  // still wins hashrate. We keep the bid hugging that floor:
  //
  //   - Above the floor (overpaying) -> walk DOWN toward it, one down-step at a
  //     time (the gate also throttles decreases to NiceHash's 10-min cooldown).
  //     This runs WHETHER OR NOT we're filled: the floor is above the marginal,
  //     so dropping to it never costs us our fill, and it stops us overpaying
  //     when the marginal falls. (This is the fix - previously walk-down only
  //     ran while "filled", so an under-filled order sat high and never followed
  //     the marginal down.)
  //   - Below the floor and under-filled -> walk UP to it (raises are free on
  //     NiceHash). When the order IS filled we do NOT chase a rising floor up:
  //     we hold the cheaper bid as long as the hashrate keeps coming.
  //   - With walk-up disabled, just track the floor both ways.
  const minFillPct = config.min_fill_pct ?? 100;
  const walkUpEnabled = config.walk_up_enabled ?? false;
  const fillThreshold = (effectiveTarget * minFillPct) / 100;
  const underFilled = primary.accepted_speed_units < fillThreshold;

  // Walk-up grace: only chase the price up once the order has been continuously
  // under-filled for at least this long, so a freshly placed or just-repriced
  // order gets time to attract miners before escalating (and walk-ups are paced -
  // the controller resets the timer on each upward move). 0 disables it. Tracked
  // across ticks via `under_filled_since`. Only gates real fill-chasing walk-ups;
  // pure floor-tracking (walk-up off) still climbs to the floor immediately.
  const graceMs = Math.max(0, (config.walk_up_grace_seconds ?? 0) * 1000);
  const gracePassed =
    graceMs === 0 ||
    (primary.under_filled_since != null && state.tick_at - primary.under_filled_since >= graceMs);
  const wantWalkUp = walkUpEnabled ? underFilled && gracePassed : true;

  const cur = primary.price_btc;
  const walkDownTo = Math.max(targetPrice, cur - config.price_down_step_btc);

  // A bid sitting ABOVE the effective cap is paying past break-even. Correct it
  // down regardless of the deadband: the deadband only exists to damp churn as
  // the bid hugs the floor, not to license overpaying above the ceiling. Without
  // this, a bid parked just over the cap (by less than one deadband) never walks
  // down - it stays above break-even indefinitely once the cap drops under it
  // (e.g. hashprice falls and the dynamic cap follows, but the bid doesn't).
  const overCap = cur - effectiveCap > 1e-9;

  let editTo = cur;
  let mode = '';
  if (cur - targetPrice >= editDeadband || overCap) {
    // Overpaying above the floor (or above the cap): walk down toward it
    // (filled or not). `walkDownTo` clamps to `targetPrice`, which is itself
    // <= effectiveCap, so this always steps the bid back toward break-even.
    editTo = walkDownTo;
    mode = overCap && cur - targetPrice < editDeadband ? 'walk down under cap' : 'walk down to floor';
  } else if (targetPrice - cur >= editDeadband && wantWalkUp) {
    // Below the floor: climb to it when under-filled and the grace has elapsed
    // (or always, if walk-up is off). When filled we skip this - hold the cheaper
    // bid, don't chase up.
    editTo = Math.min(effectiveCap, targetPrice);
    mode = 'walk up to floor';
  }

  if (Math.abs(editTo - cur) > 1e-12) {
    proposals.push({
      kind: 'EDIT_PRICE',
      order_id: primary.order_id,
      new_price_btc: editTo,
      old_price_btc: cur,
      reason: `${mode}: ${fmtPrice(cur)} -> ${fmtPrice(editTo)}${priceSuffix}`,
    });
  }

  // Limit edit when the (possibly cheap-mode) target speed changed.
  if (Math.abs(primary.limit_units - limitUnits) > 1e-9) {
    proposals.push({
      kind: 'EDIT_LIMIT',
      order_id: primary.order_id,
      new_limit_units: limitUnits,
      old_limit_units: primary.limit_units,
      reason: `target speed change: ${primary.limit_units} -> ${limitUnits} units${cheapActive ? ' (cheap mode)' : ''}`,
    });
  }

  return proposals;
}

export type { NiceHashState, Proposal };
