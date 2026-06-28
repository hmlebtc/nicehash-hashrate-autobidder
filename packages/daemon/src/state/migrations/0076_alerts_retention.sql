-- #119: per-table retention for the alerts log.
--
-- The hourly RetentionService prunes tick_metrics + decisions, but
-- alerts grows unbounded. Add a config knob defaulting to 0 (= keep
-- forever) so existing installs see no retroactive pruning. The
-- service skips the alerts prune entirely when the value is 0.
--
-- Pruning when enabled is gated on a terminal-status filter to
-- protect the retry ladder: a row in `pending` or `snoozed` is still
-- in flight (the AlertManager will retry it on the next due tick),
-- so cutting it on age would silently lose the retry. Only rows
-- whose lifecycle has resolved (`sent` / `gave_up` / `muted`) and
-- whose recovery either landed or never will are eligible.

ALTER TABLE config
  ADD COLUMN alerts_retention_days INTEGER NOT NULL DEFAULT 0;
