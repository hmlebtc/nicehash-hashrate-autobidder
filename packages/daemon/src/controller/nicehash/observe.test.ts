import { describe, expect, it, vi } from 'vitest';

import type { NiceHashService } from '../../services/nicehash-service.js';
import { decide } from './decide.js';
import {
  applyTierHysteresis,
  initialTierHysteresis,
  initialZeroRigStreaks,
  observe,
  TIER_UP_CONFIRM_TICKS,
  ZERO_RIG_CONFIRM_READS,
  type TierHysteresisState,
  type ZeroRigStreakState,
} from './observe.js';
import { computeMarketAnchor } from './orderbook.js';
import type { NiceHashControllerConfig } from './types.js';
import { competingOrdersFromBook } from './wire.js';

function config(over: Partial<NiceHashControllerConfig> = {}): NiceHashControllerConfig {
  return {
    market: 'EU',
    algorithm: 'SHA256ASICBOOST',
    pool_id: 'pool-1',
    pool_user: '',
    target_speed_units: 4,
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
    ...over,
  };
}

const BOOK = {
  stats: {
    BTC: {
      totalSpeed: '100',
      displayMarketFactor: 'PH',
      displayPriceFactor: 'EH',
      orders: [
        { id: 'mine', price: '0.0102', limit: '4', acceptedSpeed: '0', alive: true },
        { id: 'rival', price: '0.0102', limit: '5', acceptedSpeed: '0', alive: true },
      ],
    },
  },
};

function service(over: Partial<NiceHashService> = {}): NiceHashService {
  return {
    getMyOrders: vi.fn(async () => ({
      list: [
        { id: 'mine', status: { code: 'ACTIVE' }, price: '0.0102', limit: '4', amount: '0.01', availableAmount: '0.01' },
        { id: 'stranger', status: 'ACTIVE', price: '0.02', limit: '1', amount: '0.01' },
      ],
    })),
    getOrderBook: vi.fn(async () => BOOK),
    // Detail read defaults to the same (zero) delivered speed the list shows,
    // so enrichment is a no-op unless a test overrides it.
    getOrder: vi.fn(async (id: string) => ({
      id,
      price: '0.0102',
      limit: '4',
      amount: '0.01',
      acceptedCurrentSpeed: '0',
    })),
    getAccountBalance: vi.fn(async () => ({ currency: 'TBTC', totalBalance: '0.5', available: '0.5' })),
    ...over,
  } as unknown as NiceHashService;
}

const base = {
  config: config(),
  currency: 'BTC',
  balanceCurrency: 'TBTC',
  knownOrderIds: new Set(['mine']),
  runMode: 'DRY_RUN' as const,
  now: () => 1_700_000_000_000,
};

