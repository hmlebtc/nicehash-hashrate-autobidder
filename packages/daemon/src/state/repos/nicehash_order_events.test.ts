import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../db.js';
import {
  NiceHashEventsRepo,
  type NiceHashOrderEventInput,
} from './nicehash_order_events.js';

function ev(over: Partial<NiceHashOrderEventInput> = {}): NiceHashOrderEventInput {
  return {
    ts: 1000,
    order_id: 'order-1',
    action: 'EDIT_PRICE',
    run_mode: 'LIVE',
    outcome: 'EXECUTED',
    price_before: 0.0102,
    price_after: 0.0103,
    limit_before: null,
    limit_after: null,
    amount_btc: null,
    anchor_price_btc: 0.0102,
    reason: 'track anchor',
    detail: 'updatePriceAndLimit OK',
    ...over,
  };
}

describe('NiceHashEventsRepo', () => {
  let handle: DatabaseHandle;
  let repo: NiceHashEventsRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new NiceHashEventsRepo(handle.db);
  });
  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('records and lists newest-first', async () => {
    await repo.record(ev({ ts: 1000 }));
    await repo.record(ev({ ts: 3000 }));
    await repo.record(ev({ ts: 2000 }));
    const rows = await repo.list();
    expect(rows.map((r) => r.ts)).toEqual([3000, 2000, 1000]);
  });

  it('filters by action', async () => {
    await repo.record(ev({ ts: 1, action: 'CREATE' }));
    await repo.record(ev({ ts: 2, action: 'EDIT_PRICE' }));
    await repo.record(ev({ ts: 3, action: 'CANCEL' }));
    const rows = await repo.list({ actions: ['CREATE', 'CANCEL'] });
    expect(rows.map((r) => r.action).sort()).toEqual(['CANCEL', 'CREATE']);
  });

  it('filters by order id substring', async () => {
    await repo.record(ev({ ts: 1, order_id: 'abc123' }));
    await repo.record(ev({ ts: 2, order_id: 'xyz789' }));
    const rows = await repo.list({ orderIdContains: 'bc1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.order_id).toBe('abc123');
  });

  it('filters by minimum absolute price delta', async () => {
    await repo.record(ev({ ts: 1, price_before: 0.0102, price_after: 0.01021 })); // Δ 0.00001
    await repo.record(ev({ ts: 2, price_before: 0.0102, price_after: 0.0112 })); // Δ 0.001
    await repo.record(ev({ ts: 3, price_before: 0.02, price_after: 0.01 })); // Δ -0.01
    const rows = await repo.list({ minAbsDeltaPrice: 0.0005 });
    expect(rows.map((r) => r.ts).sort()).toEqual([2, 3]);
  });

  it('filters by time window and respects limit', async () => {
    for (let i = 1; i <= 5; i++) await repo.record(ev({ ts: i * 1000 }));
    const windowed = await repo.list({ sinceMs: 2000, untilMs: 4000 });
    expect(windowed.map((r) => r.ts)).toEqual([4000, 3000, 2000]);
    const limited = await repo.list({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('prunes rows older than the cutoff', async () => {
    await repo.record(ev({ ts: 1000 }));
    await repo.record(ev({ ts: 5000 }));
    const deleted = await repo.pruneOlderThan(3000);
    expect(deleted).toBe(1);
    expect((await repo.list()).map((r) => r.ts)).toEqual([5000]);
  });
});
