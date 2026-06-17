/**
 * Shared hub-JWT auth gate for parachute-agent's HTTP surfaces.
 *
 * Both auth layers run the same check — validate a hub-issued JWT against the
 * hub's JWKS (via `hub-jwt.ts` → scope-guard) and assert a required scope:
 *
 *   - Layer 1 (bridge / session↔channel): the bridge presents the token as an
 *     `Authorization: Bearer` header on `/events` + `/api/*`.
 *   - Layer 2 (human / chat UI): the page fetches a short-lived token from the
 *     hub (`/admin/agent-token`) and attaches it — as a Bearer header on the
 *     `send` POST, and as a `?token=` query param on the `/ui/events` SSE
 *     (EventSource can't set headers).
 *
 * `requireScope` accepts the token from EITHER source so one helper guards both
 * layers. The no-token path short-circuits before any JWKS fetch, keeping it
 * unit-testable without a live hub (same approach Layer 1 used).
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
 * first (the bridge + the UI's POST), falling back to a `?token=` query param
 * (the SSE case — `EventSource` can't set headers). Returns null if neither is
 * present.
 */
export function extractToken(req: Request, url: URL, allowQueryParam = false): string | null {
  const bearer = extractBearer(req.headers.get("authorization"));
  if (bearer) return bearer;
  // `?token=` is opt-in (the SSE case only). The bridge + the UI POST present a
  // Bearer header, so they never enable it — keeps query-param tokens off every
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
 * accept a `?token=` query param (the SSE case only — `EventSource` can't set
 * headers). Bridge + UI-POST callers leave it false, so query-param tokens are
 * confined to the one endpoint that needs them.
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
