-- #243 follow-up: scrub orphan May 5-6 share-counter data left behind
-- by the reverted #90 (bid acceptance ratio) infrastructure.
--
-- Forensics (recovered from a copy of the canary box's state.db on 2026-06-02):
--   * 2026-05-05 18:34 — migration 0059_tick_metrics_acceptance.sql added
--     primary_bid_shares_{purchased,accepted,rejected}_m columns and the
--     daemon began polling Braiins's /spot/bid/delivery/{order_id} into them.
--   * 2026-05-08 — commit e98ec5b reverted #90 (+ the unrelated #91
--     Datum-reject work). The migration FILE was removed from source
--     but `ALTER TABLE … DROP COLUMN` was not run, so on existing
--     databases the columns and their captured values remained.
--   * 2026-05-08 → 2026-06-02 — no write path. Columns stayed in the
--     schema; all new rows had NULL for them.
--   * 2026-06-02 — 0106_tick_metrics_braiins_shares.sql in this release
--     tried to re-add the same three columns. The idempotent migration
--     runner (added in the same release) caught `duplicate column name`,
--     stamped 0106 as applied, and continued. The #243 polling code began
--     writing values for the current bid.
--
-- Effect on any database with that history: two real-data "islands"
-- (May 5-6 from #90, and 2026-06-02+ from #243) separated by ~28 days
-- of NULL rows. Treating the two islands as one cumulative counter
-- series (naive first-vs-last) gives a meaningless "rejection rate
-- over All" because the counters belong to different bids.
--
-- Cutoff = 2026-05-08 00:00:00 UTC = 1778198400000 ms. Anything older
-- predates #90's revert and is orphan by definition. No-op for clean
-- installs (the columns physically didn't exist for users who never
-- had #90, so no rows have non-null values before the cutoff).

UPDATE tick_metrics
SET primary_bid_shares_purchased_m = NULL,
    primary_bid_shares_accepted_m = NULL,
    primary_bid_shares_rejected_m = NULL
WHERE tick_at < 1778198400000
  AND (primary_bid_shares_purchased_m IS NOT NULL
       OR primary_bid_shares_accepted_m IS NOT NULL
       OR primary_bid_shares_rejected_m IS NOT NULL);
