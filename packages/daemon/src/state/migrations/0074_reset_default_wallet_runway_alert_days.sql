-- #116 follow-up: the wallet_runway alert was originally introduced
-- with `wallet_runway_alert_days DEFAULT 3`. Operators upgrading from
-- v1.5.4 (the release that first wired the alert end-to-end) and
-- earlier therefore have a row carrying the old default of 3 even
-- though the schema's effective default is now 0 (off-by-default
-- per operator's explicit stated preference).
--
-- This migration flips that one specific value: any row still on
-- the prior default of exactly 3 is reset to 0 so the alert is
-- silent after upgrade. Operators who deliberately set 1, 2, 4,
-- 5+, etc. keep their setting - those values survive untouched.
--
-- Empirical motivation: a fresh install funded an order before the
-- wallet was topped up, the available_balance_sat read 0, and the
-- LOUD runway alert fired in Telegram on the very first tick.
-- The matching code-path fix (use total_balance_sat, not available_)
-- ships in the same commit; this migration is the data-side
-- guarantee that the operator does not have to manually toggle the
-- threshold to 0 to escape the unwanted alert after upgrade.

UPDATE config
  SET wallet_runway_alert_days = 0
  WHERE wallet_runway_alert_days = 3;
