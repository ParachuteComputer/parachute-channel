#!/usr/bin/env bash
# Techne pod supervisor.
#
# Runs two long-lived services:
#   - parachute-vault server  (always, on 127.0.0.1:1940 — auto-creates a
#     default vault on first boot, so no `vault init` needed)
#   - parachute-channel daemon (on 127.0.0.1:1941 — only after a Telegram
#     bot token is available, so the container boots cleanly before Aaron
#     has provisioned one)
#
# If TELEGRAM_BOT_TOKEN is passed via `docker run -e`, the token is persisted
# to the channel state dir on first start; subsequent starts don't need it.

set -u
umask 077

STATE_DIR="${HOME}/.parachute"
CHANNEL_STATE_DIR="${STATE_DIR}/channel"
CHANNEL_ENV_FILE="${CHANNEL_STATE_DIR}/.env"
CHANNEL_SRC="/opt/parachute-channel/src/daemon.ts"

mkdir -p "${STATE_DIR}" "${CHANNEL_STATE_DIR}"

# Persist a shell-injected bot token to the channel .env so restarts don't
# require the env var. Never overwrite a token already on disk.
if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && ! -s "${CHANNEL_ENV_FILE}" ]]; then
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "${TELEGRAM_BOT_TOKEN}" > "${CHANNEL_ENV_FILE}"
  chmod 600 "${CHANNEL_ENV_FILE}"
  echo "[techne] wrote TELEGRAM_BOT_TOKEN to ${CHANNEL_ENV_FILE}"
fi

echo "[techne] starting parachute-vault on 127.0.0.1:1940"
parachute vault serve &
VAULT_PID=$!

# --- Provision the strict-mode MCP config for `techne-claude` ---
# The wrapper at /usr/local/bin/techne-claude needs a JSON file listing
# just parachute-vault + parachute-channel. We regenerate it on every boot
# where it's missing so rebuilt images always end up with a fresh,
# working token (old tokens stay in vault DB until pruned manually).
MCP_CONFIG="${HOME}/techne/mcp.json"
if [[ ! -s "${MCP_CONFIG}" ]]; then
  echo "[techne] provisioning MCP config at ${MCP_CONFIG}"

  # Wait up to 30s for vault to be healthy so `parachute vault tokens create`
  # can talk to it. The server's first-boot auto-init can take a second or two.
  for _ in {1..30}; do
    if parachute vault status 2>/dev/null | grep -q "healthy"; then break; fi
    sleep 1
  done

  MCP_TOKEN=$(parachute vault tokens create 2>&1 | grep -oE 'pvt_[A-Za-z0-9_-]+' | head -1)
  if [[ -z "${MCP_TOKEN}" ]]; then
    echo "[techne] WARNING: could not mint MCP token — techne-claude will fail until ${MCP_CONFIG} is populated by hand"
  else
    umask 077
    cat > "${MCP_CONFIG}" <<JSON
{
  "mcpServers": {
    "parachute-vault": {
      "type": "http",
      "url": "http://127.0.0.1:1940/vaults/default/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    },
    "parachute-channel": {
      "command": "bun",
      "args": ["/opt/parachute-channel/src/bridge.ts"],
      "env": { "PARACHUTE_CHANNEL_URL": "http://127.0.0.1:1941" }
    }
  }
}
JSON
    umask 077
    echo "[techne] wrote ${MCP_CONFIG}"
  fi
fi

CHANNEL_PID=""
start_channel() {
  echo "[techne] starting parachute-channel daemon on 127.0.0.1:1941"
  bun "${CHANNEL_SRC}" &
  CHANNEL_PID=$!
}

has_token() {
  [[ -s "${CHANNEL_ENV_FILE}" ]] || [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]
}

if has_token; then
  start_channel
else
  echo "[techne] no TELEGRAM_BOT_TOKEN yet — channel will start as soon as one appears at ${CHANNEL_ENV_FILE}"
fi

# --- Always-on Techne agent in tmux ---
# A detached tmux session named `techne` runs `techne-claude-loop`, which
# keeps a Claude session alive 24/7 so inbound Telegram messages reach the
# agent even when nobody is at the keyboard. Aaron observes/interacts via
# `docker exec -it techne tmux attach -t techne` and detaches with Ctrl+B,d
# without killing it.
#
# We mirror the pane to a logfile (~/.techne-logs/loop.log) via tmux
# pipe-pane so there's a tail-able artifact even when no client is attached.
TECHNE_LOG_DIR="${HOME}/.techne-logs"
mkdir -p "${TECHNE_LOG_DIR}"

start_agent_tmux() {
  echo "[techne] starting always-on tmux session 'techne' (techne-claude-loop)"
  tmux new-session -d -s techne -n agent /usr/local/bin/techne-claude-loop
  tmux pipe-pane -t techne:agent -o "cat >> ${TECHNE_LOG_DIR}/loop.log"
}

if ! tmux has-session -t techne 2>/dev/null; then
  start_agent_tmux
fi

shutdown() {
  echo "[techne] signal received; shutting down"
  tmux kill-server 2>/dev/null || true
  [[ -n "${CHANNEL_PID}" ]] && kill "${CHANNEL_PID}" 2>/dev/null || true
  kill "${VAULT_PID}" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# Supervisor loop. Vault is the anchor: if it dies, the container exits and
# Docker's restart policy takes over. Channel is restarted with backoff on
# its own, and started on demand once a token lands. The tmux session is
# recreated if it disappears (rare; the loop wrapper is what keeps Claude
# alive, and the loop only exits if it crashes itself).
while true; do
  if ! kill -0 "${VAULT_PID}" 2>/dev/null; then
    echo "[techne] vault exited — container will exit so Docker restarts us"
    exit 1
  fi

  if [[ -z "${CHANNEL_PID}" ]]; then
    if has_token; then start_channel; fi
  elif ! kill -0 "${CHANNEL_PID}" 2>/dev/null; then
    echo "[techne] channel daemon exited — restarting in 10s"
    CHANNEL_PID=""
    sleep 10
    if has_token; then start_channel; fi
  fi

  if ! tmux has-session -t techne 2>/dev/null; then
    echo "[techne] tmux session 'techne' missing — recreating"
    start_agent_tmux
  fi

  sleep 5
done
