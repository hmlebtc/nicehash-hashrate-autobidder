-- #222: configurable EDIT_PRICE deadband (replaces hard-coded overpay/5)
-- and operator-acceptable Braiins fee ceiling for the mutation gate.
-- Default 20 reproduces the legacy hard-coded `overpay / 5` (1/5 = 20%).
-- Default 0 on max_acceptable_fee_pct halts on any non-zero fee_rate_pct,
-- matching the existing beta_exit alert semantics.
ALTER TABLE config ADD COLUMN bid_edit_deadband_pct REAL NOT NULL DEFAULT 20;
ALTER TABLE config ADD COLUMN max_acceptable_fee_pct REAL NOT NULL DEFAULT 0;
