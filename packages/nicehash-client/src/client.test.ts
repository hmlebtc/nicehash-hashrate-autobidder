import { describe, expect, it, vi } from 'vitest';

import { createNiceHashClient, NICEHASH_TEST_BASE_URL } from './client.js';
import { NiceHashApiError, NiceHashAuthMissingError } from './errors.js';
import type { NiceHashCredentials } from './auth.js';

const CREDS: NiceHashCredentials = {
  apiKey: 'apikey123',
  apiSecret: 'apisecret456',
  orgId: 'org789',
};

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Build a fetch mock that records calls and returns scripted responses. */
function mockFetch(
  responses: Array<{ status?: number; json?: unknown; text?: string }>,
): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const status = spec?.status ?? 200;
    const text = spec?.text ?? (spec?.json !== undefined ? JSON.stringify(spec.json) : '');
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (text ? JSON.parse(text) : null),
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const noSleep = () => Promise.resolve();

describe('public reads', () => {
  it('getServerTime is unsigned and hits /api/v2/time', async () => {
    const { fetch, calls } = mockFetch([{ json: { serverTime: 1700000000000 } }]);
    const client = createNiceHashClient({ baseUrl: NICEHASH_TEST_BASE_URL, fetch });
    const res = await client.getServerTime();
    expect(res.serverTime).toBe(1700000000000);
    expect(calls[0]?.url).toBe(`${NICEHASH_TEST_BASE_URL}/api/v2/time`);
    expect(calls[0]?.headers['X-Auth']).toBeUndefined();
  });

  it('syncTime learns the offset and applies it to later signed calls', async () => {
    const fixedLocal = 1_000_000;
    const { fetch, calls } = mockFetch([
      { json: { serverTime: 1700000000000 } },
      { json: { currency: 'BTC', totalBalance: '0', available: '0' } },
    ]);
    const client = createNiceHashClient({
      baseUrl: NICEHASH_TEST_BASE_URL,
      fetch,
      credentials: CREDS,
      now: () => fixedLocal,
    });
    const offset = await client.syncTime();
    expect(offset).toBe(1700000000000 - fixedLocal);
    await client.getAccountBalance('BTC');
    // X-Time on the signed call reflects local + offset = server time.
    expect(calls[1]?.headers['X-Time']).toBe(String(1700000000000));
  });
});

describe('signing on private calls', () => {
  it('signs createOrder, posts to the right URL, and signs the exact body sent', async () => {
    const { fetch, calls } = mockFetch([{ json: { id: 'order-1', price: '0.0005', limit: '10', amount: '0.001' } }]);
    const client = createNiceHashClient({
      baseUrl: NICEHASH_TEST_BASE_URL,
      fetch,
      credentials: CREDS,
      now: () => 1700000000000,
    });
    const res = await client.createOrder({
      market: 'EU',
      algorithm: 'SHA256',
      type: 'STANDARD',
      amount: '0.001',
      price: '0.0005',
      limit: '10',
      poolId: 'pool-1',
      marketFactor: '1000000000000',
      displayMarketFactor: '1000000000000',
    });
    expect(res.id).toBe('order-1');
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${NICEHASH_TEST_BASE_URL}/main/api/v2/hashpower/order/`);
    expect(call.headers['X-Auth']).toMatch(/^apikey123:[0-9a-f]{64}$/);
    // Body sent must be exactly what was JSON.stringify'd for signing.
    expect(call.body).toBe(
      JSON.stringify({
        market: 'EU',
        algorithm: 'SHA256',
        type: 'STANDARD',
        amount: '0.001',
        price: '0.0005',
        limit: '10',
        poolId: 'pool-1',
        marketFactor: '1000000000000',
        displayMarketFactor: '1000000000000',
      }),
    );
  });

  it('keeps the signed query identical to the URL query on myOrders', async () => {
    const { fetch, calls } = mockFetch([{ json: { list: [] } }]);
    const client = createNiceHashClient({
      baseUrl: NICEHASH_TEST_BASE_URL,
      fetch,
      credentials: CREDS,
      now: () => 1700000000000,
    });
    await client.getMyOrders({ algorithm: 'SHA256', market: 'EU', limit: 5, ts: 123, op: 'LT' });
    expect(calls[0]?.url).toBe(
      `${NICEHASH_TEST_BASE_URL}/main/api/v2/hashpower/myOrders?algorithm=SHA256&market=EU&ts=123&limit=5&op=LT`,
    );
    expect(calls[0]?.headers['X-Auth']).toBeDefined();
  });

  it('throws NiceHashAuthMissingError when a private call has no credentials', async () => {
    const { fetch } = mockFetch([{ json: {} }]);
    const client = createNiceHashClient({ baseUrl: NICEHASH_TEST_BASE_URL, fetch });
    await expect(client.getAccountBalance()).rejects.toBeInstanceOf(NiceHashAuthMissingError);
  });
});

describe('error handling and retries', () => {
  it('parses NiceHash error bodies into NiceHashApiError with codes', async () => {
    const { fetch } = mockFetch([
      { status: 400, json: { error_id: 'e1', errors: [{ code: 5005, message: 'price too low' }] } },
    ]);
    const client = createNiceHashClient({ baseUrl: NICEHASH_TEST_BASE_URL, fetch, credentials: CREDS, sleep: noSleep });
    const err = await client.createOrder({
      market: 'EU',
      algorithm: 'SHA256',
      type: 'STANDARD',
      amount: '0.001',
      price: '0.0005',
      limit: '10',
      poolId: 'p',
      marketFactor: '1',
      displayMarketFactor: '1',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NiceHashApiError);
    expect((err as NiceHashApiError).status).toBe(400);
    expect((err as NiceHashApiError).hasCode(5005)).toBe(true);
  });

  it('retries reads on 429 then succeeds', async () => {
    const { fetch, calls } = mockFetch([
      { status: 429, json: { errors: [{ code: 429, message: 'slow down' }] } },
      { json: { currency: 'BTC', totalBalance: '1', available: '1' } },
    ]);
    const client = createNiceHashClient({ baseUrl: NICEHASH_TEST_BASE_URL, fetch, credentials: CREDS, sleep: noSleep });
    const res = await client.getAccountBalance('BTC');
    expect(res.available).toBe('1');
    expect(calls.length).toBe(2);
  });

  it('does NOT retry mutations on 5xx', async () => {
    const { fetch, calls } = mockFetch([{ status: 503, json: {} }, { json: { id: 'x' } }]);
    const client = createNiceHashClient({ baseUrl: NICEHASH_TEST_BASE_URL, fetch, credentials: CREDS, sleep: noSleep });
    await expect(client.refillOrder('o1', '0.001')).rejects.toBeInstanceOf(NiceHashApiError);
    expect(calls.length).toBe(1);
  });

  it('tolerates an empty 200 body on cancel', async () => {
    const { fetch } = mockFetch([{ status: 200, text: '' }]);
    const client = createNiceHashClient({ baseUrl: NICEHASH_TEST_BASE_URL, fetch, credentials: CREDS });
    await expect(client.cancelOrder('o1')).resolves.toBeUndefined();
  });
});

describe('config', () => {
  it('strips a trailing slash from the base URL', async () => {
    const { fetch, calls } = mockFetch([{ json: { serverTime: 1 } }]);
    const client = createNiceHashClient({ baseUrl: `${NICEHASH_TEST_BASE_URL}/`, fetch });
    await client.getServerTime();
    expect(calls[0]?.url).toBe(`${NICEHASH_TEST_BASE_URL}/api/v2/time`);
    // sanity: vi is available for future spies
    expect(typeof vi.fn).toBe('function');
  });
});
