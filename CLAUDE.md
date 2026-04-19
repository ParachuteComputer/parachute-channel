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
claude --dangerously-load-development-channels=server:parachute-channel
```

The `=` binding is load-bearing. Space-separating the value (`--dangerously-load-development-channels server:parachute-channel`) works in `--print` mode but in interactive mode the parser swallows `server:parachute-channel` as the initial-prompt positional, leaving the flag with an empty channels list. At runtime this surfaces as `"server:parachute-channel · no MCP server configured with that name"`, which points operators at the wrong suspect (the MCP config is fine; the flag-parser is what dropped the value). Always use the `=` form — it's unambiguous in every mode. See [#8](https://github.com/ParachuteComputer/parachute-channel/issues/8).

If you hit an adjacent issue:
- The bridge now warns on stderr if the capability isn't registered, so this misconfig surfaces immediately instead of looking like everything is fine until a message arrives — see [#9](https://github.com/ParachuteComputer/parachute-channel/issues/9).
- A cosmetic `/mcp` display warning may appear even with the correct flag — expected, ignore. See [#10](https://github.com/ParachuteComputer/parachute-channel/issues/10).

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

## Access control (`access.json`)

Schema is compatible with the official Telegram plugin, plus one parachute-channel extension: `allowInChats`.

| Field | Type | Description |
|---|---|---|
| `dmPolicy` | `"open" \| "pairing" \| "allowlist"` | `"open"` disables all gating. Anything else requires `allowFrom`. |
| `allowFrom` | `string[]` | User-ID allowlist. Matches `msg.from.id` / `cq.from.id`. |
| `allowInChats` | `string[]` (optional) | **Optional** chat-ID allowlist. When present, `msg.chat.id` / `cq.message.chat.id` must also be listed — AND gate with `allowFrom`. |
| `groups`, `pending` | — | Used by the official plugin's pairing flow; read but not otherwise acted on here. |

### `allowInChats` semantics

- **Absent** → behave as today (user-allowlist only). Backwards-compatible.
- **Present with entries** → both `allowFrom` and `allowInChats` must pass.
- **Present but empty (`[]`)** → **fail-closed**: no chats allowed. If you want user-only gating, omit the field rather than setting it to `[]`.

Private DMs to the bot have `chat.id === user_id` (Telegram convention). To permit a user's DM while gating groups, list their user ID in `allowInChats` too:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["1190596288"],
  "allowInChats": ["1190596288", "-1003765557903"],
  "groups": {},
  "pending": {}
}
```

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
