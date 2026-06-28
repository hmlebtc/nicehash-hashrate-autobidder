import { describe, expect, it } from 'vitest';

import {
  formatTimeTick,
  localAlignedTimeTicks,
  niceYTicks,
  pickTimeTickInterval,
} from './chart-axis.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('pickTimeTickInterval', () => {
  it('returns sub-hour intervals for short spans', () => {
    expect(pickTimeTickInterval(30 * MIN)).toBe(5 * MIN);
    expect(pickTimeTickInterval(60 * MIN)).toBe(10 * MIN);
    expect(pickTimeTickInterval(2 * HOUR)).toBe(30 * MIN);
  });

  it('returns hourly+ for medium spans', () => {
    expect(pickTimeTickInterval(6 * HOUR)).toBe(HOUR);
    expect(pickTimeTickInterval(12 * HOUR)).toBe(2 * HOUR);
    expect(pickTimeTickInterval(24 * HOUR)).toBe(6 * HOUR);
  });

  it('returns daily+ for long spans (target = span/6, picks next-larger candidate)', () => {
    // 7 days / 6 ≈ 28h → next candidate is 2*DAY
    expect(pickTimeTickInterval(7 * DAY)).toBe(2 * DAY);
    // 30 days / 6 = 5d → next candidate is 7*DAY
    expect(pickTimeTickInterval(30 * DAY)).toBe(7 * DAY);
    // 4 days / 6 ≈ 16h → next candidate is 1*DAY
    expect(pickTimeTickInterval(4 * DAY)).toBe(DAY);
  });
});

describe('localAlignedTimeTicks', () => {
  it('returns hourly ticks aligned to local top-of-hour', () => {
    // Pick a span that crosses several hours. Use Date.now()-relative
    // values so the test stays timezone-agnostic - we only check the
    // *alignment*, not the absolute clock value.
    const start = new Date();
    start.setHours(8, 37, 12, 555); // not on the hour
    const end = new Date(start);
    end.setHours(end.getHours() + 4); // span ~4h 23m

    const ticks = localAlignedTimeTicks(start.getTime(), end.getTime(), HOUR);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const t of ticks) {
      const d = new Date(t);
      expect(d.getMinutes()).toBe(0);
      expect(d.getSeconds()).toBe(0);
    }
  });

  it('returns minute ticks aligned to multiples of stepMinutes', () => {
    const start = new Date();
    start.setHours(10, 7, 0, 0);
    const end = new Date(start);
    end.setMinutes(end.getMinutes() + 60);

    const ticks = localAlignedTimeTicks(start.getTime(), end.getTime(), 15 * MIN);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const t of ticks) {
      const d = new Date(t);
      expect(d.getMinutes() % 15).toBe(0);
    }
  });

  it('returns daily ticks aligned to local midnight', () => {
    const start = new Date();
    start.setHours(14, 30, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);

    const ticks = localAlignedTimeTicks(start.getTime(), end.getTime(), DAY);
    expect(ticks.length).toBeGreaterThanOrEqual(5);
    for (const t of ticks) {
      const d = new Date(t);
      expect(d.getHours()).toBe(0);
      expect(d.getMinutes()).toBe(0);
    }
  });

  it('returns empty when maxMs <= minMs', () => {
    expect(localAlignedTimeTicks(1000, 1000, HOUR)).toEqual([]);
    expect(localAlignedTimeTicks(2000, 1000, HOUR)).toEqual([]);
  });

  it('every emitted tick lies within [minMs, maxMs]', () => {
    const start = new Date();
    start.setHours(8, 37, 0, 0);
    const end = new Date(start);
    end.setHours(end.getHours() + 6);
    const ticks = localAlignedTimeTicks(start.getTime(), end.getTime(), HOUR);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(start.getTime());
      expect(t).toBeLessThanOrEqual(end.getTime());
    }
  });
});

