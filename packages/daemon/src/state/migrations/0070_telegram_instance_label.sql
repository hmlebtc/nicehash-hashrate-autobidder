-- Optional source-identifier label for Telegram messages. When set,
-- the TelegramSink prefixes every message body with `[<label>] ` so
-- an operator running multiple daemons against the same chat can
-- tell which instance fired which alert. Empty string = no prefix.
--
-- Motivation: operator was getting Telegram messages they couldn't
-- match to entries in the connected daemon's Alerts page, and
-- suspected (correctly) that a second instance running with the
-- same bot/chat credentials was the source. Without per-instance
-- labelling there's no way to disambiguate from the receive side.

ALTER TABLE config ADD COLUMN telegram_instance_label TEXT NOT NULL DEFAULT '';
