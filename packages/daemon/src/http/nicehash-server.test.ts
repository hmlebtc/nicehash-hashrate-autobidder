import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { NiceHashStateStore } from '../controller/nicehash/state-store.js';
import { SECRET_MASK, settingsFromEnv, type NiceHashSettings } from '../controller/nicehash/settings.js';
import type { NiceHashControllerConfig } from '../controller/nicehash/types.js';
import type { NiceHashTickResult } from '../controller/nicehash/tick.js';
import { closeDatabase, openDatabase, type DatabaseHandle } from '../state/db.js';
import { NiceHashOrdersRepo } from '../state/repos/nicehash_orders.js';
import { NiceHashMetricsRepo } from '../state/repos/nicehash_tick_metrics.js';
import { NiceHashEventsRepo } from '../state/repos/nicehash_order_events.js';
import type { NiceHashSettingsRepo } from '../state/repos/nicehash_settings.js';
import { createNiceHashHttpServer, type NiceHashHttpDeps } from './nicehash-server.js';

// The /test endpoint builds a real signed client; swap it for a fake we control.
const hoisted = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@hashrate-autopilot/nicehash-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hashrate-autopilot/nicehash-client')>();
  return { ...actual, createNiceHashClient: () => hoisted.client };
});

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

/** In-memory stand-in for NiceHashSettingsRepo. */
function fakeSettingsRepo(initial?: NiceHashSettings): {
  repo: NiceHashSettingsRepo;
  current: () => NiceHashSettings | null;
} {
  let row: NiceHashSettings | null = initial ?? null;
  const repo = {
    get: vi.fn(async () => row),
    put: vi.fn(async (s: NiceHashSettings) => {
      row = s;
    }),
  } as unknown as NiceHashSettingsRepo;
  return { repo, current: () => row };
}

function deps(
  store: NiceHashStateStore,
  settingsRepo: NiceHashSettingsRepo,
): NiceHashHttpDeps {
  return {
    store,
    ledger: { list: vi.fn(async () => []) } as unknown as NiceHashOrdersRepo,
    settingsRepo,
    config: config(),
    buildNumber: 690,
    tickSeconds: 60,
  };
}

