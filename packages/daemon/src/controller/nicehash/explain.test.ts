import { describe, expect, it } from 'vitest';

import { decide } from './decide.js';
import { explainTick, formatHoldReason, formatRemaining } from './explain.js';
import { gate } from './gate.js';
import type { NiceHashControllerConfig, NiceHashState, OwnedOrderSnapshot } from './types.js';

const NOW = 1_700_000_000_000;
const COOLDOWN = 10 * 60_000;

// The live-scenario fixture family (floor 0.4788, cap 0.4825) shared with the
// escalation suite in decide.test.ts.
function config(over: Partial<NiceHashControllerConfig> = {}): NiceHashControllerConfig {
  return {
    market: 'EU',
    algorithm: 'SHA256',
    pool_id: 'pool-1',
    pool_user: '',
    target_speed_units: 10,
    overpay_btc_per_unit_day: 0.0001,
    max_price_btc_per_unit_day: 0.4825,
    max_overpay_vs_hashprice_btc_per_unit_day: null,
    order_budget_btc: 0.01,
    refill_amount_btc: 0,
    refill_when_runway_hours: 6,
    min_order_amount_btc: 0.001,
    min_speed_limit_units: 0.01,
    price_down_step_btc: 0.002,
    min_fill_pct: 80,
    walk_up_enabled: true,
    walk_up_grace_seconds: 180,
    escalation_step_btc: 0.0002,
    escalation_interval_seconds: 60,
    cheap_threshold_pct: 0,
    cheap_target_speed_units: 0,
    ...over,
  };
}

function order(over: Partial<OwnedOrderSnapshot> = {}): OwnedOrderSnapshot {
  return {
    order_id: 'o1',
    price_btc: 0.4788,
    limit_units: 10,
    amount_btc: 0.01,
    available_amount_btc: 0.01,
    payed_amount_btc: 0,
    accepted_speed_units: 0,
    status: 'ACTIVE',
    pool_username: null,
    last_price_decrease_at: null,
    last_price_change_at: null,
    ...over,
  };
}

function state(over: Partial<NiceHashState> = {}): NiceHashState {
  return {
    tick_at: NOW,
    run_mode: 'LIVE',
    config: config(),
    market: {
      anchor_price_btc: 0.4787,
      total_speed_units: 100,
      thin: false,
      filled_prices: [0.4787],
    },
    balance_btc: 1,
    owned_orders: [order()],
    unknown_orders: [],
    hashprice_btc_per_unit_day: null,
    ...over,
  };
}

/** Run the real decide + gate pipeline and explain the result. */
function explain(s: NiceHashState, cooldownMs = COOLDOWN) {
  const proposals = decide(s);
  const gated = gate(proposals, s, { priceDecreaseCooldownMs: cooldownMs });
  return {
    proposals,
    hold: explainTick({ state: s, proposals, gated, priceDecreaseCooldownMs: cooldownMs }),
  };
}

