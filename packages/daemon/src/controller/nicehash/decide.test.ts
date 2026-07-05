import { describe, expect, it } from 'vitest';

import { decide } from './decide.js';
import type { NiceHashControllerConfig, NiceHashState, OwnedOrderSnapshot } from './types.js';

function config(over: Partial<NiceHashControllerConfig> = {}): NiceHashControllerConfig {
  return {
    market: 'EU',
    algorithm: 'SHA256',
    pool_id: 'pool-1',
    pool_user: '',
    target_speed_units: 10,
    overpay_btc_per_unit_day: 0.00001,
    max_price_btc_per_unit_day: 0.001,
    max_overpay_vs_hashprice_btc_per_unit_day: null,
    order_budget_btc: 0.01,
    refill_amount_btc: 0.01,
    refill_when_runway_hours: 6,
    min_order_amount_btc: 0.001,
    min_speed_limit_units: 0.01,
    price_down_step_btc: 0.0000001,
    cheap_threshold_pct: 0,
    cheap_target_speed_units: 0,
    dynamic_cap_enabled: false,
    ...over,
  };
}

function state(over: Partial<NiceHashState> = {}): NiceHashState {
  return {
    tick_at: 1700000000000,
    run_mode: 'LIVE',
    config: config(),
    market: { anchor_price_btc: 0.0005, total_speed_units: 100, thin: false },
    balance_btc: 1,
    owned_orders: [],
    unknown_orders: [],
    hashprice_btc_per_unit_day: 0.0008,
    ...over,
  };
}

function ownedOrder(over: Partial<OwnedOrderSnapshot> = {}): OwnedOrderSnapshot {
  return {
    order_id: 'order-a',
    price_btc: 0.00051,
    limit_units: 10,
    amount_btc: 0.01,
    available_amount_btc: 0.01,
    payed_amount_btc: 0,
    accepted_speed_units: 10,
    status: 'ACTIVE',
    pool_username: null,
    last_price_decrease_at: null,
    last_price_change_at: null,
    ...over,
  };
}

describe('decide - guards', () => {
  it('PAUSEs on unknown orders', () => {
    const out = decide(state({ unknown_orders: [{ order_id: 'x', price_btc: 0.0005 }] }));
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('PAUSE');
  });

  it('does nothing without a registered pool', () => {
    expect(decide(state({ config: config({ pool_id: '' }) }))).toEqual([]);
  });

  it('does nothing without a market anchor', () => {
    expect(decide(state({ market: null }))).toEqual([]);
    expect(
      decide(state({ market: { anchor_price_btc: null, total_speed_units: 0, thin: true } })),
    ).toEqual([]);
  });

  it('refuses to trade when the dynamic cap is set but hashprice is unknown', () => {
    const out = decide(
      state({
        config: config({ max_overpay_vs_hashprice_btc_per_unit_day: 0.0001 }),
        hashprice_btc_per_unit_day: null,
      }),
    );
    expect(out).toEqual([]);
  });
});