describe('observe', () => {
  it('owns ledger orders, ignores foreign orders, anchor excludes our order, balance parsed', async () => {
    const state = await observe({ service: service(), ...base });
    expect(state.owned_orders.map((o) => o.order_id)).toEqual(['mine']);
    // 'stranger' is a foreign order - now ignored entirely (no PAUSE).
    expect(state.unknown_orders).toEqual([]);
    expect(state.balance_btc).toBe(0.5);
    expect(state.market?.anchor_price_btc).toBe(0.0102);
    expect(state.tick_at).toBe(1_700_000_000_000);
  });

  it('adopts a foreign live order whose pool worker matches our configured pool user', async () => {
    const svc = service({
      getMyOrders: vi.fn(async () => ({
        list: [
          {
            id: 'readopt',
            status: 'ACTIVE',
            price: '0.0102',
            limit: '4',
            amount: '0.01',
            availableAmount: '0.01',
            pool: { username: 'bc1qme.autobidder' },
          },
        ],
      })) as unknown as NiceHashService['getMyOrders'],
    });
    const state = await observe({
      service: svc,
      ...base,
      knownOrderIds: new Set(), // not in the ledger; adopted purely by pool worker
      config: config({ pool_user: 'bc1qme.autobidder' }),
    });
    expect(state.owned_orders.map((o) => o.order_id)).toEqual(['readopt']);
    expect(state.unknown_orders).toEqual([]);
  });

  it('refreshes owned-order delivered speed from the order-detail endpoint', async () => {
    // The myOrders list reports 0 for "mine"; the detail endpoint shows a live
    // draw. observe should adopt the larger reading.
    const svc = service({
      getOrder: vi.fn(async (id: string) => ({
        id,
        price: '0.0102',
        limit: '4',
        amount: '0.01',
        acceptedCurrentSpeed: '0.0002',
      })) as unknown as NiceHashService['getOrder'],
    });
    const state = await observe({ service: svc, ...base });
    const mine = state.owned_orders.find((o) => o.order_id === 'mine');
    expect(mine?.accepted_speed_units).toBe(0.0002);
    expect(svc.getOrder).toHaveBeenCalledWith('mine');
  });

  it('recovers delivered speed + miner count from our order-book row when the list/detail report 0', async () => {
    // myOrders + detail both read 0, but our order is being filled in the public
    // book (the value NiceHash shows the operator). observe should surface it.
    const filledBook = {
      stats: {
        BTC: {
          totalSpeed: '100',
          displayMarketFactor: 'PH',
          displayPriceFactor: 'EH',
          orders: [
            { id: 'mine', price: '0.0102', limit: '4', acceptedSpeed: '0.0005', rigsCount: 137, alive: true },
            { id: 'rival', price: '0.0102', limit: '5', acceptedSpeed: '0', alive: true },
          ],
        },
      },
    };
    const svc = service({
      getOrderBook: vi.fn(async () => filledBook) as unknown as NiceHashService['getOrderBook'],
    });
    const state = await observe({ service: svc, ...base });
    const mine = state.owned_orders.find((o) => o.order_id === 'mine');
    expect(mine?.accepted_speed_units).toBe(0.0005);
    expect(mine?.rigs_count).toBe(137);
  });

  it('stamps under_filled_since while under-filled and clears it once filled', async () => {
    const map = new Map<string, number>();
    // 'mine' delivers 0 (< threshold target 4 x 100%) -> stamp under_filled_since.
    const s1 = await observe({ service: service(), ...base, underFilledSinceById: map, now: () => 1000 });
    expect(s1.owned_orders.find((o) => o.order_id === 'mine')?.under_filled_since).toBe(1000);
    expect(map.get('mine')).toBe(1000);

    // Still under-filled a later tick -> keep the original (continuous) timestamp.
    const s2 = await observe({ service: service(), ...base, underFilledSinceById: map, now: () => 5000 });
    expect(s2.owned_orders.find((o) => o.order_id === 'mine')?.under_filled_since).toBe(1000);

    // Now the order book shows it filled (>= threshold) -> cleared.
    const filledBook = {
      stats: {
        BTC: {
          totalSpeed: '100',
          displayMarketFactor: 'PH',
          displayPriceFactor: 'EH',
          orders: [
            { id: 'mine', price: '0.0102', limit: '4', acceptedSpeed: '4', alive: true },
            { id: 'rival', price: '0.0102', limit: '5', acceptedSpeed: '0', alive: true },
          ],
        },
      },
    };
    const svc = service({
      getOrderBook: vi.fn(async () => filledBook) as unknown as NiceHashService['getOrderBook'],
    });
    const s3 = await observe({ service: svc, ...base, underFilledSinceById: map, now: () => 9000 });
    expect(s3.owned_orders.find((o) => o.order_id === 'mine')?.under_filled_since).toBeNull();
    expect(map.has('mine')).toBe(false);
  });

  it('keeps the list-reported speed when the order-detail read fails', async () => {
    const svc = service({
      getOrder: vi.fn(async () => {
        throw new Error('detail boom');
      }) as unknown as NiceHashService['getOrder'],
    });
    const state = await observe({ service: svc, ...base });
    expect(state.owned_orders.find((o) => o.order_id === 'mine')?.accepted_speed_units).toBe(0);
    // A detail-read failure must not flip ordersOk / blank the market.
    expect(state.market).not.toBeNull();
    expect(state.orders_error == null).toBe(true);
  });

  it('adopts a lower detail availableAmount than the list (escrow allowed to fall)', async () => {
    // The list reports 0.01 (from BASE fixture); the detail endpoint shows a
    // lower figure because escrow has since been spent. observe should adopt it.
    // payedAmount is consistent with the spend, so the funded-minus-spent
    // bound (0.01 − 0.0068 = 0.0032) stays inert above the served 0.003.
    const svc = service({
      getOrder: vi.fn(async (id: string) => ({
        id,
        price: '0.0102',
        limit: '4',
        amount: '0.01',
        acceptedCurrentSpeed: '0',
        availableAmount: '0.003',
        payedAmount: '0.0068',
      })) as unknown as NiceHashService['getOrder'],
    });
    const state = await observe({ service: svc, ...base });
    const mine = state.owned_orders.find((o) => o.order_id === 'mine');
    expect(mine?.available_amount_btc).toBe(0.003);
  });

  it('bounds the detail availableAmount by the detail funded-minus-spent when it freezes', async () => {
    // The detail's availableAmount froze while payedAmount kept accruing
    // (observed live for 33+ hours of continuous billing). The patched escrow
    // must be the bounded amount − payed (0.05 − 0.012 = 0.038), not the
    // frozen raw 0.0487 - otherwise preferring the detail would reintroduce
    // the frozen figure over the corrected list one.
    const svc = service({
      getOrder: vi.fn(async (id: string) => ({
        id,
        price: '0.0102',
        limit: '4',
        amount: '0.05',
        acceptedCurrentSpeed: '0',
        availableAmount: '0.0487',
        payedAmount: '0.012',
      })) as unknown as NiceHashService['getOrder'],
    });
    const state = await observe({ service: svc, ...base });
    const mine = state.owned_orders.find((o) => o.order_id === 'mine');
    expect(mine?.available_amount_btc).toBeCloseTo(0.038, 9);
  });

  it('adopts a higher detail availableAmount than the list (post-refill freshness)', async () => {
    // The list reports 0.01 (from BASE fixture); the detail endpoint already
    // shows a refill the list hasn't caught up to. observe should adopt it.
    const svc = service({
      getOrder: vi.fn(async (id: string) => ({
        id,
        price: '0.0102',
        limit: '4',
        amount: '0.02',
        acceptedCurrentSpeed: '0',
        availableAmount: '0.02',
      })) as unknown as NiceHashService['getOrder'],
    });
    const state = await observe({ service: svc, ...base });
    const mine = state.owned_orders.find((o) => o.order_id === 'mine');
    expect(mine?.available_amount_btc).toBe(0.02);
  });

  it('keeps the list-reported availableAmount when the detail omits it, speed logic unaffected', async () => {
    const svc = service({
      getOrder: vi.fn(async (id: string) => ({
        id,
        price: '0.0102',
        limit: '4',
        amount: '0.01',
        acceptedCurrentSpeed: '0.0002',
        // availableAmount omitted entirely
      })) as unknown as NiceHashService['getOrder'],
    });
    const state = await observe({ service: svc, ...base });
    const mine = state.owned_orders.find((o) => o.order_id === 'mine');
    expect(mine?.available_amount_btc).toBe(0.01);
    expect(mine?.accepted_speed_units).toBe(0.0002);
  });

  it('keeps the list-reported availableAmount when the order-detail read fails', async () => {
    const svc = service({
      getOrder: vi.fn(async () => {
        throw new Error('detail boom');
      }) as unknown as NiceHashService['getOrder'],
    });
    const state = await observe({ service: svc, ...base });
    const mine = state.owned_orders.find((o) => o.order_id === 'mine');
    expect(mine?.available_amount_btc).toBe(0.01);
  });

  it('forces market=null and records the error when the my-orders read fails (refuse to act blind)', async () => {
    const svc = service({
      getMyOrders: vi.fn(async () => {
        throw new Error('HTTP 401 unauthorized');
      }) as unknown as NiceHashService['getMyOrders'],
    });
    const state = await observe({ service: svc, ...base });
    expect(state.market).toBeNull();
    expect(state.owned_orders).toEqual([]);
    expect(state.orders_error).toMatch(/401/);
  });

  it('records the order-book error when the book read fails', async () => {
    const svc = service({
      getOrderBook: vi.fn(async () => {
        throw new Error('book boom');
      }) as unknown as NiceHashService['getOrderBook'],
    });
    const state = await observe({ service: svc, ...base });
    expect(state.market).toBeNull();
    expect(state.market_error).toMatch(/book boom/);
    expect(state.orders_error == null).toBe(true);
  });

  it('degrades balance to null when the balance read fails, keeping the anchor', async () => {
    const svc = service({
      getAccountBalance: vi.fn(async () => {
        throw new Error('down');
      }) as unknown as NiceHashService['getAccountBalance'],
    });
    const state = await observe({ service: svc, ...base });
    expect(state.balance_btc).toBeNull();
    expect(state.market).not.toBeNull();
  });
});

