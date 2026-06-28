/**
 * Time-axis tick utilities shared between the hashrate and price charts.
 *
 * Goal: generate a small set of "round" tick timestamps (e.g. 08:00,
 * 09:00, 10:00) aligned to the *local* clock so the operator never has
 * to read 08:38:55-style arbitrary cuts. Both charts call the same
 * generator + formatter so their X-axes line up tick-for-tick.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Pick a "nice" interval that yields roughly 4-8 labels across the
 * visible span. Candidates are the human-friendly clock divisions -
 * 5/10/15/30 min, 1/2/3/6/12 h, 1/2/7/14/30 days.
 */
export function pickTimeTickInterval(spanMs: number): number {
  if (spanMs <= 0) return HOUR;
  const target = spanMs / 6;
  const candidates = [
    5 * MINUTE,
    10 * MINUTE,
    15 * MINUTE,
    30 * MINUTE,
    HOUR,
    2 * HOUR,
    3 * HOUR,
    6 * HOUR,
    12 * HOUR,
    DAY,
    2 * DAY,
    7 * DAY,
    14 * DAY,
    30 * DAY,
  ];
  return candidates.find((c) => c >= target) ?? candidates[candidates.length - 1]!;
}

/**
 * Generate tick timestamps in [minMs, maxMs], aligned to round local-time
 * boundaries for `intervalMs`. Uses Date's local-time methods so DST
 * transitions don't drift labels off the hour.
 */
export function localAlignedTimeTicks(
  minMs: number,
  maxMs: number,
  intervalMs: number,
): number[] {
  if (maxMs <= minMs) return [];
  const ticks: number[] = [];

  if (intervalMs >= DAY) {
    const stepDays = Math.max(1, Math.round(intervalMs / DAY));
    const start = new Date(minMs);
    // Next local midnight at-or-after minMs.
    const t = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    if (t.getTime() < minMs) t.setDate(t.getDate() + 1);
    while (t.getTime() <= maxMs) {
      ticks.push(t.getTime());
      t.setDate(t.getDate() + stepDays);
    }
    return ticks;
  }

  if (intervalMs >= HOUR) {
    const stepHours = Math.max(1, Math.round(intervalMs / HOUR));
    const start = new Date(minMs);
    // Round up to the next aligned hour-of-day boundary.
    const t = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
      start.getHours(),
    );
    if (t.getTime() < minMs) t.setHours(t.getHours() + 1);
    // Snap to a multiple of stepHours within the day.
    while (t.getHours() % stepHours !== 0 && t.getTime() <= maxMs) {
      t.setHours(t.getHours() + 1);
    }
    while (t.getTime() <= maxMs) {
      ticks.push(t.getTime());
      t.setHours(t.getHours() + stepHours);
    }
    return ticks;
  }

  // Sub-hour: align to multiples of `stepMinutes`.
  const stepMinutes = Math.max(1, Math.round(intervalMs / MINUTE));
  const start = new Date(minMs);
  const t = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate(),
    start.getHours(),
    Math.ceil(start.getMinutes() / stepMinutes) * stepMinutes,
  );
  if (t.getTime() < minMs) t.setMinutes(t.getMinutes() + stepMinutes);
  while (t.getTime() <= maxMs) {
    ticks.push(t.getTime());
    t.setMinutes(t.getMinutes() + stepMinutes);
  }
  return ticks;
}

/**
 * Format a tick timestamp for display under the X-axis. Sub-day
 * intervals get `HH:mm`; day-and-up get `dd MMM` (no year - the chart
 * never spans more than ~12 months in our worst case).
 */
/**
 * Generate "nice" Y-axis ticks - round numbers that a human would
 * pick (0, 1, 2, 3 or 45,000, 45,500, 46,000, not 45,127, 45,893).
 *
 * Algorithm: find a step size from the 1-2-5 series that yields
 * roughly `targetCount` ticks, then snap min down and max up to
 * multiples of that step.
 */
export function niceYTicks(
  dataMin: number,
  dataMax: number,
  targetCount = 5,
): number[] {
  // #236 follow-up: defensive against pathological inputs that
  // a chart's right-axis recomputation could surface (NaN slMin
  // when no data passed the viewport filter; Infinity slMax from
  // a stale-cache poison; runaway step / dataMax combinations
  // that lose FP precision in the v += step accumulator). Each
  // guard below addresses a specific failure mode that has been
  // (or could realistically be) observed in production.
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return [];
  if (dataMax <= dataMin) return [dataMin];
  const rawStep = (dataMax - dataMin) / Math.max(1, targetCount - 1);
  let step = niceStep(rawStep);
  // Precision floor: when `step` is smaller than the IEEE 754
  // significand resolution at the data's magnitude, `v + step === v`
  // and the accumulator loop below never progresses. We've seen this
  // surface in the dashboard when a right-axis recompute lands with
  // sub-precision rawSpan at trillion-scale values (#236 follow-up
  // operator report: difficulty at 1m chart range, ~1e14 data, span
  // <1e-2). Floor the step to a safe multiple of Number.EPSILON ×
  // scale so v + step always moves.
  const scale = Math.max(Math.abs(dataMin), Math.abs(dataMax));
  const minStep = Math.max(scale * Number.EPSILON * 16, Number.MIN_VALUE);
  if (step < minStep) step = minStep;
  const lo = Math.floor(dataMin / step) * step;
  const hi = Math.ceil(dataMax / step) * step;
  const ticks: number[] = [];
  // Hard cap. Even with the precision floor above the loop should
  // produce at most `targetCount` plus a few extra, so anything past
  // a couple dozen ticks signals a degenerate input we'd rather
  // truncate than let into the render pipeline.
  const MAX_TICKS = 50;
  // +0.5*step guards against floating-point drift skipping the last tick
  let prev = lo;
  for (let v = lo; v <= hi + step * 0.01 && ticks.length < MAX_TICKS; v += step) {
    // Secondary anti-runaway: if v stops moving (still possible at
    // extreme magnitudes where the FP step underflows the mantissa
    // even with the floor above), bail rather than spin.
    if (ticks.length > 0 && v === prev) break;
    prev = v;
    ticks.push(Math.round(v * 1e10) / 1e10); // kill FP noise
  }
  return ticks;
}

function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let nice: number;
  if (norm <= 1.5) nice = 1;
  else if (norm <= 3.5) nice = 2;
  else if (norm <= 7.5) nice = 5;
  else nice = 10;
  return nice * mag;
}

export function formatTimeTick(
  tickMs: number,
  intervalMs: number,
  locale?: string,
): string {
  const d = new Date(tickMs);
  let opts: Intl.DateTimeFormatOptions;

  if (intervalMs >= 30 * DAY) {
    // Month-level: "Jan 2026" or "Jan '26"
    opts = { month: 'short', year: '2-digit' };
  } else if (intervalMs >= 7 * DAY) {
    // Week-level: "01 Jan"
    opts = { day: '2-digit', month: 'short' };
  } else if (intervalMs >= DAY) {
    // Day-level: "Mon 01" or "01 Jan"
    opts = { weekday: 'short', day: '2-digit' };
  } else if (intervalMs >= 6 * HOUR) {
    // Multi-day span but sub-day interval: show "Mon 12:00"
    opts = { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
  } else {
    // Intraday: "12:00"
    opts = { hour: '2-digit', minute: '2-digit', hour12: false };
  }

  return new Intl.DateTimeFormat(locale, opts).format(d);
}
