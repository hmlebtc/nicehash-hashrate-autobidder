-- NiceHash client-side ownership ledger (analogue of owned_bids).
-- Records the hash-power orders the autopilot created so it can tell its own
-- orders from strangers' on every tick. Amounts in BTC; limit in the display
-- speed unit (PH/s for SHA256ASICBOOST).
CREATE TABLE IF NOT EXISTS nicehash_orders (
  order_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_known_status TEXT,
  price_btc REAL,
  amount_btc REAL,
  limit_units REAL,
  payed_amount_btc REAL NOT NULL DEFAULT 0,
  last_price_decrease_at INTEGER,
  pool_id TEXT,
  abandoned INTEGER NOT NULL DEFAULT 0
);
