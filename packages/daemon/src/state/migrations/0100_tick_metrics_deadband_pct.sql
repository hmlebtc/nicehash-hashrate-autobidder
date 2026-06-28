-- #224: per-tick capture of bid_edit_deadband_pct (configurable per
-- #222) so EDIT_PRICE event tooltips can render the deadband value
-- that was in effect at the moment of the edit. The default 20 also
-- backfills every existing tick_metrics row to 20, which matches the
-- legacy hard-coded `overpay / 5` (= 20%) so historical tooltips
-- read the right number out of the box.
ALTER TABLE tick_metrics ADD COLUMN bid_edit_deadband_pct REAL NOT NULL DEFAULT 20;
