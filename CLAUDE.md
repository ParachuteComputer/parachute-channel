# parachute-agent

Vault-native agents for Claude Code. A `#agent/definition` note in a Parachute vault
defines an agent; inbound messages (chat / vault note / scheduled job) become a turn;
the reply flows back as an outbound `#agent/message/outbound` note. Telegram today,
anything tomorrow.

## The model: agents + two backends

An agent is a `#agent/definition` note (body = system prompt, metadata = config). Its
**backend** is the axis, and there are exactly **two**
(design [`2026-06-18-channel-backend.md`](./design/2026-06-18-channel-backend.md)):

- **`programmatic`** (the DEFAULT) — the daemon runs each turn headless via
  `claude -p --resume` (sandboxed, always-on). No resident process; an inbound message
  becomes one on-demand turn, the reply is written as an outbound note.
- **`attached`** — the turn is delivered over a channel to a Claude Code session **you
  run yourself** (your machine, your env/creds, unsandboxed) and have connected to the
  channel's MCP endpoint. The daemon runs no turn; the inbound notes accumulate as a
  durable queue and your session **pulls** the next message, works, and **replies** via
  MCP tools.

> **Retired: the `interactive` (tmux) backend** (2026-06-19, design
> [`2026-06-19-retire-interactive-backend.md`](./design/2026-06-19-retire-interactive-backend.md)).
> It puppeted a tmux pane with send-keys and pushed onto an idle MCP stream to fake
> message injection — and carried the deaf-on-restart / backlog-replay / idle-wake
> fragility class. `attached` supersedes it. The PTY/tmux spawner is **parked** at
> [`src/_parked/interactive-spawn.ts`](./src/_parked/interactive-spawn.ts) for future
> terminal/process-management (a general capability, decoupled from the agent backend),
> not maintained as a live backend.

## Architecture

The **daemon** (port 1941, long-running, one per machine) is the only process that
touches a transport's external API (e.g. Telegram's getUpdates long-poll — exclusive,
no multi-consumer races). It owns the channel registry, routes inbound to the right
backend (the **daemon routing fork**: `programmatic` → `ProgrammaticAgentRegistry`'s
serial worker runs `claude -p`; `attached` → `AttachedQueueRegistry`, the durable
note-queue a connected session pulls from), and writes outbound notes.

A Claude Code session connects to a channel two ways:

- **HTTP MCP (primary)** — the session adds `<hub>/agent/mcp/<channel>` as a pure HTTP
  MCP server (URL + OAuth), exactly like the vault. The daemon serves a stateful
  Streamable-HTTP MCP endpoint (`src/mcp-http.ts`): for an `attached`-backend agent it
  exposes the **pull surface** (`pending` / `next-message` / `reply` / `release`); the
  live `pushToChannel` wake streams the programmatic backend's interim "watch it work"
  text + the live inbound wake onto the session's GET stream.
- **stdio bridge (`src/bridge.ts`)** — the session spawns the bridge, which subscribes
  to the daemon's SSE `/events` and forwards each event as a `notifications/claude/agent`
  MCP notification; outbound tool calls proxy to the daemon's HTTP `/api/*`. Still
  supported; the HTTP-MCP path is what the UI + launcher steer toward.

## Why not the official telegram plugin?

