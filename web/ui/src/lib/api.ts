/**
 * HTTP client for the agent SPA. All calls hit the daemon's JSON API, gated by
 * the hub-minted `agent:admin` Bearer (`lib/auth.ts:getAgentToken`).
 *
 * This phase (Agent UI v2 — Phase 2) is READ-ONLY: it surfaces the three
 * Phase-1 list endpoints and merges them into one agent-centric view. No create
 * / edit / delete (those are Phases 3–4).
 *
 *   - `GET /agent/api/agents`        — every agent across ALL backends
 *     (interactive / programmatic / channel), with live status.
 *   - `GET /agent/api/agent-defs`    — the vault-native `#agent/definition`
 *     records (the durable defs that instantiate agents).
 *   - `GET /agent/api/agent-vaults`  — the module-level def-vault list
 *     (`agent-vaults.json` — which vaults the module reads defs from).
 *
 * ## API base path
 *
 * The daemon's API lives at the `/agent/api/*` proxied path (the hub strips the
 * `/agent` prefix; the daemon sees `/api/*`). The SPA serves under
 * `import.meta.env.BASE_URL` = `/agent/app/`, so its sibling API is `/agent/api`
 * — derived by swapping the trailing `app/` segment for `api`. In stand-alone
 * dev (`BASE_URL=/`), we fall back to `/agent/api`, which the dev proxy in
 * vite.config.ts forwards to the loopback daemon.
 */
import { clearCachedToken, getAgentToken } from "./auth.ts";

/** Status code carried alongside the message so callers can branch numerically. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Resolve the daemon API base from the SPA mount. `/agent/app/` → `/agent/api`;
 * anything else (dev at origin root) → `/agent/api`, which the vite dev proxy
 * forwards. Origin-absolute, so it resolves correctly regardless of the
 * react-router basename.
 */
export function apiBase(): string {
  const base = import.meta.env.BASE_URL || "/";
  // `/agent/app/` → `/agent/api`. Strip a trailing `app/` (or `app`) and append
  // `api`; if the mount doesn't end in `app`, fall back to the canonical path.
  const m = base.match(/^(.*\/)app\/?$/);
  if (m) return `${m[1]}api`;
  return "/agent/api";
}

/**
 * `fetch` with the agent Bearer attached + a single re-mint-and-retry on 401 —
 * the SPA mirror of `src/ui-kit.ts:authedFetch`. On a clean 401 we drop the
 * cached token, re-mint once, and retry; a persistent 401 surfaces as an
 * `HttpError`.
 */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAgentToken();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status !== 401) return res;
  // Re-mint once and retry. The first mint may have been stale/absent.
  clearCachedToken();
  const fresh = await getAgentToken();
  if (!fresh) return res; // no session — let the caller surface the 401
  const retryHeaders = new Headers(init.headers);
  retryHeaders.set("accept", "application/json");
  retryHeaders.set("authorization", `Bearer ${fresh}`);
  return fetch(path, { ...init, headers: retryHeaders });
}

