/**
 * Vault-native agent definitions — an agent IS a `#agent/definition` note
 * (design `2026-06-17-vault-native-agents.md`, Phase 4a).
 *
 * Instead of a `channels.json` entry + a `sessions/<name>/spec.json`, a
 * vault-native agent is a single vault note: the note BODY is the system prompt,
 * the note METADATA is the config. The module reads `#agent/definition` notes from
 * a configured DEF-VAULT and, for each one, instantiates a live agent — a vault
 * channel (so inbound/outbound notes flow) + a registered programmatic agent (so an
 * inbound turn runs `claude -p`). Reactively: a note created/updated/deleted →
 * reload that one agent.
 *
 * REUSE (the design's "near-stateless executor" point — this module is small
 * because it stands on the existing machinery):
 *   - {@link AgentSpec} (sandbox/types.ts) stays the canonical in-memory shape; only
 *     its SOURCE moves from `spec.json` to a note. {@link parseAgentDef} is "note →
 *     AgentSpec".
 *   - `addChannelLive` (daemon.ts) brings up the vault channel — the SAME call the
 *     create-agent flow + boot use; injected here as {@link InstantiateDeps.ensureChannel}.
 *   - `setupProgrammaticSpawn` (agents.ts) persists `spec.json` (so the existing boot
 *     re-register + the per-turn deliver find the workspace) and `programmatic.register`
 *     registers the agent — injected as {@link InstantiateDeps.setupAndRegister}.
 *   - The def-vault's `vault:<name>:write` token (minted by the daemon the SAME way a
 *     channel/job token is — `mint-token.ts`) drives BOTH the def query and the status
 *     stamp; the vault REST encoding mirrors `VaultTransport`.
 *
 * SCOPE (4a only — OWN-VAULT). An agent defined in vault X is scoped to vault X: its
 * conversation + jobs live there, and its minted vault token is for X. There is NO
 * cross-vault / MCP / external-service connector, NO approval flow — that is 4b.
 * A def MAY declare a `uses: […]` / connections field; we PARSE + SURFACE it (so the
 * status note lists what it wants) but do NOT grant it. Secrets NEVER live in a note;
 * the Claude OAuth token + any service creds stay in the local store and are injected
 * at run time by the programmatic backend, exactly as today.
 *
 * STATUS (queryable liveness — the design's "lives in the field so an MCP side knows"):
 * after resolving a def, the registry PATCHes the note's metadata `status`. In 4a
 * (own-vault only) a successfully-instantiated agent is `enabled`; a def that declares
 * external connections is `pending` (listing them) since 4b hasn't granted them yet —
 * it still runs own-vault, the declared connections are simply absent until approved.
 */

import {
  type AgentSpec,
  type AgentBackendKind,
  type AgentMode,
  type SystemPromptMode,
  type AgentMount,
} from "./sandbox/types.ts";
import { AGENT_DEFINITION_TAG, AGENT_THREAD_TAG } from "./transports/vault.ts";
import {
  parseWants,
  connectionKey,
  resolveConnectionStatus,
  WantsParseError,
  GrantsClient,
  isRoleNote,
  rolePathKey,
  type ConnectionSpec,
} from "./grants.ts";

const DEFAULT_DEF_VAULT_URL = "http://127.0.0.1:1940";

/**
 * Page cap for a def-vault list. The poll's removed-def diff now DEREGISTERS (a
 * destructive teardown), so a list that hits this cap is treated as possibly-
 * truncated — NOT a confident set — and the removal diff is skipped that pass (see
 * {@link AgentDefRegistry.loadAll}'s truncation guard). 500 comfortably exceeds any
 * realistic agent count; it exists so the teardown is safe by construction.
 */
const DEF_LIST_LIMIT = 500;

/** A slug: alphanumeric, dash, underscore — the agent name + wake-channel key. */
const NAME_SLUG_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * A def-vault the module reads `#agent/definition` notes from. The architecture is
 * a LIST (default: one — the local `default` vault) so opening up multi-vault later
 * is appending, not a refactor (design "Decided: multi-vault"). The token grants
 * vault read (query defs) + write (stamp status + the agents' message/job notes),
 * scoped to THIS vault only — an agent defined here reaches only this vault (4a).
 */
export interface DefVaultBinding {
  /** Vault name (the `<vault>` path segment in the REST URL). */
  vault: string;
  /** REST base origin. Default `http://127.0.0.1:1940`. */
  vaultUrl?: string;
  /** A `vault:<name>:write` hub JWT (read + write), presented as Bearer. */
  token: string;
}

/** The resolved status of a def after instantiation (stamped onto the note). */
export type AgentDefStatus = "enabled" | "pending" | "error";

/**
 * Which discovery source registered a live agent (Phase 4a dual-discovery):
 *  - `def`    — a `#agent/definition` note (the original source).
 *  - `thread` — a `#agent/thread` note (the flattened model; the def can later be deleted).
 */
export type DiscoverySource = "def" | "thread";

/**
 * The discovery-source toggle (env `PARACHUTE_AGENT_DISCOVERY`) — which note types the
 * registry discovers agents from. The cutover is a FLAG-FLIP, not a new build:
 *  - `both`   (DEFAULT) — discover from BOTH `#agent/definition` AND `#agent/thread`, deduped
 *    by name with the DEF WINNING on a collision. Purely additive: with the def present and
 *    no `agent_status` set, every live agent registers EXACTLY as today (the def path is
 *    untouched; threads only ADD agents that have no def).
 *  - `thread` — discover from `#agent/thread` ONLY. Lets the orchestrator prove thread-
 *    discovery in isolation (source=thread) before deleting the def notes.
 *  - `def`    — discover from `#agent/definition` ONLY (today's exact behavior; the escape hatch).
 */
export type DiscoveryMode = "both" | "thread" | "def";

/** Parse the `PARACHUTE_AGENT_DISCOVERY` env value to a {@link DiscoveryMode}; default `both`. */
export function parseDiscoveryMode(raw: string | undefined): DiscoveryMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "thread" || v === "def" ? v : "both";
}

/**
 * Per-connection grant info surfaced to the ops UI (the MCP/connections panel) so it
 * can render a status pill + drive the cookie→hub "Connect" without re-deriving the
 * hub's grant id client-side (that divergence class already bit this codebase — the
 * id MUST come from the hub). One entry per declared `wants:` connection.
 *
 *   - `key`     — the stable {@link connectionKey} (matches a `wants` entry).
 *   - `kind`    — `vault` | `service` | `mcp` (the panel only acts on `mcp` today).
 *   - `target`  — the connection target (for `mcp`, the remote https URL).
 *   - `status`  — the hub grant's lifecycle as the hub reports it
 *     (`pending` | `approved` | `revoked` | `needs_consent`), or `pending` when no
 *     grant could be resolved (no grants client / a registration error).
 *   - `grantId` — the hub-assigned grant id (the Connect/approve key). Absent when no
 *     grant was registered/resolved (then the UI can't offer Connect — it shows a
 *     degraded hint instead).
 */
export interface ConnectionInfo {
  key: string;
  kind: "vault" | "service" | "mcp";
  target: string;
  status: string;
  grantId?: string;
}

/**
 * The parse of one `#agent/definition` note: the canonical {@link AgentSpec} the
 * registry instantiates, plus the note bookkeeping (its id for PATCH, the declared
 * connections to surface, and any parse error).
 */
export interface ParsedAgentDef {
  /** The vault note id/path — addresses the note for the status PATCH. */
  noteId: string;
  /** The agent name (= the wake channel + the spec name). */
  name: string;
  /** The canonical in-memory spec, ready for `programmatic.register`. */
  spec: AgentSpec;
  /**
   * Declared cross-vault / MCP / external-service connections beyond the def-vault
   * (the legacy `uses:` field — raw name strings). PARSED + surfaced in 4a; superseded
   * by the structured `wants:` field in 4b. Kept for back-compat (a 4a-era note that
   * declared `uses:` still surfaces its names) — but a note SHOULD use `wants:` (see
   * {@link wants}). Empty = no legacy declarations.
   */
  declaredConnections: string[];
  /**
   * Declared connections in the STRUCTURED 4b form (the `wants:` field) — vault /
   * service / mcp connection specs the agent wants to reach beyond its def-vault
   * (design 2026-06-17-agent-connectors-4b.md). REGISTERED as pending grants on
   * instantiate + injected (when approved) at spawn — granting is operator-approved
   * in the hub. Empty = own-vault only.
   */
  wants: ConnectionSpec[];
}

/** A failed parse — the note isn't a well-formed agent def. */
export class AgentDefParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDefParseError";
  }
}

/**
 * A failed def WRITE (create/edit/delete) — carries an HTTP status the daemon route
 * maps directly (400 validation, 404 unknown note, 409 name collision, 502 a
 * write/instantiate failure). Distinct from {@link AgentDefParseError} (a note that's
 * already in the vault but malformed).
 */
export class AgentDefWriteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AgentDefWriteError";
  }
}

/**
 * Coerce a vault metadata value (the vault stores metadata as strings, but a note
 * authored in another client may carry a real array/number) to a trimmed string.
 */
