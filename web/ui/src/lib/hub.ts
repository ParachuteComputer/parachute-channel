/**
 * Hub-client for the agent SPA — the cookie-authed, same-origin path to the
 * hub's Connections engine (`/admin/connections`). Used to provision the
 * **def-reload connectors**: vault triggers that webhook the agent the moment an
 * `#agent/definition` note is created/edited, so a def change instantiates its
 * agent LIVE instead of converging only via the daemon's 60s loadAll poll.
 *
 * ## Why this is secure (the operator's click IS the approval)
 *
 * `POST /admin/connections` is cookie-gated to the logged-in portal operator and
 * same-origin-belted (`origin-check.ts` — the belt's own docstring names "the
 * agent module's admin page" as a canonical consumer). So every call here rides
 * the operator's OWN authenticated hub session over a same-origin `fetch()` with
 * `credentials: "include"` — exactly the intended approval flow, just driven from
 * the agent UI instead of the hub's generic Connections builder. The agent gains
 * NO new authority: it already holds the def-vault's write token (the def-vault
 * binding minted it) and already reads `#agent/definition` notes; the connector
 * only flips that read from POLL to PUSH, webhooking the agent's OWN reload
 * endpoint with the agent's OWN `agent:send` scope.
 *
 * ## Origin + transport
 *
 * The endpoints live at the HUB origin ROOT (`<origin>/admin/connections`), NOT
 * under the `/agent` proxy prefix — mirroring `lib/auth.ts`'s `/admin/agent-token`
 * mint. We hit `window.location.origin + "/admin/..."`. This works when the SPA
 * is served through the hub proxy (`<hub-origin>/agent/app/`, same origin as the
 * hub) — the path "most users" take. Served loopback-direct
 * (`http://127.0.0.1:1941/agent/app/`) the root path resolves to the AGENT
 * daemon, which doesn't serve `/admin/connections` → a 404 we map to a clear
 * "use the hub-proxied URL" hint. The 60s poll covers reactivity either way, so
 * a failure here is a convenience gap, never a correctness one.
 */

/** A non-2xx from a hub endpoint, carrying the status so callers can branch. */
export class HubError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HubError";
  }
}

/** The hub origin root — same origin as the hub when served through its proxy. */
function hubOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

/**
 * Whether the SPA is being served DAEMON-DIRECT (the agent daemon's own loopback
 * origin, e.g. `http://127.0.0.1:1941/agent/app/`) rather than through the hub proxy
 * (`<hub-origin>/agent/app/`). The cookie→hub "Connect" only works at the hub origin —
 * served daemon-direct, the hub root paths (`/admin/grants/...`) resolve to the AGENT
 * daemon, which doesn't serve them (→ 404), AND the operator cookie + CSRF Origin
 * belt wouldn't accept the daemon's origin anyway. We surface a clear inline note
 * up front instead of letting the operator hit a confusing error on Connect.
 *
 * Heuristic: the daemon binds loopback on the agent port (1941 default; the
 * PARACHUTE_AGENT_PORT override is for non-standard installs). An exposed hub is
 * NEVER served from `127.0.0.1`/`localhost` to a remote operator; a local operator
 * on the hub's own loopback hits the HUB port (1939), not the agent's. So a loopback
 * host on the agent port is the daemon-direct tell. Conservative: a false "looks
 * daemon-direct" only HIDES the Connect button (the 60s-equivalent correctness is the
 * grant still being registered); the authoritative signal remains the approve response
 * (a 404 maps to the same hub-proxied-URL hint). Returns false in non-browser (SSR).
 */
export function isDaemonDirectOrigin(): boolean {
  if (typeof window === "undefined") return false;
  const { hostname, port } = window.location;
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  // The agent daemon's own port (the SPA is daemon-served only on the daemon's port).
  return loopback && port === "1941";
}

/**
 * One connection as `GET /admin/connections` projects it (the fields we read;
 * the wire shape carries more). `source`/`sink` mirror the store records.
 */
export interface ConnectionRow {
  id: string;
  source: { module: string; vault?: string; event: string };
  sink: { module: string; action: string };
}

/** The `definition.reload` sink action every def-reload connector targets. */
const RELOAD_ACTION = "definition.reload";
/** The two vault events a def-reload pair covers (create + edit). */
const CREATE_EVENT = "note.created";
const EDIT_EVENT = "note.updated";

/** The def-discriminator tag the trigger filters on (created/edited defs only). */
const DEFINITION_TAG = "agent/definition";

/**
 * The stable connection id for a def-reload connector. Per (vault, kind) and
 * NOT per-agent: a def change in a vault reloads whichever agent it defines, so
 * one create-connector + one edit-connector per def-vault is the whole surface.
 * Stable ids make the POST an idempotent upsert (re-add/re-enable is a no-op)
 * and give teardown an exact target. Matches the hub's CONNECTION_ID_RE slug
 * (vault names are already slug-validated upstream).
 */
