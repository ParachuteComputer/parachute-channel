# parachute-channel — the channel fabric

**Status:** in progress · started 2026-06-07 · steward: Uni (for Aaron)

The plan to evolve `parachute-channel` from a single Telegram→Claude bridge into a
**channel fabric**: multiple named channels, each routable to a specific Claude Code
session, with the module's own built-in chat UI to prove messaging, scripts to stand
up sessions wired to their channel, and — later — deep vault integration so messages
persist as notes and a UI/runner can drive sessions through the vault.

This redefines the module from the workspace CLAUDE.md's "Channel — webhook fan-out,
exploration, may retire" line into **the agent-session gateway / the vault's nervous
system**. When this firms up, that table row and the committed-core map get updated
(architectural-shift discipline → `parachute-patterns/migrations/`).

## Why now

The June 15 2026 billing change meters `claude -p` / Agent SDK usage on subscription
plans against a small separate credit pool ($20 Pro / $100 Max5x / $200 Max20x at API
rates), while **interactive sessions stay on subscription limits, unchanged**. Our
weave/automation pattern (long-running interactive sessions per vault) is exactly the
shape that survives. The channel is how those resident sessions get a real UI and how
recurring jobs reach them — replacing the `claude -p`-per-job model (which runner keeps
as a second executor for API-key users).

## The architecture

```
                  parachute-channel daemon (one, many channels)
   ┌──────────────────────────────────────────────────────────────┐
   │  named channels, each bound to a transport                    │
   │   • "aaron-dev"    transport: http-ui   (built-in chat page)   │
   │   • "ops"          transport: http-ui                          │
   │   • "tele-aaron"   transport: telegram  (demoted, still works) │
   │   • "vault-default" transport: vault    (Stage 2)             │
   └──────┬───────────────────────────────────┬───────────────────┘
          │       route by channel name        │
   ┌──────▼──────┐                     ┌────────▼─────┐
   │ bridge      │  subscribes:        │ bridge       │ subscribes:
   │ "aaron-dev" │                     │ "ops"        │
   └──────┬──────┘                     └────────┬─────┘
   ┌──────▼──────┐                     ┌────────▼─────┐
   │ CC session  │  (tmux: dev)        │ CC session   │ (tmux: ops)
   └─────────────┘                     └──────────────┘
```

**Core principles**
- **Transport abstraction.** The daemon core (channels, routing, SSE fan-out, permission
  relay) is transport-agnostic. Telegram, http-ui, and (later) vault are interchangeable
  transport impls behind one interface.
- **Routing = subscription.** The daemon hosts named channels; each bridge subscribes to a
  channel by name (`PARACHUTE_CHANNEL_NAME`); the daemon routes inbound on channel X only
  to bridges subscribed to X, and that session's outbound back out X's transport. Daemon
  stays a dumb router; reconnects/restarts are free. **(Decision 1 — resolved: session-side
  subscription, not a daemon-side map.)**
- **One daemon, many channels.** Matches the multi-session design already in the code and
  keeps the built-in UI a single place. **(Decision 2 — resolved.)**
- **MCP channel mechanism is primary.** The existing `notifications/claude/channel` wake is
  the standard, simple path. We verify it works on our Claude Code version up front (Stage 0)
  and do NOT build hook-based workarounds unless that check proves it necessary.
- **Agent-agnostic by construction.** The contract with a session is "read/write the channel
  + be woken." The Claude-specific bridge is one adapter; Codex/Gemini could plug in later.

## Testing discipline (non-negotiable, gate between every stage)

Two tiers, mirroring hub's `e2e/` but realizing the deferred Tier 2:

- **Tier 1 — automated/deterministic.** Unit + integration tests (`bun test`) on routing,
  transport dispatch, channel registry, access control. Plus a scripted e2e (`e2e/run.sh`
  shape) that boots the daemon, attaches a mock bridge, sends through each transport, and
  asserts exact delivery. `bun run typecheck` always alongside `bun test`.
- **Tier 2 — LLM-run e2e (NEW — built here).** Boots the daemon + a **real Claude Code
  session** wired through the bridge, sends a message via the http-ui transport, and an LLM
  judges that a correct, on-topic reply came back through the channel. This is the headline
  test: it exercises the actual wake→act→reply loop end to end. Lives in `e2e/llm/`.
  - Uses `ANTHROPIC_API_KEY` if present (keeps test spend off the subscription credit pool).
  - Positive control first (per negative-scans-need-positive-controls): prove the session
    is alive and the channel is wired before asserting on content.

**No stage is "done" until both tiers pass and a reviewer subagent has signed off.**

---

## Stage 0 — foundation check  ·  ☐

- [ ] Confirm idle-session wake works on our Claude Code version via the existing Telegram
      channel (send to an idle session, verify it wakes). ~30 min. If it fails, that's
      timing info, not a reason to build workarounds — re-decide with Aaron.
- [ ] Pin the Claude Code version under test; note it in this file.

## Stage 1 — the channel fabric (freestanding, no vault)  ·  ☐

**PR 1.1 — transport abstraction + named-channel routing.** ☐
- [ ] Extract a `Transport` interface (inbound → `{channel, content, meta}`; outbound:
      `reply/react/edit/download`). Telegram becomes `transports/telegram.ts`.
