import { describe, expect, it } from 'vitest';

import { computeMarketAnchor } from './orderbook.js';
import type { CompetingOrder } from './types.js';

describe('computeMarketAnchor', () => {
  it('anchors at the cheapest order with miners (NiceHash purple)', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0006, limit_units: 5, rigs_count: 70 },
      { price_btc: 0.0004, limit_units: 5, rigs_count: 56453 },
      { price_btc: 0.0005, limit_units: 5, rigs_count: 1687 },
      { price_btc: 0.00039, limit_units: 5, rigs_count: 0 }, // below the marginal - no miners
    ];
    const a = computeMarketAnchor(competitors, 100, 4);
    expect(a.anchor_price_btc).toBe(0.0004);
    expect(a.thin).toBe(false);
    // exposes the ascending fill ladder (orders with miners) for the walk-up
    expect(a.filled_prices).toEqual([0.0004, 0.0005, 0.0006]);
  });

  it('anchors at the GLOBAL cheapest order with miners even when zero-miner orders sit above it', () => {
    // Real-book shape: a band of higher-priced orders with NO miners interleaved
    // above the true marginal. The anchor must be the global lowest-priced order
    // with miners (0.4482), not the cheapest within the contiguous top block.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.466, limit_units: 5, rigs_count: 21792 },
      { price_btc: 0.4526, limit_units: 5, rigs_count: 2141 },
      { price_btc: 0.4525, limit_units: 5, rigs_count: 0 }, // gap begins
      { price_btc: 0.45, limit_units: 5, rigs_count: 0 },
      { price_btc: 0.449, limit_units: 5, rigs_count: 0 },
      { price_btc: 0.4488, limit_units: 5, rigs_count: 7279 }, // filled below the gap
      { price_btc: 0.4482, limit_units: 5, rigs_count: 2463 }, // the marginal (purple)
      { price_btc: 0.448, limit_units: 5, rigs_count: 0 },
    ];
    const a = computeMarketAnchor(competitors, 16, 2);
    expect(a.anchor_price_btc).toBe(0.4482);
    expect(a.filled_prices).toEqual([0.4482, 0.4488, 0.4526, 0.466]);
  });

  it('does not walk up the book for a larger target (still anchors at the floor)', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0006, limit_units: 50, rigs_count: 4000 },
      { price_btc: 0.0004, limit_units: 5, rigs_count: 10 },
    ];
    const a = computeMarketAnchor(competitors, 100, 40);
    expect(a.anchor_price_btc).toBe(0.0004);
    expect(a.thin).toBe(false);
  });

  it('ignores an idle over-capped high-priced order (large limit, no miners)', () => {
    // The regression: an order resting at 0.1 with a huge cap but no miners must
    // NOT become the anchor. Only orders actually winning hashrate count.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.1, limit_units: 100, rigs_count: 0 },
      { price_btc: 0.0102, limit_units: 5, rigs_count: 12 },
    ];
    const a = computeMarketAnchor(competitors, 537, 1);
    expect(a.anchor_price_btc).toBe(0.0102);
    expect(a.thin).toBe(false);
  });

  it('uses rig counts over accepted-speed when both are present (acceptedSpeed under-reports)', () => {
    // The cheap order has miners but the orderbook reports its acceptedSpeed as
    // 0 (the field under-reports). rigs_count must still anchor us at the floor.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0006, limit_units: 5, rigs_count: 3, accepted_speed_units: 2 },
      { price_btc: 0.0004, limit_units: 5, rigs_count: 5000, accepted_speed_units: 0 },
    ];
    const a = computeMarketAnchor(competitors, 100, 4);
    expect(a.anchor_price_btc).toBe(0.0004);
  });

  it('falls back to accepted-speed when no rig counts are reported', () => {
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
      { price_btc: 0.0006, limit_units: 5, rigs_count: 4 },
      { price_btc: 0.0004, limit_units: 5, rigs_count: 3 },
    ];
    const a = computeMarketAnchor(competitors, 7, 10);
    expect(a.anchor_price_btc).toBe(0.0004);
    expect(a.thin).toBe(true);
  });

  it('falls back to the bottom of the book when nothing is being filled', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0005, limit_units: 2, rigs_count: 0 },
      { price_btc: 0.0004, limit_units: 2, rigs_count: 0 },
    ];
    const a = computeMarketAnchor(competitors, 100, 4);
    expect(a.anchor_price_btc).toBe(0.0004);
    expect(a.thin).toBe(false);
  });

  it('is thin when there is no deliverable supply and nothing is filled', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0005, limit_units: 2, rigs_count: 0 },
      { price_btc: 0.0004, limit_units: 2, rigs_count: 0 },
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

  it('de-dupes the marginal and jumps a wide empty gap to the next block', () => {
    // Live shape: the marginal 0.4533 is shared by many individual orders; a run of
    // 0-miner price levels sits above it; then a real block at 0.4553. The next
    // filled tier must jump the empty gap to 0.4553, not report a duplicate 0.4533.
    // (price step 0.0001; 0.4533->0.4553 = 20 steps = 19 empty levels >= 2.)
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4533, limit_units: 5, rigs_count: 30000 },
      { price_btc: 0.4533, limit_units: 5, rigs_count: 22831 }, // dup marginal
      { price_btc: 0.4553, limit_units: 5, rigs_count: 5868 }, // next block above the empty gap
      { price_btc: 0.4555, limit_units: 5, rigs_count: 14810 },
    ];
    const a = computeMarketAnchor(competitors, 17.7, 1, 0.0001);
    expect(a.anchor_price_btc).toBe(0.4533);
    expect(a.filled_prices).toEqual([0.4533, 0.4553, 0.4555]);
  });

  it('walks through a straggler hugging the marginal (< 2 empty levels) to the gap', () => {
    // A lone tier one level above the marginal (0.4534 empty between 0.4533 and
    // 0.4535 = 1 empty level) is part of the marginal's cluster, not the next tier.
    // The next filled tier is the block above the wide gap (0.4553).
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4533, limit_units: 5, rigs_count: 60000 },
      { price_btc: 0.4535, limit_units: 5, rigs_count: 8 }, // straggler, 1 empty level below
      { price_btc: 0.4553, limit_units: 5, rigs_count: 3632 }, // real block, wide gap below
    ];
    const a = computeMarketAnchor(competitors, 17.4, 1, 0.0001);
    // 0.4535 is dropped (hugs the marginal); next filled tier is 0.4553
    expect(a.filled_prices).toEqual([0.4533, 0.4553]);
  });

  it('falls back to the next distinct price on a contiguous book (no wide gap)', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.45, limit_units: 5, rigs_count: 5000 },
      { price_btc: 0.4501, limit_units: 5, rigs_count: 3000 }, // adjacent, 0 empty levels
      { price_btc: 0.4502, limit_units: 5, rigs_count: 2000 },
    ];
    const a = computeMarketAnchor(competitors, 10, 1, 0.0001);
    expect(a.filled_prices).toEqual([0.45, 0.4501, 0.4502]);
  });

  it('without a price step, de-dupes only (no gap jumping)', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4533, limit_units: 5, rigs_count: 60000 },
      { price_btc: 0.4533, limit_units: 5, rigs_count: 8 }, // dup
      { price_btc: 0.4553, limit_units: 5, rigs_count: 3632 },
    ];
    const a = computeMarketAnchor(competitors, 17.4, 1); // no step
    expect(a.filled_prices).toEqual([0.4533, 0.4553]);
  });

  it('ignores malformed entries (non-positive price, NaN)', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0, limit_units: 5, rigs_count: 5 },
      { price_btc: Number.NaN, limit_units: 5, rigs_count: 5 },
      { price_btc: 0.0004, limit_units: 5, rigs_count: 5 },
    ];
    const a = computeMarketAnchor(competitors, 100, 1);
    expect(a.anchor_price_btc).toBe(0.0004);
  });
});
