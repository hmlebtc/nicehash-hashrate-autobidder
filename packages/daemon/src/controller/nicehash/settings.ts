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

/** How the daemon picks its run mode on boot. */
export type BootMode = 'DRY_RUN' | 'RESUME' | 'LIVE';

/** Network-hashprice oracle provider. `none` disables hashprice features. */
export type HashpriceSource = 'none' | 'mempool';

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
  // --- Strategy (parity expansion) ---
  readonly cheapModeEnabled: boolean;
  /** Target speed while cheap mode is engaged (display units). */
  readonly cheapModeTargetUnits: number;
  /** Engage cheap mode when our bid < this % of hashprice. */
  readonly cheapThresholdPct: number;
  /** Dynamic ceiling = hashprice + this (BTC/unit/day); 0 disables. */
  readonly maxPremiumOverHashpriceBtc: number;
  // --- Track-to-fill ---
  /**
   * Anchor on the next filled tier (second rung of the fill ladder) instead of
   * the marginal (cheapest filled). Places the bid where the market is actually
   * allocating hashrate on a thin/lumpy book. Falls back to the marginal when
   * there is no distinct second tier. Default true.
   */
  readonly anchorNextFilledTier: boolean;
  /** Treat the order as filled once delivered ≥ this % of target. Default 80. */
  readonly minFillPct: number;
  /**
   * When true, while under-filled the bidder walks the price up to just above
   * the next filled order on the book + overpay (climbing tier by tier) until
   * filled or a cap binds. When false, pure floor-tracking. Default true.
   */
  readonly walkUpEnabled: boolean;
  /**
   * Seconds the order must stay under-filled before the bidder walks the price up.
   * Gives a fresh/just-repriced order time to attract miners before escalating,
   * and paces floor-tracking walk-ups. For the escalation ladder it is
   * episode-based (gates entry/re-entry, not steps within an episode).
   * 0 = climb as soon as under-filled. Default 180.
   */
  readonly walkUpGraceSeconds: number;
  /**
   * Escalation ladder step (BTC/EH/day). While the order stays under-filled at
   * the normal floor (anchor + overpay) past the walk-up grace, the bid
   * escalates above the floor by this much per escalation interval, bounded by
   * the dynamic cap - a pure ladder, one step at a time (no market-hint jump).
   * After sustained fills it decays one probe step per NiceHash
   * decrease-cooldown window (~10 min). Only active with walkUpEnabled.
   * Clamped to >= 0.0001 (the price grid). Default 0.0002.
   */
  readonly escalationStepBtc: number;
  /**
   * Seconds between upward escalation-ladder moves while under-filled (decay
   * while filled paces on the decrease cooldown when that is longer). Clamped
   * to >= 5 whole seconds. Default 60.
   */
  readonly escalationIntervalSeconds: number;
  // --- Fees / break-even ---
  /** NiceHash marketplace fee on the order, percent (e.g. 3). */
  readonly niceHashFeePct: number;
  /** Mining-pool fee, percent (e.g. 1). */
  readonly poolFeePct: number;
  /**
   * Master switch for the dynamic price cap. When on, the bid is capped at the
   * fee-adjusted, buffered hashprice and the dashboard shows the cap tiles /
   * fee-aware P&L. When off, the fees and cap are ignored and pricing uses only
   * overpay + the fixed/premium ceilings.
   */
  readonly dynamicCapEnabled: boolean;
  /**
   * Profit buffer for the dynamic cap, an absolute amount in BTC/EH/day held
   * back below the fee-adjusted hashprice: dynamic cap = hashprice x (1 -
   * (niceHashFee + poolFee)/100) - this. 0 = pure break-even (no margin).
   */
  readonly dynamicCapBufferBtc: number;
  // --- Daemon / data ---
  readonly bootMode: BootMode;
  /** Network-hashprice oracle provider. */
  readonly hashpriceSource: HashpriceSource;
  /** BTC/USD price oracle for display (dashboard USD toggle). */
  readonly priceSource: string;
  /** Days of tick-metrics + order-event history to retain. */
  readonly retentionDays: number;
  /** Days of decision/error logs to retain (Logs tab). */
  readonly logRetentionDays: number;
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
const b = (e: Env, k: string, d: boolean): boolean => {
  const v = e[k];
  if (v === undefined || v === '') return d;
  return v === '1' || v.toLowerCase() === 'true';
};
function asRunMode(v: string | undefined): RunMode {
  return v === 'LIVE' || v === 'PAUSED' || v === 'DRY_RUN' ? v : 'DRY_RUN';
}
function asBootMode(v: string | undefined): BootMode {
  return v === 'DRY_RUN' || v === 'RESUME' || v === 'LIVE' ? v : 'RESUME';
}
function asHashpriceSource(v: string | undefined): HashpriceSource {
  return v === 'mempool' || v === 'none' ? v : 'none';
}