- [ ] Daemon hosts a **channel registry** (name → transport + config), loaded from
      `~/.parachute/channel/channels.json` and exposed via `/.parachute/config[/schema]`
      (runner's self-describing-config pattern, so a UI can manage it later).
- [ ] Routing: `/events?channel=<name>` subscribes a bridge; `broadcastEvent` filters by
      channel. Outbound carries channel context.
- [ ] Bridge subscribes via `PARACHUTE_CHANNEL_NAME`; degrade-warn unchanged.
- [ ] **Tests:** routing unit tests (right session gets the message, others don't);
      Telegram path unchanged (regression). typecheck + bun test green.
- [ ] Reviewer subagent.

**PR 1.2 — http-ui transport + built-in chat UI.** ☐
- [ ] `transports/http-ui.ts`: inbound via `POST /api/channels/<name>/send`; outbound
      delivered to the UI over SSE (`/ui/events?channel=<name>`).
- [ ] Minimal built-in chat page served by the daemon (`/ui` or `/ui/<channel>`): channel
      picker + message box + live transcript. No framework needed; vanilla is fine.
- [ ] **Tier 2 LLM-run e2e (headline):** boot daemon + real CC session subscribed to a test
      channel; POST a message; LLM judges the reply. Build the `e2e/llm/` harness here.
- [ ] Loopback-only; no auth in Stage 1 (named in Decision 3; hub-JWT lands when exposed).
- [ ] Reviewer subagent.

**PR 1.3 — session launcher scripts (tmux).** ☐
- [ ] `scripts/launch-session.sh <name> <channel>`: start `claude` interactive in
      `tmux new-session -d -s <name>-agent`, with the bridge wired to `<channel>` in its
      `.mcp.json`. Idempotent (don't double-launch; reattach if up).
- [ ] `scripts/list-sessions.sh` / `stop-session.sh`.
- [ ] Doc the channel→session mapping flow.
- [ ] **Tests:** scripted check that a launched session attaches to the right channel and
      round-trips a message (can reuse the Tier 2 harness with the script as setup).
- [ ] Reviewer subagent.

**Stage 1 done =** launch two sessions in tmux, open two chat pages, type into each, watch
two different Claude Code sessions answer — binding set by config. Demo + both test tiers green.

## Stage 2 — vault integration (vault as another transport)  ·  ☐

- [ ] `#channel-message` note schema: `direction` (inbound|outbound), `thread`, `sender`,
      `body`, `handled_at`. Trigger fires **inbound-only** (loop avoidance via direction
      predicate + existing `_pending_at`/`_rendered_at` idempotency markers).
- [ ] `transports/vault.ts`: activated by a vault trigger webhook on new inbound
      `#channel-message`; writes replies back as outbound notes via the vault REST API.
- [ ] Generalize the vault trigger system from scribe-flavored → inter-module event bus,
      exposed via config-schema so the **vault config UI** grows a Triggers section.
      (Coordinated PR in parachute-vault.)
- [ ] Tag-scoped vault token for the channel (read/write only `#channel-message`).
- [ ] External surface (my-vault-ui) goes dumb: talks only to the vault; persistence +
      offline come free. (Coordinated PR in my-vault-ui.)
- [ ] **Tests:** Tier 1 (trigger fires inbound-only, no reply-loop; note round-trip through
      bytes) + Tier 2 (UI writes a vault note → session wakes via trigger → reply lands as a
      note → UI sees it).
- [ ] Reviewer subagent on each repo's PR. Cross-repo convergence audit.

## Stage 3 — bulk: runner on the bus + hub registration  ·  ☐

- [ ] Runner gains a `channel` executor: a scheduled job writes a recurring inbound
      `#channel-message` note addressed to a session. Falls out of Stage 2's schema; the
      `claude -p` executor stays for API-key users.
- [ ] Channel self-registers with hub (module.json + scope-guard JWT), like runner did.
- [ ] Session lifecycle/supervision: graduate the launcher scripts to a small module or
      fold into hub-as-supervisor **only if the scripts prove insufficient** (decide then).
- [ ] **Tests:** Tier 1 + Tier 2 across the runner→channel→session→vault path.
- [ ] Reviewer subagent. Architectural-shift migration file in `parachute-patterns/migrations/`.

---

## Decisions log
- **D1 routing** — session-side subscription by channel name (not daemon-side map). Resolved 2026-06-07.
- **D2 topology** — one daemon, many channels. Resolved 2026-06-07.
- **D3 http-ui auth** — none in Stage 1 (loopback only); hub-JWT when exposed. Resolved 2026-06-07.
- **D4 wake mechanism** — MCP channel notification is primary; no hook workarounds unless Stage 0 proves necessary. Resolved 2026-06-07 (Aaron).
- **D5 Tier 2 e2e** — does not pre-exist; built here, modeled on hub Tier 1. Resolved 2026-06-07.

## Open questions (non-blocking, revisit at the stage that needs them)
- Per-channel access control for http-ui/vault transports (Telegram's `access.json` is
  transport-specific; the registry may need a per-channel access block).
- Multi-machine: one daemon per vault-host vs. a hub catalog entry routing to the right
  daemon. (Stage 3.)
- Thread/conversation modeling depth for `#channel-message` (flat vs. nested). (Stage 2.)
