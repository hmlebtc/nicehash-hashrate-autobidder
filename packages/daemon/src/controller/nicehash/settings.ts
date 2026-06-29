/**
 * Operator-editable NiceHash settings - the shape the dashboard config screen
 * reads and writes, persisted via `NiceHashSettingsRepo`.
 *
 * Settings are the operator's choices (credentials, connection, pool, strategy
 * knobs). Algorithm-derived minimums (min order/speed, price-down step) are NOT
 * stored here - they come from the live `/mining/algorithms` metadata when
 * building the controller config.
 */

import { parseDecimal, type MiningAlgorithmSetting } from '@hashrate-autopilot/nicehash-client';

import type { NiceHashControllerConfig, RunMode } from './types.js';

export interface NiceHashSettings {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly orgId: string;
  readonly baseUrl: string;
  readonly algorithm: string;
  readonly market: string;
  readonly priceCurrency: string;
  readonly balanceCurrency: string;
  readonly runMode: RunMode;
  readonly tickSeconds: number;
  readonly targetSpeedUnits: number;
  readonly overpayBtcPerUnitDay: number;
  readonly maxPriceBtcPerUnitDay: number;
  readonly orderBudgetBtc: number;
  readonly refillAmountBtc: number;
  readonly refillWhenRunwayHours: number;
  readonly poolHost: string;
  readonly poolPort: number;
  readonly poolUser: string;
  readonly poolPassword: string;
}

/** Sentinel returned in place of the real secret by {@link maskSettings}. */
export const SECRET_MASK = '••••••••';

type Env = Record<string, string | undefined>;
const s = (e: Env, k: string, d: string): string => (e[k] === undefined || e[k] === '' ? d : e[k]!);
const n = (e: Env, k: string, d: number): number => {
  const v = e[k];
  if (v === undefined || v === '') return d;
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};
function asRunMode(v: string | undefined): RunMode {
  return v === 'LIVE' || v === 'PAUSED' || v === 'DRY_RUN' ? v : 'DRY_RUN';
}

/** Seed settings from environment variables (first-boot defaults). */
export function settingsFromEnv(env: Env = process.env): NiceHashSettings {
  return {
    apiKey: s(env, 'NICEHASH_API_KEY', ''),
    apiSecret: s(env, 'NICEHASH_API_SECRET', ''),
    orgId: s(env, 'NICEHASH_ORG_ID', ''),
    baseUrl: s(env, 'NICEHASH_BASE_URL', 'https://api-test.nicehash.com'),
    algorithm: s(env, 'NICEHASH_ALGORITHM', 'SHA256ASICBOOST'),
    market: s(env, 'NICEHASH_MARKET', 'BTC'),
    priceCurrency: s(env, 'NICEHASH_PRICE_CURRENCY', 'BTC'),
    balanceCurrency: s(env, 'NICEHASH_BALANCE_CURRENCY', 'TBTC'),
    runMode: asRunMode(env.NICEHASH_RUN_MODE),
    tickSeconds: n(env, 'NICEHASH_TICK_SECONDS', 60),
    targetSpeedUnits: n(env, 'NICEHASH_TARGET_SPEED', 1),
    overpayBtcPerUnitDay: n(env, 'NICEHASH_OVERPAY', 0.0001),
    maxPriceBtcPerUnitDay: n(env, 'NICEHASH_MAX_PRICE', 0.02),
    orderBudgetBtc: n(env, 'NICEHASH_ORDER_BUDGET_BTC', 0.001),
    refillAmountBtc: n(env, 'NICEHASH_REFILL_AMOUNT_BTC', 0),
    refillWhenRunwayHours: n(env, 'NICEHASH_REFILL_RUNWAY_HOURS', 6),
    poolHost: s(env, 'NICEHASH_POOL_HOST', ''),
    poolPort: n(env, 'NICEHASH_POOL_PORT', 3333),
    poolUser: s(env, 'NICEHASH_POOL_USER', ''),
    poolPassword: s(env, 'NICEHASH_POOL_PASS', 'x'),
  };
}

/** Build the controller config from settings + live algorithm metadata. */
export function toControllerConfig(
  settings: NiceHashSettings,
  algo: MiningAlgorithmSetting,
  poolId: string,
): NiceHashControllerConfig {
  return {
    market: settings.market,
    algorithm: settings.algorithm,
    pool_id: poolId,
    target_speed_units: settings.targetSpeedUnits,
    overpay_btc_per_unit_day: settings.overpayBtcPerUnitDay,
    max_price_btc_per_unit_day: settings.maxPriceBtcPerUnitDay,
    max_overpay_vs_hashprice_btc_per_unit_day: null,
    order_budget_btc: settings.orderBudgetBtc,
    refill_amount_btc: settings.refillAmountBtc,
    refill_when_runway_hours: settings.refillWhenRunwayHours,
    min_order_amount_btc: parseDecimal(algo.minimalOrderAmount, 0.001),
    price_edit_deadband_pct: 20,
    min_speed_limit_units: parseDecimal(algo.minSpeedLimit, 0.1),
    price_down_step_btc: Math.abs(parseDecimal(algo.priceDownStep, 0.0001)),
    cheap_threshold_pct: 0,
    cheap_target_speed_units: 0,
  };
}

/** Copy with the secret replaced by a mask (for GET responses). */
export function maskSettings(settings: NiceHashSettings): NiceHashSettings {
  return { ...settings, apiSecret: settings.apiSecret ? SECRET_MASK : '' };
}

/**
 * Merge a (possibly partial, possibly masked) settings patch from the API onto
 * the existing settings. Unknown keys are ignored; numbers are coerced; an
 * unchanged/masked/empty `apiSecret` keeps the stored secret; `runMode` is
 * validated.
 */
export function mergeSettings(
  existing: NiceHashSettings,
  patch: Partial<Record<keyof NiceHashSettings, unknown>>,
): NiceHashSettings {
  const str = (k: keyof NiceHashSettings): string =>
    typeof patch[k] === 'string' ? (patch[k] as string) : (existing[k] as string);
  const num = (k: keyof NiceHashSettings): number => {
    const v = patch[k];
    if (v === undefined) return existing[k] as number;
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(x) ? x : (existing[k] as number);
  };
  const incomingSecret = patch.apiSecret;
  const apiSecret =
    typeof incomingSecret === 'string' && incomingSecret !== '' && incomingSecret !== SECRET_MASK
      ? incomingSecret
      : existing.apiSecret;

  return {
    apiKey: str('apiKey'),
    apiSecret,
    orgId: str('orgId'),
    baseUrl: str('baseUrl'),
    algorithm: str('algorithm'),
    market: str('market'),
    priceCurrency: str('priceCurrency'),
    balanceCurrency: str('balanceCurrency'),
    runMode: asRunMode(typeof patch.runMode === 'string' ? patch.runMode : existing.runMode),
    tickSeconds: num('tickSeconds'),
    targetSpeedUnits: num('targetSpeedUnits'),
    overpayBtcPerUnitDay: num('overpayBtcPerUnitDay'),
    maxPriceBtcPerUnitDay: num('maxPriceBtcPerUnitDay'),
    orderBudgetBtc: num('orderBudgetBtc'),
    refillAmountBtc: num('refillAmountBtc'),
    refillWhenRunwayHours: num('refillWhenRunwayHours'),
    poolHost: str('poolHost'),
    poolPort: num('poolPort'),
    poolUser: str('poolUser'),
    poolPassword: str('poolPassword'),
  };
}
