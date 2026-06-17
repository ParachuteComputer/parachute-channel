# Runner — scheduled agent turns (narrow, in-module)

**Status:** built 2026-06-17. Phase 2 of the Parachute Agent consolidation (`2026-06-17-parachute-agent-blueprint.md` §Sequencing step 2). Builds on the programmatic backend (`2026-06-16-pluggable-agent-backend.md`) and the vault transport's inbound→turn→outbound mechanism.

## The idea (start narrow)
A **scheduled job** is *an automated human*: "send message M to agent A on schedule S." Per the blueprint, the runner is **in-module** and **the agent is always the unit of work** — the runner does not execute anything itself; it just *authors an inbound message on a schedule*, and the existing agent-turn machinery does the rest. Aaron's steer: **"Let's start runner narrow."** So Phase 2 is *scheduled messages*, nothing more. The `tag:job` event-trigger flavor is a deliberate future extension (§Later), not in this phase.

## One mechanism (no new path)
A fired job writes an **inbound note** exactly like a human typing in chat — same tags, same metadata, same durability. There is **no special-case turn path**: the note lands in the vault (durable, queryable, visible in the transcript), the channel's already-registered vault trigger fires, and the turn runs. The runner is indifferent to backend (programmatic/interactive) because it never touches the turn — it only authors notes.

## Anatomy of a job
Persisted in `~/.parachute/channel/jobs.json` (0600, read-modify-write — same pattern as `channels.json`/`credentials.json`; vault-native job storage is the blueprint's *later* phase):
```jsonc
{ "jobs": [ {
  "id": "morning-standup", "channel": "uni-dev",
  "message": "Run the morning weave…",
  "schedule": { "cron": "53 7 * * *", "tz": "America/Los_Angeles" },
  "enabled": true, "createdAt": "…", "lastRunAt": "…",
  "lastStatus": "ok" | "error: …", "nextRunAt": "…"
} ] }
```
- **`channel` must be a vault channel** (the inject path is "write an inbound note," which only a vault transport has). Telegram/http-ui are rejected with a clear error. The default agent is vault-backed.
- **`schedule`** — a 5-field **cron** expression (`min hour dom mon dow`) plus optional IANA `tz` (default: daemon local tz). Small dependency-free evaluator (`src/cron.ts`): `*`, `*/n`, ranges (`a-b`), lists (`a,b,c`). No seconds, no macros in v1.

## Components
1. **`src/jobs.ts`** — registry: `readJobsFile`/`upsertJob`/`removeJob` (mirrors `registry.ts`), plus `validateJob` (slug, known channel, vault-transport check, cron parse).
2. **`src/cron.ts`** — `parseCron(expr)` + `nextRunAfter(expr, tz, from)`. Pure, unit-tested.
3. **`src/runner.ts`** — the scheduler. One `setInterval` tick (default 30s) checks each enabled job; if due, fire, set `lastRunAt`/`lastStatus`, recompute `nextRunAt`, persist. **Injectable clock + fire fn + tick scheduler** for deterministic tests. Catch-up = **fire-once-on-miss** (no stampede). Idempotent under overlap (skip a job already mid-fire).
4. **Fire = inject inbound.** `VaultTransport.injectInbound({ content, sender })` — sibling of `reply()` writing `[#channel-message, #channel-message/inbound]`, `metadata: { channel, direction: "inbound", sender: "runner:<jobId>", ts }`, NO `channel_inbound_rendered_at`. Reuses the channel's existing `vault:<name>:write` token.
5. **API** (`channel:admin`): `GET /api/jobs`; `POST /api/jobs {id,channel,message,schedule,enabled?}` (400 on bad cron / unknown / non-vault channel); `DELETE /api/jobs/:id`; `POST /api/jobs/:id/run` (fire now).
6. **UI** — a **Schedules** panel: list (channel · cron · next-run · last-status), add form (agent picker → message → cron field + presets like "daily 8am"/"hourly"), enable/disable, delete, "Run now." Reuse `ui-kit` shell + the hub-minted `channel:admin` token bootstrap.

## Why correct + safe
No new authority (uses the channel's existing write token, no hub round-trip). No loop risk (only writes inbound; trigger never matches outbound). Durable + visible (real vault note; high-water-mark/backlog-replay apply unchanged). Deterministic tests (clock/tick/fire injected; cron pure).

## Boundaries (NOT in Phase 2)
Not `tag:job` event triggers; not script execution (an agent runs the script — the runner just sends "run the deploy script"); not multi-step weaves/DAGs; not telegram/http-ui targets.

## Later
`tag:job` flavor; vault-native job storage; cron macros/seconds.
