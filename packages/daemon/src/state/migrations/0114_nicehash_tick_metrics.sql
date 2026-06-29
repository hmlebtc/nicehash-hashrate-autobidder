-- Per-tick NiceHash metrics time series. Backs the dashboard hashrate/price
-- charts, the summary tiles (uptime, averages, cost-vs-hashprice), and the
-- profit & loss panel. One row per controller tick (~60s cadence). Pruned by
-- the configurable retention window on a schedule.
CREATE TABLE IF NOT EXISTS nicehash_tick_metrics (
  ts INTEGER PRIMARY KEY,            -- tick_at (epoch ms)
  run_mode TEXT NOT NULL,            -- DRY_RUN / LIVE / PAUSED
  api_ok INTEGER NOT NULL,          -- 1 when the order book read succeeded
  balance_btc REAL,                  -- available balance (nullable)
  anchor_price_btc REAL,             -- market marginal/anchor price (nullable)
  our_price_btc REAL,                -- our active order price (nullable)
  total_speed_units REAL,            -- total market supply (display units)
  accepted_speed_units REAL,         -- delivered to our order(s) (display units)
  limit_units REAL,                  -- our order limit(s) (display units)
  target_units REAL,                 -- configured target speed
  floor_units REAL,                  -- configured minimum floor
  available_amount_btc REAL,         -- unspent escrow across our order(s) (BTC)
  spend_rate_btc_day REAL,           -- current burn = price x accepted (BTC/day)
  hashprice_btc_per_unit_day REAL,   -- network hashprice estimate (nullable)
  owned_count INTEGER NOT NULL,
  unknown_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nh_tick_metrics_ts ON nicehash_tick_metrics (ts);
