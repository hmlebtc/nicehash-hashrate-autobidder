import { describe, expect, it, vi } from 'vitest';

import type { NiceHashClient } from '@hashrate-autopilot/nicehash-client';

import { executeProposal, type NiceHashExecuteContext } from './execute.js';
import type { Proposal } from './types.js';

function ctx(over: Partial<NiceHashClient> = {}): NiceHashExecuteContext {
  const client = {
    createOrder: vi.fn(async () => ({ id: 'new-order', price: '0', limit: '0', amount: '0' })),
    updatePriceAndLimit: vi.fn(async () => ({ id: 'o1', price: '0', limit: '0', amount: '0' })),
    refillOrder: vi.fn(async () => ({ id: 'o1', price: '0', limit: '0', amount: '0' })),
    cancelOrder: vi.fn(async () => ({ id: 'o1', price: '0', limit: '0', amount: '0' })),
    ...over,
  } as unknown as NiceHashClient;
  return {
    client,
    market: 'EU',
    algorithm: 'SHA256',
    type: 'STANDARD',
    marketFactor: '1000000000000',
    displayMarketFactor: '1000000000000',
  };
}

const create: Proposal = {
  kind: 'CREATE_ORDER',
  price_btc: 0.00051,
  amount_btc: 0.01,
  limit_units: 10,
  pool_id: 'pool-1',
  reason: 'create',
};

describe('executeProposal - DRY_RUN', () => {
  it('does not call the client and returns a would-note', async () => {
    const c = ctx();
    const res = await executeProposal(c, 'DRY_RUN', create);
    expect(res.outcome).toBe('DRY_RUN');
    expect(c.client.createOrder).not.toHaveBeenCalled();
  });
});

describe('executeProposal - LIVE', () => {
  it('creates an order with trimmed decimal strings and echoed market factors', async () => {
    const c = ctx();
    const res = await executeProposal(c, 'LIVE', create);
    expect(res.outcome).toBe('EXECUTED');
    if (res.outcome !== 'EXECUTED') throw new Error('unreachable');
    expect(res.orderId).toBe('new-order');
    expect(c.client.createOrder).toHaveBeenCalledWith({
      market: 'EU',
      algorithm: 'SHA256',
      type: 'STANDARD',
      amount: '0.01',
      price: '0.00051',
      limit: '10',
      poolId: 'pool-1',
      marketFactor: '1000000000000',
      displayMarketFactor: '1000000000000',
    });
  });

  it('edits price only via updatePriceAndLimit', async () => {
    const c = ctx();
    await executeProposal(c, 'LIVE', {
      kind: 'EDIT_PRICE',
      order_id: 'o1',
      new_price_btc: 0.0006,
      old_price_btc: 0.0005,
      reason: 'r',
    });
    expect(c.client.updatePriceAndLimit).toHaveBeenCalledWith('o1', {
      price: '0.0006',
      marketFactor: '1000000000000',
      displayMarketFactor: '1000000000000',
    });
  });

  it('edits limit only via updatePriceAndLimit', async () => {
    const c = ctx();
    await executeProposal(c, 'LIVE', {
      kind: 'EDIT_LIMIT',
      order_id: 'o1',
      new_limit_units: 20,
      old_limit_units: 10,
      reason: 'r',
    });
    expect(c.client.updatePriceAndLimit).toHaveBeenCalledWith('o1', {
      limit: '20',
      marketFactor: '1000000000000',
      displayMarketFactor: '1000000000000',
    });
  });

  it('refills an order', async () => {
    const c = ctx();
    await executeProposal(c, 'LIVE', {
      kind: 'REFILL_ORDER',
      order_id: 'o1',
      amount_btc: 0.005,
      reason: 'r',
    });
    expect(c.client.refillOrder).toHaveBeenCalledWith('o1', '0.005');
  });

  it('cancels an order', async () => {
    const c = ctx();
    await executeProposal(c, 'LIVE', { kind: 'CANCEL_ORDER', order_id: 'o1', reason: 'r' });
    expect(c.client.cancelOrder).toHaveBeenCalledWith('o1');
  });

  it('returns FAILED (and does not throw) when the client errors', async () => {
    const c = ctx({
      createOrder: vi.fn(async () => {
        throw new Error('boom');
      }) as unknown as NiceHashClient['createOrder'],
    });
    const res = await executeProposal(c, 'LIVE', create);
    expect(res.outcome).toBe('FAILED');
    if (res.outcome !== 'FAILED') throw new Error('unreachable');
    expect(res.error).toBe('boom');
  });

  it('does not call the marketplace for PAUSE', async () => {
    const c = ctx();
    const res = await executeProposal(c, 'LIVE', { kind: 'PAUSE', reason: 'unknown order' });
    expect(res.outcome).toBe('EXECUTED');
    expect(c.client.createOrder).not.toHaveBeenCalled();
  });
});