function defReloadId(vault: string, kind: "create" | "edit"): string {
  return `agentdefs-${kind}-${vault}`;
}

/** The `POST /admin/connections` body for one def-reload connector. */
function defReloadBody(vault: string, kind: "create" | "edit") {
  return {
    id: defReloadId(vault, kind),
    // Provenance — surfaces as the "agent" group in the hub Connections view,
    // so an operator can see these were wired by the agent module's UI.
    requestedBy: "agent",
    source: {
      module: "vault",
      vault,
      event: kind === "create" ? CREATE_EVENT : EDIT_EVENT,
      filter: { tags: [DEFINITION_TAG] },
    },
    sink: { module: "agent", action: RELOAD_ACTION },
  };
}

/** A hub `fetch` carrying the operator cookie. Browser sends `Origin` (passes the CSRF belt). */
async function hubFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  return fetch(`${hubOrigin()}${path}`, { ...init, credentials: "include", headers });
}

/** Map a non-2xx hub status to an operator-facing message. */
function hubErrorMessage(status: number, fallback: string): string {
  if (status === 401) return "Not signed in to the hub portal — sign in, then retry.";
  if (status === 403) return "Not authorized — reactive reload needs host-admin access.";
  if (status === 404)
    return "Reactive reload needs the hub-proxied URL — open the agent app via your hub origin, not the loopback daemon.";
  return fallback || `hub request failed (${status})`;
}

/** Pull the server `error` field (or text) off a non-2xx response. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; error_description?: string };
    return body.error_description ?? body.error ?? "";
  } catch {
    return await res.text().catch(() => "");
  }
}

/**
 * List the hub's connections. Throws `HubError` on a non-2xx (the caller treats
 * a failure as "reactive status unavailable" rather than erroring the section).
 */
export async function listConnections(): Promise<ConnectionRow[]> {
  const res = await hubFetch("/admin/connections");
  if (!res.ok) {
    throw new HubError(res.status, hubErrorMessage(res.status, await errorDetail(res)));
  }
  const body = (await res.json()) as { connections?: ConnectionRow[] };
  return body.connections ?? [];
}

/**
 * Whether a def-vault's reactive reload is fully wired. Matched by SEMANTICS
 * (source.vault + event + sink.action), not by our id — so a pair created via
 * the hub's own Connections builder counts too. `active` requires BOTH the
 * create- and edit-event connectors (the hub binds one event per connection).
 */
export function defReloadStatus(
  vault: string,
  connections: ConnectionRow[],
): { create: boolean; edit: boolean; active: boolean } {
  const matches = (event: string) =>
    connections.some(
      (c) =>
        c.source.module === "vault" &&
        c.source.vault === vault &&
        c.source.event === event &&
        c.sink.module === "agent" &&
        c.sink.action === RELOAD_ACTION,
    );
  const create = matches(CREATE_EVENT);
  const edit = matches(EDIT_EVENT);
  return { create, edit, active: create && edit };
}

/**
 * Provision (idempotent upsert) BOTH def-reload connectors for a def-vault. Each
 * POST is independent; a partial success is reported so the caller can surface
 * "edit connector failed" precisely. Throws `HubError` only if BOTH fail with
 * the same status (the common no-session / wrong-origin case) so the caller gets
 * one clear message; otherwise resolves with `{ ok, failures }`.
 */
export async function ensureDefReloadConnections(
  vault: string,
): Promise<{ ok: boolean; failures: string[] }> {
  const kinds: Array<"create" | "edit"> = ["create", "edit"];
  const failures: string[] = [];
  // First failure's status + RAW server detail, kept separate from the
  // per-kind formatted messages so the total-failure throw maps the status once
  // (no double-wrapping through hubErrorMessage).
  let firstStatus = 0;
  let firstDetail = "";
  for (const kind of kinds) {
    const res = await hubFetch("/admin/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(defReloadBody(vault, kind)),
    });
    if (!res.ok) {
      const detail = await errorDetail(res);
      if (firstStatus === 0) {
        firstStatus = res.status;
        firstDetail = detail;
      }
      failures.push(`${kind}: ${hubErrorMessage(res.status, detail)}`);
    }
  }
  if (failures.length === kinds.length) {
    // Total failure — surface the (uniform) reason as a single thrown error.
    throw new HubError(firstStatus, hubErrorMessage(firstStatus, firstDetail || "provisioning failed"));
  }
  return { ok: failures.length === 0, failures };
}

