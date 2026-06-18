/**
 * Agent-spec + Sandbox contract types.
 *
 * The **agent spec** (design §4.1) is the single declaration of everything an
 * arm may reach: its MCP surface (channels + vault), its network egress, and its
 * filesystem view. Scope and isolation are both read off this one object, so
 * there is exactly one place that says "what is this arm allowed to touch."
 *
 *   design/2026-06-14-sandboxed-agent-sessions.md §4.1, §4.4, §4.5
 *
 * The Sandbox **contract** (design §3.1) is held constant; the **mechanism**
 * varies by platform (Seatbelt on macOS, bubblewrap on Linux) behind it. v1
 * ships one backend (Anthropic's sandbox-runtime); the escalation rung (§3.4 —
 * gVisor / full VM) is a second backend added later without touching callers.
 */

/** Read/write mode for a declared mount. */
export type MountMode = "ro" | "rw";

/**
 * A filesystem bind beyond the implicit workspace + runtime/config. Each entry
 * binds a host path to a mount path at `ro` or `rw` (design §4.5).
 *
 * On macOS the sandbox profile is glob-capable, so `hostPath` may contain glob
 * patterns; on Linux it must be a literal path (the runtime does not glob there).
 * For v1 we bind the host path directly (`mountPath` is recorded for the future
 * bubblewrap bind-remap and for the spec→mandate seam, §4.6 — it does not change
 * the v1 Seatbelt path, which has no path-remapping layer).
 */
export interface AgentMount {
  /** Path on the host to expose into the session. */
  hostPath: string;
  /** Path the session sees it at. Recorded for the future bind-remap; see note above. */
  mountPath: string;
  /** Read-only or read-write. */
  mode: MountMode;
  /**
   * Opt-in cross-session share by name (design §4.5). A deliberate hole in
   * session-to-session isolation — honored here, but the trust caveat (prefer
   * shared-`ro` from the producer, never shared-`rw` across a trust boundary) is
   * doc-level for v1. Plumbed through so a future use is a considered decision.
   */
  shared?: string;
}

/** The vault binding for an arm: which vault, what access, optionally tag-scoped. */
export interface AgentVaultSpec {
  /** Vault instance name (e.g. "default"). */
  name: string;
  /** Access verb minted into the vault token. */
  access: "read" | "write" | "admin";
  /**
   * Optional tag scope — narrows the minted vault token to these tags via the
   * `permissions.scoped_tags` claim (e.g. `["#agent/message"]`). Omitted = the
   * verb's full scope across the vault.
   */
  tags?: string[];
}

/** An additional MCP server to wire in, by URL (design §4.1 `otherMcps`). */
export interface OtherMcpSpec {
  /** Entry key in the generated `mcpServers` object. */
  name: string;
  /** Streamable-HTTP MCP URL. */
  url: string;
  /**
   * Scope to mint a token for, if this MCP is hub-gated. Omitted = no token
   * (an unauthenticated / externally-authenticated MCP).
   */
  scope?: string;
  /** Audience to mint the token under. Defaults to inferred from scope by the hub. */
  audience?: string;
}

/**
 * An agent spec — the complete least-privilege envelope for one launched arm
 * (design §4.1). `egress` and `mounts` are additive to a non-removable base; the
 * spec only ever *adds*.
 */
/**
 * A channel binding for an arm. A bare string is shorthand for `{ name, access:
 * "write" }` (back-compat — the common read+write resident session); the object
 * form scopes a channel read-only so an arm that only *watches* a channel mints
 * `agent:read` and never `agent:write` (the "scope an arm to channel X
 * read-only" use case).
 */
export interface AgentChannelSpec {
  /** Channel name (the `/mcp/<channel>` segment). */
  name: string;
  /**
   * Channel access. `"write"` (default) mints `agent:read agent:write`;
   * `"read"` mints `agent:read` only — the arm can be woken + read the channel
   * but cannot reply.
   */
  access?: "read" | "write";
}

/** A channel entry: a bare name (= write access) or the scoped object form. */
export type AgentChannel = string | AgentChannelSpec;