describe('decide - create', () => {
  it('creates an order at anchor + overpay, clamped, with budget and limit', () => {
    const out = decide(state());
    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(p.kind).toBe('CREATE_ORDER');
    if (p.kind !== 'CREATE_ORDER') throw new Error('unreachable');
    expect(p.price_btc).toBeCloseTo(0.00051, 12);
    expect(p.amount_btc).toBe(0.01);
    expect(p.limit_units).toBe(10);
    expect(p.pool_id).toBe('pool-1');
  });

  it('uses full balance when order_budget_btc is 0', () => {
    const out = decide(state({ config: config({ order_budget_btc: 0 }), balance_btc: 0.05 }));
    const p = out[0]!;
    if (p.kind !== 'CREATE_ORDER') throw new Error('expected CREATE_ORDER');
    expect(p.amount_btc).toBe(0.05);
  });

  it('does not create when affordable amount is below the NiceHash minimum', () => {
    expect(decide(state({ balance_btc: 0.0005, config: config({ order_budget_btc: 0 }) }))).toEqual(
      [],
    );
  });

  it('clamps the price to the fixed ceiling', () => {
    const out = decide(
      state({
        market: { anchor_price_btc: 0.002, total_speed_units: 100, thin: false },
        config: config({ max_price_btc_per_unit_day: 0.001 }),
      }),
    );
    const p = out[0]!;
    if (p.kind !== 'CREATE_ORDER') throw new Error('expected CREATE_ORDER');
    expect(p.price_btc).toBe(0.001);
  });

  it('caps the bid at the dynamic cap (hashprice / (1 + fees) − buffer) when enabled', () => {
    // hashprice 0.0008, fees 3% + 1% = 4%, buffer 0 => cap = 0.0008 / 1.04 (fees are
    // a markup on the bid, so cap × 1.04 = hashprice). anchor 0.0009 + overpay would
    // be 0.00091, so the cap binds.
    const out = decide(
      state({
        market: { anchor_price_btc: 0.0009, total_speed_units: 100, thin: false },
        hashprice_btc_per_unit_day: 0.0008,
        config: config({
          nicehash_fee_pct: 3,
          pool_fee_pct: 1,
          dynamic_cap_enabled: true,
          max_price_btc_per_unit_day: 1,
        }),
      }),
    );
    const p = out[0]!;
    if (p.kind !== 'CREATE_ORDER') throw new Error('expected CREATE_ORDER');
    expect(p.price_btc).toBeCloseTo(0.0008 / 1.04, 9);
  });

  it('subtracts the absolute profit buffer from the dynamic cap', () => {
    // cap = 0.0008 / 1.04 − 0.00005.
    const out = decide(
      state({
        market: { anchor_price_btc: 0.0009, total_speed_units: 100, thin: false },
        hashprice_btc_per_unit_day: 0.0008,
        config: config({
          nicehash_fee_pct: 3,
          pool_fee_pct: 1,
          dynamic_cap_enabled: true,
          dynamic_cap_buffer_btc: 0.00005,
          max_price_btc_per_unit_day: 1,
        }),
      }),
    );
    const p = out[0]!;
    if (p.kind !== 'CREATE_ORDER') throw new Error('expected CREATE_ORDER');
    expect(p.price_btc).toBeCloseTo(0.0008 / 1.04 - 0.00005, 9);
  });

  it('does not apply the dynamic cap when disabled (anchor + overpay wins)', () => {
    const out = decide(
      state({
        market: { anchor_price_btc: 0.0009, total_speed_units: 100, thin: false },
        hashprice_btc_per_unit_day: 0.0008,
        config: config({
          nicehash_fee_pct: 3,
          pool_fee_pct: 1,
          dynamic_cap_enabled: false,
          max_price_btc_per_unit_day: 1,
        }),
      }),
    );
    const p = out[0]!;
    if (p.kind !== 'CREATE_ORDER') throw new Error('expected CREATE_ORDER');
    expect(p.price_btc).toBeCloseTo(0.00091, 9);
  });

  it('falls back to the hard cap when the dynamic cap is enabled but hashprice is unavailable', () => {
    const out = decide(
      state({
        market: { anchor_price_btc: 0.0009, total_speed_units: 100, thin: false },
        hashprice_btc_per_unit_day: null,
        config: config({
          nicehash_fee_pct: 3,
          pool_fee_pct: 1,
          dynamic_cap_enabled: true,
          max_price_btc_per_unit_day: 1,
        }),
      }),
    );
    const p = out[0]!;
    if (p.kind !== 'CREATE_ORDER') throw new Error('expected CREATE_ORDER');
    // No hashprice -> dynamic cap inactive -> hard cap (1) doesn't bind -> anchor+overpay.
    expect(p.price_btc).toBeCloseTo(0.00091, 9);
  });

  it('engages cheap mode to scale the speed target up', () => {
    const out = decide(
      state({ config: config({ cheap_threshold_pct: 90, cheap_target_speed_units: 50 }) }),
    );
    const p = out[0]!;
    if (p.kind !== 'CREATE_ORDER') throw new Error('expected CREATE_ORDER');
    // ourBid 0.00051 < 0.0008*0.9=0.00072 -> cheap mode on -> limit 50
    expect(p.limit_units).toBe(50);
  });

  it('treats a terminal-status owned order as no live order (re-creates)', () => {
    const out = decide(state({ owned_orders: [ownedOrder({ status: 'DEAD' })] }));
    expect(out[0]?.kind).toBe('CREATE_ORDER');
  });
});

