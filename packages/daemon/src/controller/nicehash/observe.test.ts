import { describe, expect, it, vi } from 'vitest';

import type { NiceHashService } from '../../services/nicehash-service.js';
import { decide } from './decide.js';
import { observe } from './observe.js';
import type { NiceHashControllerConfig } from './types.js';

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
