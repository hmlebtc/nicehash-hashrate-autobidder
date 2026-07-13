import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NiceHashClient } from '@hashrate-autopilot/nicehash-client';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../../state/db.js';
import { NiceHashOrdersRepo } from '../../state/repos/nicehash_orders.js';
import { NiceHashMetricsRepo } from '../../state/repos/nicehash_tick_metrics.js';
import { NiceHashEventsRepo } from '../../state/repos/nicehash_order_events.js';
import type { NiceHashService } from '../../services/nicehash-service.js';
import { NiceHashController, parseChangeSettleRejection, parseDecreaseCooldownRejection } from './controller.js';
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

  it('a ladder raise resets neither the ladder nor the episode grace clock (episode continuation)', async () => {
    // Episode-based grace: the under-filled clock marks the START of the
    // episode. The ladder's own executed raises must not reset it (or every
    // step would wait out a fresh grace), and the ladder offset itself must
    // survive its own raises (or every step would restart the climb from 0).
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
        walk_up_grace_seconds: 180, // a REAL grace - the episode clock matters
        escalation_step_btc: 0.0002,
        escalation_interval_seconds: 60,
      },
      currency: 'BTC',
      balanceCurrency: 'TBTC',
      runMode: () => 'LIVE',
      now: () => t,
    });

    // Tick 1: first sighting stamps the episode clock; the grace (180s) has
    // not elapsed, so no escalation and no climb yet.
    const r1 = await controller.tick();
    expect(r1.proposals.find((p) => p.kind === 'EDIT_PRICE')).toBeUndefined();

    // Tick 2, 180s later: the episode grace has elapsed -> the ladder starts
    // one step up and the raise executes.
    t += 180_000;
    const r2 = await controller.tick();
    const e2 = r2.proposals.find((p) => p.kind === 'EDIT_PRICE');
    if (e2?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE in tick 2');
    expect(e2.new_price_btc).toBeCloseTo(0.01021 + 0.0002, 9);
    expect(r2.outcomes.find((o) => o.proposal === e2)?.outcome).toBe('EXECUTED');

    // Tick 3, one INTERVAL (60s < grace 180s) later, still under-filled: the
    // episode clock must be untouched by tick 2's raise, so the ladder steps
    // again (0.0002 -> 0.0004) and the climb proposes. Had the raise reset the
    // clock, gracePassed would be false here - no step, no proposal.
    t += 60_000;
    const r3 = await controller.tick();
    const e3 = r3.proposals.find((p) => p.kind === 'EDIT_PRICE');
    if (e3?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE in tick 3');
    expect(e3.new_price_btc).toBeCloseTo(0.01021 + 0.0004, 9);
  });

  it('a plain floor-tracking raise (ladder not engaged) still resets the grace clock', async () => {
    // Regression guard on the pre-existing pacing: with walk-up disabled the
    // ladder never engages, so an executed floor-tracking raise resets the
    // under-filled-since clock - the next under-fill episode is dated from the
    // raise, not from first sight.
    await ledger.insert({
      order_id: 'mine',
      created_at: 1,
      price_btc: 0.0099,
      amount_btc: 0.01,
      limit_units: 4,
      pool_id: 'pool-1',
    });
    // Mutable myOrders row: filled at tick 1 (raise executes while filled),
    // under-filled from tick 2 on.
    const row: Record<string, unknown> = {
      id: 'mine',
      status: { code: 'ACTIVE' },
      price: '0.0099', // parked below the floor (anchor 0.0102 + overpay)
      limit: '4',
      amount: '0.01',
      availableAmount: '0.01',
      acceptedCurrentSpeed: '4', // filled (>= threshold 3.2)
    };
    const svc = service([row]);
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
        walk_up_enabled: false, // pure floor-tracking: ladder never engages
        walk_up_grace_seconds: 300,
        escalation_step_btc: 0.0002,
        escalation_interval_seconds: 60,
      },
      currency: 'BTC',
      balanceCurrency: 'TBTC',
      runMode: () => 'LIVE',
      now: () => t,
    });

    // Tick 1: filled (no grace stamp from observe) and below the floor -> pure
    // floor-tracking walk-up to 0.01021 executes -> persist resets the grace
    // clock to t1 (ladder not engaged).
    const t1 = t;
    const r1 = await controller.tick();
    const e1 = r1.proposals.find((p) => p.kind === 'EDIT_PRICE');
    if (e1?.kind !== 'EDIT_PRICE') throw new Error('expected EDIT_PRICE in tick 1');
    expect(e1.new_price_btc).toBeCloseTo(0.01021, 9);
    expect(r1.outcomes.find((o) => o.proposal === e1)?.outcome).toBe('EXECUTED');

    // Tick 2: fills drop. observe sees an existing grace entry from the raise
    // (t1) and keeps it - under_filled_since dates from the raise. Without the
    // reset-on-raise, the map would be empty and observe would stamp t2.
    row.acceptedCurrentSpeed = '0';
    t += 60_000;
    const r2 = await controller.tick();
    const mine = r2.state.owned_orders.find((o) => o.order_id === 'mine');
    expect(mine?.under_filled_since).toBe(t1);
  });
});

