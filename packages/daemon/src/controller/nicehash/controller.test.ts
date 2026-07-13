import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NiceHashClient } from '@hashrate-autopilot/nicehash-client';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../../state/db.js';
import { NiceHashOrdersRepo } from '../../state/repos/nicehash_orders.js';
import { NiceHashMetricsRepo } from '../../state/repos/nicehash_tick_metrics.js';
import { NiceHashEventsRepo } from '../../state/repos/nicehash_order_events.js';
import type { NiceHashService } from '../../services/nicehash-service.js';
import { NiceHashController } from './controller.js';
import type { NiceHashControllerConfig, RunMode } from './types.js';

function config(): NiceHashControllerConfig {
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
    refill_amount_btc: 0,
    refill_when_runway_hours: 6,
    min_order_amount_btc: 0.001,
    min_speed_limit_units: 0.1,
    price_down_step_btc: 0.0001,
    min_fill_pct: 80,
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
    // Detail echoes the list entry so enrichment leaves owned orders unchanged.
    getOrder: vi.fn(async (id: string) => {
      const found = (myOrders as { id?: string }[]).find((o) => o.id === id);
      return found ?? { id, price: '0.0102', limit: '4', amount: '0.01' };
    }),
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

  it('records a metrics row each tick (and no History events in DRY_RUN)', async () => {
    const metrics = new NiceHashMetricsRepo(handle.db);
    const events = new NiceHashEventsRepo(handle.db);
    const controller = new NiceHashController({
      service: service(),
      client: client(),
      ledger,
      config: config(),
      currency: 'BTC',
      balanceCurrency: 'TBTC',
      runMode: () => 'DRY_RUN',
      now: () => 1_700_000_000_000,
      hashprice: () => 0.0098,
      metrics,
      events,
    });

    await controller.tick();

    const m = await metrics.latest();
    expect(m?.ts).toBe(1_700_000_000_000);
    expect(m?.run_mode).toBe('DRY_RUN');
    expect(m?.api_ok).toBe(1);
    expect(m?.hashprice_btc_per_unit_day).toBe(0.0098);
    expect(m?.floor_units).toBe(3.2); // fill threshold = target 4 × min-fill 80%
    expect(m?.target_units).toBe(4);

    // DRY_RUN proposals are BLOCKED by the gate, so History stays empty.
    expect(await events.list()).toHaveLength(0);
  });

  it('records an EXECUTED CREATE event with the new order id in LIVE', async () => {
    const events = new NiceHashEventsRepo(handle.db);
    const controller = new NiceHashController({
      service: service(),
      client: client(),
      ledger,
      config: config(),
      currency: 'BTC',
      balanceCurrency: 'TBTC',
      runMode: () => 'LIVE',
      now: () => 1_700_000_000_000,
      events,
    });
    await controller.tick();
    const evs = await events.list();
    expect(evs[0]).toMatchObject({ action: 'CREATE', outcome: 'EXECUTED', order_id: 'created-1' });
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

describe('NiceHashController - escalation ladder across ticks', () => {
  let handle: DatabaseHandle;
  let ledger: NiceHashOrdersRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    ledger = new NiceHashOrdersRepo(handle.db);
  });
  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('an executed escalation walk-up resets the grace but NOT the ladder (next step builds on the offset)', async () => {
    // The under-filled-since grace map IS reset on each executed raise (fresh
    // grace window); the escalation ladder must survive its own raises or every
    // step would restart the climb from zero.
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
        availableAmount: '0.01',
        acceptedCurrentSpeed: '0', // never fills in this scenario
      },
    ]);
    const cli = {
      ...client(),
      updatePriceAndLimit: vi.fn(async () => ({})),
    } as unknown as NiceHashClient;
    let t = 1_700_000_000_000;
    const controller = new NiceHashController({
      service: svc,
      client: cli,
      ledger,
      config: {
        ...config(),
        walk_up_enabled: true,
        walk_up_grace_seconds: 0, // grace passes immediately (graceMs === 0)
        escalation_step_btc: 0.0002,
        escalation_interval_seconds: 60,
      },
      currency: 'BTC',
      balanceCurrency: 'TBTC',
      runMode: () => 'LIVE',
      now: () => t,
    });

    // Tick 1: under-filled at the floor (anchor 0.0102 + overpay 0.00001) ->
    // fast-start one step (no paying-price stat in the book) -> walk up to
    // floor + 0.0002. Executing the raise resets the grace map internally.
    const r1 = await controller.tick();
    const e1 = r1.proposals.find((p) => p.kind === 'EDIT_PRICE');
    if (e1?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE in tick 1');
    expect(e1.new_price_btc).toBeCloseTo(0.01021 + 0.0002, 9);
    expect(r1.outcomes.find((o) => o.proposal === e1)?.outcome).toBe('EXECUTED');

    // Tick 2, one interval later, still under-filled: the ladder builds on the
    // retained offset (0.0002 -> 0.0004). Had the raise reset it (like the
    // grace), this tick would re-fast-start and propose floor + 0.0002 again.
    t += 60_000;
    const r2 = await controller.tick();
    const e2 = r2.proposals.find((p) => p.kind === 'EDIT_PRICE');
    if (e2?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE in tick 2');
    expect(e2.new_price_btc).toBeCloseTo(0.01021 + 0.0004, 9);
  });
});
