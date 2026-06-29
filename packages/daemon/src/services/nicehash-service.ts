/**
 * Caching + last-OK wrapper around the raw NiceHash client - the NiceHash
 * analogue of `braiins-service.ts`.
 *
 * Two concerns:
 *   1. **TTL cache** for the slow-moving algorithm metadata
 *      (`/mining/algorithms`): `marketFactor` / `displayMarketFactor` /
 *      limits change rarely, so cache them rather than refetch every tick.
 *   2. **Last-OK tracking** so the control loop can detect API outages.
 *
 * Per-tick reads (order book, my orders, balance) are passed straight through
 * (no caching) but still update the last-OK timestamp.
 */

import type {
  AccountBalance,
  MiningAlgorithmSetting,
  MyOrdersResponse,
  NiceHashClient,
  OrderBookResponse,
} from '@hashrate-autopilot/nicehash-client';

interface Cached<T> {
  value: T;
  at: number;
}

export interface NiceHashServiceOptions {
  readonly client: NiceHashClient;
  /** TTL for cached algorithm metadata. Default 1 hour. */
  readonly algorithmTtlMs?: number;
  readonly now?: () => number;
}

export class NiceHashService {
  private readonly client: NiceHashClient;
  private readonly algorithmTtlMs: number;
  private readonly now: () => number;
  private readonly algoCache = new Map<string, Cached<MiningAlgorithmSetting>>();
  private lastApiOkAt: number | null = null;

  constructor(options: NiceHashServiceOptions) {
    this.client = options.client;
    this.algorithmTtlMs = options.algorithmTtlMs ?? 60 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Learn the NiceHash server-clock offset (call on boot and periodically). */
  async syncTime(): Promise<number> {
    const offset = await this.client.syncTime();
    this.lastApiOkAt = this.now();
    return offset;
  }

  async getAlgorithmSetting(algorithm: string): Promise<MiningAlgorithmSetting> {
    const cached = this.algoCache.get(algorithm);
    if (cached && this.now() - cached.at < this.algorithmTtlMs) {
      return cached.value;
    }
    const value = await this.client.getAlgorithmSetting(algorithm);
    this.algoCache.set(algorithm, { value, at: this.now() });
    this.lastApiOkAt = this.now();
    return value;
  }

  async getOrderBook(algorithm: string): Promise<OrderBookResponse> {
    const v = await this.client.getOrderBook(algorithm);
    this.lastApiOkAt = this.now();
    return v;
  }

  async getMyOrders(opts: {
    algorithm: string;
    market?: string;
    limit?: number;
  }): Promise<MyOrdersResponse> {
    const v = await this.client.getMyOrders(opts);
    this.lastApiOkAt = this.now();
    return v;
  }

  async getAccountBalance(currency: string): Promise<AccountBalance> {
    const v = await this.client.getAccountBalance(currency);
    this.lastApiOkAt = this.now();
    return v;
  }

  getLastApiOkAt(): number | null {
    return this.lastApiOkAt;
  }

  /** Drop the cached algorithm metadata (e.g. after a schema-change alert). */
  invalidateAlgorithmCache(): void {
    this.algoCache.clear();
  }
}