describe('parseDecreaseCooldownRejection', () => {
  it('extracts the remaining seconds from a 5061 rejection', () => {
    const msg =
      'POST /main/api/v2/hashpower/order/x/updatePriceAndLimit returned 400 - 5061: Order price decreased not allowed within 10 minutes of last price change. Seconds till available: 149';
    expect(parseDecreaseCooldownRejection(msg)).toEqual({ secondsRemaining: 149 });
  });

  it('matches on the message text even without the numeric code', () => {
    const msg = 'Order price decreased not allowed within 10 minutes of last price change. Seconds till available: 7';
    expect(parseDecreaseCooldownRejection(msg)).toEqual({ secondsRemaining: 7 });
  });

  it('returns secondsRemaining null when the countdown is missing/malformed', () => {
    expect(parseDecreaseCooldownRejection('400 - 5061: Order price decreased not allowed within 10 minutes of last price change.')).toEqual({
      secondsRemaining: null,
    });
  });

  it('returns null for unrelated errors', () => {
    expect(parseDecreaseCooldownRejection('500 internal error')).toBeNull();
    expect(parseDecreaseCooldownRejection('2997 Invalid input: PRICE_DATA_SCALE')).toBeNull();
  });
});

describe('parseChangeSettleRejection', () => {
  it('extracts the remaining seconds from a 5110 rejection (the incident message)', () => {
    const msg =
      'NiceHash API POST /main/api/v2/hashpower/order/x/updatePriceAndLimit/ returned 400 - 5110: Order price or limit cannot be changed yet. Seconds till available: 10';
    expect(parseChangeSettleRejection(msg)).toEqual({ secondsRemaining: 10 });
  });

  it('matches on the message text even without the numeric code', () => {
    expect(
      parseChangeSettleRejection('Order price or limit cannot be changed yet. Seconds till available: 7'),
    ).toEqual({ secondsRemaining: 7 });
  });

  it('returns secondsRemaining null when the countdown is missing/malformed', () => {
    expect(parseChangeSettleRejection('400 - 5110: Order price or limit cannot be changed yet.')).toEqual({
      secondsRemaining: null,
    });
  });

  it('returns null for unrelated errors, and the two parsers stay disjoint', () => {
    expect(parseChangeSettleRejection('500 - 2999: Generic Server Error')).toBeNull();
    // A 5061 decrease-cooldown message is NOT a settle rejection...
    expect(
      parseChangeSettleRejection(
        '400 - 5061: Order price decreased not allowed within 10 minutes of last price change. Seconds till available: 149',
      ),
    ).toBeNull();
    // ...and a 5110 settle message is NOT a decrease-cooldown rejection.
    expect(
      parseDecreaseCooldownRejection(
        '400 - 5110: Order price or limit cannot be changed yet. Seconds till available: 10',
      ),
    ).toBeNull();
  });
});

