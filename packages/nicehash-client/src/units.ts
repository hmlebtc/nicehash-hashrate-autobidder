/**
 * Unit helpers for the NiceHash Hash-power marketplace.
 *
 * NiceHash quotes prices as **BTC per (display unit) per day** and speed
 * limits in the algorithm's **display unit** (PH/s for SHA256). Quantities
 * cross the wire as decimal strings; these helpers parse them and convert
 * between NiceHash's BTC-denominated pricing and the sat-denominated units the
 * upstream controller was written against.
 */

export const SAT_PER_BTC = 100_000_000;

/** Parse a NiceHash decimal string to a number, with a fallback for blanks. */
export function parseDecimal(value: string | number | undefined | null, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function btcToSats(btc: number): number {
  return Math.round(btc * SAT_PER_BTC);
}

export function satsToBtc(sats: number): number {
  return sats / SAT_PER_BTC;
}

/**
 * Convert a NiceHash price (BTC per display unit per day) to sat per the same
 * display unit per day. Lets the controller reason in integer sats while the
 * wire format stays BTC.
 */
export function priceBtcToSatPerUnitDay(priceBtcPerUnitDay: number): number {
  return priceBtcPerUnitDay * SAT_PER_BTC;
}

/** Inverse of {@link priceBtcToSatPerUnitDay}. */
export function priceSatToBtcPerUnitDay(priceSatPerUnitDay: number): number {
  return priceSatPerUnitDay / SAT_PER_BTC;
}

/**
 * Spend rate of an order in BTC/day: price (BTC/unit/day) × speed (units).
 * With `limit = 0` (uncapped) the realised rate depends on delivered speed,
 * so callers should pass the actual delivered speed in that case.
 */
export function spendRateBtcPerDay(priceBtcPerUnitDay: number, speedUnits: number): number {
  return priceBtcPerUnitDay * speedUnits;
}

/**
 * How many days an order's remaining escrow will last at a given price/speed.
 * Returns Infinity when the spend rate is zero (nothing draining the order),
 * and 0 when there's no escrow left.
 */
export function orderRunwayDays(
  availableAmountBtc: number,
  priceBtcPerUnitDay: number,
  speedUnits: number,
): number {
  if (availableAmountBtc <= 0) return 0;
  const rate = spendRateBtcPerDay(priceBtcPerUnitDay, speedUnits);
  if (rate <= 0) return Infinity;
  return availableAmountBtc / rate;
}

/**
 * Round a price to a NiceHash-acceptable step. NiceHash prices carry a bounded
 * number of decimals; the controller rounds to avoid `INVALID_PRICE`
 * rejections. `decimals` defaults to 4, matching the SHA256 `priceDownStep`
 * granularity (0.0001 BTC).
 */
export function roundPrice(priceBtcPerUnitDay: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(priceBtcPerUnitDay * factor) / factor;
}

/** Format a BTC quantity to a fixed-decimals string for a request body. */
export function toBtcString(btc: number, decimals = 8): string {
  return btc.toFixed(decimals);
}
