-- #149 follow-up: capture AxeOS bestDiff + bestSessionDiff per
-- tick so the Solo miners card can show a "Best Diff" column and
-- a fleet-wide max alongside hashrate / temp / power.
--
-- Format is a magnitude-suffixed string straight from AxeOS
-- (e.g. "149.53G", "225.68M", "17.78G"). Stored as TEXT to preserve
-- the operator's mental model that matches the AxeOS Swarm screen.
-- The dashboard parses the suffix at render time when it needs a
-- numeric MAX across the fleet.

ALTER TABLE solo_miner_samples ADD COLUMN best_diff_text TEXT;
ALTER TABLE solo_miner_samples ADD COLUMN best_session_diff_text TEXT;