describe('NiceHashController - API-truth decrease cooldown', () => {
  let handle: DatabaseHandle;
  let ledger: NiceHashOrdersRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    ledger = new NiceHashOrdersRepo(handle.db);
  });
  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('5061 lifecycle: rejection resyncs the clock, gate holds until NiceHash allows, then the retry succeeds', async () => {
    // Bid parked above the floor -> a walk-down is proposed every tick.
    await ledger.insert({
      order_id: 'mine',
      created_at: 1, // ancient stamps: the derived fallback says "allowed"
      price_btc: 0.0106,
      amount_btc: 0.01,
      limit_units: 4,
      pool_id: 'pool-1',
    });
    const svc = service([
      {
        id: 'mine',
        status: { code: 'ACTIVE' },
        price: '0.0106',
        limit: '4',
        amount: '0.01',
        availableAmount: '0.01',
        acceptedCurrentSpeed: '4',
      },
    ]);
    const REJECTION =
      'POST .../updatePriceAndLimit returned 400 - 5061: Order price decreased not allowed within 10 minutes of last price change. Seconds till available: 149';
    const updatePriceAndLimit = vi
      .fn()
      .mockRejectedValueOnce(new Error(REJECTION)) // tick 1: NiceHash says no
      .mockResolvedValue({}); // later attempts succeed
    const cli = { ...client(), updatePriceAndLimit } as unknown as NiceHashClient;
    let t = 1_700_000_000_000;
    const t0 = t;
    const controller = new NiceHashController({
      service: svc,
      client: cli,
      ledger,
      config: { ...config(), walk_up_enabled: false, price_down_step_btc: 0.002 },
      currency: 'BTC',
      balanceCurrency: 'TBTC',
      runMode: () => 'LIVE',
      now: () => t,
    });

    // Tick 1: our knowledge says available -> ATTEMPT the decrease; NiceHash
    // rejects with its own countdown (149s) -> the clock resyncs to the API.
    const r1 = await controller.tick();
    const o1 = r1.outcomes.find((o) => o.proposal.kind === 'EDIT_PRICE');
    expect(o1?.outcome).toBe('FAILED');
    expect(updatePriceAndLimit).toHaveBeenCalledTimes(1);

    // Tick 2, 60s later: still inside NiceHash's window -> BLOCKED by the
    // gate, no API call wasted.
    t += 60_000;
    const r2 = await controller.tick();
    const o2 = r2.outcomes.find((o) => o.proposal.kind === 'EDIT_PRICE');
    expect(o2?.outcome).toBe('BLOCKED');
    if (o2?.outcome === 'BLOCKED') expect(o2.reason).toBe('PRICE_DECREASE_COOLDOWN');
    expect(updatePriceAndLimit).toHaveBeenCalledTimes(1);
    // The hold story carries the API-derived deadline for the live countdown.
    expect(r2.hold_reason?.kind).toBe('DECREASE_COOLDOWN');
    expect(r2.hold_reason?.until).toBe(t0 + 149_000);

    // Tick 3, past NiceHash's 149s: the retry fires and succeeds.
    t = t0 + 150_000;
    const r3 = await controller.tick();
    const o3 = r3.outcomes.find((o) => o.proposal.kind === 'EDIT_PRICE');
    expect(o3?.outcome).toBe('EXECUTED');
    expect(updatePriceAndLimit).toHaveBeenCalledTimes(2);

    // The executed decrease re-arms the clock: the next walk-down (the mock
    // still reports the old price) is BLOCKED for the full window.
    t += 60_000;
    const r4 = await controller.tick();
    const o4 = r4.outcomes.find((o) => o.proposal.kind === 'EDIT_PRICE');
    expect(o4?.outcome).toBe('BLOCKED');
    expect(updatePriceAndLimit).toHaveBeenCalledTimes(2);
  });

  it('an executed RAISE arms the decrease clock: a walk-down right after is gate-blocked, not API-rejected', async () => {
    // The operator-reported bug: climb, then the floor drops, and the probe
    // walk-down within 10 min of the climb went straight to a 400/5061.
    await ledger.insert({
      order_id: 'mine',
      created_at: 1,
      price_btc: 0.0099,
      amount_btc: 0.01,
      limit_units: 4,
      pool_id: 'pool-1',
    });
    let rivalPrice = '0.0102';
    const svc = service([
      {
        id: 'mine',
        status: { code: 'ACTIVE' },
        price: '0.0099',
        limit: '4',
        amount: '0.01',
        availableAmount: '0.01',
        acceptedCurrentSpeed: '4',
      },
    ]);
    (svc.getOrderBook as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      stats: { BTC: { totalSpeed: '100', orders: [{ id: 'rival', price: rivalPrice, limit: '5', alive: true }] } },
    }));
    const updatePriceAndLimit = vi.fn(async () => ({}));
    const cli = { ...client(), updatePriceAndLimit } as unknown as NiceHashClient;
    let t = 1_700_000_000_000;
    const controller = new NiceHashController({
      service: svc,
      client: cli,
      ledger,
      config: { ...config(), walk_up_enabled: false, price_down_step_btc: 0.002 },
      currency: 'BTC',
      balanceCurrency: 'TBTC',
      runMode: () => 'LIVE',
      now: () => t,
    });

    // Tick 1: bid below the floor -> raise executes (arms the clock).
    const r1 = await controller.tick();
    const e1 = r1.proposals.find((p) => p.kind === 'EDIT_PRICE');
    if (e1?.kind !== 'EDIT_PRICE') throw new Error('expected a raise in tick 1');
    expect(e1.new_price_btc).toBeGreaterThan(e1.old_price_btc);
    expect(r1.outcomes.find((o) => o.proposal === e1)?.outcome).toBe('EXECUTED');

    // Tick 2, 60s later: the floor drops well below the bid -> walk-down
    // proposed, but NiceHash would reject it (10 min since ANY change) - the
    // gate now holds it instead of burning the API call.
    rivalPrice = '0.0090';
    t += 60_000;
    const r2 = await controller.tick();
    const e2 = r2.proposals.find((p) => p.kind === 'EDIT_PRICE');
    if (e2?.kind !== 'EDIT_PRICE') throw new Error('expected a walk-down in tick 2');
    expect(e2.new_price_btc).toBeLessThan(e2.old_price_btc);
    const o2 = r2.outcomes.find((o) => o.proposal === e2);
    expect(o2?.outcome).toBe('BLOCKED');
    expect(updatePriceAndLimit).toHaveBeenCalledTimes(1); // only the raise
  });
});
