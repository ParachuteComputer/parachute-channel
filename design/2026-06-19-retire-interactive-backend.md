# Retiring the `interactive` agent backend — migration record

**Status:** shipped (2026-06-19). Closes the open arc the `channel` backend replaced
(see [`2026-06-18-channel-backend.md`](./2026-06-18-channel-backend.md) §"Retiring
interactive"). This is the record of WHAT was retired, WHAT was parked (and where),
and WHAT was kept — plus the companion Phase-4 HTML-page retirement, which had no
migration note of its own.

## Why

There were three agent backends in flight: `interactive` (tmux + send-keys + an
idle MCP-push wake), `programmatic` (`claude -p --resume` headless turns), and
`channel` (the turn handled by a Claude Code session the operator connects to the
channel's MCP endpoint). Per Aaron (2026-06-18) there are exactly **two**:
`programmatic` (default) and `channel`. `channel` is what `interactive` was reaching
for — a session that *natively subscribes and pulls* via MCP — done right, without
the tmux puppetry and without the deaf-on-restart / backlog-replay / idle-wake
fragility class `interactive` carried.

`parseAgentDef` already rejected `backend:interactive` for vault-native defs; this
shift makes `interactive` no longer a **selectable or constructible** backend
anywhere, and removes the now-dead carrier machinery.

## Retired (removed from the live tree)

| What | Where (before) |
|---|---|
| `interactive` as a backend type value | `AgentBackendKind` union (`src/sandbox/types.ts`) — now `"programmatic" \| "channel"` |
| `interpretPersistedBackend` (the persisted-spec interactive default) | `src/spawn-agent.ts` — boot re-register now reads `spec.backend === "programmatic"` exactly; a no-backend / `interactive` spec on disk is **inert** (never migrated, never launched) |
| The web interactive spawn/list/kill/restart routing | `src/daemon.ts` `/api/agents` (GET merge, POST spawn, restart, DELETE) + the `agentOps` seam on `createFetchHandler` — the routes are now programmatic-only (channel agents are vault-native) |
| The idle-wake **backlog replay** machinery | `replayBacklog` / `REPLAY_CAP` / `ReplayMessage` (`src/daemon.ts`); the `setOnSessionConnect` install + the `/events` SSE reconnect replay; `onSessionConnect` / `setOnSessionConnect` / `pushToSession` / `fireConnectReplay` (`src/mcp-http.ts`) and the GET-branch / `registerSession` replay hooks |
| The `backlog-replay.test.ts` suite (542 lines) | deleted — its subject (`replayBacklog`) is gone |

**Verification that the backlog-replay removal was safe:** the only reader of the
delivery high-water-mark was `replayBacklog`; the channel backend tracks claim state
on the inbound note's `status` (`pending | in-flight | handled`), not via replay, and
the programmatic backend runs synchronously (no idle session to go deaf). There is no
"missed-while-idle backlog to replay onto a reconnecting session" once `interactive`
is gone. The GET `/mcp/<channel>` handler that fired `fireConnectReplay` is the live
**wake** stream (`pushToChannel`) — kept; only the replay call on it was removed.

## Parked (not deleted — future terminal/process-mgmt)

Per Aaron, the PTY/terminal-spawning machinery gets repurposed later (lower priority)
into proper terminal / process management in the Parachute interface — a general
capability, decoupled from the agent backend. It is parked behind a clear boundary:

| Parked unit | New home |
|---|---|
| The tmux SPAWNER (`spawnAgent`, `buildAgentClaudeArgs`, `buildLaunchScript`, `confirmDevChannelsPrompt` + `DEV_CHANNELS_*`, the `TmuxLauncher`/`realTmuxLauncher` seam, `SpawnAgentDeps`/`SpawnAgentResult`, `sessionName`) | `src/_parked/interactive-spawn.ts` |
| The tmux SESSION ADMIN (`AgentOps`/`TmuxAdmin`, `parseTmuxSessions`, `agentInfoFromSessions`, `realTmuxAdmin`, `createRealAgentOps`, `redactSpawnResult`, `AgentInfo`-interactive) | `src/_parked/interactive-spawn.ts` |
| The interactive operator CLI (`scripts/spawn-agent.ts`) | repointed to import the spawner from `src/_parked/interactive-spawn.ts` (+ wires its own `realTmuxLauncher`); kept buildable, not a live launch path |
| The parked unit tests | `src/_parked/interactive-spawn.test.ts` (+ the spawner-internals describes in `src/spawn-agent.test.ts`, which now import the spawner from the parked module) |

The parked spawner did NOT fork the shared sandbox/filesystem/env helpers — it
imports them from `src/spawn-agent.ts` (`wrapArgvInSandbox`, `seedAgentHome`,
`buildAgentChildEnv`, `resolveAgentCwd`, `sessionWorkspace`, `persistSpec`,
`readPersistedSpec`, `shellJoin`). `src/spawn-agent.ts` is now the SHARED-helpers
module; its `SpawnAgentDeps` was split into `SpawnAgentBaseDeps` (no tmux launcher —
what `resolveSpawnDeps` returns + the programmatic backend reads) which the parked
`SpawnAgentDeps` extends with `tmux`.

## Kept (load-bearing — explicitly NOT touched)

- **The programmatic backend** (`src/backends/programmatic.ts`) + everything it uses.
- **The channel backend + its MCP pull surface** — `pending` / `next-message` /
  `reply` / `release` dispatched to `ChannelQueueRegistry`
  (`src/backends/channel-queue.ts`; the tool surface in `src/mcp-http.ts`). 100% intact.
- **`pushToChannel`** (`src/mcp-http.ts`) — the programmatic streaming "watch it work"
  view + the live inbound wake. (`sessionHasLivePushStream` stays — `pushToChannel`
  gates on it.)
- **`delivery-state.ts`** — the durable per-channel high-water mark. `contextFor.emit`
  still advances it on a real delivery; it is now write-mostly (its only reader,
  `replayBacklog`, retired) but kept as durable infra.
- **The HTTP-MCP plumbing + auth** (OAuth discovery, `requireScope`, the `/mcp/<channel>`
  endpoint shell). The channel-pull surface rides it.
- **`bridge.ts`** (the stdio session bridge) + the `/events` SSE endpoint (the bridge
  subscribes over it — only the reconnect *replay* inside it was removed).
- **`/terminal` + `terminal-ui.ts` + `ui-kit.ts`** — `/terminal` is the demoted
  attach-to-a-tmux-session tool (`tmux attach`, not the spawner). Untouched.

## Operator-facing effect

**None.** `interactive` was never offered in the SPA create flow (the v2 create flow
only offers programmatic / channel — `web/ui/src/routes/CreateAgent.tsx`), and the
web spawn POST defaulted to `programmatic` since 2026-06-16. A `backend:"interactive"`
spawn POST now returns a clear `400` (retired) instead of launching a tmux session.
The SPA Agents list still *renders* an interactive backend pill defensively (display
continuity for any legacy agent), but offers no way to create one. Any stale
`spec.json` on disk that carries `backend:"interactive"` (or no backend) is simply
not re-registered on boot — inert, not an error.

## Companion shift — Phase-4 HTML-page retirement (no prior migration note)

Recorded here for completeness: the pre-Phase-4 world had server-rendered HTML pages
(the old `/ui` chat, the six-page nav) as the primary surface. Phase 4 replaced those
with the vault-native `#agent/definition` model + the SPA at `/agent/app/`. `/agents`
now `302`s to the SPA app root; `/terminal` is demoted to an attach tool. This
interactive retirement completes that arc on the backend side (the tmux backend was
the thing the old HTML terminal page was built around).
