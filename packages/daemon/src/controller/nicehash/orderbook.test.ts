import { describe, expect, it } from 'vitest';

import { computeMarketAnchor } from './orderbook.js';
import type { CompetingOrder } from './types.js';

describe('computeMarketAnchor', () => {
  it('anchors at the cheapest order currently receiving hashrate (NiceHash purple)', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0006, limit_units: 5, accepted_speed_units: 3 },
      { price_btc: 0.0004, limit_units: 5, accepted_speed_units: 3 },
      { price_btc: 0.0005, limit_units: 5, accepted_speed_units: 3 },
    ];
    const a = computeMarketAnchor(competitors, 100, 4);
    expect(a.anchor_price_btc).toBe(0.0004);
    expect(a.thin).toBe(false);
  });

  it('does not walk up the book for a larger target (still anchors at the floor)', () => {
    // Even though the cheapest filled order only delivers 1, a target of 4 must
    // NOT drag the anchor up to a pricier order - we bid at the floor and let
    // our order limit + the deep market do the rest.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0006, limit_units: 50, accepted_speed_units: 40 },
      { price_btc: 0.0004, limit_units: 5, accepted_speed_units: 1 },
    ];
    const a = computeMarketAnchor(competitors, 100, 4);
    expect(a.anchor_price_btc).toBe(0.0004);
    expect(a.thin).toBe(false);
  });

  it('ignores an idle over-capped high-priced order (large limit, no draw)', () => {
    // The regression: an order resting at 0.1 with a huge cap but delivering
    // nothing must NOT become the anchor. Only orders actually receiving
    // hashrate count.
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

  it('flags thin when the target exceeds the whole market supply, still at the floor', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0006, limit_units: 5, accepted_speed_units: 4 },
      { price_btc: 0.0004, limit_units: 5, accepted_speed_units: 3 },
    ];
    const a = computeMarketAnchor(competitors, 7, 10);
    expect(a.anchor_price_btc).toBe(0.0004);
    expect(a.thin).toBe(true);
  });

  it('falls back to the bottom of the book when nothing is being delivered', () => {
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
    const a = computeMarketAnchor(competitors, 100, 1);
    expect(a.anchor_price_btc).toBe(0.0004);
  });
});