describe('observe - escalation ladder', () => {
  // The base BOOK has no filled competitor (no rigs / delivered speed).
  // 'mine' delivers 0 (< target 4), i.e. under-filled every tick; the ladder
  // starts at exactly one step and climbs one step per interval.
  const escConfig = () =>
    config({
      walk_up_enabled: true,
      walk_up_grace_seconds: 0, // grace passes immediately
      escalation_step_btc: 0.0002,
      escalation_interval_seconds: 60,
    });

  it('starts the ladder one step up while under-filled and stamps the offset on the snapshot', async () => {
    const esc = new Map();
    const grace = new Map<string, number>();
    const s1 = await observe({
      service: service(),
      ...base,
      config: escConfig(),
      underFilledSinceById: grace,
      escalationByOrderId: esc,
      now: () => 1000,
    });
    expect(s1.owned_orders.find((o) => o.order_id === 'mine')?.escalation_offset_btc).toBeCloseTo(
      0.0002,
      10,
    );
    expect(esc.get('mine')?.offsetBtc).toBeCloseTo(0.0002, 10);
    expect(esc.get('mine')?.lastStepAt).toBe(1000);

    // Next interval, still under-filled -> one more step.
    const s2 = await observe({
      service: service(),
      ...base,
      config: escConfig(),
      underFilledSinceById: grace,
      escalationByOrderId: esc,
      now: () => 1000 + 60_000,
    });
    expect(s2.owned_orders.find((o) => o.order_id === 'mine')?.escalation_offset_btc).toBeCloseTo(
      0.0004,
      10,
    );

    // Half an interval later -> unchanged (paced).
    const s3 = await observe({
      service: service(),
      ...base,
      config: escConfig(),
      underFilledSinceById: grace,
      escalationByOrderId: esc,
      now: () => 1000 + 90_000,
    });
    expect(s3.owned_orders.find((o) => o.order_id === 'mine')?.escalation_offset_btc).toBeCloseTo(
      0.0004,
      10,
    );
  });

  it('a full-step decay drops by price_down_step per window (operator max-step rule)', async () => {
    // config price_down_step 0.002 > escalation step 0.0002 -> the down-move
    // takes the full NiceHash per-move decrease limit: 0.0035 -> 0.0015.
    const esc = new Map([['mine', { offsetBtc: 0.0035, lastStepAt: 1000 }]]);
    const filledBook = {
      stats: {
        BTC: {
          totalSpeed: '100',
          displayMarketFactor: 'PH',
          displayPriceFactor: 'EH',
          orders: [
            { id: 'mine', price: '0.0102', limit: '4', acceptedSpeed: '4', alive: true },
            { id: 'rival', price: '0.0102', limit: '5', acceptedSpeed: '0', alive: true },
          ],
        },
      },
    };
    const svc = service({
      getOrderBook: vi.fn(async () => filledBook) as unknown as NiceHashService['getOrderBook'],
    });
    const s = await observe({
      service: svc,
      ...base,
      config: config({
        walk_up_enabled: true,
        walk_up_grace_seconds: 0,
        escalation_step_btc: 0.0002,
        escalation_interval_seconds: 60,
        price_down_step_btc: 0.002,
      }),
      underFilledSinceById: new Map(),
      escalationByOrderId: esc,
      now: () => 1000 + 600_000,
    });
    expect(s.owned_orders.find((o) => o.order_id === 'mine')?.escalation_offset_btc).toBeCloseTo(
      0.0015,
      10,
    );
  });

  it('decays the ladder one step per decrease-cooldown window once the order fills', async () => {
    const esc = new Map([['mine', { offsetBtc: 0.0006, lastStepAt: 1000 }]]);
    const filledBook = {
      stats: {
        BTC: {
          totalSpeed: '100',
          displayMarketFactor: 'PH',
          displayPriceFactor: 'EH',
          orders: [
            { id: 'mine', price: '0.0102', limit: '4', acceptedSpeed: '4', alive: true },
            { id: 'rival', price: '0.0102', limit: '5', acceptedSpeed: '0', alive: true },
          ],
        },
      },
    };
    const svc = service({
      getOrderBook: vi.fn(async () => filledBook) as unknown as NiceHashService['getOrderBook'],
    });
    // Escalation interval (60s) elapsed but the default 10-min decrease
    // cooldown has not: the ladder holds - decay must never outrun the
    // walk-downs the gate will actually allow.
    const early = await observe({
      service: svc,
      ...base,
      config: escConfig(),
      underFilledSinceById: new Map(),
      escalationByOrderId: esc,
      now: () => 1000 + 60_000,
    });
    expect(early.owned_orders.find((o) => o.order_id === 'mine')?.escalation_offset_btc).toBeCloseTo(
      0.0006,
      10,
    );

    // A full cooldown window later: one probe step down.
    const s = await observe({
      service: svc,
      ...base,
      config: escConfig(),
      underFilledSinceById: new Map(),
      escalationByOrderId: esc,
      now: () => 1000 + 600_000,
    });
    expect(s.owned_orders.find((o) => o.order_id === 'mine')?.escalation_offset_btc).toBeCloseTo(
      0.0004,
      10,
    );

    // And the pacing follows the SAME cooldown value the gate uses: with an
    // overridden priceDecreaseCooldownMs (2 min), decay fires after 2 min.
    const esc2 = new Map([['mine', { offsetBtc: 0.0006, lastStepAt: 1000 }]]);
    const s2 = await observe({
      service: svc,
      ...base,
      config: escConfig(),
      underFilledSinceById: new Map(),
      escalationByOrderId: esc2,
      priceDecreaseCooldownMs: 120_000,
      now: () => 1000 + 120_000,
    });
    expect(s2.owned_orders.find((o) => o.order_id === 'mine')?.escalation_offset_btc).toBeCloseTo(
      0.0004,
      10,
    );
  });

  it('freezes the ladder when the order book read fails (no update, offset retained)', async () => {
    const esc = new Map([['mine', { offsetBtc: 0.0006, lastStepAt: 1000 }]]);
    const svc = service({
      getOrderBook: vi.fn(async () => {
        throw new Error('book boom');
      }) as unknown as NiceHashService['getOrderBook'],
    });
    const s = await observe({
      service: svc,
      ...base,
      config: escConfig(),
      underFilledSinceById: new Map(),
      escalationByOrderId: esc,
      now: () => 1000 + 120_000,
    });
    // Market is unavailable -> decide() will hold; the ladder must neither
    // advance nor collapse, and the retained offset is still stamped.
    expect(esc.get('mine')?.offsetBtc).toBeCloseTo(0.0006, 10);
    expect(esc.get('mine')?.lastStepAt).toBe(1000);
    expect(s.owned_orders.find((o) => o.order_id === 'mine')?.escalation_offset_btc).toBeCloseTo(
      0.0006,
      10,
    );
  });

  it('prunes ladder entries for orders that disappeared and drops the ladder when walk-up is off', async () => {
    const esc = new Map([
      ['mine', { offsetBtc: 0.0006, lastStepAt: 1000 }],
      ['gone', { offsetBtc: 0.0004, lastStepAt: 1000 }],
    ]);
    // walk-up disabled -> the whole ladder is dropped (offset back to 0).
    const s = await observe({
      service: service(),
      ...base,
      config: config({ walk_up_enabled: false }),
      underFilledSinceById: new Map(),
      escalationByOrderId: esc,
      now: () => 1000 + 60_000,
    });
    expect(esc.has('gone')).toBe(false); // pruned with the order
    expect(esc.has('mine')).toBe(false); // dropped: feature off
    expect(s.owned_orders.find((o) => o.order_id === 'mine')?.escalation_offset_btc).toBe(0);
  });
});

