import { describe, expect, it, vi } from 'vitest';

import type { CreatePoolRequest, NiceHashClient } from '@hashrate-autopilot/nicehash-client';

import { ensurePool } from './pool-manager.js';

const want: CreatePoolRequest = {
  name: 'my-pool',
  algorithm: 'SHA256ASICBOOST',
  stratumHostname: 'stratum.example.com',
  stratumPort: 3333,
  username: 'bc1qexample',
  password: 'x',
};

function client(over: Partial<NiceHashClient>): Pick<NiceHashClient, 'getPools' | 'createPool'> {
  return {
    getPools: vi.fn(async () => ({ list: [] })),
    createPool: vi.fn(async () => ({ id: 'new-pool-id', name: want.name })),
    ...over,
  } as unknown as Pick<NiceHashClient, 'getPools' | 'createPool'>;
}

describe('ensurePool', () => {
  it('returns an existing matching pool id without creating', async () => {
    const c = client({
      getPools: vi.fn(async () => ({
        list: [
          { id: 'other', name: 'x', algorithm: 'SCRYPT', stratumHostname: 'h', stratumPort: 1, username: 'u' },
          {
            id: 'match',
            name: 'my-pool',
            algorithm: 'SHA256ASICBOOST',
            stratumHostname: 'stratum.example.com',
            stratumPort: 3333,
            username: 'bc1qexample',
          },
        ],
      })) as unknown as NiceHashClient['getPools'],
    });
    const id = await ensurePool(c, want);
    expect(id).toBe('match');
    expect(c.createPool).not.toHaveBeenCalled();
  });

  it('creates a new pool when none matches', async () => {
    const c = client({});
    const id = await ensurePool(c, want);
    expect(id).toBe('new-pool-id');
    expect(c.createPool).toHaveBeenCalledWith(want);
  });

  it('does not match on a different stratum host', async () => {
    const c = client({
      getPools: vi.fn(async () => ({
        list: [
          {
            id: 'wrong-host',
            name: 'my-pool',
            algorithm: 'SHA256ASICBOOST',
            stratumHostname: 'other.example.com',
            stratumPort: 3333,
            username: 'bc1qexample',
          },
        ],
      })) as unknown as NiceHashClient['getPools'],
    });
    const id = await ensurePool(c, want);
    expect(id).toBe('new-pool-id');
    expect(c.createPool).toHaveBeenCalled();
  });
});
