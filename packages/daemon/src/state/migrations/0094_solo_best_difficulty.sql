-- #204: fleet-wide best difficulty tracking for solo miners.
--
-- 1. Add a parsed numeric column to solo_miner_samples so fleet
--    aggregation queries can MAX() without parsing text at query time.
-- 2. Create an events table logging each record-breaking moment
--    (feeds trophy chart markers and Telegram notifications).
-- 3. Add the all-time high-water mark to runtime_state for fast
--    single-row access without scanning the events table.

ALTER TABLE solo_miner_samples ADD COLUMN best_diff_numeric REAL;

ALTER TABLE runtime_state ADD COLUMN solo_best_difficulty_all_time REAL;

CREATE TABLE IF NOT EXISTS solo_best_difficulty_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at INTEGER NOT NULL,
  difficulty REAL NOT NULL,
  previous_difficulty REAL,
  device_label TEXT NOT NULL,
  device_ip TEXT NOT NULL
);

CREATE INDEX idx_solo_best_diff_events_recorded_at
  ON solo_best_difficulty_events(recorded_at);