/**
 * Which backend drives the agent (design 2026-06-16-pluggable-agent-backend.md +
 * 2026-06-18-channel-backend.md):
 *
 *  - `"programmatic"` (the DEFAULT for a NEW spawn request, per Aaron's gating
 *    decision 2026-06-16): NO resident process. An inbound message becomes one
 *    on-demand `claude -p --resume <sid>` turn ({@link AgentBackend}); the reply is
 *    posted back as an outbound `#agent/message/outbound` note. No idle session →
 *    nothing to go deaf, no reconnect, no replay, no consent gate. The reliable
 *    primary path; best for clean per-message "do a task, report back" turns.
 *  - `"channel"` (design 2026-06-18-channel-backend.md): the turn is delivered over
 *    a channel to a Claude Code session the OPERATOR runs themselves (their machine,
 *    their env/creds, unsandboxed) and has connected to the channel's MCP endpoint.
 *    The daemon runs NO `claude -p`; the inbound `#agent/message/inbound` notes
 *    accumulate as a durable queue (the vault IS the queue). The connected session
 *    PULLs the next message (an MCP tool), works, and REPLYs (an MCP tool) — the
 *    daemon writes the outbound note + marks the inbound handled. Routed to the
 *    {@link ChannelQueueRegistry}, entirely bypassing the programmatic serial worker
 *    (the daemon routing fork). Claim state lives on the inbound note's `status`
 *    (`pending | in-flight | handled`), so it's restart-safe.
 *  - `"interactive"` (the original tmux path; now RETIRED — design 2026-06-18
 *    "Retiring interactive"): an idle interactive `claude` in a tmux pane, fed
 *    inbound by pushing onto a subscribed MCP development channel. Carries the
 *    deaf-on-restart machinery (#67/#68/#70/#71). Kept in the type for back-compat
 *    of already-persisted specs; NOT selectable for a vault-native def (parseAgentDef
 *    rejects it). `channel` supersedes the human-driven-CC need it hedged.
 *
 * DEFAULT-RESOLUTION NOTE — the omitted-field default differs by context, on
 * purpose: a NEW request that omits `backend` resolves to `"programmatic"`
 * ({@link buildSpecFromBody} in `agents.ts`), but a PERSISTED `spec.json` that omits
 * `backend` predates the field and resolves to `"interactive"`
 * ({@link interpretPersistedBackend} in `spawn-agent.ts`) — so the flip applies going
 * forward without silently migrating already-running interactive agents.
 */
export type AgentBackendKind = "interactive" | "programmatic" | "channel";

/**
 * How a channel's {@link AgentSpec.systemPrompt} composes with Claude Code's own
 * default system prompt (design 2026-06-16-channel-system-prompt.md):
 *
 *   - `"append"` (DEFAULT): KEEP Claude Code's capable default system prompt
 *     (~2.4k tokens of tool/agentic instruction) and ADD the channel's role on top
 *     — `claude -p --append-system-prompt(-file) <X>`. The right default: the
 *     channel gets strong specificity without losing CC's base competence.
 *   - `"replace"`: REPLACE the default entirely with the channel's prompt —
 *     `claude -p --system-prompt(-file) <X>`. A fully-custom persona for an
 *     operator who wants total control of the system layer (and leanness on the
 *     subscription — fewer base tokens per turn).
 *
 * Either mode is orthogonal to CLAUDE.md, which is a SEPARATE context layer
 * unaffected by both flags (only `--bare` would drop it — and `--bare` is
 * deliberately NOT implemented; see the design note: it is API-key-only by design
 * and would force metered billing off the subscription).
 */
export type SystemPromptMode = "append" | "replace";

