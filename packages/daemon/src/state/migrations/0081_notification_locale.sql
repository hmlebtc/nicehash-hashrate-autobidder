-- #131: localize Telegram notifications to the operator's chosen
-- language. Adds a `notification_locale` column on config; valid
-- values are 'en' (default), 'nl', 'es'. Empty string is treated as
-- 'en' by getAlertCopy().

ALTER TABLE config ADD COLUMN notification_locale TEXT NOT NULL DEFAULT 'en';
