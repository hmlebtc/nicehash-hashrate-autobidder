import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../db.js';
import { NiceHashOrdersRepo } from './nicehash_orders.js';

describe('NiceHashOrdersRepo', () => {
  let handle: DatabaseHandle;
  let repo: NiceHashOrdersRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new NiceHashOrdersRepo(handle.db);
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  const insertArgs = {
    order_id: 'order-1',
    created_at: 1_700_000_000_000,
    price_btc: 0.0102,
    amount_btc: 0.01,
    limit_units: 4,
    pool_id: 'pool-1',
  };

  it('inserts and reads back an order (idempotent on order_id)', async () => {
    await repo.insert(insertArgs);
    await repo.insert(insertArgs); // duplicate is a no-op
    const ids = await repo.getIds();
    expect([...ids]).toEqual(['order-1']);
    const rows = await repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      order_id: 'order-1',
      price_btc: 0.0102,
      amount_btc: 0.01,
      limit_units: 4,
      pool_id: 'pool-1',
      payed_amount_btc: 0,
      last_price_decrease_at: null,
      abandoned: false,
    });
  });

  it('records and surfaces price-decrease timestamps', async () => {
    await repo.insert(insertArgs);
    expect((await repo.lastPriceDecreaseMap()).size).toBe(0);
    await repo.setLastPriceDecrease('order-1', 1_700_000_100_000, 0.0101);
    const map = await repo.lastPriceDecreaseMap();
    expect(map.get('order-1')).toBe(1_700_000_100_000);
    const row = (await repo.list())[0];
    expect(row?.price_btc).toBe(0.0101);
  });

  it('tracks last_price_change_at on insert, raises, and decreases', async () => {
    await repo.insert(insertArgs);
    // insert seeds the settle window at created_at
    expect((await repo.lastPriceChangeMap()).get('order-1')).toBe(insertArgs.created_at);
    // an upward change bumps the change timestamp but not the decrease one
    await repo.setLastPriceChange('order-1', 1_700_000_200_000, 0.0105);
    expect((await repo.lastPriceChangeMap()).get('order-1')).toBe(1_700_000_200_000);
    expect((await repo.lastPriceDecreaseMap()).size).toBe(0);
    expect((await repo.list())[0]?.price_btc).toBe(0.0105);
    // a decrease bumps both
    await repo.setLastPriceDecrease('order-1', 1_700_000_300_000, 0.01);
    expect((await repo.lastPriceChangeMap()).get('order-1')).toBe(1_700_000_300_000);
    expect((await repo.lastPriceDecreaseMap()).get('order-1')).toBe(1_700_000_300_000);
  });

  it('reconciles status/price/limit and keeps payed monotonic', async () => {
    await repo.insert(insertArgs);
    await repo.reconcileFromApi([
      { order_id: 'order-1', status: 'ACTIVE', price_btc: 0.0103, amount_btc: 0.01, limit_units: 4, payed_amount_btc: 0.002 },
    ]);
    let row = (await repo.list())[0];
    expect(row?.last_known_status).toBe('ACTIVE');
    expect(row?.price_btc).toBe(0.0103);
    expect(row?.payed_amount_btc).toBe(0.002);

    // A lower payed reading from a later poll must not roll the total back.
    await repo.reconcileFromApi([
      { order_id: 'order-1', status: 'ACTIVE', price_btc: 0.0103, amount_btc: 0.01, limit_units: 4, payed_amount_btc: 0.0019 },
    ]);
    row = (await repo.list())[0];
    expect(row?.payed_amount_btc).toBe(0.002);
  });

  it('does not insert unknown orders during reconcile', async () => {
    await repo.reconcileFromApi([
      { order_id: 'stranger', status: 'ACTIVE', price_btc: 0.02, amount_btc: 0.01, limit_units: 1, payed_amount_btc: 0 },
    ]);
    expect((await repo.getIds()).size).toBe(0);
  });

  it('marks an order cancelled', async () => {
    await repo.insert(insertArgs);
    await repo.markCancelled('order-1');
    expect((await repo.list())[0]?.last_known_status).toBe('CANCELLED');
  });

  it('sums lifetime spend', async () => {
    await repo.insert(insertArgs);
    await repo.insert({ ...insertArgs, order_id: 'order-2' });
    await repo.reconcileFromApi([
      { order_id: 'order-1', status: 'DEAD', price_btc: 0.0102, amount_btc: 0.01, limit_units: 4, payed_amount_btc: 0.003 },
      { order_id: 'order-2', status: 'ACTIVE', price_btc: 0.0102, amount_btc: 0.01, limit_units: 4, payed_amount_btc: 0.004 },
    ]);
    expect(await repo.sumLifetimePayedBtc()).toBeCloseTo(0.007, 12);
  });
});
