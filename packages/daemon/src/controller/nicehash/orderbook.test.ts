import { describe, expect, it } from 'vitest';

import { computeMarketAnchor } from './orderbook.js';
import type { CompetingOrder } from './types.js';

describe('computeMarketAnchor', () => {
  it('anchors at the cheapest filled order (NiceHash purple) for a tiny target', () => {
    // Two orders are being filled; a small target only needs to displace the
    // cheapest of them -> anchor is that marginal price.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0005, limit_units: 5, accepted_speed_units: 5 },
      { price_btc: 0.0004, limit_units: 5, accepted_speed_units: 5 },
    ];
    const a = computeMarketAnchor(competitors, 12, 0.001);
    expect(a.anchor_price_btc).toBe(0.0004);
    expect(a.thin).toBe(false);
  });

  it('walks filled orders cheapest -> dearest until the target is freed', () => {
    // Cheapest filled delivers 3 (< target 4); the next frees 3 more (>= 4),
    // so we must outbid the 0.0005 order.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0005, limit_units: 5, accepted_speed_units: 3 },
      { price_btc: 0.0004, limit_units: 5, accepted_speed_units: 3 },
    ];
    const a = computeMarketAnchor(competitors, 12, 4);
    expect(a.anchor_price_btc).toBe(0.0005);
    expect(a.thin).toBe(false);
  });

  it('displaces only the cheapest filled order, not the dearest, when that suffices', () => {
    // A pricier order is drawing 8, a cheaper one is drawing 5. Target 4 is
    // covered by displacing just the cheaper one -> anchor is the cheaper price,
    // not the expensive competitor at the top.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0006, limit_units: 0, accepted_speed_units: 8 },
      { price_btc: 0.0004, limit_units: 5, accepted_speed_units: 5 },
    ];
    const a = computeMarketAnchor(competitors, 13, 4);
    expect(a.anchor_price_btc).toBe(0.0004);
    expect(a.thin).toBe(false);
  });

  it('ignores an idle over-capped high-priced order (large limit, no draw)', () => {
    // The regression: an order resting at 0.1 with a huge cap but delivering
    // nothing must NOT drag the anchor to the top of the book. Only the order
    // actually receiving hashrate (0.0102) counts.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.1, limit_units: 100, accepted_speed_units: 0 },
      { price_btc: 0.0102, limit_units: 5, accepted_speed_units: 4 },
    ];
    const a = computeMarketAnchor(competitors, 537, 1);
    expect(a.anchor_price_btc).toBe(0.0102);
    expect(a.thin).toBe(false);
  });

  it('ignores an idle uncapped high-priced order (limit 0, no draw)', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.1, limit_units: 0, accepted_speed_units: 0 },
      { price_btc: 0.0102, limit_units: 5, accepted_speed_units: 5 },
    ];
    const a = computeMarketAnchor(competitors, 537, 4);
    expect(a.anchor_price_btc).toBe(0.0102);
    expect(a.thin).toBe(false);
  });

  it('is thin and anchors at the dearest filled order when the target exceeds all delivery', () => {
    // Filled delivery sums to 7 but we want 10 -> can't win it all; outbid the
    // dearest filled order to grab what supply allows.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0006, limit_units: 5, accepted_speed_units: 4 },
      { price_btc: 0.0004, limit_units: 5, accepted_speed_units: 3 },
    ];
    const a = computeMarketAnchor(competitors, 7, 10);
    expect(a.anchor_price_btc).toBe(0.0006);
    expect(a.thin).toBe(true);
  });

  it('falls back to the bottom of the book when nothing is being delivered', () => {
    // No competitor is drawing supply (idle/empty market) -> no live
    // competition; sit at the cheapest price with spare supply available.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0005, limit_units: 2, accepted_speed_units: 0 },
      { price_btc: 0.0004, limit_units: 2, accepted_speed_units: 0 },
    ];
    const a = computeMarketAnchor(competitors, 100, 4);
    expect(a.anchor_price_btc).toBe(0.0004);
    expect(a.thin).toBe(false);
  });

  it('is thin when there is no deliverable supply and nothing is filled', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0005, limit_units: 2, accepted_speed_units: 0 },
      { price_btc: 0.0004, limit_units: 2, accepted_speed_units: 0 },
    ];
    const a = computeMarketAnchor(competitors, 0, 4);
    expect(a.anchor_price_btc).toBe(0.0004);
    expect(a.thin).toBe(true);
  });

  it('returns a null anchor when the book is empty', () => {
    const a = computeMarketAnchor([], 100, 4);
    expect(a.anchor_price_btc).toBeNull();
    expect(a.thin).toBe(false);
  });

  it('ignores malformed entries (non-positive price, NaN)', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0, limit_units: 5, accepted_speed_units: 5 },
      { price_btc: Number.NaN, limit_units: 5, accepted_speed_units: 5 },
      { price_btc: 0.0004, limit_units: 5, accepted_speed_units: 5 },
    ];
    const a = computeMarketAnchor(competitors, 100, 0.001);
    expect(a.anchor_price_btc).toBe(0.0004);
  });
});
