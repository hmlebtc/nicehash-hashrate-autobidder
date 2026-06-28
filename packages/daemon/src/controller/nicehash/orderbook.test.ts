import { describe, expect, it } from 'vitest';

import { computeMarketAnchor } from './orderbook.js';
import type { CompetingOrder } from './types.js';

describe('computeMarketAnchor', () => {
  it('returns the marginal competitor price when supply is partially contested', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0005, limit_units: 5 },
      { price_btc: 0.0004, limit_units: 5 },
    ];
    // total 12, target 4: top takes 5 (7 left), next would leave 2 (<4) -> must
    // outbid the 0.0004 order.
    const a = computeMarketAnchor(competitors, 12, 4);
    expect(a.anchor_price_btc).toBe(0.0004);
    expect(a.thin).toBe(false);
  });

  it('anchors at the cheapest rival when there is spare supply', () => {
    const competitors: CompetingOrder[] = [{ price_btc: 0.0005, limit_units: 2 }];
    const a = computeMarketAnchor(competitors, 100, 4);
    expect(a.anchor_price_btc).toBe(0.0005);
    expect(a.thin).toBe(false);
  });

  it('returns null anchor (no rivals) when supply is ample and the book is empty', () => {
    const a = computeMarketAnchor([], 100, 4);
    expect(a.anchor_price_btc).toBeNull();
    expect(a.thin).toBe(false);
  });

  it('is thin and anchors at the top when there is no deliverable supply', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0005, limit_units: 2 },
      { price_btc: 0.0004, limit_units: 2 },
    ];
    const a = computeMarketAnchor(competitors, 0, 4);
    expect(a.anchor_price_btc).toBe(0.0005);
    expect(a.thin).toBe(true);
  });

  it('is thin and anchors at the top when target exceeds total supply', () => {
    const competitors: CompetingOrder[] = [{ price_btc: 0.0005, limit_units: 2 }];
    const a = computeMarketAnchor(competitors, 3, 5);
    expect(a.anchor_price_btc).toBe(0.0005);
    expect(a.thin).toBe(true);
  });

  it('does not let an idle uncapped order (limit 0, no draw) drag the anchor up', () => {
    // Mirrors the live testnet: a BUSINESS ceiling order resting high but
    // delivering nothing must not force us to outbid it.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.1, limit_units: 0, accepted_speed_units: 0 },
      { price_btc: 0.0102, limit_units: 5 },
    ];
    const a = computeMarketAnchor(competitors, 537, 4);
    expect(a.anchor_price_btc).toBe(0.0102);
    expect(a.thin).toBe(false);
  });

  it('must outbid an uncapped competitor that IS actively drawing supply', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0006, limit_units: 0, accepted_speed_units: 8 },
      { price_btc: 0.0004, limit_units: 5 },
    ];
    const a = computeMarketAnchor(competitors, 10, 4);
    expect(a.anchor_price_btc).toBe(0.0006);
    expect(a.thin).toBe(false);
  });

  it('ignores malformed entries (non-positive price, NaN)', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0, limit_units: 5 },
      { price_btc: Number.NaN, limit_units: 5 },
      { price_btc: 0.0004, limit_units: 5 },
    ];
    const a = computeMarketAnchor(competitors, 100, 4);
    expect(a.anchor_price_btc).toBe(0.0004);
  });
});
