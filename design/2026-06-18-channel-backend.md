# The `channel` backend — deliver agent turns to a Claude Code session you run

**Status:** design (2026-06-18, with Aaron). Evolves the post-programmatic direction
([`2026-06-16-channel-architecture-post-programmatic.md`](./2026-06-16-channel-architecture-post-programmatic.md))
and the pluggable-backend seam ([`2026-06-16-pluggable-agent-backend.md`](./2026-06-16-pluggable-agent-backend.md)).

## The model (Aaron, corrected 2026-06-18)

An agent (a `#agent/definition`) is the only first-class unit. Its **backend** is the
axis, and there are exactly **two**:

- **`programmatic`** — the daemon runs each turn headless via `claude -p --resume`
  (sandboxed, always-on, the default).
- **`channel`** — the turn is delivered over a channel to a **Claude Code session you
  run yourself** (your machine, your env/creds/context, unsandboxed) and have connected
  to the channel. The daemon doesn't run the turn; your session does, and the reply
  flows back as the outbound note.

It is **`programmatic` vs `channel` — NOT `programmatic` vs `interactive`.** The old
**`interactive` (tmux + MCP-push) backend is RETIRED** (see §"Retiring interactive"):
it puppeted a terminal with send-keys / pushed onto an idle MCP GET stream to fake
message injection — "not how it's meant to work," and the carrier of the whole
deaf-on-restart / backlog-replay / reconnect fragility class. **`channel` is what
interactive was reaching for, done right:** the session *natively subscribes and
pulls* via MCP; no tmux, no send-keys, no push, no idle-wake.

The spectrum this creates: **always-on headless workers** (`programmatic`) ↔
**run-in-my-full-power-session-when-I'm-around** (`channel`). Same vault-native fabric
(`inbound #agent/message → turn → outbound #agent/message`), different executor.
`channel` also inherits the interactive backend's **billing-hedge** property — if
programmatic `-p`/SDK ever moves off the subscription, "run your own subscription
Claude Code and connect it to the channel" is the durable fallback — without the tmux
hack.

## What `channel` IS, concretely

A `channel`-backend agent's inbound messages **accumulate as a durable queue** (the
`#agent/message/inbound` notes themselves — the vault IS the queue). The agent runs no
`claude -p`. Instead, **your Claude Code session connects to the channel's MCP
endpoint** and:

1. **pulls** the next unhandled inbound message (an MCP tool),
2. does the work in your session (full tools, your env, unsandboxed, your machine),
3. **replies** (an MCP tool) → the daemon writes the `#agent/message/outbound` note
   (the same durable outbound path the programmatic worker + the old interactive
   `reply` tool use — shows in the chat UI, threads `inReplyTo`) and marks the inbound
   handled.

No turn runs in the daemon; revocation/idle/restart are non-issues (there's no
resident agent process and no pushed stream to miss). If your session is offline, the
queue simply waits — `channel` is "handle when I'm around," by design.

## The MCP-pull protocol (the channel's MCP surface)

The channel exposes an MCP endpoint your session connects to:
`<hub>/agent/<channel>/mcp` (rides the existing `/agent/*` hub proxy; authed with a
**hub-issued token scoped to that channel** — the seam: hub owns identity, the agent
module owns the channel/queue). Tools:

- **`pending`** (resource or tool) — how many inbound messages await + a peek (ids +
  previews). Lets a session/hook show "N messages waiting."
