import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { NiceHashStateStore } from '../controller/nicehash/state-store.js';
import { SECRET_MASK, settingsFromEnv, type NiceHashSettings } from '../controller/nicehash/settings.js';
import type { NiceHashControllerConfig } from '../controller/nicehash/types.js';
import type { NiceHashTickResult } from '../controller/nicehash/tick.js';
import { closeDatabase, openDatabase, type DatabaseHandle } from '../state/db.js';
import { NiceHashBookSnapshotsRepo } from '../state/repos/nicehash_book_snapshots.js';
import { NiceHashOrdersRepo } from '../state/repos/nicehash_orders.js';
import { NiceHashMetricsRepo } from '../state/repos/nicehash_tick_metrics.js';
import { NiceHashEventsRepo } from '../state/repos/nicehash_order_events.js';
import { NiceHashDecisionLogRepo } from '../state/repos/nicehash_decision_log.js';
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
      market: { anchor_price_btc: 0.0102, total_speed_units: 537, thin: false, filled_prices: [0.0102, 0.0105] },
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
    expect(body.market.next_filled_price_btc).toBe(0.0105);
    expect(body.balance_btc).toBe(0.001);
    expect(body.proposals[0]).toEqual({ kind: 'CREATE_ORDER', reason: 'create' });
    expect(body.outcomes[0]).toEqual({ kind: 'CREATE_ORDER', outcome: 'BLOCKED', detail: 'RUN_MODE_NOT_LIVE' });
  });

  it('GET /api/nicehash/status reflects a live tickSeconds getter (no restart)', async () => {
    let tick = 60;
    const app2 = await createNiceHashHttpServer({ ...deps(store, settings.repo), tickSeconds: () => tick });
    try {
      let body = (await app2.inject({ method: 'GET', url: '/api/nicehash/status' })).json();
      expect(body.tick_seconds).toBe(60);
      tick = 30; // simulate a live "Tick seconds" config edit
      body = (await app2.inject({ method: 'GET', url: '/api/nicehash/status' })).json();
      expect(body.tick_seconds).toBe(30);
    } finally {
      await app2.close();
    }
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

describe('status next_action - live hold countdown', () => {
  let app: FastifyInstance;
  let store: NiceHashStateStore;

  beforeEach(async () => {
    store = new NiceHashStateStore('LIVE');
    app = await createNiceHashHttpServer(deps(store, fakeSettingsRepo(settingsFromEnv({})).repo));
  });
  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  it('formats the hold with a remaining time computed at REQUEST time (counts down between polls)', async () => {
    const base = 1_700_000_000_000;
    const edit = {
      kind: 'EDIT_PRICE' as const,
      order_id: 'o1',
      new_price_btc: 0.4824,
      old_price_btc: 0.4825,
      reason: 'walk down (de-escalating): ...',
    };
    store.setLast({
      ...tickResult(),
      proposals: [edit],
      outcomes: [{ proposal: edit, outcome: 'BLOCKED', reason: 'PRICE_DECREASE_COOLDOWN' }],
      hold_reason: {
        kind: 'DECREASE_COOLDOWN',
        until: base + 149_000, // NiceHash's own "Seconds till available" answer
        from_btc: 0.4825,
        to_btc: 0.4824,
        label: 'walk down (de-escalating)',
      },
    });

    vi.useFakeTimers();
    vi.setSystemTime(base);
    let body = (await app.inject({ method: 'GET', url: '/api/nicehash/status' })).json();
    expect(body.next_action).toBe(
      'walk down (de-escalating) 0.4825 -> 0.4824 — waiting on NiceHash decrease cooldown, ~2:29 remaining',
    );
    expect(body.outcomes[0].detail).toBe(
      'waiting on NiceHash decrease cooldown, ~2:29 remaining',
    );

    // 100s later, WITHOUT a new tick: the countdown moved - it is computed per
    // request, never frozen at tick time.
    vi.setSystemTime(base + 100_000);
    body = (await app.inject({ method: 'GET', url: '/api/nicehash/status' })).json();
    expect(body.next_action).toContain('~0:49 remaining');
    expect(body.outcomes[0].detail).toContain('~0:49 remaining');
  });

  it('clears the hold story when the next tick has a real action or no hold', async () => {
    store.setLast({ ...tickResult(), hold_reason: null });
    const body = (await app.inject({ method: 'GET', url: '/api/nicehash/status' })).json();
    expect(body.next_action).toBeNull();
  });
});

/** Minimal RFC 4180 parser - just enough to prove the CSV export round-trips
 *  fields containing commas, quotes, and embedded newlines correctly. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('NiceHash HTTP server - CSV export', () => {
  let handle: DatabaseHandle;
  let app: FastifyInstance;
  let eventsRepo: NiceHashEventsRepo;
  let decisionLogRepo: NiceHashDecisionLogRepo;
  let ledger: NiceHashOrdersRepo;

  const trickyReason = 'walk up, "escalating", 2 steps\nsecond line';
  const trickyMessage = 'blocked, reason: "cooldown", retry later';
  const trickyDetail = 'run=LIVE balance=0.001 anchor=0.0102\nEDIT_PRICE: walk down -> BLOCKED(PRICE_DECREASE_COOLDOWN)';

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    eventsRepo = new NiceHashEventsRepo(handle.db);
    decisionLogRepo = new NiceHashDecisionLogRepo(handle.db);
    ledger = new NiceHashOrdersRepo(handle.db);

    const now = Date.now();
    await decisionLogRepo.record({
      ts: now - 3000, level: 'info', kind: 'TICK', run_mode: 'LIVE',
      message: 'holding — no action', detail: 'run=LIVE balance=0.001 anchor=0.0102',
    });
    await decisionLogRepo.record({
      ts: now - 2000, level: 'warn', kind: 'TICK', run_mode: 'LIVE',
      message: trickyMessage, detail: trickyDetail,
    });
    await decisionLogRepo.record({
      ts: now - 1000, level: 'error', kind: 'ERROR', run_mode: 'LIVE',
      message: 'tick error: boom', detail: null,
    });

    await eventsRepo.record({
      ts: now - 5000, order_id: 'order-1', action: 'CREATE', run_mode: 'LIVE', outcome: 'EXECUTED',
      price_before: null, price_after: 0.0102, limit_before: null, limit_after: 1,
      amount_btc: 0.001, anchor_price_btc: 0.0102, reason: 'initial create', detail: 'ok',
    });
    await eventsRepo.record({
      ts: now - 4000, order_id: 'order-1', action: 'EDIT_PRICE', run_mode: 'LIVE', outcome: 'EXECUTED',
      price_before: 0.0102, price_after: 0.0105, limit_before: null, limit_after: null,
      amount_btc: null, anchor_price_btc: 0.0103, reason: trickyReason, detail: 'ok',
    });
    await eventsRepo.record({
      ts: now - 3000, order_id: 'order-1', action: 'CANCEL', run_mode: 'LIVE', outcome: 'FAILED',
      price_before: 0.0105, price_after: null, limit_before: 1, limit_after: null,
      amount_btc: null, anchor_price_btc: null, reason: 'operator requested', detail: 'err',
    });

    app = await createNiceHashHttpServer({
      store: new NiceHashStateStore('LIVE'),
      ledger,
      settingsRepo: fakeSettingsRepo(settingsFromEnv({})).repo,
      config: config(),
      buildNumber: 700,
      tickSeconds: 60,
      events: eventsRepo,
      decisionLog: decisionLogRepo,
    });
  });
  afterEach(async () => {
    await app.close();
    await closeDatabase(handle);
  });

  it('GET /api/nicehash/logs.csv returns a CSV attachment with a UTF-8 BOM and the expected columns', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/logs.csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="nicehash-decision-log-\d{8}-\d{6}\.csv"$/,
    );
    expect(res.body.charCodeAt(0)).toBe(0xfeff); // BOM so Excel detects UTF-8
    const rows = parseCsv(res.body.slice(1));
    expect(rows[0]).toEqual(['when_iso', 'when_ms', 'level', 'mode', 'summary', 'detail']);
    expect(rows.length).toBe(4); // header + 3 log rows
  });

  it('round-trips a summary/detail containing a comma, a double-quote, and a newline', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/logs.csv' });
    const rows = parseCsv(res.body.slice(1));
    const header = rows[0]!;
    const warnRow = rows.find((r) => r[header.indexOf('level')] === 'warn')!;
    expect(warnRow[header.indexOf('summary')]).toBe(trickyMessage);
    expect(warnRow[header.indexOf('detail')]).toBe(trickyDetail);
  });

  it('GET /api/nicehash/logs.csv honors the level filter (level=warn only exports warn rows)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/logs.csv?level=warn' });
    const rows = parseCsv(res.body.slice(1));
    expect(rows.length).toBe(2); // header + 1 warn row
    expect(rows[1]![rows[0]!.indexOf('level')]).toBe('warn');
  });

  it('GET /api/nicehash/history.csv returns a CSV attachment with a UTF-8 BOM and the expected columns', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/history.csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="nicehash-order-history-\d{8}-\d{6}\.csv"$/,
    );
    expect(res.body.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(res.body.slice(1));
    expect(rows[0]).toEqual([
      'when_iso', 'when_ms', 'order_id', 'action', 'outcome',
      'price_before_btc', 'price_after_btc', 'delta_btc', 'amount_btc', 'reason',
    ]);
    expect(rows.length).toBe(4); // header + 3 events
  });

  it('round-trips a reason containing a comma, a double-quote, and a newline', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/history.csv' });
    const rows = parseCsv(res.body.slice(1));
    const header = rows[0]!;
    const editRow = rows.find((r) => r[header.indexOf('action')] === 'EDIT_PRICE')!;
    expect(editRow[header.indexOf('reason')]).toBe(trickyReason);
    // Delta is computed from price_before/price_after (0.0105 - 0.0102).
    expect(Number(editRow[header.indexOf('delta_btc')])).toBeCloseTo(0.0003, 9);
  });

  it('GET /api/nicehash/history.csv honors the action filter (action=CANCEL only exports CANCEL rows)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/history.csv?action=CANCEL' });
    const rows = parseCsv(res.body.slice(1));
    expect(rows.length).toBe(2); // header + 1 CANCEL row
    expect(rows[1]![rows[0]!.indexOf('action')]).toBe('CANCEL');
  });

  it('clamps an oversized limit to 10000 and defaults to 5000 when absent', async () => {
    const spy = vi.spyOn(eventsRepo, 'list');
    await app.inject({ method: 'GET', url: '/api/nicehash/history.csv?limit=999999' });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ limit: 10000 }), 10000);
    spy.mockClear();
    await app.inject({ method: 'GET', url: '/api/nicehash/history.csv' });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ limit: 5000 }), 10000);
  });

  it('returns a header-only CSV when the repos are not wired up', async () => {
    const bareApp = await createNiceHashHttpServer({
      store: new NiceHashStateStore('LIVE'),
      ledger,
      settingsRepo: fakeSettingsRepo(settingsFromEnv({})).repo,
      config: config(),
      buildNumber: 700,
      tickSeconds: 60,
    });
    try {
      const logsRes = await bareApp.inject({ method: 'GET', url: '/api/nicehash/logs.csv' });
      expect(parseCsv(logsRes.body.slice(1)).length).toBe(1);
      const histRes = await bareApp.inject({ method: 'GET', url: '/api/nicehash/history.csv' });
      expect(parseCsv(histRes.body.slice(1)).length).toBe(1);
      const bookRes = await bareApp.inject({ method: 'GET', url: '/api/nicehash/book.csv' });
      expect(parseCsv(bookRes.body.slice(1)).length).toBe(1);
    } finally {
      await bareApp.close();
    }
  });
});

describe('NiceHash HTTP server - order-book capture', () => {
  let handle: DatabaseHandle;
  let app: FastifyInstance;
  let bookRepo: NiceHashBookSnapshotsRepo;

  const row = (
    id: string,
    price: number,
    rigs: number,
    state: 'filled' | 'unconfirmed_zero' | 'confirmed_zero' | 'recovering_nonzero',
  ) => ({
    id,
    price_btc: price,
    limit_units: 5,
    rigs_count: rigs,
    accepted_speed_units: 0,
    debounce_state: state,
  });

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    bookRepo = new NiceHashBookSnapshotsRepo(handle.db);
    await bookRepo.record({
      ts: 1000,
      marginal_price_btc: 0.4788,
      raw_tier_btc: 0.4789,
      smoothed_tier_btc: 0.4789,
      rows: [row('top', 0.49, 5000, 'filled'), row('z1', 0.4788, 0, 'confirmed_zero')],
    });
    await bookRepo.record({
      ts: 2000,
      marginal_price_btc: 0.4788,
      raw_tier_btc: null,
      smoothed_tier_btc: 0.4789,
      rows: [row('top', 0.49, 5000, 'filled'), row('z1', 0.4788, 20, 'recovering_nonzero')],
    });
    await bookRepo.record({
      ts: 3000,
      marginal_price_btc: 0.4788,
      raw_tier_btc: 0.4789,
      smoothed_tier_btc: 0.4789,
      rows: [row('top', 0.49, 5000, 'filled'), row('z1', 0.4788, 0, 'confirmed_zero')],
    });
    app = await createNiceHashHttpServer({
      store: new NiceHashStateStore('LIVE'),
      ledger: { list: vi.fn(async () => []) } as unknown as NiceHashOrdersRepo,
      settingsRepo: fakeSettingsRepo(settingsFromEnv({})).repo,
      config: config(),
      buildNumber: 700,
      tickSeconds: 60,
      bookSnapshots: bookRepo,
    });
  });
  afterEach(async () => {
    await app.close();
    await closeDatabase(handle);
  });

  it('GET /api/nicehash/book returns the capture status and the latest snapshot', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/book' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.capturing).toBe(true); // config omits the toggle -> defaults on
    expect(body.capture.count).toBe(3);
    expect(body.capture.first_ts).toBe(1000);
    expect(body.capture.last_ts).toBe(3000);
    expect(body.capture.stored_bytes).toBeGreaterThan(0);
    expect(body.latest.ts).toBe(3000);
    expect(body.latest.rows).toHaveLength(2);
    expect(body.latest.rows[1].debounce_state).toBe('confirmed_zero');
  });

  it('GET /api/nicehash/book reports not-capturing when no repo is wired', async () => {
    const bare = await createNiceHashHttpServer({
      store: new NiceHashStateStore('LIVE'),
      ledger: { list: vi.fn(async () => []) } as unknown as NiceHashOrdersRepo,
      settingsRepo: fakeSettingsRepo(settingsFromEnv({})).repo,
      config: config(),
      buildNumber: 700,
      tickSeconds: 60,
    });
    try {
      const body = (await bare.inject({ method: 'GET', url: '/api/nicehash/book' })).json();
      expect(body).toEqual({ capturing: false, capture: null, latest: null });
    } finally {
      await bare.close();
    }
  });

  it('GET /api/nicehash/book.csv streams one line per order row per snapshot, chronological', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/book.csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="nicehash-order-book-\d{8}-\d{6}\.csv"$/,
    );
    expect(res.body.charCodeAt(0)).toBe(0xfeff); // BOM
    const rows = parseCsv(res.body.slice(1));
    expect(rows[0]).toEqual([
      'when_iso', 'when_ms', 'marginal_btc', 'raw_tier_btc', 'smoothed_tier_btc',
      'order_id', 'price_btc', 'limit_units', 'rigs', 'speed_units', 'debounce_state',
    ]);
    expect(rows.length).toBe(1 + 3 * 2); // header + 3 snapshots x 2 rows
    const header = rows[0]!;
    // Chronological order, and the flattened fields land in the right columns.
    expect(rows[1]![header.indexOf('when_ms')]).toBe('1000');
    expect(rows[5]![header.indexOf('when_ms')]).toBe('3000');
    const flicker = rows.find((r) => r[header.indexOf('debounce_state')] === 'recovering_nonzero')!;
    expect(flicker[header.indexOf('when_ms')]).toBe('2000');
    expect(flicker[header.indexOf('rigs')]).toBe('20');
    expect(flicker[header.indexOf('raw_tier_btc')]).toBe(''); // honest null in the export
    expect(flicker[header.indexOf('smoothed_tier_btc')]).toBe('0.4789');
  });

  it('GET /api/nicehash/book.csv honors the snapshot cap (most recent first, emitted ascending)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/book.csv?snapshots=2' });
    const rows = parseCsv(res.body.slice(1));
    expect(rows.length).toBe(1 + 2 * 2); // header + the 2 MOST RECENT snapshots
    const header = rows[0]!;
    expect(rows[1]![header.indexOf('when_ms')]).toBe('2000'); // 1000 dropped by the cap
    expect(rows[4]![header.indexOf('when_ms')]).toBe('3000');
  });

  it('GET /api/nicehash/book.csv honors a from/to window', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/book.csv?from=1500&to=2500' });
    const rows = parseCsv(res.body.slice(1));
    expect(rows.length).toBe(1 + 2); // header + the single ts=2000 snapshot
    expect(rows[1]![rows[0]!.indexOf('when_ms')]).toBe('2000');
  });

  it('GET /api/nicehash/book.csv ends the (partial) response instead of hanging when a snapshot read fails mid-stream', async () => {
    const original = bookRepo.get.bind(bookRepo);
    vi.spyOn(bookRepo, 'get').mockImplementation(async (ts: number) => {
      if (ts === 2000) throw new Error('blob corrupted');
      return original(ts);
    });
    // inject() only resolves once the response ENDS - a hang here would time
    // the test out. The export is cut short at the failing snapshot but the
    // client still gets a complete (partial) CSV.
    const res = await app.inject({ method: 'GET', url: '/api/nicehash/book.csv' });
    expect(res.statusCode).toBe(200);
    const rows = parseCsv(res.body.slice(1));
    expect(rows.length).toBe(1 + 2); // header + the ts=1000 snapshot's 2 rows only
    expect(rows[1]![rows[0]!.indexOf('when_ms')]).toBe('1000');
  });

  it('POST /api/nicehash/book/clear wipes every snapshot and reports the count', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/nicehash/book/clear' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 3 });
    const after = (await app.inject({ method: 'GET', url: '/api/nicehash/book' })).json();
    expect(after.capture.count).toBe(0);
    expect(after.latest).toBeNull();
    // Idempotent: clearing an already-empty store deletes nothing.
    expect((await app.inject({ method: 'POST', url: '/api/nicehash/book/clear' })).json()).toEqual({ deleted: 0 });
  });

  it('POST /api/nicehash/book/clear reports 0 when no repo is wired', async () => {
    const bare = await createNiceHashHttpServer({
      store: new NiceHashStateStore('LIVE'),
      ledger: { list: vi.fn(async () => []) } as unknown as NiceHashOrdersRepo,
      settingsRepo: fakeSettingsRepo(settingsFromEnv({})).repo,
      config: config(),
      buildNumber: 700,
      tickSeconds: 60,
    });
    try {
      const res = await bare.inject({ method: 'POST', url: '/api/nicehash/book/clear' });
      expect(res.json()).toEqual({ deleted: 0 });
    } finally {
      await bare.close();
    }
  });
});
