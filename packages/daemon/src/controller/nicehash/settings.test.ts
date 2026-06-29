import { describe, expect, it } from 'vitest';

import type { MiningAlgorithmSetting } from '@hashrate-autopilot/nicehash-client';

import {
  SECRET_MASK,
  maskSettings,
  mergeSettings,
  resolveBootRunMode,
  settingsFromEnv,
  speedUnitLabel,
  toControllerConfig,
  type NiceHashSettings,
} from './settings.js';

function base(): NiceHashSettings {
  return settingsFromEnv({});
}

describe('settingsFromEnv', () => {
  it('uses safe defaults when env is empty', () => {
    const s = settingsFromEnv({});
    expect(s.apiKey).toBe('');
    expect(s.apiSecret).toBe('');
    expect(s.orgId).toBe('');
    expect(s.baseUrl).toBe('https://api-test.nicehash.com');
    expect(s.algorithm).toBe('SHA256ASICBOOST');
    expect(s.market).toBe('BTC');
    expect(s.priceCurrency).toBe('BTC');
    expect(s.balanceCurrency).toBe('TBTC');
    expect(s.runMode).toBe('DRY_RUN');
    expect(s.tickSeconds).toBe(60);
    // parity-expansion defaults
    expect(s.cheapModeEnabled).toBe(false);
    expect(s.maxPremiumOverHashpriceBtc).toBe(0);
    expect(s.editPriceDeadbandPct).toBe(20);
    expect(s.bootMode).toBe('RESUME');
    expect(s.hashpriceSource).toBe('none');
    expect(s.retentionDays).toBe(30);
    expect(s.niceHashFeePct).toBe(3);
    expect(s.poolFeePct).toBe(1);
    expect(s.useBreakEven).toBe(true);
    expect(s.capAtBreakEven).toBe(true);
    expect(s.logRetentionDays).toBe(30);
  });

  it('reads overrides from env and coerces numbers', () => {
    const s = settingsFromEnv({
      NICEHASH_API_KEY: 'k',
      NICEHASH_API_SECRET: 's',
      NICEHASH_ORG_ID: 'o',
      NICEHASH_BASE_URL: 'https://api2.nicehash.com',
      NICEHASH_RUN_MODE: 'LIVE',
      NICEHASH_TICK_SECONDS: '30',
      NICEHASH_TARGET_SPEED: '2.5',
      NICEHASH_BALANCE_CURRENCY: 'BTC',
    });
    expect(s.apiKey).toBe('k');
    expect(s.baseUrl).toBe('https://api2.nicehash.com');
    expect(s.runMode).toBe('LIVE');
    expect(s.tickSeconds).toBe(30);
    expect(s.targetSpeedUnits).toBe(2.5);
    expect(s.balanceCurrency).toBe('BTC');
  });

  it('falls back to DRY_RUN for an unknown run mode', () => {
    expect(settingsFromEnv({ NICEHASH_RUN_MODE: 'NONSENSE' }).runMode).toBe('DRY_RUN');
  });
});

describe('maskSettings', () => {
  it('replaces a present secret with the mask', () => {
    expect(maskSettings({ ...base(), apiSecret: 'shh' }).apiSecret).toBe(SECRET_MASK);
  });
  it('leaves an empty secret empty', () => {
    expect(maskSettings({ ...base(), apiSecret: '' }).apiSecret).toBe('');
  });
});

describe('mergeSettings', () => {
  it('keeps the stored secret when the patch is masked, empty, or absent', () => {
    const existing = { ...base(), apiSecret: 'stored' };
    expect(mergeSettings(existing, { apiSecret: SECRET_MASK }).apiSecret).toBe('stored');
    expect(mergeSettings(existing, { apiSecret: '' }).apiSecret).toBe('stored');
    expect(mergeSettings(existing, {}).apiSecret).toBe('stored');
  });

  it('replaces the secret when a real new value is posted', () => {
    expect(mergeSettings({ ...base(), apiSecret: 'old' }, { apiSecret: 'new' }).apiSecret).toBe('new');
  });

  it('coerces numeric strings and ignores non-numeric ones', () => {
    const existing = { ...base(), tickSeconds: 60, targetSpeedUnits: 1 };
    const merged = mergeSettings(existing, { tickSeconds: '30', targetSpeedUnits: 'NaN-ish' });
    expect(merged.tickSeconds).toBe(30);
    expect(merged.targetSpeedUnits).toBe(1); // unchanged on non-numeric
  });

  it('validates run mode', () => {
    expect(mergeSettings(base(), { runMode: 'LIVE' }).runMode).toBe('LIVE');
    expect(mergeSettings(base(), { runMode: 'BOGUS' }).runMode).toBe('DRY_RUN');
  });

  it('ignores unknown keys', () => {
    const merged = mergeSettings(base(), { bogusKey: 'x' } as Record<string, unknown>);
    expect(merged).not.toHaveProperty('bogusKey');
  });

  it('coerces booleans, boot mode, and hashprice source', () => {
    expect(mergeSettings(base(), { cheapModeEnabled: true }).cheapModeEnabled).toBe(true);
    expect(mergeSettings(base(), { cheapModeEnabled: 'true' }).cheapModeEnabled).toBe(true);
    expect(mergeSettings(base(), { cheapModeEnabled: '1' }).cheapModeEnabled).toBe(true);
    expect(mergeSettings(base(), { cheapModeEnabled: 'false' }).cheapModeEnabled).toBe(false);
    expect(mergeSettings(base(), { bootMode: 'LIVE' }).bootMode).toBe('LIVE');
    expect(mergeSettings(base(), { bootMode: 'BOGUS' }).bootMode).toBe('RESUME');
    expect(mergeSettings(base(), { hashpriceSource: 'mempool' }).hashpriceSource).toBe('mempool');
    expect(mergeSettings(base(), { hashpriceSource: 'bogus' }).hashpriceSource).toBe('none');
  });

  it('coerces the fee fields and the break-even toggles', () => {
    const m = mergeSettings(base(), {
      niceHashFeePct: '2.5',
      poolFeePct: '0.5',
      capAtBreakEven: 'false',
      useBreakEven: 'false',
    });
    expect(m.niceHashFeePct).toBe(2.5);
    expect(m.poolFeePct).toBe(0.5);
    expect(m.capAtBreakEven).toBe(false);
    expect(m.useBreakEven).toBe(false);
    expect(mergeSettings(base(), { capAtBreakEven: true }).capAtBreakEven).toBe(true);
    expect(mergeSettings(base(), { useBreakEven: true }).useBreakEven).toBe(true);
  });
});