describe('formatTimeTick', () => {
  it('formats intraday intervals as HH:mm 24-hour', () => {
    const d = new Date();
    d.setHours(9, 0, 0, 0);
    const out = formatTimeTick(d.getTime(), HOUR, 'en-US');
    expect(out).toMatch(/09/);
    expect(out).toMatch(/00/);
  });

  it('formats multi-hour intervals with weekday + time', () => {
    const d = new Date(2026, 3, 16, 12, 0, 0);
    const out = formatTimeTick(d.getTime(), 6 * HOUR, 'en-US');
    // Should include a weekday abbreviation and the time
    expect(out).toMatch(/12/);
    expect(out).toMatch(/00/);
  });

  it('formats day intervals with weekday + date', () => {
    const d = new Date(2026, 3, 16, 14, 0, 0);
    const out = formatTimeTick(d.getTime(), DAY, 'en-US');
    expect(out).toMatch(/16/);
  });

  it('formats week intervals as dd month', () => {
    const d = new Date(2026, 3, 16, 14, 0, 0);
    const out = formatTimeTick(d.getTime(), 7 * DAY, 'en-US');
    expect(out).toMatch(/16/);
    expect(out).toMatch(/Apr/);
  });

  it('formats month intervals with month + year', () => {
    const d = new Date(2026, 3, 16, 14, 0, 0);
    const out = formatTimeTick(d.getTime(), 30 * DAY, 'en-US');
    expect(out).toMatch(/Apr/);
    expect(out).toMatch(/26/);
  });
});

describe('niceYTicks', () => {
  it('basic 0..1 range with default count produces sensible ticks', () => {
    const out = niceYTicks(0, 1, 5);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(20);
    expect(out[0]).toBeLessThanOrEqual(0);
    expect(out[out.length - 1]).toBeGreaterThanOrEqual(1);
  });

  it('returns [dataMin] when dataMax <= dataMin', () => {
    expect(niceYTicks(5, 5, 5)).toEqual([5]);
    expect(niceYTicks(10, 3, 5)).toEqual([10]);
  });

  it('terminates and stays bounded on trillion-scale tiny rawSpan (the #236 hang scenario)', () => {
    // Difficulty data at ~1e14 scale, rawSpan of ~3.7 (within an
    // epoch, post-aggregation FP noise). Pre-fix this could lose
    // precision in the v += step accumulator and infinite-loop.
    const start = Date.now();
    const out = niceYTicks(138959663236498.6, 138959663236502.3, 5);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // must be fast, not stuck
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(100);
  });

  it('terminates on rawSpan well below FP precision at huge magnitude', () => {
    // dataMin + step rounds back to dataMin in IEEE 754; loop must
    // detect the non-progress and bail rather than spin forever.
    const start = Date.now();
    const out = niceYTicks(1e14, 1e14 + 1e-5, 5);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(out.length).toBeLessThan(1000);
  });

  it('rejects NaN inputs by returning an empty list', () => {
    expect(niceYTicks(Number.NaN, 1, 5)).toEqual([]);
    expect(niceYTicks(0, Number.NaN, 5)).toEqual([]);
  });

  it('rejects Infinity inputs by returning an empty list', () => {
    expect(niceYTicks(Number.POSITIVE_INFINITY, 0, 5)).toEqual([]);
    expect(niceYTicks(0, Number.POSITIVE_INFINITY, 5)).toEqual([]);
  });

  it('caps the tick array at a reasonable maximum for pathological inputs', () => {
    // Even if step somehow gets computed too small relative to range,
    // the loop must hard-stop. This guards against degenerate inputs
    // smuggling in a runaway allocation.
    const start = Date.now();
    const out = niceYTicks(0, 1e6, 5);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(out.length).toBeLessThan(50);
  });

  it('pinned operator-data scenario: difficulty at 24h chart range (#236 follow-up #2)', () => {
    // Real values from /api/metrics?range=24h on 2026-06-02:
    // 2 distinct network_difficulty values 0.15 apart at scale 1.39e14.
    // Pre-fix this hung Firefox out of memory because `step = 0.05`
    // computed below double-precision resolution at 1.39e14 magnitude,
    // so `v += step` never progressed and the loop ran forever
    // allocating SVG tick labels until the JS heap OOMed.
    const start = Date.now();
    const out = niceYTicks(138955357012247.3, 138955357012247.45, 5);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(50);
  });
});
