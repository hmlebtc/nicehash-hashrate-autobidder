import { describe, expect, it, vi } from 'vitest';

import type { NiceHashService } from '../../services/nicehash-service.js';
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
    price_edit_deadband_pct: 20,
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
