import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NiceHashClient } from '@hashrate-autopilot/nicehash-client';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../../state/db.js';
import { NiceHashOrdersRepo } from '../../state/repos/nicehash_orders.js';
import type { NiceHashService } from '../../services/nicehash-service.js';
import { NiceHashController } from './controller.js';
import { decide } from './decide.js';
import { explainTick, formatHoldReason } from './explain.js';
import { gate } from './gate.js';
import {
  effectiveDecreaseAvailableAt,
  type NiceHashControllerConfig,
  type NiceHashState,
  type OwnedOrderSnapshot,
} from './types.js';

// ---- 2026-07-13 incident: EXECUTED decrease 21:58:14 (stamps BOTH ledger
// columns), EXECUTED raise 22:04:39 (change stamp; in-memory clock armed to
// 22:14:39), six 500-FAILED raises 22:07-22:12, BLOCKED walk-downs ~22:13.
// The dashboard showed "~0:00 remaining" - the EXPIRED 21:58:14+10min
// decrease-stamp clock - while the gate correctly held until 22:14:39. The
// countdown must be the gate's own clock, by construction.
const T_DECREASE = Date.parse('2026-07-13T21:58:14Z');
const T_RAISE = Date.parse('2026-07-13T22:04:39Z');
const T_BLOCKED = Date.parse('2026-07-13T22:13:03Z');
const COOLDOWN = 10 * 60_000;
const OUTAGE_500 =
  'NiceHash API POST /main/api/v2/hashpower/order/mine/updatePriceAndLimit/ returned 500 - 2999: Generic Server Error';

function config(): NiceHashControllerConfig {
  return {
    market: 'EU',
    algorithm: 'SHA256ASICBOOST',
    pool_id: 'pool-1',
    pool_user: '',
    target_speed_units: 4,
    overpay_btc_per_unit_day: 0.0001,
    max_price_btc_per_unit_day: 1,
    max_overpay_vs_hashprice_btc_per_unit_day: null,
    order_budget_btc: 0.01,
    refill_amount_btc: 0,
    refill_when_runway_hours: 6,
    min_order_amount_btc: 0.001,
    min_speed_limit_units: 0.1,
    price_down_step_btc: 0.002,
    min_fill_pct: 80,
    walk_up_enabled: true,
    walk_up_grace_seconds: 180,
    escalation_step_btc: 0.0002,
    escalation_interval_seconds: 60,
    cheap_threshold_pct: 0,
    cheap_target_speed_units: 0,
  };
}

// Under-filled order; book anchor 0.4820 -> floor 0.4821.
const myOrder = {
  id: 'mine',
  status: { code: 'ACTIVE' },
  price: '0.4827',
  limit: '4',
  amount: '0.01',
  availableAmount: '0.01',
  acceptedCurrentSpeed: '0',
};
function service(): NiceHashService {
  return {
    getAlgorithmSetting: vi.fn(async () => ({
      algorithm: 'SHA256ASICBOOST',
      marketFactor: '1000000000000000',
      displayMarketFactor: 'PH',
    })),
    getMyOrders: vi.fn(async () => ({ list: [myOrder] })),
    getOrder: vi.fn(async () => myOrder),
    getOrderBook: vi.fn(async () => ({
      stats: {
        BTC: {
          totalSpeed: '100',
          orders: [{ id: 'rival', price: '0.4820', limit: '5', rigsCount: 10, alive: true }],
        },
      },
    })),
    getAccountBalance: vi.fn(async () => ({ currency: 'TBTC', totalBalance: '0', available: '0' })),
  } as unknown as NiceHashService;
}