function metaStr(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * Parse a comma/space-separated list field OR a real array → a clean string[].
 * Used for `egress` and `uses` (a note authored as YAML front-matter may carry
 * either; a vault that stringifies arrays gives us the comma form).
 */
function metaList(v: unknown): string[] {
  let parts: string[] = [];
  if (Array.isArray(v)) {
    parts = v.map((x) => (typeof x === "string" ? x : String(x)));
  } else if (typeof v === "string") {
    parts = v.split(/[,\s]+/);
  }
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Best-effort, NON-throwing extraction of a def note's agent name (`metadata.name`),
 * for tracking the seen set + the removed-def grant-GC diff (#96) — distinct from
 * {@link parseAgentDef}, which validates + throws. Returns undefined when the note has
 * no usable name (we then carry the prior last-known name forward). Does NOT slug-
 * validate: a note that once instantiated already passed parse; tracking the raw name
 * is enough to address its grants for the prune.
 */
function nameOfDefNote(note: { metadata?: Record<string, unknown> }): string | undefined {
  return metaStr(note.metadata?.name);
}

/**
 * Parse one `#agent/definition` note into a {@link ParsedAgentDef}. PURE — no I/O.
 *
 * Mapping (the design's "note shape"):
 *   - note BODY (`content`)  → `spec.systemPrompt` (the agent's role, in prose).
 *   - `metadata.name`        → `spec.name` (REQUIRED, slug) = the wake channel.
 *   - `metadata.backend`     → `spec.backend` (default `programmatic`).
 *   - `metadata.mode`        → `spec.mode` (default `single-threaded`; `multi-threaded`
 *     ok; the legacy aliases `resident`/`one-shot`/`per-thread` are DUAL-ACCEPTED and
 *     mapped silently). The note id → `spec.definition` (provenance).
 *   - `metadata.systemPromptMode` → `spec.systemPromptMode` (default `append`).
 *   - `metadata.workspace`   → `spec.workspace` (optional absolute host cwd).
 *   - `metadata.filesystem`  → `spec.filesystem` (`workspace` | `full`).
 *   - `metadata.network`     → `spec.network` (`open` | `restricted`).
 *   - `metadata.egress`      → `spec.egress` (host list, for `restricted`).
 *   - the def-vault binding   → `spec.vault` (own-vault, `write`) — passed in, since
 *     the note never names which vault it lives in (it's defined BY being in it).
 *   - `metadata.uses`        → `declaredConnections` (PARSED, NOT granted — 4b).
 *
 * `spec.channels` is `[name]` — the wake channel IS the agent name (the design's
 * "agent ≡ channel" collapse). Throws {@link AgentDefParseError} on a missing/bad
 * name (the registry skips that note + stamps `error`, rather than instantiating a
 * malformed agent).
 *
 * SECRETS: a def declares creds BY REFERENCE only (`uses:`). We deliberately do NOT
 * read any token/secret field off the note — secrets stay local. `credentialRef`
 * stays the local Claude-credential selector (defaults to the wake channel) and is
 * never sourced from the note.
 */
export function parseAgentDef(note: {
  id?: string;
  /**
   * The note's PATH (e.g. `Agents/steward`) — carried onto `spec.definitionPath` for the
   * composed-prompt self-entry header (#169). Distinct from the note ID (a timestamp-slug).
   * Optional: a reader that doesn't surface a path leaves it unset and the header falls back
   * to the id then the name.
   */
  path?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}, binding: { vault: string }): ParsedAgentDef {
  const noteId = typeof note.id === "string" ? note.id : "";
  if (!noteId) {
    throw new AgentDefParseError("#agent/definition note has no id");
  }
  const meta = note.metadata ?? {};
  const notePath = typeof note.path === "string" && note.path ? note.path : undefined;
  const defLabel = `#agent/definition note ${noteId}`;

  const name = metaStr(meta.name);
  if (!name) {
    throw new AgentDefParseError(`${defLabel} has no metadata.name`);
  }
  if (!NAME_SLUG_RE.test(name)) {
    throw new AgentDefParseError(
      `${defLabel}: name "${name}" must be a slug (alphanumeric, dash, underscore)`,
    );
  }

  // Backend / mode — parsed by the shared field parsers (same validation the thread-spec
  // path uses). Backend default `programmatic`; the retired `interactive` is rejected; the
  // legacy `"channel"` value DUAL-READs to `"attached"`. Mode default `single-threaded`,
  // dual-accepting the legacy aliases (resident→single; one-shot/per-thread→multi).
  const backend = parseBackendField(meta, defLabel);
  const mode = parseModeField(meta, defLabel);

  const spec: AgentSpec = {
    name,
    channels: [name], // wake channel = the agent name (agent ≡ channel)
    backend,
    mode,
    // The def note id — provenance carried into the `#agent/thread` note (BOTH modes;
    // interim plain id string; typed link fields are a future vault feature).
    definition: noteId,
    // The def note PATH (when the reader surfaced one) — the human-legible loadout path
    // used for the composed-prompt self-entry header (#169). The note ID above is a
    // timestamp-slug; the PATH (`Agents/steward`) is what the header should read.
    ...(notePath ? { definitionPath: notePath } : {}),
    // Own-vault binding (4a): the def-vault, write-scoped. NOT sourced from the note
    // — it's the vault the note LIVES in (passed in by the caller).
    vault: { name: binding.vault, access: "write" },
  };

  // The note body IS the system prompt. A blank body → no system prompt (CC's
  // default, untouched) rather than an empty `--append-system-prompt-file`.
  const body = typeof note.content === "string" ? note.content.trim() : "";
  if (body.length > 0) {
    spec.systemPrompt = note.content!; // keep the untrimmed body (whitespace may matter in prose)
    const mode = metaStr(meta.systemPromptMode);
    if (mode !== undefined) {
      if (mode !== "append" && mode !== "replace") {
        throw new AgentDefParseError(
          `#agent/definition note ${noteId}: systemPromptMode must be "append" or "replace"`,
        );
      }
      spec.systemPromptMode = mode as SystemPromptMode;
    }
  }

  // Model (optional) — passed to `claude -p --model` by the programmatic backend.
  const model = parseModelField(meta, defLabel);
  if (model !== undefined) spec.model = model;

  // Sandbox / containment knobs (workspace / filesystem / network / egress / mounts).
  //
  // NOTE (step-up, agent#80): `filesystem: "full"` is the dangerous, full-disk
  // case. The step-up PIN gate is enforced on the HTTP spawn path only
  // (`POST /api/agents` in daemon.ts). This VAULT-NATIVE path (a #agent/definition
  // note with `filesystem: full`) is NOT step-up-gated — registering it requires
  // `vault:write` to author the note, which is itself separately scope-gated, so a
  // step-up challenge here would gate a capability the caller already had to hold a
  // write credential to reach. If the threat model is ever revisited (e.g. less-
  // trusted note authors), this is the gap to close.
  Object.assign(spec, parseSandboxKnobs(meta, defLabel));

  // Declared connections beyond the def-vault (the legacy `uses:` field). PARSED +
  // surfaced; never a secret — these are NAMES (`github`, `vault:research:read`).
  const declaredConnections = metaList(meta.uses);

  // STRUCTURED connection declarations (the 4b `wants:` field — design
  // 2026-06-17-agent-connectors-4b.md). Comma-separated connection specs parsed into
  // {@link ConnectionSpec}s. A MALFORMED `wants:` → the def is an ERROR (we re-throw
  // as AgentDefParseError so the registry stamps status:error + doesn't half-
  // instantiate, design §1). The def-vault is implicit — never appears in `wants:`.
  let wants: ConnectionSpec[];
  try {
    wants = parseWants(meta.wants);
  } catch (err) {
    if (err instanceof WantsParseError) {
      throw new AgentDefParseError(`#agent/definition note ${noteId}: ${err.message}`);
    }
    throw err;
  }

  return { noteId, name, spec, declaredConnections, wants };
}

/** Parse a metadata `mounts` value (JSON array string or real array) → AgentMount[]. */
function parseMounts(v: unknown): AgentMount[] {
  let arr: unknown;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.length === 0) return [];
    try {
      arr = JSON.parse(t);
    } catch {
      return [];
    }
  } else {
    arr = v;
  }
  if (!Array.isArray(arr)) return [];
  const out: AgentMount[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.hostPath !== "string" || !m.hostPath.startsWith("/")) continue;
    if (typeof m.mountPath !== "string" || !m.mountPath.startsWith("/")) continue;
    if (m.mode !== "ro" && m.mode !== "rw") continue;
    const mount: AgentMount = { hostPath: m.hostPath, mountPath: m.mountPath, mode: m.mode };
    if (typeof m.shared === "string" && m.shared.length > 0) mount.shared = m.shared;
    out.push(mount);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared field parsers — the per-field validation common to a `#agent/definition`
// note ({@link parseAgentDef}) and a `#agent/thread` note ({@link parseThreadSpec}).
// Extracted so the two discovery sources validate config IDENTICALLY (one source of
// truth for the backend/mode/model/sandbox rules); `label` prefixes each error so a
// def vs a thread is distinguishable in the log. Each is PURE.
// ---------------------------------------------------------------------------

/**
 * Parse the `backend` field. Default `programmatic` (the reliable primary path); the
 * retired `interactive` (tmux) backend is REJECTED with a clear message (rather than
 * silently demoting); the legacy backend VALUE `"channel"` DUAL-READs to `"attached"`
 * (the value rename — the routing-key `channel` is a SEPARATE concept, untouched).
 */
function parseBackendField(meta: Record<string, unknown>, label: string): AgentBackendKind {
  const raw = metaStr(meta.backend);
  if (raw === undefined) return "programmatic";
  if (raw === "interactive") {
    throw new AgentDefParseError(
      `${label}: the "interactive" backend is retired — use "programmatic" (daemon-run turns, ` +
        `the default) or "attached" (handled by a Claude Code session you connect to the channel).`,
    );
  }
  // DUAL-READ: the legacy backend value `"channel"` normalizes to `"attached"`.
  const normalized = raw === "channel" ? "attached" : raw;
  if (normalized !== "programmatic" && normalized !== "attached") {
    throw new AgentDefParseError(`${label}: backend must be "programmatic" or "attached"`);
  }
  return normalized;
}

/**
 * Parse the execution-lifecycle `mode` field. Default `single-threaded`; DUAL-ACCEPTs
 * the legacy aliases (resident→single-threaded; one-shot/per-thread→multi-threaded),
 * mapping silently. Any other value is rejected with an actionable error.
 */
function parseModeField(meta: Record<string, unknown>, label: string): AgentMode {
  const raw = metaStr(meta.mode);
  if (raw === undefined) return "single-threaded";
  if (raw === "single-threaded" || raw === "resident") return "single-threaded";
  if (raw === "multi-threaded" || raw === "one-shot" || raw === "per-thread") return "multi-threaded";
  throw new AgentDefParseError(`${label}: mode must be "single-threaded" or "multi-threaded"`);
}

/**
 * Parse the optional `model` field — a CC alias (`opus`) or full id (`claude-opus-4-8`).
 * Validates only the CHARSET (no membership list — models evolve), so a typo'd-but-
 * wellformed value still reaches `--model` (the turn errors clearly) while a malformed
 * value (spaces/control chars) fails fast. Undefined when absent/blank.
 */
function parseModelField(meta: Record<string, unknown>, label: string): string | undefined {
  const model = metaStr(meta.model);
  if (model === undefined || model.length === 0) return undefined;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model)) {
    throw new AgentDefParseError(
      `${label}: model "${model}" is not a valid model name (letters, numbers, dot, underscore, colon, dash)`,
    );
  }
  return model;
}

/**
 * Parse the sandbox / containment knobs — workspace / filesystem / network / egress /
 * mounts. All OPTIONAL: absent → omitted (the spawn path's SAFE DEFAULTS apply — the
 * live agents run on defaults, so absence is the common case). A present-but-malformed
 * value THROWS (the caller skips that note), mirroring the def discipline. We do NOT
 * statSync `workspace` here (parse is pure + may run on a box where the dir is mounted
 * differently); the spawn path's own checks apply when the turn runs.
 */
function parseSandboxKnobs(
  meta: Record<string, unknown>,
  label: string,
): Pick<AgentSpec, "workspace" | "filesystem" | "network" | "egress" | "mounts"> {
  const out: Pick<AgentSpec, "workspace" | "filesystem" | "network" | "egress" | "mounts"> = {};
  const workspace = metaStr(meta.workspace);
  if (workspace !== undefined) {
    if (!workspace.startsWith("/")) {
      throw new AgentDefParseError(`${label}: workspace must be an absolute path (start with "/")`);
    }
    out.workspace = workspace;
  }
  const filesystem = metaStr(meta.filesystem);
  if (filesystem !== undefined) {
    if (filesystem !== "workspace" && filesystem !== "full") {
      throw new AgentDefParseError(`${label}: filesystem must be "workspace" or "full"`);
    }
    out.filesystem = filesystem;
  }
  const network = metaStr(meta.network);
  if (network !== undefined) {
    if (network !== "open" && network !== "restricted") {
      throw new AgentDefParseError(`${label}: network must be "open" or "restricted"`);
    }
    out.network = network;
  }
  const egress = metaList(meta.egress);
  if (egress.length > 0) out.egress = egress;
  // Filesystem mounts — JSON-encoded array in metadata, parsed defensively. A malformed
  // value is ignored (not fatal — mounts are an advanced knob).
  const mounts = parseMounts(meta.mounts);
  if (mounts.length > 0) out.mounts = mounts;
  return out;
}

/** The enable/disable axis carried on a `#agent/thread` note's `metadata.agent_status`. */
export type AgentEnableStatus = "enabled" | "disabled";

/**
 * The parse of one `#agent/thread` note into an {@link AgentSpec} — the THREAD discovery
 * source (Phase 4a dual-discovery, DESIGN-2026-06-29-threads-roles-context.md). A thread
 * IS the agent now: `metadata.agent` is the name/routing-key, the config rides on the
 * thread, and the IDENTITY composes at TURN TIME from roles ① + thread content ② +
 * loadout ③ — so {@link spec}'s `systemPrompt` is DELIBERATELY EMPTY here (we never read
 * the thread BODY as the prompt; the body is the rolling summary).
 */
export interface ParsedThreadSpec {
  /** The thread note id/path (addresses the note + the live-map key). */
  noteId: string;
  /** The agent name (= `metadata.agent`, the routing key + wake channel). */
  name: string;
  /** The canonical in-memory spec — `systemPrompt` UNSET (composes at turn time). */
  spec: AgentSpec;
  /** The enable/disable axis (`metadata.agent_status`, default `enabled`). DISTINCT from
   *  `metadata.status` (the TURN OUTCOME ok/error/working — never read here). Discovery
   *  SKIPS a `disabled` thread. */
  agentStatus: AgentEnableStatus;
  /**
   * Structured `wants:` declared on the thread (PARSED + surfaced for parity), if any.
   * NOT registered as grants in Phase 4a — only a `#agent/role` carries capability (the
   * security layer, DESIGN §"Roles carry capability"); a thread's `wants:` is
   * informational. Empty for the live agents.
   */
  wants: ConnectionSpec[];
}

/**
 * Parse one `#agent/thread` note into a {@link ParsedThreadSpec}. PURE — no I/O.
 *
 * Mapping (the flattened model — the thread IS the agent):
 *   - `metadata.agent`       → `spec.name` (REQUIRED, slug) = the wake channel.
 *   - `metadata.backend`     → `spec.backend` (default `programmatic`; `"channel"` dual-read).
 *   - `metadata.model`       → `spec.model` (optional).
 *   - `metadata.mode`        → `spec.mode` (default `single-threaded`; legacy aliases accepted).
 *   - `metadata.definition`  → `spec.definition` (provenance; falls back to the thread note id).
 *   - the thread note PATH   → `spec.definitionPath` (the composed-prompt self-entry header, #169).
 *   - sandbox knobs (`workspace`/`filesystem`/`network`/`egress`/`mounts`) → read if present,
 *     else SAFE DEFAULTS (the live agents run on defaults — absence is parsed safely).
 *   - the def-vault binding  → `spec.vault` (own-vault, `write`) — passed in (a thread never
 *     names which vault it lives in; it's defined BY being there, same as a def).
 *   - `metadata.agent_status`→ `agentStatus` (enable/disable; default `enabled`).
 *
 * `spec.systemPrompt` is NEVER set — identity composes from roles ① + thread content ② +
 * loadout ③ at turn time (the thread BODY is the rolling summary, not the prompt). Throws
 * {@link AgentDefParseError} on a missing/bad `metadata.agent` (the registry skips that note).
 * SECRETS: a thread declares creds BY REFERENCE only — we never read a token off the note.
 */
