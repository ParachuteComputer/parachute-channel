/**
 * Agent connectors — approval-gated cross-resource GRANTS (design
 * 2026-06-17-agent-connectors-4b.md, slice 4b-1).
 *
 * 4a gave an agent its OWN def-vault. 4b lets a `#agent/definition` note DECLARE
 * what it wants to reach BEYOND that — other local vaults, external services
 * (GitHub, Cloudflare), and (parsed-but-deferred to 4b-2) remote MCP/OAuth servers.
 * Every extra reach is OPERATOR-APPROVED in the hub; every secret stays in the hub's
 * grant store; the agent module is the CONSUMER that fetches approved material at
 * spawn + injects it into the ephemeral per-spawn `.mcp.json` + env.
 *
 * THE ONE INVARIANT (design §"The one invariant"): a vault note can only REQUEST, it
 * can never GRANT. This module:
 *   - parses the note's `wants:` into structured {@link ConnectionSpec}s ({@link parseWants});
 *   - REGISTERS each as a PENDING grant with the hub (`PUT /admin/grants`) — that is
 *     the request, not a grant; worst case it sits `pending`;
 *   - at spawn, fetches only APPROVED grants' MATERIAL (`GET …/material`) and injects
 *     it. Unapproved/pending/error connections are simply ABSENT — never a failure.
 *
 * THE WIRE CONTRACT (parachute-hub PR #668 + #96 — consume, do not redesign):
 *   - PUT  <hub>/admin/grants          { agent, connection } → { id, agent, connection, status, reason? }
 *   - GET  <hub>/admin/grants?agent=<> → { grants: [{ id, agent, connection, status, reason?, approvedAt? }] }
 *   - GET  <hub>/admin/grants/<id>/material → APPROVED only:
 *         vault   → { kind:"vault",   token, mcpUrl }
 *         service → { kind:"service", token, inject }
 *         (404 unknown id / 409 not-approved)
 *   - POST <hub>/admin/grants/reconcile { agent, liveConnections } → { pruned, prunedIds } (#96
 *         grant-GC): the hub re-derives each key with ITS connectionKey and tears down +
 *         REMOVEs every grant for `agent` whose key is NOT among the live specs (empty
 *         liveConnections = the def is gone → prune ALL). Stops a removed
 *         want / a deleted def from orphaning a live approved grant. Pruning only ever
 *         REMOVES access, so it shares the host-admin Bearer (never an operator cookie).
 *   - Auth: all of these need a `parachute:host:admin` Bearer — we REUSE the module's
 *     existing host-admin-capable MANAGER BEARER (the operator token it mints vault
 *     tokens with; see mint-token.ts / spawn-deps.ts). NO new auth path.
 *   - approve/revoke are operator-only via the hub UI — the module NEVER calls those.
 *
 * SECURITY: grant material is SECRET (tokens). It only ever lands in the ephemeral,
 * 0600 per-spawn `.mcp.json` + the child env — NEVER in a vault note. Material is
 * fetched FRESH each spawn (design: revocation takes effect on the next spawn), so we
 * deliberately do NOT cache it.
 */

import { DENYLISTED_ENV } from "./credentials.ts";

// ---------------------------------------------------------------------------
// Connection spec — the structured form of one `wants:` entry
// ---------------------------------------------------------------------------

/**
 * A declared connection beyond the def-vault. Matches the hub's `connection` spec
 * shape exactly (design §"The hub grants API", connection spec):
 *   `{ kind, target, access?, tags?, inject? }`
 * — `access`/`tags` are vault-only; `inject` is service-only (`("env"|"mcp")[]`).
 */
export interface ConnectionSpec {
  /** Resource kind. `vault`/`service`/`surface` are wired; `mcp` is parsed-but-deferred. */
  kind: "vault" | "service" | "surface" | "mcp";
  /**
   * The resource target — a vault name (`research`), a service name (`github`),
   * a surface name (`gitcoin-brain`), or, for `kind:"mcp"`, the remote MCP https URL.
   */
  target: string;
  /** Access verb. Vault + surface (`surface:<name>:<verb>` — write ⊇ read at the git endpoint). */
  access?: "read" | "write";
  /** Vault tag-scope (one or more `#tag`). Vault-only. */
  tags?: string[];
  /** Injection shape(s) for a service credential. Service-only. */
  inject?: ("env" | "mcp")[];
}

/** A malformed `wants:` entry — the whole def is an error (no half-instantiate). */
export class WantsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WantsParseError";
  }
}

/**
 * A STABLE, canonical key for a connection — the (agent, connection) grant key the
 * status `pending:[…]` list reports + the hub upserts on. Derived purely from the
 * spec so a re-parse of the same `wants:` yields the same key (idempotent upsert).
 *
 *   vault   → `vault:<target>:<access>[#tag…]`   (tags sorted for stability)
 *   service → `<inject-joined>:<target>`          e.g. `env+mcp:github`
 *   surface → `surface:<target>:<access>`
 *   mcp     → `mcp:<url>`
 *
 * NOTE: this key is used ONLY for the agent's OWN status resolution
 * ({@link resolveConnectionStatus}) — where BOTH sides (the declared spec + the
 * hub's echoed-back `connection`) run through THIS function, so it's internally
 * consistent. It is DELIBERATELY NOT sent to the hub for reconcile: the agent
 * sends SPECS and the hub re-derives keys with its own `connectionKey` (the
 * cross-repo divergence lesson — agent#96/hub#674).
 */
export function connectionKey(c: ConnectionSpec): string {
  if (c.kind === "vault") {
    const tags = c.tags && c.tags.length > 0 ? [...c.tags].sort().join("") : "";
    return `vault:${c.target}:${c.access ?? "read"}${tags}`;
  }
  if (c.kind === "service") {
    const inject = (c.inject && c.inject.length > 0 ? [...c.inject].sort() : ["env"]).join("+");
    return `${inject}:${c.target}`;
  }
  if (c.kind === "surface") {
    return `surface:${c.target}:${c.access ?? "read"}`;
  }
  return `mcp:${c.target}`;
}

