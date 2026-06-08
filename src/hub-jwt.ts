/**
 * Hub-issued JWT validation. parachute-channel as a resource server: it trusts
 * tokens the hub signs against keys fetched from the hub's
 * `/.well-known/jwks.json`.
 *
 * The trust kernel — JWKS fetch + verify, issuer pin, RFC 7519 string-or-array
 * `aud` handling, revocation — lives in the shared `@openparachute/scope-guard`
 * library so vault, scribe, and channel can't silently drift on the worst place
 * to drift. This file is the channel-side adapter: hub-origin resolution
 * (env-var precedence + loopback fallback), a process-wide guard instance, and
 * re-exports preserving the surface the daemon imports.
 *
 * Audience pin: channel tokens carry `aud: "channel"`. We pass
 * `expectedAudience: "channel"` so a token minted for some other resource
 * (e.g. a vault) can't be replayed against the channel even if it happens to
 * carry channel-shaped scopes. The hub mints `iss: <hub public origin>`, so
 * `PARACHUTE_HUB_ORIGIN` MUST be set to the hub's *public* origin for `iss`
 * validation to succeed on an exposed deployment — the loopback fallback is for
 * a co-located, never-exposed dev daemon only.
 */
import {
  createScopeGuard,
  HubJwtError,
  type HubJwtClaims,
  looksLikeJwt,
} from "@openparachute/scope-guard";

const DEFAULT_HUB_LOOPBACK = "http://127.0.0.1:1939";

/** The audience channel tokens are minted with; strict-checked on every validate. */
export const CHANNEL_AUDIENCE = "channel" as const;

/**
 * Resolve the hub origin used to fetch JWKS and validate `iss`. Strips a
 * trailing slash so we get a single canonical form.
 *
 * Order: env var → loopback fallback. We deliberately don't read
 * `~/.parachute/services.json` — the hub is the dispatcher, not a registered
 * service in that file. If a deployment exposes the hub on a non-default
 * origin (the normal case once channel is reachable off-box), the env var is
 * the contract — and it MUST be the hub's public origin, because the hub stamps
 * that origin as the token `iss`.
 */
export function getHubOrigin(): string {
  const env = process.env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, "");
  if (env && env.length > 0) return env;
  return DEFAULT_HUB_LOOPBACK;
}

// Process-wide guard. The resolver form lets tests flip `PARACHUTE_HUB_ORIGIN`
// between cases — the lib re-resolves on every `validateHubJwt` and
// `resetJwksCache` call so the env-var change picks up without a restart. The
// JWKS cache (5min/30s defaults) lives inside the guard, shared across requests.
const guard = createScopeGuard({ hubOrigin: () => getHubOrigin() });

/**
 * Verify a presented JWT against the hub's JWKS, pinned to `aud: "channel"`.
 * Throws `HubJwtError` on any failure (bad signature, wrong issuer, wrong
 * audience, expired, missing kid, JWKS unreachable, revoked). On success
 * returns the surfaced claims plus the parsed scope list.
 *
 * Trust pins: `iss` MUST equal the configured hub origin AND `aud` MUST equal
 * `"channel"`. Without those, a token signed by any RSA key — or one minted for
 * another resource — would pass verification.
 */
export async function validateHubJwt(token: string): Promise<HubJwtClaims> {
  return guard.validateHubJwt(token, { expectedAudience: CHANNEL_AUDIENCE });
}

/**
 * Reset the cached JWKS getter. Tests use this to switch origins between cases;
 * production callers shouldn't need it (origin is process-stable).
 */
export function resetJwksCache(): void {
  guard.resetJwksCache();
}

/**
 * Reset the cached revocation list. Tests use this to start from a clean
 * fail-closed state between cases; production callers shouldn't need it (the
 * cache refreshes itself on TTL expiry).
 */
export function resetRevocationCache(): void {
  guard.resetRevocationCache();
}

export { HubJwtError, looksLikeJwt };
export type { HubJwtClaims };
