# Agent UI v2 + the reactivity connectors

**Status:** design-of-record (2026-06-18, with Aaron). Two coupled threads: (1) make
vault changes flow LIVE into the agent module (the "connectors"); (2) collapse the
agent module's six server-rendered HTML pages into one agent-centric SPA. (1) gates (2).

## Part 1 — Reactivity: the vault is the source of truth; subscribe, don't poll-at-boot

### Current state (investigated, file-referenced)
Only **inbound messages** are reactive. Everything else converges on a **timer, not a
trigger**:

| Change | Reactive today? | Mechanism | Latency |
|---|---|---|---|
| `#agent/message/inbound` | **Yes** | hub-provisioned vault trigger → `POST /api/vault/inbound` → `ingestInbound` | instant |
| `#agent/definition` **create** | **No** (poll) | `loadAll()` re-lists each tick; the `/api/vault/agent-def`→`reload()` fast path is **dead code** (no trigger provisioned) | ≤ 60s |
| `#agent/definition` **edit** | **No** (poll) | same `loadAll`/`reload` path, unwired | ≤ 60s |
| `#agent/definition` **delete** | **No** (poll) + **structurally blocked** | `pruneRemovedDefs` diff; vault triggers can't subscribe `deleted` (`triggers-api.ts:124-133`), hub rejects `note.deleted` (`admin-connections.ts`) | ≤ 60s |
| `#agent/job` **cron edit** | **No** (poll, by design) | `Runner.tick()` re-queries every 30s + reseeds the horizon | ≤ 30s |