/** A vault name slug — the `<name>` segment in `vault:<name>:<verb>`. */
const VAULT_NAME_SLUG = /^[a-zA-Z0-9_-]+$/;
/** A service name slug — `github`, `cloudflare`, … */
const SERVICE_NAME_SLUG = /^[a-zA-Z0-9_-]+$/;
/**
 * A surface name slug — the `<name>` segment in `surface:<name>:<verb>`. MATCHES
 * the hub's `SURFACE_NAME_RE` (git-registry.ts) so a name this parser accepts is
 * one the hub's PUT/registry + git-transport URL parser also accept (no slashes
 * or dots → no path traversal in the git endpoint). Bounded length.
 */
const SURFACE_NAME_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Parse the `wants:` metadata field — a comma-separated list of connection specs —
 * into structured {@link ConnectionSpec}s. PURE, no I/O.
 *
 * Spec forms (design §"The connection declaration"):
 *   - `vault:<name>:<read|write>` with optional `#tag` suffix(es):
 *       `vault:research:read`              → {kind:"vault", target:"research", access:"read"}
 *       `vault:research:read#published#wip`→ {…, tags:["#published","#wip"]}
 *     (the agent's OWN def-vault is implicit — never in `wants:`; the def-vault binding
 *      drives `spec.vault`, not this.)
 *   - `env:<service>`  → {kind:"service", target:"<service>", inject:["env"]}
 *     `mcp:<service>`  → {kind:"service", target:"<service>", inject:["mcp"]}
 *     BOTH for the same service MERGE → inject:["env","mcp"].
 *   - `mcp:<https-url>`→ {kind:"mcp", target:"<url>"}  (parsed; deferred to 4b-2).
 *
 * Disambiguation of `mcp:<x>`: an `<x>` that starts with `http://` or `https://` is
 * a remote MCP (`kind:"mcp"`); otherwise it's a service MCP-injection (`mcp:github`).
 *
 * Accepts a real array OR the comma/space-joined string the vault stringifies arrays
 * into. A MALFORMED entry throws {@link WantsParseError} — the caller stamps the def
 * `status:error` rather than half-instantiating (design §1 "a malformed `wants:` →
 * the def is an error").
 */
export function parseWants(raw: unknown): ConnectionSpec[] {
  const entries = toEntries(raw);
  if (entries.length === 0) return [];

  // Service connections accumulate by target so `env:github` + `mcp:github` merge to
  // one connection with inject:["env","mcp"] (design §1). Keyed by service target.
  const services = new Map<string, Set<"env" | "mcp">>();
  // Insertion order of services (Map preserves it, but we re-emit at the end so the
  // overall ordering = first-seen across all kinds).
  const out: ConnectionSpec[] = [];
  // Placeholder index per service so the merged service lands at its first position.
  const servicePos = new Map<string, number>();

  for (const entry of entries) {
    const spec = parseOneWant(entry);
    if (spec.kind === "service") {
      const modes = services.get(spec.target);
      if (modes) {
        for (const m of spec.inject ?? []) modes.add(m);
        continue; // already placeheld at first position
      }
      const set = new Set<"env" | "mcp">(spec.inject ?? []);
      services.set(spec.target, set);
      servicePos.set(spec.target, out.length);
      out.push(spec); // placeholder; finalized below with the merged inject
      continue;
    }
    out.push(spec);
  }

  // Finalize each service connection's merged inject (stable order: env before mcp).
  for (const [target, modes] of services) {
    const pos = servicePos.get(target)!;
    const inject = (["env", "mcp"] as const).filter((m) => modes.has(m));
    out[pos] = { kind: "service", target, inject };
  }

  return out;
}

/** Coerce a `wants:` metadata value (array or comma/space string) → clean entries. */
function toEntries(raw: unknown): string[] {
  let parts: string[] = [];
  if (Array.isArray(raw)) {
    parts = raw.map((x) => (typeof x === "string" ? x : String(x)));
  } else if (typeof raw === "string") {
    parts = raw.split(/[,\s]+/);
  } else if (raw === undefined || raw === null) {
    return [];
  } else {
    parts = [String(raw)];
  }
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Parse ONE `wants:` entry string. Throws {@link WantsParseError} on a malformed one. */
function parseOneWant(entry: string): ConnectionSpec {
  const colon = entry.indexOf(":");
  if (colon < 0) {
    throw new WantsParseError(
      `wants: "${entry}" is malformed — expected "<kind>:<target>…" ` +
        `(e.g. "vault:research:read", "env:github", "mcp:https://…").`,
    );
  }
  const prefix = entry.slice(0, colon);
  const rest = entry.slice(colon + 1);

  switch (prefix) {
    case "vault":
      return parseVaultWant(entry, rest);
    case "surface":
      return parseSurfaceWant(entry, rest);
    case "env":
      return parseServiceWant(entry, rest, "env");
    case "mcp":
      // `mcp:` is overloaded: a remote-MCP URL (kind:"mcp", 4b-2) vs a service MCP
      // injection (kind:"service", inject:["mcp"], 4b-1). An http(s) target is the URL form.
      if (/^https?:\/\//i.test(rest)) return parseMcpUrlWant(entry, rest);
      return parseServiceWant(entry, rest, "mcp");
    default:
      throw new WantsParseError(
        `wants: "${entry}" has unknown kind "${prefix}" — expected one of ` +
          `vault | surface | env | mcp.`,
      );
  }
}

/** Parse `vault:<name>:<read|write>[#tag…]`. */
function parseVaultWant(entry: string, rest: string): ConnectionSpec {
  // rest = "<name>:<verb>[#tag…]". Split on the FIRST colon (name has no colon).
  const colon = rest.indexOf(":");
  if (colon < 0) {
    throw new WantsParseError(
      `wants: "${entry}" is malformed — a vault connection needs a verb: ` +
        `"vault:<name>:<read|write>".`,
    );
  }
  const name = rest.slice(0, colon);
  let verbAndTags = rest.slice(colon + 1);
  if (!VAULT_NAME_SLUG.test(name)) {
    throw new WantsParseError(
      `wants: "${entry}" — vault name "${name}" must be a slug (alphanumeric, dash, underscore).`,
    );
  }
  // Tag suffix: everything from the first `#` onward, split into individual `#tag`s.
  let tags: string[] | undefined;
  const hash = verbAndTags.indexOf("#");
  if (hash >= 0) {
    const tagStr = verbAndTags.slice(hash);
    verbAndTags = verbAndTags.slice(0, hash);
    tags = tagStr
      .split("#")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .map((t) => `#${t}`);
    if (tags.length === 0) tags = undefined;
  }
  const verb = verbAndTags.trim();
  if (verb !== "read" && verb !== "write") {
    throw new WantsParseError(
      `wants: "${entry}" — vault access must be "read" or "write" (got "${verb}").`,
    );
  }
  return { kind: "vault", target: name, access: verb, ...(tags ? { tags } : {}) };
}

/**
 * Parse `surface:<name>:<read|write>` — a grant to a surface's hub-hosted git repo
 * (Phase 2 §6a). Mirrors {@link parseVaultWant}'s `<name>:<verb>` split, minus the
 * tag suffix (surfaces have no tag-scope). The verb is REQUIRED + explicit (like
 * vault): `write` = clone+push, `read` = clone only. write ⊇ read at the git
 * endpoint, so a `write` grant needs no separate read grant to clone.
 *
 * The name is NORMALIZED to lowercase (the canonical form): the hub lowercases it too
 * (admin-agent-grants.ts parseConnectionSpec) so both repos' keys agree, and the hub's
 * `grantId` slug + minted `surface:<name>:<verb>` scope + `/git/<name>` remote are all
 * lowercase — surfaces are lowercase-kebab by convention (surface-host registers them
 * lowercase). Validated case-permissively (SURFACE_NAME_SLUG), then lowercased.
 */
function parseSurfaceWant(entry: string, rest: string): ConnectionSpec {
  const colon = rest.indexOf(":");
  if (colon < 0) {
    throw new WantsParseError(
      `wants: "${entry}" is malformed — a surface connection needs a verb: ` +
        `"surface:<name>:<read|write>".`,
    );
  }
  const name = rest.slice(0, colon);
  const verb = rest.slice(colon + 1).trim();
  if (!SURFACE_NAME_SLUG.test(name)) {
    throw new WantsParseError(
      `wants: "${entry}" — surface name "${name}" must be a slug ` +
        `(alphanumeric, dash, underscore; no slashes or dots).`,
    );
  }
  if (verb !== "read" && verb !== "write") {
    throw new WantsParseError(
      `wants: "${entry}" — surface access must be "read" or "write" (got "${verb}").`,
    );
  }
  return { kind: "surface", target: name.toLowerCase(), access: verb };
}

/** Parse `env:<service>` / `mcp:<service>` into one service connection. */
function parseServiceWant(entry: string, service: string, mode: "env" | "mcp"): ConnectionSpec {
  const target = service.trim();
  if (!SERVICE_NAME_SLUG.test(target)) {
    throw new WantsParseError(
      `wants: "${entry}" — service name "${target}" must be a slug (alphanumeric, dash, underscore).`,
    );
  }
  // Reject a service whose env-var would collide with the Claude-auth denylist
  // (e.g. a service named `claude-code-oauth` → CLAUDE_CODE_OAUTH_TOKEN). The
  // spawn-time denylist already drops it (security intact), but surface it HERE at
  // define-time so the operator sees the problem rather than a silent spawn-warn.
  if (DENYLISTED_ENV.has(serviceEnvVar(target))) {
    throw new WantsParseError(
      `wants: "${entry}" — service "${target}" maps to the protected env var ${serviceEnvVar(target)}, ` +
        `which a grant can never set (it's the session's managed Claude auth).`,
    );
  }
  return { kind: "service", target, inject: [mode] };
}

/** Parse `mcp:<https-url>` — a remote MCP (parsed; deferred to 4b-2). */
function parseMcpUrlWant(entry: string, url: string): ConnectionSpec {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WantsParseError(`wants: "${entry}" — "${url}" is not a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WantsParseError(`wants: "${entry}" — remote MCP URL must be http(s) (got "${parsed.protocol}").`);
  }
  return { kind: "mcp", target: url };
}

// ---------------------------------------------------------------------------
// The hub grants-API client (consume parachute-hub #668)
// ---------------------------------------------------------------------------

/** A grant record as the hub returns it (PUT result / GET list element). No secrets. */
export interface GrantRecord {
  /** The hub-assigned grant id (used to fetch material). */
  id: string;
  /** The agent name the grant belongs to. */
  agent: string;
  /** The connection spec (echoed back). */
  connection: ConnectionSpec;
  /** Lifecycle: `pending` (registered, not approved), `approved`, `revoked`, `error`. */
  status: string;
  /** Optional human reason (e.g. why it errored). */
  reason?: string;
  /** ISO timestamp the operator approved it (approved grants). */
  approvedAt?: string;
}

/**
 * Approved-grant material — APPROVED only. A discriminated union by `kind`.
 *   - `vault`   → a Bearer + the granted vault's MCP URL (inject as an MCP server).
 *   - `service` → a Bearer + the inject shape(s) (env var and/or service MCP server).
 *   - `mcp`     → a remote-MCP grant (4b-2): a Bearer + the remote MCP URL. The wire
 *       shape is byte-identical to `vault` (`{ token, mcpUrl }`) — the hub auto-refreshes
 *       OAuth tokens behind `/material` and projects only `{ kind, token, mcpUrl }`, so
 *       the consumer injects it the SAME way as a granted vault.
 */
export type GrantMaterial =
  | { kind: "vault"; token: string; mcpUrl: string }
  | { kind: "service"; token: string; inject: ("env" | "mcp")[] }
  | { kind: "surface"; token: string; remoteUrl: string }
  | { kind: "mcp"; token: string; mcpUrl: string };

/** A failed grants-API call — carries the HTTP status for the caller to branch on. */
export class GrantsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GrantsApiError";
  }
}

export interface GrantsClientDeps {
  /** Hub public origin (the grants API lives on the hub, not the vault). */
  hubOrigin: string;
  /**
   * The module's host-admin-capable MANAGER BEARER — the SAME operator token it
   * mints vault tokens with (mint-token.ts). All three grants endpoints require a
   * `parachute:host:admin` Bearer; we reuse this credential, no new auth path.
   */
  managerBearer: string;
  /** Inject fetch for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

/**
 * Thin client for the hub's grants API (parachute-hub #668 + #96). The calls the module
 * makes — register (PUT), list (GET), fetch-material (GET …/material), and reconcile
 * (POST …/reconcile, the grant-GC of #96). It NEVER approves/revokes (operator-only via
 * the hub UI). All requests carry the manager bearer (`parachute:host:admin`).
 */
export class GrantsClient {
  private readonly base: string;
  private readonly managerBearer: string;
  private readonly fetchFn: typeof fetch;

  constructor(deps: GrantsClientDeps) {
    if (!deps.hubOrigin) throw new Error("GrantsClient: hubOrigin is required");
    if (!deps.managerBearer) throw new Error("GrantsClient: managerBearer is required");
    this.base = stripTrailingSlash(deps.hubOrigin);
    this.managerBearer = deps.managerBearer;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.managerBearer}`, ...(extra ?? {}) };
  }

  /**
   * Register (idempotent upsert) a PENDING grant request for `(agent, connection)`.
   * `PUT /admin/grants { agent, connection }` → the grant record (status, usually
   * `pending` on first register; an already-approved grant returns its current
   * status). Throws {@link GrantsApiError} on a non-ok response.
   */
  async registerGrant(agent: string, connection: ConnectionSpec): Promise<GrantRecord> {
    const url = `${this.base}/admin/grants`;
    const res = await this.fetchFn(url, {
      method: "PUT",
      headers: this.authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ agent, connection }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new GrantsApiError(`register grant failed (${res.status}) ${detail}`.trim(), res.status);
    }
    return (await res.json()) as GrantRecord;
  }

  /**
   * List the grants for an agent — `GET /admin/grants?agent=<name>` → `{ grants }`.
   * No secrets (status only). Throws on a non-ok response.
   */
  async listGrants(agent: string): Promise<GrantRecord[]> {
    const url = `${this.base}/admin/grants?agent=${encodeURIComponent(agent)}`;
    const res = await this.fetchFn(url, { headers: this.authHeaders() });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new GrantsApiError(`list grants failed (${res.status}) ${detail}`.trim(), res.status);
    }
    const parsed = (await res.json()) as { grants?: GrantRecord[] };
    return Array.isArray(parsed.grants) ? parsed.grants : [];
  }

  /**
   * Fetch a grant's MATERIAL — `GET /admin/grants/<id>/material`. APPROVED only:
   * the hub 404s an unknown id and 409s a not-yet-approved grant — both return null
   * (the connection is simply absent this spawn, never a failure). Any OTHER non-ok
   * throws {@link GrantsApiError} (a real fault the caller should log). The result
   * is SECRET (a token) — fetched fresh each spawn, never cached.
   */
  async getMaterial(id: string): Promise<GrantMaterial | null> {
    const url = `${this.base}/admin/grants/${encodeURIComponent(id)}/material`;
    const res = await this.fetchFn(url, { headers: this.authHeaders() });
    if (res.status === 404 || res.status === 409) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new GrantsApiError(`get grant material failed (${res.status}) ${detail}`.trim(), res.status);
    }
    return (await res.json()) as GrantMaterial;
  }

  /**
   * GARBAGE-COLLECT an agent's now-stale grants (parachute-hub #96). `POST
   * /admin/grants/reconcile { agent, liveConnections }` → `{ pruned, prunedIds }`. The
   * hub re-derives each key with ITS OWN connectionKey and tears down + REMOVES every
   * grant for `agent` whose key is NOT among the live specs (an empty array prunes ALL
   * of the agent's grants — the def is gone). This is how a removed connection (or a
   * deleted `#agent/definition` note) stops orphaning a live `approved` grant row.
   *
   * `liveConnections` is the agent's CURRENTLY-declared connection SPECS (`def.wants`).
   * We send SPECS, not keys, so there's no dependency on this module's connectionKey
   * matching the hub's — the hub keys them the same way it stored them.
   *
   * SAFETY: only ever call this from a CONFIDENT live set — a clean successful def load
   * (real `liveConnections`) or a confirmed removal (empty array). NEVER from a parse/load
   * failure: a transient error must not present an empty/partial set that nukes
   * approved grants. Pruning only ever REMOVES access (never escalates), so the host-admin
   * Bearer is the right auth (mirrors PUT/GET /admin/grants) — the same one the module
   * uses for register/list/material. Throws {@link GrantsApiError} on a non-ok response;
   * the caller logs + continues (best-effort — a GC fault must never crash a load).
   */
  async reconcileGrants(
    agent: string,
    liveConnections: ConnectionSpec[],
  ): Promise<{ pruned: number; prunedIds?: string[] }> {
    // Send the live connection SPECS, not pre-computed keys: the hub re-derives
    // each key with its OWN connectionKey (the one it stored them under). Sending
    // keys we computed here would couple to the hub's separate connectionKey impl,
    // which diverges for service / tagged-vault / mixed-case-mcp grants and would
    // wrongly prune still-wanted grants (caught by live verification 2026-06-18).
    const url = `${this.base}/admin/grants/reconcile`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ agent, liveConnections }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new GrantsApiError(`reconcile grants failed (${res.status}) ${detail}`.trim(), res.status);
    }
    const parsed = (await res.json().catch(() => ({}))) as { pruned?: number; prunedIds?: string[] };
    return {
      pruned: typeof parsed.pruned === "number" ? parsed.pruned : 0,
      ...(Array.isArray(parsed.prunedIds) ? { prunedIds: parsed.prunedIds } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Status resolution — enabled vs pending from registered grants
// ---------------------------------------------------------------------------

/** The resolved status for a def after its connections are registered. */
export interface ConnectionStatus {
  /** `enabled` iff every declared connection is `approved`; else `pending`. */
  status: "enabled" | "pending";
  /** The connection keys NOT yet approved (only when `pending`). */
  pending?: string[];
}

/**
 * Resolve the def's status from its declared connections + each one's registered
 * grant status (design §2). `enabled` ONLY if EVERY connection is `approved`; else
 * `pending` listing the unapproved connection keys. No connections → `enabled`.
 *
 * `grantStatusByKey` maps a {@link connectionKey} → the hub's grant status. A
 * connection with no entry (registration failed / not found) counts as NOT approved.
 */
export function resolveConnectionStatus(
  connections: ConnectionSpec[],
  grantStatusByKey: Map<string, string>,
): ConnectionStatus {
  if (connections.length === 0) return { status: "enabled" };
  const pending: string[] = [];
  for (const c of connections) {
    const key = connectionKey(c);
    if (grantStatusByKey.get(key) !== "approved") pending.push(key);
  }
  if (pending.length === 0) return { status: "enabled" };
  return { status: "pending", pending };
}

// ---------------------------------------------------------------------------
// Spawn-time injection — approved grant material → MCP-config entries + env vars
// ---------------------------------------------------------------------------

/** Known service → the env var name its token injects as. Default: `<TARGET>_TOKEN`. */
const SERVICE_ENV_VAR: Record<string, string> = {
  github: "GITHUB_TOKEN",
  cloudflare: "CLOUDFLARE_API_TOKEN",
};

/** Known service → its remote MCP server URL (for the `inject:["mcp"]` shape). */
const SERVICE_MCP_URL: Record<string, string> = {
  github: "https://api.githubcopilot.com/mcp/",
};

/** The env var name a service's token injects as (known map ?? `<TARGET>_TOKEN`). */
export function serviceEnvVar(service: string): string {
  return SERVICE_ENV_VAR[service] ?? `${service.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TOKEN`;
}

/** The known remote-MCP URL for a service, or undefined (no MCP injection for it). */
export function serviceMcpUrl(service: string): string | undefined {
  return SERVICE_MCP_URL[service];
}

/** One MCP server entry to ADD to the agent's `--mcp-config` from a grant. */
export interface InjectedMcpEntry {
  /** Entry key in `mcpServers` (unique per granted resource). */
  name: string;
  /** Streamable-HTTP MCP URL. */
  url: string;
  /** Bearer token for the Authorization header. */
  token: string;
}

/**
 * One granted git credential (a surface grant) — the git remote the agent
 * clones/pushes + the scoped hub token that authenticates it. The token is
 * injected into `git` via a per-spawn 0700 GIT_ASKPASS (private + executable — git
 * execs it; never `.git/config`), so it never persists on disk beyond the ephemeral
 * workspace (design §6a step 4).
 */
export interface GitCredential {
  /** The git remote — `<hubOrigin>/git/<name>` (the hub git-transport endpoint). */
  remoteUrl: string;
  /** The scoped `surface:<name>:<verb>` JWT (Basic `x-access-token:<jwt>` / Bearer). */
  token: string;
}

/** The result of resolving an agent's approved grants into spawn-injectable bits. */
export interface InjectedGrants {
  /** MCP servers to ADD to the existing per-spawn `.mcp.json` (vault + service-mcp). */
  mcpEntries: InjectedMcpEntry[];
  /** Env vars to set for the agent's shell tools (service env injections). */
  env: Record<string, string>;
  /**
   * Granted git credentials (surface grants) — the backend wires each into a
   * per-spawn GIT_ASKPASS + a `PARACHUTE_SURFACE_<NAME>_REMOTE` env var so the
   * agent can `git clone`/`git push` the surface's repo. Empty for an agent with
   * no surface grants (today's behavior — no git wiring at all).
   */
  gitCredentials: GitCredential[];
}

/**
 * Resolve an agent's APPROVED grants into spawn-injectable MCP entries + env vars
 * (design §3). Fetches the agent's grant LIST, then for each `approved` grant fetches
 * its MATERIAL FRESH (never cached — revocation takes effect next spawn) and maps it:
 *
 *   - vault material (`{token, mcpUrl}`)            → an MCP server entry (the agent
 *       reaches the OTHER vault alongside its own).
 *   - service material, inject includes `"env"`     → an env var (github→GITHUB_TOKEN,
 *       cloudflare→CLOUDFLARE_API_TOKEN, default `<TARGET>_TOKEN`).
 *   - service material, inject includes `"mcp"`     → the service's MCP server entry
 *       (known-service→URL map; a service with no known MCP logs + SKIPS the mcp
 *       inject, keeping the env one).
 *   - surface material (`{token, remoteUrl}`)        → a {@link GitCredential} (the
 *       agent clones/pushes the surface's hub-hosted git repo). NOT an MCP entry +
 *       NOT an env var — the backend wires it into a per-spawn GIT_ASKPASS + a
 *       remote-URL env var.
 *   - mcp material (`{token, mcpUrl}`, 4b-2)         → an MCP server entry (the agent
 *       reaches the remote MCP / OAuth resource). An UNAPPROVED mcp grant has no
 *       material — `getMaterial` returns null (404/409), so it's simply absent.
 *
 * The MCP-entry KEYS are namespaced (`grant-vault-<name>`, `grant-service-<svc>`,
 * `grant-mcp-<grant-id>`) so they never collide with the agent's own def-vault entry
 * (`parachute-vault-<name>`).
 *
 * Best-effort + isolated: the grant LIST failing throws (the caller logs + spawns
 * WITHOUT injected grants — own-vault still works); a SINGLE material fetch failing
 * is logged + skipped (that one connection is absent; the rest inject). Secrets only
 * flow into the returned struct → the ephemeral 0600 spawn config; never logged.
 */
export async function resolveInjectedGrants(
  client: GrantsClient,
  agent: string,
): Promise<InjectedGrants> {
  const mcpEntries: InjectedMcpEntry[] = [];
  const env: Record<string, string> = {};
  const gitCredentials: GitCredential[] = [];

  const grants = await client.listGrants(agent); // throws → caller spawns without grants
  for (const g of grants) {
    if (g.status !== "approved") continue; // only approved grants have material
    let material: GrantMaterial | null;
    try {
      material = await client.getMaterial(g.id);
    } catch (err) {
      // A single material fetch fault must not sink the others — that connection is
      // simply absent this spawn. Never log the token (there is none in the error).
      console.warn(
        `parachute-agent: fetching grant material for "${agent}" (${connectionKey(g.connection)}) ` +
          `failed (skipping this connection): ${(err as Error).message}`,
      );
      continue;
    }
    if (!material) continue; // 404/409 — not actually approved/available right now

    if (material.kind === "vault") {
      mcpEntries.push({
        name: grantVaultEntryKey(g.connection.target),
        url: material.mcpUrl,
        token: material.token,
      });
      continue;
    }

    if (material.kind === "mcp") {
      // Remote-MCP grant (4b-2): the /material wire shape is byte-identical to vault's
      // (`{token, mcpUrl}`); inject it the SAME way. Key on the grant ID (not the URL)
      // so two distinct remote MCPs never collide on the entry name.
      mcpEntries.push({
        name: grantMcpEntryKey(g.id),
        url: material.mcpUrl,
        token: material.token,
      });
      continue;
    }

    if (material.kind === "surface") {
      // Surface git grant (Phase 2 §6a): the material carries the scoped token +
      // the git remote. The backend wires it into a per-spawn GIT_ASKPASS + a
      // `PARACHUTE_SURFACE_<NAME>_REMOTE` env var — NEVER an MCP entry + NEVER
      // `.git/config`. Just carry it through as a git credential.
      gitCredentials.push({ remoteUrl: material.remoteUrl, token: material.token });
      continue;
    }

    if (material.kind === "service") {
      // service material — inject env and/or mcp per the material's `inject` list.
      const service = g.connection.target;
      const inject = material.inject ?? [];
      if (inject.includes("env")) {
        env[serviceEnvVar(service)] = material.token;
      }
      if (inject.includes("mcp")) {
        const url = serviceMcpUrl(service);
        if (url) {
          mcpEntries.push({
            name: grantServiceEntryKey(service),
            url,
            token: material.token,
          });
        } else {
          // No known MCP URL for this service — keep the env inject, skip the mcp one.
          console.warn(
            `parachute-agent: service "${service}" granted with inject:"mcp" but no known MCP URL — ` +
              `skipping the MCP injection (the env injection, if any, still applies).`,
          );
        }
      }
      continue;
    }

    // Exhaustiveness guard (future-safety): every known material kind `continue`s
    // above, so `material` is `never` here today. If a future kind is added to the
    // union without a branch, it lands here + is skipped LOUDLY rather than silently
    // falling into the service path. Never log the token (the struct, not the value).
    console.warn(
      `parachute-agent: grant material for "${agent}" has an unhandled kind ` +
        `"${(material as { kind?: string }).kind}" — skipping (no injection).`,
    );
  }

  return { mcpEntries, env, gitCredentials };
}

/**
 * UNION an agent's injected grants across MULTIPLE grant-source keys (roles as the
 * capability layer — DESIGN-2026-06-29-threads-roles-context.md). The injected grants for a
 * turn are the union of `resolveInjectedGrants(client, key)` over `[spec.name, ...roleKeys]`:
 *
 *   - `spec.name`  — the LEGACY def path (UNCHANGED): a `#agent/definition` keeps its
 *     grants keyed by its `metadata.name`. For the 4 live def agents (uni, steward, …)
 *     this is the ONLY key, so with no loaded roles the union has one source and the
 *     result is byte-identical to {@link resolveInjectedGrants}(client, spec.name).
 *   - each `roleKey` — a slugged role PATH ({@link rolePathKey}) for every loaded note in
 *     the thread's `metadata.roles` that is an `#agent/role` declaring `wants:`. Loading a
 *     role into a thread unions that role's path-keyed APPROVED grants in.
 *
 * Dedupe rule: MCP entries are deduped by their entry `name` (first source wins);
 * env vars are deduped by var name (first source wins); git credentials are deduped
 * by `remoteUrl` (first source wins). The legacy `spec.name` source is conventionally
 * first, so a def's own grant wins a collision with a role's.
 *
 * Keys are deduped + processed in order; a duplicate key (e.g. the same role twice in the
 * roles list, or a role key that happens to equal `spec.name`) is fetched ONCE. A single
 * source's grant-LIST failure is logged + SKIPPED (its grants are simply absent this
 * turn — the others still inject), so a flaky hub on one role never sinks the whole
 * turn's injection. Material is fetched FRESH per source (never cached), same as the
 * single-source path.
 */
export async function resolveInjectedGrantsUnion(
  client: GrantsClient,
  keys: string[],
): Promise<InjectedGrants> {
  const mcpByName = new Map<string, InjectedMcpEntry>();
  const env: Record<string, string> = {};
  const gitByRemote = new Map<string, GitCredential>();
  const seenKeys = new Set<string>();

  for (const key of keys) {
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    let injected: InjectedGrants;
    try {
      injected = await resolveInjectedGrants(client, key);
    } catch (err) {
      // A single source's grant LIST failing must not sink the others — that source's
      // grants are simply absent this turn (its own-vault is unaffected; another
      // source's grants still inject). Never log a token (there is none in the error).
      console.warn(
        `parachute-agent: resolving grants for source "${key}" failed ` +
          `(skipping this source's grants for this turn): ${(err as Error).message}`,
      );
      continue;
    }
    for (const entry of injected.mcpEntries) {
      if (!mcpByName.has(entry.name)) mcpByName.set(entry.name, entry);
    }
    for (const [varName, value] of Object.entries(injected.env)) {
      if (!(varName in env)) env[varName] = value;
    }
    for (const cred of injected.gitCredentials) {
      if (!gitByRemote.has(cred.remoteUrl)) gitByRemote.set(cred.remoteUrl, cred);
    }
  }

  return {
    mcpEntries: [...mcpByName.values()],
    env,
    gitCredentials: [...gitByRemote.values()],
  };
}

// ---------------------------------------------------------------------------
// Surface git injection — the GIT_ASKPASS credential channel (design §6a step 4)
// ---------------------------------------------------------------------------

/** POSIX single-quote-escape (for embedding a value inside `'…'` in the script). */
function shSingleQuoteBody(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

/** The git URL path (`/git/<name>`) of a surface remote — used to disambiguate
 *  tokens when an agent holds grants to MULTIPLE surfaces on the one hub host. */
function gitRemotePath(remoteUrl: string): string {
  try {
    return new URL(remoteUrl).pathname;
  } catch {
    return remoteUrl;
  }
}

/** The surface name (last `/git/<name>` segment) of a remote, or null. */
export function surfaceNameFromRemoteUrl(remoteUrl: string): string | null {
  const segs = gitRemotePath(remoteUrl).split("/").filter((s) => s.length > 0);
  const last = segs[segs.length - 1];
  return last && last.length > 0 ? last : null;
}

/** The `PARACHUTE_SURFACE_<NAME>_REMOTE` env var name for a surface remote. */
export function surfaceRemoteEnvVar(remoteUrl: string): string | null {
  const name = surfaceNameFromRemoteUrl(remoteUrl);
  if (!name) return null;
  return `PARACHUTE_SURFACE_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_REMOTE`;
}

/**
 * Build the per-spawn GIT_ASKPASS script that feeds a surface-scoped hub token to
 * `git` on demand — so the token authenticates `git clone`/`git push` WITHOUT ever
 * landing in `.git/config` or a URL (design §6a step 4). Git invokes the askpass as
 * `askpass "<prompt>"`; the script answers on stdout:
 *   - a `Username` prompt → the sentinel `x-access-token` (the hub accepts Basic
 *     `x-access-token:<jwt>`, GitHub's compat form — see git-transport.ts extractToken);
 *   - a `Password` prompt → the surface's token.
 *
 * SINGLE surface (the common case): any password prompt echoes the one token —
 * host-keyed, unambiguous. MULTIPLE surfaces share the ONE hub host, so the caller
 * sets `credential.useHttpPath=true` (see {@link buildSurfaceGitEnv}) which puts the
 * repo PATH in the prompt; this script then path-matches `…/git/<name>…` to return
 * the right token (falling back to the first token if no path matches — a graceful,
 * debuggable 403 rather than a wrong-surface push, never a security hole).
 *
 * PURE + testable. The token is single-quoted (a JWT is `[A-Za-z0-9._-]` — never a
 * quote — but we escape defensively). Empty `creds` → a no-op script (never wired).
 */
export function buildGitAskpassScript(creds: GitCredential[]): string {
  const head = [
    "#!/bin/sh",
    "# Parachute surface git credentials — GIT_ASKPASS (per-spawn, 0700, ephemeral).",
    "# The surface-scoped hub token is echoed on demand only — it NEVER lands in",
    "# .git/config or a remote URL. Git invokes: askpass \"<prompt>\".",
    'case "$1" in',
    "  Username*|username*) printf %s 'x-access-token' ;;",
    "  *)",
  ];
  const tail = ["esac", ""];
  if (creds.length <= 1) {
    const tok = creds[0]?.token ?? "";
    return [...head, `    printf %s '${shSingleQuoteBody(tok)}' ;;`, ...tail].join("\n");
  }
  // Multi-surface: match the repo path in the prompt (needs credential.useHttpPath).
  const inner = ['    case "$1" in'];
  for (const c of creds) {
    const path = gitRemotePath(c.remoteUrl);
    inner.push(`      *'${shSingleQuoteBody(path)}'*) printf %s '${shSingleQuoteBody(c.token)}' ;;`);
  }
  inner.push(`      *) printf %s '${shSingleQuoteBody(creds[0]!.token)}' ;;`);
  inner.push("    esac", "    ;;");
  return [...head, ...inner, ...tail].join("\n");
}

/**
 * Build the env vars that wire a surface-grant holder's `git` to the per-spawn
 * askpass (design §6a step 4). Returns `{}` for no surface grants (no git wiring —
 * today's behavior). For ≥1:
 *   - `GIT_ASKPASS` → the askpass script path; `GIT_TERMINAL_PROMPT=0` (fail closed,
 *     never block on an interactive prompt);
 *   - `PARACHUTE_SURFACE_<NAME>_REMOTE` per surface → the clone/push URL, so the
 *     agent DISCOVERS where to clone (the clone-per-turn model — the agent runs the
 *     clone itself in its cwd; the daemon pre-clones nothing);
 *   - for ≥2 surfaces (same hub host, distinct scoped tokens) → `credential.useHttpPath`
 *     via GIT_CONFIG_* so git includes the repo PATH in the askpass prompt and the
 *     script can return the RIGHT token per surface. None of these are secrets (the
 *     token lives only in the askpass file) and none collide with the Claude-auth
 *     denylist, so they ride the ordinary child-env path.
 */
export function buildSurfaceGitEnv(
  creds: GitCredential[],
  askpassPath: string,
): Record<string, string> {
  if (creds.length === 0) return {};
  const env: Record<string, string> = {
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const c of creds) {
    const varName = surfaceRemoteEnvVar(c.remoteUrl);
    if (varName) env[varName] = c.remoteUrl;
  }
  if (creds.length >= 2) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "credential.useHttpPath";
    env.GIT_CONFIG_VALUE_0 = "true";
  }
  return env;
}

/**
 * The hub grant-holder KEY for a ROLE (roles as the capability layer —
 * DESIGN-2026-06-29-threads-roles-context.md) — the slugged note PATH, mirroring the slug
 * discipline the hub's `grantId` uses (`/`→`-`, all non-slug chars collapse). Prefixed
 * `role--` so it reads UNAMBIGUOUSLY as a role source and is practically partitioned from
 * def keys: a def `metadata.name` is an operator-authored `[a-zA-Z0-9_-]+` slug (the live
 * cast — `uni`, `steward`, … — have no `--`), so the `role--` prefix keeps the two
 * namespaces apart in normal operation. (The def-name regex technically accepts `--`, so a
 * deliberately-crafted def named `role--<x>` could share a role's partition — but that's an
 * operator-trust corner, not an exploitable boundary: an operator who can author such a def
 * can author the role too.) The hub keys `grantId(agent, spec) = ${agent}--${connectionKey}`
 * on this opaque holder string; each role is therefore its OWN prune partition on the hub
 * (`listGrantsForAgent`), so a role's reconcile can never touch a def's grants or another role's.
 *
 * Examples: `Uni/Roles/github` → `role--Uni-Roles-github`; `Roles/Read.ai` → `role--Roles-Read-ai`.
 */
export function rolePathKey(notePath: string): string {
  // Mirror sandbox/types.ts `slug`: collapse every non-`[a-zA-Z0-9_-]` char to `-`.
  const slugged = notePath.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `role--${slugged}`;
}

/** The bare tag (post-canonicalization) that marks a note as a ROLE — `#agent/role`. */
export const ROLE_TAG = "agent/role";

/**
 * Is this loaded note a ROLE that declares `wants:`? — the SECURITY GATE (roles carry
 * capability — DESIGN-2026-06-29-threads-roles-context.md). A note's `wants:` is honored
 * ONLY if the note carries the `#agent/role` tag; a plain content note's `wants:` is
 * IGNORED (inert) even if present, so loading arbitrary notes for context can NEVER add
 * capabilities. PURE — no I/O. Tag matching tolerates a stray leading `#` (pre-/post-
 * canonicalization) so an `#agent/role`-authored note is recognized either way.
 *
 * Returns the parsed `wants:` connection specs when the note is a role WITH a non-empty,
 * cleanly-parsing `wants:`; otherwise `null` (not a role, no `wants:`, or a parse error —
 * a parse error stamps the note `status:error` via the reconcile path; this fast-path just
 * returns null).
 */
export function roleWants(note: {
  tags?: unknown;
  metadata?: Record<string, unknown>;
}): ConnectionSpec[] | null {
  if (!isRoleNote(note)) return null;
  const raw = note.metadata?.wants;
  if (raw === undefined || raw === null) return null;
  let specs: ConnectionSpec[];
  try {
    specs = parseWants(raw);
  } catch {
    return null; // parse error — the reconcile path stamps status:error; injection ignores it.
  }
  return specs.length > 0 ? specs : null;
}

/**
 * Does this note carry the `#agent/role` tag? Tolerates the `tags` field being an array of
 * strings (the vault REST shape) or a comma/space-joined string, and a stray leading
 * `#` on the tag value. PURE.
 */
export function isRoleNote(note: { tags?: unknown }): boolean {
  const tags = note.tags;
  let list: string[];
  if (Array.isArray(tags)) {
    list = tags.map((t) => (typeof t === "string" ? t : String(t)));
  } else if (typeof tags === "string") {
    list = tags.split(/[,\s]+/);
  } else {
    return false;
  }
  return list.some((t) => t.trim().replace(/^#/, "") === ROLE_TAG);
}

/** MCP entry key for a GRANTED vault — namespaced so it never collides with the
 *  agent's OWN def-vault entry (`parachute-vault-<name>`). */
export function grantVaultEntryKey(vault: string): string {
  return `grant-vault-${vault}`;
}

/** MCP entry key for a GRANTED service MCP server. */
export function grantServiceEntryKey(service: string): string {
  return `grant-service-${service}`;
}

/** MCP entry key for a GRANTED remote MCP (4b-2) — keyed by the grant id (stable +
 *  collision-free) and namespaced so it never collides with `grant-vault-*` /
 *  `grant-service-*` / the agent's OWN def-vault entry (`parachute-vault-<name>`). */
export function grantMcpEntryKey(slug: string): string {
  return `grant-mcp-${slug}`;
}
