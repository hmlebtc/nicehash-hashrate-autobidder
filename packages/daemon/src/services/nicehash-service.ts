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
  HashpowerOrder,
  MiningAlgorithmSetting,
  MyOrdersResponse,
  NiceHashClient,
  OrderBookEntry,
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

  /**
   * Fetch the **whole** order book so the marginal - the cheapest order still
   * receiving hashrate (NiceHash's purple price) - can be found reliably.
   *
   * The endpoint returns orders sorted by price descending, capped at
   * `PAGE_SIZE` per page (NiceHash defaults to 100), so reading only page 0
   * makes the anchor read ~the top of the book instead of the floor.
   *
   * We can NOT stop at the first zero-miner order: the fill pattern is not a
   * single contiguous block at the top. Orders with no miners are routinely
   * interleaved *above* the true marginal (an order can be priced higher yet
   * draw no rigs - incompatible pool, exhausted cap, etc.), so an early stop on
   * the first gap lands the anchor far above NiceHash's purple. Instead we walk
   * every page and let `computeMarketAnchor` take the global cheapest order with
   * miners. Bounded by `pagination.totalPageCount`, a short final page, a
   * no-new-orders guard (so a server that ignores `page` degrades to the old
   * top-100 rather than looping), and a hard page cap. De-duped by id.
   */
  async getOrderBook(algorithm: string, currency = 'BTC'): Promise<OrderBookResponse> {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 30;

    let firstBook: OrderBookResponse | null = null;
    const merged: OrderBookEntry[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < MAX_PAGES; page++) {
      const book = await this.client.getOrderBook(algorithm, { size: PAGE_SIZE, page });
      if (page === 0) firstBook = book;
      const stats = book.stats?.[currency] ?? Object.values(book.stats ?? {})[0];
      const orders = stats?.orders ?? [];

      let added = 0;
      for (const o of orders) {
        const key = o.id ?? `${o.price}|${o.limit}|${o.type ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(o);
        added++;
      }

      this.lastApiOkAt = this.now();

      if (added === 0) break; // no progress (page ignored or book exhausted)
      const totalPages = stats?.pagination?.totalPageCount;
      if (totalPages !== undefined && page + 1 >= totalPages) break;
      if (orders.length < PAGE_SIZE) break; // last (short) page
    }

    if (!firstBook) return { stats: {} };
    // Reassemble a single book whose target currency carries the full,
    // de-duplicated, multi-page order list; preserve all other stats fields.
    const baseStats = firstBook.stats?.[currency];
    if (!baseStats) return firstBook;
    return {
      ...firstBook,
      stats: { ...firstBook.stats, [currency]: { ...baseStats, orders: merged } },
    };
  }

  getOrder(orderId: string): Promise<HashpowerOrder> {
    return this.client.getOrder(orderId).then((v) => {
      this.lastApiOkAt = this.now();
      return v;
    });
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