describe('resolveBootRunMode', () => {
  it('forces DRY_RUN / LIVE regardless of persisted mode', () => {
    expect(resolveBootRunMode('DRY_RUN', 'LIVE')).toBe('DRY_RUN');
    expect(resolveBootRunMode('LIVE', 'PAUSED')).toBe('LIVE');
  });
  it('RESUME keeps the persisted mode but demotes PAUSED to DRY_RUN', () => {
    expect(resolveBootRunMode('RESUME', 'LIVE')).toBe('LIVE');
    expect(resolveBootRunMode('RESUME', 'DRY_RUN')).toBe('DRY_RUN');
    expect(resolveBootRunMode('RESUME', 'PAUSED')).toBe('DRY_RUN');
  });
});

describe('speedUnitLabel', () => {
  it('maps the algorithm marketFactor to its speed unit', () => {
    expect(speedUnitLabel(1e18)).toBe('EH'); // SHA256ASICBOOST
    expect(speedUnitLabel(1e15)).toBe('PH');
    expect(speedUnitLabel(1e12)).toBe('TH');
    expect(speedUnitLabel(0)).toBe('PH'); // safe fallback
    expect(speedUnitLabel(Number.NaN)).toBe('PH');
  });
});

describe('toControllerConfig', () => {
  const algo: MiningAlgorithmSetting = {
    minimalOrderAmount: '0.001',
    minSpeedLimit: '0.1',
    priceDownStep: '-0.1',
    marketFactor: '1000000000000000',
    displayMarketFactor: 'PH',
  } as MiningAlgorithmSetting;

  it('carries strategy knobs through and derives minimums from the algorithm', () => {
    const settings = {
      ...base(),
      market: 'BTC',
      algorithm: 'SHA256ASICBOOST',
      targetSpeedUnits: 3,
      overpayBtcPerUnitDay: 0.0002,
      maxPriceBtcPerUnitDay: 0.03,
      orderBudgetBtc: 0.002,
    };
    const cfg = toControllerConfig(settings, algo, 'pool-9');
    expect(cfg.market).toBe('BTC');
    expect(cfg.speed_display_unit).toBe('PH'); // marketFactor 1e15
    expect(cfg.algorithm).toBe('SHA256ASICBOOST');
    expect(cfg.pool_id).toBe('pool-9');
    expect(cfg.target_speed_units).toBe(3);
    expect(cfg.overpay_btc_per_unit_day).toBe(0.0002);
    expect(cfg.max_price_btc_per_unit_day).toBe(0.03);
    expect(cfg.order_budget_btc).toBe(0.002);
    expect(cfg.min_order_amount_btc).toBe(0.001);
    expect(cfg.min_speed_limit_units).toBe(0.1);
    expect(cfg.price_down_step_btc).toBe(0.1); // absolute value of the negative step
  });

  it('maps the edit-price deadband and the hashprice cap (0 disables)', () => {
    const off = toControllerConfig({ ...base(), editPriceDeadbandPct: 35 }, algo, 'p');
    expect(off.price_edit_deadband_pct).toBe(35);
    expect(off.max_overpay_vs_hashprice_btc_per_unit_day).toBeNull();
    const on = toControllerConfig({ ...base(), maxPremiumOverHashpriceBtc: 0.002 }, algo, 'p');
    expect(on.max_overpay_vs_hashprice_btc_per_unit_day).toBe(0.002);
  });

  it('wires cheap mode only when enabled', () => {
    const disabled = toControllerConfig(
      { ...base(), cheapModeEnabled: false, cheapThresholdPct: 95, cheapModeTargetUnits: 10 },
      algo,
      'p',
    );
    expect(disabled.cheap_threshold_pct).toBe(0);
    expect(disabled.cheap_target_speed_units).toBe(0);
    const enabled = toControllerConfig(
      { ...base(), cheapModeEnabled: true, cheapThresholdPct: 95, cheapModeTargetUnits: 10 },
      algo,
      'p',
    );
    expect(enabled.cheap_threshold_pct).toBe(95);
    expect(enabled.cheap_target_speed_units).toBe(10);
  });

  it('carries the fees + break-even toggles into the controller config', () => {
    const cfg = toControllerConfig(
      { ...base(), niceHashFeePct: 3, poolFeePct: 1, useBreakEven: true, capAtBreakEven: true },
      algo,
      'p',
    );
    expect(cfg.nicehash_fee_pct).toBe(3);
    expect(cfg.pool_fee_pct).toBe(1);
    expect(cfg.use_break_even).toBe(true);
    expect(cfg.cap_at_break_even).toBe(true);
  });
});
