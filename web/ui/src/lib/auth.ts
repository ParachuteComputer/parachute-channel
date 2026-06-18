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

/** Test seam: replace the cached token directly. */
export function _setCachedTokenForTest(token: string, expiresAt: number): void {
  cached = { token, expiresAt };
}