describe('NiceHash HTTP server', () => {
  let app: FastifyInstance;
  let app2: FastifyInstance;
  let store: NiceHashStateStore;
  let settings: ReturnType<typeof fakeSettingsRepo>;

  beforeEach(async () => {
    store = new NiceHashStateStore('DRY_RUN');
    settings = fakeSettingsRepo(settingsFromEnv({}));
    // The /test endpoint probes the BTC price source over fetch; stub it so the
    // suite is deterministic and offline. (Pool + hashprice checks are skipped
    // by default: no pool host, hashprice source = none.)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ bitcoin: { usd: 65000 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    app = await createNiceHashHttpServer(deps(store, settings.repo));
  });
  afterEach(async () => {
    await app.close();
    hoisted.client = null;
    vi.unstubAllGlobals();
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

  it('POST /api/nicehash/run-mode updates the store and persists', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/nicehash/run-mode', payload: { mode: 'PAUSED' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ run_mode: 'PAUSED' });
    expect(store.getRunMode()).toBe('PAUSED');
    expect(settings.current()?.runMode).toBe('PAUSED');
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

  it('GET / serves the NiceHash dashboard HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('NiceHash Hashrate Autobidder');
    expect(res.body).toContain('/api/nicehash/status');
    expect(res.body).toContain('/api/nicehash/config');
    expect(res.body).toContain('/api/nicehash/test');
  });

  it('GET /api/nicehash/config masks the secret', async () => {
    settings = fakeSettingsRepo({ ...settingsFromEnv({}), apiKey: 'k', apiSecret: 'shh', orgId: 'o' });
    app2 = await createNiceHashHttpServer(deps(store, settings.repo));
    const res = await app2.inject({ method: 'GET', url: '/api/nicehash/config' });
    expect(res.statusCode).toBe(200);
    const cfg = res.json().config;
    expect(cfg.apiKey).toBe('k');
    expect(cfg.apiSecret).toBe(SECRET_MASK);
    await app2.close();
  });

  it('POST /api/nicehash/config keeps the secret when the mask is posted back', async () => {
    settings = fakeSettingsRepo({ ...settingsFromEnv({}), apiKey: 'k', apiSecret: 'shh', orgId: 'o' });
    app2 = await createNiceHashHttpServer(deps(store, settings.repo));
    const res = await app2.inject({
      method: 'POST',
      url: '/api/nicehash/config',
      payload: { apiSecret: SECRET_MASK, targetSpeedUnits: '5', runMode: 'PAUSED' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.apiSecret).toBe(SECRET_MASK);
    // Stored secret is unchanged; numeric coerced; run mode applied live.
    expect(settings.current()?.apiSecret).toBe('shh');
    expect(settings.current()?.targetSpeedUnits).toBe(5);
    expect(store.getRunMode()).toBe('PAUSED');
    await app2.close();
  });

  it('POST /api/nicehash/config replaces the secret when a new one is posted', async () => {
    settings = fakeSettingsRepo({ ...settingsFromEnv({}), apiKey: 'k', apiSecret: 'shh', orgId: 'o' });
    app2 = await createNiceHashHttpServer(deps(store, settings.repo));
    await app2.inject({ method: 'POST', url: '/api/nicehash/config', payload: { apiSecret: 'new-secret' } });
    expect(settings.current()?.apiSecret).toBe('new-secret');
    await app2.close();
  });

  const nhCheck = (body: { checks: { name: string; ok: boolean; skipped?: boolean; detail: string }[] }) =>
    body.checks.find((c) => c.name === 'NiceHash API')!;

  it('POST /api/nicehash/test reports the NiceHash check failed when credentials are missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/nicehash/test', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false); // a failed (non-skipped) check fails the overall result
    const nh = nhCheck(body);
    expect(nh.ok).toBe(false);
    expect(nh.detail).toMatch(/required/i);
  });

  it('POST /api/nicehash/test probes pool, hashprice, BTC price, and the NiceHash API', async () => {
    hoisted.client = {
      syncTime: vi.fn(async () => -42),
      getAlgorithmSetting: vi.fn(async () => ({ marketFactor: '1000000000000000', displayMarketFactor: 'PH', displayPriceFactor: 'EH' })),
      getAccountBalance: vi.fn(async () => ({ available: '0.005' })),
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/nicehash/test',
      payload: { apiKey: 'k', apiSecret: 's', orgId: 'o', balanceCurrency: 'TBTC' },
    });
    const body = res.json();
    // Four independent checks, in order.
    expect(body.checks.map((c: { name: string }) => c.name)).toEqual([
      'NiceHash API',
      'Pool',
      'Hashprice source',
      'BTC price source',
    ]);
    const nh = nhCheck(body);
    expect(nh.ok).toBe(true);
    expect(nh.detail).toContain('-42ms');
    expect(nh.detail).toContain('1000000000000000');
    expect(nh.detail).toContain('0.005 TBTC');
    // No pool host / hashprice source configured -> skipped (don't fail overall).
    const pool = body.checks.find((c: { name: string }) => c.name === 'Pool');
    expect(pool.skipped).toBe(true);
    const hp = body.checks.find((c: { name: string }) => c.name === 'Hashprice source');
    expect(hp.skipped).toBe(true);
    // BTC price comes from the stubbed fetch.
    const btc = body.checks.find((c: { name: string }) => c.name === 'BTC price source');
    expect(btc.ok).toBe(true);
    expect(btc.detail).toContain('65,000');
    expect(body.ok).toBe(true);
  });

  it('POST /api/nicehash/test still reports the NiceHash check OK when only the balance read fails', async () => {
    hoisted.client = {
      syncTime: vi.fn(async () => 0),
      getAlgorithmSetting: vi.fn(async () => ({ marketFactor: '1', displayMarketFactor: 'PH' })),
      getAccountBalance: vi.fn(async () => {
        throw new Error('no balance permission');
      }),
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/nicehash/test',
      payload: { apiKey: 'k', apiSecret: 's', orgId: 'o' },
    });
    const nh = nhCheck(res.json());
    expect(nh.ok).toBe(true);
    expect(nh.detail).toMatch(/balance read failed/);
    expect(nh.detail).toMatch(/permission/);
  });

  it('POST /api/nicehash/test marks the NiceHash check failed when the signed read throws', async () => {
    hoisted.client = {
      syncTime: vi.fn(async () => {
        throw new Error('clock unreachable');
      }),
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/nicehash/test',
      payload: { apiKey: 'k', apiSecret: 's', orgId: 'o' },
    });
    const body = res.json();
    expect(body.ok).toBe(false);
    const nh = nhCheck(body);
    expect(nh.ok).toBe(false);
    expect(nh.detail).toMatch(/clock unreachable/);
  });
});