export interface AgentSpec {
  /** Human-readable arm name; used as the tmux session + workspace slug. */
  name: string;
  /**
   * Channels to attach (one MCP entry each). Each entry is a bare name (read+write,
   * back-compat) or `{ name, access: "read" }` to scope a channel read-only.
   */
  channels: AgentChannel[];
  /**
   * WORKING DIRECTORY — a real host path the agent operates from (design
   * 2026-06-16-agent-filesystem-and-sharing.md, the working-directory axis). When
   * set, this absolute path becomes the agent's CWD and an rw working-root in the
   * sandbox (it's bound rw + readable, exactly like an `rw` mount that is also the
   * cwd). It is SHAREABLE — two agents (or a runner job, or a plain script) can
   * point at the same dir (shared-rw concurrency is a known, deferred caveat; the
   * agents step on each other like humans in a repo without git discipline).
   *
   * CRITICAL — the working dir is DECOUPLED from the agent's PRIVATE RUNTIME HOME.
   * The seeded `CLAUDE_CONFIG_DIR` (`seedAgentHome`), `tmp`, `spec.json`,
   * `system-prompt.txt`, and ESPECIALLY `.mcp.json` (which inlines the scoped
   * vault/channel tokens — secrets) STAY in the per-agent private `sessions/<name>/`
   * dir, 0600, NEVER written into this shared `workspace`. The governing principle
   * (the design note's "line"): capability/credential/state is per-agent private;
   * the working dir is shareable. `--mcp-config` / `--system-prompt-file` point at
   * the private dir by ABSOLUTE path, so they're unaffected by the cwd change.
   *
   * Unset → today's behavior EXACTLY: the cwd is the private `sessions/<name>` dir
   * (which is also the synthetic workspace).
   */
  workspace?: string;
  /** Optional vault binding. */
  vault?: AgentVaultSpec;
  /** Additional MCP servers, by URL. */
  otherMcps?: OtherMcpSpec[];
  /**
   * Filesystem READ scope — ONE of Anthropic's two containment boundaries
   * (https://www.anthropic.com/engineering/claude-code-sandboxing). Orthogonal to
   * {@link network} — the agent's reach into the local disk and its reach onto the
   * network are independent controls, deliberately NOT bundled.
   *
   *   - `"workspace"` (DEFAULT): SCOPED reads. The home tree (`/Users` on macOS,
   *     `/home` on Linux) is DENIED, then re-allowed ONLY for the per-session
   *     workspace + the claude runtime + declared mounts. The agent literally
   *     cannot read the operator's secrets — `~/.parachute/operator.token` (the
   *     hub bearer), SSH keys, other projects — even though the network is open.
   *     This is the security-correct default: scoped disk, exfiltration surface
   *     removed at the source.
   *
   *   - `"full"`: BROAD reads (the runtime default — the whole filesystem is
   *     readable). An explicit, deliberate escape hatch for the rare agent that
   *     genuinely needs to read across the operator's disk AND is trusted not to
   *     leak it. Combined with `network: "open"` this is the maximum-reach posture
   *     — only choose it knowingly.
   *
   * WRITES are confined to the per-session workspace + rw mounts in BOTH cases
   * (the agent can never corrupt the operator's files or escape its workspace),
   * exactly per Anthropic's "read/write the cwd, block outside" model.
   */
  filesystem?: "workspace" | "full";
  /**
   * Network egress — the SECOND containment boundary, orthogonal to
   * {@link filesystem}:
   *
   *   - `"open"` (DEFAULT): full internet, no restriction. The right default for
   *     an owner-operated agent on a trusted box (claude needs the network to be
   *     useful) — SAFE because the `"workspace"` filesystem default already keeps
   *     local secrets unreadable, so "open network" can't exfiltrate what the
   *     agent can't see.
   *
   *   - `"restricted"`: egress confined to a non-removable base
   *     (`{ Anthropic API, hub/vault }`) UNIONed with {@link egress}. For an agent
   *     fed FOREIGN/untrusted input, where you want to bound where it can reach
   *     even for data it legitimately holds.
   */
  network?: "open" | "restricted";
  /**
   * Network egress hosts ADDITIVE to the non-removable base — only meaningful
   * under `network: "restricted"` (when the network is `"open"` this is ignored).
   * A restricted code-building agent opens exactly the package/source hosts it
   * needs here.
   */
  egress?: string[];
  /**
   * Filesystem mounts — ADDITIVE to the default private per-session workspace
   * (rw) + the implicit runtime/claude-config (ro). Under `filesystem:
   * "workspace"` (the default) these are the ONLY host paths re-allowed for
   * reads beyond the workspace — mount the project you want the agent to work on.
   */
  mounts?: AgentMount[];
  /**
   * Which stored Claude credential to inject (design §6). Default = "operator".
   * This stream injects the credential as a passed-in param/placeholder; Stream 3
   * builds the real per-channel secret store.
   */
  credentialRef?: string;
  /**
   * Which backend drives the agent (design 2026-06-16-pluggable-agent-backend.md).
   * A NEW spawn request that omits this defaults to `"programmatic"` (on-demand
   * `claude -p` turns, no resident process — the reliable primary path, per Aaron's
   * gating decision 2026-06-16); `"interactive"` (the original tmux path) is the
   * opt-in/"advanced" backend. A PERSISTED spec.json that omits this resolves to
   * `"interactive"` instead (back-compat — it predates the field). See
   * {@link AgentBackendKind} for the full default-resolution note. Persisted in
   * spec.json so a daemon restart re-registers a programmatic agent on boot.
   */
  backend?: AgentBackendKind;
  /**
   * Per-channel system prompt — the operator gives the channel a specific role,
   * backend-visible, so the agent gets strong specificity decoupled from the
   * workspace + CLAUDE.md (design 2026-06-16-channel-system-prompt.md). Set when
   * creating/configuring the channel; written to a per-session file and passed on
   * EVERY `claude -p` turn (the flags are per-invocation, not persistent — a
   * `--resume` turn re-passes it too). Unset → today's behavior (CC's default
   * prompt, untouched). Persisted in spec.json.
   */
  systemPrompt?: string;
  /**
   * How {@link systemPrompt} composes with Claude Code's default system prompt —
   * `"append"` (DEFAULT, keep CC's base + add the role) or `"replace"` (full
   * custom persona). Only meaningful when `systemPrompt` is set. See
   * {@link SystemPromptMode}.
   */
  systemPromptMode?: SystemPromptMode;
}

/**
 * The default workspace + runtime binds the contract always grants, independent
 * of any spec. The caller supplies the concrete paths (resolved against the
 * session's state dir + the runtime/config location) — keeping this module
 * free of filesystem-layout assumptions and test-sandboxable.
 */
export interface BaseBinds {
  /** Private per-session workspace (rw). */
  workspace: string;
  /**
   * Read-only runtime/claude-config paths the session needs to run `claude`
   * (e.g. the claude config dir). Always bound `ro`.
   */
  runtimeReadOnly: string[];
}

/** Platform the Sandbox config is being built for. */
export type SandboxPlatform = "darwin" | "linux";

/**
 * Normalize a channel entry (bare name or object) to `{ name, access }`. A bare
 * string defaults to `write` (back-compat); the object form defaults to `write`
 * when `access` is omitted.
 */
export function normalizeChannel(ch: AgentChannel): { name: string; access: "read" | "write" } {
  if (typeof ch === "string") return { name: ch, access: "write" };
  return { name: ch.name, access: ch.access ?? "write" };
}