describe('observe - state maps survive a failed my-orders read', () => {
  it('a transient orders-read failure neither prunes nor advances the ladder/grace; recovery resumes, no walk-down', async () => {
    // Tick N left the order escalated (offset 0.0039, bid raised to 0.0106)
    // with a live grace timestamp. Tick N+1's my-orders read throws: the order
    // still sits at its escalated price on NiceHash, so wiping the per-order
    // state would walk the bid back to the floor over one API blip.
    const esc = new Map([['mine', { offsetBtc: 0.0039, lastStepAt: 1000 }]]);
    const grace = new Map([['mine', 500]]);
    const escalatedOrders = [
      {
        id: 'mine',
        status: { code: 'ACTIVE' },
        price: '0.0106', // escalated well above the floor (0.0102 + 0.00001)
        limit: '4',
        amount: '0.01',
        availableAmount: '0.01',
      },
    ];
    const cfg = config({
      walk_up_enabled: true,
      walk_up_grace_seconds: 0,
      escalation_step_btc: 0.0002,
      escalation_interval_seconds: 60,
    });

    // Tick N+1: my-orders read fails -> both maps untouched (not pruned, not
    // advanced, not re-stamped).
    const failing = service({
      getMyOrders: vi.fn(async () => {
        throw new Error('502 blip');
      }) as unknown as NiceHashService['getMyOrders'],
    });
    const s1 = await observe({
      service: failing,
      ...base,
      config: cfg,
      underFilledSinceById: grace,
      escalationByOrderId: esc,
      now: () => 31_000,
    });
    expect(s1.orders_error).toMatch(/502/);
    expect(esc.get('mine')).toEqual({ offsetBtc: 0.0039, lastStepAt: 1000 });
    expect(grace.get('mine')).toBe(500);

    // Tick N+2: the read recovers -> the ladder resumes from the retained
    // offset (stepping on the interval), the grace timestamp is the original,
    // and decide() proposes no DOWNWARD move - the escalated position holds.
    // (Had the maps been wiped, the ladder would restart at one step ->
    // target 0.01041 below the 0.0106 bid -> a walk-down surrendering the
    // position.)
    const recovered = service({
      getMyOrders: vi.fn(async () => ({ list: escalatedOrders })) as unknown as NiceHashService['getMyOrders'],
      getOrder: vi.fn(async () => ({ id: 'mine', price: '0.0106', limit: '4', amount: '0.01' })) as unknown as NiceHashService['getOrder'],
    });
    const s2 = await observe({
      service: recovered,
      ...base,
      config: cfg,
      underFilledSinceById: grace,
      escalationByOrderId: esc,
      now: () => 61_000,
    });
    const mine = s2.owned_orders.find((o) => o.order_id === 'mine');
    expect(mine?.under_filled_since).toBe(500); // original grace timestamp
    expect(mine?.escalation_offset_btc).toBeCloseTo(0.0041, 10); // 0.0039 + one interval step

    const proposals = decide(s2);
    for (const p of proposals) {
      if (p.kind === 'EDIT_PRICE') {
        expect(p.new_price_btc).toBeGreaterThan(p.old_price_btc); // never down from state loss
      }
    }
    const up = proposals.find((p) => p.kind === 'EDIT_PRICE');
    if (up?.kind !== 'EDIT_PRICE') throw new Error('expected an upward EDIT_PRICE');
    expect(up.new_price_btc).toBeCloseTo(0.01021 + 0.0041, 9);
  });
});

describe('applyTierHysteresis', () => {
  const primed = (accepted: number | null): TierHysteresisState => ({
    primed: true,
    accepted,
    pending: null,
    pendingCount: 0,
  });

  it('cold start: the first successful read is accepted as-is (value or null)', () => {
    expect(applyTierHysteresis(initialTierHysteresis(), 0.482).tier).toBe(0.482);
    expect(applyTierHysteresis(initialTierHysteresis(), null).tier).toBeNull();
    expect(applyTierHysteresis(initialTierHysteresis(), 0.482).next.primed).toBe(true);
  });

  it(`an upward move needs ${TIER_UP_CONFIRM_TICKS} consecutive agreeing ticks`, () => {
    const t1 = applyTierHysteresis(primed(0.4789), 0.4885);
    expect(t1.tier).toBe(0.4789); // held back on the first sighting
    const t2 = applyTierHysteresis(t1.next, 0.4885);
    expect(t2.tier).toBe(0.4885); // second consecutive tick confirms
    expect(t2.next.accepted).toBe(0.4885);
  });

  it('a downward move applies instantly (never lag a genuine drop)', () => {
    const t = applyTierHysteresis(primed(0.4885), 0.4789);
    expect(t.tier).toBe(0.4789);
    expect(t.next.accepted).toBe(0.4789);
  });

  it('value -> null is downward: instant', () => {
    const t = applyTierHysteresis(primed(0.4885), null);
    expect(t.tier).toBeNull();
    expect(t.next.accepted).toBeNull();
  });

  it('null -> value is upward: needs confirmation (anchor falls back to marginal meanwhile)', () => {
    const t1 = applyTierHysteresis(primed(null), 0.482);
    expect(t1.tier).toBeNull();
    const t2 = applyTierHysteresis(t1.next, 0.482);
    expect(t2.tier).toBe(0.482);
  });

  it('a dip during confirmation cancels the pending move (spike never lands)', () => {
    const t1 = applyTierHysteresis(primed(0.4789), 0.4885); // spike, pending
    const t2 = applyTierHysteresis(t1.next, 0.4789); // back down: instant, pending dropped
    expect(t2.tier).toBe(0.4789);
    const t3 = applyTierHysteresis(t2.next, 0.4885); // a fresh spike starts over
    expect(t3.tier).toBe(0.4789);
  });

  it('confirms at the PENDING value when the raw tier overshoots above it', () => {
    // Pending 0.4813; the next read spikes to 0.4885 (>= pending): that
    // confirms the pending 0.4813, not the overshoot - conservative.
    const t1 = applyTierHysteresis(primed(null), 0.4813);
    const t2 = applyTierHysteresis(t1.next, 0.4885);
    expect(t2.tier).toBe(0.4813);
    expect(t2.next.accepted).toBe(0.4813);
  });

  it('re-arms at a LOWER upward candidate instead of confirming the higher one', () => {
    const t1 = applyTierHysteresis(primed(0.4789), 0.4885); // pending 0.4885
    const t2 = applyTierHysteresis(t1.next, 0.482); // still above accepted, below pending
    expect(t2.tier).toBe(0.4789); // re-armed, not confirmed
    const t3 = applyTierHysteresis(t2.next, 0.482);
    expect(t3.tier).toBe(0.482); // the lower candidate confirms
  });
});

