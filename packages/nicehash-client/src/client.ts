/**
 * NiceHash Hash-power API client - a thin, typed wrapper over `fetch`.
 *
 * Mirrors the retry discipline of the upstream Braiins client:
 *   - reads  : retry 429 / 5xx / network (idempotent).
 *   - mutate : retry 429 only - a 5xx or dropped connection on a
 *              create/update/refill may have committed server-side, so we
 *              surface it rather than risk a double-apply.
 *   - cancel : idempotent - retry 429 / 5xx / network.
 *
 * Authentication is per-request HMAC-SHA256 (see `./auth`). Public endpoints
 * (`/api/v2/time`, `/mining/algorithms`) are sent unsigned; the order book is
 * signed opportunistically when credentials are present.
 *
 * NiceHash is sensitive to clock skew (the signed `X-Time` must be close to
 * server time), so the client tracks an offset learned from `/api/v2/time`
 * via `syncTime()`.
 */

import { createSignedHeaders, toQueryString, type NiceHashCredentials } from './auth.js';
import {
  NiceHashApiError,
  NiceHashAuthMissingError,
  NiceHashNetworkError,
  parseNiceHashError,
} from './errors.js';
import type {
  AccountBalance,
  CreateOrderParams,
  CreateOrderResponse,
  CreatePoolRequest,
  HashpowerOrder,
  MiningAlgorithmSetting,
  MiningAlgorithmsResponse,
  MyOrdersResponse,
  OrderBookResponse,
  Pool,
  PoolsResponse,
  ServerTimeResponse,
  UpdatePriceAndLimitParams,
} from './types.js';

export const NICEHASH_PROD_BASE_URL = 'https://api2.nicehash.com';
export const NICEHASH_TEST_BASE_URL = 'https://api-test.nicehash.com';

type AuthMode = 'required' | 'optional' | 'none';
type RetryClass = 'read' | 'mutate' | 'cancel';

export interface NiceHashClientConfig {
  /** Defaults to the production base URL. Use the test URL for testnet. */
  readonly baseUrl?: string;
  /** Required for all private endpoints; public reads work without it. */
  readonly credentials?: NiceHashCredentials;
  readonly fetch?: typeof fetch;
  /** Max attempts for retryable failures. Default 3. */
  readonly maxRetries?: number;
  /** Sleep function (override for tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Clock source (override for tests). Default Date.now. */
  readonly now?: () => number;
}

export interface NiceHashClient {
  /** Learn the server-clock offset so signed `X-Time` stays in tolerance. */
  syncTime(): Promise<number>;
  getServerTime(): Promise<ServerTimeResponse>;
  getAlgorithms(): Promise<MiningAlgorithmsResponse>;
  /** Fetch one algorithm's marketplace settings; throws if not found. */
  getAlgorithmSetting(algorithm: string): Promise<MiningAlgorithmSetting>;
  getOrderBook(algorithm: string): Promise<OrderBookResponse>;
  getAccountBalance(currency?: string): Promise<AccountBalance>;
  getMyOrders(opts: {
    algorithm: string;
    market?: string;
    limit?: number;
    ts?: number;
    op?: 'LT' | 'GT';
  }): Promise<MyOrdersResponse>;
  getOrder(orderId: string): Promise<HashpowerOrder>;
  createOrder(params: CreateOrderParams): Promise<CreateOrderResponse>;
  updatePriceAndLimit(orderId: string, params: UpdatePriceAndLimitParams): Promise<HashpowerOrder>;
  refillOrder(orderId: string, amountBtc: string): Promise<HashpowerOrder>;
  cancelOrder(orderId: string): Promise<HashpowerOrder>;
  getPools(opts?: { size?: number; page?: number }): Promise<PoolsResponse>;
  createPool(req: CreatePoolRequest): Promise<Pool>;
  deletePool(poolId: string): Promise<void>;
}

