# Runner — scheduled agent turns (narrow, in-module)

**Status:** built 2026-06-17. Phase 2 of the Parachute Agent consolidation (`2026-06-17-parachute-agent-blueprint.md` §Sequencing step 2). Builds on the programmatic backend (`2026-06-16-pluggable-agent-backend.md`) and the vault transport's inbound→turn→outbound mechanism.

## The idea (start narrow)
A **scheduled job** is *an automated human*: "send message M to agent A on schedule S." Per the blueprint, the runner is **in-module** and **the agent is always the unit of work** — the runner does not execute anything itself; it just *authors an inbound message on a schedule*, and the existing agent-turn machinery does the rest. Aaron's steer: **"Let's start runner narrow."** So Phase 2 is *scheduled messages*, nothing more. The `tag:job` event-trigger flavor is a deliberate future extension (§Later), not in this phase.

## One mechanism (no new path)
A fired job writes an **inbound note** exactly like a human typing in chat — same tags, same metadata, same durability. There is **no special-case turn path**: the note lands in the vault (durable, queryable, visible in the transcript), the channel's already-registered vault trigger fires, and the turn runs. The runner is indifferent to backend (programmatic/interactive) because it never touches the turn — it only authors notes.

## Anatomy of a job — VAULT-NATIVE storage (Aaron's call 2026-06-17)
A **job IS a vault note** — durable, queryable, and renderable by any surface — not a local `jobs.json`. This is the blueprint's "vault as the spine" realized in this phase, and it converges with the future `tag:job` idea. The job note lives in the **target channel's vault** (each vault-channel already carries `config.vault` / `config.vaultUrl` / `config.token` — the channel's existing `vault:<name>:write` token covers all job CRUD; the runner mints nothing).
- **Parent tag** `#agent-job` (queryable; mirrors the `#channel-message` convention). This is a brand-new tag, so it's named for the module's new identity (Parachute Agent) from the start. (The `#channel-message → #agent-message` rename is a separate Phase-3 data migration — the *injected message* notes still use `#channel-message`.)
- **content** = the message text to inject.
- **metadata** (all string-typed in the vault): `{ channel, cron, tz?, enabled, createdAt, lastRunAt?, lastStatus? }`. **`nextRunAt` is computed IN MEMORY, never persisted.**
- **path**: `Channels/<channel>/jobs/<jobId>` (slug id; deterministic so an upsert overwrites in place).

```jsonc
// the #agent-job note, as the vault stores it
{ "content": "Run the morning weave…",
  "path": "Channels/uni-dev/jobs/morning-standup",
  "tags": ["#agent-job"],
  "metadata": { "channel": "uni-dev", "cron": "53 7 * * *",
                "tz": "America/Los_Angeles", "enabled": "true",
                "createdAt": "…", "lastRunAt": "…", "lastStatus": "ok" } }
```
- **`channel` must be a vault channel** (the inject path is "write an inbound note," which only a vault transport has). Telegram/http-ui are rejected with a clear error. The default agent is vault-backed.
- **`schedule`** — a 5-field **cron** expression (`min hour dom mon dow`) plus optional IANA `tz` (default: daemon local tz). Small dependency-free evaluator (`src/cron.ts`): `*`, `*/n`, ranges (`a-b`), lists (`a,b,c`). No seconds, no macros in v1.

### Vault REST endpoints (all with the channel's existing `vault:write` token)
- **List:** `GET <vaultUrl>/vault/<vault>/api/notes?tag=%23agent-job&include_content=true&limit=<n>` → bare JSON array; **filter client-side by `metadata.channel`** (no `?metadata={channel:{eq}}` — FIELD_NOT_INDEXED risk; same index-free pattern `loadTranscript` uses).
- **Create/replace:** `POST <vaultUrl>/vault/<vault>/api/notes` `{ content, path, tags:["#agent-job"], metadata }` (upsert by path).
- **Update status on fire:** `PATCH <vaultUrl>/vault/<vault>/api/notes/<id>` with the changed metadata (lastRunAt, lastStatus).
- **Delete:** `DELETE <vaultUrl>/vault/<vault>/api/notes/<id>`.

These live on `VaultTransport` (it owns the URL + token + encoding), so `jobs.ts` is a thin storage-agnostic facade.

## Components
1. **`src/jobs.ts`** — the `Job` model + `validateJob` (pure: slug, known channel, vault-transport check, cron parse) + `VaultJobStore` (`listAll`/`upsert`/`remove`/`patch`, same read-all/upsert/remove interface, now backed by `#agent-job` vault notes via the channel's `VaultTransport`).
2. **`src/cron.ts`** — `parseCron(expr)` + `nextRunAfter(expr, tz, from)`. Pure, unit-tested.
3. **`src/runner.ts`** — the scheduler. One `setInterval` tick (default 30s) **loads jobs from the vault store**, checks each enabled job; if due, fire, set `lastRunAt`/`lastStatus`, recompute `nextRunAt` (in memory), and PATCH the bookkeeping back. **Injectable clock + load fn + fire fn + persist fn + tick scheduler** for deterministic tests. `nextRunAt` is held in an in-memory per-job horizon map (never persisted). Catch-up = **fire-once-on-miss** (no stampede). Idempotent under overlap (skip a job already mid-fire).
4. **Fire = inject inbound.** `VaultTransport.injectInbound({ content, sender })` — sibling of `reply()` writing `[#channel-message, #channel-message/inbound]`, `metadata: { channel, direction: "inbound", sender: "runner:<jobId>", ts }`, NO `channel_inbound_rendered_at`. Reuses the channel's existing `vault:<name>:write` token.
5. **API** (`agent:admin`): `GET /api/jobs`; `POST /api/jobs {id,channel,message,schedule,enabled?}` (400 on bad cron / unknown / non-vault channel); `DELETE /api/jobs/:id`; `POST /api/jobs/:id/run` (fire now).
6. **UI** — a sibling **Schedules** page (`/jobs`, nav entry): list (agent · cron · next-run · last-status), add form (agent picker → message → cron field + presets like "daily 8am"/"hourly"), enable/disable, delete, "Run now." Reuse `ui-kit` shell + the hub-minted `agent:admin` token bootstrap. (A dedicated page over an agents-page section: each surface stays single-purpose, matching the module's one-page-per-concern idiom, and avoids growing the already-large agents page.)

## Why correct + safe
No new authority (uses the channel's existing write token, no hub round-trip). No loop risk (only writes inbound; trigger never matches outbound). Durable + visible (real vault note; high-water-mark/backlog-replay apply unchanged). Deterministic tests (clock/tick/fire injected; cron pure).

## Boundaries (NOT in Phase 2)
Not `tag:job` event triggers; not script execution (an agent runs the script — the runner just sends "run the deploy script"); not multi-step weaves/DAGs; not telegram/http-ui targets.

## Later
`tag:job` event-trigger flavor; cron macros/seconds; declaring the `#agent-job` tag schema (indexed `channel`) for index-backed per-channel job queries at scale (today's list is index-free, mirroring the transcript read).
