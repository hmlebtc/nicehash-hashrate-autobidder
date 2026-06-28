import { describe, expect, it } from 'vitest';

import {
  btcToSats,
  orderRunwayDays,
  parseDecimal,
  priceBtcToSatPerUnitDay,
  priceSatToBtcPerUnitDay,
  roundPrice,
  SAT_PER_BTC,
  satsToBtc,
  spendRateBtcPerDay,
  toBtcString,
} from './units.js';

describe('parseDecimal', () => {
  it('parses decimal strings', () => {
    expect(parseDecimal('0.001')).toBe(0.001);
    expect(parseDecimal('42')).toBe(42);
  });
  it('returns the fallback for blank/invalid/nullish input', () => {
    expect(parseDecimal('')).toBe(0);
    expect(parseDecimal(undefined)).toBe(0);
    expect(parseDecimal(null)).toBe(0);
    expect(parseDecimal('not-a-number', -1)).toBe(-1);
  });
  it('passes through numbers', () => {
    expect(parseDecimal(3.5)).toBe(3.5);
  });
});

describe('btc <-> sat', () => {
  it('round-trips', () => {
    expect(btcToSats(1)).toBe(SAT_PER_BTC);
    expect(satsToBtc(SAT_PER_BTC)).toBe(1);
    expect(btcToSats(0.001)).toBe(100_000);
  });
});

describe('price conversions', () => {
  it('converts BTC/unit/day <-> sat/unit/day', () => {
    expect(priceBtcToSatPerUnitDay(0.0005)).toBe(50_000);
    expect(priceSatToBtcPerUnitDay(50_000)).toBe(0.0005);
  });
});

describe('spendRateBtcPerDay', () => {
  it('multiplies price by speed', () => {
    expect(spendRateBtcPerDay(0.0005, 10)).toBeCloseTo(0.005, 12);
  });
});

describe('orderRunwayDays', () => {
  it('computes days of escrow left', () => {
    // 0.01 BTC at 0.0005 BTC/unit/day × 10 units = 0.005 BTC/day -> 2 days
    expect(orderRunwayDays(0.01, 0.0005, 10)).toBeCloseTo(2, 12);
  });
  it('returns 0 with no escrow', () => {
    expect(orderRunwayDays(0, 0.0005, 10)).toBe(0);
  });
  it('returns Infinity when nothing is draining the order', () => {
    expect(orderRunwayDays(0.01, 0, 10)).toBe(Infinity);
    expect(orderRunwayDays(0.01, 0.0005, 0)).toBe(Infinity);
  });
});

describe('roundPrice', () => {
  it('rounds to 4 decimals by default', () => {
    expect(roundPrice(0.00012345)).toBe(0.0001);
    expect(roundPrice(0.00018)).toBe(0.0002);
  });
  it('honours a custom precision', () => {
    expect(roundPrice(0.00012345, 6)).toBe(0.000123);
  });
});

describe('toBtcString', () => {
  it('formats with fixed decimals', () => {
    expect(toBtcString(0.001)).toBe('0.00100000');
    expect(toBtcString(1.23456789, 4)).toBe('1.2346');
  });
});
