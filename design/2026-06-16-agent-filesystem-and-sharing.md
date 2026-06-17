# Agent filesystem & sharing — workspace, shared library, private runtime

**Status:** the **working-directory axis (seam #1) SHIPPED 2026-06-16** (the
`workspace` spec field — PR #82); the shared-library axis (#2) + step-up auth (#3)
remain direction (not yet built). Companion to
[`2026-06-14-sandboxed-agent-sessions.md`](./2026-06-14-sandboxed-agent-sessions.md)
(sandbox/isolation), [`2026-06-16-pluggable-agent-backend.md`](./2026-06-16-pluggable-agent-backend.md)
(how an agent is driven), and
[`2026-06-16-session-environment-and-credentials.md`](./2026-06-16-session-environment-and-credentials.md)
(env/cred injection). Written ahead of resuming **parachute-runner**, which will
reuse these primitives.

## The problem

Today an agent's session dir (`~/.parachute/channel/sessions/<name>/` by default;
overridable via `PARACHUTE_CHANNEL_STATE_DIR` / the injected `sessionsDir` dep) fuses
four different things into one private blob:
- the **working directory** (cwd),
- a seeded **per-agent `CLAUDE_CONFIG_DIR`** (`<workspace>/home/.claude`, written by
  `seedAgentHome`) holding **config + library** (skills, slash commands, sub-agents).
  Note: the operator's real `~/.claude` is never written — only `~/.claude.json` is
  *read* as a seed source, and the agent always runs with `CLAUDE_CONFIG_DIR` pointed
  at its own dir, so CC's "user-level" config layer is fully controlled per-agent,
- the **`.mcp.json`** (with the agent's scoped vault/channel tokens), and
- **mutable runtime state** (sessions, history, locks, cache, tmp).

Two emerging needs break that monolith:
1. An agent often wants to **work from a real directory** on the computer (a repo), and
   that directory should be **shareable** — with other agents, with runner jobs, with
   plain scripts. (A runner job might kickstart an agent via channel *and* run scripts
   in the same place.)
2. Agents should **share curated library content** — an operator curates a set of
   **skills** (and slash commands, sub-agents) once and wants *all* their agents to
   have them.

…while some things must stay **strictly per-agent and never shared** — above all the
**MCP config and its scoped tokens** (vault access), which is the security/capability
boundary between agents.

## The decomposition: three independent axes

An agent's filesystem context is really **three** things, not one:

| Axis | What | Sharing |
|---|---|---|
| **Working directory** | where the agent operates (cwd) | shareable real dir (ro safe; rw needs a concurrency story) |
| **Shared library** | curated, inert content: skills, slash commands, sub-agent defs, output styles | **shareable** read-only across agents |
| **Private runtime** | `.mcp.json` + scoped tokens; mutable state (sessions, cache, locks, tmp); trust/onboarding flags | **never shared** — per-agent |

## The governing principle (the line)

> **Anything that carries a credential or a scoped capability is per-agent and never
> shared. Anything that is inert, curated content can be shared.**

- `.mcp.json` (scoped vault/channel tokens), the injected `CLAUDE_CODE_OAUTH_TOKEN`,
  any per-agent secret → **private**. Sharing them collapses the per-agent isolation
  that the whole sandbox model exists to provide.
- Skills, slash commands, sub-agent definitions, output styles → **shareable** (they're
  curated text/content, not capabilities).

That one rule decides where any *future* piece of config belongs — no case-by-case
agonizing.

## Mapping to Claude Code's own config model

CC already layers config: user-level (`~/.claude` / `CLAUDE_CONFIG_DIR`) + project-level
(`.claude` in the cwd) + managed. Skills load from user + project `skills/`; MCP from
`.mcp.json`; settings layer user→project→local. So we lean on CC's layering rather than
inventing one:
- **Shared library** → an operator-curated `skills/` (+ commands, agents) dir surfaced
  into each opted-in agent **read-only**.
- **Private runtime** → today's per-agent `CLAUDE_CONFIG_DIR` (`seedAgentHome`) with its
  own `.mcp.json` + mutable state — unchanged.

The implementation trick is composing a **shared read-only library source** with a
**per-agent private config** (via mount / symlink / a skills path) so skills are shared
but `.mcp.json` + state stay isolated. The exact mechanism wants a small spike against
CC's skills-discovery (does it follow a symlinked `skills/`? a configurable path? a
read-only mount layered under the private config?) — TBD when we build it, not now.

## Composition with the other seams

All orthogonal, all compose:
- **Backend** (how driven: interactive ↔ programmatic) ×
- **Working dir** (where it works) ×
- **Shared library** (what skills it has) ×
- **Runner** (what triggers it).

A **runner job** becomes: pick a *working dir* + a *backend*, inherit the *shared
library*, get *per-agent scoped credentials*, triggered by a `tag:job` note or cron —
with **channel** as the comms fabric. Runner reuses the agent/sandbox/credential
primitives (`AgentBackend`, `wrapArgvInSandbox`, the #68 env injection); it doesn't
reinvent them.

## Minimal seams to land (good-enough-now — don't over-build)

1. **`workspace` (host path) on the agent spec** — ✅ **SHIPPED (PR #82, 2026-06-16).**
   Decouples the working dir from the private runtime home. Set → that dir is the cwd
   + an rw working-root in the sandbox; the private home (`.mcp.json`/`spec.json`/
   `system-prompt.txt`/seeded `CLAUDE_CONFIG_DIR`/`tmp`) stays per-agent at
   `sessions/<name>/`, 0600, never written into the shared dir. Unset → today's
   private synthetic workspace. Both backends honor it via a shared `resolveAgentCwd`;
   `buildSpecFromBody` requires an absolute, existing directory. Unblocks shared
   real-dir work + runner.
2. **A shared-library dir** — an operator-curated `skills/` (+ commands/agents) path,
   mounted **read-only** into agents that opt in. Could start as a single configurable
   shared-skills path that `seedAgentHome` layers in read-only.
3. **Keep `.mcp.json` + scoped tokens + mutable state strictly per-agent** — no change;
   just make the boundary *explicit and documented* so future config lands in the right
   layer (per the governing principle).

**Defer until a concrete need:** a named-workspace registry; a library
package/versioning system; shared-**rw** working-dir concurrency coordination; a
workspace bundling its own scoped env/creds (ties into #68 — natural later, e.g. a
repo's `GH_TOKEN` travelling with its workspace).

## Open questions
- **Shared-rw working dir concurrency** — multiple agents editing one dir step on each
  other like humans in a repo without git discipline. The `AgentMount.shared?` hook
  exists (v1 doc-level only — "plumbed through so a future use is a considered
  decision," per `sandbox/types.ts`); the *policy* (when shared-rw is allowed vs
  requires coordination) is open. Shared-ro is always safe.
- **CC skills-sharing mechanism** — the exact way to share `skills/` while isolating
  `.mcp.json` (spike when building seam #2).
- **Working dir vs library collision** — when a real repo is mounted as the working
  dir, CC treats that repo as the project root and will read *its* `.claude/` (skills,
  settings) too. The working-dir seam and the shared-library seam can interact
  non-obviously there (repo-local `.claude/` layering on top of the shared library) —
  resolve the precedence when building the library seam.
- **One library or many** — a single global library vs per-purpose / per-"team"
  libraries an agent selects from.