describe('explainTick - hold reasons', () => {
  it('DECREASE_COOLDOWN: a held walk-down carries the intended move + the API deadline', () => {
    // Filled at an escalated-decayed target below the bid -> walk-down
    // proposed; the API-truth clock says not yet.
    const s = state({
      owned_orders: [
        order({
          price_btc: 0.4804,
          accepted_speed_units: 10, // filled
          escalation_offset_btc: 0.0014, // decayed target 0.4802
          escalation_last_step_at: NOW - 1000,
          decrease_available_at: NOW + 149_000,
        }),
      ],
    });
    const { hold } = explain(s);
    expect(hold?.kind).toBe('DECREASE_COOLDOWN');
    expect(hold?.until).toBe(NOW + 149_000);
    expect(hold?.from_btc).toBeCloseTo(0.4804, 9);
    expect(hold?.to_btc).toBeCloseTo(0.4802, 9);
    expect(hold?.label).toContain('walk down');
  });

  it('GRACE_WAIT: under-filled with the grace running counts down to the grace end', () => {
    const s = state({
      owned_orders: [
        order({ under_filled_since: NOW - 60_000 }), // grace 180s: 120s left
      ],
    });
    const { proposals, hold } = explain(s);
    expect(proposals).toEqual([]); // decide holds (grace gates the climb)
    expect(hold?.kind).toBe('GRACE_WAIT');
    expect(hold?.until).toBe(NOW - 60_000 + 180_000);
  });

  it('ESCALATION_STEP_WAIT: engaged ladder at its rung counts down to the next step', () => {
    const s = state({
      owned_orders: [
        order({
          price_btc: 0.479, // at floor 0.4788 + offset 0.0002
          under_filled_since: NOW - 30 * 60_000, // grace long passed
          escalation_offset_btc: 0.0002,
          escalation_last_step_at: NOW - 20_000, // interval 60s: 40s left
        }),
      ],
    });
    const { proposals, hold } = explain(s);
    expect(proposals).toEqual([]);
    expect(hold?.kind).toBe('ESCALATION_STEP_WAIT');
    expect(hold?.until).toBe(NOW - 20_000 + 60_000);
    expect(hold?.step_btc).toBeCloseTo(0.0002, 10);
  });

  it('AT_CAP_UNDERFILLED: ladder at the cap with no room left holds with no timer', () => {
    const s = state({
      owned_orders: [
        order({
          price_btc: 0.4825, // at the cap
          under_filled_since: NOW - 30 * 60_000,
          escalation_offset_btc: 0.0038, // raw >= room 0.0037
          escalation_last_step_at: NOW - 20_000,
        }),
      ],
    });
    const { proposals, hold } = explain(s);
    expect(proposals).toEqual([]);
    expect(hold?.kind).toBe('AT_CAP_UNDERFILLED');
    expect(hold?.until).toBeNull();
  });

  it('MARKET_ABOVE_CAP: whole book above the cap, bid parked at the cap', () => {
    const s = state({
      market: {
        anchor_price_btc: 0.49,
        total_speed_units: 100,
        thin: false,
        filled_prices: [0.49],
      },
      owned_orders: [order({ price_btc: 0.4825 })], // already at the cap
    });
    const { proposals, hold } = explain(s);
    expect(proposals).toEqual([]);
    expect(hold?.kind).toBe('MARKET_ABOVE_CAP');
  });

  it('FILLED_ESCALATED: filled at an escalated price counts down to the next probe (decay vs cooldown, later wins)', () => {
    const s = state({
      owned_orders: [
        order({
          price_btc: 0.4804,
          accepted_speed_units: 10, // filled
          escalation_offset_btc: 0.0016, // bid == floor + offset -> no proposal
          escalation_last_step_at: NOW - 60_000, // decay window (10 min) not elapsed
          decrease_available_at: NOW + 200_000, // API says even later
        }),
      ],
    });
    const { proposals, hold } = explain(s);
    expect(proposals).toEqual([]);
    expect(hold?.kind).toBe('FILLED_ESCALATED');
    // later of decay (lastStep + 10 min) and the API clock
    expect(hold?.until).toBe(Math.max(NOW - 60_000 + COOLDOWN, NOW + 200_000));
  });

  it('AT_TARGET: filled, in-band at the floor - a plain hold', () => {
    const s = state({
      owned_orders: [order({ price_btc: 0.4788, accepted_speed_units: 10 })],
    });
    const { proposals, hold } = explain(s);
    expect(proposals).toEqual([]);
    expect(hold?.kind).toBe('AT_TARGET');
    expect(hold?.escalated).toBe(false);
  });

  it('is observability-only: explaining never perturbs decide()', () => {
    const s = state({
      owned_orders: [order({ under_filled_since: NOW - 60_000 })],
    });
    const before = decide(s);
    explain(s);
    const after = decide(s);
    expect(after).toEqual(before);
  });

  it('stays silent when a proposal already tells the story', () => {
    // Under-filled past grace, below target -> a walk-up proposal exists.
    const s = state({
      owned_orders: [
        order({ price_btc: 0.478, under_filled_since: NOW - 30 * 60_000 }),
      ],
    });
    const { proposals, hold } = explain(s);
    expect(proposals.length).toBeGreaterThan(0);
    expect(hold).toBeNull();
  });
});

describe('formatHoldReason - live countdown', () => {
  it('renders m:ss and counts DOWN between two request times', () => {
    const hold = {
      kind: 'DECREASE_COOLDOWN' as const,
      until: NOW + 149_000,
      from_btc: 0.4825,
      to_btc: 0.4824,
      label: 'walk down (de-escalating)',
    };
    const at0 = formatHoldReason(hold, NOW);
    const at60 = formatHoldReason(hold, NOW + 60_000);
    expect(at0).toBe(
      'walk down (de-escalating) 0.4825 -> 0.4824 — waiting on NiceHash decrease cooldown, ~2:29 remaining',
    );
    expect(at60).toBe(
      'walk down (de-escalating) 0.4825 -> 0.4824 — waiting on NiceHash decrease cooldown, ~1:29 remaining',
    );
  });

  it('clamps an expired countdown at 0:00 and formats every kind', () => {
    expect(formatRemaining(NOW - 5000, NOW)).toBe('0:00');
    expect(formatHoldReason({ kind: 'GRACE_WAIT', until: NOW + 90_000 }, NOW)).toBe(
      'under-filled — walk-up/escalation opens in 1:30 (grace)',
    );
    expect(
      formatHoldReason({ kind: 'ESCALATION_STEP_WAIT', until: NOW + 40_000, step_btc: 0.0002 }, NOW),
    ).toBe('escalating — next step (+0.0002) in 0:40');
    expect(formatHoldReason({ kind: 'AT_CAP_UNDERFILLED', until: null }, NOW)).toBe(
      'at dynamic cap — market clears above break-even; holding',
    );
    expect(formatHoldReason({ kind: 'MARKET_ABOVE_CAP', until: null }, NOW)).toBe(
      'market above cap — holding at the cap, ready if it dips',
    );
    expect(formatHoldReason({ kind: 'FILLED_ESCALATED', until: NOW + 305_000 }, NOW)).toBe(
      'filled at escalated price — next probe down in ~5:05',
    );
    expect(formatHoldReason({ kind: 'AT_TARGET', until: null, escalated: true }, NOW)).toBe(
      'holding — at escalated target',
    );
    expect(formatHoldReason({ kind: 'AT_TARGET', until: null, escalated: false }, NOW)).toBe(
      'holding — at target (anchor + overpay)',
    );
    expect(formatHoldReason(null, NOW)).toBeNull();
  });
});
