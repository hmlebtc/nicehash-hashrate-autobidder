-- #102: persist cumulative on-chain payout total per tick.
--
-- Earlier the dashboard could plot ocean_unpaid_sat (the sat balance
-- Ocean is *about* to pay) but lost the longitudinal view the moment
-- a payout landed on-chain - unpaid resets to ~0 and history gets
-- bumpy. paid_total_sat is the monotonically non-decreasing partner:
-- cumulative sum of reward_events.value_sat (where reorged = 0,
-- detected_at <= tick_at) at each tick. Combined with unpaid it
-- gives a clean "lifetime earnings" line across payout cliffs.
--
-- Nullable: rows older than this migration carry NULL (no source
-- data); rows on payout_source = 'none' installs also carry NULL
-- (no on-chain observer wiring) and the chart degrades gracefully.

ALTER TABLE tick_metrics ADD COLUMN paid_total_sat INTEGER;