export function parseThreadSpec(
  note: { id?: string; path?: string; content?: string; metadata?: Record<string, unknown> },
  binding: { vault: string },
): ParsedThreadSpec {
  const noteId = typeof note.id === "string" ? note.id : "";
  if (!noteId) {
    throw new AgentDefParseError("#agent/thread note has no id");
  }
  const meta = note.metadata ?? {};
  const notePath = typeof note.path === "string" && note.path ? note.path : undefined;
  const label = `#agent/thread note ${noteId}`;

  // The routing key IS the agent name (the channel→agent CONTRACT — `metadata.agent`).
  const name = metaStr(meta.agent);
  if (!name) {
    throw new AgentDefParseError(`${label} has no metadata.agent (the routing key / agent name)`);
  }
  if (!NAME_SLUG_RE.test(name)) {
    throw new AgentDefParseError(
      `${label}: agent "${name}" must be a slug (alphanumeric, dash, underscore)`,
    );
  }

  const backend = parseBackendField(meta, label);
  const mode = parseModeField(meta, label);

  const spec: AgentSpec = {
    name,
    channels: [name], // wake channel = the agent name (agent ≡ channel).
    backend,
    mode,
    // Provenance for the `#agent/thread` note the turn materializes: the thread's own
    // `metadata.definition` if it carries one (a thread cloned from a def keeps the link),
    // else the thread note id itself (the thread IS the source now).
    definition: metaStr(meta.definition) ?? noteId,
    // The thread note PATH (when surfaced) — the human-legible self-entry header (#169).
    ...(notePath ? { definitionPath: notePath } : {}),
    // Own-vault binding (4a): the def-vault, write-scoped. NOT from the note — it's the
    // vault the thread LIVES in (passed in by the caller).
    vault: { name: binding.vault, access: "write" },
  };

  // systemPrompt is DELIBERATELY UNSET — identity composes from roles ① + thread content
  // ② + loadout ③ at turn time. We never read the thread BODY here.

  const model = parseModelField(meta, label);
  if (model !== undefined) spec.model = model;

  // Sandbox / containment knobs — present → parsed (+ validated); absent → SAFE DEFAULTS.
  Object.assign(spec, parseSandboxKnobs(meta, label));

  // `agent_status` — the enable/disable axis. DEFAULT `enabled` when absent; only the
  // exact string `disabled` disables. DISTINCT from `metadata.status` (the turn outcome),
  // which we never read here.
  const rawEnable = metaStr(meta.agent_status);
  const agentStatus: AgentEnableStatus = rawEnable === "disabled" ? "disabled" : "enabled";

  // `wants:` — PARSED for parity/surfacing, NOT registered as grants in 4a (only a role
  // grants capability). A malformed value is an ERROR (mirrors the def discipline).
  let wants: ConnectionSpec[];
  try {
    wants = parseWants(meta.wants);
  } catch (err) {
    if (err instanceof WantsParseError) {
      throw new AgentDefParseError(`${label}: ${err.message}`);
    }
    throw err;
  }

  return { noteId, name, spec, agentStatus, wants };
}

/**
 * Resolve the status a parsed def gets WITHOUT grant information — the fallback path
 * (no grants client wired, e.g. hub not provisioned). Own-vault only → `enabled`; a
 * def that declares ANY connection (legacy `uses:` names OR structured `wants:`) →
 * `pending` (listing them) since nothing has been granted yet. The agent still runs
 * own-vault either way; this is the queryable signal.
 *
 * When a grants client IS wired, the registry instead registers each `wants:`
 * connection + resolves status from the hub's grant statuses
 * (`resolveConnectionStatus` in grants.ts) — `enabled` only once every connection is
 * approved. This pure function is the no-hub fallback + the legacy-`uses:` path.
 */
export function resolveDefStatus(def: ParsedAgentDef): {
  status: AgentDefStatus;
  pending?: string[];
} {
  const pending = [
    ...def.declaredConnections,
    ...def.wants.map((c) => connectionKey(c)),
  ];
  if (pending.length > 0) {
    return { status: "pending", pending };
  }
  return { status: "enabled" };
}

/**
 * A thin vault client for ONE def-vault — the def-query + the status-PATCH. Mirrors
 * `VaultTransport`'s REST encoding (the `#` + `/` in a tag → `%23`/`%2F`; the note
 * PATCH route is `PATCH /vault/<vault>/api/notes/<id>`). `fetchFn` is injectable so
 * tests drive it with a recorder, deterministic, no global mock leak.
 */
export class DefVaultClient {
  private readonly vault: string;
  private readonly vaultUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(binding: DefVaultBinding, fetchFn?: typeof fetch) {
    if (!binding.vault) throw new Error("DefVaultClient: binding.vault is required");
    if (!binding.token) throw new Error("DefVaultClient: binding.token is required");
    this.vault = binding.vault;
    this.vaultUrl = (binding.vaultUrl ?? DEFAULT_DEF_VAULT_URL).replace(/\/$/, "");
    this.token = binding.token;
    this.fetchFn = fetchFn ?? fetch;
  }

  /** The def-vault name (for routing reload events to the right client). */
  get vaultName(): string {
    return this.vault;
  }

  /**
   * List the `#agent/definition` notes in this vault. INDEX-FREE: queries by the
   * exact tag (the leaf — we never rely on namespace prefix expansion) with
   * `include_content=true` (we need the body = the system prompt). Throws on a
   * non-ok vault response so the caller surfaces a clear error rather than a
   * silently-empty agent set.
   */
  async listDefNotes(opts?: { limit?: number }): Promise<
    Array<{ id: string; path?: string; content?: string; metadata?: Record<string, unknown> }>
  > {
    const limit = opts?.limit ?? DEF_LIST_LIMIT;
    const params = new URLSearchParams();
    params.set("tag", AGENT_DEFINITION_TAG); // URLSearchParams encodes `#`→`%23`, `/`→`%2F`
    params.set("include_content", "true");
    params.set("limit", String(limit));
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes?${params.toString()}`;
    const res = await this.fetchFn(url, { headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`def-vault "${this.vault}": list defs failed (${res.status}) ${detail}`.trim());
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new Error(`def-vault "${this.vault}": list defs — bad JSON: ${(err as Error).message}`);
    }
    type RawNote = { id?: string; path?: string; content?: string; metadata?: Record<string, unknown> };
    const notes: RawNote[] = Array.isArray(parsed)
      ? (parsed as RawNote[])
      : ((parsed as { notes?: RawNote[] })?.notes ?? []);
    const out: Array<{ id: string; path?: string; content?: string; metadata?: Record<string, unknown> }> = [];
    for (const n of notes) {
      if (typeof n.id === "string" && n.id) {
        // Carry the note PATH (when the vault surfaces one) so parseAgentDef can label the
        // composed-prompt self entry with the human-legible path, not the timestamp-id (#169).
        out.push({
          id: n.id,
          ...(typeof n.path === "string" && n.path ? { path: n.path } : {}),
          content: n.content,
          metadata: n.metadata,
        });
      }
    }
    return out;
  }

  /**
   * List the `#agent/thread` notes in this vault — the THREAD discovery source (Phase 4a
   * dual-discovery). INDEX-FREE: queries by the exact leaf tag. `include_content=false` —
   * unlike a def, a thread's BODY is NOT the prompt (it's the rolling summary; identity
   * composes at turn time), so we fetch only id/path/metadata (lighter than the def list).
   * Throws on a non-ok vault response (mirrors {@link listDefNotes}).
   */
  async listThreadNotes(opts?: { limit?: number }): Promise<
    Array<{ id: string; path?: string; metadata?: Record<string, unknown> }>
  > {
    const limit = opts?.limit ?? DEF_LIST_LIMIT;
    const params = new URLSearchParams();
    params.set("tag", AGENT_THREAD_TAG); // URLSearchParams encodes `/`→`%2F`
    params.set("limit", String(limit));
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes?${params.toString()}`;
    const res = await this.fetchFn(url, { headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`def-vault "${this.vault}": list threads failed (${res.status}) ${detail}`.trim());
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new Error(`def-vault "${this.vault}": list threads — bad JSON: ${(err as Error).message}`);
    }
    type RawNote = { id?: string; path?: string; metadata?: Record<string, unknown> };
    const notes: RawNote[] = Array.isArray(parsed)
      ? (parsed as RawNote[])
      : ((parsed as { notes?: RawNote[] })?.notes ?? []);
    const out: Array<{ id: string; path?: string; metadata?: Record<string, unknown> }> = [];
    for (const n of notes) {
      if (typeof n.id === "string" && n.id) {
        out.push({
          id: n.id,
          ...(typeof n.path === "string" && n.path ? { path: n.path } : {}),
          metadata: n.metadata,
        });
      }
    }
    return out;
  }

  /** Fetch ONE note by id (for a created/updated reload). Null on 404/miss. `tags` is carried
   *  through (reconcileRole needs it for the `#agent/role` security gate). */
  async getNote(
    id: string,
  ): Promise<{ id: string; path?: string; content?: string; metadata?: Record<string, unknown>; tags?: unknown } | null> {
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes/${encodeURIComponent(id)}?include_content=true`;
    const res = await this.fetchFn(url, { headers: { authorization: `Bearer ${this.token}` } });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`def-vault "${this.vault}": get note ${id} failed (${res.status}) ${detail}`.trim());
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new Error(`def-vault "${this.vault}": get note ${id} — bad JSON: ${(err as Error).message}`);
    }
    const n = (parsed ?? {}) as { id?: string; path?: string; note?: { id?: string; path?: string; content?: string; metadata?: Record<string, unknown>; tags?: unknown }; content?: string; metadata?: Record<string, unknown>; tags?: unknown };
    const note = n.note ?? n;
    if (typeof note.id !== "string" || !note.id) return null;
    return {
      id: note.id,
      // Carry the note PATH for the self-entry header (#169).
      ...(typeof note.path === "string" && note.path ? { path: note.path } : {}),
      content: note.content,
      metadata: note.metadata,
      // Carry tags for the role security gate (reconcileRole reads `#agent/role`).
      ...(note.tags !== undefined ? { tags: note.tags } : {}),
    };
  }

  /**
   * Stamp the resolved status onto the def note's metadata. PATCH merges the changed
   * fields (the vault merges metadata). `pending` is written as a comma-joined string
   * when present (the vault stores metadata as strings) and CLEARED (empty string)
   * otherwise, so a flip enabled→pending→enabled doesn't leave a stale list. Throws
   * on a non-ok response; the caller logs + continues (status is best-effort — a
   * failed stamp must not prevent the agent from running).
   */
  async patchStatus(
    noteId: string,
    status: AgentDefStatus,
    pending?: string[],
  ): Promise<void> {
    const metadata: Record<string, string> = { status };
    // Always set `pending` (to the list, or empty) so it never goes stale across flips.
    metadata.pending = pending && pending.length > 0 ? pending.join(", ") : "";
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes/${encodeURIComponent(noteId)}`;
    const res = await this.fetchFn(url, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      // `force: true` satisfies the vault's mutation precondition (it 428s without
      // `if_updated_at` or `force`). Safe: `status`/`pending` are the module's OWN
      // authoritative derived fields, the body carries no content, and the vault
      // MERGES metadata ({...existing, ...body.metadata}) so name/backend are kept.
      // (Without this the status stamp silently 428'd — caught via live testing.)
      body: JSON.stringify({ metadata, force: true }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`def-vault "${this.vault}": patch status ${noteId} failed (${res.status}) ${detail}`.trim());
    }
  }

  /**
   * Create a `#agent/definition` note: body = the system prompt, metadata = the
   * config, tagged the exact def tag (the same tag {@link listDefNotes} queries). The
   * vault assigns the note id; we return the created note (id + content + metadata) so
   * the caller can reload it into a live agent immediately. Throws on a non-ok vault
   * response. The path defaults under `Agents/<name>` (a flat, predictable slug) so a
   * vault surface groups them; the vault is free to relocate it.
   */
  async createNote(args: {
    content: string;
    metadata: Record<string, string>;
    path?: string;
  }): Promise<{ id: string; content?: string; metadata?: Record<string, unknown> }> {
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes`;
    const body: Record<string, unknown> = {
      content: args.content,
      tags: [AGENT_DEFINITION_TAG],
      metadata: args.metadata,
    };
    if (args.path) body.path = args.path;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`def-vault "${this.vault}": create def failed (${res.status}) ${detail}`.trim());
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new Error(`def-vault "${this.vault}": create def — bad JSON: ${(err as Error).message}`);
    }
    const n = (parsed ?? {}) as {
      id?: string;
      note?: { id?: string; content?: string; metadata?: Record<string, unknown> };
      content?: string;
      metadata?: Record<string, unknown>;
    };
    const note = n.note ?? n;
    if (typeof note.id !== "string" || !note.id) {
      throw new Error(`def-vault "${this.vault}": create def succeeded but response had no note id`);
    }
    return { id: note.id, content: note.content, metadata: note.metadata };
  }

  /**
   * Edit an existing def note: update its body (system prompt) and/or merge metadata
   * fields. `force: true` satisfies the vault's 428 mutation precondition (the module's
   * own authoritative edit; the vault MERGES metadata so unspecified fields are kept).
   * Only the provided fields are sent. Throws on a non-ok vault response.
   */
  async patchNote(
    noteId: string,
    fields: { content?: string; metadata?: Record<string, string> },
  ): Promise<void> {
    const body: Record<string, unknown> = { force: true };
    if (fields.content !== undefined) body.content = fields.content;
    if (fields.metadata !== undefined) body.metadata = fields.metadata;
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes/${encodeURIComponent(noteId)}`;
    const res = await this.fetchFn(url, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`def-vault "${this.vault}": patch def ${noteId} failed (${res.status}) ${detail}`.trim());
    }
  }

  /** Delete a def note by id. Throws on a non-ok vault response (404 IS ok — gone is gone). */
  async deleteNote(noteId: string): Promise<void> {
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes/${encodeURIComponent(noteId)}`;
    const res = await this.fetchFn(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => "");
      throw new Error(`def-vault "${this.vault}": delete def ${noteId} failed (${res.status}) ${detail}`.trim());
    }
  }
}

/**
 * The side-effects the registry needs to bring a def to life, injected so the
 * registry is unit-testable WITHOUT a daemon, a vault, a sandbox, or tmux.
 *
 *   - {@link ensureChannel} — bring up (or replace) the vault channel for the agent's
 *     wake channel. The daemon wires this to `addChannelLive` with a vault
 *     `ChannelEntry` built from the def-vault binding (the SAME path create-agent +
 *     boot use). Awaited so the transport is live before we register the agent.
 *   - {@link setupAndRegister} — persist `spec.json` (so the existing boot
 *     re-register + per-turn deliver find the workspace) + register the programmatic
 *     agent. The daemon wires this to `setupProgrammaticSpawn` + `programmatic.register`.
 *   - {@link deregister} — tear an agent down by name (drop its programmatic
 *     registration). The daemon wires this to `programmatic.deregister`.
 *   - {@link removeChannel} — stop + drop the wake channel (on delete). The daemon
 *     wires this to `removeChannelLive`.
 */
export interface InstantiateDeps {
  /** Bring up the vault channel for `name`, bound to `binding`. */
  ensureChannel(name: string, binding: DefVaultBinding): Promise<void>;
  /** Persist spec.json + register the programmatic agent for `spec`. */
  setupAndRegister(spec: AgentSpec): Promise<void>;
  /** Deregister the programmatic agent `name`. Returns whether one was registered. */
  deregister(name: string): Promise<boolean>;
  /** Stop + remove the wake channel `name`. Returns whether one existed. */
  removeChannel(name: string): Promise<boolean>;
}

/** The live record of an instantiated def (so a reload/delete can address it). */
interface LiveDef {
  /** The def-vault this agent belongs to. */
  vault: string;
  /** The note id (the reload/delete key within a vault). */
  noteId: string;
  /** The agent name (= wake channel) — for channel/registry teardown. */
  name: string;
  /** The resolved status (for /health + observability). */
  status: AgentDefStatus;
  /** The agent backend the def selected (`programmatic` | `attached`). */
  backend: AgentBackendKind;
  /** The execution-lifecycle mode the def selected (`single-threaded` | `multi-threaded`). */
  mode: AgentMode;
  /** First ~200 chars of the system prompt (the note body) — a preview, NOT a secret. */
  systemPromptPreview: string;
  /** Declared connections still pending approval (the status `pending` list), if any. */
  pending: string[];
  /** Structured `wants:` connection keys (surfaced for the UI; never a secret). */
  wants: string[];
  /**
   * Per-connection grant info (key, kind, target, hub grant status, grant id) — the
   * source the connections/MCP panel renders + drives Connect from. One entry per
   * declared `wants:` connection. Never a secret (status + id only, no token).
   */
  connections: ConnectionInfo[];
  /** The model the programmatic backend runs turns on (from `metadata.model`); unset = CC default. */
  model?: string;
  /** Which DISCOVERY SOURCE registered this agent — a `#agent/definition` note (`def`) or a
   *  `#agent/thread` note (`thread`). The observability axis for the Phase 4a cutover (prove
   *  thread-discovery is registering the agents before deleting the defs). */
  source: DiscoverySource;
}

