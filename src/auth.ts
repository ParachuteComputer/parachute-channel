/**
 * Shared hub-JWT auth gate for parachute-agent's HTTP surfaces.
 *
 * Both auth layers run the same check — validate a hub-issued JWT against the
 * hub's JWKS (via `hub-jwt.ts` → scope-guard) and assert a required scope:
 *
 *   - Layer 1 (bridge / session↔channel): the bridge presents the token as an
 *     `Authorization: Bearer` header on `/events` + `/api/*`.
 *   - Layer 2 (human / chat UI): the page fetches a short-lived token from the
 *     hub (`/admin/agent-token`) and attaches it as a Bearer header on the
 *     `send` POST. For the browser SSE streams (`/ui/events`,
 *     `/api/channels/<ch>/turn-events`) — which an `EventSource` can't set a
 *     header on — the page does NOT put the JWT in the URL. Instead it mints a
 *     one-time SSE TICKET (`POST /api/ui/sse-ticket`, Bearer-authenticated) and
 *     opens `…?ticket=<nonce>`. See `requireSseTicket` below + `ui-ticket.ts`.
 *
 * `requireScope` accepts the token from a Bearer header (and, for the
 * agent:admin terminal WebSocket only, a `?token=` query param). The no-token
 * path short-circuits before any JWKS fetch, keeping it unit-testable without a
 * live hub (same approach Layer 1 used).
 *
 * WHY THE TICKET (agent#25). A full hub JWT in a `?token=` URL lands in any
 * access/proxy log, browser history, or network trace — a credential leak
 * mitigated before only by the token's short TTL. The browser SSE endpoints now
 * trade the JWT for an opaque, single-use, ≤60s ticket (`requireSseTicket`); the
 * JWT only ever travels in a `fetch` Bearer header. The legacy `?token=` SSE
 * path was REMOVED (pre-1.0, no deprecation window). The terminal WebSocket
 * (`agent:admin`) still uses `?token=` — a separate, operator-gated mechanism
 * out of this change's scope.
 *
 * DUAL-ACCEPT (channel→agent rename transition,
 * `parachute-patterns/migrations/2026-06-17-channel-to-agent.md` rule 1). New
 * tokens carry `agent:*` scopes; tokens minted before the rename carry
 * `channel:*`. The hub now MINTS `agent:*`, but live agent tokens minted earlier
 * must keep validating until re-minted. So `requireScope` accepts a request that
 * carries EITHER the required `agent:<verb>` scope OR its legacy `channel:<verb>`
 * equivalent. A later contract cycle drops the legacy acceptance.
 */

import { validateHubJwt, HubJwtError } from "./hub-jwt.ts";
import { extractBearer } from "@openparachute/scope-guard";
import { consumeTicket } from "./ui-ticket.ts";

/** Agent scopes, declared here so callers share one spelling. */
export const SCOPE_READ = "agent:read" as const;
export const SCOPE_WRITE = "agent:write" as const;
export const SCOPE_SEND = "agent:send" as const;
/** Config-management scope: create/list/delete channels (hub-orchestrated setup). */
export const SCOPE_ADMIN = "agent:admin" as const;

/**
 * Legacy alias for a new `agent:<verb>` scope — its pre-rename `channel:<verb>`
 * form. A token that carries the legacy scope is still accepted on read (the
 * dual-accept transition). Returns `undefined` when the scope has no `agent:`
 * prefix (a generic scope with no legacy alias).
 */
export function legacyScopeAlias(scope: string): string | undefined {
  return scope.startsWith("agent:") ? `channel:${scope.slice("agent:".length)}` : undefined;
}

/**
 * Whether a granted scope list authorizes `required` under dual-accept: it
 * contains `required` itself OR its legacy `channel:<verb>` alias.
 */
export function grantsScope(granted: readonly string[], required: string): boolean {
  if (granted.includes(required)) return true;
  const legacy = legacyScopeAlias(required);
  return legacy !== undefined && granted.includes(legacy);
}

/**
 * The scope the in-page terminal requires. The terminal attaches to a session's
 * live tmux pane — the MOST DANGEROUS capability the daemon exposes (full
 * interactive control of the session's shell), so it is OPERATOR-GATED, not
 * session-gated. We reuse `agent:admin`: the hub mints it ONLY for the
 * logged-in operator's cookie session (`<hub>/admin/agent-token` →
 * `agent:read agent:send agent:admin`), and never for a connecting Claude
 * Code session (a session holds `agent:read`/`agent:write`, never
 * `agent:admin`). So a session can never open a terminal onto itself or
 * another — only the operator can. This is the design's "operator-gated"
 * requirement expressed in the module's existing scope vocabulary (no new scope to
 * mint, no hub change). See `design/2026-06-14-sandboxed-agent-sessions.md` §5.3.
 */
export const SCOPE_TERMINAL = SCOPE_ADMIN;

