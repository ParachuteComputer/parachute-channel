# Agent

**Chat with your Claude Code sessions — a channel per session.**

> ⚠️ **Experimental (v0.1.0).** Agent is a preview, evolving quickly. It runs
> today on an owner-operated, trusted machine — it is **not yet hardened for
> untrusted or multi-tenant use**. Read [Status & safety](#status--safety) before
> you rely on it. (Part of [Parachute](https://parachute.computer); conventions in
> [`parachute-patterns`](https://github.com/ParachuteComputer/parachute-patterns).)

Agent is a **messaging fabric for Claude Code**. One daemon hosts named
*channels*; a Claude Code session connects to a channel, and you talk to it — from
Telegram, from a Parachute vault, or from the built-in web chat. The session
replies on the same channel. It also lets you **spawn and watch sandboxed agent
sessions from the browser**.

## What you get

- **Talk to a session over any transport.** A channel is bound to one transport:
  - `vault` — messages are durable [`#agent/message`](#vault-backed-channels)
    notes in a Parachute vault, so the conversation is queryable and renders in any
    vault surface (this is the recommended transport).
  - `telegram` — a Telegram bot, one per channel.
  - `http-ui` — an ephemeral in-memory transport for quick local testing.
- **A built-in web surface** at `<hub-origin>/agent/` — Home, Chat, Agents,
  Terminal, and Config, on the Parachute brand. Chat over a `vault` channel shows
  the durable transcript and writes your messages back as notes.
- **Sandboxed agent sessions.** Spawn a Claude Code session in a sandbox (scoped
  filesystem + a network posture you choose), bound to a channel, and watch it in
  an in-page terminal. See [Agents](#agent-sessions).

## How it works

Two components connected by SSE — a long-running **daemon** and a per-session
**bridge**:

```
your transports (Telegram / vault trigger / web chat)
        ↕
   daemon (port 1941, one per machine) ──┐ owns each transport; fans inbound
        ↕ SSE (/events) + HTTP (/api/*)  │ to subscribers, accepts outbound
   bridge  (stdio MCP, per session)      │
        ↕ MCP notifications + tools       │
   Claude Code session ──────────────────┘ wakes on a message, replies with a tool
```

A session can also connect as a **pure HTTP MCP server** (by URL + OAuth, exactly
like adding the vault) — no local config file. See
[Connecting a session](#connecting-a-session).

Deeper design + operational detail live in [`CLAUDE.md`](./CLAUDE.md).

## Status & safety

Agent is `focus: experimental` and pre-1.0. What's solid vs. early:

- **Solid:** the daemon/bridge fabric, the vault + Telegram + http-ui transports,
  hub registration + reverse-proxy, the web surface (Home/Chat/Agents/Terminal/
  Config), and vault-backed durable chat.
- **Early / changing:** the npm package isn't published yet (run from source —
  tracked in [#16](https://github.com/ParachuteComputer/parachute-agent/issues/16));
  agent-session isolation is real but young; APIs may shift.

**Read this about agent sessions.** A spawned agent runs `claude` with
`--dangerously-skip-permissions` (it's autonomous — no human at the terminal to
answer prompts). The containment is the **OS sandbox**
([`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime) —
Seatbelt on macOS, bubblewrap on Linux), with two independent boundaries you set
per spawn:

- **Filesystem** — `workspace` (default): reads are scoped to the agent's own
  workspace + the claude runtime, so it **can't read your home tree** (SSH keys,
  `~/.parachute/operator.token`, other projects); `full`: broad reads. Writes are
  confined to the workspace in both.
- **Network** — `open` (default): full internet; `restricted`: only the
  Anthropic API + your hub/vault + hosts you list.

The default (scoped reads + open network) is safe for your *own* agents because
the filesystem sandbox keeps secrets unreadable — open network can't exfiltrate
what the agent can't see. For an agent that handles **untrusted input**, use
`network: restricted`. This is appropriate for an owner-operated, trusted box;
full multi-tenant isolation is future work.

## Running it

Agent runs alongside the rest of a Parachute install (the
[hub](https://github.com/ParachuteComputer/parachute-hub) is the portal + OAuth
issuer). Until the npm package ships, run it from source:

```bash
git clone https://github.com/ParachuteComputer/parachute-agent
cd parachute-agent
bun install
bun link            # so `parachute start agent` follows this checkout
```

The daemon self-registers into `~/.parachute/services.json` and ships
`.parachute/module.json`, so the hub lists it in the portal and reverse-proxies
`<hub-origin>/agent/*` → the loopback daemon. Reach the web surface at
`<hub-origin>/agent/` (or `http://127.0.0.1:1941/` locally).

| | |
|---|---|
| npm | `@openparachute/agent` (publish pending [#16](https://github.com/ParachuteComputer/parachute-agent/issues/16)) |
| bins | `parachute-agent` (daemon), `parachute-agent-bridge` (session bridge) |
| port | `1941` · paths `/agent` |
| scopes | `agent:read` · `agent:write` · `agent:send` · `agent:admin` |
| state | `~/.parachute/agent/` (`channels.json`, `access.json`, `inbox/`) |

## The web surface

Reachable at `<hub-origin>/agent/`:

- **Home** — your channels + any running agents at a glance.
- **Chat** — talk to a channel. Over a `vault` channel you see the durable
  transcript (markdown rendered); your messages are written back as notes.
- **Agents** — set the Claude credential, then spawn a sandboxed agent bound to a
  channel; list + kill running agents.
- **Terminal** — attach to a running agent's session in an in-page xterm.
- **Config** — add/remove channels (vault / Telegram / http-ui).

## Vault-backed channels

A `vault` channel stores every message as a note carrying **two tags**: the parent
`#agent/message` (queryable membership — list a channel's whole transcript with
one `tag: "#agent/message"` + `metadata.channel` query) and a directional child
`#agent/message/inbound` (human→session) or `#agent/message/outbound`
(session→human). Inbound notes wake the session via a vault trigger; replies are
written as outbound notes. Because the conversation lives in the vault, it's
durable, queryable, and renders in any vault surface — the built-in chat and a
custom surface show the same thread. Full note shape + the trigger setup are in
[`CLAUDE.md`](./CLAUDE.md#vault-integration-stage-2--channels-backed-by-agent-message-notes).

## Connecting a session

A Claude Code session connects to a channel as a pure HTTP MCP server — by URL +
OAuth, like adding the vault:

```bash
claude mcp add --transport http agent <hub-origin>/agent/mcp/<channel>
```

It prompts for OAuth the first time. The session wakes on inbound messages and
replies with the `reply` tool. (A stdio bridge over `/events` + `/api/*` also
works for local/headless launches — see [`CLAUDE.md`](./CLAUDE.md).)

## License

[AGPL-3.0](./LICENSE).