/**
 * Resolve the run mode the daemon should boot into, given the boot policy and
 * the last persisted run mode. RESUME demotes PAUSED to DRY_RUN (a paused
 * order should not silently resume trading after a restart).
 */
export function resolveBootRunMode(bootMode: BootMode, persisted: RunMode): RunMode {
  if (bootMode === 'DRY_RUN') return 'DRY_RUN';
  if (bootMode === 'LIVE') return 'LIVE';
  return persisted === 'PAUSED' ? 'DRY_RUN' : persisted;
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
    cheapModeEnabled: b(env, 'NICEHASH_CHEAP_ENABLED', false),
    cheapModeTargetUnits: n(env, 'NICEHASH_CHEAP_TARGET_SPEED', 0),
    cheapThresholdPct: n(env, 'NICEHASH_CHEAP_THRESHOLD_PCT', 0),
    maxPremiumOverHashpriceBtc: n(env, 'NICEHASH_MAX_PREMIUM_VS_HASHPRICE', 0),
    anchorNextFilledTier: b(env, 'NICEHASH_ANCHOR_NEXT_FILLED_TIER', true),
    minFillPct: n(env, 'NICEHASH_MIN_FILL_PCT', 80),
    walkUpEnabled: b(env, 'NICEHASH_WALK_UP', true),
    walkUpGraceSeconds: n(env, 'NICEHASH_WALK_UP_GRACE_SECONDS', 180),
    escalationStepBtc: n(env, 'NICEHASH_ESCALATION_STEP', 0.0002),
    escalationIntervalSeconds: n(env, 'NICEHASH_ESCALATION_INTERVAL_SECONDS', 60),
    niceHashFeePct: n(env, 'NICEHASH_FEE_PCT', 3),
    poolFeePct: n(env, 'NICEHASH_POOL_FEE_PCT', 1),
    dynamicCapEnabled: b(env, 'NICEHASH_DYNAMIC_CAP', true),
    dynamicCapBufferBtc: n(env, 'NICEHASH_DYNAMIC_CAP_BUFFER', 0),
    bootMode: asBootMode(env.NICEHASH_BOOT_MODE),
    hashpriceSource: asHashpriceSource(env.NICEHASH_HASHPRICE_SOURCE),
    priceSource: s(env, 'NICEHASH_PRICE_SOURCE', 'coingecko'),
    retentionDays: n(env, 'NICEHASH_RETENTION_DAYS', 30),
    logRetentionDays: n(env, 'NICEHASH_LOG_RETENTION_DAYS', 30),
  };
}

/**
 * Map an algorithm's `marketFactor` (hashes per speed-display unit) to its unit
 * label - the unit NiceHash shows speeds in for that market. SHA256ASICBOOST
 * uses 1e18 = EH/s; other algos may use PH/TH. Defaults to PH if unrecognised.
 */