describe('NiceHash HTTP server - metrics / history / summary / run-now', () => {
  let handle: DatabaseHandle;
  let app: FastifyInstance;
  let metricsRepo: NiceHashMetricsRepo;
  let eventsRepo: NiceHashEventsRepo;
  let ledger: NiceHashOrdersRepo;
  let runNow: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    metricsRepo = new NiceHashMetricsRepo(handle.db);
    eventsRepo = new NiceHashEventsRepo(handle.db);
    ledger = new NiceHashOrdersRepo(handle.db);
    runNow = vi.fn(async () => ({ ok: true }));

    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await metricsRepo.record({
        ts: now - (5 - i) * 60_000,
        run_mode: 'LIVE',
        api_ok: 1,
        balance_btc: 0.01,
        anchor_price_btc: 0.0102,
        our_price_btc: 0.0103,
        total_speed_units: 500,
        accepted_speed_units: 0.9,
        limit_units: 1,
        target_units: 1,
        floor_units: 0.01,
        available_amount_btc: 0.0008,
        spend_rate_btc_day: 0.00001,
        hashprice_btc_per_unit_day: 0.0098,
        owned_count: 1,
        unknown_count: 0,
      });
    }
    await eventsRepo.record({
      ts: now - 120_000, order_id: 'o1', action: 'CREATE', run_mode: 'LIVE', outcome: 'EXECUTED',
      price_before: null, price_after: 0.0102, limit_before: null, limit_after: 1,
      amount_btc: 0.001, anchor_price_btc: 0.0102, reason: 'create', detail: 'ok',
    });
    await eventsRepo.record({
      ts: now - 60_000, order_id: 'o1', action: 'EDIT_PRICE', run_mode: 'LIVE', outcome: 'EXECUTED',
      price_before: 0.0102, price_after: 0.0103, limit_before: null, limit_after: null,
      amount_btc: null, anchor_price_btc: 0.0102, reason: 'track', detail: 'ok',
    });

    const store = new NiceHashStateStore('LIVE');
    app = await createNiceHashHttpServer({
      store,
      ledger,
      settingsRepo: fakeSettingsRepo(settingsFromEnv({})).repo,
      config: config(),
      buildNumber: 700,
      tickSeconds: 60,
      metrics: metricsRepo,
      events: eventsRepo,
      hashprice: () => 0.0098,
      runNow,
    });
  });
  afterEach(async () => {
    await app.close();
    await closeDatabase(handle);
  });

  it('GET /api/nicehash/metrics returns the windowed series', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/metrics?range=24h' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.range).toBe('24h');
    expect(body.rows.length).toBe(5);
    expect(body.rows[0].our_price_btc).toBe(0.0103);
  });

  it('GET /api/nicehash/history filters by action', async () => {
    const all = (await app.inject({ method: 'GET', url: '/api/nicehash/history' })).json();
    expect(all.events.length).toBe(2);
    const edits = (
      await app.inject({ method: 'GET', url: '/api/nicehash/history?action=EDIT_PRICE' })
    ).json();
    expect(edits.events.length).toBe(1);
    expect(edits.events[0].action).toBe('EDIT_PRICE');
  });

  it('GET /api/nicehash/summary returns tiles + lifetime spend + hashprice', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/nicehash/summary?range=24h' })).json();
    expect(body.summary.samples).toBe(5);
    expect(body.summary.uptime_pct).toBe(100);
    expect(body.summary.avg_our_price_btc).toBeCloseTo(0.0103, 9);
    expect(body.hashprice_now).toBe(0.0098);
    expect(body.lifetime_spent_btc).toBe(0);
    expect(body.current.ts).toBeGreaterThan(0);
  });

  it('POST /api/nicehash/run-now triggers a tick', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/nicehash/run-now' });
    expect(res.json()).toEqual({ ok: true });
    expect(runNow).toHaveBeenCalledTimes(1);
  });
});