/**
 * The detailed view of one live vault-native agent the `GET /api/agent-defs` route
 * returns — everything a UI needs to render + edit it, NO secrets (no tokens). The
 * channel == the agent name (agent ≡ channel); the vault is the def-vault.
 */
export interface AgentDefDetail {
  /** The vault note id (the create/edit/delete key). */
  noteId: string;
  /** The agent name (= wake channel + spec name). */
  name: string;
  /** The agent backend (`programmatic` | `attached`). */
  backend: AgentBackendKind;
  /** The execution-lifecycle mode (`single-threaded` | `multi-threaded`). */
  mode: AgentMode;
  /** The def-vault this agent is defined in. */
  vault: string;
  /** The resolved liveness status (`enabled` | `pending` | `error`). */
  status: AgentDefStatus;
  /** Declared connections still pending approval (empty when none). */
  pending: string[];
  /** First ~200 chars of the system prompt (the note body) — a preview, NOT the full text. */
  systemPromptPreview: string;
  /** Structured `wants:` connection keys the agent declared (empty when own-vault only). */
  wants: string[];
  /**
   * Per-connection grant info (key, kind, target, hub grant status, grant id) — the
   * connections/MCP panel renders status pills + drives the cookie→hub Connect from
   * this. Additive (a back-compat field; older clients ignore it). One entry per
   * declared `wants:` connection. NO secrets (status + id, never a token).
   */
  connections: ConnectionInfo[];
  /** The model the programmatic backend runs turns on (e.g. `opus`); undefined = CC default. */
  model?: string;
  /** The wake channel inbound routes to this agent on (== name). */
  channel: string;
  /** Which DISCOVERY SOURCE registered this agent (`def` | `thread`) — the Phase 4a cutover
   *  observability axis. Additive (older clients ignore it). */
  source: DiscoverySource;
}

/** How many chars of the system prompt the detail preview surfaces. */
export const SYSTEM_PROMPT_PREVIEW_LEN = 200;

/**
 * The FULL editable view of one live vault-native agent the `GET /api/agent-defs/<id>`
 * route returns — everything the edit form needs to pre-fill, including the FULL system
 * prompt (the whole note body, not the {@link AgentDefDetail} ~200-char preview). NO
 * secrets (no tokens). The list endpoint deliberately returns only the preview (cheap +
 * non-sensitive); this single-def fetch reads the note body fresh so an edit pre-fills
 * the actual prompt rather than a truncation.
 */
export interface AgentDefFull {
  /** The vault note id (the edit/delete key). */
  noteId: string;
  /** The agent name (= wake channel + spec name). */
  name: string;
  /** The agent backend (`programmatic` | `attached`). */
  backend: AgentBackendKind;
  /** The def-vault this agent is defined in. */
  vault: string;
  /** The execution-lifecycle mode (`single-threaded` | `multi-threaded`). */
  mode: AgentMode;
  /** Structured `wants:` connection keys the agent declared (empty when own-vault only). */
  wants: string[];
  /**
   * Per-connection grant info (key, kind, target, hub grant status, grant id) — same
   * additive field {@link AgentDefDetail} carries, so the edit view's connections panel
   * can render status + drive Connect without a second fetch. NO secrets.
   */
  connections: ConnectionInfo[];
  /** The model the programmatic backend runs turns on (e.g. `opus`); undefined = CC default. */
  model?: string;
  /** The FULL system prompt — the whole note body (NOT truncated). */
  systemPrompt: string;
  /** The resolved liveness status (`enabled` | `pending` | `error`). */
  status: AgentDefStatus;
}

/**
 * The vault-native agent-def registry — reads `#agent/definition` notes from the
 * configured def-vaults and keeps the live agent set in sync with them.
 *
 * Lifecycle (the design's reactive model):
 *   - {@link loadAll} (boot) — for each def-vault, list its defs + instantiate each.
 *   - {@link reload} (trigger / poll) — re-read ONE note: created/updated →
 *     re-instantiate; deleted (note gone) → deregister. Per-note granularity via the
 *     `vault + noteId → LiveDef` map.
 *   - {@link deregisterAllForVault} — drop a whole vault's agents (config change).
 *
 * Grant-GC (#96): the registry also keeps the hub's grant rows in sync with the live
 * def set so a removed connection / a deleted def doesn't orphan an approved grant. On
 * a CONFIDENT signal only — a clean successful instantiate (prune to the def's current
 * `wants:` keys) or a CONFIRMED removal (deleted/404 → prune ALL) — it POSTs the hub's
 * reconcile endpoint; a transient parse/list/fetch failure NEVER prunes (safety guard).
 *
 * Idempotent: re-instantiating the same name swaps the registration in place
 * (`programmatic.register` + `addChannelLive` both replace-by-name), so an update is
 * a clean re-instantiate, not a duplicate. A name collision ACROSS def-vaults (two
 * vaults both defining `uni-dev`) is resolved last-writer-wins on the shared wake
 * channel; we log it (the operator owns their vaults — 4a is own-box).
 */
export class AgentDefRegistry {
  /** def-vault name → its client. */
  private readonly clients = new Map<string, DefVaultClient>();
  /** def-vault name → its binding (for `ensureChannel`). */
  private readonly bindings = new Map<string, DefVaultBinding>();
  /** `${vault}\u0000${noteId}` → the live record. */
  private readonly live = new Map<string, LiveDef>();
  /**
   * Per-vault set of `#agent/definition` notes seen on the LAST CONFIDENT read —
   * `noteId → agentName` — the prior-known set the removed-def diff (grant-GC, #96)
   * compares against. ONLY mutated from a confident signal: a successful vault LIST
   * (loadAll) or a confirmed single-note removal/instantiate (reload). A note's name is
   * its parsed `metadata.name`; a present-but-parse-failing note KEEPS its last-known
   * name (carry-forward) so a transient parse error never drops it from the tracked set
   * — which would wrongly flag it as removed (safety guard, design "only prune from a
   * confident live set"). Keyed `vault → (noteId → agentName)`.
   */
  private readonly seenDefs = new Map<string, Map<string, string>>();
  private readonly deps: InstantiateDeps;
  /**
   * The hub grants client (4b) — used to REGISTER each def's `wants:` connections as
   * pending grants on instantiate + resolve status from the hub's grant statuses.
   * Optional: null when the hub isn't provisioned yet (no manager bearer) — then the
   * registry falls back to {@link resolveDefStatus} (pending if any connection is
   * declared) and never registers, so the vault-native path still runs own-vault.
   */
  private grants: GrantsClient | null;
  /**
   * The discovery-source toggle (env `PARACHUTE_AGENT_DISCOVERY`). Gates which note types
   * {@link loadAll} lists and which reactive reload paths run: `both` (default) lists defs
   * THEN threads (def wins on a name collision); `thread` lists threads only; `def` lists
   * defs only (today's behavior). Fixed at construction — the cutover is a restart.
   */
  private readonly discoveryMode: DiscoveryMode;

  constructor(
    deps: InstantiateDeps,
    opts?: {
      bindings?: DefVaultBinding[];
      fetchFn?: typeof fetch;
      grants?: GrantsClient | null;
      discovery?: DiscoveryMode;
    },
  ) {
    this.deps = deps;
    this.grants = opts?.grants ?? null;
    this.discoveryMode = opts?.discovery ?? "both";
    for (const b of opts?.bindings ?? []) {
      this.addVault(b, opts?.fetchFn);
    }
  }

  /** The active discovery mode (for /health + observability + tests). */
  get discovery(): DiscoveryMode {
    return this.discoveryMode;
  }

  /** Whether `#agent/definition` notes are a discovery source under the active mode. */
  private defsEnabled(): boolean {
    return this.discoveryMode !== "thread";
  }

  /** Whether `#agent/thread` notes are a discovery source under the active mode. */
  private threadsEnabled(): boolean {
    return this.discoveryMode !== "def";
  }

  /**
   * Whether the agent `name` is ALREADY live in the registry under a DIFFERENT live-map key
   * — the dedup gate for thread-discovery (a thread whose name a def already registered is
   * skipped: def wins in `both` mode). `exceptKey` is the candidate's own key, so a thread
   * re-instantiating itself across polls is NOT seen as a collision with itself.
   */
  private isNameLiveElsewhere(name: string, exceptKey: string): boolean {
    for (const [key, d] of this.live) {
      if (d.name === name && key !== exceptKey) return true;
    }
    return false;
  }

