/**
 * Auth helper for the agent SPA. The SPA is served BY the agent daemon (under
 * the hub-proxied `/agent/app/` mount), so it leans on the operator's existing
 * hub SESSION COOKIE rather than running its own OAuth dance — exactly as the
 * daemon-rendered HTML pages already do (`src/ui-kit.ts:fetchToken`, the
 * `/admin/channel-token` → `/admin/agent-token` rename).
 *
 * Flow:
 *   1. SPA bootstrap (or any `/agent/api/*` call) calls `getAgentToken()`.
 *   2. That hits `GET <origin>/admin/agent-token` with `credentials:"include"`.
 *      The hub endpoint reads the `parachute_hub_session` cookie (set by the
 *      hub's /login) and trades it for a short-lived (~10 min) JWT carrying
 *      `aud:agent` + the `agent:admin` scope, returned as JSON.
 *   3. The token is held in module-scoped state — NEVER localStorage. Page
 *      snapshots can't carry it past a refresh, and the XSS surface is the
 *      narrowest possible.
 *   4. On 401, the cached token is dropped and the next call re-mints. The
 *      caller (`lib/api.ts:authedFetch`) re-mints once and retries — matching
 *      the HTML pages' single-retry-on-401 behavior.
 *
 * Note: the mint endpoint lives at the HUB origin root (`/admin/agent-token`),
 * NOT under the `/agent` proxy prefix — the hub serves it directly, cookie-gated
 * to the logged-in portal operator. We therefore hit `origin + "/admin/..."`,
 * never a BASE_URL-prefixed path.
 */

interface MintedToken {
  token: string;
  expiresAt: number; // epoch ms
}

let cached: MintedToken | null = null;
let inFlight: Promise<string | null> | null = null;

/** Minimum slack we keep on the cached token before refetching. */
const REFRESH_BUFFER_MS = 30_000;

/** Default TTL assumed when the mint response omits `expires_at`. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function tokenEndpoint(): string {
  // The mint sits at the hub origin root, cookie-gated. Same origin in every
  // mode (dev, daemon-direct, hub-proxied) — we never prefix with BASE_URL.
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/admin/agent-token`;
}

/**
 * Returns the cached agent:admin JWT, refreshing it if it's about to expire (or
 * if we don't have one yet). Concurrent callers share the in-flight fetch so a
 * burst of API calls doesn't mint a token each.
 *
 * Returns `null` when the mint fails (no session, network error, malformed
 * body). The SPA renders OPEN, so a failed mint surfaces as an API 401 the
 * caller handles (re-mint + retry, then an error state) — it does NOT hard-
 * redirect, mirroring the daemon HTML pages which tolerate a failed mint.
 */
export async function getAgentToken(): Promise<string | null> {
  const now = Date.now();
  if (cached && cached.expiresAt - now > REFRESH_BUFFER_MS) {
    return cached.token;
  }
  if (inFlight) return inFlight;
  inFlight = fetchToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function fetchToken(): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(tokenEndpoint(), {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "include",
    });
  } catch {
    cached = null;
    return null;
  }
  if (!res.ok) {
    // 401 (no session) / 403 (non-admin) / 5xx — drop the cache and report no
    // token. The API layer surfaces the resulting failure to the operator.
    cached = null;
    return null;
  }
  let body: { token?: string; expires_at?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    cached = null;
    return null;
  }
  if (!body.token) {
    cached = null;
    return null;
  }
  const expiresAt = body.expires_at
    ? new Date(body.expires_at).getTime()
    : Date.now() + DEFAULT_TTL_MS;
  cached = { token: body.token, expiresAt };
  return body.token;
}

/** Drop the cached token. Useful after an explicit invalidation (e.g. a 401). */
export function clearCachedToken(): void {
  cached = null;
}

/**
 * Mint a one-time SSE TICKET for the browser EventSource streams (agent#25).
 *
 * An `EventSource` can't set an `Authorization` header, so the chat used to put
 * the hub JWT directly in the SSE URL (`?token=<JWT>`) — which leaks the
 * credential into access logs / history / traces. Instead we POST the JWT (as a
 * normal Bearer header — no leak) to `/agent/api/ui/sse-ticket`, which returns a
 * single-use, ≤60s opaque ticket. The caller puts THAT in the SSE URL
 * (`?ticket=<nonce>`); the server consumes it on connect. The ticket is NOT
 * cached — it's single-use, so every connect (and every reconnect) mints a fresh
 * one.
 *
 * Returns the ticket string, or `null` when the mint fails (no session / network
 * / malformed) — the caller (Chat's `openStreams`) then opens no stream, and the
 * usual re-auth-and-retry on SSE error re-mints. Mirrors `getAgentToken`'s
 * tolerant failure shape (the SPA renders OPEN; a failed mint is an error state,
 * not a hard redirect).
 */
export async function getSseTicket(): Promise<string | null> {
  const token = await getAgentToken();
  if (!token) return null;
  let res: Response;
  try {
    res = await fetch(sseTicketEndpoint(), {
      method: "POST",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      credentials: "include",
    });
  } catch {
    return null;
  }
  if (res.status === 401) {
    // 401 = the cached JWT was stale/expired — drop it, re-mint once, retry. (A
    // 403 means the token lacks agent:read; a fresh fetch wouldn't fix that, so we
    // DON'T retry it — it falls through to the `!res.ok → null` below.)
    clearCachedToken();
    const fresh = await getAgentToken();
    if (!fresh) return null;
    try {
      res = await fetch(sseTicketEndpoint(), {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${fresh}` },
        credentials: "include",
      });
    } catch {
      return null;
    }
  }
  if (!res.ok) return null;
  let body: { ticket?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return null;
  }
  return body.ticket ?? null;
}

/**
 * The SSE-ticket mint endpoint — under the AGENT module mount (`/agent/api/...`),
 * NOT the hub origin root like the token mint. Derived from the SPA base the same
 * way `lib/api.ts:apiBase` does (`/agent/app/` → `/agent/api`), falling back to
 * the canonical path in stand-alone dev (the vite proxy forwards it).
 */
function sseTicketEndpoint(): string {
  const base = import.meta.env.BASE_URL || "/";
  const m = base.match(/^(.*\/)app\/?$/);
  const apiBase = m ? `${m[1]}api` : "/agent/api";
  return `${apiBase}/ui/sse-ticket`;
}

/** Test seam: replace the cached token directly. */
export function _setCachedTokenForTest(token: string, expiresAt: number): void {
  cached = { token, expiresAt };
}
