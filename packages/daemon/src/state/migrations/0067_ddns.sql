-- #111: daemon-managed Dynamic DNS updater.
--
-- Lets the operator configure a DDNS provider (currently only `noip`)
-- in the dashboard so the daemon itself keeps the public-facing
-- hostname's A record in sync with the box's current public IP, on
-- a 5-minute cadence. Replaces the router-firmware-based DDNS client
-- that has proven flaky in practice (cf. recurring "Stratum DOWN"
-- false-alarms when mynetgear.com goes down or the router fails to
-- push an updated lease).
--
-- All four columns are TEXT with empty-string defaults so existing
-- installs upgrade cleanly. `ddns_provider = ''` means "disabled" -
-- the updater service short-circuits and does nothing.

ALTER TABLE config ADD COLUMN ddns_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN ddns_hostname TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN ddns_username TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN ddns_credential TEXT NOT NULL DEFAULT '';
