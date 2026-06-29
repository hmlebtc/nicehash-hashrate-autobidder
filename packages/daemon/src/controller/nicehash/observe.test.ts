import { describe, expect, it, vi } from 'vitest';

import type { NiceHashService } from '../../services/nicehash-service.js';
import { observe } from './observe.js';
import type { NiceHashControllerConfig } from './types.js';

function config(): NiceHashControllerConfig {
  return {
    market: 'EU',
    algorithm: 'SHA256ASICBOOST',
    pool_id: 'pool-1',
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
  it('builds state: owned vs unknown split, anchor excludes our order, balance parsed', async () => {
    const state = await observe({ service: service(), ...base });
    expect(state.owned_orders.map((o) => o.order_id)).toEqual(['mine']);
    expect(state.unknown_orders.map((o) => o.order_id)).toEqual(['stranger']);
    expect(state.balance_btc).toBe(0.5);
    expect(state.market?.anchor_price_btc).toBe(0.0102);
    expect(state.tick_at).toBe(1_700_000_000_000);
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
