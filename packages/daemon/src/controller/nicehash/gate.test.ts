import { describe, expect, it } from 'vitest';

import { gate } from './gate.js';
import type { NiceHashControllerConfig, NiceHashState, OwnedOrderSnapshot, Proposal, RunMode } from './types.js';

const COOLDOWN = 10 * 60_000;

function config(): NiceHashControllerConfig {
  return {
    market: 'EU',
    algorithm: 'SHA256ASICBOOST',
    pool_id: 'pool-1',
    target_speed_units: 10,
    overpay_btc_per_unit_day: 0.00001,
    max_price_btc_per_unit_day: 1,
    max_overpay_vs_hashprice_btc_per_unit_day: null,
    order_budget_btc: 0.01,
    refill_amount_btc: 0.01,
    refill_when_runway_hours: 6,
    min_order_amount_btc: 0.001,
    min_speed_limit_units: 0.1,
    price_down_step_btc: 0.0001,
    cheap_threshold_pct: 0,
    cheap_target_speed_units: 0,
  };
}

function state(runMode: RunMode, owned: OwnedOrderSnapshot[] = [], tickAt = 1_000_000): NiceHashState {
  return {
    tick_at: tickAt,
    run_mode: runMode,
    config: config(),
    market: { anchor_price_btc: 0.01, total_speed_units: 100, thin: false },
    balance_btc: 1,
    owned_orders: owned,
    unknown_orders: [],
    hashprice_btc_per_unit_day: null,
  };
}

const editDown: Proposal = {
  kind: 'EDIT_PRICE',
  order_id: 'o1',
  new_price_btc: 0.009,
  old_price_btc: 0.01,
  reason: 'r',
};
const editUp: Proposal = { ...editDown, new_price_btc: 0.011 };
const create: Proposal = {
  kind: 'CREATE_ORDER',
  price_btc: 0.01,
  amount_btc: 0.01,
  limit_units: 10,
  pool_id: 'pool-1',
  reason: 'r',
};

function ownedAt(lastDecrease: number | null): OwnedOrderSnapshot {
  return {
    order_id: 'o1',
    price_btc: 0.01,
    limit_units: 10,
    amount_btc: 0.01,
    available_amount_btc: 0.01,
    payed_amount_btc: 0,
    accepted_speed_units: 10,
    status: 'ACTIVE',
    last_price_decrease_at: lastDecrease,
    last_price_change_at: lastDecrease,
  };
}

describe('gate - run mode', () => {
  it('denies all marketplace mutations in DRY_RUN', () => {
    const out = gate([create], state('DRY_RUN'), { priceDecreaseCooldownMs: COOLDOWN });
    expect(out[0]?.allowed).toBe(false);
    if (out[0]?.allowed === false) expect(out[0].reason).toBe('RUN_MODE_NOT_LIVE');
  });

  it('denies with RUN_MODE_PAUSED when paused', () => {
    const out = gate([create], state('PAUSED'), { priceDecreaseCooldownMs: COOLDOWN });
    if (out[0]?.allowed === false) expect(out[0].reason).toBe('RUN_MODE_PAUSED');
    else throw new Error('expected denial');
  });

  it('always allows PAUSE through', () => {
    const out = gate([{ kind: 'PAUSE', reason: 'x' }], state('DRY_RUN'), {
      priceDecreaseCooldownMs: COOLDOWN,
    });
    expect(out[0]?.allowed).toBe(true);
  });

  it('allows mutations when LIVE', () => {
    const out = gate([create], state('LIVE'), { priceDecreaseCooldownMs: COOLDOWN });
    expect(out[0]?.allowed).toBe(true);
  });
});

describe('gate - price-decrease cooldown', () => {
  it('denies an EDIT_PRICE decrease inside the cooldown window', () => {
    // last decrease 1 min ago, cooldown 10 min -> still inside
    const s = state('LIVE', [ownedAt(1_000_000 - 60_000)]);
    const out = gate([editDown], s, { priceDecreaseCooldownMs: COOLDOWN });
    if (out[0]?.allowed === false) expect(out[0].reason).toBe('PRICE_DECREASE_COOLDOWN');
    else throw new Error('expected cooldown denial');
  });

  it('allows an EDIT_PRICE decrease after the cooldown', () => {
    const s = state('LIVE', [ownedAt(1_000_000 - 11 * 60_000)]);
    const out = gate([editDown], s, { priceDecreaseCooldownMs: COOLDOWN });
    expect(out[0]?.allowed).toBe(true);
  });

  it('always allows price raises regardless of cooldown', () => {
    const s = state('LIVE', [ownedAt(1_000_000 - 60_000)]);
    const out = gate([editUp], s, { priceDecreaseCooldownMs: COOLDOWN });
    expect(out[0]?.allowed).toBe(true);
  });
});

describe('gate - decrease cooldown counts ANY price change (NiceHash rule)', () => {
  it('denies a decrease within the cooldown of a RAISE (the 400/5061 case)', () => {
    // Only the last-change stamp is recent (a ladder climb); the last-decrease
    // stamp is ancient. NiceHash rejects decreases within 10 min of ANY price
    // change, so the gate must too - previously this sailed through to a
    // guaranteed 400 "5061: ... not allowed within 10 minutes of last price
    // change".
    const s = state('LIVE', [
      {
        ...ownedAt(null),
        last_price_decrease_at: null,
        last_price_change_at: 1_000_000 - 60_000, // raised 1 min ago
      },
    ]);
    const out = gate([editDown], s, { priceDecreaseCooldownMs: COOLDOWN });
    if (out[0]?.allowed === false) expect(out[0].reason).toBe('PRICE_DECREASE_COOLDOWN');
    else throw new Error('expected cooldown denial');
  });

  it('allows a decrease once BOTH stamps are older than the cooldown', () => {
    const s = state('LIVE', [
      {
        ...ownedAt(1_000_000 - 12 * 60_000),
        last_price_change_at: 1_000_000 - 11 * 60_000,
      },
    ]);
    const out = gate([editDown], s, { priceDecreaseCooldownMs: COOLDOWN });
    expect(out[0]?.allowed).toBe(true);
  });

  it('the API-truth clock (decrease_available_at) overrides the derived stamps', () => {
    // NiceHash said "Seconds till available: 30" -> available at 1_000_030_000,
    // even though the derived stamps would say the window has long passed...
    const blocked = state('LIVE', [
      {
        ...ownedAt(1_000_000 - 30 * 60_000),
        decrease_available_at: 1_000_000 + 30_000,
      },
    ]);
    const b = gate([editDown], blocked, { priceDecreaseCooldownMs: COOLDOWN });
    if (b[0]?.allowed === false) expect(b[0].reason).toBe('PRICE_DECREASE_COOLDOWN');
    else throw new Error('expected cooldown denial');

    // ...and the reverse: the API says available NOW, even though a recent
    // raise stamp would have derived a block. The API's answer wins.
    const allowed = state('LIVE', [
      {
        ...ownedAt(null),
        last_price_change_at: 1_000_000 - 60_000,
        decrease_available_at: 1_000_000 - 1,
      },
    ]);
    expect(gate([editDown], allowed, { priceDecreaseCooldownMs: COOLDOWN })[0]?.allowed).toBe(true);
  });

  it('raises stay unthrottled even with the API-truth clock in the future', () => {
    const s = state('LIVE', [
      { ...ownedAt(1_000_000 - 1000), decrease_available_at: 1_000_000 + 600_000 },
    ]);
    expect(gate([editUp], s, { priceDecreaseCooldownMs: COOLDOWN })[0]?.allowed).toBe(true);
  });
});
