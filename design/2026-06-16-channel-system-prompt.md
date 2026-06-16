# Per-channel system prompt — give a channel a role

**Status:** built 2026-06-16. Companion to
[`2026-06-16-pluggable-agent-backend.md`](./2026-06-16-pluggable-agent-backend.md)
(how an agent is driven), [`2026-06-16-agent-filesystem-and-sharing.md`](./2026-06-16-agent-filesystem-and-sharing.md)
(workspace / shared library / private runtime), and
[`2026-06-16-session-environment-and-credentials.md`](./2026-06-16-session-environment-and-credentials.md)
(env/credential injection).

## The feature

An operator gives a channel a **specific role** via a system prompt, set when
creating/configuring the channel — **backend-visible**, so the agent gets strong
specificity. Two new fields on the `AgentSpec` (`src/sandbox/types.ts`):

- `systemPrompt?: string` — the role text.
- `systemPromptMode?: "append" | "replace"` — how it composes with Claude Code's
  own default system prompt. **Default `"append"`.**

Parsed from the untrusted spawn body in `buildSpecFromBody` (`src/agents.ts`): the
mode is validated to exactly the two allowed values (anything else → 400); a
blank/whitespace-only prompt is treated as unset (no flag); an orphan mode with no
prompt is dropped. The spec is persisted in `spec.json`, so a daemon restart
re-registers the role.

### The two modes (verified empirically, claude 2.1.179, + against docs)

- **Append** (`--append-system-prompt` / `--append-system-prompt-file`): **KEEPS**
  Claude Code's capable default system prompt (~2.4k tokens of agentic/tool
  instruction) and **adds** the channel's role on top. The default — the channel
  gets specificity without losing CC's base competence.
- **Replace** (`--system-prompt` / `--system-prompt-file`): **REPLACES** the
  default entirely with the channel's prompt. A fully-custom persona; also leaner on
  the subscription (fewer base tokens per turn).
- **CLAUDE.md is a SEPARATE context layer**, unaffected by either flag — only
  `--bare` would drop it (and `--bare` is not implemented; see below). So the role
  (system prompt) and the workspace conventions (CLAUDE.md) are independent knobs:
  the role gives channel specificity **decoupled** from the workspace/CLAUDE.md.

### File-backed, re-applied per turn

The flags are **per-invocation, not persistent** — `claude -p` re-reads them each
run. The programmatic backend runs a **fresh `claude -p` per turn** (including
`--resume` turns), so it MUST re-pass the flag on **every** turn. We write the
prompt to a per-session file (`<workspace>/system-prompt.txt`, `0600`) and pass the
**`-file` variant** (`--append-system-prompt-file` / `--system-prompt-file`):

- robust to long / multiline prompts (no shell-quoting a giant arg);
- keeps the prompt **visible-on-disk** to the backend;
- the file is **(re)written every `deliver`** and the flag rebuilt in the per-turn
  argv (`buildProgrammaticClaudeArgs`) — so a resume turn carries the role too.

The **interactive** backend (`buildAgentClaudeArgs` / `spawnAgent`) passes the same
`-file` flag once at launch (the session is long-lived, so per-turn re-pass is
unnecessary) — for backend-parity/agnosticism. Unset `systemPrompt` → no file, no
flag, today's behavior unchanged.

### UI + surfacing

The Agents page spawn form (`src/agents-ui.ts`) gets a **System prompt** textarea +
an **Append (default) / Replace** mode control with the one-line hint *"Append keeps
Claude Code's capable base and adds your channel's role; Replace gives full
control."* `collectSpec` sends `systemPrompt` + `systemPromptMode` only when the
textarea is non-blank. `GET /api/agents` surfaces a `systemPromptMode` on each agent
when a prompt is set (the **mode**, not the text — the prompt can be long /
role-sensitive); the running-agents list shows a small `role: append|replace` badge.

## The `--bare` finding (so we never re-litigate)

`--bare` is **API-key-only BY DESIGN.** It skips OAuth/keychain and does **not** read
`CLAUDE_CODE_OAUTH_TOKEN`
(doc: code.claude.com/docs/en/authentication, 2026-06-16 — *"Bare mode does not read
`CLAUDE_CODE_OAUTH_TOKEN`; authenticate with `ANTHROPIC_API_KEY`."*). Confirmed
programmatically (claude 2.1.179): `--bare` + an injected subscription token →
"Not logged in"; non-bare `-p` + the same token → works on the subscription
(`apiKeySource: none`, `five_hour` rate-limit pool). Using `--bare` would therefore
force **metered/API billing off the subscription**.

**Decision: `bare` is intentionally NOT implemented** — it would silently flip
billing, exactly the footgun the env-credential model
([session-environment note](./2026-06-16-session-environment-and-credentials.md))
exists to prevent. Keep it out unless Anthropic changes the policy. If `--bare` is
ever wanted, it couples to the metered/API-key path (the "guarded" provider keys
from the session-environment note) as an advanced, explicitly-opt-into-metered mode
— never a silent default.

## Leanness on the subscription (the bare-alternative)

You don't need `--bare` to run a lean agent on the subscription. The programmatic
backend already runs `--strict-mcp-config` with a **vault-only** `.mcp.json` (no MCP
/ tool bloat). Further leanness, all subscription-compatible:

- `--system-prompt` (**replace** mode) — drops CC's ~2.4k-token default for a small
  custom prompt;
- `--allowedTools` — trim the tool surface (future knob);
- a minimal workspace CLAUDE.md.

These cut per-turn tokens **without** leaving the subscription — the opposite of
`--bare`, which leaves it entirely.
