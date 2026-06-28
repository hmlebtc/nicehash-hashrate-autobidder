-- Store the real transaction timestamp from the Braiins API instead of
-- relying solely on first_seen_at_ms (daemon discovery time).  Nullable
-- because existing rows won't have it until the next poll backfills.
ALTER TABLE braiins_deposits ADD COLUMN tx_timestamp_ms INTEGER;
