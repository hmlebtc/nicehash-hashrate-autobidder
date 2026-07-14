-- Per-tick NiceHash order-book capture (the dashboard "Order book" tab + CSV
-- export). One row per successful book read: the tier readings the smoothing
-- pipeline derived from it plus the FULL alive competitor book as a gzipped
-- JSON array (per row: id, price, limit, rigs, speed, and the row's current
-- debounce state - the state is what makes the smoothing diagnosable
-- offline). ~10-15 KB gzipped per tick at ~1000 rows, i.e. ~40 MB/day at 30s
-- ticks. Pruned by the operator-configurable book-capture retention window;
-- capture itself can be toggled off entirely.
CREATE TABLE IF NOT EXISTS nicehash_book_snapshots (
  ts INTEGER PRIMARY KEY,      -- book read time (epoch ms, = tick_at)
  marginal_price_btc REAL,     -- raw marginal (NiceHash purple), nullable
  raw_tier_btc REAL,           -- strict next tier (no smoothing), nullable
  smoothed_tier_btc REAL,      -- exposed next tier (debounce + hysteresis), nullable
  row_count INTEGER NOT NULL,  -- alive competitor rows in the blob
  book_gz BLOB NOT NULL        -- gzipped JSON: [{i,p,l,r,s,d}, ...] price-descending
);
CREATE INDEX IF NOT EXISTS idx_nh_book_snapshots_ts ON nicehash_book_snapshots (ts);
