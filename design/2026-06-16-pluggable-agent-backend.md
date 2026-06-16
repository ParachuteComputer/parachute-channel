# Pluggable agent backend: interactive-tmux vs programmatic-SDK

**Status:** direction (not yet built). Decided 2026-06-16. Companion to
[`2026-06-14-sandboxed-agent-sessions.md`](./2026-06-14-sandboxed-agent-sessions.md)
(the sandbox/isolation model) and
[`2026-06-16-session-environment-and-credentials.md`](./2026-06-16-session-environment-and-credentials.md)
(credential/env injection).

## Why

Today a channel agent is **one specific thing**: an *interactive* Claude Code
process in a tmux pane, fed inbound messages by pushing them into an idle session
over an MCP "development channel." That single choice is the source of an entire
fragility class we've spent real effort taming:

- the session goes **deaf on any daemon restart** and Claude Code doesn't
  auto-reconnect a dropped streamable-HTTP MCP server → the no-loss high-water-mark
  + backlog replay (channel#67) and the per-session restart (channel#68);
- the `--dangerously-load-development-channels` **interactive consent gate** hangs
  a headless spawn → the poll-and-`send-keys` auto-confirm (#71, fixes #70).

All of that exists *because* we drive an **idle interactive** session. It is, as the
operator put it, "hacking a bunch of weird things in."

A second path is now viable: **`claude -p` / the Claude Agent SDK on the
subscription.** Anthropic had gated programmatic use behind a separate metered
credit pool (announced 2026-05-14, effective 2026-06-15) and then **paused it on
2026-06-15** — *"for now, nothing has changed; Agent SDK / `claude -p` / third-party
app usage still draw from your subscription's usage limits"* — with an explicit
commitment to give advance notice before any revised version takes effect. So
programmatic agents
can run on `CLAUDE_CODE_OAUTH_TOKEN` today, with full MCP + tool support and session
continuity (`resume=session_id` / streaming input).

The programmatic path **deletes the whole fragility class**: there is no idle session
to keep alive, so there is nothing to go deaf, nothing to reconnect, no backlog to
replay, no TUI gate to auto-answer. "Wake" becomes "feed the SDK the next message."

## The decision: don't pick one — make the backend pluggable

Define a single seam — an **AgentBackend** — and let a channel choose its backend.
Everything *above* the seam is shared and strategy-agnostic; only the
"drive-the-agent" layer differs.

```
                shared, backend-agnostic
  ┌──────────────────────────────────────────────────────────┐
  │  chat UI  ·  vault message transport (#channel-message)   │
  │  sandbox/isolation  ·  per-channel env/credential inject  │
  └──────────────────────────────────────────────────────────┘
                              │  AgentBackend seam
        ┌─────────────────────┴──────────────────────┐
        ▼                                             ▼
  Interactive (tmux CC)                      Programmatic (Agent SDK)
  - observe / drive a live session           - feed message → stream reply
  - "watch it work" terminal attach          - resume=session_id continuity
  - carries #67/#68/#70 machinery            - NO idle session → no reconnect/
  - most billing-durable (human-driven         replay/gate machinery
    interactive was NOT the billing target)  - ideal for fire-and-forget tasks
```

### What's shared (carries over regardless — not sunk cost)
- **Vault message transport** (`#channel-message/{inbound,outbound}`) + the chat UI —
  the durable conversation store is independent of how the agent is driven.
- **Sandbox/isolation** — the agent runs tools + edits files in either backend.
- **Per-channel env/credential injection** (channel#68) — the SDK process needs
  `GH_TOKEN` etc. exactly as the interactive process does. The
  `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` denylist becomes *more* load-bearing here
  (see Billing).

### What's backend-specific
- **Interactive:** the tmux launch, the dev-channels MCP wiring, the consent-gate
  auto-confirm (#71, fixes #70), the deaf-on-restart no-loss/replay/restart machinery
  (#67/#68). Keep it for "I want to watch/drive a live session."
- **Programmatic:** an Agent SDK session per channel (streaming input, persisted
  `session_id`), MCP wired via the SDK's `mcp_servers` option, tools pre-approved
  (`allowed_tools` / `permission-mode`). No TUI → no consent gates at all.

### Proposed seam (sketch)
```ts
interface AgentBackend {
  start(spec): Promise<AgentHandle>;          // bring an agent up for a channel
  deliver(handle, message): Promise<void>;    // hand it an inbound message
  // outbound flows back through the shared vault transport, not the seam
  stop(handle): Promise<void>;
  status(handle): Promise<{ live: boolean }>; // for /health
}
```
Interactive `start` = the current tmux spawn; `deliver` = push onto the MCP GET
stream. Programmatic `start` = open an SDK session; `deliver` = next streaming-input
turn (`resume=session_id`).

Note the **delivery guarantee is asymmetric**: the interactive `deliver` (push onto
the MCP GET stream) can silently fail if the session is deaf — which is exactly why
`Promise<void>` is safe there only because the #67 high-water-mark + backlog replay
catches the gap. The programmatic `deliver` is a direct turn into a live SDK session,
so failure is observable inline. Whatever the final seam, it must not let the
interactive side's silent-loss footgun leak into the programmatic contract.

## Billing — the load-bearing caveat

- **The subscription reprieve for programmatic use is explicitly temporary** ("for
  now," rework promised with advance notice). The 2026-05 change *specifically
  targeted* Agent SDK / `claude -p` / third-party apps — i.e. the *exact* category
  the programmatic backend lives in. **Interactive, human-driven Claude Code was not
  the target**, which is why interactive is the more billing-durable backend and we
  keep it.
- **`ANTHROPIC_API_KEY` in the env silently overrides subscription auth → metered
  billing** (auth precedence puts it above `CLAUDE_CODE_OAUTH_TOKEN`; it has caused
  surprise four-figure bills). The #68 denylist already blocks it; keep that filter
  explicit and tested in both backends.
- **Verify before committing weight to programmatic:** on the actual deploy box,
  confirm `claude -p`/SDK with `CLAUDE_CODE_OAUTH_TOKEN` draws the *subscription*
  (not API), and that no `ANTHROPIC_API_KEY` is present in the spawn env. Track
  Anthropic's "rework coming" notice and re-evaluate if the split returns.

## Tradeoffs to weigh per backend
| | Interactive (tmux CC) | Programmatic (Agent SDK) |
|---|---|---|
| Fragility | high (reconnect/replay/gate hacks) | low (no idle session) |
| Watch-it-work terminal | native (tmux attach) | needs rebuild (stream SDK output to the in-page terminal) |
| Billing durability | higher (not the billing-change target) | lower (the explicit target; reprieve is "for now") |
| Best for | observe/drive a live session | fire-and-forget "do a task, report back" |
| Continuity | free (long-lived process) | `resume=session_id` / streaming input |

## Phasing
1. ~~Keep **interactive as the default** backend~~ — **SUPERSEDED (2026-06-16):** once
   the programmatic backend landed + was live-verified, the operator chose to make
   **programmatic the default** and gate interactive behind an "Advanced" affordance
   (it's the buggier path, kept available to "bring back out" if Anthropic's SDK
   pricing change returns). New spawns default to programmatic; existing persisted
   interactive specs are preserved via the context-split default (see #76 /
   `interpretPersistedBackend`).
2. Extract the **AgentBackend seam** without changing interactive behavior.
3. Build the **programmatic backend** behind the seam; reproduce the watch-it-work
   view by streaming SDK output into the in-page terminal if we want parity.
4. Evaluate on real use (billing draw, latency, ergonomics); let channels opt into a
   backend. Don't rip out interactive — the two serve different jobs and hedge the
   billing uncertainty.