- **`next-message`** — claim + return the oldest unhandled inbound (id, text, thread
  context, the agent's system prompt so the session adopts the agent's persona). Marks
  it **in-flight** (so two connected sessions don't double-handle).
- **`reply`** `{ inReplyTo, text }` — write the outbound `#agent/message/outbound`
  note (via the channel transport's `reply()`), mark the inbound **handled**.
- **`release`** (optional) — un-claim an in-flight message (the session is giving up;
  it returns to pending). In-flight messages auto-release after a TTL so a crashed
  session doesn't strand the queue.

The session adopts the agent's persona by reading the system prompt `next-message`
returns (the `#agent/definition` body) — so "being" the agent is just: pull, prepend
the agent's prompt as context, work, reply. **Adopting the persona is the session's
responsibility, not protocol-enforced** (reviewer NIT) — MCP can't force a system
prompt on the caller. The channel MCP's server `INSTRUCTIONS` string reinforces the
convention ("treat the returned `systemPrompt` as your instructions for this reply");
in the trusted-operator model that's sufficient.

## Connecting a session — "make it really easy" (Aaron)

One step, the same ease we built for the interactive attach:

- **`parachute agent channel connect <channel>`** (CLI) — mints a channel-scoped
  hub token and writes the MCP server entry into the operator's chosen Claude Code
  scope (project `.mcp.json` or user settings): `{ "<channel>": { type: "http", url:
  "<hub>/agent/<channel>/mcp", headers: { Authorization: "Bearer <token>" } } }`.
  Prints what it did + how to disconnect, **and surfaces the token's TTL** (the hub's
  non-ephemeral default is ~90d) so the operator knows when to re-`connect` — a silently
  expired token otherwise gives an opaque 401 (reviewer NIT). Reuses the existing
  mint+write pattern (`launch-session.sh` already writes an HTTP-server-config-with-Bearer).
  (Also offered as a copy-paste snippet from the channel's admin page, for sessions on
  another machine.)
- Optionally a tiny **SessionStart / periodic hook** the connect step can install that
  calls `pending` and surfaces "you have N channel messages" so you don't have to
  remember to check. (Pull stays the mechanism; the hook is just a nudge.)

Push is deliberately NOT attempted — Claude Code has no standing inbound socket, so
"push" would really be "notify, then pull" anyway. MCP-pull embraces that honestly.

## The flow

```
inbound (chat / vault note / scheduled job)
  → #agent/message/inbound note (the durable queue; backend:channel agents run NO claude -p)
your Claude Code session  ── connected to <hub>/agent/<channel>/mcp (channel-scoped token) ──▶
  ── next-message ──▶  claim oldest unhandled inbound (+ the agent's system prompt)
  ── (work in your session: full tools, your env, unsandboxed) ──
  ── reply { inReplyTo, text } ──▶  daemon writes #agent/message/outbound (threads + chat UI)
                                    + marks the inbound handled
```

Same inbound/outbound notes as programmatic — a channel agent and a programmatic agent
are indistinguishable to the rest of the fabric (chat UI, threading, runner jobs). Only
the executor differs.

## Backend selection + the async shape (daemon routing fork)

**The channel backend does NOT slot into `ProgrammaticAgentRegistry`** — that registry's
drain worker reads `deliver()`'s `reply` synchronously and owns the outbound write. A
channel agent has no synchronous turn and its outbound is written by the MCP `reply`
tool, so reusing that worker would double-write (worker + tool) or silently drop the
reply (worker sees an empty `deliver` result). So the fork is at the **daemon router**,
not inside a shared registry (reviewer BLOCKER):

```
inbound #agent/message/inbound  →  daemon router, by the def's backend:
   backend: programmatic  →  ProgrammaticAgentRegistry.enqueue → serial worker runs
                             claude -p, deliver()→reply, worker writes the outbound note
   backend: channel       →  ChannelQueueRegistry (NEW): the inbound note IS the queue
                             item; NO worker, NO deliver()-for-reply. The connected
                             session pulls via MCP + the MCP `reply` tool writes outbound.
```

So `channel` agents go through a **new `ChannelQueueRegistry`** (a queue + claim
tracker + the MCP surface), entirely bypassing `ProgrammaticAgentRegistry`. The
`AgentBackend.deliver→reply` seam is **not used** on the channel path — the channel
backend's role is just `start(spec)` (register the channel + its queue with the
router); there is no in-process `deliver`-produces-reply. (If a uniform `AgentBackend`
shape is wanted, a channel `deliver` would be a pure *enqueue* returning `{ok:true}`
with no `reply` — but the daemon must route channel inbound to the channel registry
**before** any programmatic-worker enqueue; the seam fit is cosmetic, the routing fork
is load-bearing.)

This is a genuinely **async** backend: the reply arrives out-of-band when a session
pulls + replies; nothing in the daemon waits on it.

## Claim/ack durability — committed to note-metadata

Claim state lives on the inbound note, not in `delivery-state.json` (reviewer
SHOULD-FIX — `delivery-state` only holds a per-channel high-water timestamp, no
per-message claim, and a file-only claim is lost on restart). The
`#agent/message/inbound` note carries a **`status: pending | in-flight | handled`**
field:
- `next-message` claims the oldest `pending` → sets `in-flight` + `claimedAt` (vault
  PATCH, `force:true` per the 4a precondition). Returns nothing-to-do when none pending.
- `reply` writes the outbound note **then** sets the inbound `handled`.
- **Restart-safe:** the vault is the source of truth — an `in-flight` claim survives a
  daemon restart; nothing is re-presented that was already `handled`.

