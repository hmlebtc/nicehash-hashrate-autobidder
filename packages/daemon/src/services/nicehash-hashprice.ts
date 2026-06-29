/**
 * Network-hashprice oracle (estimate) for the NiceHash autobidder.
 *
 * NiceHash's API exposes no income/payout data (unlike the Braiins+Ocean stack
 * the upstream paired with), so to power the "cost vs hashprice" tile and an
 * estimated profit/loss the daemon derives the SHA-256 network hashprice from a
 * public source. The value is BTC per EH per day - the same unit as NiceHash
 * order prices (displayPriceFactor "EH") - so it can be compared directly to
 * our bid and the market anchor.
 *
 * This is an ESTIMATE: it uses mainnet emission + network hashrate and assumes
 * the SHA-256 price-display unit (EH). It never drives bidding unless the
 * operator configures the dynamic hashprice cap; it primarily feeds the
 * dashboard. The controller reads {@link HashpriceOracle.latest} (sync, last
 * fetched); the daemon calls {@link HashpriceOracle.refresh} on a schedule.
 */

import type { HashpriceSource } from '../controller/nicehash/settings.js';

export interface HashpriceOracleOptions {
  readonly source: HashpriceSource;
  /** Cache freshness window; refresh() is a no-op within it. Default 5 min. */
  readonly ttlMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** mempool.space base URL (override for self-hosted instances). */
  readonly baseUrl?: string;
}

const SATS_PER_BTC = 100_000_000;
const H_PER_EH = 1e18;

export class HashpriceOracle {
  private readonly source: HashpriceSource;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;

  private value: number | null = null;
  private fetchedAt = 0;

  constructor(opts: HashpriceOracleOptions) {
    this.source = opts.source;
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.baseUrl = (opts.baseUrl ?? 'https://mempool.space').replace(/\/$/, '');
  }

  /** Last successfully fetched hashprice (BTC/EH/day), or null. Sync. */
  latest(): number | null {
    return this.value;
  }

  /** True when the cached value is older than the TTL (or never fetched). */
  isStale(): boolean {
    return this.value === null || this.now() - this.fetchedAt >= this.ttlMs;
  }

  /**
   * Fetch + recompute the hashprice. On any failure the previous value is kept
   * (returns it) so a transient outage doesn't blank the dashboard. Returns the
   * current cached value.
   */
  async refresh(): Promise<number | null> {
    if (this.source === 'none') {
      this.value = null;
      return null;
    }
    try {
      const fresh = await this.fetchMempool();
      if (fresh !== null && Number.isFinite(fresh) && fresh > 0) {
        this.value = fresh;
        this.fetchedAt = this.now();
      }
    } catch {
      /* keep the last good value */
    }
    return this.value;
  }

  private async fetchMempool(): Promise<number | null> {
    const [hashrate, dailyBtc] = await Promise.all([
      this.getJson<{ currentHashrate?: number }>('/api/v1/mining/hashrate/3d').then((d) =>
        Number(d.currentHashrate),
      ),
      // Sum of block rewards (subsidy + fees) over the last ~144 blocks ≈ 1 day.
      this.getJson<{ totalReward?: number | string }>('/api/v1/mining/reward-stats/144').then(
        (d) => Number(d.totalReward) / SATS_PER_BTC,
      ),
    ]);
    if (!(hashrate > 0) || !(dailyBtc > 0)) return null;
    // BTC per (H/s) per day, scaled to per EH/day.
    return (dailyBtc / hashrate) * H_PER_EH;
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`hashprice fetch ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}
