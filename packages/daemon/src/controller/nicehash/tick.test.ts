import { describe, expect, it, vi } from 'vitest';

import type { NiceHashClient } from '@hashrate-autopilot/nicehash-client';

import type { NiceHashService } from '../../services/nicehash-service.js';
import { tick } from './tick.js';
import type { NiceHashControllerConfig, RunMode } from './types.js';

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

function service(): NiceHashService {
  return {
    getAlgorithmSetting: vi.fn(async () => ({
      algorithm: 'SHA256ASICBOOST',
      marketFactor: '1000000000000000',
      displayMarketFactor: 'PH',
    })),
    getMyOrders: vi.fn(async () => ({ list: [] })),
    getOrderBook: vi.fn(async () => ({
      stats: { BTC: { totalSpeed: '100', orders: [{ id: 'rival', price: '0.0102', limit: '5', alive: true }] } },
    })),
    getAccountBalance: vi.fn(async () => ({ currency: 'TBTC', totalBalance: '0.5', available: '0.5' })),
  } as unknown as NiceHashService;
}

function client(): NiceHashClient {
  return {
    createOrder: vi.fn(async () => ({ id: 'created-1', price: '0.0102', limit: '4', amount: '0.01' })),
  } as unknown as NiceHashClient;
}

const baseDeps = (runMode: RunMode) => ({
  service: service(),
  client: client(),
  config: config(),
  currency: 'BTC',
  balanceCurrency: 'TBTC',
  knownOrderIds: new Set<string>(),
  runMode,
  now: () => 1_700_000_000_000,
});

describe('tick', () => {
  it('DRY_RUN: proposes CREATE_ORDER but the gate blocks it (no API mutation)', async () => {
    const deps = baseDeps('DRY_RUN');
    const res = await tick(deps);
    expect(res.proposals[0]?.kind).toBe('CREATE_ORDER');
    expect(res.outcomes[0]?.outcome).toBe('BLOCKED');
    expect(deps.client.createOrder).not.toHaveBeenCalled();
  });

  it('LIVE: executes the CREATE_ORDER against the client', async () => {
    const deps = baseDeps('LIVE');
    const res = await tick(deps);
    expect(res.outcomes[0]?.outcome).toBe('EXECUTED');
    expect(deps.client.createOrder).toHaveBeenCalledTimes(1);
    // marketFactor/displayMarketFactor come from the cached algorithm metadata.
    expect(deps.client.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        algorithm: 'SHA256ASICBOOST',
        market: 'EU',
        type: 'STANDARD',
        marketFactor: '1000000000000000',
        displayMarketFactor: 'PH',
        poolId: 'pool-1',
      }),
    );
  });

  it('invokes the onExecuted hook for each outcome', async () => {
    const deps = baseDeps('LIVE');
    const seen: string[] = [];
    await tick({ ...deps, onExecuted: (o) => void seen.push(o.outcome) });
    expect(seen).toEqual(['EXECUTED']);
  });
});
