-- #130: track Braiins on-chain deposit lifecycle so the alert evaluator
-- can fire Telegram notifications on transitions (Detected / Available /
-- Returned) without re-firing on every poll.
--
-- The autopilot polls /v1/account/transaction/on-chain on a tick cadence;
-- each row in this table is one persisted-by-Braiins deposit, keyed on
-- tx_id. The notified_* flags record whether each lifecycle event has
-- already been emitted, so the same deposit doesn't fire repeated alerts
-- if it sits in compliance for hours. When the operator's
-- notify_on_braiins_deposit toggle is OFF, the evaluator still updates
-- this table and silently flips notified_* to 1 for the current state -
-- that prevents a flood of historical alerts when the operator later
-- toggles notifications ON.
--
-- Returns are detected via a non-null `return_tx_id` (per Braiins
-- OpenAPI - "returned deposits only" - more reliable than guessing the
-- DepositStatus enum's exact integer mapping).

CREATE TABLE braiins_deposits (
  tx_id TEXT PRIMARY KEY,
  amount_sat INTEGER NOT NULL,
  address TEXT,
  -- Last seen DepositStatus enum value (0..5; exact mapping is not
  -- documented by Braiins, see services/deposit-watcher.ts for the
  -- working assumption).
  last_seen_status INTEGER NOT NULL,
  last_seen_return_tx_id TEXT,
  -- ms-since-epoch first time the daemon observed this deposit.
  first_seen_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  -- Per-event idempotency flags. 0 = not yet notified (or notification
  -- toggle was off when the state was first observed); 1 = already
  -- emitted to the alert pipeline (or silently absorbed because the
  -- toggle was off, to prevent flood-on-toggle-on).
  notified_detected INTEGER NOT NULL DEFAULT 0 CHECK (notified_detected IN (0, 1)),
  notified_available INTEGER NOT NULL DEFAULT 0 CHECK (notified_available IN (0, 1)),
  notified_returned INTEGER NOT NULL DEFAULT 0 CHECK (notified_returned IN (0, 1))
);

CREATE INDEX idx_braiins_deposits_first_seen_at ON braiins_deposits (first_seen_at_ms);

-- Operator toggle for the deposit-lifecycle Telegram notifications.
-- 0 = off (default). When 0, the table above still gets populated (so
-- toggling back on does not retroactively alert on every deposit ever
-- seen), but no Telegram POST fires.
ALTER TABLE config ADD COLUMN notify_on_braiins_deposit INTEGER NOT NULL DEFAULT 0
  CHECK (notify_on_braiins_deposit IN (0, 1));
