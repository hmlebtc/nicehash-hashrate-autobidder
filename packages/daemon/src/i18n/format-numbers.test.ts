import { describe, expect, it } from 'vitest';

import {
  formatBtc,
  formatFixed,
  formatInteger,
  formatPct,
  formatSat,
  formatSatAmount,
  localeTag,
  resolveDisplayLocale,
} from './format-numbers.js';

describe('localeTag', () => {
  it('maps short locale codes to BCP-47 tags', () => {
    expect(localeTag('en')).toBe('en-US');
    expect(localeTag('nl')).toBe('nl-NL');
    expect(localeTag('es')).toBe('es-ES');
  });
  it('falls back to en-US for null / undefined / unknown', () => {
    expect(localeTag(null)).toBe('en-US');
    expect(localeTag(undefined)).toBe('en-US');
    expect(localeTag('xx')).toBe('en-US');
  });
});

describe('formatInteger', () => {
  it('en uses comma thousands', () => {
    expect(formatInteger(1_062_144, 'en')).toBe('1,062,144');
  });
  it('nl uses period thousands', () => {
    expect(formatInteger(1_062_144, 'nl')).toBe('1.062.144');
  });
  it('es uses period thousands', () => {
    expect(formatInteger(1_062_144, 'es')).toBe('1.062.144');
  });
  it('rounds any fractional input down to whole number digits', () => {
    expect(formatInteger(12_418.7, 'en')).toBe('12,419');
  });
});

describe('formatBtc', () => {
  it('en uses period decimal', () => {
    expect(formatBtc(1_062_144, 'en')).toBe('0.01062144');
  });
  it('nl uses comma decimal', () => {
    expect(formatBtc(1_062_144, 'nl')).toBe('0,01062144');
  });
  it('es uses comma decimal', () => {
    expect(formatBtc(1_062_144, 'es')).toBe('0,01062144');
  });
  it('renders 0 sat cleanly', () => {
    expect(formatBtc(0, 'en')).toBe('0.00000000');
  });
});

describe('formatSat', () => {
  it('appends the unit literally (not translated)', () => {
    expect(formatSat(1_062_144, 'en')).toBe('1,062,144 sat');
    expect(formatSat(1_062_144, 'nl')).toBe('1.062.144 sat');
    expect(formatSat(1_062_144, 'es')).toBe('1.062.144 sat');
  });
});

describe('formatSatAmount', () => {
  it('returns the BTC framing for amounts at or above 1 BTC', () => {
    expect(formatSatAmount(150_000_000, 'en')).toBe('1.50000000 BTC (150,000,000 sat)');
    expect(formatSatAmount(150_000_000, 'nl')).toBe('1,50000000 BTC (150.000.000 sat)');
  });
  it('returns just the sat form for sub-BTC amounts (matches deposit-watcher convention)', () => {
    expect(formatSatAmount(1_062_144, 'en')).toBe('1,062,144 sat');
    expect(formatSatAmount(1_062_144, 'nl')).toBe('1.062.144 sat');
    expect(formatSatAmount(12_418, 'en')).toBe('12,418 sat');
  });
  it('takes the BTC framing at exactly 1 BTC', () => {
    expect(formatSatAmount(100_000_000, 'en')).toBe('1.00000000 BTC (100,000,000 sat)');
  });
});

describe('formatFixed', () => {
  it('en uses period decimal', () => {
    expect(formatFixed(3.12, 2, 'en')).toBe('3.12');
  });
  it('nl uses comma decimal', () => {
    expect(formatFixed(3.12, 2, 'nl')).toBe('3,12');
  });
  it('pads to the requested fraction width', () => {
    expect(formatFixed(4, 1, 'en')).toBe('4.0');
    expect(formatFixed(4, 1, 'nl')).toBe('4,0');
  });
});

describe('formatPct', () => {
  it('suffixes a % that does not change across locales', () => {
    expect(formatPct(0.51, 2, 'en')).toBe('0.51%');
    expect(formatPct(0.51, 2, 'nl')).toBe('0,51%');
    expect(formatPct(0.51, 2, 'es')).toBe('0,51%');
  });
});

// #227 follow-up: resolveDisplayLocale takes the dashboard's preset
// value (config.display_number_locale) and produces the concrete
// `{ bcp47, useGrouping }` pair the formatting helpers need.
describe('resolveDisplayLocale', () => {
  it('system falls back to en-US with grouping', () => {
    expect(resolveDisplayLocale('system')).toEqual({ bcp47: 'en-US', useGrouping: true });
    expect(resolveDisplayLocale(null)).toEqual({ bcp47: 'en-US', useGrouping: true });
    expect(resolveDisplayLocale(undefined)).toEqual({ bcp47: 'en-US', useGrouping: true });
  });
  it('en-US / nl-NL / fr-FR pass through unchanged', () => {
    expect(resolveDisplayLocale('en-US')).toEqual({ bcp47: 'en-US', useGrouping: true });
    expect(resolveDisplayLocale('nl-NL')).toEqual({ bcp47: 'nl-NL', useGrouping: true });
    expect(resolveDisplayLocale('fr-FR')).toEqual({ bcp47: 'fr-FR', useGrouping: true });
  });
  it('no-grouping renders en-US with thousand separators disabled', () => {
    expect(resolveDisplayLocale('no-grouping')).toEqual({
      bcp47: 'en-US',
      useGrouping: false,
    });
  });
  it('unknown values fall back to the safe en-US default', () => {
    expect(resolveDisplayLocale('zh-CN')).toEqual({ bcp47: 'en-US', useGrouping: true });
    expect(resolveDisplayLocale('')).toEqual({ bcp47: 'en-US', useGrouping: true });
  });
});

describe('formatters accept ResolvedDisplayLocale', () => {
  it('formatInteger honors useGrouping: false on no-grouping', () => {
    const resolved = resolveDisplayLocale('no-grouping');
    expect(formatInteger(1_062_144, resolved)).toBe('1062144');
  });
  it('formatBtc with nl-NL produces comma decimal', () => {
    expect(formatBtc(1_062_144, resolveDisplayLocale('nl-NL'))).toBe('0,01062144');
  });
  it('formatSatAmount with no-grouping drops thousand separators', () => {
    const resolved = resolveDisplayLocale('no-grouping');
    expect(formatSatAmount(150_000_000, resolved)).toBe('1.50000000 BTC (150000000 sat)');
  });
});