describe('decide - maintain', () => {
  it('edits price when drifted at least one price step from the floor', () => {
    const out = decide(state({ owned_orders: [ownedOrder({ price_btc: 0.0004 })] }));
    const kinds = out.map((p) => p.kind);
    expect(kinds).toContain('EDIT_PRICE');
    const edit = out.find((p) => p.kind === 'EDIT_PRICE');
    if (edit?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE');
    expect(edit.new_price_btc).toBeCloseTo(0.00051, 12);
  });

  it('does not edit price for a sub-price-step drift', () => {
    // reprice threshold = one price step (0.0000001); drift 0.00000005 < a step,
    // so the bid holds (no % deadband any more - it re-prices on any full step).
    const out = decide(state({ owned_orders: [ownedOrder({ price_btc: 0.00050995 })] }));
    expect(out.find((p) => p.kind === 'EDIT_PRICE')).toBeUndefined();
  });

  it('edits the limit when the target speed changed', () => {
    const out = decide(state({ owned_orders: [ownedOrder({ limit_units: 4 })] }));
    const edit = out.find((p) => p.kind === 'EDIT_LIMIT');
    if (edit?.kind !== 'EDIT_LIMIT') throw new Error('expected EDIT_LIMIT');
    expect(edit.new_limit_units).toBe(10);
  });

  it('refills when the order runway drops below the threshold', () => {
    // available 0.001 at price 0.0005 x speed 10 = 0.005/day -> 4.8h < 6h
    const out = decide(
      state({ owned_orders: [ownedOrder({ available_amount_btc: 0.001, price_btc: 0.0005 })] }),
    );
    const refill = out.find((p) => p.kind === 'REFILL_ORDER');
    if (refill?.kind !== 'REFILL_ORDER') throw new Error('expected REFILL_ORDER');
    expect(refill.amount_btc).toBe(0.01);
  });

  it('does not refill when runway is comfortable', () => {
    const out = decide(state({ owned_orders: [ownedOrder()] }));
    expect(out.find((p) => p.kind === 'REFILL_ORDER')).toBeUndefined();
  });

  it('cancels extra owned orders, keeping the lowest id as primary', () => {
    const out = decide(
      state({
        owned_orders: [
          ownedOrder({ order_id: 'order-b' }),
          ownedOrder({ order_id: 'order-a' }),
        ],
      }),
    );
    const cancels = out.filter((p) => p.kind === 'CANCEL_ORDER');
    expect(cancels).toHaveLength(1);
    if (cancels[0]?.kind !== 'CANCEL_ORDER') throw new Error('expected CANCEL_ORDER');
    expect(cancels[0].order_id).toBe('order-b');
  });
});

describe('decide - track to fill', () => {
  const T = 1_700_000_000_000;
  // A fill ladder with a gap: filled tiers at 0.0005 / 0.0007 / 0.0009.
  const market = (over = {}) => ({
    anchor_price_btc: 0.0005,
    total_speed_units: 100,
    thin: false,
    filled_prices: [0.0005, 0.0007, 0.0009],
    ...over,
  });

  it('walks up to the floor (marginal + overpay) when under-filled and below it', () => {
    // cur 0.0004 < floor (anchor 0.0005 + overpay 0.00001 = 0.00051); under-filled
    // (5 < 80% of 10) -> climb to the floor.
    const out = decide(
      state({
        market: market(),
        owned_orders: [ownedOrder({ price_btc: 0.0004, accepted_speed_units: 5 })],
        config: config({ walk_up_enabled: true, min_fill_pct: 80, max_price_btc_per_unit_day: 1 }),
      }),
    );
    const e = out.find((p) => p.kind === 'EDIT_PRICE');
    if (e?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE');
    expect(e.new_price_btc).toBeCloseTo(0.00051, 9);
  });

  it('walks DOWN toward the floor when under-filled and overpaying (follows the marginal down)', () => {
    // The operator's case: bid 0.0009 sits well above the floor 0.00051 but is
    // delivering ~0. We must still step down toward the floor, not stay high.
    const out = decide(
      state({
        market: market({ filled_prices: [0.0005] }),
        owned_orders: [ownedOrder({ price_btc: 0.0009, accepted_speed_units: 0 })],
        config: config({
          walk_up_enabled: true,
          min_fill_pct: 80,
          max_price_btc_per_unit_day: 1,
          price_down_step_btc: 0.0000001,
        }),
      }),
    );
    const e = out.find((p) => p.kind === 'EDIT_PRICE');
    if (e?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE');
    expect(e.new_price_btc).toBeCloseTo(0.0009 - 0.0000001, 10);
  });

  it('walks up every tick while under-filled when the grace is disabled (default 0)', () => {
    // With no grace configured, even immediately after a price change an
    // under-filled order below the floor climbs again (raises are unconstrained).
    const out = decide(
      state({
        tick_at: T,
        market: market(),
        owned_orders: [
          ownedOrder({ price_btc: 0.0004, accepted_speed_units: 5, last_price_change_at: T - 1_000 }),
        ],
        config: config({ walk_up_enabled: true, min_fill_pct: 80, max_price_btc_per_unit_day: 1 }),
      }),
    );
    const e = out.find((p) => p.kind === 'EDIT_PRICE');
    if (e?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE');
    expect(e.new_price_btc).toBeCloseTo(0.00051, 9);
  });

  it('holds (no walk up) while under-filled until the grace period elapses', () => {
    const out = decide(
      state({
        tick_at: T,
        market: market(),
        owned_orders: [
          ownedOrder({ price_btc: 0.0004, accepted_speed_units: 5, under_filled_since: T - 60_000 }),
        ],
        config: config({
          walk_up_enabled: true,
          min_fill_pct: 80,
          max_price_btc_per_unit_day: 1,
          walk_up_grace_seconds: 180,
        }),
      }),
    );
    // under-filled for only 60s of a 180s grace -> hold.
    expect(out.find((p) => p.kind === 'EDIT_PRICE')).toBeUndefined();
  });

  it('walks up once the under-filled grace period has elapsed', () => {
    const out = decide(
      state({
        tick_at: T,
        market: market(),
        owned_orders: [
          ownedOrder({ price_btc: 0.0004, accepted_speed_units: 5, under_filled_since: T - 200_000 }),
        ],
        config: config({
          walk_up_enabled: true,
          min_fill_pct: 80,
          max_price_btc_per_unit_day: 1,
          walk_up_grace_seconds: 180,
        }),
      }),
    );
    const e = out.find((p) => p.kind === 'EDIT_PRICE');
    if (e?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE');
    expect(e.new_price_btc).toBeCloseTo(0.00051, 9);
  });

  it('still walks DOWN during the grace (grace only gates climbing, not floor-tracking down)', () => {
    const out = decide(
      state({
        tick_at: T,
        market: market({ filled_prices: [0.0005] }),
        owned_orders: [
          ownedOrder({ price_btc: 0.0009, accepted_speed_units: 0, under_filled_since: T - 1_000 }),
        ],
        config: config({
          walk_up_enabled: true,
          min_fill_pct: 80,
          max_price_btc_per_unit_day: 1,
          walk_up_grace_seconds: 180,
          price_down_step_btc: 0.0000001,
        }),
      }),
    );
    const e = out.find((p) => p.kind === 'EDIT_PRICE');
    if (e?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE');
    expect(e.new_price_btc).toBeCloseTo(0.0009 - 0.0000001, 10);
  });

  it('does NOT walk up while filled, even when the floor rises above our bid', () => {
    // Filled (delivered 10 >= 80% of target 10 = 8) and the floor climbed above
    // our bid: we keep the cheaper bid and only climb once we lose fill.
    const out = decide(
      state({
        market: market({ anchor_price_btc: 0.0008, filled_prices: [0.0008, 0.0009] }),
        owned_orders: [ownedOrder({ price_btc: 0.0006, accepted_speed_units: 10 })],
        config: config({ walk_up_enabled: true, min_fill_pct: 80, max_price_btc_per_unit_day: 1 }),
      }),
    );
    expect(out.find((p) => p.kind === 'EDIT_PRICE')).toBeUndefined();
  });

  it('walks down toward the floor when filled and overpaying (track-to-fill)', () => {
    const out = decide(
      state({
        market: market({ filled_prices: [0.0005] }),
        owned_orders: [ownedOrder({ price_btc: 0.0009, accepted_speed_units: 10 })],
        config: config({
          walk_up_enabled: true,
          min_fill_pct: 80,
          max_price_btc_per_unit_day: 1,
          price_down_step_btc: 0.0000001,
        }),
      }),
    );
    const e = out.find((p) => p.kind === 'EDIT_PRICE');
    if (e?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE');
    expect(e.new_price_btc).toBeCloseTo(0.0009 - 0.0000001, 10);
  });

  it('holds when under-filled and already sitting at the floor (within deadband)', () => {
    // cur == floor (0.00051): nothing to do - we're already at the lowest filled
    // bid, just waiting for the fill to land.
    const out = decide(
      state({
        market: market(),
        owned_orders: [ownedOrder({ price_btc: 0.00051, accepted_speed_units: 5 })],
        config: config({ walk_up_enabled: true, min_fill_pct: 80, max_price_btc_per_unit_day: 1 }),
      }),
    );
    expect(out.find((p) => p.kind === 'EDIT_PRICE')).toBeUndefined();
  });

  it('walks a bid parked a sub-price-step above the cap down to break-even', () => {
    // The operator's 6h-flat case: the dynamic cap fell under the bid (hashprice
    // dropped) so the bid ends up OVER the cap by less than one price step. The
    // normal floor-tracking walk-down needs a full-step drift, so only the
    // over-cap bypass (paying above break-even is never OK) moves it back down.
    const out = decide(
      state({
        market: market({ anchor_price_btc: 0.4556, filled_prices: [0.4556] }),
        owned_orders: [ownedOrder({ price_btc: 0.45423, accepted_speed_units: 0 })],
        config: config({
          walk_up_enabled: true,
          min_fill_pct: 80,
          // Fixed cap high; the dynamic cap (below) is what bites.
          max_price_btc_per_unit_day: 1,
          dynamic_cap_enabled: true,
          nicehash_fee_pct: 3,
          pool_fee_pct: 1,
          dynamic_cap_buffer_btc: 0,
          overpay_btc_per_unit_day: 0.0001,
          price_down_step_btc: 0.0001,
        }),
        // cap = hashprice / (1 + 4%) = 0.472348 / 1.04 = 0.4541808; bid 0.45423 is
        // ~0.0000492 over it - smaller than the 0.0001 price step, so the normal
        // walk-down stays silent and only the over-cap bypass fires.
        hashprice_btc_per_unit_day: 0.472348,
      }),
    );
    const e = out.find((p) => p.kind === 'EDIT_PRICE');
    if (e?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE');
    // walkDownTo clamps to the cap (target), so it lands exactly at break-even.
    expect(e.new_price_btc).toBeCloseTo(0.472348 / 1.04, 8);
    expect(e.new_price_btc).toBeLessThan(0.45423);
  });

  it('caps the walk-up at the price ceiling', () => {
    // Floor would be anchor 0.001 + overpay 0.00001 = 0.00101, but the cap is
    // 0.00095, so we climb only to the cap.
    const out = decide(
      state({
        market: market({ anchor_price_btc: 0.001, filled_prices: [0.001] }),
        owned_orders: [ownedOrder({ price_btc: 0.0005, accepted_speed_units: 5 })],
        config: config({ walk_up_enabled: true, min_fill_pct: 80, max_price_btc_per_unit_day: 0.00095 }),
      }),
    );
    const e = out.find((p) => p.kind === 'EDIT_PRICE');
    if (e?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE');
    expect(e.new_price_btc).toBeCloseTo(0.00095, 9);
  });

  it('steps the bid down toward the floor by at most one price-down step when filled', () => {
    // Filled, sitting at 0.0009, floor 0.00051: a single move drops by the
    // algorithm down-step (0.0000001), not all the way to the floor.
    const out = decide(
      state({
        market: market({ filled_prices: [0.0005] }),
        owned_orders: [ownedOrder({ price_btc: 0.0009, accepted_speed_units: 10 })],
        config: config({ max_price_btc_per_unit_day: 1, price_down_step_btc: 0.0000001 }),
      }),
    );
    const e = out.find((p) => p.kind === 'EDIT_PRICE');
    if (e?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE');
    expect(e.new_price_btc).toBeCloseTo(0.0009 - 0.0000001, 10);
  });
});

describe('decide - anchor on the next filled tier', () => {
  // Fill ladder with a gap: marginal 0.0005, next tier 0.0007, then 0.0009.
  const market = (over = {}) => ({
    anchor_price_btc: 0.0005,
    total_speed_units: 100,
    thin: false,
    filled_prices: [0.0005, 0.0007, 0.0009],
    ...over,
  });

  it('CREATEs at the next tier + overpay when enabled', () => {
    const out = decide(
      state({
        owned_orders: [],
        market: market(),
        config: config({ anchor_next_filled_tier: true, max_price_btc_per_unit_day: 1 }),
      }),
    );
    const p = out[0]!;
    if (p.kind !== 'CREATE_ORDER') throw new Error('expected CREATE_ORDER');
    // next tier 0.0007 + overpay 0.00001 = 0.00071 (not marginal 0.0005 + overpay)
    expect(p.price_btc).toBeCloseTo(0.00071, 9);
  });

  it('falls back to the marginal when there is no distinct second tier', () => {
    const out = decide(
      state({
        owned_orders: [],
        market: market({ filled_prices: [0.0005] }),
        config: config({ anchor_next_filled_tier: true, max_price_btc_per_unit_day: 1 }),
      }),
    );
    const p = out[0]!;
    if (p.kind !== 'CREATE_ORDER') throw new Error('expected CREATE_ORDER');
    expect(p.price_btc).toBeCloseTo(0.00051, 9); // marginal 0.0005 + overpay
  });

  it('walks up from marginal+overpay to next-tier+overpay (the stuck-bid case)', () => {
    // Bid sat at marginal(0.0005)+overpay(0.00001)=0.00051, under-filled. Anchored
    // on the marginal it would hold there forever (target == current). Anchored on
    // the next tier (0.0007) the target becomes 0.00071, so it walks UP into the
    // fill zone - the fix for "the bid never walks up or down".
    const out = decide(
      state({
        market: market(),
        owned_orders: [ownedOrder({ price_btc: 0.00051, accepted_speed_units: 0 })],
        config: config({
          anchor_next_filled_tier: true,
          walk_up_enabled: true,
          min_fill_pct: 80,
          max_price_btc_per_unit_day: 1,
        }),
      }),
    );
    const e = out.find((p) => p.kind === 'EDIT_PRICE');
    if (e?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE');
    expect(e.new_price_btc).toBeCloseTo(0.00071, 9);
  });

  it('walks DOWN when the next tier falls (tracks the tier both ways)', () => {
    // Bid at 0.00071 (next-tier 0.0007 + overpay). The next tier drops to 0.0006,
    // so the target falls to 0.00061 and the bid steps down toward it.
    const out = decide(
      state({
        market: market({ filled_prices: [0.0005, 0.0006, 0.0009] }),
        owned_orders: [ownedOrder({ price_btc: 0.00071, accepted_speed_units: 0 })],
        config: config({
          anchor_next_filled_tier: true,
          walk_up_enabled: true,
          min_fill_pct: 80,
          max_price_btc_per_unit_day: 1,
          price_down_step_btc: 0.0000001,
        }),
      }),
    );
    const e = out.find((p) => p.kind === 'EDIT_PRICE');
    if (e?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE');
    expect(e.new_price_btc).toBeCloseTo(0.00071 - 0.0000001, 10); // one step down toward 0.00061
  });

  it('anchors on the marginal when the toggle is off (default in the pure controller)', () => {
    const out = decide(
      state({
        owned_orders: [],
        market: market(),
        config: config({ max_price_btc_per_unit_day: 1 }), // anchor_next_filled_tier unset
      }),
    );
    const p = out[0]!;
    if (p.kind !== 'CREATE_ORDER') throw new Error('expected CREATE_ORDER');
    expect(p.price_btc).toBeCloseTo(0.00051, 9); // marginal 0.0005 + overpay
  });
});