The official plugin has a known bug (anthropics/claude-code#38098, open): every Claude Code session with the plugin enabled at any scope auto-spawns a Telegram poller child, even without `--channels`. This causes multi-consumer races that drop ~50% of messages. The plugin system's `enabledPlugins` resolution is session-global and can't be scoped to one session. This gateway solves the problem by design: one daemon, any number of subscribers.

## Running

### Daemon (start once, runs forever)

```bash
bun src/daemon.ts
# or via the hub supervisor / launchd — see below
```

Telegram channels carry a per-channel bot token in `channels.json` config — the daemon does NOT read a global `TELEGRAM_BOT_TOKEN`. Define channels via the admin SPA at `/agent/app/` (or by writing `~/.parachute/agent/channels.json` directly).

### Connecting an `attached`-backend session (the easy path)

```bash
claude mcp add --transport http agent <hub-origin>/agent/mcp/<channel>
```

It prompts for OAuth the first time (like the vault). Then the session runs the pull
loop: `pending` → `next-message` (claims the oldest inbound + returns the agent's system
prompt to adopt) → do the work → `reply { inReplyTo, text }` (writes the outbound note +
marks the inbound handled). A claimed message auto-releases after a TTL so a crashed
session never strands the queue.

### stdio bridge (alternative)

Registered in a session's `.mcp.json`:
```json
{
  "mcpServers": {
    "parachute-agent": {
      "command": "bun",
      "args": ["<path>/src/bridge.ts"],
      "env": { "PARACHUTE_AGENT_URL": "http://127.0.0.1:1941" }
    }
  }
}
```

Launch Claude Code with:
```bash
claude --dangerously-load-development-channels=server:parachute-agent
```

The `=` binding is load-bearing. Space-separating the value (`--dangerously-load-development-channels server:parachute-agent`) works in `--print` mode but in interactive mode the parser swallows `server:parachute-agent` as the initial-prompt positional, leaving the flag with an empty channels list. At runtime this surfaces as `"server:parachute-agent · no MCP server configured with that name"`, which points operators at the wrong suspect (the MCP config is fine; the flag-parser is what dropped the value). Always use the `=` form — it's unambiguous in every mode. See [#8](https://github.com/ParachuteComputer/parachute-agent/issues/8).

If you hit an adjacent issue:
- The bridge warns on stderr if the capability isn't registered, so this misconfig surfaces immediately instead of looking like everything is fine until a message arrives — see [#9](https://github.com/ParachuteComputer/parachute-agent/issues/9).
- A cosmetic `/mcp` display warning may appear even with the correct flag — expected, ignore. See [#10](https://github.com/ParachuteComputer/parachute-agent/issues/10).

## Hub integration

Agent self-registers into `~/.parachute/services.json` at boot and ships
`.parachute/module.json`, so hub lists it in the portal and reverse-proxies
`<expose>/agent/*` → the loopback daemon (`stripPrefix:true`; SSE survives the proxy).
The admin / agents SPA is reachable at `<hub-origin>/agent/app/` over the expose, and at
`http://127.0.0.1:1941/agent/app/` locally. (`/agents` `302`s to the SPA app root; the
old server-rendered HTML pages — the `/ui` chat, the six-page nav — retired in Phase 4.
`/terminal` remains as a demoted attach-to-a-tmux-session tool, not a backend.)

## HTTP MCP endpoint detail (the discovery contract)

The `<hub-origin>/agent/mcp/<channel>` endpoint a session adds (see "Connecting an
`attached`-backend session" above) is a stateful Streamable-HTTP MCP server
(`src/mcp-http.ts`). Discovery is RFC 9728 + RFC 8414, in the **path-insertion** form a
Claude Code HTTP-MCP client probes (mirrors vault's `src/oauth-discovery.ts`), served
PUBLIC (no auth) by the daemon:

- `GET /.well-known/oauth-protected-resource/mcp/<channel>` → `resource` (the public MCP
  URL, built from `X-Forwarded-Host`), `authorization_servers: [<hub-origin>]`,
  `scopes_supported: ["agent:read","agent:write"]`, `bearer_methods_supported: ["header"]`.
- `GET /.well-known/oauth-authorization-server/mcp/<channel>` → forwarder pointing
  `authorization_endpoint` / `token_endpoint` / `registration_endpoint` / `jwks_uri` at the hub.
- A no/invalid-bearer `POST /mcp/<channel>` returns **401 + `WWW-Authenticate: Bearer
  resource_metadata="…/.well-known/oauth-protected-resource/mcp/<channel>"`** — the signal a
  spec OAuth client follows to start the flow. (Only `/mcp/*` carries the challenge; `/events`
  + `/api/*` stay plain 401.)

For an `attached`-backend agent the endpoint serves the PULL surface
(`pending` / `next-message` / `reply` / `release`, dispatched to `AttachedQueueRegistry`);
the live `pushToChannel` wake streams the programmatic backend's interim text + the live
inbound wake onto a session's GET stream. The stdio `bridge.ts` over `/events` + `/api/*`
still works (Layer 1 below) — the HTTP MCP endpoint is **additive**, and is the path the
SPA + the `claude mcp add` connect step steer toward.

## Auth

**Layer 1 — session↔channel (done).** The bridge-facing daemon endpoints (`GET /events`,
`POST /api/{reply,react,edit,permission,download}`) require a hub-issued JWT (`aud: agent`,
scope `agent:read`/`agent:write`), validated via `@openparachute/scope-guard` against the
hub's JWKS — exactly like a vault MCP client. The launcher mints the token
(`parachute auth mint-token --scope "agent:read agent:write"`) and injects it as
`PARACHUTE_AGENT_TOKEN`; the bridge presents it as a Bearer. Any session on any machine
connects this way — no loopback trust.

The daemon **must** have `PARACHUTE_HUB_ORIGIN` set to the hub's *public* origin (the hub stamps
that as the token `iss`); the loopback fallback is dev-only. Hub-as-supervisor sets this when it
starts the module; a manually-run daemon on an exposed box needs it in the environment.

**Layer 2 — human↔UI (done).** The chat-UI traffic endpoints (`POST /api/channels/<name>/send`
→ scope `agent:send`; the browser SSE streams `GET /ui/events` + `GET /api/channels/<ch>/turn-events`
→ scope `agent:read`) require a hub-issued JWT, validated the same way as Layer 1 (shared
`requireScope` in `src/auth.ts`). The token comes from a hub endpoint —
`GET <hub-origin>/admin/agent-token` (cookie-gated to the logged-in portal operator), returning
`{ token, expires_at, scopes }` with `aud:agent` + `agent:read agent:send`, ~10min TTL. The chat
page fetches it on load (`credentials: "include"`) and attaches it as a Bearer header on the send
POST and the ticket mint. On a 401/SSE-error it re-fetches once and retries. `/ui`, `/health`, and
`/.parachute/config[/schema]` stay OPEN — the page must load to bootstrap its token fetch, and the
config listing is non-sensitive.

**SSE one-time ticket (agent#25).** An `EventSource` can't set an `Authorization` header, so the
browser SSE streams used to take the hub JWT as a `?token=<JWT>` query param — which leaks the
credential into any access/proxy log, browser history, or network trace (mitigated before only by
the ~10min TTL). They now authenticate with a **one-time ticket** instead: the page POSTs its
bearer to `POST /api/ui/sse-ticket` (Bearer-gated on `agent:read`, `mintSseTicket` in `src/auth.ts`),
which returns `{ ticket, expires_at }` — an opaque 256-bit base64url nonce held only server-side in
a TTL'd map (`src/ui-ticket.ts`, ≤60s) carrying the minting token's validated scopes. The page then
opens `…?ticket=<nonce>`; the SSE consume path (`requireSseTicket`) looks it up, **consumes it
single-use** (deletes immediately → a replay 401s), and establishes the stream with the ticket's
scopes (never widened past the JWT's). So the JWT never appears in a URL. Each EventSource mints its
own ticket; an SSE error re-mints and reconnects. The legacy `?token=` SSE path was REMOVED (pre-1.0,
no deprecation window). The `agent:admin` terminal WebSocket still uses `?token=` — a separate
operator-gated mechanism, out of this change's scope.

**Step-up auth — PIN second factor on the dangerous actions (agent#80).** A single
`agent:admin` session can do anything dangerous with no re-confirm — set/rotate credentials
(→ exfiltrate vault/channel/Claude tokens), open a **terminal** (→ raw host shell), or spawn a
`filesystem: full` agent (→ read the whole disk). So those actions require a **step-up token**
IN ADDITION to `agent:admin`. The operator sets a PIN once (hashed+salted via `Bun.password`
argon2id in `~/.parachute/agent/step-up.json`, mode 0600 — `src/step-up.ts`); `POST /api/step-up
{ pin }` validates it (rate-limited, 5 wrong / 5 min lockout) and mints an opaque CSPRNG nonce
(TTL ~5min, server-side TTL'd map, REUSABLE within its window — like `ui-ticket.ts` but not
single-use). `POST /api/step-up/pin { newPin, currentPin? }` sets/rotates the PIN (rotation
requires the current PIN). The gate (`requireStepUp` in `src/auth.ts`) is enforced SERVER-side
on: **set-credentials** (`POST`/`DELETE` `/api/credentials/env` + `/api/credentials/claude[/:channel]`),
the **terminal** WS (`authorizeTerminalUpgrade`), and the **`filesystem: "full"` spawn** path
(ordinary sandboxed spawns stay frictionless). A gate miss returns `403 { error:
"step_up_required", reason: "setup"|"token" }` — DISTINCT from a plain 401 (no/invalid bearer) —
so the SPA prompts (first-time setup vs PIN entry) instead of re-authenticating. The token rides
the `X-Step-Up-Token` header (or `?step_up=` for the terminal WS, which can't set a header). The
SPA holds it in memory and attaches it transparently in `lib/api.ts:authedFetch` (re-prompt on
expiry); the PIN is never logged or returned. The step-up token NEVER widens scope — it's a
second factor on top of `agent:admin`, never a substitute.

## Vault integration (Stage 2) — channels backed by `#agent/message` notes

A `vault` transport backs a channel with notes in a Parachute vault, so messages
are durable, queryable, and a vault surface can render them. Multiple channels per
vault: the note's routing-key metadata routes it.

> **Routing-key CONTRACT landed (#133).** The data-model `channel → agent` rename's
> CONTRACT phase is in: every note now writes the routing key under `metadata.agent`
> ONLY (the `metadata.channel` dual-write is dropped), and the vault inbound trigger
> keys on `has_metadata:["agent"]`. The `noteAgentKey` helper (`src/transports/vault.ts`)
> still READS `agent ?? channel` as a read-only tolerance for any in-flight straggler
> during the live cutover. The legacy `#channel-message*` / interim `#agent-message*`
> tag dual-read + dual-schema were dropped too (we only ever wrote `#agent/message*`).
> **Live cutover is a SEPARATE step:** merging this code has no live effect until the
> vault trigger is re-registered to `has_metadata:["agent"]` and the daemon restarts.
> Note the TRANSPORT/ENDPOINT "channel" concept is untouched — `channels.json`, the
> `Channel` type, `/mcp/<channel>`, `InboundMessage.channel`, and the note path prefixes
> all stay.

**The `#agent/*` namespace is module-owned** (design
`design/2026-06-17-vault-native-agents.md`). Every vault object this module manages
hangs off the `#agent` prefix: `#agent/definition` (a vault-native agent def — body
is the system prompt, metadata is the config), `#agent/message{,/inbound,/outbound}`
(a conversation turn), `#agent/job` (a scheduled trigger), `#agent/thread` (the durable
record of one thread — see the `#agent/thread` subsection below). The tag schema declares
`parent_names` so a human `tag:#agent` query rolls up to everything the module owns.
The module always queries the EXACT leaf tag (never relies on prefix magic), and
keeps the "tag both queryable parent + directional child literally" floor so loop
avoidance + transcript listing work with zero per-vault schema dependency. The
channel→agent CONTRACT dropped the prior flat `#agent-message*` / legacy
`#channel-message*` tag dual-read — the module both WRITES and READS only the
`#agent/message*` tags now.

**Note shape** — TWO tags per note, carried literally (two orthogonal axes):
- the parent `#agent/message` — the QUERYABLE membership tag. A UI lists a channel's
  whole transcript (both directions) with one `tag: "#agent/message"` + `metadata.agent`
  (the routing key) query, because the parent is literally on every note.
- a directional child — the trigger DISCRIMINATOR: `#agent/message/inbound` (human→session)
  or `#agent/message/outbound` (session reply).

**The slash is a namespace, NOT query inheritance.** In a Parachute vault a slash in a tag
NAME is a namespace convention only — `query-notes { tag: "#agent/message" }` matches
descendants by the `tags.parent_names` graph (declared via `update-tag`), NOT by name-prefix.
A note tagged ONLY `#agent/message/inbound` is INVISIBLE to a `tag: "#agent/message"`
query unless that inheritance was separately declared — so we tag BOTH the parent and the
child and don't depend on per-vault schema setup.

Content = the message text; metadata: `{ agent, direction: "inbound"|"outbound", sender,
in_reply_to (outbound), ts }` — `agent` is the routing key (the channel→agent CONTRACT moved
it off the dropped `channel` field; `noteAgentKey` keeps an `agent ?? channel` read fallback
for stragglers). Loop avoidance lives in the TAG, not metadata: the trigger fires on the inbound
child tag only (exact match), which an outbound note never carries, so a reply never wakes its own
session. **Inbound notes MUST carry BOTH `#agent/message` (parent, makes it queryable) AND
`#agent/message/inbound` (child, fires the trigger), with the routing key in `metadata.agent`.**
Outbound notes carry `#agent/message` + `#agent/message/outbound`.

**Flow.** INBOUND (human→session): a new `#agent/message` + `#agent/message/inbound` note →
a vault **trigger** POSTs a webhook → the agent daemon's `POST /api/vault/inbound` → routes by
`noteAgentKey(note.metadata)` (reads `metadata.agent`) → `ctx.emit` wakes the session (fans to
SSE bridges + HTTP-MCP sessions alike). OUTBOUND (session→human): the session's `reply` writes a `#agent/message` +
`#agent/message/outbound` note via the vault REST API (`POST <vaultUrl>/vault/<vault>/api/notes`,
Bearer `vault:<name>:write`).

**channels.json** (the channel side):
```json
{ "name": "eng", "transport": "vault",
  "config": { "vault": "default", "vaultUrl": "http://127.0.0.1:1940",
              "token": "<vault:default:write JWT>", "webhookSecret": "<shared secret>" } }
```

**Vault side** (operator config — activates the inbound trigger):
1. (Optional, for indexed queries) declare the `#agent/message` tag schema with
   indexed `agent`/`direction`/`sender` fields (`update-tag`).
2. Add a trigger to the vault's `config.yaml` that fires on new inbound notes and
   webhooks the agent daemon. Loop avoidance is by tag: the vault predicate does
   EXACT tag membership, so firing on the inbound CHILD tag (`#agent/message/inbound`)
   never matches an outbound (reply) note — which carries `#agent/message/outbound`,
   not the inbound child — so no `missing_metadata` clause is needed. (Both directions
   also carry the parent `#agent/message`, but the trigger keys on the child only.)
   ```yaml
   triggers:
     - name: channel_inbound
       events: ["created"]
       when:
         tags: ["agent/message/inbound"]
         has_metadata: ["agent"]
         missing_metadata: ["channel_inbound_rendered_at"]
       action:
         webhook: "http://127.0.0.1:1941/api/vault/inbound?secret=<shared secret>"
         send: "json"
   ```
   The shared secret rides in the URL — vault doesn't sign webhooks yet; a hub-JWT
   auth block on the trigger is a follow-up. The daemon defends in depth too:
   `ingestInbound` drops any note tagged `#agent/message/outbound`, so a reply can
   never wake its own session.

### `#agent/thread` — the thread record (the unified model)

The unified model is `definition -> thread -> message`: **everything is a thread**, and
EVERY completed turn materializes a `#agent/thread` note (a "run" was always a thread with
one turn — the older `#agent/run` tag retired into this). The note is the durable,
queryable record of one thread: its BODY is a rolling SUMMARY (`## Summary` /
`## Latest turn`), and its metadata carries the thread state — `agent` (the routing key),
`definition`, `mode`, `status`, `started_at`, `last_turn_at`, `turn_count`, cumulative `usage`, and the
Claude `session` UUID. The INDEXED `status`/`definition`/`mode` fields make threads
operator-queryable ("all failed threads", "all threads of agent X", "all multi-threaded
threads").

> **Thread ≡ session (#131).** The thread's Claude session UUID now lives on the thread
> note itself as `metadata.session`: the daemon `--session-id`-CREATES the session on the
> first turn and `--resume`-CONTINUES it on later turns, reading the UUID back off the
> note. This replaces the retired separate `agent-session-state.json` store — the thread
> note IS the session record.

**v1 OVERWRITES the `## Summary` section every turn.** The module regenerates the whole
body from the rolled-up metadata each turn (it never reads the prior note's content), so
`## Summary` is a module-owned default, not a preserved slot. It is EARMARKED for a future
summarizer agent, but summarizer-agent enrichment needs a read-prior-content → merge path
(to preserve a summarizer-owned section across the regenerate), which is DEFERRED. "May
own" means earmarked, not preserved.

**Both execution modes materialize a thread note** — the mode governs the thread's
IDENTITY (its path leaf) + whether it upserts:

- **`single-threaded`** — exactly ONE thread note per channel at the DETERMINISTIC path
  `Threads/<safeChannel>/<safeName>` (named after the definition). It UPSERTS in place
  across turns: the transport READs the existing note, then writes the rolled-up
  aggregates (`turn_count` incremented, `usage` summed, original `started_at` preserved,
  `last_turn_at` advanced). Safe today because the drain is serial per channel and
  single-threaded is one-thread-per-channel; concurrent-threads-per-channel (the deferred
  continuation increment) will re-derive aggregates from the `#agent/message` children or
  a vault atomic-merge instead.
- **`multi-threaded`** — one thread note PER FIRE at `Threads/<safeChannel>/<uuid>`
  (`turn_count` 1; usage = this fire's). No upsert.

**Loop safety:** the thread note carries `['#agent/thread']` EXACTLY — never a message tag,
never the inbound child — so it can never wake a session. It is also the PRIMARY record of
the turn, written BEFORE the additive outbound transcript write, so a turn's record
survives an outbound failure.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | (unset) | **Highest-priority port input** — the hub supervisor injects this from the module's services.json `entry.port` (the canonical pattern vault/scribe follow). The daemon binds AND self-registers this port, so the supervisor's readiness probe + `/agent/*` proxy target agree (agent#41). Empty/non-numeric falls through. |
| `PARACHUTE_AGENT_PORT` | `1941` | Daemon HTTP port — back-compat override for a daemon run *outside* the supervisor. Used only when `PORT` is unset. |
| `PARACHUTE_AGENT_URL` | `http://127.0.0.1:1941` | Bridge → daemon URL |
| `PARACHUTE_AGENT_STATE_DIR` | `~/.parachute/agent` | Token, access config, inbox |
| `PARACHUTE_AGENT_SWEEP_MS` | `30000` | **Daemon:** cadence of the attached-backend claim-sweep tick (auto-releases `in-flight` inbound claims older than the 15-min TTL back to `pending`, so a crashed/abandoned session can't strand a channel queue). |
| `PARACHUTE_HUB_ORIGIN` | `http://127.0.0.1:1939` | **Daemon:** hub's public origin for JWT `iss` validation. Required on an exposed deployment (the loopback default is dev-only); hub-as-supervisor sets it. |
| `PARACHUTE_AGENT_TOKEN` | (none) | **Bridge:** hub-issued agent JWT presented as Bearer. The launcher mints + injects it; unset = no auth header (dev only). Default mint TTL is the hub's non-ephemeral default (~90d); re-launch re-mints. |

## State directory

`~/.parachute/agent/`:
- `channels.json` — the channel registry. Each telegram channel carries its own bot token in `config.token` (created via the admin UI or written directly).
- `.env` — optional generic env vars (e.g. `PARACHUTE_HUB_ORIGIN`). The daemon no longer consumes `TELEGRAM_BOT_TOKEN` here.
- `access.json` — allowlist (compatible with the official plugin's format)
- `inbox/` — downloaded attachments
- `delivery-state.json` — per-channel last-delivered high-water-mark (`{ "<channel>": "<iso-ts>" }`), the spine of the no-silent-loss guarantee (below). Cheap, monotonic, write-through; losing it only costs a bounded re-replay.

## No silent message loss (delivery high-water-mark + backlog replay)

A connected vault-backed session used to go silently deaf after a daemon restart: MCP sessions drop on restart and only reconnect on the next interaction, and an inbound that lands with **zero** live subscribers reaches no one — yet the vault trigger acks success and stamps `..._rendered_at`, so it never re-fires. The message stays durable in the vault but is lost from the live wake.

The fix (`src/delivery-state.ts`):
- **Per-channel high-water-mark** — the ISO `ts` of the last inbound we actually delivered to ≥1 live subscriber. `contextFor.emit` advances it ONLY on a real delivery (SSE client count + MCP session count > 0); a 0-subscriber emit deliberately leaves the mark behind so the message replays later. Monotonic (never rewinds), persisted to `delivery-state.json`. A channel with no persisted mark defaults to the **daemon boot time** — so a first connect never replays ancient history, only the genuine deaf-window gap.
- **Backlog replay on (re)connect** (`replayBacklog`, VAULT channels only) — when an MCP session registers or an SSE bridge reopens `/events`, the daemon loads the channel transcript (reusing the index-free `loadTranscript`), replays the inbound messages newer than the mark — oldest-first, capped at the newest 50 — to **that one new subscriber only** (a per-session MCP push / a write to that one SSE stream, so existing subscribers aren't re-woken), then advances the mark.

`markSeen` (the webhook idempotency dedup that prevents the N-trigger fan-out from double-waking) is unchanged and orthogonal — the backlog path is gated by the mark, not by `markSeen`.

## Access control (`access.json`)

Schema is compatible with the official Telegram plugin, plus one parachute-agent extension: `allowInChats`.

| Field | Type | Description |
|---|---|---|
| `dmPolicy` | `"open" \| "pairing" \| "allowlist"` | `"open"` disables all gating. Anything else requires `allowFrom`. |
| `allowFrom` | `string[]` | User-ID allowlist. Matches `msg.from.id` / `cq.from.id`. |
| `allowInChats` | `string[]` (optional) | **Optional** chat-ID allowlist. For DMs, it's an AND gate with `allowFrom`. For **groups** (negative chat_id), inclusion grants entry to any group member — `allowFrom` is bypassed so shared spaces don't need every participant enumerated. |
| `groups`, `pending` | — | Used by the official plugin's pairing flow; read but not otherwise acted on here. |

### `allowInChats` semantics

- **Absent** → behave as today (user-allowlist only, no per-chat gating). Backwards-compatible.
- **Present with entries** →
  - **DMs** (positive chat_id, equals user_id): require BOTH `allowFrom` AND `allowInChats` to include the id.
  - **Groups** (negative chat_id): inclusion in `allowInChats` grants entry to any group member. `allowFrom` is bypassed. This is the intended way to let the bot participate in shared spaces without enumerating every member.
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

The channel MCP endpoint serves ONE of two tool surfaces, resolved at connect time by
the channel's backend (`src/mcp-http.ts`):

**Push surface** (a non-`attached` channel / the bridge — the session is woken, then replies):

| Tool | Description |
|---|---|
| `reply` | Send text + file attachments to a chat. Images → photos, .ogg → voice, others → documents. |
| `react` | Add emoji reaction to a message |
| `edit_message` | Edit a previously sent message |
| `download_attachment` | Download a Telegram file by file_id, returns local path |

**Pull surface** (an `attached`-backend agent — the session pulls the durable queue,
dispatched to `AttachedQueueRegistry`):

| Tool | Description |
|---|---|
| `pending` | How many inbound messages await + a peek (read-only, claims nothing) |
| `next-message` | Claim the oldest unhandled inbound; returns `{ id, text, inReplyTo, systemPrompt }` and marks it in-flight |
| `reply` | `{ inReplyTo, text }` → write the outbound note + mark the inbound handled |
| `release` | Un-claim an in-flight message back to pending |

## Testing

```bash
# Health check
curl http://127.0.0.1:1941/health

# Send a test message
curl -X POST http://127.0.0.1:1941/api/reply \
  -H "content-type: application/json" \
  -d '{"chat_id":"<CHAT_ID>","text":"hello from parachute-agent"}'
```

## Future

Two orthogonal axes extend cleanly:

- **New transports** (how a channel reaches the outside world — Telegram, http-ui,
  vault, …): add `src/transports/<name>.ts` implementing the `Transport` contract and
  register it alongside the others. The session-facing MCP contract is unchanged.
- **The two backends** (`programmatic` | `attached`) are the settled execution axis; the
  retired `interactive` (tmux) path is parked, not extended (design
  [`2026-06-19-retire-interactive-backend.md`](./design/2026-06-19-retire-interactive-backend.md)).
  A future revival of the parked PTY code lands as a general terminal/process-management
  capability, decoupled from the agent backend.

## Post-merge hygiene

When a PR is merged, locally:

```
git checkout main && git pull
```

Agent's steward does this already — captured here so it's durable and matches the convention now documented across every Parachute repo. Caught 2026-04-21 across vault/lens/scribe/cli where it wasn't being done.
