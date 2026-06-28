-- Track when a deposit first reached DEPOSIT_STATUS_CREDITED so the
-- chart can position the marker at the balance-step moment, not at
-- the Bitcoin transaction time.  Nullable because existing rows and
-- not-yet-credited deposits won't have it.
ALTER TABLE braiins_deposits ADD COLUMN credited_at_ms INTEGER;
