#!/usr/bin/env bash
#
# launch-session.sh <name> <channel> — spin up a Claude Code session in tmux,
# wired to a parachute-agent channel, ready to chat through the UI.
#
# Idempotent: re-running for an existing session is a no-op (prints how to
# attach). Handles the first-launch prompts (folder-trust + dev-channels) so it's
# genuinely one command. Drops a CLAUDE.md in the session workdir so the session
# reliably replies via the channel's reply tool.
#
# Env:
#   PARACHUTE_AGENT_URL        daemon the bridge connects to (default http://127.0.0.1:1941)
#   PARACHUTE_AGENT_STATE_DIR  base for session workdirs (default ~/.parachute/agent)
#
# Example:
#   ./scripts/launch-session.sh aaron aaron
#   ./scripts/launch-session.sh ops   ops
#
set -euo pipefail

NAME="${1:-}"
CHANNEL="${2:-}"
if [ -z "$NAME" ] || [ -z "$CHANNEL" ]; then
  echo "usage: launch-session.sh <session-name> <channel-name>" >&2
  exit 2
fi
# Both are used as slugs — in file paths, a tmux session name, and inside the
# generated .mcp.json. Reject anything that could break those (quotes, spaces,
# slashes, shell metachars). Channel names elsewhere are slug-like ("aaron","ops").
if printf '%s' "$NAME$CHANNEL" | grep -q '[^a-zA-Z0-9_-]'; then
  echo "error: <name> and <channel> must be alphanumeric, dash, or underscore only" >&2
  exit 2
fi

DAEMON_URL="${PARACHUTE_AGENT_URL:-http://127.0.0.1:1941}"
STATE_DIR="${PARACHUTE_AGENT_STATE_DIR:-$HOME/.parachute/agent}"
WORKDIR="$STATE_DIR/sessions/$NAME"
SESSION="$NAME-agent"

for bin in tmux bun claude; do
  command -v "$bin" >/dev/null 2>&1 || { echo "error: '$bin' not found on PATH" >&2; exit 1; }
done

# Idempotent: already running → just tell the operator how to reach it.
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "session '$SESSION' is already running (channel unchanged)."
  echo "  attach:           tmux attach -t $SESSION"
  echo "  change channel:   ./scripts/stop-session.sh $NAME && ./scripts/launch-session.sh $NAME <channel>"
  echo "  stop:             ./scripts/stop-session.sh $NAME"
  exit 0
fi

# Warn (don't fail) if the daemon isn't reachable — the bridge reconnects when it comes up.
if ! curl -fsS "$DAEMON_URL/health" >/dev/null 2>&1; then
  echo "warning: agent daemon not reachable at $DAEMON_URL — start it first (parachute-agent)." >&2
  echo "         launching anyway; the bridge will connect once the daemon is up." >&2
fi

mkdir -p "$WORKDIR"

# Mint a hub-issued JWT so the session authenticates to the agent daemon
# (aud: "agent", scopes agent:read + agent:write). The daemon validates it
# against the hub's JWKS — the bridge connection is authenticated like a vault
# MCP client, NOT trusted by loopback. If minting fails (no hub running, or not
# logged in), warn but continue: a dev daemon may be running unguarded, in which
# case it accepts an unauthenticated bridge.
TOKEN="$(parachute auth mint-token --scope "agent:read agent:write" 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  echo "warning: could not mint an agent token (parachute auth mint-token failed)." >&2
  echo "         the session will connect WITHOUT auth — fine for an unguarded dev daemon," >&2
  echo "         but an auth-enabled daemon will reject it (HTTP 401). Ensure the hub is" >&2
  echo "         running and you're logged in (parachute login) to authenticate the session." >&2
fi