export function speedUnitLabel(marketFactor: number): string {
  if (!(marketFactor > 0)) return 'PH';
  const scale: readonly [number, string][] = [
    [1e18, 'EH'],
    [1e15, 'PH'],
    [1e12, 'TH'],
    [1e9, 'GH'],
    [1e6, 'MH'],
    [1e3, 'kH'],
    [1, 'H'],
  ];
  for (const [factor, label] of scale) if (marketFactor >= factor) return label;
  return 'H';
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
    pool_user: settings.poolUser,
    target_speed_units: settings.targetSpeedUnits,
    overpay_btc_per_unit_day: settings.overpayBtcPerUnitDay,
    max_price_btc_per_unit_day: settings.maxPriceBtcPerUnitDay,
    max_overpay_vs_hashprice_btc_per_unit_day:
      settings.maxPremiumOverHashpriceBtc > 0 ? settings.maxPremiumOverHashpriceBtc : null,
    order_budget_btc: settings.orderBudgetBtc,
    refill_amount_btc: settings.refillAmountBtc,
    refill_when_runway_hours: settings.refillWhenRunwayHours,
    min_order_amount_btc: parseDecimal(algo.minimalOrderAmount, 0.001),
    anchor_next_filled_tier: settings.anchorNextFilledTier,
    min_speed_limit_units: parseDecimal(algo.minSpeedLimit, 0.1),
    price_down_step_btc: Math.abs(parseDecimal(algo.priceDownStep, 0.0001)),
    min_fill_pct: settings.minFillPct,
    walk_up_enabled: settings.walkUpEnabled,
    walk_up_grace_seconds: settings.walkUpGraceSeconds,
    escalation_step_btc: settings.escalationStepBtc,
    escalation_interval_seconds: settings.escalationIntervalSeconds,
    // Cheap mode only engages when enabled AND its target exceeds the normal one.
    cheap_threshold_pct: settings.cheapModeEnabled ? settings.cheapThresholdPct : 0,
    cheap_target_speed_units: settings.cheapModeEnabled ? settings.cheapModeTargetUnits : 0,
    nicehash_fee_pct: settings.niceHashFeePct,
    pool_fee_pct: settings.poolFeePct,
    dynamic_cap_enabled: settings.dynamicCapEnabled,
    dynamic_cap_buffer_btc: settings.dynamicCapBufferBtc,
    speed_display_unit: speedUnitLabel(Number(algo.marketFactor)),
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
  const bool = (k: keyof NiceHashSettings): boolean => {
    const v = patch[k];
    if (v === undefined) return existing[k] as boolean;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
    return existing[k] as boolean;
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
    // Clamp to a 5s floor and whole seconds: the dashboard posts the raw input
    // string and Number('') === 0, so a cleared field (or a 0/negative value)
    // would remove the per-second pause between control-loop passes entirely
    // and hammer the NiceHash API back-to-back until rate-limited.
    tickSeconds: Math.max(5, Math.round(num('tickSeconds'))),
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
    cheapModeEnabled: bool('cheapModeEnabled'),
    cheapModeTargetUnits: num('cheapModeTargetUnits'),
    cheapThresholdPct: num('cheapThresholdPct'),
    maxPremiumOverHashpriceBtc: num('maxPremiumOverHashpriceBtc'),
    anchorNextFilledTier: bool('anchorNextFilledTier'),
    minFillPct: num('minFillPct'),
    walkUpEnabled: bool('walkUpEnabled'),
    walkUpGraceSeconds: num('walkUpGraceSeconds'),
    // Clamp to the price grid: a 0/negative step would make the escalation
    // ladder a no-op loop (or walk the wrong way).
    escalationStepBtc: Math.max(0.0001, num('escalationStepBtc')),
    // Clamp to a 5s floor and whole seconds, same rationale as tickSeconds: a
    // cleared field coerces to 0 and would step the ladder every single tick.
    escalationIntervalSeconds: Math.max(5, Math.round(num('escalationIntervalSeconds'))),
    niceHashFeePct: num('niceHashFeePct'),
    poolFeePct: num('poolFeePct'),
    dynamicCapEnabled: bool('dynamicCapEnabled'),
    dynamicCapBufferBtc: num('dynamicCapBufferBtc'),
    bootMode: asBootMode(typeof patch.bootMode === 'string' ? patch.bootMode : existing.bootMode),
    hashpriceSource: asHashpriceSource(
      typeof patch.hashpriceSource === 'string' ? patch.hashpriceSource : existing.hashpriceSource,
    ),
    priceSource: str('priceSource'),
    retentionDays: num('retentionDays'),
    logRetentionDays: num('logRetentionDays'),
  };
}
