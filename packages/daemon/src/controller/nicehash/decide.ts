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

import { breakEvenPrice, isActionableOrder, type NiceHashState, type Proposal } from './types.js';

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
  const dynamicCap =
    dynamicCapConfigured && hashprice !== null
      ? hashprice + config.max_overpay_vs_hashprice_btc_per_unit_day!
      : null;
  let effectiveCap = dynamicCap !== null ? Math.min(fixedCap, dynamicCap) : fixedCap;

  // Fee-adjusted break-even ceiling: bid + NiceHash fee + pool fee must not
  // exceed what the rented hashrate earns (the hashprice). Gated behind the
  // master `use_break_even` switch AND the `cap_at_break_even` knob; applies
  // only when a hashprice is available, so a transient oracle gap never blocks
  // bidding.
  const breakEven = config.use_break_even
    ? breakEvenPrice(hashprice, config.nicehash_fee_pct, config.pool_fee_pct)
    : null;
  let cappedByBreakEven = false;
  if (config.use_break_even && config.cap_at_break_even && breakEven !== null && breakEven < effectiveCap) {
    effectiveCap = breakEven;
    cappedByBreakEven = true;
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

  const capLabel = cappedByBreakEven ? 'break-even' : 'cap';
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

  // --- Track-to-fill price management ---------------------------------------
  // Baseline is the floor (anchor + overpay, capped) = `targetPrice`. When the
  // order is under-filled we walk the bid UP to just above the next filled order
  // on the book (the next tier with miners) + overpay - climbing the fill ladder
  // a tier at a time. Raises are unconstrained on NiceHash, so we escalate every
  // tick we're under-filled (no settle window). When filled and sitting above the
  // floor we step the bid DOWN toward it - by at most one `price_down_step_btc`
  // per move (the gate additionally throttles decreases to the 10-minute
  // cooldown), so a large drop is never sent in one illegal jump.
  const minFillPct = config.min_fill_pct ?? 100;
  const walkUpEnabled = config.walk_up_enabled ?? false;
  const fillThreshold = (effectiveTarget * minFillPct) / 100;
  const underFilled = primary.accepted_speed_units < fillThreshold;
  const cur = primary.price_btc;

  // Escalation target: jump to just above the cheapest filled order priced above
  // us (the next tier to outbid) + overpay, capped. Gaps of unfilled orders are
  // skipped - only orders with miners define a tier worth climbing to.
  const nextFilledAbove = (state.market.filled_prices ?? []).find((p) => p > cur);
  const escalateTo =
    nextFilledAbove !== undefined
      ? Math.min(effectiveCap, nextFilledAbove + config.overpay_btc_per_unit_day)
      : cur;
  const escalating = walkUpEnabled && underFilled && escalateTo > cur;

  let editTo = cur;
  let mode = '';
  if (escalating) {
    editTo = escalateTo; // intentional walk-up; bypasses the deadband
    mode = 'walk up to fill';
  } else if (walkUpEnabled) {
    // Track-to-fill mode. We only ever walk UP while under-filled. Crucially,
    // when we ARE filled we do NOT chase the floor up: a risen floor (the
    // marginal moving above our bid) is fine as long as we keep getting our
    // hashrate - we hold the cheaper bid and only start climbing again once we
    // fall under-filled. So:
    if (underFilled) {
      // No higher filled tier to climb to (escalation didn't fire): only raise
      // to the floor if it climbed above us; never lower while we still want
      // more hashrate.
      if (targetPrice - cur >= editDeadband) {
        editTo = Math.min(effectiveCap, targetPrice);
        mode = 'track anchor up';
      }
    } else if (cur - targetPrice >= editDeadband) {
      // Filled and overpaying (the floor dropped below us): walk DOWN toward the
      // floor by at most one down-step (the gate also throttles decreases to the
      // 10-minute cooldown), so a big drop is never sent in one illegal jump.
      editTo = Math.max(targetPrice, cur - config.price_down_step_btc);
      mode = 'walk down to floor';
    }
    // Filled and at/below the floor within the deadband: hold.
  } else if (Math.abs(cur - targetPrice) >= editDeadband) {
    // Walk-up disabled: pure floor-tracking, both ways, deadband-gated.
    if (targetPrice > cur) {
      editTo = Math.min(effectiveCap, targetPrice);
      mode = 'track anchor up';
    } else {
      editTo = Math.max(targetPrice, cur - config.price_down_step_btc);
      mode = 'walk down to floor';
    }
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
