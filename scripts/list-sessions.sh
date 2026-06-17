#!/usr/bin/env bash
#
# list-sessions.sh — show the channel sessions launched by launch-session.sh
# (tmux sessions named "<name>-agent") and, when reachable, the daemon's
# per-channel client counts.
#
set -euo pipefail

DAEMON_URL="${PARACHUTE_AGENT_URL:-http://127.0.0.1:1941}"

echo "channel sessions (tmux):"
sessions="$(tmux ls 2>/dev/null | grep -E '^[^:]+-agent:' || true)"
if [ -z "$sessions" ]; then
  echo "  (none)"
else
  printf '%s\n' "$sessions" | sed 's/^/  /'
fi

echo
echo "daemon channels ($DAEMON_URL):"
if health="$(curl -fsS "$DAEMON_URL/health" 2>/dev/null)"; then
  printf '%s' "$health" | grep -o '"name":"[^"]*","kind":"[^"]*","clients":[0-9]*' | sed 's/^/  /' || echo "  (no channels)"
else
  echo "  (daemon not reachable)"
fi
