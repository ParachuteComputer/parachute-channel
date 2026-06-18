# Vault-native agent definitions — an agent IS a note

**Status:** design / exploration (2026-06-17, with Aaron). Realizes the
[blueprint](./2026-06-17-parachute-agent-blueprint.md) §Sequencing step 4
("vault-native agent config") and subsumes the per-channel system-prompt feature
([2026-06-16-channel-system-prompt.md](./2026-06-16-channel-system-prompt.md)).

## The idea
Today an agent is defined by two local files: a `channels.json` entry (its
transport/vault binding) + a `sessions/<name>/spec.json` (backend, system prompt,
workspace, isolation). **Move the definition into the vault as a note** — a new
`#agent` tag. Then:

- **The note body IS the system prompt** (the agent's role, in prose).
- **The note metadata is the config** (backend, workspace, isolation, which vault
  + creds it uses).
- The agent module just needs **one vault connected**; it reads `#agent` notes and
  runs each as a live agent.

The payoff Aaron named: **define and edit agents from any chat that can write to
the vault.** Open Claude against `unforced` (or the project vault), write a note
describing an agent, and it comes alive. The system becomes self-organizing —
agents define and reshape agents — with the vault as the single source of truth.

## Why this is the natural endgame
The module already converged on **the vault as the spine**: conversations are
`#agent-message` notes, scheduled jobs are `#agent-job` notes (Phase 2, already
vault-native). The one thing still living in local files is the agent *definition*.
Make it `#agent` and the vault holds the **whole system** — three note types, one
substrate:

| Note tag | Is | Who writes it |
|---|---|---|
| `#agent/definition` | the agent definition (role + config) | a human/agent in any vault chat |
| `#agent/message/{inbound,outbound}` | a turn of conversation | humans (in) / the agent (out) |
| `#agent/job` | a scheduled trigger | the Schedules UI / any vault writer |

**Namespacing (decided with Aaron 2026-06-17):** the `#agent/*` namespace is
**owned by the agent module** — every vault object the module manages hangs off it
(`#agent/definition`, `#agent/message`, `#agent/job`). This is a general pattern:
the next module to define vault-native objects (e.g. a surfaces module) gets its own
`#surface/*` namespace. Clean, collision-free, and "what does the agent module own?"
is one prefix.

**The Parachute-vault gotcha (load-bearing):** a slash in a tag *name* is a
namespace convention — it does **NOT** by itself confer query inheritance
(`query-notes { tag: "#agent" }` does NOT match `#agent/definition` unless the
`parent_names` graph says so). So we do two things the module already does for
`#channel-message`/`/inbound`:
1. **Tag the queryable level literally.** The module queries each type by its exact
   tag (`#agent/definition`, `#agent/job`, `#agent/message/inbound`) — no reliance
   on prefix magic.
2. **Declare `parent_names` in the module's tag schema** (`ensureSchema`, via
   `update-tag`) so `#agent/definition` → parent `#agent`, `#agent/message/inbound`
   → parent `#agent/message` → parent `#agent`. That makes `tag:#agent` roll up to
   *everything the module owns* (the nice human query) and `tag:#agent/message` roll
   up to both directions — without depending on per-vault setup for the module's own
   exact-tag queries. Messages still tag both the queryable parent (`#agent/message`)
   and the directional child (`#agent/message/inbound`) literally, as today, so loop
   avoidance + transcript listing work with zero schema dependency.

The agent module becomes a **near-stateless executor** bound to a vault: read the
defs, watch for inbound + jobs, run turns, write outbound. Everything durable +
queryable + editable from anywhere with vault access.

## The `#agent` note shape
```
---
tags: [#agent/definition]       # + parent #agent declared via parent_names for the rollup
metadata:
  name: uni-dev                 # slug; the agent's identity + wake-channel key
  backend: programmatic         # programmatic (default) | interactive
  systemPromptMode: append      # append (default) | replace
  workspace: /Users/.../code    # optional host cwd
  filesystem: workspace         # workspace (default) | full
  network: open                 # open (default) | restricted
  egress: [api.github.com]      # when restricted
  vault: default                # the vault this agent reads/writes (its conversation + jobs)
  vaultAccess: write            # the vault scope it gets
  uses: [github, cloudflare]    # NAMED credential references — NOT secrets (see below)
---
You are uni-dev, the development agent for the Parachute project. You work in the
repo at <workspace>, follow the conventions in CLAUDE.md, … (the system prompt)
```
The body is the role; metadata is the knobs. "Write an agent" ≈ "write a note that
describes what it should be." This is the most natural possible authoring surface.

## The load-bearing rule: secrets NEVER live in the note
A `#agent` note is readable by anyone with vault read — and editable by anyone with
write. So it **must not contain secrets**. The note declares *what* the agent is and
*which* credentials it needs **by reference** (`uses: [github]`, `vault: default`).
The actual secret values — `CLAUDE_CODE_OAUTH_TOKEN`, scoped vault/channel JWTs,
the GitHub/Cloudflare tokens — stay in the module's **private local store**
(`~/.parachute/agent/credentials.json` + per-agent `sessions/<name>/`, 0600), exactly
where they live today, and are injected at run time. This preserves the existing
posture (secrets out of the shareable layer; [session-environment-and-credentials](./2026-06-16-session-environment-and-credentials.md))
while making the *definition* freely shareable.

So there are two planes:
- **Definition plane (vault, shareable, editable anywhere):** role + config + cred
  *references*. Self-organizing.
