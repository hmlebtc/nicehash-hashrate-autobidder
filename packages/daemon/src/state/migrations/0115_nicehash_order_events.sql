-- NiceHash order-mutation audit trail. Backs the History page: every CREATE /
-- EDIT_PRICE / EDIT_LIMIT / REFILL / CANCEL the controller attempts, with the
-- before/after price+limit and the reason. Records EXECUTED, DRY_RUN, and
-- FAILED outcomes (BLOCKED holds/cooldowns are not recorded - they are not
-- actions). Pruned by the configurable retention window.
CREATE TABLE IF NOT EXISTS nicehash_order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  order_id TEXT,
  action TEXT NOT NULL,              -- CREATE / EDIT_PRICE / EDIT_LIMIT / REFILL / CANCEL
  run_mode TEXT NOT NULL,
  outcome TEXT NOT NULL,             -- EXECUTED / DRY_RUN / FAILED
  price_before REAL,
  price_after REAL,
  limit_before REAL,
  limit_after REAL,
  amount_btc REAL,
  anchor_price_btc REAL,
  reason TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_nh_order_events_ts ON nicehash_order_events (ts);
