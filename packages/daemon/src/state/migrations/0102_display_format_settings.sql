-- #227 follow-up: promote `numberLocale` and `dateLayout` from the
-- dashboard's browser localStorage to daemon-managed config so that
-- Telegram messages (rendered by the daemon, not the browser) can
-- respect them. Without this the Display & Logging dropdowns
-- governed UI rendering only; the daemon's alert path had no way to
-- read them and fell back to en-US for every Telegram body.
--
-- Default 'system' on both columns preserves current behaviour for
-- existing installs (the daemon's `resolveDisplayLocale` helper
-- treats 'system' as "fall back to en-US" since there's no browser
-- context on the server side). Operators who actively choose a
-- locale on the Display & Logging tab get the dashboard to PATCH
-- the new value here and Telegram picks it up on the next alert.
ALTER TABLE config ADD COLUMN display_number_locale TEXT NOT NULL DEFAULT 'system';
ALTER TABLE config ADD COLUMN display_date_layout TEXT NOT NULL DEFAULT 'system';
