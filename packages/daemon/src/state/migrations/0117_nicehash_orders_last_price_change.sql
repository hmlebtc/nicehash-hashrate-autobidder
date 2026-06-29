-- Track when each owned order's price last changed (up OR down), so the
-- track-to-fill controller can wait a settle window after a bid change before
-- escalating again (giving miners time to re-point). Distinct from
-- last_price_decrease_at, which only records downward moves for the NiceHash
-- 10-minute decrease cooldown.
ALTER TABLE nicehash_orders ADD COLUMN last_price_change_at INTEGER;
