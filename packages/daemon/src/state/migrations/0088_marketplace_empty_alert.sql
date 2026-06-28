-- #167: configurable threshold for the marketplace_empty alert.
-- Counts consecutive minutes the Braiins orderbook had no hashrate
-- available for our target AND delivery was ~0 before the Telegram
-- alert fires (and the Status-page banner renders). Two-condition
-- gate keeps micro-gaps in the orderbook from tripping a false alert.
ALTER TABLE config
  ADD COLUMN marketplace_empty_alert_after_minutes INTEGER NOT NULL DEFAULT 5;
