import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../db.js';
import {
  NiceHashBookSnapshotsRepo,
  type NiceHashBookSnapshot,
} from './nicehash_book_snapshots.js';

function snap(ts: number, over: Partial<NiceHashBookSnapshot> = {}): NiceHashBookSnapshot {
  return {
    ts,
    marginal_price_btc: 0.4788,
    raw_tier_btc: 0.4789,
    smoothed_tier_btc: 0.4789,
    rows: [
      {
        id: 'top',
        price_btc: 0.49,
        limit_units: 5,
        rigs_count: 5000,
        accepted_speed_units: 0.2,
        debounce_state: 'filled',
      },
      {
        id: 'z1',
        price_btc: 0.4788,
        limit_units: 5,
        rigs_count: 0,
        accepted_speed_units: 0,
        debounce_state: 'confirmed_zero',
      },
      {
        id: null, // id-less rows survive the round trip too
        price_btc: 0.47,
        limit_units: 0.001,
        rigs_count: null,
        accepted_speed_units: null,
        debounce_state: 'confirmed_zero',
      },
    ],
    ...over,
  };
}

describe('NiceHashBookSnapshotsRepo', () => {
  let handle: DatabaseHandle;
  let repo: NiceHashBookSnapshotsRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new NiceHashBookSnapshotsRepo(handle.db);
  });
  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('round-trips a snapshot through the gzipped blob (latest)', async () => {
    const s = snap(1000);
    await repo.record(s);
    const back = await repo.latest();
    expect(back).toEqual(s);
  });

  it('upserts on ts conflict (one row per tick)', async () => {
    await repo.record(snap(1000, { smoothed_tier_btc: 0.4789 }));
    await repo.record(snap(1000, { smoothed_tier_btc: 0.4813 }));
    const meta = await repo.meta();
    expect(meta.count).toBe(1);
    expect((await repo.get(1000))?.smoothed_tier_btc).toBe(0.4813);
  });

  it('meta reports count, span, and stored size', async () => {
    await repo.record(snap(1000));
    await repo.record(snap(3000));
    const meta = await repo.meta();
    expect(meta.count).toBe(2);
    expect(meta.first_ts).toBe(1000);
    expect(meta.last_ts).toBe(3000);
    expect(meta.stored_bytes).toBeGreaterThan(0);
  });

  it('listTs returns the MOST RECENT n snapshots in range, ascending', async () => {
    for (const ts of [1000, 2000, 3000, 4000, 5000]) await repo.record(snap(ts));
    expect(await repo.listTs({ limit: 3 })).toEqual([3000, 4000, 5000]);
    expect(await repo.listTs({ fromMs: 2000, toMs: 4000, limit: 10 })).toEqual([
      2000, 3000, 4000,
    ]);
    expect(await repo.listTs({ fromMs: 2000, toMs: 4000, limit: 2 })).toEqual([3000, 4000]);
  });

  it('prunes rows older than the cutoff', async () => {
    for (const ts of [1000, 2000, 3000]) await repo.record(snap(ts));
    const deleted = await repo.pruneOlderThan(2500);
    expect(deleted).toBe(2);
    expect((await repo.meta()).count).toBe(1);
    expect((await repo.latest())?.ts).toBe(3000);
  });

  it('clearAll wipes every snapshot and reports the count', async () => {
    for (const ts of [1000, 2000, 3000]) await repo.record(snap(ts));
    expect(await repo.clearAll()).toBe(3);
    expect((await repo.meta()).count).toBe(0);
    expect(await repo.latest()).toBeNull();
    expect(await repo.clearAll()).toBe(0); // idempotent on an empty table
  });

  it('nullable tier readings round-trip (a null-tier tick)', async () => {
    const s = snap(1000, { raw_tier_btc: null, smoothed_tier_btc: null });
    await repo.record(s);
    const back = await repo.get(1000);
    expect(back?.raw_tier_btc).toBeNull();
    expect(back?.smoothed_tier_btc).toBeNull();
  });
});
