-- Fix deposits that got credited_at_ms set to "now" during the first
-- poll after migration 0097.  For deposits that were already CREDITED,
-- tx_timestamp_ms is a much better approximation of when they were
-- credited than the daemon's restart time.
UPDATE braiins_deposits
  SET credited_at_ms = tx_timestamp_ms
  WHERE credited_at_ms IS NOT NULL
    AND tx_timestamp_ms IS NOT NULL
    AND credited_at_ms > tx_timestamp_ms + 86400000;
