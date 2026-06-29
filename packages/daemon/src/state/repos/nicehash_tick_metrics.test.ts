import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../db.js';
import { NiceHashMetricsRepo, type NiceHashMetricRow } from './nicehash_tick_metrics.js';

function row(ts: number, over: Partial<NiceHashMetricRow> = {}): NiceHashMetricRow {
  return {
    ts,
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
    spend_rate_btc_day: 0.00927,
    hashprice_btc_per_unit_day: 0.0098,
    owned_count: 1,
    unknown_count: 0,
    ...over,
  };
}

describe('NiceHashMetricsRepo', () => {
  let handle: DatabaseHandle;
  let repo: NiceHashMetricsRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new NiceHashMetricsRepo(handle.db);
  });
  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('records and reads a range ascending by ts', async () => {
    await repo.record(row(2000));
    await repo.record(row(1000));
    await repo.record(row(3000));
    const rows = await repo.range(1500);
    expect(rows.map((r) => r.ts)).toEqual([2000, 3000]);
  });

  it('upserts on ts conflict', async () => {
    await repo.record(row(1000, { our_price_btc: 0.01 }));
    await repo.record(row(1000, { our_price_btc: 0.02 }));
    const rows = await repo.range(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.our_price_btc).toBe(0.02);
  });

  it('returns the latest row', async () => {
    await repo.record(row(1000));
    await repo.record(row(5000, { our_price_btc: 0.05 }));
    await repo.record(row(3000));
    expect((await repo.latest())?.ts).toBe(5000);
  });

  it('summarises a window (uptime from api_ok, averages ignore nulls)', async () => {
    await repo.record(row(1000, { api_ok: 1, our_price_btc: 0.01, hashprice_btc_per_unit_day: 0.02 }));
    await repo.record(row(2000, { api_ok: 0, our_price_btc: null, hashprice_btc_per_unit_day: null }));
    await repo.record(row(3000, { api_ok: 1, our_price_btc: 0.03, hashprice_btc_per_unit_day: 0.04 }));
    const s = await repo.summary(0);
    expect(s.samples).toBe(3);
    expect(s.uptime_pct).toBeCloseTo((2 / 3) * 100, 6);
    expect(s.avg_our_price_btc).toBeCloseTo(0.02, 9); // (0.01 + 0.03) / 2
    expect(s.avg_hashprice_btc_per_unit_day).toBeCloseTo(0.03, 9);
    expect(s.first_ts).toBe(1000);
    expect(s.last_ts).toBe(3000);
  });

  it('prunes rows older than the cutoff', async () => {
    await repo.record(row(1000));
    await repo.record(row(2000));
    await repo.record(row(3000));
    const deleted = await repo.pruneOlderThan(2500);
    expect(deleted).toBe(2);
    expect((await repo.range(0)).map((r) => r.ts)).toEqual([3000]);
  });
});