// ===========================================================================
// Agent-connector GRANTS — the cookie→hub "Connect" for an MCP server (4b-2).
//
// Adding the MCP server is a DAEMON op (PATCH the def's `wants:` to append
// `mcp:<url>`; the daemon registers the pending grant via its host-admin bearer).
// APPROVING it (the OAuth dance / static-bearer store) is OPERATOR-COOKIE-gated on
// the hub — a host-admin Bearer CANNOT approve (isFirstAdmin only). So the browser
// must call the hub's approve endpoint DIRECTLY with the operator cookie. This works
// same-origin because the SPA is served at the hub origin (`<hub>/agent/app/`).
//
// We MIRROR the hub's proven client impl (parachute-hub web/ui Grants.tsx
// `onConnectMcp`/`onApprove` + src/admin-agent-grants.ts `approveGrant`):
//   POST <origin>/admin/grants/<id>/approve   (credentials: "include")
//     - body `{}`         (no token) → OAuth: response carries `authorizeUrl`;
//                          the caller full-page-redirects the browser there.
//     - body `{ token }`  (static bearer) → store + approve immediately, no redirect.
//   A `needs_consent` grant re-offers the SAME path (the "Reconnect" affordance).
//
// Degradation: served daemon-direct (`http://127.0.0.1:1941/agent/app/`,
// cross-origin to the hub) the cookie won't flow and the CSRF belt rejects it — the
// approve 404s (no such route on the daemon) / 401s. The 404 maps to the existing
// "use the hub-proxied URL" hint, so the panel shows a clear message, not a confusing
// raw error. The brief's `isHubOrigin()` helper gates the affordance up front.
// ===========================================================================

/**
 * A grant in the hub's list/echo wire shape (NEVER carries the secret material).
 * Mirrors `GrantListing` in parachute-hub web/ui/src/lib/api.ts. `authorizeUrl` is
 * present ONLY on an `approveAgentGrant` OAuth start (no pasted token).
 */
export interface GrantListing {
  id: string;
  agent: string;
  connection: { kind: "vault" | "service" | "mcp"; target: string };
  status: "pending" | "approved" | "revoked" | "needs_consent";
  reason?: string;
  approvedAt?: string;
  /** The remote-issuer consent URL — present only when starting an mcp OAuth flow. */
  authorizeUrl?: string;
}

/**
 * Approve (or start the OAuth flow for) an agent connector grant — the cookie→hub
 * "Connect" / "Reconnect". `POST <origin>/admin/grants/<id>/approve` with the
 * operator cookie (`credentials: "include"`); same-origin only (the hub's CSRF belt).
 *
 *   - NO `token` → START OAuth: the returned listing carries `authorizeUrl`; the
 *     caller full-page-redirects the browser to the remote consent screen. The hub's
 *     callback finishes server-side and flips the grant `approved`.
 *   - WITH `token` → store a static bearer (non-OAuth MCP) + approve immediately.
 *
 * Throws `HubError` on a non-2xx — a 404 maps to the hub-proxied-URL hint (the
 * daemon-direct degradation), 401 to a sign-in hint. The grant `id` MUST come from
 * the daemon's def-API (`connections[].grantId`) — never derived client-side.
 */
export async function approveAgentGrant(
  id: string,
  token?: string,
  returnTo?: string,
): Promise<GrantListing> {
  const body: Record<string, string> = {};
  if (token !== undefined) body.token = token;
  // A ROOT-RELATIVE path (the hub's isSafeHubReturnTo rejects absolute URLs).
  // The hub 302s back to it after the OAuth round-trip, so the operator lands
  // back on this surface instead of a dead-end "close this tab" page.
  if (returnTo) body.returnTo = returnTo;
  const res = await hubFetch(`/admin/grants/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new HubError(res.status, hubErrorMessage(res.status, await errorDetail(res)));
  }
  return (await res.json()) as GrantListing;
}

/**
 * Tear down a def-vault's def-reload connectors. Deletes BOTH the canonical
 * ids AND any semantically-matching connection from the supplied list (so a
 * pair wired via the hub builder, with hub-derived ids, is also removed).
 * 404s are ignored (already gone). Throws `HubError` only on a non-404 failure.
 */
export async function teardownDefReloadConnections(
  vault: string,
  connections: ConnectionRow[] = [],
): Promise<void> {
  const ids = new Set<string>([defReloadId(vault, "create"), defReloadId(vault, "edit")]);
  for (const c of connections) {
    if (
      c.source.module === "vault" &&
      c.source.vault === vault &&
      (c.source.event === CREATE_EVENT || c.source.event === EDIT_EVENT) &&
      c.sink.module === "agent" &&
      c.sink.action === RELOAD_ACTION
    ) {
      ids.add(c.id);
    }
  }
  for (const id of ids) {
    const res = await hubFetch(`/admin/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new HubError(res.status, hubErrorMessage(res.status, await errorDetail(res)));
    }
  }
}