describe('observe - next-tier smoothing (zero-rig debounce + upward hysteresis)', () => {
  // A compact book: top block 0.4885/0.4820, a persistent zero wall at 0.4810
  // (the run-breaker that pins the tier at 0.4820), marginal at 0.4800.
  // `mid` (0.4820) is the row whose rigs we flicker per tick.
  const smoothingBook = (midRigs: number) => ({
    stats: {
      BTC: {
        totalSpeed: '100',
        displayMarketFactor: 'PH',
        displayPriceFactor: 'EH',
        orders: [
          { id: 'top', price: '0.4885', limit: '5', acceptedSpeed: '0.1', rigsCount: 3000, alive: true },
          { id: 'mid', price: '0.4820', limit: '5', acceptedSpeed: '0', rigsCount: midRigs, alive: true },
          { id: 'wall', price: '0.4810', limit: '5', acceptedSpeed: '0', rigsCount: 0, alive: true },
          { id: 'marg', price: '0.4800', limit: '5', acceptedSpeed: '0.5', rigsCount: 46648, alive: true },
        ],
      },
    },
  });

  // A settled (primed) streak state: each entry is a long-confirmed zero row.
  const primedStreaks = (entries: readonly (readonly [string, number])[]): ZeroRigStreakState => ({
    primed: true,
    rowsByOrderId: new Map(
      entries.map(([id, zeroReads]) => [id, { zeroReads, nonzeroReads: 0 }]),
    ),
  });

  const smoothingDeps = (midRigs: number, streaks: ZeroRigStreakState, hyst: TierHysteresisState) => ({
    service: service({
      getMyOrders: vi.fn(async () => ({ list: [] })) as unknown as NiceHashService['getMyOrders'],
      getOrderBook: vi.fn(async () => smoothingBook(midRigs)) as unknown as NiceHashService['getOrderBook'],
    }),
    ...base,
    knownOrderIds: new Set<string>(),
    zeroRigStreakState: streaks,
    tierHysteresisState: hyst,
  });

  it('cold start: the first successful read reproduces the strict tier exactly (no null collapse)', async () => {
    // Restart: streaks unprimed, hysteresis unprimed. The wall (a persistent
    // zero-rig row above the block) must be seeded as already-CONFIRMED on the
    // first read, so the exposed tier === the pre-smoothing strict tier
    // (0.4820) - NOT collapsed to null / the marginal, which would let
    // decide() walk the bid down out of the filled block on every release
    // restart.
    const streaks = initialZeroRigStreaks();
    const hyst = initialTierHysteresis();
    const s1 = await observe(smoothingDeps(57, streaks, hyst));
    expect(s1.market?.filled_prices).toEqual([0.48, 0.482, 0.4885]); // strict tier, first read
    expect(streaks.primed).toBe(true);
    // Seeded as already-confirmed on the cold-start read.
    expect(streaks.rowsByOrderId.get('wall')).toEqual({
      zeroReads: ZERO_RIG_CONFIRM_READS,
      nonzeroReads: 0,
    });
    expect(hyst.accepted).toBe(0.482);

    // Second read: a brand-new zero row would now get the normal one-read
    // transparency - the wall itself keeps counting.
    const s2 = await observe(smoothingDeps(57, streaks, hyst));
    expect(s2.market?.filled_prices).toEqual([0.48, 0.482, 0.4885]);
    expect(streaks.rowsByOrderId.get('wall')).toEqual({
      zeroReads: ZERO_RIG_CONFIRM_READS + 1,
      nonzeroReads: 0,
    });
  });

  it('full lifecycle: one-read flicker suppressed, persistent zero confirmed, recovery instant', async () => {
    // Pre-warmed wall streak (long-confirmed zero) so the tier starts settled.
    const streaks = primedStreaks([['wall', 5]]);
    const hyst = initialTierHysteresis();

    // Tick 1: mid filled -> tier 0.4820; cold-start hysteresis accepts as-is.
    // Smoothed == raw, so the faithful full ladder passes through untouched
    // (consumers only read filled_prices[0]/[1]).
    const s1 = await observe(smoothingDeps(57, streaks, hyst));
    expect(s1.market?.filled_prices).toEqual([0.48, 0.482, 0.4885]);
    expect(streaks.rowsByOrderId.get('wall')).toEqual({ zeroReads: 6, nonzeroReads: 0 });
    expect(streaks.rowsByOrderId.has('mid')).toBe(false); // rigs>0: no entry

    // Tick 2: mid (the tier row ITSELF) flickers to rigs=0 for ONE read ->
    // streak 1, unconfirmed -> transparent to the scan; the run bottom (0.4820)
    // now has no confirmed miners, so the debounced raw tier rounds up to
    // 0.4885 - and the HYSTERESIS holds that upward move pending: the exposed
    // tier stays 0.4820. (A flicker on a row ABOVE the tier is absorbed by the
    // debounce alone - see the probe replay, sample 7.)
    const s2 = await observe(smoothingDeps(0, streaks, hyst));
    expect(s2.market?.filled_prices).toEqual([0.48, 0.482]);
    expect(streaks.rowsByOrderId.get('mid')).toEqual({ zeroReads: 1, nonzeroReads: 0 });

    // Tick 3: mid recovers (rigs>0) while its zero was still UNCONFIRMED ->
    // entry dropped immediately (fresh rows count filled with no delay), raw
    // tier back at 0.4820, the pending upward move is cancelled: the one-read
    // zero flicker never surfaced.
    const s3 = await observe(smoothingDeps(57, streaks, hyst));
    expect(s3.market?.filled_prices).toEqual([0.48, 0.482, 0.4885]);
    expect(streaks.rowsByOrderId.has('mid')).toBe(false);

    // Ticks 4-5: mid goes 0 and STAYS 0 -> streak reaches the confirm count;
    // the raw tier holds 0.4885 for 2 consecutive ticks -> the move is real
    // and lands on tick 5.
    const s4 = await observe(smoothingDeps(0, streaks, hyst));
    expect(s4.market?.filled_prices).toEqual([0.48, 0.482]); // still held
    const s5 = await observe(smoothingDeps(0, streaks, hyst));
    expect(streaks.rowsByOrderId.get('mid')).toEqual({
      zeroReads: ZERO_RIG_CONFIRM_READS,
      nonzeroReads: 0,
    });
    expect(s5.market?.filled_prices).toEqual([0.48, 0.4885]); // confirmed up-move

    // Tick 6: mid (now a CONFIRMED zero) reads rigs>0 for one read -> the
    // symmetric debounce keeps it a run-breaker while recovering, and the
    // recovery ambiguity freezes the hysteresis: the tier holds at 0.4885
    // (a genuine drop is delayed by exactly one read, a flicker never lands).
    const s6 = await observe(smoothingDeps(57, streaks, hyst));
    expect(s6.market?.filled_prices).toEqual([0.48, 0.4885]);
    expect(streaks.rowsByOrderId.get('mid')).toEqual({
      zeroReads: ZERO_RIG_CONFIRM_READS,
      nonzeroReads: 1,
    });

    // Tick 7: second consecutive nonzero read -> the fill is genuine, the
    // entry is dropped and the downward move applies instantly.
    const s7 = await observe(smoothingDeps(57, streaks, hyst));
    expect(s7.market?.filled_prices).toEqual([0.48, 0.482, 0.4885]);
    expect(streaks.rowsByOrderId.has('mid')).toBe(false);
    expect(hyst.accepted).toBe(0.482);
  });

  it('prunes streak entries for rows that left the book', async () => {
    const streaks = primedStreaks([
      ['wall', 5],
      ['ghost', 3], // no longer in the book
    ]);
    await observe(smoothingDeps(57, streaks, initialTierHysteresis()));
    expect(streaks.rowsByOrderId.has('ghost')).toBe(false);
    expect(streaks.rowsByOrderId.get('wall')).toEqual({ zeroReads: 6, nonzeroReads: 0 });
  });

  it('a failed BOOK read freezes both the streak state and the hysteresis state', async () => {
    const streaks = initialZeroRigStreaks(); // restart, first read fails
    const hyst: TierHysteresisState = { primed: true, accepted: 0.482, pending: 0.4885, pendingCount: 1 };
    const svc = service({
      getMyOrders: vi.fn(async () => ({ list: [] })) as unknown as NiceHashService['getMyOrders'],
      getOrderBook: vi.fn(async () => {
        throw new Error('book boom');
      }) as unknown as NiceHashService['getOrderBook'],
    });
    const s = await observe({
      service: svc,
      ...base,
      knownOrderIds: new Set<string>(),
      zeroRigStreakState: streaks,
      tierHysteresisState: hyst,
    });
    expect(s.market).toBeNull();
    expect(streaks.primed).toBe(false); // the NEXT successful read still gets the strict cold-start seeding
    expect(streaks.rowsByOrderId.size).toBe(0);
    expect(hyst).toEqual({ primed: true, accepted: 0.482, pending: 0.4885, pendingCount: 1 });
  });

  it('a failed MY-ORDERS read also freezes them (the market snapshot is discarded)', async () => {
    const streaks = primedStreaks([['wall', 5]]);
    const hyst: TierHysteresisState = { primed: true, accepted: 0.482, pending: 0.4885, pendingCount: 1 };
    const svc = service({
      getMyOrders: vi.fn(async () => {
        throw new Error('502 blip');
      }) as unknown as NiceHashService['getMyOrders'],
      getOrderBook: vi.fn(async () => smoothingBook(0)) as unknown as NiceHashService['getOrderBook'],
    });
    const s = await observe({
      service: svc,
      ...base,
      knownOrderIds: new Set<string>(),
      zeroRigStreakState: streaks,
      tierHysteresisState: hyst,
    });
    expect(s.market).toBeNull(); // refuse to act blind
    expect(streaks.rowsByOrderId).toEqual(
      new Map([['wall', { zeroReads: 5, nonzeroReads: 0 }]]),
    ); // not bumped, not pruned
    expect(hyst).toEqual({ primed: true, accepted: 0.482, pending: 0.4885, pendingCount: 1 });
  });

  it('drops a held-back tier that went stale below the risen marginal (invariant: tier > marginal)', async () => {
    // The accepted tier (0.4795) predates a marginal that has since risen to
    // 0.4800. While a new upward move is pending, the exposed tier must not
    // sit at-or-below the marginal - it is dropped and the anchor falls back
    // to the marginal for the tick.
    const streaks = primedStreaks([['wall', 5]]);
    const hyst: TierHysteresisState = { primed: true, accepted: 0.4795, pending: null, pendingCount: 0 };
    const s = await observe(smoothingDeps(57, streaks, hyst));
    // Raw tier 0.4820 is upward vs accepted 0.4795 -> held pending; the stale
    // 0.4795 is below the 0.4800 marginal -> dropped for this tick.
    expect(s.market?.filled_prices).toEqual([0.48]);
    expect(hyst.pending).toBe(0.482);
  });
});

