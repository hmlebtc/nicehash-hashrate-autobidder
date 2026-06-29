/**
 * Build the NiceHash runtime + controller config from environment variables.
 *
 * Shared by the standalone runner (`scripts/run-nicehash-loop.ts`) and the
 * DB-backed daemon entrypoint (`main-nicehash.ts`) so they can never drift.
 * Pure over an injected env map, so it's unit-testable.
 *
 * Connection settings (credentials, base URL, algorithm) are read first so the
 * client can be built; the rest of the controller config needs the live
 * algorithm metadata (min order / min speed / price-down step) and is built
 * once that's fetched.
 */

import { parseDecimal, type MiningAlgorithmSetting, type NiceHashCredentials } from '@hashrate-autopilot/nicehash-client';

import type { NiceHashControllerConfig, RunMode } from './types.js';

export type EnvMap = Record<string, string | undefined>;

export interface NiceHashConnection {
  readonly credentials: NiceHashCredentials;
  readonly baseUrl: string;
  readonly algorithm: string;
}

export interface NiceHashRuntimeConfig {
  readonly config: NiceHashControllerConfig;
  /** Order-book currency bucket (BTC). */
  readonly currency: string;
  /** Balance currency (TBTC on testnet, BTC on production). */
  readonly balanceCurrency: string;
  readonly runMode: RunMode;
  readonly tickSeconds: number;
  readonly ownOrderIds: ReadonlySet<string>;
}

const NICEHASH_PROD = 'https://api2.nicehash.com';
const NICEHASH_TEST = 'https://api-test.nicehash.com';

function num(env: EnvMap, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(env: EnvMap, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

/** Read connection settings; throws if a required credential is missing. */
export function readConnection(env: EnvMap = process.env): NiceHashConnection {
  const apiKey = env.NICEHASH_API_KEY;
  const apiSecret = env.NICEHASH_API_SECRET;
  const orgId = env.NICEHASH_ORG_ID;
  const missing = [
    !apiKey && 'NICEHASH_API_KEY',
    !apiSecret && 'NICEHASH_API_SECRET',
    !orgId && 'NICEHASH_ORG_ID',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Missing required env var(s): ${missing.join(', ')}`);
  }
  return {
    credentials: { apiKey: apiKey!, apiSecret: apiSecret!, orgId: orgId! },
    baseUrl: str(env, 'NICEHASH_BASE_URL', NICEHASH_TEST),
    algorithm: str(env, 'NICEHASH_ALGORITHM', 'SHA256ASICBOOST'),
  };
}

function parseRunMode(value: string | undefined): RunMode {
  if (value === 'LIVE' || value === 'PAUSED' || value === 'DRY_RUN') return value;
  return 'DRY_RUN'; // safe default
}

/**
 * Build the full controller config from env + the live algorithm metadata.
 * Marketplace minimums (order amount, speed, price-down step) come from the
 * algorithm so they're always correct for the configured algorithm.
 */
export function buildControllerConfig(
  algo: MiningAlgorithmSetting,
  env: EnvMap = process.env,
): NiceHashRuntimeConfig {
  const minOrder = parseDecimal(algo.minimalOrderAmount, 0.001);
  const config: NiceHashControllerConfig = {
    market: str(env, 'NICEHASH_MARKET', 'EU'),
    algorithm: str(env, 'NICEHASH_ALGORITHM', 'SHA256ASICBOOST'),
    pool_id: str(env, 'NICEHASH_POOL_ID', ''),
    target_speed_units: num(env, 'NICEHASH_TARGET_SPEED', 1),
    overpay_btc_per_unit_day: num(env, 'NICEHASH_OVERPAY', 0.0001),
    max_price_btc_per_unit_day: num(env, 'NICEHASH_MAX_PRICE', 0.02),
    max_overpay_vs_hashprice_btc_per_unit_day: null,
    order_budget_btc: num(env, 'NICEHASH_ORDER_BUDGET_BTC', minOrder),
    refill_amount_btc: num(env, 'NICEHASH_REFILL_AMOUNT_BTC', 0),
    refill_when_runway_hours: num(env, 'NICEHASH_REFILL_RUNWAY_HOURS', 6),
    min_order_amount_btc: minOrder,
    price_edit_deadband_pct: num(env, 'NICEHASH_DEADBAND_PCT', 20),
    min_speed_limit_units: parseDecimal(algo.minSpeedLimit, 0.1),
    price_down_step_btc: Math.abs(parseDecimal(algo.priceDownStep, 0.0001)),
    cheap_threshold_pct: num(env, 'NICEHASH_CHEAP_THRESHOLD_PCT', 0),
    cheap_target_speed_units: num(env, 'NICEHASH_CHEAP_TARGET_SPEED', 0),
  };
  const ownOrderIds = new Set(
    str(env, 'NICEHASH_OWN_ORDER_IDS', '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );
  return {
    config,
    currency: str(env, 'NICEHASH_PRICE_CURRENCY', 'BTC'),
    balanceCurrency: str(env, 'NICEHASH_BALANCE_CURRENCY', 'TBTC'),
    runMode: parseRunMode(env.NICEHASH_RUN_MODE),
    tickSeconds: num(env, 'NICEHASH_TICK_SECONDS', 60),
    ownOrderIds,
  };
}

export { NICEHASH_PROD, NICEHASH_TEST };