export function createNiceHashClient(config: NiceHashClientConfig = {}): NiceHashClient {
  const baseUrl = (config.baseUrl ?? NICEHASH_PROD_BASE_URL).replace(/\/$/, '');
  const maxRetries = config.maxRetries ?? 3;
  const sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const baseNow = config.now ?? Date.now;
  const fetchImpl = config.fetch ?? fetch;
  const creds = config.credentials;
  const hasCreds = creds !== undefined;

  // Offset (ms) added to the local clock to approximate NiceHash server time.
  let timeOffsetMs = 0;
  const nowMs = (): number => baseNow() + timeOffsetMs;

  const isTransient = (
    err: unknown,
    opts: { retryOn5xx: boolean; retryOnNetwork: boolean },
  ): boolean => {
    if (err instanceof NiceHashApiError) {
      if (err.status === 429) return true;
      if (opts.retryOn5xx && err.status >= 500 && err.status < 600) return true;
      return false;
    }
    if (err instanceof NiceHashNetworkError) return opts.retryOnNetwork;
    return false;
  };

  const retryOpts: Record<RetryClass, { retryOn5xx: boolean; retryOnNetwork: boolean }> = {
    read: { retryOn5xx: true, retryOnNetwork: true },
    mutate: { retryOn5xx: false, retryOnNetwork: false },
    cancel: { retryOn5xx: true, retryOnNetwork: true },
  };

  const withRetry = async <T>(endpoint: string, retry: RetryClass, fn: () => Promise<T>): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt >= maxRetries || !isTransient(err, retryOpts[retry])) throw err;
        await sleep(Math.min(200 * 2 ** (attempt - 1), 2000));
      }
    }
    throw lastErr;
  };

  const request = async <T>(opts: {
    method: string;
    path: string;
    query?: Readonly<Record<string, string | number | boolean | undefined | null>>;
    body?: unknown;
    auth: AuthMode;
    retry: RetryClass;
  }): Promise<T> => {
    const queryStr = opts.query ? toQueryString(opts.query) : '';
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const endpoint = `${opts.method} ${opts.path}`;

    if (opts.auth === 'required' && !hasCreds) throw new NiceHashAuthMissingError();

    return withRetry<T>(endpoint, opts.retry, async () => {
      const headers: Record<string, string> = { accept: 'application/json' };
      const sign = opts.auth === 'required' || (opts.auth === 'optional' && hasCreds);
      if (sign && creds) {
        Object.assign(
          headers,
          createSignedHeaders(creds, {
            method: opts.method,
            path: opts.path,
            query: queryStr,
            body: bodyStr,
            time: nowMs(),
          }),
        );
      } else if (bodyStr !== undefined) {
        headers['content-type'] = 'application/json';
      }

      const url = baseUrl + opts.path + (queryStr ? `?${queryStr}` : '');
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: opts.method,
          headers,
          ...(bodyStr !== undefined ? { body: bodyStr } : {}),
        });
      } catch (err) {
        throw new NiceHashNetworkError(endpoint, err);
      }

      if (!response.ok) {
        let parsed: unknown = null;
        try {
          parsed = await response.json();
        } catch {
          /* error bodies are sometimes empty (e.g. 405) */
        }
        const { errorId, errors } = parseNiceHashError(parsed);
        throw new NiceHashApiError({ status: response.status, endpoint, errorId, errors, body: parsed });
      }

      // Some mutations (cancel, refill) can answer 200 with an empty body.
      const text = await response.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return undefined as T;
      }
    });
  };

  const encodePath = (segment: string): string => encodeURIComponent(segment);

  const client: NiceHashClient = {
    async syncTime() {
      const { serverTime } = await this.getServerTime();
      timeOffsetMs = serverTime - baseNow();
      return timeOffsetMs;
    },

    getServerTime: () =>
      request<ServerTimeResponse>({
        method: 'GET',
        path: '/api/v2/time',
        auth: 'none',
        retry: 'read',
      }),

    getAlgorithms: () =>
      request<MiningAlgorithmsResponse>({
        method: 'GET',
        path: '/main/api/v2/mining/algorithms',
        auth: 'none',
        retry: 'read',
      }),

    async getAlgorithmSetting(algorithm: string) {
      const { miningAlgorithms } = await this.getAlgorithms();
      const found = miningAlgorithms.find((a) => a.algorithm === algorithm);
      if (!found) {
        throw new Error(`NiceHash algorithm "${algorithm}" not found in /mining/algorithms`);
      }
      return found;
    },

    getOrderBook: (algorithm: string) =>
      request<OrderBookResponse>({
        method: 'GET',
        path: '/main/api/v2/hashpower/orderBook',
        query: { algorithm },
        auth: 'optional',
        retry: 'read',
      }),

    getAccountBalance: (currency = 'BTC') =>
      request<AccountBalance>({
        method: 'GET',
        path: `/main/api/v2/accounting/account2/${encodePath(currency)}`,
        auth: 'required',
        retry: 'read',
      }),

    getMyOrders: ({ algorithm, market, limit = 100, ts, op = 'LT' }) =>
      request<MyOrdersResponse>({
        method: 'GET',
        path: '/main/api/v2/hashpower/myOrders',
        query: { algorithm, market, ts: ts ?? nowMs(), limit, op },
        auth: 'required',
        retry: 'read',
      }),

    getOrder: (orderId: string) =>
      request<HashpowerOrder>({
        method: 'GET',
        path: `/main/api/v2/hashpower/order/${encodePath(orderId)}`,
        auth: 'required',
        retry: 'read',
      }),

    createOrder: (params: CreateOrderParams) =>
      request<CreateOrderResponse>({
        method: 'POST',
        path: '/main/api/v2/hashpower/order/',
        body: params,
        auth: 'required',
        retry: 'mutate',
      }),

    updatePriceAndLimit: (orderId: string, params: UpdatePriceAndLimitParams) =>
      request<HashpowerOrder>({
        method: 'POST',
        path: `/main/api/v2/hashpower/order/${encodePath(orderId)}/updatePriceAndLimit/`,
        body: params,
        auth: 'required',
        retry: 'mutate',
      }),

    refillOrder: (orderId: string, amountBtc: string) =>
      request<HashpowerOrder>({
        method: 'POST',
        path: `/main/api/v2/hashpower/order/${encodePath(orderId)}/refill/`,
        body: { amount: amountBtc },
        auth: 'required',
        retry: 'mutate',
      }),

    cancelOrder: (orderId: string) =>
      request<HashpowerOrder>({
        method: 'DELETE',
        path: `/main/api/v2/hashpower/order/${encodePath(orderId)}`,
        auth: 'required',
        retry: 'cancel',
      }),

    getPools: ({ size = 100, page = 0 } = {}) =>
      request<PoolsResponse>({
        method: 'GET',
        path: '/main/api/v2/pools/',
        query: { size, page },
        auth: 'required',
        retry: 'read',
      }),

    createPool: (req: CreatePoolRequest) =>
      request<Pool>({
        method: 'POST',
        path: '/main/api/v2/pool/',
        body: req,
        auth: 'required',
        retry: 'mutate',
      }),

    deletePool: (poolId: string) =>
      request<void>({
        method: 'DELETE',
        path: `/main/api/v2/pool/${encodePath(poolId)}`,
        auth: 'required',
        retry: 'cancel',
      }),
  };

  return client;
}
