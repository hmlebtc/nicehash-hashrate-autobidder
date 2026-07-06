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
    // Real-book shape: a band of higher-priced orders that report NO miners sits
    // above the true marginal. The anchor must still be the global lowest-priced
    // order with miners (0.4482) - the 0-miner orders must not drag it up. But
    // those 0-miner orders are ABOVE the marginal, so by NiceHash's strict
    // descending-price delivery they are themselves filled (the API just didn't
    // report their counts) and belong in the fill ladder by price position. Only
    // 0.448 (below the marginal) is excluded.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.466, limit_units: 5, rigs_count: 21792 },
      { price_btc: 0.4526, limit_units: 5, rigs_count: 2141 },
      { price_btc: 0.4525, limit_units: 5, rigs_count: 0 }, // above marginal -> filled by price
      { price_btc: 0.45, limit_units: 5, rigs_count: 0 },
      { price_btc: 0.449, limit_units: 5, rigs_count: 0 },
      { price_btc: 0.4488, limit_units: 5, rigs_count: 7279 }, // filled
      { price_btc: 0.4482, limit_units: 5, rigs_count: 2463 }, // the marginal (purple)
      { price_btc: 0.448, limit_units: 5, rigs_count: 0 }, // below marginal -> excluded
    ];
    const a = computeMarketAnchor(competitors, 16, 2);
    expect(a.anchor_price_btc).toBe(0.4482);
    expect(a.filled_prices).toEqual([0.4482, 0.4488, 0.449, 0.45, 0.4525, 0.4526, 0.466]);
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

  it('counts an order filled by miners even when its accepted-speed reads 0', () => {
    // The cheap order has miners but the orderbook reports its acceptedSpeed as
    // 0 (the field under-reports). It must still count as filled (via rigs_count)
    // and anchor us at the floor.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.0006, limit_units: 5, rigs_count: 3, accepted_speed_units: 2 },
      { price_btc: 0.0004, limit_units: 5, rigs_count: 5000, accepted_speed_units: 0 },
    ];
    const a = computeMarketAnchor(competitors, 100, 4);
    expect(a.anchor_price_btc).toBe(0.0004);
  });

  it('treats a speed-only order below the miner-bearing block as noise, not the marginal', () => {
    // The order-book API routinely reports a small residual delivered-speed on an
    // order sitting BELOW the fill line (0 miners) - a stale/boundary artifact. When
    // a pricier order reports miners, the marginal is the cheapest MINER-bearing
    // order (NiceHash's purple), not the cheaper speed-only straggler. (Reverses an
    // earlier speed-union rule that let this residual noise drag the marginal far
    // below NiceHash's purple - see the 0.4556-vs-0.4606 live case, 2026-07-06.)
    const competitors: CompetingOrder[] = [
      { price_btc: 0.46, limit_units: 5, rigs_count: 90013, accepted_speed_units: 4.6 },
      { price_btc: 0.458, limit_units: 5, rigs_count: 0, accepted_speed_units: 0.0111 }, // residual noise below
    ];
    const a = computeMarketAnchor(competitors, 18, 1);
    expect(a.anchor_price_btc).toBe(0.46); // the miner-bearing block, not the speed-only 0.458
    expect(a.filled_prices).toEqual([0.46]);
  });

  it('anchors on the miner-bearing block, ignoring residual-speed stragglers below a wide gap', () => {
    // Operator's live book (2026-07-06): NiceHash's purple marginal is the big block
    // at 0.4606 (41,850 miners). Below it sit residual-speed stragglers (0 miners,
    // tiny accepted_speed) and a wide run of empty 0-volume slots. The marginal must
    // be 0.4606 - NOT dragged down to the 0.4556 speed-straggler. With the cap below
    // the whole block, the next tier reins to the nearest real block above (0.4607).
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4556, limit_units: 0.00013852, rigs_count: 0, accepted_speed_units: 0.0073 }, // noise
      { price_btc: 0.4559, limit_units: 0.0000172, rigs_count: 0, accepted_speed_units: 0.0009 }, // noise
      { price_btc: 0.4605, limit_units: 0.00001039, rigs_count: 0, accepted_speed_units: 0.0005 }, // noise
      { price_btc: 0.4606, limit_units: 0.00459248, rigs_count: 41850, accepted_speed_units: 0.2393 }, // purple
      { price_btc: 0.4607, limit_units: 0.00389315, rigs_count: 3314, accepted_speed_units: 0.2028 },
      { price_btc: 0.462, limit_units: 0.00066185, rigs_count: 1245, accepted_speed_units: 0.0344 },
    ];
    const a = computeMarketAnchor(competitors, 13, 1, 0.0001, 0.45594);
    expect(a.anchor_price_btc).toBe(0.4606); // NiceHash purple, not the 0.4556 straggler
    expect(a.filled_prices[1]).toBe(0.4607); // nearest real block above the marginal
  });

  it('counts orders by accepted-speed when no rig counts are reported anywhere', () => {
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

  it('anchors the next tier on the real block when the API drops its miner/speed counts', () => {
    // Operator's live book (2026-07-06): marginal 0.4535 (purple, ~40k miners)
    // plus a small 0.4536 cluster, then a wide 0-count gap, then the real next
    // block at 0.4555 (the order book shows ~9,814 miners) with 0.4556/0.4557
    // above it, and a detectable 0.4560 tier further up. The order-book API
    // returned 0/undefined rigs AND speed for the whole 0.4555-0.4557 block even
    // though it is plainly filled. A rigs/speed-only ladder dropped that block and
    // jumped to the next *detectable* tier (0.4560), which - being above the cap -
    // clamped onto the cap (0.45592) and read as a phantom next tier. By price
    // position the next filled tier is the real 0.4555 block.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4535, limit_units: 5, rigs_count: 40501 }, // marginal (purple)
      { price_btc: 0.4536, limit_units: 5, rigs_count: 57 }, // marginal cluster
      { price_btc: 0.4555, limit_units: 5, rigs_count: 0, accepted_speed_units: 0 }, // real block, counts dropped
      { price_btc: 0.4556, limit_units: 5, rigs_count: 0, accepted_speed_units: 0 },
      { price_btc: 0.4557, limit_units: 5, rigs_count: 0, accepted_speed_units: 0 },
      { price_btc: 0.456, limit_units: 5, rigs_count: 174 }, // detectable tier above
    ];
    const a = computeMarketAnchor(competitors, 18, 1, 0.0001, 0.45592);
    expect(a.anchor_price_btc).toBe(0.4535);
    // next filled tier is the real 0.4555 block, not 0.4560 clamped to the cap
    expect(a.filled_prices[1]).toBe(0.4555);
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

  it('collapses a far gap-jump onto the cap (contiguous low book overshoots)', () => {
    // The overshoot: the low book is momentarily contiguous (no >= 2-empty gap)
    // from the marginal up through a wide range, so the first real gap - and the
    // block above it - sits far up the book (0.498). We never bid above the cap, so
    // the reported next filled tier must collapse onto the cap (0.4554), not chart
    // 0.498. (0.4600 -> 0.498 = 380 empty levels >= 2 => the jump lands at 0.498.)
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4533, limit_units: 5, rigs_count: 30000 }, // marginal
      { price_btc: 0.4534, limit_units: 5, rigs_count: 5000 }, // contiguous cluster...
      { price_btc: 0.4535, limit_units: 5, rigs_count: 4000 },
      { price_btc: 0.46, limit_units: 5, rigs_count: 3000 }, // ...still < 2-empty steps apart
      { price_btc: 0.498, limit_units: 5, rigs_count: 2000 }, // block above the wide gap
    ];
    const a = computeMarketAnchor(competitors, 17.7, 1, 0.0001, 0.4554);
    expect(a.anchor_price_btc).toBe(0.4533);
    // 0.498 is out of reach (> cap), so it collapses onto the cap
    expect(a.filled_prices).toEqual([0.4533, 0.4554]);
  });

  it('keeps the real next tier when the whole book is above the cap (no blank tier)', () => {
    // Live regression: the entire filled book is priced above our break-even cap
    // (marginal 0.4580 > cap 0.4559). The cap-clamp must NOT drop every tier and
    // blank filled_prices[1] - we still expose the real next filled tier so the
    // dashboard shows where the market is. (The bid is capped separately.)
    const competitors: CompetingOrder[] = [
      { price_btc: 0.458, limit_units: 5, rigs_count: 106 }, // marginal, above the cap
      { price_btc: 0.46, limit_units: 5, rigs_count: 90013 }, // next block
      { price_btc: 0.4602, limit_units: 5, rigs_count: 5695 },
    ];
    const a = computeMarketAnchor(competitors, 18.3, 1, 0.0001, 0.4559);
    expect(a.anchor_price_btc).toBe(0.458);
    // next tier is populated (0.46), not blanked by the clamp
    expect(a.filled_prices).toEqual([0.458, 0.46, 0.4602]);
  });

  it('reins the above-cap next tier to the nearest real block, not a far gap-jump straggler', () => {
    // Live regression (2026-07-06): the whole filled book sits above the cap
    // (marginal 0.4561 > cap 0.4559), so the cap-clamp is off. The low book is
    // momentarily contiguous (a run of empty 0-volume slots hugging the marginal),
    // then a wide empty gap, so the gap-jump lands on a far straggler (0.496) -
    // the "blue line shoots to 0.49xx" artifact. The bid is pinned at the cap
    // regardless (display-only), but the tile must track the nearest REAL block
    // (0.4566), not the far straggler.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4561, limit_units: 0.0002, rigs_count: 10563 }, // marginal (above cap)
      { price_btc: 0.4562, limit_units: 0, rigs_count: 0 }, // empty phantom slot
      { price_btc: 0.4563, limit_units: 0, rigs_count: 0 },
      { price_btc: 0.4564, limit_units: 0, rigs_count: 0 },
      { price_btc: 0.4565, limit_units: 0, rigs_count: 0 },
      { price_btc: 0.4566, limit_units: 0.0004, rigs_count: 606 }, // nearest real block
      { price_btc: 0.496, limit_units: 0.0001, rigs_count: 5 }, // far straggler above a wide gap
    ];
    const a = computeMarketAnchor(competitors, 18, 1, 0.0001, 0.4559);
    expect(a.anchor_price_btc).toBe(0.4561);
    // next tier is the nearest real block (0.4566), not the far 0.496 gap-jump
    expect(a.filled_prices[1]).toBe(0.4566);
  });

  it('does not clamp a next filled tier that is already below the cap', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4533, limit_units: 5, rigs_count: 30000 },
      { price_btc: 0.4553, limit_units: 5, rigs_count: 5868 }, // next block, below cap
      { price_btc: 0.4555, limit_units: 5, rigs_count: 14810 }, // above cap -> clamps to cap
    ];
    const a = computeMarketAnchor(competitors, 17.7, 1, 0.0001, 0.4554);
    // next filled tier 0.4553 is untouched; the 0.4555 straggler collapses onto the cap
    expect(a.filled_prices).toEqual([0.4533, 0.4553, 0.4554]);
  });

  it('computes the median and speed-weighted average of the filled orders', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.45, limit_units: 5, rigs_count: 10, accepted_speed_units: 1 },
      { price_btc: 0.46, limit_units: 5, rigs_count: 10, accepted_speed_units: 3 },
      { price_btc: 0.47, limit_units: 5, rigs_count: 10, accepted_speed_units: 0 }, // filled by rigs, 0 speed
    ];
    const a = computeMarketAnchor(competitors, 100, 1);
    expect(a.median_price_btc).toBeCloseTo(0.46, 9); // middle of [0.45, 0.46, 0.47]
    // speed-weighted: (0.45*1 + 0.46*3) / 4 = 0.4575 (0.47 has 0 speed, excluded)
    expect(a.avg_price_btc).toBeCloseTo(0.4575, 9);
  });

  it('falls back to the unweighted mean for avg when no filled order reports speed', () => {
    const competitors: CompetingOrder[] = [
      { price_btc: 0.45, limit_units: 5, rigs_count: 10 },
      { price_btc: 0.47, limit_units: 5, rigs_count: 10 },
    ];
    const a = computeMarketAnchor(competitors, 100, 1);
    expect(a.median_price_btc).toBeCloseTo(0.46, 9); // (0.45 + 0.47) / 2
    expect(a.avg_price_btc).toBeCloseTo(0.46, 9); // unweighted mean
  });

  it('reports null market stats when nothing is filled', () => {
    const competitors: CompetingOrder[] = [{ price_btc: 0.45, limit_units: 5, rigs_count: 0 }];
    const a = computeMarketAnchor(competitors, 100, 1);
    expect(a.median_price_btc).toBeNull();
    expect(a.avg_price_btc).toBeNull();
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
