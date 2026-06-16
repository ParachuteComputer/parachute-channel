# Session environment & credentials — unify the injection model

**Status:** direction (not yet built). Post-launch refactor. Companion to
[`2026-06-14-sandboxed-agent-sessions.md`](./2026-06-14-sandboxed-agent-sessions.md)
(the sandbox/isolation model) and the no-loss/reconnect work in
`src/daemon.ts` + `src/mcp-http.ts`.

## The observation

After [PR #68](https://github.com/ParachuteComputer/parachute-channel/pull/68) we
have **two subsystems doing one shape**:

- the `claude` credential slice (`resolveClaudeCredential` → inject
  `CLAUDE_CODE_OAUTH_TOKEN`), and
- the generic `env` slice (`resolveChannelEnv` → inject operator-scoped env vars;
  denylisted keys are already stripped at resolve).

Both are literally: *resolve a value (operator-default ?? per-channel-override) →
inject it as an environment variable into the spawned session.* `CLAUDE_CODE_OAUTH_TOKEN`
is not a different **kind** of thing — it's just a session variable that happens to
be required + default-injected. That duplication is the smell.

## The model

**One "session environment" store** (default + per-channel overrides) where
`CLAUDE_CODE_OAUTH_TOKEN` is just a well-known entry. The only system opinion is a
small **policy table** over a handful of keys — not a separate mechanism:

| Policy | Keys | Behavior |
|---|---|---|
| **Required (as a set)** | a valid auth path | spawn fails loud only if *no* recognized auth resolves |
| **Guarded** | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, … | not injected by default (no *silent* billing/provider switch); deliberately enable-able per channel, with the implication surfaced |
| **Reserved** | `PATH`, `HOME`, `XDG_*` | set by the system via structural passthrough + the seeded home — *not* denylisted (see `DENYLISTED_ENV` docblock: keeping the denylist focused on billing keys is deliberate), but an operator value for these won't survive the layering |
| **Free** | `GH_TOKEN`, `CLOUDFLARE_API_TOKEN`, … | operator's to set |

### Two refinements that matter

1. **"Required" is a set, not a key.** The default auth path is the subscription
   OAuth token, but a channel could instead carry a direct Anthropic API key, a
   custom gateway (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, e.g. a LiteLLM
   proxy), or Bedrock/Vertex/Foundry (`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY`).
   The spawn
   validates that *some* recognized path resolves — it does not bless one key.

2. **"Guarded" ≠ "forbidden."** The danger with `ANTHROPIC_API_KEY` was never that
   someone might *want* metered/API billing — it's that it could land in the env
   **silently** and flip billing without the operator realizing. So the policy is
   *safe-default + informed override*, not prohibition. The denylist shipped in #68
   is the current safe default; this model reframes it as "guarded, override coming."

This is the Parachute posture: subscription-OAuth-by-default because it's the
no-surprise-billing path, but *that it's a choice* — API, your own gateway,
Bedrock, Vertex — is the point. The generic env store is exactly the substrate that
makes all of those "just work" with zero per-provider code, since Claude Code already
reads those env vars. The security posture is unchanged regardless of provider: scope
the token at issuance; the sandbox keeps the agent off the operator's other secrets.

## What to keep when unifying

- **A thin UX/guard layer for the required auth.** A dedicated "Claude auth"
  affordance (with the `claude setup-token` help) and a guard against *deleting* the
  last working auth path and bricking every session — even though it's stored in the
  same map.
- **The billing invariant stays an explicit, tested filter** at the injection point.
  Today the slice separation makes "never silently inject an API key" structurally
  obvious; in a unified map it becomes a policy rule — fine, but it must be guarded by
  tests, not left implicit.

## Migration sketch

1. Add the unified `env` store as the substrate (done in #68).
2. Collapse the `claude` slice into a well-known required key + the policy table;
   keep a back-compat read shim (`claude.default` → `env.default.CLAUDE_CODE_OAUTH_TOKEN`,
   `claude.channels[x]` → `env.channels[x].CLAUDE_CODE_OAUTH_TOKEN`).
3. Replace the hard denylist with the guarded-default policy + per-channel override
   acknowledgment.
4. Surface alternate auth paths in the config UI behind a deliberate "change provider"
   affordance.

## Relationship to the reconnect work

This is the credential companion to the **deaf-session-on-restart** problem (a CC
session goes deaf on any daemon restart and doesn't auto-reconnect). #68 added the
per-session restart that re-sources env + reconnects; the open **Phase-2** is
auto-respawning deaf managed sessions on daemon (re)start. Both this unification and
that auto-reconnect are post-launch.
