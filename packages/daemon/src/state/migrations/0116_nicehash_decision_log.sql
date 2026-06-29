-- Per-tick decision + error log for debugging the bot. One row per controller
-- tick (what it decided and why, including holds / blocks / pauses) plus rows
-- for tick-level errors. Surfaced on the dashboard Logs tab and pruned by the
-- operator-configurable log-retention window.
CREATE TABLE IF NOT EXISTS nicehash_decision_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,            -- info / warn / error
  kind TEXT NOT NULL,            -- TICK / ERROR
  run_mode TEXT,
  message TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_nh_decision_log_ts ON nicehash_decision_log (ts);
