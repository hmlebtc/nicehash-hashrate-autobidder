-- Operator-editable NiceHash settings, persisted so they can be changed from
-- the dashboard instead of the compose env. Single row (id = 1) holding a JSON
-- blob of the settings (credentials + connection + strategy). Seeded from env
-- on first boot.
CREATE TABLE IF NOT EXISTS nicehash_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
