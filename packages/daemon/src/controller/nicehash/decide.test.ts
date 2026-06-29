import { describe, expect, it } from 'vitest';

import { decide } from './decide.js';
import type { NiceHashControllerConfig, NiceHashState, OwnedOrderSnapshot } from './types.js';

function config(over: Partial<NiceHashControllerConfig> = {}): NiceHashControllerConfig {
  return {
    market: 'EU',
    algorithm: 'SHA256',
    pool_id: 'pool-1',
    target_speed_units: 10,
    overpay_btc_per_unit_day: 0.00001,
    max_price_btc_per_unit_day: 0.001,
    max_overpay_vs_hashprice_btc_per_unit_day: null,
    order_budget_btc: 0.01,
    refill_amount_btc: 0.01,
    refill_when_runway_hours: 6,
    min_order_amount_btc: 0.001,
    price_edit_deadband_pct: 20,
    min_speed_limit_units: 0.01,
    price_down_step_btc: 0.0000001,
    cheap_threshold_pct: 0,
    cheap_target_speed_units: 0,
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
    last_price_decrease_at: null,
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

  it('caps the bid at the fee-adjusted break-even when capAtBreakEven is on', () => {
    // hashprice 0.0008, fees 3% + 1% => break-even 0.0008/1.04 ≈ 0.00076923.
    // anchor 0.0009 + overpay would be 0.00091, so the cap binds.
    const out = decide(
      state({
        market: { anchor_price_btc: 0.0009, total_speed_units: 100, thin: false },
        hashprice_btc_per_unit_day: 0.0008,
        config: config({
          nicehash_fee_pct: 3,
          pool_fee_pct: 1,
          cap_at_break_even: true,
          max_price_btc_per_unit_day: 1,
        }),
      }),
    );
    const p = out[0]!;
    if (p.kind !== 'CREATE_ORDER') throw new Error('expected CREATE_ORDER');
    expect(p.price_btc).toBeCloseTo(0.0008 / 1.04, 9);
  });

  it('does not cap at break-even when the toggle is off (anchor + overpay wins)', () => {
    const out = decide(
      state({
        market: { anchor_price_btc: 0.0009, total_speed_units: 100, thin: false },
        hashprice_btc_per_unit_day: 0.0008,
        config: config({
          nicehash_fee_pct: 3,
          pool_fee_pct: 1,
          cap_at_break_even: false,
          max_price_btc_per_unit_day: 1,
        }),
      }),
    );
    const p = out[0]!;
    if (p.kind !== 'CREATE_ORDER') throw new Error('expected CREATE_ORDER');
    expect(p.price_btc).toBeCloseTo(0.00091, 9);
  });

  it('ignores the break-even cap when hashprice is unavailable (graceful)', () => {
    const out = decide(
      state({
        market: { anchor_price_btc: 0.0009, total_speed_units: 100, thin: false },
        hashprice_btc_per_unit_day: null,
        config: config({
          nicehash_fee_pct: 3,
          pool_fee_pct: 1,
          cap_at_break_even: true,
          max_price_btc_per_unit_day: 1,
        }),
      }),
    );
    const p = out[0]!;
    if (p.kind !== 'CREATE_ORDER') throw new Error('expected CREATE_ORDER');
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
  it('edits price when drifted beyond the deadband', () => {
    const out = decide(state({ owned_orders: [ownedOrder({ price_btc: 0.0004 })] }));
    const kinds = out.map((p) => p.kind);
    expect(kinds).toContain('EDIT_PRICE');
    const edit = out.find((p) => p.kind === 'EDIT_PRICE');
    if (edit?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE');
    expect(edit.new_price_btc).toBeCloseTo(0.00051, 12);
  });

  it('does not edit price within the deadband', () => {
    // deadband = max(1e-7, 1e-5*0.2)=2e-6; drift 1e-6 < deadband
    const out = decide(state({ owned_orders: [ownedOrder({ price_btc: 0.000509 })] }));
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
