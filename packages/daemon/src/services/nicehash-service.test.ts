import { describe, expect, it, vi } from 'vitest';

import type {
  NiceHashClient,
  OrderBookEntry,
  OrderBookResponse,
} from '@hashrate-autopilot/nicehash-client';

import { NiceHashService } from './nicehash-service.js';

function mockClient(over: Partial<NiceHashClient> = {}): NiceHashClient {
  return {
    syncTime: vi.fn(async () => 0),
    getAlgorithmSetting: vi.fn(async () => ({
      algorithm: 'SHA256ASICBOOST',
      marketFactor: '1000000000000000',
      displayMarketFactor: 'PH',
    })),
    getOrderBook: vi.fn(async () => ({ stats: {} })),
    getOrder: vi.fn(async () => ({ id: 'x', price: '0.45', limit: '0', amount: '0' })),
    getMyOrders: vi.fn(async () => ({ list: [] })),
    getAccountBalance: vi.fn(async () => ({ currency: 'TBTC', totalBalance: '0', available: '0' })),
    ...over,
  } as unknown as NiceHashClient;
}

/** A full (100-order) order-book page, all orders filled (rigsCount > 0). */
function filledPage(base: number): OrderBookResponse {
  const orders: OrderBookEntry[] = Array.from({ length: 100 }, (_, i) => ({
    id: `o${base.toFixed(4)}-${i}`,
    type: 'STANDARD',
    price: (base - i * 0.0001).toFixed(8),
    limit: '0',
    acceptedSpeed: '0.01',
    rigsCount: 5,
    alive: true,
  }));
  return { stats: { BTC: { totalSpeed: '16', orders } } };
}

/** A page whose cheaper half is unfilled (rigsCount 0) - the marginal boundary. */
function mixedPage(base: number): OrderBookResponse {
  const orders: OrderBookEntry[] = Array.from({ length: 100 }, (_, i) => ({
    id: `m${base.toFixed(4)}-${i}`,
    type: 'STANDARD',
    price: (base - i * 0.0001).toFixed(8),
    limit: '0',
    acceptedSpeed: i < 40 ? '0.01' : '0',
    rigsCount: i < 40 ? 5 : 0,
    alive: true,
  }));
  return { stats: { BTC: { totalSpeed: '16', orders } } };
}

describe('NiceHashService', () => {
  it('caches algorithm metadata within the TTL and refetches after it', async () => {
    let t = 0;
    const client = mockClient();
    const svc = new NiceHashService({ client, algorithmTtlMs: 1000, now: () => t });

    await svc.getAlgorithmSetting('SHA256ASICBOOST');
    t = 500;
    await svc.getAlgorithmSetting('SHA256ASICBOOST');
    expect(client.getAlgorithmSetting).toHaveBeenCalledTimes(1);

    t = 2000;
    await svc.getAlgorithmSetting('SHA256ASICBOOST');
    expect(client.getAlgorithmSetting).toHaveBeenCalledTimes(2);
  });

  it('tracks last-OK on reads', async () => {
    let t = 100;
    const svc = new NiceHashService({ client: mockClient(), now: () => t });
    expect(svc.getLastApiOkAt()).toBeNull();
    await svc.getOrderBook('SHA256ASICBOOST');
    expect(svc.getLastApiOkAt()).toBe(100);
    t = 200;
    await svc.getAccountBalance('TBTC');
    expect(svc.getLastApiOkAt()).toBe(200);
  });

  it('passes through my-orders reads', async () => {
    const client = mockClient();
    const svc = new NiceHashService({ client });
    await svc.getMyOrders({ algorithm: 'SHA256ASICBOOST', market: 'EU' });
    expect(client.getMyOrders).toHaveBeenCalledWith({ algorithm: 'SHA256ASICBOOST', market: 'EU' });
  });

  it('paginates the order book until it crosses the marginal (unfilled page)', async () => {
    const getOrderBook = vi.fn(async (_algo: string, opts?: { size?: number; page?: number }) =>
      opts?.page === 0 ? filledPage(0.5) : mixedPage(0.49),
    );
    const svc = new NiceHashService({ client: mockClient({ getOrderBook } as Partial<NiceHashClient>) });

    const book = await svc.getOrderBook('SHA256ASICBOOST', 'BTC');

    // Page 0 is fully filled -> fetch page 1; page 1 has zero-rig orders -> stop.
    expect(getOrderBook).toHaveBeenCalledTimes(2);
    expect(getOrderBook).toHaveBeenNthCalledWith(1, 'SHA256ASICBOOST', { size: 100, page: 0 });
    expect(getOrderBook).toHaveBeenNthCalledWith(2, 'SHA256ASICBOOST', { size: 100, page: 1 });
    // Both pages merged into one book.
    expect(book.stats.BTC?.orders.length).toBe(200);
    // The merged book reaches the floor: cheapest filled order is on page 1.
    const filled = (book.stats.BTC?.orders ?? []).filter((o) => (o.rigsCount ?? 0) > 0);
    const cheapestFilled = Math.min(...filled.map((o) => Number(o.price)));
    expect(cheapestFilled).toBeCloseTo(0.49 - 39 * 0.0001, 8);
  });

  it('stops paginating when a page yields no new orders (page param ignored)', async () => {
    // A server that ignores `page` returns the same filled page every call;
    // de-dup makes the second page add nothing, so we stop at the top-100.
    const same = filledPage(0.5);
    const getOrderBook = vi.fn(async () => same);
    const svc = new NiceHashService({ client: mockClient({ getOrderBook } as Partial<NiceHashClient>) });

    const book = await svc.getOrderBook('SHA256ASICBOOST');

    expect(getOrderBook).toHaveBeenCalledTimes(2);
    expect(book.stats.BTC?.orders.length).toBe(100);
  });

  it('passes through order-detail reads and tracks last-OK', async () => {
    const t = 300;
    const getOrder = vi.fn(async () => ({
      id: 'abc',
      price: '0.45',
      limit: '0',
      amount: '0',
      acceptedCurrentSpeed: '0.0002',
    }));
    const svc = new NiceHashService({
      client: mockClient({ getOrder } as Partial<NiceHashClient>),
      now: () => t,
    });
    const order = await svc.getOrder('abc');
    expect(order.acceptedCurrentSpeed).toBe('0.0002');
    expect(getOrder).toHaveBeenCalledWith('abc');
    expect(svc.getLastApiOkAt()).toBe(300);
  });

  it('invalidateAlgorithmCache forces a refetch', async () => {
    const client = mockClient();
    const svc = new NiceHashService({ client });
    await svc.getAlgorithmSetting('SHA256ASICBOOST');
    svc.invalidateAlgorithmCache();
    await svc.getAlgorithmSetting('SHA256ASICBOOST');
    expect(client.getAlgorithmSetting).toHaveBeenCalledTimes(2);
  });
});
