/**
 * #260: NerdAxe / NerdQAxe firmware reports `bestDiff` /
 * `bestSessionDiff` as raw numbers where stock Bitaxe ESP-Miner
 * reports magnitude-suffixed strings ("4.29G"). The original parser
 * called `.trim()` on the value, so the first successful poll of a
 * NerdAxe threw out of tick() *before* the snapshot assignment -
 * successful polls were discarded while failed polls rendered,
 * freezing the Status card on the last failure forever.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  AxeOSPoller,
  formatMagnitudeSuffixed,
  parseMagnitudeSuffixed,
} from './axeos-poller.js';
import { AxeOSClient, type AxeOSSystemInfo } from './axeos.js';
import type { AppConfig } from '../config/schema.js';
import type { RuntimeStateRepo } from '../state/repos/runtime_state.js';
import type { InsertSampleArgs, SoloMinerRow, SoloMinersRepo } from '../state/repos/solo_miners.js';

// Trimmed-down real payload from the NerdAxeGamma in #260
// (firmware v1.0.37.1, shufps/ESP-Miner-NerdQAxePlus family).
const NERDAXE_INFO: AxeOSSystemInfo = {
  deviceModel: 'NerdAxeGamma',
  hashRate: 1424.808,
  hashRate_1m: 1420.788,
  hashRate_10m: 1426.997,
  hashRate_1h: 1422.106,
  temp: 54,
  vrTemp: 59.75,
  power: 18.30032,
  sharesAccepted: 32,
  sharesRejected: 0,
  uptimeSeconds: 16259,
  ASICModel: 'BM1370',
  version: 'v1.0.37.1',
  stratumURL: '10.10.44.145',
  stratumPort: 23334,
  stratumUser: 'redacted',
  // The #260 trap: numbers, not "58.38M" / "32.30M" strings.
  bestDiff: 58389175,
  bestSessionDiff: 32300773,
};

const BITAXE_INFO: AxeOSSystemInfo = {
  hashRate: 1100,
  temp: 60,
  ASICModel: 'BM1368',
  bestDiff: '4.29G',
  bestSessionDiff: '225.68M',
};

function makeDevice(id: number, ip: string): SoloMinerRow {
  return {
    id,
    label: `${ip} (test)`,
    ip,
    enabled: true,
    sort_order: 0,
    created_at: 0,
    updated_at: 0,
  };
}

function makeRepo(devices: SoloMinerRow[]): {
  repo: SoloMinersRepo;
  samples: InsertSampleArgs[][];
} {
  const samples: InsertSampleArgs[][] = [];
  const repo = {
    listEnabled: vi.fn(async () => devices),
    insertSamples: vi.fn(async (rows: InsertSampleArgs[]) => {
      samples.push(rows);
    }),
    insertBestDiffEvent: vi.fn(async () => {}),
  } as unknown as SoloMinersRepo;
  return { repo, samples };
}

function makeRuntimeRepo(stored: number | null = null): RuntimeStateRepo {
  return {
    get: vi.fn(async () => ({ solo_best_difficulty_all_time: stored })),
    patch: vi.fn(async () => {}),
  } as unknown as RuntimeStateRepo;
}

function makeClient(infoByIp: Record<string, AxeOSSystemInfo | Error>): AxeOSClient {
  return {
    getSystemInfo: vi.fn(async (ip: string) => {
      const v = infoByIp[ip];
      if (!v) return { reachable: false, info: null, error: 'fetch failed' };
      if (v instanceof Error) return { reachable: false, info: null, error: v.message };
      return { reachable: true, info: v, error: null };
    }),
  } as unknown as AxeOSClient;
}

function makePoller(client: AxeOSClient, repo: SoloMinersRepo, runtimeRepo: RuntimeStateRepo) {
  return new AxeOSPoller({
    cfgRef: { value: { solo_mining_enabled: true } as AppConfig },
    repo,
    runtimeRepo,
    client,
    now: () => 1_780_700_000_000,
  });
}

describe('parseMagnitudeSuffixed', () => {
  it('parses Bitaxe-style suffixed strings', () => {
    expect(parseMagnitudeSuffixed('4.29G')).toBe(4.29e9);
    expect(parseMagnitudeSuffixed('225.68M')).toBe(225.68e6);
    expect(parseMagnitudeSuffixed('123')).toBe(123);
    expect(parseMagnitudeSuffixed('1.5k')).toBe(1500);
  });

  it('passes NerdAxe-style raw numbers through losslessly (#260)', () => {
    expect(parseMagnitudeSuffixed(58389175)).toBe(58389175);
    expect(parseMagnitudeSuffixed(0)).toBe(0);
    expect(parseMagnitudeSuffixed(NaN)).toBeNull();
    expect(parseMagnitudeSuffixed(Infinity)).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseMagnitudeSuffixed(null)).toBeNull();
    expect(parseMagnitudeSuffixed(undefined)).toBeNull();
    expect(parseMagnitudeSuffixed('')).toBeNull();
    expect(parseMagnitudeSuffixed('garbage')).toBeNull();
  });
});

describe('formatMagnitudeSuffixed', () => {
  it('formats the way AxeOS displays difficulty', () => {
    expect(formatMagnitudeSuffixed(58389175)).toBe('58.39M');
    expect(formatMagnitudeSuffixed(4_290_000_000)).toBe('4.29G');
    expect(formatMagnitudeSuffixed(999)).toBe('999');
    expect(formatMagnitudeSuffixed(1500)).toBe('1.5K');
    expect(formatMagnitudeSuffixed(123_400_000_000)).toBe('123.4G');
  });

  it('round-trips through parseMagnitudeSuffixed within formatting precision', () => {
    const parsed = parseMagnitudeSuffixed(formatMagnitudeSuffixed(58389175));
    expect(parsed).toBeCloseTo(58390000, -4);
  });
});

describe('AxeOSPoller.tick with NerdAxe numeric bestDiff (#260)', () => {
  it('completes the tick, updates the snapshot, and persists the sample', async () => {
    const device = makeDevice(2, '10.10.44.254');
    const { repo, samples } = makeRepo([device]);
    const poller = makePoller(makeClient({ '10.10.44.254': NERDAXE_INFO }), repo, makeRuntimeRepo());

    await poller.tick(1_780_700_000_000);

    const snap = poller.getSnapshot();
    expect(snap.enabled).toBe(true);
    expect(snap.entries).toHaveLength(1);
    const entry = snap.entries[0]!;
    expect(entry.reachable).toBe(true);
    expect(entry.error).toBeNull();
    expect(entry.hashrate_10m_ghs).toBeCloseTo(1426.997);
    // Numeric firmware value formatted for display, exact value preserved.
    expect(entry.best_diff_text).toBe('58.39M');
    expect(entry.best_session_diff_text).toBe('32.3M');
    expect(entry.best_diff_numeric).toBe(58389175);

    expect(samples).toHaveLength(1);
    expect(samples[0]![0]!.best_diff_numeric).toBe(58389175);
    expect(samples[0]![0]!.best_diff_text).toBe('58.39M');
  });

  it('still passes Bitaxe string payloads through unchanged', async () => {
    const device = makeDevice(1, '192.168.1.50');
    const { repo, samples } = makeRepo([device]);
    const poller = makePoller(makeClient({ '192.168.1.50': BITAXE_INFO }), repo, makeRuntimeRepo());

    await poller.tick(1_780_700_000_000);

    const entry = poller.getSnapshot().entries[0]!;
    expect(entry.best_diff_text).toBe('4.29G');
    expect(entry.best_session_diff_text).toBe('225.68M');
    expect(entry.best_diff_numeric).toBe(4.29e9);
    expect(samples[0]![0]!.best_diff_numeric).toBe(4.29e9);
  });

  it('keeps polling the rest of the fleet when one payload blows up the mapping', async () => {
    const nerd = makeDevice(2, '10.10.44.254');
    const axe = makeDevice(1, '192.168.1.50');
    const { repo } = makeRepo([axe, nerd]);
    // Poison pill: an info object whose property access throws.
    const poison = new Proxy({} as AxeOSSystemInfo, {
      get() {
        throw new Error('boom');
      },
    });
    const poller = makePoller(
      makeClient({ '192.168.1.50': BITAXE_INFO, '10.10.44.254': poison }),
      repo,
      makeRuntimeRepo(),
    );

    await poller.tick(1_780_700_000_000);

    const entries = poller.getSnapshot().entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.reachable).toBe(true);
    expect(entries[0]!.best_diff_text).toBe('4.29G');
    expect(entries[1]!.reachable).toBe(false);
    expect(entries[1]!.error).toContain('payload mapping failed');
  });

  it('records the exact NerdAxe value as the fleet best difficulty, not the rounded text', async () => {
    const device = makeDevice(2, '10.10.44.254');
    const { repo } = makeRepo([device]);
    const runtimeRepo = makeRuntimeRepo(1_000_000);
    const poller = makePoller(makeClient({ '10.10.44.254': NERDAXE_INFO }), repo, runtimeRepo);

    await poller.tick(1_780_700_000_000);

    expect(runtimeRepo.patch).toHaveBeenCalledWith({
      solo_best_difficulty_all_time: 58389175,
    });
    expect(poller.getLastBestDiffResult()).toMatchObject({
      isNewRecord: true,
      fleetMax: 58389175,
      previousRecord: 1_000_000,
    });
  });
});

describe('AxeOSClient error cause surfacing (#260 diagnosability)', () => {
  it('appends the undici cause to the generic "fetch failed" message', async () => {
    const cause = new Error('connect EHOSTUNREACH 10.10.44.254:80');
    const failure = new TypeError('fetch failed', { cause });
    const client = new AxeOSClient({
      fetchImpl: vi.fn(async () => {
        throw failure;
      }) as unknown as typeof fetch,
    });

    const result = await client.getSystemInfo('10.10.44.254');
    expect(result.reachable).toBe(false);
    expect(result.error).toBe('fetch failed: connect EHOSTUNREACH 10.10.44.254:80');
  });
});
