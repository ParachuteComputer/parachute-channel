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
 * THE WIRE CONTRACT (parachute-hub PR #668 — consume, do not redesign):
 *   - PUT  <hub>/admin/grants          { agent, connection } → { id, agent, connection, status, reason? }
 *   - GET  <hub>/admin/grants?agent=<> → { grants: [{ id, agent, connection, status, reason?, approvedAt? }] }
 *   - GET  <hub>/admin/grants/<id>/material → APPROVED only:
 *         vault   → { kind:"vault",   token, mcpUrl }
 *         service → { kind:"service", token, inject }
 *         (404 unknown id / 409 not-approved)
 *   - Auth: all three need a `parachute:host:admin` Bearer — we REUSE the module's
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
  /** Resource kind. `vault`/`service` are wired in 4b-1; `mcp` is parsed-but-deferred. */
  kind: "vault" | "service" | "mcp";
  /**
   * The resource target — a vault name (`research`), a service name (`github`),
   * or, for `kind:"mcp"`, the remote MCP https URL.
   */
  target: string;
  /** Vault access verb. Vault-only. */
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
 *   mcp     → `mcp:<url>`
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
  return `mcp:${c.target}`;
}

/** A vault name slug — the `<name>` segment in `vault:<name>:<verb>`. */
const VAULT_NAME_SLUG = /^[a-zA-Z0-9_-]+$/;
/** A service name slug — `github`, `cloudflare`, … */
const SERVICE_NAME_SLUG = /^[a-zA-Z0-9_-]+$/;

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
          `vault | env | mcp.`,
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
 * Thin client for the hub's grants API (parachute-hub #668). Three calls the module
 * makes — register (PUT), list (GET), fetch-material (GET …/material). It NEVER
 * approves/revokes (operator-only via the hub UI). All requests carry the manager
 * bearer (`parachute:host:admin`).
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

/** The result of resolving an agent's approved grants into spawn-injectable bits. */
export interface InjectedGrants {
  /** MCP servers to ADD to the existing per-spawn `.mcp.json` (vault + service-mcp). */
  mcpEntries: InjectedMcpEntry[];
  /** Env vars to set for the agent's shell tools (service env injections). */
  env: Record<string, string>;
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

  return { mcpEntries, env };
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
