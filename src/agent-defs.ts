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
  type SystemPromptMode,
  type AgentMount,
} from "./sandbox/types.ts";
import { AGENT_DEFINITION_TAG } from "./transports/vault.ts";

const DEFAULT_DEF_VAULT_URL = "http://127.0.0.1:1940";

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
   * (the `uses:` field). PARSED + surfaced in 4a; granting is 4b. Empty = own-vault
   * only → `enabled`.
   */
  declaredConnections: string[];
}

/** A failed parse — the note isn't a well-formed agent def. */
export class AgentDefParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDefParseError";
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
 * Parse one `#agent/definition` note into a {@link ParsedAgentDef}. PURE — no I/O.
 *
 * Mapping (the design's "note shape"):
 *   - note BODY (`content`)  → `spec.systemPrompt` (the agent's role, in prose).
 *   - `metadata.name`        → `spec.name` (REQUIRED, slug) = the wake channel.
 *   - `metadata.backend`     → `spec.backend` (default `programmatic`).
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
  content?: string;
  metadata?: Record<string, unknown>;
}, binding: { vault: string }): ParsedAgentDef {
  const noteId = typeof note.id === "string" ? note.id : "";
  if (!noteId) {
    throw new AgentDefParseError("#agent/definition note has no id");
  }
  const meta = note.metadata ?? {};

  const name = metaStr(meta.name);
  if (!name) {
    throw new AgentDefParseError(`#agent/definition note ${noteId} has no metadata.name`);
  }
  if (!NAME_SLUG_RE.test(name)) {
    throw new AgentDefParseError(
      `#agent/definition note ${noteId}: name "${name}" must be a slug (alphanumeric, dash, underscore)`,
    );
  }

  // Backend — default programmatic (the reliable primary path; interactive is the
  // gated opt-in, selectable but not the default for a vault def). 4a: the
  // vault-native instantiate path is programmatic-only — `interactive` is NOT yet
  // wired for vault defs (it forces a tmux spawn the def path doesn't drive). So we
  // REJECT it here with a clear message (→ status:error on the note) rather than
  // silently demoting to programmatic. Supporting interactive for vault defs is a
  // later increment.
  let backend: AgentBackendKind = "programmatic";
  const rawBackend = metaStr(meta.backend);
  if (rawBackend !== undefined) {
    if (rawBackend === "interactive") {
      throw new AgentDefParseError(
        `#agent/definition note ${noteId}: the "interactive" backend is not yet supported for ` +
          `vault-native defs — use "programmatic" (the default).`,
      );
    }
    if (rawBackend !== "programmatic") {
      throw new AgentDefParseError(
        `#agent/definition note ${noteId}: backend must be "programmatic"`,
      );
    }
    backend = rawBackend;
  }

  const spec: AgentSpec = {
    name,
    channels: [name], // wake channel = the agent name (agent ≡ channel)
    backend,
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

  // Working directory (optional absolute host cwd). We do NOT statSync here (parse is
  // pure + may run on a box where the dir is mounted differently); the spawn path's
  // own checks apply when the turn runs.
  const workspace = metaStr(meta.workspace);
  if (workspace !== undefined) {
    if (!workspace.startsWith("/")) {
      throw new AgentDefParseError(
        `#agent/definition note ${noteId}: workspace must be an absolute path (start with "/")`,
      );
    }
    spec.workspace = workspace;
  }

  // Filesystem read scope.
  const filesystem = metaStr(meta.filesystem);
  if (filesystem !== undefined) {
    if (filesystem !== "workspace" && filesystem !== "full") {
      throw new AgentDefParseError(
        `#agent/definition note ${noteId}: filesystem must be "workspace" or "full"`,
      );
    }
    spec.filesystem = filesystem;
  }

  // Network egress mode + (under restricted) the additional host allowlist.
  const network = metaStr(meta.network);
  if (network !== undefined) {
    if (network !== "open" && network !== "restricted") {
      throw new AgentDefParseError(
        `#agent/definition note ${noteId}: network must be "open" or "restricted"`,
      );
    }
    spec.network = network;
  }
  const egress = metaList(meta.egress);
  if (egress.length > 0) spec.egress = egress;

  // Filesystem mounts — JSON-encoded array in metadata (the note can't carry a
  // structured array natively in a string vault), parsed defensively. Optional; a
  // malformed value is ignored (not fatal — mounts are an advanced knob).
  const mounts = parseMounts(meta.mounts);
  if (mounts.length > 0) spec.mounts = mounts;

  // Declared connections beyond the def-vault (the `uses:` field). PARSED + surfaced;
  // granting is 4b. Never a secret — these are NAMES (`github`, `vault:research:read`).
  const declaredConnections = metaList(meta.uses);

  return { noteId, name, spec, declaredConnections };
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

/**
 * Resolve the status a parsed def gets in 4a. Own-vault only → `enabled`; a def that
 * declares external connections → `pending` (listing them) since 4b hasn't granted
 * them. The agent still runs own-vault either way; this is the queryable signal.
 */
export function resolveDefStatus(def: ParsedAgentDef): {
  status: AgentDefStatus;
  pending?: string[];
} {
  if (def.declaredConnections.length > 0) {
    return { status: "pending", pending: def.declaredConnections };
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
    Array<{ id: string; content?: string; metadata?: Record<string, unknown> }>
  > {
    const limit = opts?.limit ?? 500;
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
    type RawNote = { id?: string; content?: string; metadata?: Record<string, unknown> };
    const notes: RawNote[] = Array.isArray(parsed)
      ? (parsed as RawNote[])
      : ((parsed as { notes?: RawNote[] })?.notes ?? []);
    const out: Array<{ id: string; content?: string; metadata?: Record<string, unknown> }> = [];
    for (const n of notes) {
      if (typeof n.id === "string" && n.id) {
        out.push({ id: n.id, content: n.content, metadata: n.metadata });
      }
    }
    return out;
  }

  /** Fetch ONE note by id (for a created/updated reload). Null on 404/miss. */
  async getNote(
    id: string,
  ): Promise<{ id: string; content?: string; metadata?: Record<string, unknown> } | null> {
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
    const n = (parsed ?? {}) as { id?: string; note?: { id?: string; content?: string; metadata?: Record<string, unknown> }; content?: string; metadata?: Record<string, unknown> };
    const note = n.note ?? n;
    if (typeof note.id !== "string" || !note.id) return null;
    return { id: note.id, content: note.content, metadata: note.metadata };
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
      body: JSON.stringify({ metadata }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`def-vault "${this.vault}": patch status ${noteId} failed (${res.status}) ${detail}`.trim());
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
  private readonly deps: InstantiateDeps;

  constructor(deps: InstantiateDeps, opts?: { bindings?: DefVaultBinding[]; fetchFn?: typeof fetch }) {
    this.deps = deps;
    for (const b of opts?.bindings ?? []) {
      this.addVault(b, opts?.fetchFn);
    }
  }

  /** Register a def-vault binding (additive — multi-vault is appending). */
  addVault(binding: DefVaultBinding, fetchFn?: typeof fetch): void {
    this.clients.set(binding.vault, new DefVaultClient(binding, fetchFn));
    this.bindings.set(binding.vault, binding);
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
  list(): ReadonlyArray<{ vault: string; noteId: string; name: string; status: AgentDefStatus }> {
    return [...this.live.values()].map((d) => ({ ...d }));
  }

  private keyOf(vault: string, noteId: string): string {
    return `${vault}\u0000${noteId}`;
  }

  /**
   * Read all defs from every bound def-vault + instantiate each. Best-effort per
   * vault AND per note: a single vault's list failure (or one note's parse/instantiate
   * failure) is logged and never aborts the others, so one bad def can't sink the set.
   * Returns the count successfully instantiated.
   */
  async loadAll(): Promise<number> {
    let count = 0;
    for (const [vault, client] of this.clients) {
      let notes: Awaited<ReturnType<DefVaultClient["listDefNotes"]>>;
      try {
        notes = await client.listDefNotes();
      } catch (err) {
        console.error(`agent-defs: listing defs from vault "${vault}" failed (continuing): ${(err as Error).message}`);
        continue;
      }
      for (const note of notes) {
        if (await this.instantiate(vault, note)) count++;
      }
    }
    return count;
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
    const client = this.clients.get(vault);
    if (!client) {
      console.warn(`agent-defs: reload for unknown def-vault "${vault}" — ignoring.`);
      return "skipped";
    }
    // A delete event: the note is gone — tear down without a fetch (the GET would 404
    // anyway; skipping it is faster + avoids a confusing 404 log).
    if (event === "deleted") {
      await this.deregisterByNote(vault, noteId);
      return "deregistered";
    }
    let note: Awaited<ReturnType<DefVaultClient["getNote"]>>;
    try {
      note = await client.getNote(noteId);
    } catch (err) {
      console.error(`agent-defs: reload fetch of ${noteId} from "${vault}" failed: ${(err as Error).message}`);
      return "skipped";
    }
    if (!note) {
      // Re-read says it's gone (deleted, or no longer carries the def tag we can see).
      await this.deregisterByNote(vault, noteId);
      return "deregistered";
    }
    return (await this.instantiate(vault, note)) ? "instantiated" : "skipped";
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
    note: { id: string; content?: string; metadata?: Record<string, unknown> },
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

    const { status, pending } = resolveDefStatus(def);
    this.live.set(this.keyOf(vault, note.id), { vault, noteId: note.id, name: def.name, status });
    // Stamp status — best-effort: a failed stamp doesn't unmake the running agent.
    try {
      await client.patchStatus(note.id, status, pending);
    } catch (err) {
      console.warn(`agent-defs: status stamp for "${def.name}" failed (continuing): ${(err as Error).message}`);
    }
    console.log(`agent-defs: instantiated "${def.name}" from ${note.id} in "${vault}" (status=${status}).`);
    return true;
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
    for (const rec of [...this.live.values()]) {
      if (rec.vault === vault) await this.deregisterByNote(vault, rec.noteId);
    }
  }
}
