#!/usr/bin/env bash
#
# stop-session.sh <name> — stop a channel session launched by launch-session.sh.
# Kills the tmux session (which exits Claude Code + its bridge). Leaves the
# session workdir (.mcp.json + CLAUDE.md) in place so a relaunch is instant.
#
set -euo pipefail

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "usage: stop-session.sh <session-name>" >&2
  exit 2
fi
SESSION="$NAME-agent"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
  echo "stopped session '$SESSION'."
else
  echo "no running session '$SESSION'."
fi