# MCP config — the session's only wiring to the channel. This is now an HTTP
# MCP server (URL + Bearer), NOT a stdio bridge spawned from a local file: the
# session connects to the daemon's `/mcp/<channel>` endpoint exactly like adding
# the vault MCP. No `bun src/bridge.ts` path — works on any machine that can
# reach the daemon URL. The minted token rides as the Authorization header (the
# headless/local launch path); a human adding the channel by hand uses
# `claude mcp add --transport http` and gets prompted for OAuth instead.
MCP_URL="$DAEMON_URL/mcp/$CHANNEL"
# MCP server name — `agent-<channel>` so the .mcp.json key, the
# `--dangerously-load-development-channels=server:<name>` flag, and the daemon's
# self-reported name all match (no `server:aaron` vs `server:agent` surprise).
MCP_NAME="agent-$CHANNEL"
if [ -n "$TOKEN" ]; then
  cat > "$WORKDIR/.mcp.json" <<EOF
{
  "mcpServers": {
    "$MCP_NAME": {
      "type": "http",
      "url": "$MCP_URL",
      "headers": {
        "Authorization": "Bearer $TOKEN"
      }
    }
  }
}
EOF
else
  cat > "$WORKDIR/.mcp.json" <<EOF
{
  "mcpServers": {
    "$MCP_NAME": {
      "type": "http",
      "url": "$MCP_URL"
    }
  }
}
EOF
fi
# .mcp.json holds the agent token — keep it owner-only.
chmod 600 "$WORKDIR/.mcp.json"

# Reinforce the channel contract so the session always answers via the reply tool.
cat > "$WORKDIR/CLAUDE.md" <<'EOF'
# Channel session

You are a resident assistant attached to a Parachute channel. A human is messaging
you through a chat UI.

**The human reads ONLY your `reply` tool output — your transcript is invisible to
them.** For EVERY message that arrives on the channel, respond by calling the
`reply` tool. Always. Even a one-word answer. If you don't call `reply`, the human
sees nothing.
EOF

echo "launching session '$SESSION' on channel '$CHANNEL' (daemon $DAEMON_URL)…"
tmux new-session -d -s "$SESSION" -x 220 -y 50 \
  "cd '$WORKDIR' && exec claude --dangerously-load-development-channels=server:$MCP_NAME --dangerously-skip-permissions"

# First-launch prompts render a beat after start; accept them, then wait for the
# channel to attach. The order can vary, so poll for either.
trusted=0; acked=0; ready=0
for _ in $(seq 1 60); do
  pane="$(tmux capture-pane -p -t "$SESSION" 2>/dev/null || true)"
  if printf '%s' "$pane" | grep -q "inject directly in this session"; then ready=1; break; fi
  if [ "$trusted" = 0 ] && printf '%s' "$pane" | grep -q "trust this folder"; then
    tmux send-keys -t "$SESSION" Enter; trusted=1; sleep 1; continue
  fi
  if [ "$acked" = 0 ] && printf '%s' "$pane" | grep -q "local development"; then
    tmux send-keys -t "$SESSION" Enter; acked=1; sleep 1; continue
  fi
  sleep 0.5
done

if [ "$ready" != 1 ]; then
  echo "warning: session launched but the channel banner didn't appear in 30s." >&2
  echo "         inspect with: tmux attach -t $SESSION" >&2
  exit 1
fi

# Best-effort confirm the HTTP MCP session registered with the daemon on this channel.
connected=0
for _ in $(seq 1 20); do
  n="$(curl -fsS "$DAEMON_URL/health" 2>/dev/null | grep -o "\"name\":\"$CHANNEL\"[^}]*\"mcp_sessions\":[0-9]*" | grep -o '"mcp_sessions":[0-9]*' | grep -o '[0-9]*' || echo 0)"
  if [ "${n:-0}" -ge 1 ]; then connected=1; break; fi
  sleep 0.5
done

echo "✓ session '$SESSION' ready on channel '$CHANNEL'."
echo "  connected over HTTP MCP at $MCP_URL (no local bridge file)."
[ -n "$TOKEN" ] && echo "  authenticated with a hub-issued agent token (agent:read + agent:write)." \
                || echo "  NOT authenticated (no token minted) — only an unguarded dev daemon will accept it."
[ "$connected" = 1 ] && echo "  HTTP MCP session registered with the daemon." || echo "  (MCP session not yet confirmed via /health — usually a moment behind.)"
echo "  chat:    open the channel UI and pick channel '$CHANNEL'"
echo "  watch:   tmux attach -t $SESSION   (detach: Ctrl-b then d)"
echo "  stop:    ./scripts/stop-session.sh $NAME"
