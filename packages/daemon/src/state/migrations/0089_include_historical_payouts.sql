-- Toggle for the lifetime-earnings backfill loop (#170).
-- When ON (default), the payout-observer's electrs path enumerates
-- all coinbase txs ever credited to btc_payout_address and inserts
-- them into reward_events, so the chart's paid_total_sat series
-- reflects historical Ocean payouts even after the operator sweeps
-- them off-address. When OFF, only currently-unspent outputs are
-- counted (the pre-#170 behaviour) - useful for operators with
-- per-period fresh-address discipline who don't want past activity
-- pulled in.
ALTER TABLE config
  ADD COLUMN include_historical_payouts INTEGER NOT NULL DEFAULT 1;