**"ch-verify needed a restart" explained:** it didn't, strictly — the reactive fast
path is dead code, so a new def converges only via the 60s `loadAll` poll (or a
restart's boot `loadAll`). It was checked inside the 60s window, so it *looked* like
restart-required. The instinct was right: **the reactive trigger genuinely does not fire.**

### The connectors needed (ride the hub Connections engine — the boundary seam)
The hub provisions vault triggers (`buildVaultTrigger` → `POST <vault>/api/triggers`);
the module declares the sink (a `vault-trigger` action in `.parachute/module.json`);
provisioning is operator-driven (the admin "click is the approval").

- **Connector 1 — `#agent/definition` create+edit reactive.** *Wiring, not building —
  the webhook (`/api/vault/agent-def`) + `reload()` per-note re-instantiate already
  exist.* Add a `definition.reload` action + a `connectionTemplate` on `note.created`
  **and** `note.updated` filtered `tags:[#agent/definition]`; provision it. Keep the
  60s `loadAll` as a documented safety net. **Phase 0 — do first; it gates the UI.**
- **Connector 2 — `#agent/definition` delete reactive.** *Platform-blocked:* vault +
  hub must add `deleted` to allowed trigger events + a `vault.note.deleted` source
  mapping. The module's `reload(...,"deleted")` deregister path is ready. Until then
  delete is poll-only (≤60s) — acceptable. Tracked as a vault+hub follow-up.
- **Connector 3 — `#agent/job` cron reactive.** *Greenfield (no job webhook).*
  **Recommendation: don't, unless the UI demands instant next-run feedback** — 30s is
  fine for cron-grain; the runner is intentionally clock-driven.

### The general pattern (audit elsewhere)
Anywhere a module materializes vault notes into live runtime state — defs→registry,
jobs→schedules, inbound→sessions — it needs a **trigger+webhook pair, with the poll as
an explicit documented safety net, not the silent primary path.** Read-at-boot + a long
poll *hides* the missing trigger (it converges, so it looks like latency). Same class as
[[feedback_static_vs_dynamic_state]]. Worth an audit pass across vault/scribe/surface.

## Part 2 — Agent UI v2: one agent-centric surface

Collapse the six HTML pages (Home · Chat · Agents · Schedules · Terminal · Config) into
**one SPA where the `#agent/definition` is the only first-class unit.** Channels,
transports, and backends become *attributes of an agent*, not sibling pages.

**UNIFY** — Home+Agents+Config → one "Agents" view (list every backend: backend ·
channel/transport · schedule · queue/connection state · credential scope, one detail
panel); create-agent + Config/manage-channels → one create flow (channel provisioning
becomes a step, not a sibling page — the blueprint's explicit goal); the two "Vault"
pickers → one model (channel backing-store vs read/write scope is the same in the 1:1
default; split only in Advanced); `GET /api/agents` lists ALL backends (stop rejecting
`channel`, #102).

**NEWLY SURFACE** — backend as the primary axis `programmatic | channel` + the
channel-backend **"connect your Claude Code session"** UX (mint channel-scoped token,
render the `claude mcp add` one-liner, show queue depth); the module-level **def-vault
list** (`agent-vaults.json` — today invisible/uneditable: which vaults define agents,
add/remove, token status) via new `GET/POST/DELETE /api/agent-vaults`; vault-native
`#agent/definition` list/create/edit/delete (body=system prompt, metadata=config) via
`GET /api/agent-defs` + a write path (or the SPA writes def notes via the vault REST API
with a minted token); the agent↔channel↔schedule relationship in one place.

**RETIRE** — `interactive` from the create form (keep `/terminal`+xterm as a low-pri
off-nav attach tool); the standalone Config/manage-channels page (folded into create);
the server-rendered-HTML-string idiom (`agents-ui.ts` 62KB, `admin-ui.ts` 55KB); the
create-form duplication (dup vault pickers, the programmatic|interactive select).

### SPA, not daemon-HTML
The hub + surface admins are SPAs; consistency + the v2's interactivity (live list,
queue depth, connect-flow state, inline def editing) argue for it — the 62KB inline-HTML
idiom handles this badly. Architecture: **daemon exposes a clean JSON `/api`, serves a
built bundle.** Reuse the hub/surface admin SPA scaffold (don't greenfield a framework).
Fallback if the lift stalls: land the API + model-unification first, migrate pages
incrementally behind the new API.

### Dependency: Part 1 gates Part 2
A UI that edits vault-backed agents is only coherent if edits flow live — else every
save looks broken (the ch-verify confusion, in the operator's face). **Connector 1 is a
hard prerequisite for the def-authoring UI** (cheap → do first). Connector 2 (delete) is
*not* a blocker (ship with a ≤60s delete-convergence note). Connector 3 optional.

## Execution lifecycle: everything is a thread

**The unified model: `definition -> thread -> message`.** EVERYTHING is a thread. A
`#agent/definition` instantiates an agent; each agent runs THREADS; each thread holds
MESSAGES (the conversation turns). A "run" was always just a thread with one turn — so the
term retires, the `#agent/run` note becomes the `#agent/thread` note, and **BOTH execution
modes materialize a thread note** (the structural unification). A `#agent/thread` note is
the durable, queryable record of one thread; its BODY holds a rolling SUMMARY of the
thread (a future summarizer agent may own/enrich the `## Summary` slot — module-owned in
v1), and its metadata carries the thread state (`channel`, `definition`, `mode`, `status`,
`started_at`, `last_turn_at`, `turn_count`, cumulative `usage`). The indexed
`status`/`definition`/`mode` fields make threads operator-queryable.

A `#agent/definition`'s `metadata.mode` declares its EXECUTION-LIFECYCLE shape — how a
turn relates to the agent's thread, and the thread note's IDENTITY. An agent is one of
exactly two kinds (defined by `claude -p` session-id semantics):

- **`single-threaded`** (DEFAULT; = today's behavior) — ONE persistent session per
  channel. Each turn `--resume`s the stored session id and persists the returned id; the
  **channel transcript IS the conversation**. It materializes exactly ONE `#agent/thread`
  note per channel, **named after the definition** (the deterministic stable path
  `Threads/<channel>/<name>`), UPSERTED in place across turns — the body holds a rolling
  summary, and `turn_count` + cumulative `usage` roll up each turn. A scheduled job for a
  single-threaded def is a synthetic inbound that resumes that one thread (continuing the
  chat) + upserts its one thread note.
- **`multi-threaded`** — turns are THREAD-KEYED. Every fire mints a fresh thread, runs an
  independent turn, and materializes ONE `#agent/thread` note **per fire**
  (`Threads/<channel>/<uuid>`; `turn_count` 1; usage = this fire's). Its per-fire
  observability record (input + reply + status + timing).

The thread note is the PRIMARY record of the turn, written BEFORE the additive outbound
transcript write (the c34db03 ordering, now applied UNIFORMLY to both modes) so the turn's
record survives an outbound failure. It carries `['#agent/thread']` EXACTLY — never a
message tag — so it can never wake a session (loop safety).

**The retired term.** "one-shot" was never its own mode — it was only ever the
**degenerate first turn of a multi-threaded agent**, so the name retires. The parser
DUAL-ACCEPTS the legacy values (`resident`→`single-threaded`, `one-shot`→`multi-threaded`,
`per-thread`→`multi-threaded`), mapping silently, so already-authored def notes keep
working with no migration.

**Ships now in its degenerate form.** TODAY no inbound carries a thread id, so a
multi-threaded agent mints a FRESH thread on every fire (no `--resume` read; the returned
session id is NOT persisted to the channel store), and the single-threaded thread-note
aggregates are computed by READING the existing note then writing — SAFE because the drain
is serial per channel and single-threaded is one-thread-per-channel today. The **deferred
continuation increment**: thread-id routing on the inbound, a thread-keyed session store,
per-thread drain serialization, message-level per-turn usage, and recording the minted
session/thread id into the thread note so a specific prior thread becomes resumable (at
which point single-threaded's read-modify-write aggregation switches to re-deriving from
the `#agent/message` children or a vault atomic-merge, to avoid lost-update). When that
lands, the SAME mode gains continuation **with no operator-facing change and no
migration** — the fresh-per-fire shape that ships now is simply its degenerate case.

## Phased build order
- **Phase 0 — Connector 1** (def create+edit reactive): manifest `definition.reload`
  action + `created`+`updated` template; provision; verify a def edit reflects live.
  *Small; unblocks everything.*
- **Phase 1 — API layer:** `GET /api/agent-defs` + def write path; `GET/POST/DELETE
  /api/agent-vaults`; `GET /api/agents` includes all backends (#102). Independently
  valuable; de-risks the SPA.
- **Phase 2 — SPA shell + unified Agents view** (port the hub/surface scaffold; one
  list-all-backends + detail panel on the Phase-1 API; Home becomes the Agents list).
- **Phase 3 — Unified create flow** (collapse create + Config; channel provisioning a
  step; retire `interactive` + dup pickers). **Folds in channel-backend design phases
  3–5** (the MCP-pull connect UX, `claude mcp add` one-liner, queue depth) — this is
  where you pick `backend:channel` and need the connect affordance.
- **Phase 4 — Def-vault config + schedules + cleanup** (the `agent-vaults.json` editor;
  fold Schedules into the agent detail; retire the standalone Config page + the inline
  HTML; demote `/terminal` off primary nav).
- **Phase 5 (optional) — Connector 3** (only if instant cron-edit feedback is needed).

**Key files:** manifest `.parachute/module.json` (add `definition.reload`); webhook
`src/daemon.ts:2819-2871`; reload path `src/agent-defs.ts:735-768`; backend rejection
`src/agents.ts:378-381` (#102); UI to replace `src/{agents,admin,home,jobs,terminal}-ui.ts`,
nav `src/ui-kit.ts`; hub seam `parachute-hub/src/admin-connections.ts`; vault trigger
constraints `parachute-vault/src/triggers-api.ts:124-133`. Channel-backend design:
[`2026-06-18-channel-backend.md`](./2026-06-18-channel-backend.md).
