import { describe, expect, it, vi } from 'vitest';

import { HashpriceOracle } from './nicehash-hashprice.js';

/** Fake fetch returning canned JSON per mempool endpoint. */
function fakeFetch(data: { difficulty?: number; totalReward?: number }, fail = false): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    if (fail) throw new Error('network down');
    const u = String(url);
    const body = u.includes('/mining/hashrate/')
      ? { currentDifficulty: data.difficulty }
      : { totalReward: data.totalReward };
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

// hashprice = dailyBtc / (difficulty × 2^32 / 600) × 1e18 (BTC/EH/day).
const DIFFICULTY = 1e14;
const DAILY_BTC = 450;
const NETWORK_HS = (DIFFICULTY * 2 ** 32) / 600;
const EXPECTED = (DAILY_BTC / NETWORK_HS) * 1e18;
const GOOD = { difficulty: DIFFICULTY, totalReward: DAILY_BTC * 100_000_000 };

describe('HashpriceOracle', () => {
  it('source "none" never fetches and stays null', async () => {
    const fetchImpl = fakeFetch({});
    const oracle = new HashpriceOracle({ source: 'none', fetchImpl });
    expect(await oracle.refresh()).toBeNull();
    expect(oracle.latest()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('computes BTC/EH/day from difficulty-implied hashrate + daily reward', async () => {
    const oracle = new HashpriceOracle({ source: 'mempool', fetchImpl: fakeFetch(GOOD) });
    const hp = await oracle.refresh();
    expect(hp).toBeCloseTo(EXPECTED, 12);
    expect(oracle.latest()).toBeCloseTo(EXPECTED, 12);
  });

  it('keeps the last good value when a refresh fails', async () => {
    const ok = new HashpriceOracle({ source: 'mempool', fetchImpl: fakeFetch(GOOD) });
    await ok.refresh();
    expect(ok.latest()).toBeCloseTo(EXPECTED, 12);

    // A fresh oracle that only ever fails stays null and does not throw.
    const failing = new HashpriceOracle({ source: 'mempool', fetchImpl: fakeFetch({}, true) });
    expect(await failing.refresh()).toBeNull();
  });

  it('reports staleness against the TTL', async () => {
    const now = { t: 0 };
    const oracle = new HashpriceOracle({
      source: 'mempool',
      ttlMs: 1000,
      now: () => now.t,
      fetchImpl: fakeFetch(GOOD),
    });
    expect(oracle.isStale()).toBe(true);
    await oracle.refresh();
    expect(oracle.isStale()).toBe(false);
    now.t = 2000;
    expect(oracle.isStale()).toBe(true);
  });

  it('returns null on absurd inputs (zero difficulty)', async () => {
    const oracle = new HashpriceOracle({
      source: 'mempool',
      fetchImpl: fakeFetch({ difficulty: 0, totalReward: DAILY_BTC * 100_000_000 }),
    });
    expect(await oracle.refresh()).toBeNull();
  });
});
