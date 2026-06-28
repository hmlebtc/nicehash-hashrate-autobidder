-- #108: persist Ocean pool blocks so the historical pool-luck plot
-- works on a fresh install (and every install after a long downtime).
--
-- Before this change `pool_blocks_24h_count` / `pool_blocks_7d_count`
-- were per-tick snapshots derived from Ocean's recent_blocks list at
-- the time of the tick. With nothing recorded before the daemon's
-- first tick, the historical luck line was empty for the entire 7-day
-- pre-install window, even though Ocean's /v1/blocks endpoint was
-- happy to serve up the past blocks the whole time.
--
-- This table is the persistent ground truth: every pool block the
-- daemon has ever seen, keyed by height (Ocean blocks are uniquely
-- identified by their network height). The daemon upserts on every
-- per-tick Ocean fetch, and a startup backfill pages through
-- /v1/blocks to fill the recent week (or as much as Ocean returns).

CREATE TABLE pool_blocks (
  height INTEGER PRIMARY KEY,
  block_hash TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,      -- ms since epoch (UTC)
  total_reward_sat INTEGER NOT NULL,
  subsidy_sat INTEGER NOT NULL,
  fees_sat INTEGER NOT NULL,
  worker TEXT,
  username TEXT,
  observed_at_ms INTEGER NOT NULL     -- when the daemon first saw it
);

CREATE INDEX idx_pool_blocks_timestamp_ms ON pool_blocks (timestamp_ms);
