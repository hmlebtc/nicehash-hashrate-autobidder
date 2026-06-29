import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { NiceHashStateStore } from '../controller/nicehash/state-store.js';
import type { NiceHashControllerConfig } from '../controller/nicehash/types.js';
import type { NiceHashTickResult } from '../controller/nicehash/tick.js';
import type { NiceHashOrdersRepo } from '../state/repos/nicehash_orders.js';
import { createNiceHashHttpServer, type NiceHashHttpDeps } from './nicehash-server.js';

function config(): NiceHashControllerConfig {
  return {
    market: 'BTC',
    algorithm: 'SHA256ASICBOOST',
    pool_id: 'pool-1',
    target_speed_units: 1,
    overpay_btc_per_unit_day: 0.0001,
    max_price_btc_per_unit_day: 0.02,
    max_overpay_vs_hashprice_btc_per_unit_day: null,
    order_budget_btc: 0.001,
    refill_amount_btc: 0,
    refill_when_runway_hours: 6,
    min_order_amount_btc: 0.001,
    price_edit_deadband_pct: 20,
    min_speed_limit_units: 0.1,
    price_down_step_btc: 0.1,
    cheap_threshold_pct: 0,
    cheap_target_speed_units: 0,
  };
}

function tickResult(): NiceHashTickResult {
  return {
    state: {
      tick_at: 1_700_000_000_000,
      run_mode: 'DRY_RUN',
      config: config(),
      market: { anchor_price_btc: 0.0102, total_speed_units: 537, thin: false },
      balance_btc: 0.001,
      owned_orders: [],
      unknown_orders: [],
      hashprice_btc_per_unit_day: null,
    },
    proposals: [
      { kind: 'CREATE_ORDER', price_btc: 0.0103, amount_btc: 0.001, limit_units: 1, pool_id: 'pool-1', reason: 'create' },
    ],
    gated: [],
    outcomes: [{ proposal: { kind: 'CREATE_ORDER', price_btc: 0.0103, amount_btc: 0.001, limit_units: 1, pool_id: 'pool-1', reason: 'create' }, outcome: 'BLOCKED', reason: 'RUN_MODE_NOT_LIVE' }],
  };
}

function deps(store: NiceHashStateStore): NiceHashHttpDeps {
  return {
    store,
    ledger: { list: vi.fn(async () => []) } as unknown as NiceHashOrdersRepo,
    config: config(),
    buildNumber: 690,
    tickSeconds: 60,
  };
}

describe('NiceHash HTTP server', () => {
  let app: FastifyInstance;
  let store: NiceHashStateStore;

  beforeEach(async () => {
    store = new NiceHashStateStore('DRY_RUN');
    app = await createNiceHashHttpServer(deps(store));
  });
  afterEach(async () => {
    await app.close();
  });

  it('GET /api/health returns ok + build', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, build: 690 });
  });

  it('GET /api/nicehash/status returns defaults before the first tick', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/status' });
    const body = res.json();
    expect(body.run_mode).toBe('DRY_RUN');
    expect(body.tick_at).toBeNull();
    expect(body.config.algorithm).toBe('SHA256ASICBOOST');
    expect(body.owned_orders).toEqual([]);
  });

  it('GET /api/nicehash/status reflects the latest tick', async () => {
    store.setLast(tickResult());
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/status' });
    const body = res.json();
    expect(body.market.anchor_price_btc).toBe(0.0102);
    expect(body.balance_btc).toBe(0.001);
    expect(body.proposals[0]).toEqual({ kind: 'CREATE_ORDER', reason: 'create' });
    expect(body.outcomes[0]).toEqual({ kind: 'CREATE_ORDER', outcome: 'BLOCKED', detail: 'RUN_MODE_NOT_LIVE' });
  });

  it('POST /api/nicehash/run-mode updates the store', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/nicehash/run-mode', payload: { mode: 'PAUSED' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ run_mode: 'PAUSED' });
    expect(store.getRunMode()).toBe('PAUSED');
  });

  it('POST /api/nicehash/run-mode rejects an invalid mode', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/nicehash/run-mode', payload: { mode: 'BOGUS' } });
    expect(res.statusCode).toBe(400);
    expect(store.getRunMode()).toBe('DRY_RUN');
  });

  it('GET /api/nicehash/orders returns the ledger rows', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/orders' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orders: [] });
  });
});
