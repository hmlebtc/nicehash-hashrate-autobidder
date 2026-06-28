-- #129: rename the top-tier severity from ERROR to IMPORTANT.
--
-- Migration 0075 renamed LOUD -> ERROR a few sessions ago, but ERROR
-- carried the wrong framing - many of the events that fire at this
-- tier are not really errors (`unknown_bid_detected`, sustained
-- pause, deposit returned by Braiins compliance, etc). The operator
-- picked IMPORTANT as the correct framing in #129's interview:
-- the tier captures "this needs your attention" rather than "this
-- is broken." WARNING and INFO unchanged.
--
-- Idempotent UPDATE - safe on a DB that already has IMPORTANT rows
-- (a no-op) and on the post-0075 ERROR state.

UPDATE alerts SET severity = 'IMPORTANT' WHERE severity = 'ERROR';
