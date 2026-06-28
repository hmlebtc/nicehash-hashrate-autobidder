#!/usr/bin/env bash
#
# Print current daemon status. Exits 0 if running, 1 otherwise.
#
# Two supervision paths are supported, checked in this order:
#   1. systemd unit (production boxes - see deploy-systemd.sh). This is
#      authoritative when the unit exists; the PID file below is NOT
#      written by the systemd path, so checking it on a systemd box
#      gives a false "not running" (the bug this ordering fixes).
#   2. nohup / data/daemon.pid (dev machines using start.sh).
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/data/daemon.pid"
LOG_FILE="$ROOT/data/logs/daemon.log"
SERVICE_NAME="${HASHRATE_AUTOPILOT_SERVICE:-hashrate-autopilot}"

# --- 1. systemd-managed install -------------------------------------
# `systemctl cat` succeeds (read-only, no sudo) iff the unit is known.
if command -v systemctl >/dev/null 2>&1 && systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
  state="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
  echo "daemon (systemd unit '$SERVICE_NAME'): ${state:-unknown}"
  systemctl --no-pager status "$SERVICE_NAME" 2>/dev/null | head -6 || true
  echo
  echo "recent logs (journalctl -u $SERVICE_NAME -n 10):"
  journalctl -u "$SERVICE_NAME" -n 10 --no-pager 2>/dev/null \
    || echo "(journal not readable - try: sudo journalctl -u $SERVICE_NAME -n 50)"
  [ "$state" = "active" ] && exit 0 || exit 1
fi

# --- 2. nohup / PID-file install ------------------------------------
if [[ ! -f "$PID_FILE" ]]; then
  echo "daemon: not running (no PID file; no systemd unit '$SERVICE_NAME' either)"
  exit 1
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  echo "daemon: running (PID $PID)"
  ps -p "$PID" -o pid,etime,command
  echo
  echo "recent logs (last 10 lines of $LOG_FILE):"
  tail -n 10 "$LOG_FILE" 2>/dev/null || echo "(no log yet)"
  exit 0
fi

echo "daemon: not running (PID file references dead process $PID)"
exit 1
