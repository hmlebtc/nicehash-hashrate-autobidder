#!/usr/bin/env bash
#
# Tail the daemon log. Ctrl+C to exit.
#
# Two supervision paths are supported, checked in the same order as
# status.sh:
#   1. systemd unit (production boxes - see deploy-systemd.sh). The
#      daemon's stdout/stderr go to the journal, NOT to
#      data/logs/daemon.log - that file is only written by the nohup
#      path below. Tailing the stale file on a systemd box shows
#      whatever the last `start.sh` run logged (often an old crash),
#      which looks alarmingly like the daemon is still down even when
#      systemd is happily running it. Follow the journal instead.
#   2. nohup / data/logs/daemon.log (dev machines using start.sh).
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="$ROOT/data/logs/daemon.log"
SERVICE_NAME="${HASHRATE_AUTOPILOT_SERVICE:-hashrate-autopilot}"

# --- 1. systemd-managed install -------------------------------------
# `systemctl cat` succeeds (read-only, no sudo) iff the unit is known.
if command -v systemctl >/dev/null 2>&1 && systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
  echo "==> following journal for systemd unit '$SERVICE_NAME' (Ctrl+C to exit)"
  if journalctl -u "$SERVICE_NAME" -n 50 -f 2>/dev/null; then
    exit 0
  fi
  echo "(journal not readable without sudo - retrying with sudo)"
  exec sudo journalctl -u "$SERVICE_NAME" -n 50 -f
fi

# --- 2. nohup / PID-file install ------------------------------------
if [[ ! -f "$LOG_FILE" ]]; then
  echo "No log file at $LOG_FILE yet, and no systemd unit '$SERVICE_NAME'. Start the daemon first."
  exit 1
fi

exec tail -f "$LOG_FILE"