function pureState(order: OwnedOrderSnapshot): NiceHashState {
  return {
    tick_at: T_BLOCKED,
    run_mode: 'LIVE',
    config: config(),
    market: {
      anchor_price_btc: 0.482,
      total_speed_units: 100,
      thin: false,
      filled_prices: [0.482],
    },
    balance_btc: 0,
    owned_orders: [order],
    unknown_orders: [],
    hashprice_btc_per_unit_day: null,
  };
}
const baseOrder: OwnedOrderSnapshot = {
  order_id: 'mine',
  price_btc: 0.4827,
  limit_units: 4,
  amount_btc: 0.01,
  available_amount_btc: 0.01,
  payed_amount_btc: 0,
  accepted_speed_units: 0,
  status: 'ACTIVE',
  pool_username: null,
  last_price_decrease_at: null,
  last_price_change_at: null,
};

describe('incident repro: blocked walk-down countdown must equal the gate', () => {
  let handle: DatabaseHandle;
  let ledger: NiceHashOrdersRepo;

  beforeEach(async () => {
    myOrder.price = '0.4827';
    handle = await openDatabase({ path: ':memory:' });
    ledger = new NiceHashOrdersRepo(handle.db);
    await ledger.insert({
      order_id: 'mine',
      created_at: T_DECREASE - 3600_000,
      price_btc: 0.482,
      amount_btc: 0.01,
      limit_units: 4,
      pool_id: 'pool-1',
    });
    // The 21:58:14 EXECUTED decrease (stamps BOTH ledger columns) - the clock
    // the incident dashboard wrongly counted down (expired at 22:08:14).
    await ledger.setLastPriceDecrease('mine', T_DECREASE, 0.482);
    // The 22:04:39 EXECUTED raise (change stamp only).
    await ledger.setLastPriceChange('mine', T_RAISE, 0.4827);
  });
  afterEach(async () => {
    await closeDatabase(handle);
  });

  const make = (t: () => number, cli?: NiceHashClient, cfg?: NiceHashControllerConfig) =>
    new NiceHashController({
      service: service(),
      client:
        cli ?? ({ updatePriceAndLimit: vi.fn(async () => ({})) } as unknown as NiceHashClient),
      ledger,
      config: cfg ?? config(),
      currency: 'BTC',
      balanceCurrency: 'TBTC',
      runMode: () => 'LIVE',
      now: t,
    });

  it('NO restart: armed at the raise; 500-FAILED raises never re-arm; blocked at +8:24 counts ~1:36', async () => {
    const updatePriceAndLimit = vi
      .fn()
      .mockResolvedValueOnce({}) // the arming raise
      .mockRejectedValue(new Error(OUTAGE_500)); // the outage: every later attempt 500s
    const cli = { updatePriceAndLimit } as unknown as NiceHashClient;
    let t = T_RAISE;
    // Pure floor-tracking (walk-up off) keeps the ladder out of the picture:
    // the raises still fire and fail exactly like the incident's.
    const controller = make(() => t, cli, { ...config(), walk_up_enabled: false });

    // The 22:04:39 raise executes (bid below the floor) and arms the clock.
    myOrder.price = '0.4820';
    const r0 = await controller.tick();
    expect(r0.outcomes.find((o) => o.proposal.kind === 'EDIT_PRICE')?.outcome).toBe('EXECUTED');

    // The six-in-a-row incident: raises keep FAILING with 500s. None of these
    // may re-arm the decrease clock (no price change happened).
    for (const dt of [160_000, 200_000, 260_000, 320_000, 380_000, 440_000]) {
      t = T_RAISE + dt;
      const r = await controller.tick();
      const o = r.outcomes.find((x) => x.proposal.kind === 'EDIT_PRICE');
      expect(o?.outcome).toBe('FAILED');
    }

    // 22:13:03-equivalent: bid reads 0.4827, walk-down proposed -> BLOCKED,
    // and the countdown is the GATE's clock: raise + 10 min, ~1:36 remaining.
    myOrder.price = '0.4827';
    t = T_BLOCKED;
    const r = await controller.tick();
    const o = r.outcomes.find((x) => x.proposal.kind === 'EDIT_PRICE');
    expect(o?.outcome).toBe('BLOCKED');
    expect(r.hold_reason?.kind).toBe('DECREASE_COOLDOWN');
    expect(r.hold_reason?.until).toBe(T_RAISE + COOLDOWN); // NOT re-armed by the FAILED raises
    const line = formatHoldReason(r.hold_reason, T_BLOCKED);
    expect(line).toContain('~1:36 remaining');
    expect(line).not.toContain('0:00');
  });

  it('RESTART (the incident): fresh maps, same ledger - countdown is the raise clock, never the expired decrease stamp', async () => {
    // Fresh controller = wiped in-memory clock, exactly the 0.6.50 restart.
    const controller = make(() => T_BLOCKED);
    const r = await controller.tick();
    const o = r.outcomes.find((x) => x.proposal.kind === 'EDIT_PRICE');
    expect(o?.outcome).toBe('BLOCKED');
    // Ledger fallback = max(decrease 21:58:14, change 22:04:39) + 10 min.
    expect(r.hold_reason?.until).toBe(T_RAISE + COOLDOWN);
    const line = formatHoldReason(r.hold_reason, T_BLOCKED);
    expect(line).toContain('~1:36 remaining');
    // The incident string - the expired 21:58:14+10min clock reads 0:00 -
    // must never be shown while the gate holds.
    expect(line).not.toContain('0:00');
  });

  it('invariant: whenever the gate blocks a decrease, the countdown is the gate clock and > 0:00 (map / fallback / fresh boot)', () => {
    const variants: ReadonlyArray<[string, Partial<OwnedOrderSnapshot>]> = [
      // (a) API-truth map value present, stale decrease stamp (incident shape).
      [
        'armed map + expired decrease stamp',
        {
          decrease_available_at: T_RAISE + COOLDOWN,
          last_price_decrease_at: T_DECREASE,
          last_price_change_at: null,
        },
      ],
      // (b) map wiped (restart), both ledger stamps.
      [
        'ledger fallback',
        {
          decrease_available_at: null,
          last_price_decrease_at: T_DECREASE,
          last_price_change_at: T_RAISE,
        },
      ],
      // (c) fresh boot, only a recent raise stamp.
      ['raise stamp only', { decrease_available_at: null, last_price_change_at: T_RAISE }],
    ];
    for (const [label, over] of variants) {
      const order = { ...baseOrder, ...over };
      const state = pureState(order);
      const proposals = decide(state);
      const gated = gate(proposals, state, { priceDecreaseCooldownMs: COOLDOWN });
      const blocked = gated.find((g) => !g.allowed && g.reason === 'PRICE_DECREASE_COOLDOWN');
      expect(blocked, label).toBeDefined();
      const hold = explainTick({ state, proposals, gated, priceDecreaseCooldownMs: COOLDOWN });
      expect(hold?.kind, label).toBe('DECREASE_COOLDOWN');
      // The countdown is the gate's own clock - strictly in the future while
      // the gate holds.
      expect(hold!.until, label).toBe(effectiveDecreaseAvailableAt(order, COOLDOWN));
      expect(hold!.until!, label).toBeGreaterThan(T_BLOCKED);
      expect(formatHoldReason(hold, T_BLOCKED), label).not.toContain('~0:00');
    }
  });

  it("devil's advocate: when the API clock contradicts the stamps, gate and story agree (both open)", () => {
    // NiceHash says available NOW despite a fresh raise stamp: the decrease
    // sails through and no cooldown story is told - never a mixed message.
    const order: OwnedOrderSnapshot = {
      ...baseOrder,
      last_price_change_at: T_BLOCKED - 60_000, // raised 1 min ago...
      decrease_available_at: T_BLOCKED - 1, // ...but the API-truth clock says go
    };
    const state = pureState(order);
    const proposals = decide(state);
    const gated = gate(proposals, state, { priceDecreaseCooldownMs: COOLDOWN });
    const edit = gated.find((g) => g.proposal.kind === 'EDIT_PRICE');
    expect(edit?.allowed).toBe(true);
    const hold = explainTick({ state, proposals, gated, priceDecreaseCooldownMs: COOLDOWN });
    expect(hold).toBeNull();
  });
});
