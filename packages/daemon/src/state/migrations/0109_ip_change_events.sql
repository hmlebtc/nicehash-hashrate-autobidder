-- #250: persisted log of public-IP change events. Each row is one
-- observed rotation of the box's public IPv4 (old -> new), detected by
-- the public-IP poll's onIpChange hook (which fires only on a real
-- non-null -> different-non-null change). Persisted because the DDNS
-- in-memory snapshot resets on restart, so the dashboard can:
--   (a) show "IP last changed: A -> B, <age>" in the Dynamic DNS card,
--       distinct from the (misleading) hourly-heartbeat "last push", and
--   (b) draw a marker on the hashrate / price charts at each change
--       time, to correlate IP rotations against rejection-rate spikes
--       (a new public IP briefly breaks the Braiins -> pool connection).
CREATE TABLE ip_change_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  old_ip TEXT,
  new_ip TEXT NOT NULL
);
CREATE INDEX idx_ip_change_events_occurred_at ON ip_change_events (occurred_at);