/** Pull the server `error` (or text) off a non-2xx response for an HttpError. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? "";
  } catch {
    return await res.text().catch(() => "");
  }
}

/** GET a JSON endpoint with the Bearer, throwing HttpError on a non-2xx. */
async function getJson<T>(suffix: string): Promise<T> {
  const res = await authedFetch(`${apiBase()}${suffix}`);
  if (!res.ok) {
    throw new HttpError(res.status, (await errorDetail(res)) || `${suffix} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * POST a JSON body to an endpoint with the Bearer + the same single 401
 * re-mint-and-retry as `getJson`, throwing HttpError on a non-2xx. Used by the
 * Phase-3 create flow (the first write path the SPA carries).
 */
async function postJson<T>(suffix: string, body: unknown): Promise<T> {
  const res = await authedFetch(`${apiBase()}${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new HttpError(res.status, (await errorDetail(res)) || `${suffix} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Wire types — mirror the daemon's Phase-1 JSON shapes (snake/camel as the
// daemon emits them; the daemon uses camelCase for these endpoints).
// ---------------------------------------------------------------------------

/** The backend that drives an agent. The primary axis of the v2 view. */
export type AgentBackend = "interactive" | "programmatic" | "channel";

/**
 * One entry from `GET /agent/api/agents` — the merged all-backends list.
 * Mirrors `AgentInfo` in `src/agents.ts`. Interactive agents carry
 * `attached`/`hasWorkspace`; programmatic/channel agents carry a live `status`
 * and (when vault-native) a `channel` + `vault`.
 */
export interface AgentRow {
  name: string;
  session: string;
  attached: boolean;
  workspace: string;
  hasWorkspace: boolean;
  backend: AgentBackend;
  /** Live status — `idle` | `working` | `queued:N`. Absent for interactive. */
  status?: string;
  /** The wake channel this agent serves (channel-backend; agent == channel). */
  channel?: string;
  /** The def-vault backing this agent's conversation, when known. */
  vault?: string;
  systemPromptMode?: "append" | "replace";
  workingDir?: string;
}

export interface AgentsResponse {
  agents: AgentRow[];
}

/** The resolved liveness of a vault-native def. Mirrors `AgentDefStatus`. */
export type AgentDefStatus = "enabled" | "pending" | "error" | string;

/**
 * One entry from `GET /agent/api/agent-defs` — a vault-native
 * `#agent/definition` record. Mirrors `AgentDefDetail` in `src/agent-defs.ts`.
 */
export interface AgentDefRow {
  /** The vault note id (the create/edit/delete key — not used read-only). */
  noteId: string;
  name: string;
  backend: "programmatic" | "channel";
  vault: string;
  status: AgentDefStatus;
  /** Declared connections still pending approval (empty when none). */
  pending: string[];
  /** First ~200 chars of the system prompt — a preview, NOT the full text. */
  systemPromptPreview: string;
  /** Structured `wants:` connection keys (empty when own-vault only). */
  wants: string[];
  /** The wake channel inbound routes to this agent on (== name). */
  channel: string;
}

export interface AgentDefsResponse {
  defs: AgentDefRow[];
}

/**
 * One entry from `GET /agent/api/agent-vaults` — a def-vault binding.
 * `tokenPresent` is a boolean, NEVER the token value.
 */
export interface AgentVaultRow {
  vault: string;
  url: string;
  tokenPresent: boolean;
}

export interface AgentVaultsResponse {
  vaults: AgentVaultRow[];
}

/** List every agent across all backends. */
export function listAgents(): Promise<AgentsResponse> {
  return getJson<AgentsResponse>("/agents");
}

/** List the vault-native agent definitions. */
export function listAgentDefs(): Promise<AgentDefsResponse> {
  return getJson<AgentDefsResponse>("/agent-defs");
}

/** List the module's def-vaults (read-only display). */
export function listAgentVaults(): Promise<AgentVaultsResponse> {
  return getJson<AgentVaultsResponse>("/agent-vaults");
}

// ---------------------------------------------------------------------------
// Create flow (Agent UI v2 — Phase 3). `POST /api/agent-defs` writes a vault-
// native `#agent/definition` note (body = system prompt, metadata = config) and
// auto-instantiates the agent + its channel routing — so the create flow is JUST
// this one call; there is NO separate channel-provisioning step.
// ---------------------------------------------------------------------------

/** Execution-lifecycle mode — the top-level branch. Rides in `metadata.mode`. */
export type AgentMode = "single-threaded" | "multi-threaded";

/** The backend selectable in the create flow. `interactive` is RETIRED — not offered. */
export type CreatableBackend = "programmatic" | "channel";

/**
 * The `POST /api/agent-defs` request body. Mirrors the daemon handler at
 * `src/daemon.ts` ~2755-2789. The MODE is NOT a top-level field — it rides in
 * `metadata.mode`; `metadata` is an object of strings (the daemon coerces).
 * `wants` is a comma-separated string (the daemon's `wants:` shape), optional.
 */
export interface CreateAgentDefBody {
  vault: string;
  name: string;
  backend: CreatableBackend;
  systemPrompt: string;
  wants?: string;
  metadata: Record<string, string>;
}

/** `POST /api/agent-defs` 201 response — the created def in the detail shape. */
export interface CreateAgentDefResponse {
  ok: boolean;
  def: AgentDefRow;
}

/**
 * Create a vault-native agent definition. Auto-instantiates the agent + (for a
 * channel backend) its channel inbound routing — one call, no separate channel
 * POST. Throws `HttpError` on a non-2xx (e.g. 400 "no def-vaults configured",
 * 409 name collision) so the form surfaces the daemon's message inline.
 */
export function createAgentDef(body: CreateAgentDefBody): Promise<CreateAgentDefResponse> {
  return postJson<CreateAgentDefResponse>("/agent-defs", body);
}

/**
 * The `claude mcp add` one-liner a channel-backend agent's operator runs to
 * connect their own Claude Code session to the channel's MCP endpoint. Mirrors
 * the daemon's server-rendered snippet (`src/daemon.ts:1194-1196`): the channel
 * MCP mounts at `<origin><MOUNT>/mcp/<name>`, where MOUNT is the agent module's
 * proxy prefix (`/agent` over the hub expose, derived from the API base by
 * dropping the trailing `/api`). The agent name IS its channel.
 */
export function connectSessionCommand(name: string, origin: string): string {
  const mount = apiBase().replace(/\/api$/, "");
  // Server-name is `agent-<name>` to match the chat UI's connect snippet
  // (src/daemon.ts ~1194: `var name = "agent-" + ch`), so an operator who connects
  // the same channel from either surface registers ONE consistently-named MCP server.
  // The URL path is the bare channel name (`/mcp/<name>`).
  return `claude mcp add --transport http --scope user agent-${name} ${origin}${mount}/mcp/${name}`;
}