describe('observe - probe replay (2026-07-14, 11 live samples, SHA256ASICBOOST/BTC)', () => {
  // Reconstruction of the operator's live probe: marginal 0.4768 constant,
  // strict tier flapping [0.4813, 0.4885, 0.4885, 0.4789, 0.4789, 0.4789,
  // 0.4885, 0.4885, 0.4789, 0.4789, 0.4789] - 4 flaps in 5 minutes. Row-level
  // causes, by order id (from the probe's row diffs):
  //   - d0143f55 @ 0.4857: rigs=0 in samples 2-3 (tier -> 0.4885), then
  //     410 -> 396 -> 706 as sellers migrated to it.
  //   - 6c7fb050 @ 0.4860: brand-new order, appears in sample 7 at rigs=0,
  //     still 0 in sample 8 (tier -> 0.4885), then 469 -> 453 -> 799.
  //   - six orders @ 0.4800: rigs 0 -> 16..21 in lockstep (speed 0 both sides).
  //   - 5762a364 @ 0.4788: 0 -> 8468, later 573 -> 0 with speed frozen at
  //     0.38046409 on both sides - stale reporting; shares its level with a
  //     persistent zero row, which is what pins the strict tier at 0.4789.
  const SIX = ['59391719', 'ef950278', 'af57c365', '91df5e00', '0c46ba17', '6e5f7d0e'];
  // rigs per sample (index 0 = sample 1)
  const D0143F55 = [350, 0, 0, 410, 396, 706, 700, 700, 700, 700, 700];
  const C6C7FB050 = [-1, -1, -1, -1, -1, -1, 0, 0, 469, 453, 799]; // -1 = not in the book yet
  const S5762A364 = [0, 0, 0, 8468, 6000, 6100, 5900, 573, 0, 0, 0];

  const row = (id: string, price: string, rigs: number, speed = '0') => ({
    id,
    price,
    limit: '5',
    acceptedSpeed: speed,
    rigsCount: rigs,
    alive: true,
  });

  const probeBook = (sample: number) => {
    const i = sample - 1;
    return {
      stats: {
        BTC: {
          totalSpeed: '100',
          displayMarketFactor: 'PH',
          displayPriceFactor: 'EH',
          orders: [
            row('top1', '0.4900', 5000, '0.2'),
            row('top2', '0.4885', 3000, '0.1'),
            ...(C6C7FB050[i]! >= 0 ? [row('6c7fb050', '0.4860', C6C7FB050[i]!)] : []),
            row('d0143f55', '0.4857', D0143F55[i]!),
            row('r4822', '0.4822', 40),
            row('r4813', '0.4813', 60),
            ...SIX.map((id, k) => row(id, '0.4800', sample <= 3 ? 0 : 16 + k)),
            row('r4789', '0.4789', 120),
            row('5762a364', '0.4788', S5762A364[i]!, '0.38046409'),
            row('z4788', '0.4788', 0), // persistent zero row sharing the level
            row('m4768', '0.4768', 41850, '0.9'), // the marginal (purple)
            row('tail1', '0.4700', 0), // unfilled tail below the marginal
            row('tail2', '0.4650', 0),
          ],
        },
      },
    };
  };

  it('raw strict tier reproduces the probe flaps; the smoothed tier holds 0.4789 from sample 4 with zero upward flaps', async () => {
    const streaks = initialZeroRigStreaks(); // cold start, exactly as a daemon restart would see it
    const hyst = initialTierHysteresis();
    const rawTiers: (number | null)[] = [];
    const smoothedTiers: (number | null)[] = [];

    for (let sample = 1; sample <= 11; sample++) {
      const book = probeBook(sample);

      // The strict (unsmoothed) view of the same book - what v0.6.53 showed.
      const { competitors, totalSpeedUnits } = competingOrdersFromBook(book, 'BTC', new Set());
      const raw = computeMarketAnchor(competitors, totalSpeedUnits, 4);
      expect(raw.anchor_price_btc).toBe(0.4768); // marginal constant throughout
      rawTiers.push(raw.filled_prices?.[1] ?? null);

      // The live pipeline: observe() with the controller-owned smoothing state.
      const s = await observe({
        service: service({
          getMyOrders: vi.fn(async () => ({ list: [] })) as unknown as NiceHashService['getMyOrders'],
          getOrderBook: vi.fn(async () => book) as unknown as NiceHashService['getOrderBook'],
        }),
        ...base,
        knownOrderIds: new Set<string>(),
        zeroRigStreakState: streaks,
        tierHysteresisState: hyst,
      });
      expect(s.market?.anchor_price_btc).toBe(0.4768);
      smoothedTiers.push(s.market?.filled_prices?.[1] ?? null);
    }

    // The strict tier flapped exactly as the operator saw live: 4 flaps.
    expect(rawTiers).toEqual([
      0.4813, 0.4885, 0.4885, 0.4789, 0.4789, 0.4789, 0.4885, 0.4885, 0.4789, 0.4789, 0.4789,
    ]);

    // The smoothed tier: sample 1 exposes the TRUE strict tier immediately
    // (cold-start zeros are seeded as confirmed - a restart must never
    // collapse the tier toward the marginal and walk the bid down), holds
    // 0.4813 through the samples 2-3 spike (d0143f55's fresh zero is
    // transparent at s2; the s3-confirmed break is held by the hysteresis).
    // Sample 4 is a recovery-ambiguous tick (d0143f55 reads rigs>0 again but
    // its recovery is unconfirmed): the hysteresis freezes - CRITICALLY, the
    // recovery breaker must not manufacture a 2nd consecutive elevated read
    // and land the 0.4885 spike. The genuine drop to 0.4789 lands at sample 5
    // (delayed exactly one read by the symmetric debounce) and the tier NEVER
    // moves up again - both 0.4885 spike episodes vanish (sample 7 absorbed
    // by the zero-debounce, sample 8 by the upward hysteresis, sample 9 - the
    // 6c7fb050 recovery tick - by the ambiguity freeze).
    expect(smoothedTiers).toEqual([
      0.4813, 0.4813, 0.4813, 0.4813, 0.4789, 0.4789, 0.4789, 0.4789, 0.4789, 0.4789, 0.4789,
    ]);
    for (const t of smoothedTiers.slice(4)) expect(t).toBe(0.4789); // zero upward flaps, settled from sample 5
  });
});