  /**
   * Drop any OTHER live-map entry that shares `name` (keeping `keepKey`) — WITHOUT
   * deregistering the agent. Used after a DEF instantiates so the def WINS on a name
   * collision with a thread-sourced entry (a thread registered before its def appeared,
   * a reactive-ordering edge): the channel + programmatic registration are name-keyed and
   * already replaced-in-place by the def, so this only de-duplicates the live MAP (no
   * teardown — same name, still a live agent). Keeps the listing name-unique + def-sourced.
   */
  private evictOtherLiveByName(name: string, keepKey: string): void {
    for (const [key, d] of [...this.live]) {
      // ONLY a THREAD-sourced entry is evicted — a def-over-def same-name collision ACROSS
      // def-vaults is the existing multi-vault case (both kept in the live map so
      // {@link findLiveByNote} can flag the #106 ambiguity); evicting one would mask it.
      if (d.name === name && key !== keepKey && d.source === "thread") {
        this.live.delete(key);
        console.log(
          `agent-defs: '${name}' now sourced from def (${keepKey}); dropped the stale ` +
            `thread-sourced live entry (${key}) — def wins on a name collision.`,
        );
      }
    }
  }

  /** Wire (or replace) the hub grants client — set once the manager bearer resolves
   *  at boot (the constructor runs before the operator token is read). */
  setGrantsClient(grants: GrantsClient | null): void {
    this.grants = grants;
  }

  /** Register a def-vault binding (additive — multi-vault is appending). */
  addVault(binding: DefVaultBinding, fetchFn?: typeof fetch): void {
    this.clients.set(binding.vault, new DefVaultClient(binding, fetchFn));
    this.bindings.set(binding.vault, binding);
  }

  /**
   * Remove a def-vault binding (the client + binding indexes). The caller
   * ({@link deregisterAllForVault}) tears down the vault's live agents FIRST; this
   * drops the registry's knowledge of the vault so a later `loadAll` no longer queries
   * it. Idempotent. Does NOT touch the persisted `agent-vaults.json` — that's the
   * daemon route's job (the registry has no file knowledge).
   */
  removeVault(vault: string): void {
    this.clients.delete(vault);
    this.bindings.delete(vault);
    this.seenDefs.delete(vault);
  }

  /** The number of def-vaults bound (for /health + tests). */
  get vaultCount(): number {
    return this.clients.size;
  }

  /** The sole bound def-vault's name, or undefined when not exactly one. Lets the
   *  reload webhook default `vault` when the install is single-vault (the common case). */
  soleVaultName(): string | undefined {
    if (this.clients.size !== 1) return undefined;
    return [...this.clients.keys()][0];
  }

  /** The live instantiated defs (for /health + the agents list + tests). */
  list(): ReadonlyArray<{
    vault: string;
    noteId: string;
    name: string;
    status: AgentDefStatus;
    source: DiscoverySource;
  }> {
    return [...this.live.values()].map((d) => ({
      vault: d.vault,
      noteId: d.noteId,
      name: d.name,
      status: d.status,
      source: d.source,
    }));
  }

