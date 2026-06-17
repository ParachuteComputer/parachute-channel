# Parachute Agent — the work-execution module (blueprint)

**Status:** direction (2026-06-17), decided with Aaron. This reframes the module's
*identity* (it was "channel"; it is becoming "agent"). The rename itself is a future
migration (see Sequencing). Builds on the programmatic-backend arc (#73/#74/#76/#83),
the workspace seam (#82), system prompt (#79), and the design notes #72/#77/#81.

## Identity
**Parachute Agent is the part of Parachute where work gets done.** Vault remembers,
Surface displays, Scribe transcribes, Hub coordinates — **Agent acts.** Everything in
this module is a configured AI agent that lives on your vault: you feed it (chat, a
vault note, or a schedule), it works (including running scripts), and it records +
remembers in the vault.

## Decisions (locked)
- **One module.** The channel / agent / runner split collapses into one. This is where
  work happens, and the work happens *through agents*.
- **Agent ≡ channel.** The subscriber-era split is gone — programmatically, a message
  *is* a `claude -p` turn that replies. Fuse them: one **create-agent** config + flow
  (collapse today's two steps, create-channel then spawn-agent-on-it).
- **Runner starts narrow and stays in-module — even with scripts.** Runner = scheduling
  agents ("send message M to agent A at time T / on event X"). When script-jobs arrive,
  **the agent is still the unit of work — an agent runs the script**, not a separate
  script-runner. So there is no general "job substrate" module waiting to split out;
  it's agents, scheduled. One module, durably.
- **The agent is always the unit of work.** Conversational task or script task, it's an
  agent doing it. That invariant is what keeps this one module forever.

## The agent
A configured agent = **backend** (programmatic default · interactive gated) · **workspace**
· **system-prompt** · **vault + scoped credentials** · **isolation** (fs / network / mounts),
plus a durable conversation. One config surface — one thing to create and talk to.

## Three inputs, one mechanism
Every way a message arrives converges on `inbound note → agent turn → durable outbound
note`, so the agent is indifferent to the source:
1. **Chat** — a human in the cohesive UI (vault-backed conversation).
2. **Vault note** — anything (a system, a script, the MCP) writes a
   `#channel-message/inbound` note → the integration path.
3. **Scheduled job (runner)** — a cron / `tag:job` trigger injects a message.

## Vault as the spine
Conversation = vault notes; jobs = `tag:job` notes; memory = the vault; (future) the
agent's config could itself be a vault note. It's not bolted-together parts — it's **one
vault-native actor** with three ways in. The vault is the substrate; the agent acts on it.
(The `tag:job → agent turn` path is the original "vault-as-job-substrate" runner idea,
now realized *inside* the agent module rather than as a separate one.)

## Workspace — lives in the agent (room to play)
Today (#82) a workspace is a **field on the agent** (a host path that becomes its cwd;
the private runtime — `.mcp.json`, scoped tokens, config, state — stays per-agent; secrets
never land in the shared dir). That keeps the workspace "in the agent" while still
shareable (two agents can point at the same path).
- **Default:** keep it as part of the agent's config.
- **To explore:** if many agents come to share complex workspace setups (mounts, scoped
  creds, shared state), a **first-class named workspace** (defined once, referenced by
  agents) becomes worth it. Not required now — revisit when sharing complexity demands.
  This is the deliberate "play around with what makes sense" zone.

## Naming: Parachute Agent
- Parachute modules are functional nouns for what they *are*; this one *acts* →
  **Agent**. "Channel" names the interface (a pipe); "Runner" names one input (a
  schedule) — both undersell the whole.
- It is also `parachute-agent` **realized correctly**: the retired `parachute-agent`
  (Claude-in-containers) was the right idea at the wrong size; programmatic `claude -p`,
  vault-backed, owner-operated is the right-sized version.
- Migration cost (deliberate, later — a planned sweep, not mid-flight): repo /
  `@openparachute/channel` → `agent` / CLI short name / hub registry / services.json /
  docs, plus handling the retired `parachute-agent` repo + npm package (archive-and-absorb,
  or revive). Ship it with a `parachute-patterns/migrations/` propagation checklist.

## What stays separate
- **Hub** — substrate (identity, tokens, supervision, admin UI + the #666 lock). Not Agent.
- **Vault** — the spine the agent acts on.
- **Interactive backend** — kept but gated (the billing hedge / live-session case); it's a
  *backend of the agent*, not a separate module.

## Sequencing
1. **Consolidate config** — one create-agent flow (fuse create-channel + spawn-agent) +
   the programmatic terminal/UI cleanup (hide the dead terminal link for programmatic).
2. **Runner subsystem** — `tag:job` / cron-triggered messages → agent turns, in-module.
3. **Rename migration** — channel → agent (deliberate sweep + retired-name handling +
   migration checklist).
4. *(later, only if demanded)* vault-native agent config; first-class named workspaces;
   any leaner script path (only if "an agent runs the script" proves insufficient).

## Open questions (to play with)
- **Workspace:** field-on-agent (today) vs first-class named workspace — resolve when
  sharing complexity arrives.
- **Rename mechanics:** revive the `parachute-agent` repo vs rename `parachute-channel`.
- **Script-jobs:** confirm "an agent runs the script" covers the case (vs a leaner
  script-only path) when we get there — the decision is to keep it agent-driven unless
  proven otherwise.
