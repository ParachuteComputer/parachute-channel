# Agent-to-agent callback routing (`reply_to`) — the orchestrator substrate

**Status:** shipped (2026-06-20, branch `ag-agent-callbacks`). Builds directly on the
thread-as-container substrate (#122) and the pending-inbound queue / replay (#121). No
new transport, no new backend — additive metadata + one new daemon→registry seam.

## The problem

The programmatic backend already lets an agent send a message to ANOTHER agent: write an
`#agent/message/inbound` note to the recipient's channel (via the vault), the recipient's
vault trigger fires, the daemon runs a `claude -p` turn, and a reply is written as an
`#agent/message/outbound` note. That is fire-and-forget. An **orchestrator** agent that
fans out N sub-tasks to N worker agents has no way to learn when each finishes — it would
have to poll the workers' transcripts.

We want **request/response between agent threads**: when an agent sends a message to
another agent and wants to know when it's done, it sets a **callback address** on the
message. When the recipient finishes its turn, the daemon delivers a lightweight
**callback** back to the sender's channel — a NOTIFICATION + a LINK to the result, NOT the
full result duplicated. The sender (an orchestrator) is woken by the callback and PULLS the
full result if it wants.

**Summary + link, orchestrator pulls** (the explicit design choice). Rationale: cleaner
(the callback note stays small + uniform regardless of reply size) and a better security
boundary (the orchestrator reaches for the result through its own vault read scope; the
callback carries only opaque ids, not the recipient's possibly-sensitive output inlined
into the sender's channel).

## The model

### 1. `reply_to` on inbound messages (the SEND side)

An `#agent/message/inbound` note MAY carry these in `metadata` (the vault stores metadata
as strings):

| Field | Meaning |
|---|---|
| `reply_to` | The **sender's channel name** — where to deliver a callback when this turn finishes. A single-threaded agent's channel ↔ thread is 1:1, so an agent knows its own channel = its def name and stamps it here. Absent → no callback (an ordinary turn). |
| `correlation_id` | (optional) An opaque id the sender uses to match a callback to the request it fired. Echoed verbatim onto the callback. The daemon never interprets it. |
| `delegation_depth` | (optional, default 0) How many delegation HOPS deep this message is. Incremented on each callback hop; bounds runaway chains. |

The sending agent sets these when it writes the inbound note to the recipient's channel.
These ride from `note.metadata` → flattened into `meta` by the vault transport's
`ingestInbound` → `contextFor.emit` (daemon.ts) extracts them via `callbackFieldsFromMeta`
→ onto the `QueuedMessage` (`replyTo` / `correlationId` / `delegationDepth`) → available to
the drain (registry.ts). The pending-inbound buffer (#121) carries them too, so a delegated
request that arrives before its recipient agent is live still triggers a callback once the
buffered turn replays on `register()`.

**The SEND side relies on an agent knowing its own channel.** Today that means an
orchestrator agent's prompt/tooling stamps `reply_to: <its own channel>` when it writes the
inbound note to a worker. A dedicated **`delegate` MCP tool** — "send this message to agent
X and register a callback to me" — that fills in `reply_to`/`correlation_id`/`delegation_depth`
automatically is the natural follow-up; this PR ships the daemon-side substrate the tool
would drive.

### 2. The callback on turn-completion (the CORE, daemon-side)

In the drain (`src/backends/registry.ts`), AFTER a turn completes — on **BOTH** `ok` and
`error` (the orchestrator MUST learn about failures; a hung orchestrator waiting on a
dropped failure is the worst outcome) — IF the originating message had `reply_to`, the drain
delivers a callback via the new `WriteCallback` seam:

- The daemon writes a NEW `#agent/message/inbound` note to the `reply_to` channel (so it
  wakes the sender through the NORMAL inbound path — the vault trigger fires, webhooks back,
  the daemon routes it to the sender's agent, exactly as if a human had messaged it).
- **Content:** a brief notification + link, e.g.
  `[callback] <recipientChannel> finished (ok) — see source_message / source_thread …`.
  The full reply is NOT duplicated.
- **Metadata (the contract):**

  | Field | Value |
  |---|---|
  | `callback` | `"true"` — distinguishes a callback inbound from an ordinary one |
  | `status` | `"ok"` \| `"error"` |
  | `source_channel` | the recipient channel/def whose turn finished |
  | `source_thread` | the recipient's per-turn `#agent/thread` id. Resolvable for multi-threaded (the per-fire note leaf); for single-threaded it's a per-turn correlation id, NOT the note leaf — use `source_message` as the reliable pull-link there (resolvable `source_thread` for both modes is tracked in #124) |
  | `source_message` | the recipient's OUTBOUND reply note id, when a reply was produced + delivered (absent on an error / empty turn) |
  | `correlation_id` | echoed from the request when present |
  | `delegation_depth` | incoming depth + 1 |

The callback note carries the inbound tags (`#agent/message` + `#agent/message/inbound`) so
it routes, **BUT never carries `reply_to`** — a callback is terminal.

`source_message` is captured by threading the written outbound note's id back through the
`WriteOutbound` seam (its return type widened to `Promise<{ id?: string } | void>`, fully
back-compat — `void` is a member of the union, so every existing recorder still satisfies it).

### 3. Loop safety (critical)

Three layers, defense-in-depth:

1. **The callback never carries `reply_to`** (structural). Handling a callback can't
   auto-trigger another callback — no ping-pong. Enforced at the daemon wiring AND stripped
   defensively in `VaultTransport.writeCallback` even if a caller widened the shape.
2. **`delegation_depth` ceiling** (`MAX_DELEGATION_DEPTH = 8`). On each hop the depth
   increments; a message arriving at or past the ceiling delivers NO callback (logged
   loudly — a hit means a delegation tree ran away or a cycle formed). This bounds any chain
   even if layer 1 were somehow defeated. The turn itself still runs + records; only the
   onward notification stops.
3. **Unknown / not-live `reply_to` channel** reuses the #122 own-it-don't-strand posture:
   `buildWriteCallback` logs + returns WITHOUT throwing (the recipient's turn already ran +
   recorded; only the notification is lost, and the sender can poll the recipient's thread
   out-of-band). It does NOT crash the recipient's drain.

A callback delivery failure is best-effort like the other sinks — logged, never thrown out,
never re-runs the (already-completed) turn.

## Concurrency correctness (verified, not re-architected)

#122 already gives the guarantee; this PR confirms + tests it. An orchestrator fires N
sub-task messages; the N callbacks return to its single channel. They are handled by the
orchestrator's **per-channel serial drain**: callbacks arrive as inbound notes on the
orchestrator's channel, queue FIFO, and drain ONE at a time — there is never two concurrent
`claude -p` for one channel (the `#draining` single-in-flight-promise invariant), so the
orchestrator's single-threaded `--resume` session carries state across them without
clobbering. A returning callback that lands before its turn finishes queues behind the
in-flight one and drains next. None is lost (the pending buffer / replay covers the
pre-registration window too). A test simulates N callbacks to one channel draining in FIFO
order with `maxConcurrent === 1`.

## What changed

| File | Change |
|---|---|
| `src/backends/registry.ts` | `QueuedMessage` gains `replyTo`/`correlationId`/`delegationDepth`; new `WriteCallback` seam + `CallbackMeta` contract + `MAX_DELEGATION_DEPTH`; the drain calls `maybeDeliverCallback` at all four terminal points; `WriteOutbound` return widened to surface the outbound note id for `source_message`. |
| `src/daemon.ts` | `callbackFieldsFromMeta` (extract + coerce); `contextFor.emit` threads the fields onto the enqueue + pending paths; `buildWriteCallback` (resolve the reply_to channel's transport, own-it on unknown); `buildWriteOutbound` returns the written note id; registry wired with `writeCallback`. |
| `src/transport.ts` | `Transport.writeCallback?` + `CallbackMetadata` (the transport-local mirror of `CallbackMeta`). |
| `src/transports/vault.ts` | `VaultTransport.writeCallback` (writes a callback inbound note, strips any stray `reply_to`); `writeInbound` gains an optional `extraMeta`. |

## Deferred / follow-ups

- A dedicated **`delegate` MCP tool** that fills in `reply_to`/`correlation_id`/`delegation_depth`
  so an orchestrator agent doesn't hand-stamp them (the SEND-side ergonomics).
- Multi-threaded `source_thread` is the per-fire note leaf (an exact link); single-threaded
  `source_thread` is the per-turn correlation id (the deterministic thread note's leaf is the
  def name — the same single-threaded outbound→note-by-stable-path linkage gap that already
  exists for `metadata.thread`). Making `source_thread` a resolvable note id for both modes
  (widen the writeThread seam to return the written id) is tracked in **#124**; until then,
  `source_message` is the reliable pull-link for single-threaded recipients.
- `correlation_id` is opaque end-to-end; no daemon-side request/response registry (the
  orchestrator's own session memory matches replies to requests).