  /**
   * The live instantiated defs in the DETAILED `GET /api/agent-defs` shape — backend,
   * vault, status, pending, the system-prompt PREVIEW (not the full body), wants, and
   * the wake channel. NO secrets (no tokens). Sorted by name for a stable list.
   */
  listDetailed(): AgentDefDetail[] {
    return [...this.live.values()]
      .map((d) => ({
        noteId: d.noteId,
        name: d.name,
        backend: d.backend,
        mode: d.mode,
        vault: d.vault,
        status: d.status,
        pending: [...d.pending],
        systemPromptPreview: d.systemPromptPreview,
        wants: [...d.wants],
        connections: d.connections.map((c) => ({ ...c })),
        ...(d.model ? { model: d.model } : {}),
        channel: d.name, // agent ≡ channel.
        source: d.source,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Whether a def-vault by this name is configured (the write-path vault guard). */
  hasVault(vault: string): boolean {
    return this.clients.has(vault);
  }

  /** The configured def-vault names (for /api/agent-vaults + the write-path guard). */
  vaultNames(): string[] {
    return [...this.clients.keys()];
  }

  /**
   * The configured def-vault bindings VERBATIM (carrying their tokens) — for
   * persisting the live set back to `agent-vaults.json` on an add (so a boot-minted
   * default's real token is preserved, never clobbered to empty). INTERNAL: this
   * carries SECRETS — never serialize it to the wire (the wire view is
   * {@link vaultStatuses}). Returns copies so a caller can't mutate the registry's
   * bindings in place.
   */
  liveBindings(): DefVaultBinding[] {
    return [...this.bindings.values()].map((b) => ({ ...b }));
  }

  /**
   * The configured def-vaults as a non-secret view — name + url + whether a token is
   * present (NEVER the token VALUE). The `GET /api/agent-vaults` listing's source of
   * truth (the live registry, not the on-disk file, so a boot-minted binding shows its
   * token even before the file write lands). Sorted by name.
   */
  vaultStatuses(): Array<{ vault: string; url: string; tokenPresent: boolean }> {
    return [...this.bindings.values()]
      .map((b) => ({
        vault: b.vault,
        url: b.vaultUrl ?? DEFAULT_DEF_VAULT_URL,
        tokenPresent: typeof b.token === "string" && b.token.length > 0,
      }))
      .sort((a, b) => a.vault.localeCompare(b.vault));
  }

  /**
   * Whether a note id is a CURRENTLY-LIVE def in a given vault — the write-path guard
   * for PATCH/DELETE so the routes only ever touch notes this module actually
   * instantiated as `#agent/definition` agents in a configured def-vault (not an
   * arbitrary note id an operator passes). Returns the live detail when it is, else
   * null.
   */
  liveDef(vault: string, noteId: string): AgentDefDetail | null {
    const d = this.live.get(this.keyOf(vault, noteId));
    if (!d) return null;
    return {
      noteId: d.noteId,
      name: d.name,
      backend: d.backend,
      mode: d.mode,
      vault: d.vault,
      status: d.status,
      pending: [...d.pending],
      systemPromptPreview: d.systemPromptPreview,
      wants: [...d.wants],
      connections: d.connections.map((c) => ({ ...c })),
      ...(d.model ? { model: d.model } : {}),
      channel: d.name,
      source: d.source,
    };
  }

  /** Find a live def by note id across ALL configured vaults (PATCH/DELETE address
   *  a note by id; the vault is resolved here). Returns the {vault, detail} or null.
   *  AMBIGUITY GUARD (#106 review): if two configured def-vaults each vend a note at
   *  the SAME id, picking the first match is non-deterministic — so throw a 409-class
   *  {@link AgentDefWriteError} ("specify vault") rather than silently mutating one of
   *  them. The single-match happy path is unchanged. */
  findLiveByNote(noteId: string): { vault: string; detail: AgentDefDetail } | null {
    const matches: string[] = [];
    for (const d of this.live.values()) {
      if (d.noteId === noteId) matches.push(d.vault);
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new AgentDefWriteError(
        `note ${noteId} is a live agent definition in multiple def-vaults (${matches
          .sort()
          .join(", ")}); ambiguous note id across vaults — specify vault`,
        409,
      );
    }
    const vault = matches[0]!;
    return { vault, detail: this.liveDef(vault, noteId)! };
  }

  /**
   * Fetch ONE live def's FULL editable view (the `GET /api/agent-defs/<id>` route) — the
   * same fields {@link liveDef} carries, but with the FULL system prompt read fresh from
   * the note body (the list/detail carries only the ~200-char preview, which can't pre-
   * fill an edit form). The note MUST be a currently-live def we instantiated in a
   * configured vault — same guard as the PATCH/DELETE write paths (resolves the vault via
   * {@link findLiveByNote}, so an unknown/non-def id → null and the route 404s; an
   * ambiguous-across-vaults id throws the 409-class {@link AgentDefWriteError}). NO
   * secrets — the body is the prompt, never a token. Returns null when the note isn't a
   * live def OR the vault no longer vends it (a delete that races the fetch).
   */
  async getFullDef(noteId: string): Promise<AgentDefFull | null> {
    const found = this.findLiveByNote(noteId);
    if (!found) return null;
    const client = this.clients.get(found.vault);
    if (!client) return null;
    const note = await client.getNote(noteId);
    if (!note) return null;
    const detail = found.detail;
    return {
      noteId: detail.noteId,
      name: detail.name,
      backend: detail.backend,
      vault: detail.vault,
      mode: detail.mode,
      wants: [...detail.wants],
      connections: detail.connections.map((c) => ({ ...c })),
      ...(detail.model ? { model: detail.model } : {}),
      systemPrompt: typeof note.content === "string" ? note.content : "",
      status: detail.status,
    };
  }

  private keyOf(vault: string, noteId: string): string {
    return `${vault}\u0000${noteId}`;
  }

  /**
   * Read all agents from every bound def-vault + instantiate each. The DISCOVERY MODE
   * (Phase 4a dual-discovery) selects the source(s): `def`/`both` list `#agent/definition`
   * notes; `thread`/`both` ALSO list `#agent/thread` notes. In `both`, defs run FIRST so a
   * thread whose name a def already registered is DEDUPED (def wins). Best-effort per vault
   * AND per note: a single list failure (or one note's parse/instantiate failure) is logged
   * and never aborts the others. Returns the count successfully instantiated.
   *
   * Removed-def convergence (DEF source only): after a CONFIDENT read (a successful, non-
   * truncated list of the vault's whole def set), diff the prior-known def set against it —
   * any note now GONE has had its `#agent/definition` note deleted, so the agent is TORN
   * DOWN + grants pruned. This is the ONLY automatic path for a def deletion (no vault
   * `deleted` trigger — see {@link pruneRemovedDefs}). THREADS have NO such diff here:
   * thread-discovery is purely ADDITIVE (it never tears down), so a removed/disabled thread
   * does not auto-deregister via the poll — teardown stays on the thread-status webhook +
   * the reactive {@link reloadThread} (deleted/404) + a restart. This keeps the load-bearing
   * weave safe (the poll can never accidentally tear down a live agent from a thread read).
   */
  async loadAll(): Promise<number> {
    let count = 0;
    for (const [vault, client] of this.clients) {
      // ── DEF source (modes `def` + `both`) — the original path, untouched. ──────────
      if (this.defsEnabled()) {
        let notes: Awaited<ReturnType<DefVaultClient["listDefNotes"]>> | undefined;
        try {
          notes = await client.listDefNotes({ limit: DEF_LIST_LIMIT });
        } catch (err) {
          console.error(`agent-defs: listing defs from vault "${vault}" failed (continuing): ${(err as Error).message}`);
          // CONFIDENT-SET GUARD: a failed list is NOT a confident read — leave the prior
          // seen set untouched (NO removed-def diff, NO instantiate) so a hub/vault blip can't
          // prune grants or tear an agent down. `notes` stays undefined → the block below is
          // skipped, but the INDEPENDENT thread source still runs (it has its own try/catch).
        }
        if (notes !== undefined) {
          // TRUNCATION GUARD (the second way a read is non-confident): a list at the page cap
          // may be partial. The removed-def diff now performs a DESTRUCTIVE teardown
          // (pruneRemovedDefs deregisters), so a truncated read that omits the tail must NOT be
          // mistaken for deletions. Skip the diff + the seen-set rebuild (rebuilding from a
          // truncated list would drop the omitted tail and mis-flag it removed next pass); still
          // (re)instantiate what we got — instantiate only adds/updates, never tears down.
          // Practically unreachable at today's agent counts; the guard makes the teardown safe
          // by construction.
          // `< cap` ⇒ the result fit on one page → it cannot be truncated; `>= cap` is the
          // (possibly-)truncated case the `else` defers.
          const confident = notes.length < DEF_LIST_LIMIT;
          if (confident) {
            // Detect removed defs by diffing the prior seen set (noteId→name) against the ids
            // present now, BEFORE we mutate it.
            const presentIds = new Set(notes.map((n) => n.id));
            await this.pruneRemovedDefs(vault, presentIds);
            // Rebuild the seen set from this confident read (carry-forward last-known names for
            // notes that fail to parse, so a transient parse error doesn't drop them).
            this.rebuildSeenDefs(vault, notes);
          } else {
            console.warn(
              `agent-defs: def list for "${vault}" returned ${notes.length} notes (>= the ${DEF_LIST_LIMIT} ` +
                `page cap) — skipping the removed-def reconcile this pass to avoid a truncated-read teardown.`,
            );
          }
          for (const note of notes) {
            if (await this.instantiate(vault, note)) count++;
          }
        }
      }

      // ── THREAD source (modes `thread` + `both`) — additive dual-discovery. ─────────
      // Runs AFTER the def loop so a thread whose name a def already registered dedups
      // against it (def wins in `both`). Purely additive: a list failure / one bad thread
      // is logged + skipped; NO removed-thread teardown (see the method note above).
      if (this.threadsEnabled()) {
        let threads: Awaited<ReturnType<DefVaultClient["listThreadNotes"]>>;
        try {
          threads = await client.listThreadNotes({ limit: DEF_LIST_LIMIT });
        } catch (err) {
          console.error(
            `agent-defs: listing threads from vault "${vault}" failed (continuing): ${(err as Error).message}`,
          );
          continue;
        }
        for (const note of threads) {
          if (await this.instantiateThread(vault, note)) count++;
        }
      }
    }
    return count;
  }

  /**
   * Reconcile every def that was in the prior seen set for `vault` but is NOT in
   * `presentIds` (its note was deleted) — tear the agent DOWN (drop the live
   * programmatic registration + the wake channel) AND `reconcileGrants(agent, [])`
   * prune ALL its grants. Best-effort throughout; grant cleanup is a no-op without a
   * grants client. Called ONLY with a confident current id set (a successful,
   * non-truncated list); never on a list failure or a truncated read (see {@link loadAll}).
   *
   * Why the poll MUST deregister (not just prune grants): there is NO vault `deleted`
   * trigger — the hub's connection engine maps only `note.created`/`note.updated` to
   * vault-trigger verbs (parachute-hub `admin-connections` `eventToVaultEvents`), so a
   * def deleted out-of-band NEVER fires the reactive `reload(...,"deleted")` teardown.
   * This poll is the ONLY automatic convergence path for a deletion, so it must do the
   * SAME full teardown {@link confirmedRemoval} does, or a deleted agent stays live (an
   * orphan: gone from the vault, still answering messages) until the daemon restarts.
   */
  private async pruneRemovedDefs(vault: string, presentIds: Set<string>): Promise<void> {
    const prior = this.seenDefs.get(vault);
    if (!prior) return; // first confident read of this vault — nothing to compare against.
    for (const [noteId, name] of prior) {
      if (presentIds.has(noteId)) continue; // still present — not a removal.
      // Confirmed removal: the def note is gone from a confident vault read. Tear the
      // agent + wake channel down, then prune its grants. (The seen-set entry is cleared
      // by the `rebuildSeenDefs` that runs right after this in `loadAll`.)
      await this.deregisterByNote(vault, noteId);
      await this.reconcileForRemovedAgent(name);
    }
  }

  /**
   * Rebuild the per-vault seen set from a confident list. Each present note maps
   * noteId→its parsed `metadata.name`; a note that fails to parse keeps its prior
   * last-known name (so a transient parse error doesn't drop it from the tracked set
   * and wrongly flag it removed next pass). A note that never had a name (parse-failed
   * on first sight) is tracked id-only (empty name) so it isn't re-detected as removed.
   */
  private rebuildSeenDefs(
    vault: string,
    notes: Array<{ id: string; content?: string; metadata?: Record<string, unknown> }>,
  ): void {
    const prior = this.seenDefs.get(vault);
    const next = new Map<string, string>();
    for (const note of notes) {
      const name = nameOfDefNote(note) ?? prior?.get(note.id) ?? "";
      next.set(note.id, name);
    }
    this.seenDefs.set(vault, next);
  }

  /**
   * Reconcile a CONFIRMED-removed agent's grants away (prune ALL). Best-effort + no-op
   * without a grants client / without a known name.
   *
   * FIX 5 (PR #3) — make the failure NON-SILENT. A hub-unreachable reconcile used to be
   * caught + logged + ignored, ORPHANING the agent's approved grants on the hub (a
   * re-created same-named agent resurrects them). It's still BEST-EFFORT (we don't block
   * the note delete on grant cleanup — the def IS gone), but we now (a) `console.warn`
   * loudly AND (b) RETURN a structured signal so the caller can surface a PARTIAL success
   * (delete succeeded, grant cleanup didn't) rather than claiming a clean full success.
   * `skipped` = no grants client / no name (nothing to reconcile — a true no-op).
   */
  private async reconcileForRemovedAgent(
    name: string,
  ): Promise<{ ok: true; pruned: number } | { ok: false; error: string } | { skipped: true }> {
    if (!this.grants || !name) return { skipped: true };
    try {
      const { pruned } = await this.grants.reconcileGrants(name, []);
      if (pruned > 0) {
        console.log(`agent-defs: pruned ${pruned} stale grant(s) for removed agent "${name}".`);
      }
      return { ok: true, pruned };
    } catch (err) {
      const error = (err as Error).message;
      // NON-SILENT (FIX 5): a swallowed grant-GC failure orphans approved grants on the
      // hub. Warn loudly + return the failure so the delete path reports partial success.
      console.warn(
        `agent-defs: pruning grants for removed agent "${name}" FAILED — its approved hub ` +
          `grants may be ORPHANED (re-creating a same-named agent would resurrect them); ` +
          `the note delete still completed (best-effort grant cleanup): ${error}`,
      );
      return { ok: false, error };
    }
  }

  /**
   * Reload ONE def by note id (the reactive path — a vault trigger / poll says this
   * note changed). Re-reads the note from its vault: present → (re)instantiate;
   * absent (deleted) → deregister. `event` is a hint from the trigger
   * (`created`/`updated`/`deleted`); we still re-read so a stale/racing event
   * resolves to ground truth (a "created" that was since deleted tears down, not up).
   *
   * Returns the resulting state so the webhook can ack meaningfully.
   */
  async reload(
    vault: string,
    noteId: string,
    event?: "created" | "updated" | "deleted",
  ): Promise<"instantiated" | "deregistered" | "skipped"> {
    // DISCOVERY-MODE GATE: in `thread` mode `#agent/definition` notes are NOT a source, so a
    // def-reload webhook is a clean no-op (registering the def would collide with the thread-
    // sourced agent). The def-watch triggers may still fire (they're not torn down at cutover);
    // we simply ignore them. `def`/`both` proceed.
    if (!this.defsEnabled()) return "skipped";
    const client = this.clients.get(vault);
    if (!client) {
      console.warn(`agent-defs: reload for unknown def-vault "${vault}" — ignoring.`);
      return "skipped";
    }
    // A delete event: the note is gone — tear down without a fetch (the GET would 404
    // anyway; skipping it is faster + avoids a confusing 404 log). A delete is a
    // CONFIRMED removal → prune the agent's grants (#96).
    if (event === "deleted") {
      await this.confirmedRemoval(vault, noteId);
      return "deregistered";
    }
    let note: Awaited<ReturnType<DefVaultClient["getNote"]>>;
    try {
      note = await client.getNote(noteId);
    } catch (err) {
      console.error(`agent-defs: reload fetch of ${noteId} from "${vault}" failed: ${(err as Error).message}`);
      // A fetch FAILURE is NOT a confirmed removal — skip without pruning grants (safety
      // guard: never prune from an inconclusive read). The agent + grants stay intact.
      return "skipped";
    }
    if (!note) {
      // Re-read 404 says it's gone (deleted, or no longer carries the def tag we can
      // see) — a CONFIRMED removal → prune the agent's grants (#96).
      await this.confirmedRemoval(vault, noteId);
      return "deregistered";
    }
    return (await this.instantiate(vault, note)) ? "instantiated" : "skipped";
  }

  /**
   * Reload ONE `#agent/thread` note by id (the reactive THREAD-discovery path — a thread-
   * watch trigger says this note changed; Phase 4a). The thread analogue of {@link reload},
   * but ADDITIVE: present + enabled + not-deduped → (re)instantiate; deleted/404 → deregister
   * ONLY the thread-sourced agent at this note's key (a def-sourced same-name agent keyed by a
   * DIFFERENT note is left intact). NO grant-GC (threads register no grants — only roles do).
   *
   * DISCOVERY-MODE GATE: a no-op in `def` mode (threads aren't a source then). DEDUP: in
   * `both` mode a thread whose name a def already registered is skipped (def wins). DISABLE:
   * a thread with `agent_status: disabled` is NOT registered (and if it was thread-sourced-live,
   * we tear it down so a flip-to-disabled converges reactively too).
   */
  async reloadThread(
    vault: string,
    noteId: string,
    event?: "created" | "updated" | "deleted",
  ): Promise<"instantiated" | "deregistered" | "skipped"> {
    if (!this.threadsEnabled()) return "skipped";
    const client = this.clients.get(vault);
    if (!client) {
      console.warn(`agent-defs: thread reload for unknown def-vault "${vault}" — ignoring.`);
      return "skipped";
    }
    const key = this.keyOf(vault, noteId);
    // A delete event: the thread note is gone — tear down ONLY a thread-sourced agent at this
    // key (deregisterByNote no-ops if this key isn't live, e.g. a def-sourced same-name agent
    // keyed elsewhere). No fetch needed.
    if (event === "deleted") {
      if (this.live.get(key)?.source === "thread") await this.deregisterByNote(vault, noteId);
      return "deregistered";
    }
    let note: Awaited<ReturnType<DefVaultClient["getNote"]>>;
    try {
      note = await client.getNote(noteId);
    } catch (err) {
      console.error(`agent-defs: thread reload fetch of ${noteId} from "${vault}" failed: ${(err as Error).message}`);
      // A fetch FAILURE is inconclusive — never tear down (safety). Leave the agent intact.
      return "skipped";
    }
    if (!note) {
      // 404 — the thread is gone. Tear down ONLY a thread-sourced agent at this key.
      if (this.live.get(key)?.source === "thread") await this.deregisterByNote(vault, noteId);
      return "deregistered";
    }
    return (await this.instantiateThread(vault, note)) ? "instantiated" : "skipped";
  }

  /**
   * Reconcile ONE ROLE's grants (roles as the capability layer —
   * DESIGN-2026-06-29-threads-roles-context.md). Driven by the per-role vault trigger
   * (`POST /api/vault/role` → here), NOT by load (load is per-turn). A role is the
   * GRANT-DECLARING note; its `wants:` is keyed on the hub by the role's slugged PATH
   * ({@link rolePathKey}) — its OWN prune partition, so this reconcile can NEVER touch a def's
   * grants or another role's (the `feedback_cross_repo_derived_key_divergence` class is
   * structurally avoided: the live set is trivially this one note's current `wants:`).
   *
   * Outcomes (mirrors the def-load grant discipline):
   *   - `deleted` event (FORWARD-COMPATIBLE — the vault has no `deleted` trigger today, so the
   *     live delete path is the 404 case below + the 60s loadAll poll; the explicit handling is
   *     kept so a future `deleted` trigger Just Works), OR the note is gone (404), OR it no
   *     longer carries `#agent/role`, OR it declares no `wants:`  → PRUNE that role's partition to
   *     [] (`reconcileGrants(roleKey, [])`). Per-role, so safe.
   *   - a clean parse of an `#agent/role` note's `wants:` → REGISTER each connection under `roleKey`
   *     (idempotent upsert) + RECONCILE to that live set (prune any want it no longer declares).
   *   - a PARSE ERROR on `wants:` → stamp the note `status:error`, NEVER reconcile (a malformed
   *     role must not present a stale/empty live set that nukes its approved grants — the same
   *     safety rule the def path uses).
   *   - no grants client (hub not provisioned) → no-op (best-effort).
   *
   * Best-effort + non-fatal throughout — a reconcile/registration fault logs + returns; it never
   * throws out of the webhook path. The role's PATH is read off the note (fallback: the note id).
   */
  async reconcileRole(
    vault: string,
    noteId: string,
    event?: "created" | "updated" | "deleted",
  ): Promise<"reconciled" | "pruned" | "error" | "skipped"> {
    if (!this.grants) return "skipped"; // hub not provisioned → no grant store to reconcile.
    const client = this.clients.get(vault);
    if (!client) {
      console.warn(`agent-defs: role reconcile for unknown vault "${vault}" — ignoring.`);
      return "skipped";
    }
    // A delete event: the note is gone — prune its partition without a fetch (a CONFIRMED removal).
    if (event === "deleted") {
      await this.pruneRoleGrants(rolePathKey(noteId));
      return "pruned";
    }
    let note: Awaited<ReturnType<DefVaultClient["getNote"]>>;
    try {
      note = await client.getNote(noteId);
    } catch (err) {
      // A fetch FAILURE is NOT a confirmed removal — never prune from an inconclusive read.
      console.error(`agent-defs: role reconcile fetch of ${noteId} from "${vault}" failed: ${(err as Error).message}`);
      return "skipped";
    }
    if (!note) {
      // 404 — the role is gone (deleted / no longer visible). CONFIRMED removal → prune its partition.
      await this.pruneRoleGrants(rolePathKey(noteId));
      return "pruned";
    }
    // The grant key is the role's PATH (slugged), mirroring the slug discipline grantId uses.
    // Fall back to the note id when the vault didn't surface a path.
    const rolePath = typeof note.path === "string" && note.path ? note.path : noteId;
    const roleKey = rolePathKey(rolePath);
    // THE SECURITY GATE: only an `#agent/role` note's `wants:` is honored. A note that lost the
    // role tag (or never had it) drops to prune-to-[] for its partition — its `wants:` is inert.
    if (!isRoleNote({ tags: (note as { tags?: unknown }).tags })) {
      await this.pruneRoleGrants(roleKey);
      return "pruned";
    }
    let wants: ConnectionSpec[];
    try {
      wants = parseWants(note.metadata?.wants);
    } catch (err) {
      // A malformed `wants:` → stamp the note `status:error`, NEVER reconcile (don't present a
      // stale/empty live set that would nuke this role's approved grants). Best-effort stamp.
      console.error(`agent-defs: role ${noteId} in "${vault}" has a malformed wants: ${(err as Error).message}`);
      await client.patchStatus(noteId, "error").catch(() => {});
      return "error";
    }
    if (wants.length === 0) {
      // The role declares no wants (or dropped them) → prune its partition to [] (per-role, safe).
      await this.pruneRoleGrants(roleKey);
      return "pruned";
    }
    // REGISTER each want under the role key (idempotent upsert) + RECONCILE to this live set.
    const grants = this.grants;
    for (const conn of wants) {
      try {
        await grants.registerGrant(roleKey, conn);
      } catch (err) {
        // A single registration fault is non-fatal — the others still register; the operator
        // approves later. (The reconcile below sends the live SPECS, so a missed register
        // doesn't get pruned.)
        console.warn(
          `agent-defs: registering role grant for "${roleKey}" (${connectionKey(conn)}) failed ` +
            `(continuing): ${(err as Error).message}`,
        );
      }
    }
    try {
      const { pruned } = await grants.reconcileGrants(roleKey, wants);
      if (pruned > 0) console.log(`agent-defs: pruned ${pruned} stale grant(s) for role "${roleKey}".`);
    } catch (err) {
      console.warn(`agent-defs: reconciling role grants for "${roleKey}" failed (continuing): ${(err as Error).message}`);
    }
    return "reconciled";
  }

  /**
   * Prune a role's grant partition to [] (`reconcileGrants(roleKey, [])`) — the per-role GC for a
   * deleted role / a role that dropped `wants:` / a note that lost the `#agent/role` tag. Per-role,
   * so it can never touch a def's or another role's grants. Best-effort: a fault logs + returns.
   */
  private async pruneRoleGrants(roleKey: string): Promise<void> {
    if (!this.grants) return;
    try {
      const { pruned } = await this.grants.reconcileGrants(roleKey, []);
      if (pruned > 0) console.log(`agent-defs: pruned ${pruned} grant(s) for removed role "${roleKey}".`);
    } catch (err) {
      console.warn(`agent-defs: pruning role grants for "${roleKey}" failed (continuing): ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Def write path (the v2 API layer) — create / edit / delete a `#agent/definition`
  // note in a configured def-vault, then reload it into a LIVE agent immediately (the
  // per-note reload, NOT the 60s poll). The daemon owns the def-vault write token
  // (def-vaults.ts); these methods drive its client. Validation is the registry's job
  // (vault configured, name slug, backend valid) so the daemon route stays thin.
  // ---------------------------------------------------------------------------

  /**
   * Create a new `#agent/definition` note in `vault` (body = system prompt, metadata =
   * name/backend/wants/extra), then reload it so the agent is LIVE immediately (no
   * wait for the trigger or the poll). Returns the created def in the {@link
   * AgentDefDetail} shape. Throws {@link AgentDefWriteError} on a validation failure
   * (unknown vault, bad name, bad backend) or a write/reload failure.
   */
  async createDef(args: {
    vault: string;
    name: string;
    backend: AgentBackendKind;
    systemPrompt: string;
    wants?: string;
    metadata?: Record<string, string>;
  }): Promise<AgentDefDetail> {
    const client = this.clients.get(args.vault);
    if (!client) {
      throw new AgentDefWriteError(`unknown def-vault "${args.vault}" (configure it first)`, 400);
    }
    if (!NAME_SLUG_RE.test(args.name)) {
      throw new AgentDefWriteError(
        `name "${args.name}" must be a slug (alphanumeric, dash, underscore)`,
        400,
      );
    }
    // DUAL-READ the legacy backend value `"channel"` → canonical `"attached"`, so a
    // caller (or a hand-driven API client) passing the pre-rename value still WRITES the
    // canonical value. The routing key `channel` is a separate concept, unchanged.
    const backend: AgentBackendKind =
      (args.backend as string) === "channel" ? "attached" : args.backend;
    if (backend !== "programmatic" && backend !== "attached") {
      throw new AgentDefWriteError(`backend must be "programmatic" or "attached"`, 400);
    }
    // A name collision with a live def (in ANY vault — the wake channel is shared) would
    // resurrect last-writer-wins on the channel; reject up front for a clean error.
    for (const d of this.live.values()) {
      if (d.name === args.name) {
        throw new AgentDefWriteError(
          `an agent named "${args.name}" already exists (note ${d.noteId} in "${d.vault}")`,
          409,
        );
      }
    }
    const metadata = this.buildDefMetadata({ ...args, backend });
    const created = await client.createNote({
      content: args.systemPrompt,
      metadata,
      path: `Agents/${args.name}`,
    });
    // Reload the just-created note → instantiate it LIVE now (the immediate path).
    await this.reload(args.vault, created.id, "created");
    const detail = this.liveDef(args.vault, created.id);
    if (!detail) {
      // Instantiation didn't take (a parse/instantiate failure stamps status:error on
      // the note + returns false). Surface that the note was written but isn't live.
      throw new AgentDefWriteError(
        `def note ${created.id} written to "${args.vault}" but failed to instantiate ` +
          `(check the note's status field for the error)`,
        502,
      );
    }
    return detail;
  }

  /**
   * Edit an existing live def note (body and/or metadata), then reload it so the change
   * is LIVE immediately. The note MUST be a currently-live def we instantiated in a
   * configured vault (the daemon resolves the vault; we re-guard here). Returns the
   * updated detail. Throws {@link AgentDefWriteError} on a miss or a write/reload failure.
   */
  async editDef(
    noteId: string,
    fields: { systemPrompt?: string; wants?: string; metadata?: Record<string, string> },
  ): Promise<AgentDefDetail> {
    const found = this.findLiveByNote(noteId);
    if (!found) {
      throw new AgentDefWriteError(`note ${noteId} is not a live agent definition`, 404);
    }
    const client = this.clients.get(found.vault);
    if (!client) {
      throw new AgentDefWriteError(`unknown def-vault "${found.vault}"`, 400);
    }
    const patch: { content?: string; metadata?: Record<string, string> } = {};
    if (fields.systemPrompt !== undefined) patch.content = fields.systemPrompt;
    const metadata: Record<string, string> = { ...(fields.metadata ?? {}) };
    if (fields.wants !== undefined) metadata.wants = fields.wants;
    if (Object.keys(metadata).length > 0) patch.metadata = metadata;
    if (patch.content === undefined && patch.metadata === undefined) {
      throw new AgentDefWriteError(`nothing to edit (provide systemPrompt, wants, or metadata)`, 400);
    }
    await client.patchNote(noteId, patch);
    await this.reload(found.vault, noteId, "updated");
    const detail = this.liveDef(found.vault, noteId);
    if (!detail) {
      throw new AgentDefWriteError(
        `def note ${noteId} edited but failed to re-instantiate (check the note's status field)`,
        502,
      );
    }
    return detail;
  }

  /**
   * Delete a live def note, then deregister the agent immediately. The note MUST be a
   * currently-live def we instantiated. Returns the (vault, name) of what was removed,
   * plus a `grantsReconciled` flag (FIX 5, PR #3) — `false` when the best-effort grant
   * cleanup FAILED so the caller can report a PARTIAL success rather than a clean one.
   *
   * ORDERING (FIX 4, PR #3) — the VAULT NOTE DELETE happens FIRST; only after it
   * SUCCEEDS do we deregister the live agent. So a vault-delete 502 throws here BEFORE
   * any in-memory teardown — the def stays REGISTERED (it reappears coherently on the
   * next poll), never orphaned (gone from memory but still in the vault, the confusing
   * half-state). This mirrors the `agent-vaults` removal path's "persist the durable
   * change first, then tear down in-memory state" discipline (daemon.ts #106). Throws
   * {@link AgentDefWriteError} on a miss; a vault-delete failure throws (un-torn-down).
   */
  async deleteDef(
    noteId: string,
  ): Promise<{ vault: string; name: string; grantsReconciled: boolean }> {
    const found = this.findLiveByNote(noteId);
    if (!found) {
      throw new AgentDefWriteError(`note ${noteId} is not a live agent definition`, 404);
    }
    const client = this.clients.get(found.vault);
    if (!client) {
      throw new AgentDefWriteError(`unknown def-vault "${found.vault}"`, 400);
    }
    // STEP 1 — delete the vault note FIRST (the durable change). A non-ok (non-404)
    // response throws out of here, BEFORE any deregister, so the in-memory def is left
    // intact (FIX 4): no orphan, the next poll re-converges. (404 is fine — gone is gone.)
    await client.deleteNote(noteId);
    // STEP 2 — the note is gone → tear the agent down + prune grants (the confirmed-
    // removal path). Capture the grant-reconcile outcome to surface a partial success.
    const reconcile = await this.confirmedRemoval(found.vault, noteId);
    const grantsReconciled = !("ok" in reconcile) || reconcile.ok === true;
    return { vault: found.vault, name: found.detail.name, grantsReconciled };
  }

  /**
   * Build the metadata for a created/edited def note from the API inputs. `name` +
   * `backend` are the load-bearing config; `wants` is the comma-separated connection
   * list (omitted when empty); any extra `metadata` the caller passes is merged FIRST
   * so the explicit name/backend/wants win (the route can't override the validated
   * name/backend via the metadata bag). NEVER carries a token/secret — secrets stay
   * local (the parse path never reads creds off a note).
   */
  private buildDefMetadata(args: {
    name: string;
    backend: AgentBackendKind;
    wants?: string;
    metadata?: Record<string, string>;
  }): Record<string, string> {
    const metadata: Record<string, string> = { ...(args.metadata ?? {}) };
    metadata.name = args.name;
    metadata.backend = args.backend;
    if (args.wants !== undefined && args.wants.trim().length > 0) {
      metadata.wants = args.wants;
    }
    return metadata;
  }

  /**
   * A CONFIRMED removed def (a `deleted` trigger, or a re-read 404): tear the agent
   * down AND prune ALL its grants (#96 grant-GC) so a deleted `#agent/definition` note
   * doesn't orphan live approved rows. The seen-set entry is cleared so a later loadAll
   * doesn't re-detect (and re-prune) the same removal. Reconcile is best-effort.
   *
   * Returns the grant-reconcile outcome (FIX 5, PR #3) so the API delete path can report
   * a PARTIAL success when grant cleanup failed (delete done, grants possibly orphaned).
   */
  private async confirmedRemoval(
    vault: string,
    noteId: string,
  ): Promise<{ ok: true; pruned: number } | { ok: false; error: string } | { skipped: true }> {
    // The grant holder name comes from the live record if present, else the last-known
    // name we tracked for this note (a def removed before it ever instantiated).
    const name =
      this.live.get(this.keyOf(vault, noteId))?.name ?? this.seenDefs.get(vault)?.get(noteId);
    await this.deregisterByNote(vault, noteId);
    this.seenDefs.get(vault)?.delete(noteId);
    if (!name) return { skipped: true };
    return this.reconcileForRemovedAgent(name);
  }

  /**
   * Instantiate (or re-instantiate) one def note: parse → bring up the channel →
   * persist+register the agent → stamp status. Returns true on success. A parse
   * failure stamps `error` (so the note surfaces the problem) and returns false; an
   * instantiate failure is logged + returns false (the prior registration, if any,
   * is left intact — we don't tear down a working agent on a transient failure).
   */
  private async instantiate(
    vault: string,
    note: { id: string; path?: string; content?: string; metadata?: Record<string, unknown> },
  ): Promise<boolean> {
    const binding = this.bindings.get(vault);
    const client = this.clients.get(vault);
    if (!binding || !client) return false;

    let def: ParsedAgentDef;
    try {
      def = parseAgentDef(note, { vault });
    } catch (err) {
      console.error(`agent-defs: skipping malformed def ${note.id} in "${vault}": ${(err as Error).message}`);
      // Best-effort: surface the problem on the note itself.
      await client.patchStatus(note.id, "error").catch(() => {});
      return false;
    }

    try {
      await this.deps.ensureChannel(def.name, binding);
      await this.deps.setupAndRegister(def.spec);
    } catch (err) {
      console.error(`agent-defs: instantiating "${def.name}" (${note.id} in "${vault}") failed: ${(err as Error).message}`);
      await client.patchStatus(note.id, "error").catch(() => {});
      return false;
    }

    // Resolve status. 4b: when a grants client is wired AND the def declares `wants:`
    // connections, REGISTER each as a pending grant with the hub + derive status from
    // the hub's grant statuses (`enabled` only once every connection is approved).
    // Otherwise fall back to the pure {@link resolveDefStatus} (pending if anything is
    // declared, enabled if nothing is). Either way the agent ALREADY ran its own-vault
    // setup above — an unapproved connection is absent at spawn, never a failure here.
    const { status, pending, connections } = await this.resolveStatusWithGrants(def);
    const fullPrompt = def.spec.systemPrompt ?? "";
    const systemPromptPreview =
      fullPrompt.length > SYSTEM_PROMPT_PREVIEW_LEN
        ? fullPrompt.slice(0, SYSTEM_PROMPT_PREVIEW_LEN)
        : fullPrompt;
    const key = this.keyOf(vault, note.id);
    this.live.set(key, {
      vault,
      noteId: note.id,
      name: def.name,
      status,
      backend: def.spec.backend ?? "programmatic",
      mode: def.spec.mode ?? "single-threaded",
      systemPromptPreview,
      pending: pending ?? [],
      wants: def.wants.map((c) => connectionKey(c)),
      connections,
      ...(def.spec.model ? { model: def.spec.model } : {}),
      source: "def",
    });
    // DEF WINS (Phase 4a dual-discovery): drop any stale THREAD-sourced live entry for the
    // same name (no teardown — the channel + registration are name-keyed and just replaced
    // in place by this def). Handles the reactive-ordering edge where a thread registered
    // before its def appeared; keeps the listing name-unique + def-sourced in `both` mode.
    this.evictOtherLiveByName(def.name, key);
    // Track this note in the per-vault seen set (a confident, freshly-parsed read) so the
    // removed-def diff (loadAll) and the reload-delete path both address it by name. This
    // covers the reload single-note path where loadAll's rebuild didn't run.
    this.recordSeen(vault, note.id, def.name);
    // Stamp status — best-effort: a failed stamp doesn't unmake the running agent.
    try {
      await client.patchStatus(note.id, status, pending);
    } catch (err) {
      console.warn(`agent-defs: status stamp for "${def.name}" failed (continuing): ${(err as Error).message}`);
    }
    // Grant-GC (#96): a CLEAN successful load is a confident live set, so prune any grant
    // the agent no longer declares — e.g. a `wants:` entry removed from the def. We send
    // the CURRENTLY-declared connection SPECS; the hub re-derives the keys with its own
    // connectionKey. SAFETY: only reached AFTER a successful parse + instantiate; a
    // parse/instantiate failure returns above WITHOUT reconciling, so a transient error
    // never presents a stale/empty live set that nukes approved grants.
    await this.reconcileLiveKeys(def);
    console.log(`agent-defs: instantiated "${def.name}" from def ${note.id} in "${vault}" (status=${status}, source=def).`);
    return true;
  }

  /**
   * Instantiate (or re-instantiate) one `#agent/thread` note as a live agent — the THREAD
   * discovery source (Phase 4a dual-discovery). Mirrors {@link instantiate} but for the
   * flattened model, with three differences that keep it ADDITIVE + SAFE:
   *
   *   1. DEDUP (def wins): skip when the agent name is ALREADY live under a different key
   *      (a `#agent/definition` registered it, or another thread did) — so `both` mode is
   *      byte-identical to today for every def-backed agent (the thread just dedups).
   *   2. agent_status: skip a thread whose `metadata.agent_status` is `disabled` (and tear
   *      down a previously thread-sourced-live agent that flips to disabled). DISTINCT from
   *      `metadata.status` (the turn outcome) — never read here.
   *   3. NO status stamp + NO grant registration: we never write the thread note's metadata
   *      (`status` is the turn outcome, owned by the worker) and threads carry no capability
   *      (only `#agent/role` grants — the security layer). So this is read-only on the vault.
   *
   * Returns true on a successful (re)registration. A parse failure / dedup-skip / disabled
   * thread returns false (logged, no vault write). An instantiate failure leaves any prior
   * registration intact (we don't tear down a working agent on a transient failure).
   */
  private async instantiateThread(
    vault: string,
    note: { id: string; path?: string; metadata?: Record<string, unknown> },
  ): Promise<boolean> {
    const binding = this.bindings.get(vault);
    if (!binding) return false;

    let parsed: ParsedThreadSpec;
    try {
      parsed = parseThreadSpec(note, { vault });
    } catch (err) {
      // A malformed thread note → log + skip. We do NOT stamp the note (status is the turn
      // outcome, not ours to write); the def path's status-stamp has no thread analogue.
      console.error(`agent-defs: skipping malformed thread ${note.id} in "${vault}": ${(err as Error).message}`);
      return false;
    }

    const key = this.keyOf(vault, note.id);

    // (2) agent_status: a disabled thread is not a discovery source. If it was previously
    // thread-sourced-live here, tear it down so a flip-to-disabled converges (a def-sourced
    // same-name agent keyed elsewhere is untouched — def wins).
    if (parsed.agentStatus === "disabled") {
      if (this.live.get(key)?.source === "thread") {
        console.log(`agent-defs: thread '${parsed.name}' (${note.id}) is agent_status=disabled — tearing down.`);
        await this.deregisterByNote(vault, note.id);
      }
      return false;
    }

    // (1) DEDUP — def (or another thread) already registered this name under a different key.
    if (this.isNameLiveElsewhere(parsed.name, key)) {
      console.log(
        `agent-defs: thread-discovery — '${parsed.name}' (${note.id}) deduped (already live from ` +
          `another source); NOT registered from this thread (def wins in 'both' mode).`,
      );
      return false;
    }

    try {
      await this.deps.ensureChannel(parsed.name, binding);
      await this.deps.setupAndRegister(parsed.spec);
    } catch (err) {
      console.error(
        `agent-defs: instantiating thread "${parsed.name}" (${note.id} in "${vault}") failed: ${(err as Error).message}`,
      );
      return false;
    }

    // A thread-sourced agent has no def status flow → status `enabled` (it's live), no
    // pending/connections (threads register no grants — roles are the capability layer).
    this.live.set(key, {
      vault,
      noteId: note.id,
      name: parsed.name,
      status: "enabled",
      backend: parsed.spec.backend ?? "programmatic",
      mode: parsed.spec.mode ?? "single-threaded",
      systemPromptPreview: "", // identity composes at turn time — no prompt body here.
      pending: [],
      wants: parsed.wants.map((c) => connectionKey(c)),
      connections: [],
      ...(parsed.spec.model ? { model: parsed.spec.model } : {}),
      source: "thread",
    });
    console.log(`agent-defs: instantiated "${parsed.name}" from thread ${note.id} in "${vault}" (source=thread).`);
    return true;
  }

  /** Record a note in the per-vault seen set (noteId → agent name) — a confident read. */
  private recordSeen(vault: string, noteId: string, name: string): void {
    let m = this.seenDefs.get(vault);
    if (!m) {
      m = new Map<string, string>();
      this.seenDefs.set(vault, m);
    }
    m.set(noteId, name);
  }

  /**
   * Prune the agent's grants down to its CURRENTLY-declared connections (#96 grant-GC,
   * the clean-load case). POSTs reconcile with the live connection SPECS (`def.wants`);
   * the hub re-derives each key with its own connectionKey and tears down + removes every
   * grant NOT in that set (e.g. a removed want). A def with no `wants:` sends an empty
   * set, which prunes any leftover grant from a prior `wants:` it no longer declares.
   * Best-effort: no grants client → no-op; a reconcile failure logs a warning and never
   * throws out of the load path.
   */
  private async reconcileLiveKeys(def: ParsedAgentDef): Promise<void> {
    if (!this.grants) return;
    // Pass the live connection SPECS (def.wants) — the hub derives the keys with
    // its own connectionKey. (Sending keys we computed via grants.ts connectionKey
    // would diverge from the hub's for service/tagged/mcp grants → wrong prunes.)
    try {
      const { pruned } = await this.grants.reconcileGrants(def.name, def.wants);
      if (pruned > 0) {
        console.log(`agent-defs: pruned ${pruned} stale grant(s) for "${def.name}".`);
      }
    } catch (err) {
      console.warn(
        `agent-defs: reconciling grants for "${def.name}" failed (continuing): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Resolve a def's status, registering its `wants:` connections as PENDING grants
   * when a grants client is wired (4b). For each declared connection: `PUT
   * /admin/grants {agent, connection}` (idempotent upsert), collect the returned
   * status, then derive `enabled` (every connection approved) vs `pending` (listing
   * the unapproved connection keys). Legacy `uses:` names are appended to `pending`
   * (they have no grants flow — informational only).
   *
   * Best-effort + non-fatal: NO grants client, NO `wants:`, or a registration failure
   * all fall back to {@link resolveDefStatus} (a connection that couldn't register
   * counts as unapproved → the def is `pending`, not `error` — the agent still runs
   * own-vault, the operator can retry the hub). A single connection's PUT failing is
   * logged + that connection counts as unapproved; the others still register.
   */
  private async resolveStatusWithGrants(
    def: ParsedAgentDef,
  ): Promise<{ status: AgentDefStatus; pending?: string[]; connections: ConnectionInfo[] }> {
    if (!this.grants || def.wants.length === 0) {
      // No hub wiring / no structured connections → the pure fallback. The connections
      // list is still surfaced (status `pending`, NO grant id) so the ops panel can
      // list the agent's declared `mcp:` connections + show the degraded hint when
      // there's nothing to Connect against (no grant could be resolved here).
      const fallback = resolveDefStatus(def);
      const connections: ConnectionInfo[] = def.wants.map((c) => ({
        key: connectionKey(c),
        kind: c.kind,
        target: c.target,
        status: "pending",
      }));
      return { ...fallback, connections };
    }
    const grants = this.grants;
    const statusByKey = new Map<string, string>();
    // Per-connection grant info (id + status) for the ops panel — keyed by connectionKey
    // so it lines up with the def's wants. The grant id comes FROM the hub (registerGrant
    // is an idempotent upsert that echoes the existing grant's id + current status); we
    // never derive it client-side (the hub's id-slug impl must not be duplicated).
    const infoByKey = new Map<string, ConnectionInfo>();
    for (const conn of def.wants) {
      const key = connectionKey(conn);
      try {
        const rec = await grants.registerGrant(def.name, conn);
        statusByKey.set(key, rec.status);
        infoByKey.set(key, {
          key,
          kind: conn.kind,
          target: conn.target,
          status: rec.status,
          ...(rec.id ? { grantId: rec.id } : {}),
        });
      } catch (err) {
        // A failed registration → the connection counts as unapproved (absent from
        // statusByKey). Never fatal — the agent runs own-vault; the operator retries.
        // Surface it with status `pending` + no grant id (the panel shows it un-Connectable).
        infoByKey.set(key, { key, kind: conn.kind, target: conn.target, status: "pending" });
        console.warn(
          `agent-defs: registering grant for "${def.name}" (${key}) failed ` +
            `(treating as pending): ${(err as Error).message}`,
        );
      }
    }
    const connections = def.wants.map(
      (c) =>
        infoByKey.get(connectionKey(c)) ?? {
          key: connectionKey(c),
          kind: c.kind,
          target: c.target,
          status: "pending",
        },
    );
    const resolved = resolveConnectionStatus(def.wants, statusByKey);
    // Surface legacy `uses:` names alongside the structured pending keys (no grant flow).
    const pending = [...(resolved.pending ?? []), ...def.declaredConnections];
    if (resolved.status === "enabled" && pending.length === 0) {
      return { status: "enabled", connections };
    }
    return { status: "pending", pending, connections };
  }

  /** Tear down the agent for a given (vault, noteId): deregister + drop its channel. */
  private async deregisterByNote(vault: string, noteId: string): Promise<void> {
    const key = this.keyOf(vault, noteId);
    const rec = this.live.get(key);
    if (!rec) return; // never instantiated (a delete for a note we don't track) — no-op.
    this.live.delete(key);
    try {
      await this.deps.deregister(rec.name);
    } catch (err) {
      console.error(`agent-defs: deregistering "${rec.name}" failed (continuing): ${(err as Error).message}`);
    }
    try {
      await this.deps.removeChannel(rec.name);
    } catch (err) {
      console.error(`agent-defs: removing channel "${rec.name}" failed (continuing): ${(err as Error).message}`);
    }
    console.log(`agent-defs: deregistered "${rec.name}" (${noteId} in "${vault}").`);
  }

  /** Tear down every agent from a def-vault (e.g. the vault binding is removed). */
  async deregisterAllForVault(vault: string): Promise<void> {
    // Drop the seen-defs entry for this vault FIRST (reviewer nit): otherwise the
    // next confident loadAll would diff the now-unbound vault's stale entries as
    // "removed" and issue spurious reconcile(agent, []) prunes — but the binding
    // was dropped, the defs weren't deleted, so their grants must NOT be GC'd.
    this.seenDefs.delete(vault);
    for (const rec of [...this.live.values()]) {
      if (rec.vault === vault) await this.deregisterByNote(vault, rec.noteId);
    }
  }
}
