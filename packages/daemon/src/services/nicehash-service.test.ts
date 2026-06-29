import { describe, expect, it, vi } from 'vitest';

import type { NiceHashClient } from '@hashrate-autopilot/nicehash-client';

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
    getMyOrders: vi.fn(async () => ({ list: [] })),
    getAccountBalance: vi.fn(async () => ({ currency: 'TBTC', totalBalance: '0', available: '0' })),
    ...over,
  } as unknown as NiceHashClient;
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

  it('invalidateAlgorithmCache forces a refetch', async () => {
    const client = mockClient();
    const svc = new NiceHashService({ client });
    await svc.getAlgorithmSetting('SHA256ASICBOOST');
    svc.invalidateAlgorithmCache();
    await svc.getAlgorithmSetting('SHA256ASICBOOST');
    expect(client.getAlgorithmSetting).toHaveBeenCalledTimes(2);
  });
});
