import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NiceHashClient } from '@hashrate-autopilot/nicehash-client';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../../state/db.js';
import { NiceHashOrdersRepo } from '../../state/repos/nicehash_orders.js';
import type { NiceHashService } from '../../services/nicehash-service.js';
import { NiceHashController } from './controller.js';
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
    refill_amount_btc: 0,
    refill_when_runway_hours: 6,
    min_order_amount_btc: 0.001,
    price_edit_deadband_pct: 20,
    min_speed_limit_units: 0.1,
    price_down_step_btc: 0.0001,
    cheap_threshold_pct: 0,
    cheap_target_speed_units: 0,
  };
}

function service(myOrders: unknown[] = []): NiceHashService {
  return {
    getAlgorithmSetting: vi.fn(async () => ({
      algorithm: 'SHA256ASICBOOST',
      marketFactor: '1000000000000000',
      displayMarketFactor: 'PH',
    })),
    getMyOrders: vi.fn(async () => ({ list: myOrders })),
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

describe('NiceHashController', () => {
  let handle: DatabaseHandle;
  let ledger: NiceHashOrdersRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    ledger = new NiceHashOrdersRepo(handle.db);
  });
  afterEach(async () => {
    await closeDatabase(handle);
  });

  const make = (runMode: RunMode, svc = service(), cli = client()) =>
    new NiceHashController({
      service: svc,
      client: cli,
      ledger,
      config: config(),
      currency: 'BTC',
      balanceCurrency: 'TBTC',
      runMode: () => runMode,
      now: () => 1_700_000_000_000,
    });

  it('DRY_RUN: blocks the create and persists nothing', async () => {
    const cli = client();
    const res = await make('DRY_RUN', service(), cli).tick();
    expect(res.proposals[0]?.kind).toBe('CREATE_ORDER');
    expect(res.outcomes[0]?.outcome).toBe('BLOCKED');
    expect(cli.createOrder).not.toHaveBeenCalled();
    expect((await ledger.getIds()).size).toBe(0);
  });

  it('LIVE: executes the create and records the new order in the ledger', async () => {
    const cli = client();
    const res = await make('LIVE', service(), cli).tick();
    expect(res.outcomes[0]?.outcome).toBe('EXECUTED');
    expect(cli.createOrder).toHaveBeenCalledTimes(1);
    const ids = await ledger.getIds();
    expect([...ids]).toEqual(['created-1']);
    const row = (await ledger.list())[0];
    expect(row).toMatchObject({ order_id: 'created-1', pool_id: 'pool-1', last_known_status: 'CREATED' });
  });

  it('reconciles ledger rows from observed owned orders', async () => {
    // Seed the ledger with an order, then have myOrders report it ACTIVE+spend.
    await ledger.insert({
      order_id: 'mine',
      created_at: 1,
      price_btc: 0.0102,
      amount_btc: 0.01,
      limit_units: 4,
      pool_id: 'pool-1',
    });
    const svc = service([
      {
        id: 'mine',
        status: { code: 'ACTIVE' },
        price: '0.0102',
        limit: '4',
        amount: '0.01',
        payedAmount: '0.003',
        acceptedCurrentSpeed: '3.5',
      },
    ]);
    await make('DRY_RUN', svc).tick();
    const row = (await ledger.list()).find((r) => r.order_id === 'mine');
    expect(row?.last_known_status).toBe('ACTIVE');
    expect(row?.payed_amount_btc).toBe(0.003);
  });
});
