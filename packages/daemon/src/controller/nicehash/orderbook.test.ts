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
    // The whole book above the marginal is contiguously miner-bearing, so the
    // top run reaches the marginal itself: there is NO separate next tier - a
    // bid at the marginal wins (strict contiguous-top rule).
    expect(a.filled_prices).toEqual([0.0004]);
  });

  it('anchors at the GLOBAL cheapest order with miners and the ladder is miner-bearing only', () => {
    // Real-book shape: a band of 0-miner orders sits above the true marginal. The
    // anchor must be the global lowest-priced order WITH miners (0.4482) - the
    // 0-miner orders must not drag it up. Those 0-miner orders are also NOT filled
    // tiers (miners is the reliable signal; a resting order with 0 miners isn't
    // winning hashrate), so the ladder is the miner-bearing prices only.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.466, limit_units: 5, rigs_count: 21792 },
      { price_btc: 0.4526, limit_units: 5, rigs_count: 2141 },
      { price_btc: 0.4525, limit_units: 5, rigs_count: 0 }, // 0 miners -> not a filled tier
      { price_btc: 0.45, limit_units: 5, rigs_count: 0 },
      { price_btc: 0.449, limit_units: 5, rigs_count: 0 },
      { price_btc: 0.4488, limit_units: 5, rigs_count: 7279 }, // filled
      { price_btc: 0.4482, limit_units: 5, rigs_count: 2463 }, // the marginal (purple)
      { price_btc: 0.448, limit_units: 5, rigs_count: 0 }, // below marginal -> excluded
    ];
    const a = computeMarketAnchor(competitors, 16, 2);
    expect(a.anchor_price_btc).toBe(0.4482);
    // Strict rule: the contiguous miner-bearing top is 0.466 down to 0.4526
    // (the 0.4525 zero-miner row ends it). 0.4488 is a real fill but sits
    // below the zero-miner wall - not part of the clearing block.
    expect(a.filled_prices).toEqual([0.4482, 0.4526, 0.466]);
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
    const a = computeMarketAnchor(competitors, 13, 1);
    expect(a.anchor_price_btc).toBe(0.4606); // NiceHash purple, not the 0.4556 straggler
    // 0.462 -> 0.4607 -> 0.4606 (the marginal) are contiguously miner-bearing:
    // the top run reaches the marginal, so there is no separate next tier.
    expect(a.filled_prices).toEqual([0.4606]);
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

  it('a zero-miner wall below the top block pushes the next tier to the block above it', () => {
    // marginal 0.4535 (purple) with a 0.4536 tier right above it, then rows at
    // 0.4555-0.4557 whose per-order miners the API dropped to 0, then 0.456.
    // Strict rule: the contiguous miner-bearing top is just {0.456} (the
    // 0.4557 zero-miner row ends it) - the next tier is 0.456, and the
    // 0.4536 fill below the wall is not part of the clearing block.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4535, limit_units: 5, rigs_count: 40501 }, // marginal (purple)
      { price_btc: 0.4536, limit_units: 5, rigs_count: 57 },
      { price_btc: 0.4555, limit_units: 5, rigs_count: 0, accepted_speed_units: 0 }, // 0 miners
      { price_btc: 0.4556, limit_units: 5, rigs_count: 0, accepted_speed_units: 0 },
      { price_btc: 0.4557, limit_units: 5, rigs_count: 0, accepted_speed_units: 0 },
      { price_btc: 0.456, limit_units: 5, rigs_count: 174 },
    ];
    const a = computeMarketAnchor(competitors, 18, 1);
    expect(a.anchor_price_btc).toBe(0.4535);
    expect(a.filled_prices[1]).toBe(0.456);
    expect(a.filled_prices).toEqual([0.4535, 0.456]);
  });

  it('a book contiguously filled down to the marginal has NO separate next tier', () => {
    // Live book (2026-07-06): marginal 0.4556 (purple, 57k miners), then 0.4557,
    // 0.4559, 0.456, 0.4561, 0.4562 - every row miner-bearing. The contiguous
    // top run reaches the marginal itself: the market genuinely clears at the
    // marginal, so a bid there wins and next tier is null ([marginal] ladder).
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4556, limit_units: 0.0187, rigs_count: 57182 }, // marginal (purple)
      { price_btc: 0.4557, limit_units: 0.00001, rigs_count: 16 },
      { price_btc: 0.4559, limit_units: 0.0019, rigs_count: 306 },
      { price_btc: 0.456, limit_units: 0.001, rigs_count: 32 },
      { price_btc: 0.4561, limit_units: 0.0004, rigs_count: 99 },
      { price_btc: 0.4562, limit_units: 0.00006, rigs_count: 53 },
    ];
    const a = computeMarketAnchor(competitors, 14, 1);
    expect(a.anchor_price_btc).toBe(0.4556);
    expect(a.filled_prices).toEqual([0.4556]);
  });

  it('skips a lone miner straggler and anchors the next tier on the contiguous top block', () => {
    // Operator's live book (2026-07-06): marginal 0.4545 (purple, 61k miners). Above it
    // sits 0.4554 - a lone miner tier under a zero-miner row - then the block
    // 0.4565/0.4566/0.4567. Strict rule: the contiguous miner-bearing top is
    // 0.4567 down to 0.4565 (the 0.4562 zero-miner row ends it), so the next
    // tier is 0.4565 - the 0.4554 island below the wall is not the block.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4545, limit_units: 0.0052, rigs_count: 61103 }, // marginal (purple)
      { price_btc: 0.4554, limit_units: 0.00003, rigs_count: 79, accepted_speed_units: 0.0018 }, // lone straggler
      { price_btc: 0.4562, limit_units: 0.00002, rigs_count: 0, accepted_speed_units: 0.0001 }, // speed, no miners
      { price_btc: 0.4565, limit_units: 0.0194, rigs_count: 3940, accepted_speed_units: 1.02 }, // block start
      { price_btc: 0.4566, limit_units: 0.0001, rigs_count: 451 },
      { price_btc: 0.4567, limit_units: 0.0055, rigs_count: 10451 },
    ];
    const a = computeMarketAnchor(competitors, 14, 1);
    expect(a.anchor_price_btc).toBe(0.4545);
    expect(a.filled_prices[1]).toBe(0.4565); // 0.4554 island below the wall skipped
  });

  it('keeps a miner tier that starts a block even with a small gap above the marginal', () => {
    // Operator's earlier book: marginal 0.4545, a 0-miner run, then a solid block whose
    // start 0.4568 (8951 miners) has 0.457 (24 miners) two ticks above it. 0.4568 is not
    // a lone straggler (a miner tier sits close above), so it is the next filled tier.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4545, limit_units: 0.0052, rigs_count: 49478 }, // marginal (purple)
      { price_btc: 0.4562, limit_units: 0.00002, rigs_count: 0, accepted_speed_units: 0.001 }, // no miners
      { price_btc: 0.4565, limit_units: 0.021, rigs_count: 0, accepted_speed_units: 1.1 }, // speed, no miners
      { price_btc: 0.4568, limit_units: 0.0057, rigs_count: 8951 }, // block start
      { price_btc: 0.457, limit_units: 0.00002, rigs_count: 24 },
      { price_btc: 0.4571, limit_units: 0.0046, rigs_count: 6545 },
    ];
    const a = computeMarketAnchor(competitors, 14, 1);
    expect(a.anchor_price_btc).toBe(0.4545);
    expect(a.filled_prices[1]).toBe(0.4568); // bottom of the contiguous top, not the 0-miner rows
  });

  it('a fully miner-bearing book (dup marginal rows included) has no next tier', () => {
    // Every row carries miners, so the contiguous top run reaches the marginal
    // (0.4533, shared by two rows - the de-dupe must not fabricate a tier).
    // Market clears at the marginal: next tier null, ladder = [marginal].
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4533, limit_units: 5, rigs_count: 30000 },
      { price_btc: 0.4533, limit_units: 5, rigs_count: 22831 }, // dup marginal
      { price_btc: 0.4553, limit_units: 5, rigs_count: 5868 },
      { price_btc: 0.4555, limit_units: 5, rigs_count: 14810 },
    ];
    const a = computeMarketAnchor(competitors, 17.7, 1);
    expect(a.anchor_price_btc).toBe(0.4533);
    expect(a.filled_prices).toEqual([0.4533]);
  });

  it('reads the top block faithfully however far above any cap it sits (no clamp)', () => {
    // Marginal cluster low, a zero-miner row at 0.454, then the clearing block
    // at 0.46/0.498. The tier is the block bottom (0.46) as-is - never clamped
    // to a cap (the bid is capped separately in decide()).
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4533, limit_units: 5, rigs_count: 30000 }, // marginal
      { price_btc: 0.454, limit_units: 5, rigs_count: 0 }, // zero-miner wall
      { price_btc: 0.46, limit_units: 5, rigs_count: 3000 },
      { price_btc: 0.498, limit_units: 5, rigs_count: 2000 },
    ];
    const a = computeMarketAnchor(competitors, 17.7, 1);
    expect(a.anchor_price_btc).toBe(0.4533);
    expect(a.filled_prices).toEqual([0.4533, 0.46, 0.498]);
  });

  it('keeps the real next tier when the whole book is above the cap (no blank tier)', () => {
    // Live regression: the entire filled book is priced above our break-even
    // cap. The tier must still be populated so the dashboard shows where the
    // market is - the bid is capped separately.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.458, limit_units: 5, rigs_count: 106 }, // marginal
      { price_btc: 0.4599, limit_units: 5, rigs_count: 0 }, // zero-miner row below the block
      { price_btc: 0.46, limit_units: 5, rigs_count: 90013 }, // block
      { price_btc: 0.4602, limit_units: 5, rigs_count: 5695 },
    ];
    const a = computeMarketAnchor(competitors, 18.3, 1);
    expect(a.anchor_price_btc).toBe(0.458);
    expect(a.filled_prices).toEqual([0.458, 0.46, 0.4602]);
  });

  it('anchors the next tier on the contiguous block above phantom 0-miner slots', () => {
    // Phantom 0-miner slots hug the marginal, then a miner block 0.4566/0.4567.
    // The contiguous top run is {0.4567, 0.4566}; the tier is the block bottom.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.4561, limit_units: 0.0002, rigs_count: 10563 }, // marginal
      { price_btc: 0.4562, limit_units: 0, rigs_count: 0 }, // phantom
      { price_btc: 0.4563, limit_units: 0, rigs_count: 0 },
      { price_btc: 0.4566, limit_units: 0.0004, rigs_count: 606 }, // block bottom
      { price_btc: 0.4567, limit_units: 0.0004, rigs_count: 720 },
    ];
    const a = computeMarketAnchor(competitors, 18, 1);
    expect(a.anchor_price_btc).toBe(0.4561);
    expect(a.filled_prices[1]).toBe(0.4566);
  });

  // ---- Strict contiguous-top-of-book rule: the operator's 2026-07-13 live
  // book. Miner fills exist at 0.4788 (marginal), 0.4791 (an island under a
  // wall of zero-miner rows) and 0.4808 (another island), but the block the
  // market actually clears into is the contiguous run 0.4850..0.4820. The old
  // gap heuristic tracked the 0.4791 island; the next tier must be 0.4820.
  const operatorBook = (): CompetingOrder[] => [
    { price_btc: 0.485, limit_units: 5, rigs_count: 49 },
    { price_btc: 0.4846, limit_units: 5, rigs_count: 105 },
    { price_btc: 0.4842, limit_units: 5, rigs_count: 4235 },
    { price_btc: 0.4838, limit_units: 5, rigs_count: 1135 },
    { price_btc: 0.4836, limit_units: 5, rigs_count: 105 },
    { price_btc: 0.4831, limit_units: 5, rigs_count: 70 },
    { price_btc: 0.4828, limit_units: 5, rigs_count: 80 },
    { price_btc: 0.4827, limit_units: 5, rigs_count: 63 },
    { price_btc: 0.4822, limit_units: 5, rigs_count: 61 },
    { price_btc: 0.4821, limit_units: 5, rigs_count: 2574 },
    { price_btc: 0.482, limit_units: 5, rigs_count: 46648 },
    { price_btc: 0.4813, limit_units: 5, rigs_count: 0 }, // zero-miner wall starts
    { price_btc: 0.4808, limit_units: 5, rigs_count: 2 }, // island
    { price_btc: 0.4801, limit_units: 5, rigs_count: 0 },
    { price_btc: 0.4797, limit_units: 5, rigs_count: 0 },
    { price_btc: 0.4795, limit_units: 5, rigs_count: 0 },
    { price_btc: 0.4792, limit_units: 5, rigs_count: 0 },
    { price_btc: 0.4791, limit_units: 5, rigs_count: 3785 }, // island (the old tier)
    { price_btc: 0.479, limit_units: 5, rigs_count: 0 },
    { price_btc: 0.4788, limit_units: 5, rigs_count: 7835 }, // marginal (purple)
    { price_btc: 0.4787, limit_units: 5, rigs_count: 0 },
    { price_btc: 0.4785, limit_units: 5, rigs_count: 0 },
  ];

  it("operator's live book: next tier = bottom of the contiguously filled top (0.4820), not the 0.4791 island", () => {
    const a = computeMarketAnchor(operatorBook(), 20, 1);
    expect(a.anchor_price_btc).toBe(0.4788);
    expect(a.filled_prices[1]).toBe(0.482);
  });

  it('zero-miner noise priced ABOVE the highest miner-bearing row is ignored', () => {
    // Price priority makes a genuinely-unfilled order above a filled one
    // impossible - a 0.4900:0 row on top is dead noise, not a run-breaker.
    const a = computeMarketAnchor(
      [{ price_btc: 0.49, limit_units: 5, rigs_count: 0 }, ...operatorBook()],
      20,
      1,
    );
    expect(a.anchor_price_btc).toBe(0.4788);
    expect(a.filled_prices[1]).toBe(0.482);
  });

  it('a zero-miner row INSIDE the block climbs the tier to the run above it (strict)', () => {
    // Documented v0.6.38 trade-off: the API under-reports miners on genuinely
    // filled rows, so a 0.4830:0 row inside the block ends the run at 0.4831 -
    // the cap bounds the worst case.
    const a = computeMarketAnchor(
      [{ price_btc: 0.483, limit_units: 5, rigs_count: 0 }, ...operatorBook()],
      20,
      1,
    );
    expect(a.anchor_price_btc).toBe(0.4788);
    expect(a.filled_prices[1]).toBe(0.4831);
  });

  it('no contiguous tier above the marginal -> null (ladder = [marginal])', () => {
    // The highest miner-bearing row IS the marginal (everything above it is
    // zero-miner): the run bottoms out at the marginal, so there is no next
    // tier to anchor above it.
    const competitors: CompetingOrder[] = [
      { price_btc: 0.48, limit_units: 5, rigs_count: 0 },
      { price_btc: 0.479, limit_units: 5, rigs_count: 0 },
      { price_btc: 0.4788, limit_units: 5, rigs_count: 7835 }, // marginal & highest fill
    ];
    const a = computeMarketAnchor(competitors, 20, 1);
    expect(a.anchor_price_btc).toBe(0.4788);
    expect(a.filled_prices).toEqual([0.4788]);
  });

  it('row-level strictness: a zero-miner row sharing a price with a miner-bearing row taints the level', () => {
    // 0.4842 has both a miner-bearing and a zero-miner ROW: the level is not
    // provably consuming, so the run ends above it - the tier is 0.4846.
    const a = computeMarketAnchor(
      [{ price_btc: 0.4842, limit_units: 5, rigs_count: 0 }, ...operatorBook()],
      20,
      1,
    );
    expect(a.anchor_price_btc).toBe(0.4788);
    expect(a.filled_prices[1]).toBe(0.4846);
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