- **Secret plane (local, private, operator-provisioned once):** the cred *values*
  the references resolve to. The module mints the scoped vault/channel tokens itself
  (it already does — `mint-token.ts`), so the note never needs them.

A reference with no matching local credential → the agent runs without it (and the
module surfaces "agent uni-dev wants `github` but no credential is provisioned"),
rather than failing silently. Provisioning a secret stays a deliberate local act.

## Reactive lifecycle (define → live, edit → reconfigure, delete → retire)
The module learns of `#agent` notes the same way it learns of inbound messages
today — a **vault trigger**:
- On `#agent` note created/updated → webhook the daemon → (re)instantiate that agent
  (register it in the programmatic registry, bind its wake channel = its `name`).
- On delete → tear the agent down.
- On boot → query all `#agent` notes and instantiate the set.

This reuses the exact machinery Phase 1/2 built (the vault trigger → `/api/vault/*`
webhook → registry). A poll fallback (every N min) covers vaults without trigger
support. (vault#467 live-query SSE is an even cleaner future option.)

## How a message reaches a vault-defined agent
Unchanged from today, just sourced differently: an `#agent-message/inbound` note with
`metadata.channel === <agent name>` wakes that agent. The agent's *identity* now comes
from its `#agent` note instead of a `channels.json` entry; the routing key (`name`)
is the same. The wake "channel" and the agent become one thing — which is the
"agent ≡ channel" collapse the blueprint called for, now literal.

## The control-plane trust gradient (security boundary to state plainly)
Whoever can write `#agent` notes to the connected vault can define agents that run
with the module's privileges (`--dangerously-skip-permissions`, machine access). So
**the def vault is a trusted control plane.** This is correct for an owner-operated
box (Aaron's own vault), but it's a real boundary: the module must only read defs
from a vault the operator controls, and (later, multi-user) `#agent` authorship is a
privileged capability, not a general vault-write. Ties to
[trust-gradient-isolation](../../parachute-patterns/patterns/trust-gradient-isolation.md).
The secret plane is the backstop: even a hostile def can only *reference* creds, never
read them, and only creds the operator provisioned locally are available.

## What it replaces / migration
`channels.json` + `sessions/<name>/spec.json` → `#agent` notes (the def) + the
unchanged local secret store. The create-agent UI (Phase 1) becomes a thin
**note-writer** (or is skipped — write the note in any chat). Since the current data
is disposable test state, this is a **clean cutover**, not a migration: wipe the old
local defs, stand up the `#agent` reader, define the real agents as notes.

## Is it a big lift? (Aaron's instinct: "not too huge")
Roughly right, because it reuses everything:
- **New:** a vault-sourced agent registry (query `#agent` → build the same
  `AgentSpec` the registry already consumes) + a reload trigger (mirror the inbound
  trigger) + cred-reference resolution (map `uses:[…]` → the existing private store).
- **Reused:** the programmatic backend, the vault transport, the trigger/webhook
  path, the mint logic, the secret store, the routing-by-metadata.
The `AgentSpec` interface stays the canonical in-memory shape; only its *source*
moves from `spec.json` to a vault note. So the core is "parse a note into an
AgentSpec" + "reload on trigger" — a contained addition on top of the now-landed
agent module.

## Decided
- **Tag namespace:** `#agent/*`, module-owned (`#agent/definition`, `#agent/message`,
  `#agent/job`), with `parent_names` declared for the `#agent` rollup. General pattern
  for future modules (`#surface/*`, …). *(Implication: the just-landed flat
  `#agent-message` / `#agent-job` tags move to `#agent/message` / `#agent/job` as part
  of this build — cheap, since the current data is disposable test state.)*
- **Secrets stay OUT of the vault** in a local secret file, as today — until a
  dedicated secrets-integration story emerges. (Aaron, 2026-06-17.)
- **Multi-vault: any vault can define agents** (Aaron, 2026-06-17). Link a vault to the
  agent module → its `#agent/definition` notes become live agents here, properly scoped.
  **Default to a single vault — `unforced`, Aaron's personal/playtest vault — but the
  architecture must NOT hard-code single-vault.** Model the binding as a **list** of
  linked def-vaults (default: one), so opening up multi-vault later is just appending,
  not a refactor. **Per-vault scoping (load-bearing):** an agent defined in vault X is
  bound to vault X — its conversations/jobs live there and its minted vault token is
  scoped to X. So a vault only grants its agents access to *itself* (no cross-vault
  reach unless a def explicitly + with authorization asks for it). This is the scoping
  that makes "link any vault" safe. *(Same shape will serve `#surface/*` when a vault
  defines surfaces — a later parallel, not now.)*

## Open questions
- **Cross-vault operation:** the default is an agent operates on its *defining* vault.
  Do we ever need an agent defined in vault A to act on vault B? Deferred — start with
  agent-bound-to-its-def-vault; revisit if a real case appears (a def could later name a
  different target vault, gated by the operator provisioning that vault's token).
- **Cred references:** the `uses: [name]` vocabulary + how the module maps a name to
  a provisioned credential (a local `credentials.json` keyed by name). Needs a small
  registry of named creds.
- **Reload granularity:** re-instantiate just the changed agent (needs the note id →
  agent mapping) vs reload-all on any `#agent` change. Start with per-note.
- **Authoring ergonomics:** a metadata template / the create-agent UI writing the
  note vs hand-authoring. Probably ship a tiny "new agent" note template.
- **Conflict with a running turn:** editing an agent's note mid-turn — apply on the
  next turn (turns are atomic in the programmatic backend), don't interrupt.