/** JSON Response helper (shared spelling for the auth error bodies). */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Extract a presented token from a request: the `Authorization: Bearer` header
 * first (the bridge, the UI's POST, the SSE-ticket mint), falling back to a
 * `?token=` query param only when `allowQueryParam` is set. The ONLY caller that
 * opts into the query param is the agent:admin terminal WebSocket
 * (`new WebSocket()` can't set headers); the browser SSE streams moved to the
 * one-time-ticket path (`requireSseTicket`) so a JWT never rides in a URL. Returns
 * null if neither source is present.
 */
export function extractToken(req: Request, url: URL, allowQueryParam = false): string | null {
  const bearer = extractBearer(req.headers.get("authorization"));
  if (bearer) return bearer;
  // `?token=` is opt-in (the terminal WebSocket only). Every other caller presents
  // a Bearer header, so they leave it false — keeping query-param JWTs off every
  // endpoint that doesn't strictly need them (and out of those access logs).
  if (allowQueryParam) {
    const q = url.searchParams.get("token");
    if (q && q.length > 0) return q;
  }
  return null;
}

/**
 * Guard an HTTP endpoint on a hub-issued JWT carrying `scope`. The token arrives
 * as an `Authorization: Bearer` header; pass `allowQueryParam: true` to also
 * accept a `?token=` query param (the agent:admin terminal WebSocket only —
 * `new WebSocket()` can't set headers). All other callers leave it false, so
 * query-param JWTs are confined to that one endpoint. Browser SSE streams use
 * `requireSseTicket` (the one-time ticket), not this.
 *
 * Returns `null` when the request is authorized (caller proceeds), or a
 * `Response` (401/403) the caller must return as-is.
 *
 * The no-token path short-circuits before any JWKS fetch, so it's unit-testable
 * without a live hub. Real signature/issuer/audience validation is scope-guard's
 * own tested surface.
 */
export async function requireScope(
  req: Request,
  url: URL,
  scope: string,
  allowQueryParam = false,
): Promise<Response | null> {
  const token = extractToken(req, url, allowQueryParam);
  if (!token) {
    return json({ error: "unauthorized", message: "Bearer token required" }, 401);
  }
  try {
    const claims = await validateHubJwt(token);
    // Dual-accept: the required `agent:<verb>` scope OR its legacy `channel:<verb>`
    // alias authorizes the request (pre-rename tokens keep validating).
    if (!grantsScope(claims.scopes, scope)) {
      return json(
        { error: "insufficient_scope", message: `requires ${scope}`, granted: claims.scopes },
        403,
      );
    }
    return null;
  } catch (err) {
    return json(
      { error: "unauthorized", message: err instanceof HubJwtError ? err.message : "invalid token" },
      401,
    );
  }
}

/**
 * Mint endpoint for a one-time SSE ticket (agent#25). Authenticate the presented
 * Bearer JWT for `scope` (the SAME validation `requireScope` runs — no-token →
 * 401 pre-JWKS, bad/insufficient → 401/403), then issue a single-use, ≤60s
 * opaque ticket carrying ONLY the token's validated scopes. The ticket — never
 * the JWT — goes in the SSE URL. Returns the mint `Response` (200 `{ ticket,
 * expires_at }`, or the gate's 401/403) for the caller to return as-is.
 *
 * `mintTicket` is injected (defaults to the real `ui-ticket.ts` store) so unit
 * tests can assert what scopes get carried without reaching into the singleton.
 * Critically, an UNAUTHENTICATED mint is impossible: the scope gate runs first
 * and short-circuits before any ticket is created — minting without a valid
 * bearer would be an auth bypass.
 */
export async function mintSseTicket(
  req: Request,
  url: URL,
  scope: string,
  mint: (scopes: readonly string[]) => { ticket: string; expiresAt: number },
): Promise<Response> {
  const token = extractToken(req, url); // Bearer header ONLY — never a query param.
  if (!token) {
    return json({ error: "unauthorized", message: "Bearer token required" }, 401);
  }
  let scopes: string[];
  try {
    const claims = await validateHubJwt(token);
    if (!grantsScope(claims.scopes, scope)) {
      return json(
        { error: "insufficient_scope", message: `requires ${scope}`, granted: claims.scopes },
        403,
      );
    }
    // Carry the token's OWN validated scopes — never widen beyond what it holds.
    scopes = claims.scopes;
  } catch (err) {
    return json(
      { error: "unauthorized", message: err instanceof HubJwtError ? err.message : "invalid token" },
      401,
    );
  }
  const { ticket, expiresAt } = mint(scopes);
  return json({ ticket, expires_at: new Date(expiresAt).toISOString() });
}

/**
 * Guard a browser SSE endpoint on a one-time `?ticket=<nonce>` (agent#25 — the
 * EventSource auth path that replaced the leaky `?token=<JWT>`). Look up + CONSUME
 * the ticket (single-use: a second connect 401s), then assert the ticket's carried
 * scopes include `scope` (the ticket can never authorize more than the JWT that
 * minted it — `mintSseTicket` stored exactly that JWT's scopes). Returns `null`
 * when authorized (caller opens the stream) or a 401 `Response` to return as-is.
 *
 * No JWKS fetch on this path — the JWT was validated at MINT time and its scopes
 * captured in the ticket; consume is a pure in-memory lookup. So an absent /
 * expired / already-used / under-scoped ticket all map to 401 with no network I/O.
 */
export function requireSseTicket(url: URL, scope: string): Response | null {
  const consumed = consumeTicket(url.searchParams.get("ticket"));
  if (!consumed) {
    return json({ error: "unauthorized", message: "valid one-time SSE ticket required" }, 401);
  }
  if (!grantsScope(consumed.scopes, scope)) {
    return json(
      { error: "insufficient_scope", message: `ticket lacks ${scope}`, granted: consumed.scopes },
      403,
    );
  }
  return null;
}
