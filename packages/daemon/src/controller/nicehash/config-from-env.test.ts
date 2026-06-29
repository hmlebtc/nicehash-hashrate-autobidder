import { describe, expect, it } from 'vitest';

import type { MiningAlgorithmSetting } from '@hashrate-autopilot/nicehash-client';

import { buildControllerConfig, readConnection, type EnvMap } from './config-from-env.js';

const ALGO: MiningAlgorithmSetting = {
  algorithm: 'SHA256ASICBOOST',
  marketFactor: '1000000000000000',
  displayMarketFactor: 'PH',
  minimalOrderAmount: '0.001',
  minSpeedLimit: '0.1',
  maxSpeedLimit: '100000',
  priceDownStep: '-0.1',
};

describe('readConnection', () => {
  it('throws listing the missing credential vars', () => {
    expect(() => readConnection({})).toThrow(/NICEHASH_API_KEY/);
    expect(() => readConnection({ NICEHASH_API_KEY: 'k' })).toThrow(/NICEHASH_API_SECRET/);
  });

  it('reads credentials and defaults the base URL to testnet', () => {
    const conn = readConnection({ NICEHASH_API_KEY: 'k', NICEHASH_API_SECRET: 's', NICEHASH_ORG_ID: 'o' });
    expect(conn.credentials).toEqual({ apiKey: 'k', apiSecret: 's', orgId: 'o' });
    expect(conn.baseUrl).toBe('https://api-test.nicehash.com');
    expect(conn.algorithm).toBe('SHA256ASICBOOST');
  });
});

describe('buildControllerConfig', () => {
  it('uses algorithm metadata for marketplace minimums', () => {
    const { config } = buildControllerConfig(ALGO, {});
    expect(config.min_order_amount_btc).toBe(0.001);
    expect(config.min_speed_limit_units).toBe(0.1);
    expect(config.price_down_step_btc).toBe(0.1); // abs of -0.1
    expect(config.order_budget_btc).toBe(0.001); // defaults to min order
  });

  it('applies env overrides and parses run mode + own-order ids', () => {
    const env: EnvMap = {
      NICEHASH_MARKET: 'USA',
      NICEHASH_TARGET_SPEED: '5',
      NICEHASH_OVERPAY: '0.0002',
      NICEHASH_MAX_PRICE: '0.05',
      NICEHASH_RUN_MODE: 'LIVE',
      NICEHASH_TICK_SECONDS: '30',
      NICEHASH_OWN_ORDER_IDS: 'a, b ,c',
      NICEHASH_BALANCE_CURRENCY: 'BTC',
    };
    const rc = buildControllerConfig(ALGO, env);
    expect(rc.config.market).toBe('USA');
    expect(rc.config.target_speed_units).toBe(5);
    expect(rc.config.overpay_btc_per_unit_day).toBe(0.0002);
    expect(rc.config.max_price_btc_per_unit_day).toBe(0.05);
    expect(rc.runMode).toBe('LIVE');
    expect(rc.tickSeconds).toBe(30);
    expect([...rc.ownOrderIds]).toEqual(['a', 'b', 'c']);
    expect(rc.balanceCurrency).toBe('BTC');
  });

  it('defaults an invalid run mode to DRY_RUN', () => {
    expect(buildControllerConfig(ALGO, { NICEHASH_RUN_MODE: 'BOGUS' }).runMode).toBe('DRY_RUN');
  });
});