describe('observe - symmetric debounce (operator gap scenario, 2026-07-14)', () => {
  // The operator's live book: the block bottom sits ONE grid step above the
  // marginal (cyan 0.4789, purple 0.4788). Confirmed-zero rows share the
  // marginal's price level (the mixed level is what pins the tier at 0.4789).
  // Rig flicker goes both ways: when those zero rows read rigs>0 for a single
  // book read, the level looks all-filled, the run reaches the marginal, and
  // the tier collapses to null - a gap in the cyan line and a 0.4788/0.4789
  // anchor flap. The symmetric debounce keeps a confirmed-zero row a breaker
  // until its nonzero reading confirms (2 consecutive reads).
  const gapBook = (zRigs: number) => ({
    stats: {
      BTC: {
        totalSpeed: '100',
        displayMarketFactor: 'PH',
        displayPriceFactor: 'EH',
        orders: [
          { id: 'top', price: '0.4900', limit: '5', acceptedSpeed: '0.2', rigsCount: 5000, alive: true },
          { id: 'r4789', price: '0.4789', limit: '5', acceptedSpeed: '0.01', rigsCount: 120, alive: true },
          { id: 'marg', price: '0.4788', limit: '5', acceptedSpeed: '0.9', rigsCount: 41850, alive: true },
          // The two zero rows sharing the marginal level; speed 0 on both
          // sides of the flip, exactly as the probe showed.
          { id: 'z1', price: '0.4788', limit: '5', acceptedSpeed: '0', rigsCount: zRigs, alive: true },
          { id: 'z2', price: '0.4788', limit: '5', acceptedSpeed: '0', rigsCount: zRigs, alive: true },
          { id: 'tail', price: '0.4700', limit: '5', acceptedSpeed: '0', rigsCount: 0, alive: true },
        ],
      },
    },
  });

  const gapDeps = (zRigs: number, streaks: ZeroRigStreakState, hyst: TierHysteresisState) => ({
    service: service({
      getMyOrders: vi.fn(async () => ({ list: [] })) as unknown as NiceHashService['getMyOrders'],
      getOrderBook: vi.fn(async () => gapBook(zRigs)) as unknown as NiceHashService['getOrderBook'],
    }),
    ...base,
    knownOrderIds: new Set<string>(),
    zeroRigStreakState: streaks,
    tierHysteresisState: hyst,
  });

  it('a one-read nonzero flicker on confirmed-zero rows leaves the tier at 0.4789 (no null gap); a genuine fill lands on the 2nd read', async () => {
    const streaks: ZeroRigStreakState = {
      primed: true,
      rowsByOrderId: new Map([
        ['z1', { zeroReads: 5, nonzeroReads: 0 }],
        ['z2', { zeroReads: 5, nonzeroReads: 0 }],
        ['tail', { zeroReads: 5, nonzeroReads: 0 }],
      ]),
    };
    const hyst: TierHysteresisState = { primed: true, accepted: 0.4789, pending: null, pendingCount: 0 };

    // Tick 1 (baseline): mixed marginal level -> tier 0.4789, anchor 0.4788.
    const s1 = await observe(gapDeps(0, streaks, hyst));
    expect(s1.market?.anchor_price_btc).toBe(0.4788);
    expect(s1.market?.filled_prices?.[1]).toBe(0.4789);

    // Tick 2 (the gap): z1/z2 flicker to rigs=20 for ONE read (speed still 0).
    // Pre-fix the level read all-filled -> run reached the marginal -> tier
    // null -> cyan gap + anchor flap. Now: recovering rows stay breakers, the
    // ambiguity freezes the hysteresis, the tier holds 0.4789 and the anchor
    // stays put. No null anywhere.
    const s2 = await observe(gapDeps(20, streaks, hyst));
    expect(s2.market?.anchor_price_btc).toBe(0.4788);
    expect(s2.market?.filled_prices?.[1]).toBe(0.4789); // NO gap
    expect(streaks.rowsByOrderId.get('z1')).toEqual({ zeroReads: 6, nonzeroReads: 1 });

    // Tick 3 (re-zero): the flicker resolves back to zero -> the recovery
    // counter re-arms cleanly, the row is a plain confirmed zero again.
    const s3 = await observe(gapDeps(0, streaks, hyst));
    expect(s3.market?.filled_prices?.[1]).toBe(0.4789);
    expect(streaks.rowsByOrderId.get('z1')).toEqual({ zeroReads: 7, nonzeroReads: 0 });

    // Ticks 4-5 (genuine fill): z1/z2 read rigs>0 twice in a row. Tick 4 is
    // the held read (breaker + freeze); tick 5 confirms - the entries drop,
    // the run genuinely reaches the marginal, and the null lands (downward is
    // instant once confirmed; delayed exactly one extra read overall).
    const s4 = await observe(gapDeps(20, streaks, hyst));
    expect(s4.market?.filled_prices?.[1]).toBe(0.4789); // still held one read
    const s5 = await observe(gapDeps(20, streaks, hyst));
    expect(streaks.rowsByOrderId.has('z1')).toBe(false); // recovery confirmed
    expect(s5.market?.filled_prices).toEqual([0.4788]); // genuine null: fill reaches the marginal
    expect(hyst.accepted).toBeNull();
  });

  it('the order-book capture sink gets the full book with per-row debounce state (strict raw vs smoothed tier)', async () => {
    const streaks: ZeroRigStreakState = {
      primed: true,
      rowsByOrderId: new Map([
        ['z1', { zeroReads: 5, nonzeroReads: 0 }],
        ['z2', { zeroReads: 5, nonzeroReads: 0 }],
        ['tail', { zeroReads: 5, nonzeroReads: 0 }],
      ]),
    };
    const hyst: TierHysteresisState = { primed: true, accepted: 0.4789, pending: null, pendingCount: 0 };
    const captures: import('../../state/repos/nicehash_book_snapshots.js').NiceHashBookSnapshot[] = [];

    // Flicker tick (z rows read rigs=20): the STRICT tier collapses to null,
    // the smoothed tier holds 0.4789 - the capture records BOTH, plus each
    // row's live debounce state, at the tick's own timestamp.
    await observe({
      ...gapDeps(20, streaks, hyst),
      now: () => 42_000,
      onBookCapture: (c) => captures.push(c),
    });
    expect(captures).toHaveLength(1);
    const snap = captures[0]!;
    expect(snap.ts).toBe(42_000);
    expect(snap.marginal_price_btc).toBe(0.4788);
    expect(snap.raw_tier_btc).toBeNull(); // strict view: flicker collapsed the run
    expect(snap.smoothed_tier_btc).toBe(0.4789); // what the bot actually acted on
    expect(snap.rows.map((r) => r.price_btc)).toEqual([0.49, 0.4789, 0.4788, 0.4788, 0.4788, 0.47]); // price-descending
    const byId = new Map(snap.rows.map((r) => [r.id, r]));
    expect(byId.get('top')?.debounce_state).toBe('filled');
    expect(byId.get('z1')?.debounce_state).toBe('recovering_nonzero');
    expect(byId.get('z1')?.rigs_count).toBe(20); // raw book value, not the debounced view
    expect(byId.get('tail')?.debounce_state).toBe('confirmed_zero');

    // A failed my-orders read must not capture (the debounce state is frozen
    // and the market snapshot is discarded - a capture would misrepresent it).
    const failing = {
      ...gapDeps(0, streaks, hyst),
      service: service({
        getMyOrders: vi.fn(async () => {
          throw new Error('502 blip');
        }) as unknown as NiceHashService['getMyOrders'],
      }),
      onBookCapture: (c: (typeof captures)[number]) => captures.push(c),
    };
    await observe(failing);
    expect(captures).toHaveLength(1); // no new capture
  });
});
