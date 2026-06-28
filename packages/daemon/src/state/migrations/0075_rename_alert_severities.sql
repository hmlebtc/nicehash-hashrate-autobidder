-- Rename the alert severity column values from the old internal
-- names (LOUD / WARN) to the operator-facing names (ERROR /
-- WARNING). INFO is unchanged.
--
-- Operator stated they "absolutely detest" the LOUD nomenclature
-- and prefer the standard error / warning / info / debug ladder.
-- The schema-side and code-side names follow this migration in
-- the same commit. New code only writes ERROR / WARNING / INFO,
-- so this UPDATE is a one-shot translation of the historical rows.
--
-- "RESOLVED" is a presentation label, not a stored severity. The
-- recovery rows that already exist (severity = INFO with a
-- non-null paired_alert_id) keep their INFO severity; the
-- Telegram render and dashboard derive the [RESOLVED] label
-- from `paired_alert_id IS NOT NULL`.

UPDATE alerts SET severity = 'ERROR'   WHERE severity = 'LOUD';
UPDATE alerts SET severity = 'WARNING' WHERE severity = 'WARN';
