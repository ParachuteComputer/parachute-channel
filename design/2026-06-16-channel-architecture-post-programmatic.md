# Agent architecture, post-programmatic shift — a fresh look

**Status:** direction (2026-06-16). Written after the agent's center of gravity moved
from **interactive** (a live Claude Code in tmux you attach to) to **programmatic**
(each message answered by a sandboxed `claude -p --resume` turn). Companion to
[`2026-06-16-pluggable-agent-backend.md`](./2026-06-16-pluggable-agent-backend.md),
[`2026-06-16-agent-filesystem-and-sharing.md`](./2026-06-16-agent-filesystem-and-sharing.md),
[`2026-06-16-session-environment-and-credentials.md`](./2026-06-16-session-environment-and-credentials.md),
and `2026-06-16-channel-system-prompt.md` (lands with #79).

## What a channel IS now

A **vault-backed conversation** + a **programmatic agent** that answers each inbound
message as one scoped `claude -p --resume` turn whose reply is written back as an
outbound `#channel-message` note. The agent is defined by four orthogonal axes:

> **backend × workspace × system-prompt × credentials**

That's the whole thing, and it's what **runner** will build on (a runner job = pick a
workspace + backend + system prompt + scoped credentials, triggered by a job note).
No persistent process between turns → no deaf-on-restart, no reconnect, no replay.

## What's now carried weight (quarantined, not deleted)

These exist *only* to serve the gated **interactive** backend; none is load-bearing
for the default programmatic path anymore:

- no-loss high-water-mark + backlog replay (#67)
- per-session restart (#68)
- the `--dangerously-load-development-channels` consent auto-confirm (#71, fixing issue #70)
- the MCP idle-wake / reconnect transport (the `notifications/claude/agent` push to an
  idle HTTP-MCP session; serves the interactive path — the programmatic backend is
  stateless per turn and needs none of it)

**Keep them** — interactive is the billing hedge (if Anthropic moves programmatic
`-p`/SDK off the subscription, interactive human-driven CC is the durable fallback) —
but recognize them as *quarantined complexity*. Don't invest further there; if
interactive is never used in practice, they're a clean future deletion.

## The terminal: split the two needs it conflated

The terminal existed to **attach to the live interactive tmux session**. Programmatic
has nothing to attach to. But it was fusing two genuinely separate needs:

1. **Watch the agent work** → the programmatic-native answer is to **stream the turn's
   `stream-json`** (interim assistant text + tool calls) into the chat UI. The backend
   already parses that stream to extract the reply; surfacing it live is the real
   "watch it work," in the chat where it belongs — *better* than a terminal for this.
2. **A human shell in the workspace** → independently useful, more so with the
   workspace seam + runner (a channel works from a real dir; you want to inspect/run
   things there). Reframe the terminal as a **sandboxed workspace shell** — confined to
   the channel's workspace under the same fs/egress policy as agents — NOT an
   agent-attach and NOT a raw host shell.

So: don't delete the capability — **repurpose** (workspace shell) and **add streaming**
(agent-watching). They stop being the same feature.

## Security: the admin panel is the real boundary

With agents well-sandboxed, the dominant residual risk is the **admin panel itself**:
one session can set credentials (→ exfiltrate tokens), spawn a `filesystem: full`
agent (→ read the disk), or open a terminal (→ raw host shell). A *raw host* terminal
is the one surface strictly more powerful than everything else — which is why the
terminal reframe is **sandbox it** (a workspace-confined shell is no more powerful than
a workspace agent). Beyond that, the bigger lever is **step-up auth** (a PIN /
re-confirm) on the genuinely dangerous actions — terminal, set-credentials, full-fs
spawn — tracked as **#80**. That's primarily a hub-auth concern (it should cover all
admin surfaces), with agent a consumer.

## Build order

1. **Streaming view** — surface each programmatic turn's `stream-json` (interim text +
   tool calls) into the chat UI. The watch-it-work win; reclaims what the terminal gave,
   programmatic-native.
2. **Workspace seam** — the `workspace` host-path on the spec (see the filesystem note);
   lets a channel work from a real dir, shared with runner jobs.
3. **Step-up auth** (#80) — cross-cutting with hub.
4. **Terminal → sandboxed workspace shell** — repurpose, confined to the workspace.

Items 1–2 are agent-local and unblock runner; 3 is cross-cutting; 4 is the terminal
disposition once the workspace seam exists.