**TTL auto-release:** a daemon heartbeat (the existing periodic tick) scans `in-flight`
notes whose `claimedAt` is older than **15 min** and resets them to `pending` (so a
crashed/abandoned session can't strand the queue). Re-presenting is just "it's `pending`
again." 15 min comfortably covers a real operator turn; tune if needed.

## Retiring interactive

The `interactive` (tmux) backend + its quarantined carrier weight (no-loss
high-water-mark / backlog replay #67, per-session restart #68, the
`--dangerously-load-development-channels` consent auto-confirm #71, the
`notifications/claude/agent` MCP idle-wake/push transport) are **retired** —
`channel` supersedes the human-driven-CC need they hedged, without the fragility.
- `parseAgentDef` already rejects `backend:interactive` for vault-native agents; now
  **drop `interactive` as a selectable backend** everywhere (registry, create-agent
  flow, docs). 
- **Park, don't delete, the PTY/terminal code** (`spawn-agent.ts` + the terminal
  transport): per Aaron it gets **repurposed later** (lower priority) into proper
  **terminal/process management in the Parachute interface** — a general capability
  (spin up a Claude Code session, or anything), decoupled from the agent backend. Move
  it behind a clear "parked: future terminal-mgmt" boundary (or a `_parked/` location)
  so it's not maintained as a live backend but isn't lost.
- `mcp-http.ts` is split, not wholesale dropped (reviewer NIT — it conflates two
  pushes):
  - **RETAIN `pushToChannel`** — it's load-bearing for the **programmatic streaming
    view** (interim turn text → live chat), unrelated to interactive.
  - **RETAIN** the HTTP-MCP plumbing + auth (the channel-pull surface reuses it).
  - **RETIRE** the interactive-only machinery: the `notifications/claude/agent`
    **idle-wake** (no idle session to wake on the channel path) and the
    **backlog-replay** (`replayBacklog` / `onSessionConnect` / `fireConnectReplay` —
    there's no deaf-on-restart problem; the durable note queue + claim status replaces it).

## Security / boundary

- **The session is the operator's own** (full trust — their machine, their creds). The
  daemon never spawns or controls it; it only queues + serves messages. No host-shell
  exposure originates from the agent module.
- **The channel token is hub-issued + channel-scoped** — it can pull/reply for exactly
  that channel, nothing else (seam: hub = identity/issuance; agent module = the channel
  resource server validating the token). Revoke = the session loses access on its next
  call (same posture as every other hub-issued token).
- **`channel` is a MODE inside the agent module**, not a new module and not hub logic —
  validated by the 2026-06-18 boundary audit (execution topology + the queue are
  agent-domain; the hub provides identity + the `/agent/*` transport).
- In-flight claim TTL + single-claim semantics prevent a crashed/duplicate session from
  stranding or double-handling the queue.

## Build phasing

1. **`channel` backend + queue** — the backend kind, the daemon routing (enqueue, no
   `claude -p`), the durable pending/in-flight state (extend `delivery-state`).
2. **The channel MCP surface** — `pending` / `next-message` / `reply` / `release`
   tools on `<hub>/agent/<channel>/mcp`, channel-scoped-token auth. (Reuse the HTTP-MCP
   plumbing; drop the push path.)
3. **`parachute agent channel connect`** — mint the channel token + write the session's
   MCP config; the copy-paste snippet on the channel admin page; the optional pending
   hook.
4. **Retire interactive** — drop it as a selectable backend; park the PTY code behind a
   clear boundary; remove the quarantined push/replay weight.
5. **Create-agent UX** — `backend: channel` in the create-agent flow + the admin UI
   (pick programmatic vs channel; for channel, surface "connect your session").

1–2 are the core (an agent can be handled by a connected session end-to-end). 3 is the
ease-of-use. 4 is the cleanup the model enables. 5 is the surface polish.

## Real-path verification plan

Define a `backend:channel` agent; connect a *real* Claude Code session (this one, or a
second) to `<hub>/agent/<channel>/mcp`; send an inbound (chat/note); confirm the session
sees `pending`, `next-message` returns it (+ the agent's system prompt), a `reply`
writes the outbound `#agent/message/outbound` note that shows in the chat UI + threads
correctly; confirm a second connected session doesn't double-handle (claim semantics);
confirm an unhandled message survives a daemon restart (durable queue); confirm the
channel token only works for its channel. (Per the real-path lessons — verify through
the actual hub-proxied MCP path, not just a daemon-direct probe.)

## Open / forks (flag for Aaron)

- **One channel : many agents, or one channel : one agent?** Leaning **one channel per
  agent** (the channel IS the agent's conduit; simplest) — but a single "my-laptop"
  channel that *several* agents route into (you pull a mixed queue, each message
  carrying its agent's persona) is also coherent and maybe nicer ergonomically. Start
  one-per-agent; the MCP surface is the same either way (a multi-agent channel just
  tags each message with its agent). **Which do you want first?**
- **Claim/ack durability** — track in-flight in `delivery-state` (file) vs purely via
  note metadata (`status: in-flight/handled` on the inbound note). Note-metadata is
  more vault-native + survives anything; `delivery-state` is faster. Lean note-metadata.
- **Auto-fallback** — if a channel agent's session is offline for N hours, optionally
  fall back to a programmatic turn? Probably **no** (defeats the "my session" intent) —
  leave it queued. Flag only.
