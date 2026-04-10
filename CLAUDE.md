# parachute-channel

Messaging gateway for Claude Code. Telegram today, anything tomorrow.

## Architecture

Two components — daemon and bridge — connected by SSE:

```
Telegram API
    ↕ getUpdates / sendMessage / etc.
daemon (port 1941, long-running, one per machine)
    ↕ SSE for inbound, HTTP for outbound
bridge (stdio MCP, spawned per-session by Claude Code)
    ↕ stdio MCP notifications + tools
Claude Code session
```

The **daemon** is the only process that touches the Telegram API. It owns the getUpdates long-poll exclusively — no multi-consumer races by construction. Multiple bridges can connect simultaneously.

The **bridge** is a stateless MCP server that Claude Code spawns as a subprocess. It declares `claude/channel` capability so Claude Code registers a notification listener. It connects to the daemon's SSE `/events` stream and forwards each event as a `notifications/claude/channel` MCP notification. Outbound tool calls (reply, react, edit, download) proxy to the daemon's HTTP API.

## Why not the official telegram plugin?

The official plugin has a known bug (anthropics/claude-code#38098, open): every Claude Code session with the plugin enabled at any scope auto-spawns a Telegram poller child, even without `--channels`. This causes multi-consumer races that drop ~50% of messages. The plugin system's `enabledPlugins` resolution is session-global and can't be scoped to one session. This gateway solves the problem by design: one daemon, any number of bridges.

## Running

### Daemon (start once, runs forever)

```bash
bun src/daemon.ts
# or via launchd — see below
```

Requires `TELEGRAM_BOT_TOKEN` in env or `~/.parachute/channel/.env`.

### Bridge (registered in .mcp.json, Claude Code spawns it)

Registered in `~/UnforcedAGI/.mcp.json`:
```json
{
  "mcpServers": {
    "parachute-channel": {
      "command": "bun",
      "args": ["<path>/src/bridge.ts"],
      "env": { "PARACHUTE_CHANNEL_URL": "http://127.0.0.1:1941" }
    }
  }
}
```

Launch Claude Code with:
```bash
claude --dangerously-load-development-channels server:parachute-channel
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | (required) | Telegram bot token from BotFather |
| `PARACHUTE_CHANNEL_PORT` | `1941` | Daemon HTTP port |
| `PARACHUTE_CHANNEL_URL` | `http://127.0.0.1:1941` | Bridge → daemon URL |
| `PARACHUTE_CHANNEL_STATE_DIR` | `~/.parachute/channel` | Token, access config, inbox |

## State directory

`~/.parachute/channel/`:
- `.env` — `TELEGRAM_BOT_TOKEN=...`
- `access.json` — allowlist (compatible with the official plugin's format)
- `inbox/` — downloaded attachments

## MCP tools exposed to Claude

| Tool | Description |
|---|---|
| `reply` | Send text + file attachments to a chat. Images → photos, .ogg → voice, others → documents. |
| `react` | Add emoji reaction to a message |
| `edit_message` | Edit a previously sent message |
| `download_attachment` | Download a Telegram file by file_id, returns local path |

## Testing

```bash
# Health check
curl http://127.0.0.1:1941/health

# Send a test message
curl -X POST http://127.0.0.1:1941/api/reply \
  -H "content-type: application/json" \
  -d '{"chat_id":"<CHAT_ID>","text":"hello from parachute-channel"}'
```

## Future

The daemon + bridge split makes adding new backends straightforward:
- Discord: add `src/discord/` with a Discord gateway poller, register alongside telegram
- SMS/iMessage: same pattern
- Custom web frontend: same pattern — the bridge doesn't change

The bridge's MCP contract (`notifications/claude/channel` + tool surface) stays the same regardless of backend.
