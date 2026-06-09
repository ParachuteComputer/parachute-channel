/**
 * Hub-issued JWT validation. parachute-channel as a resource server: it trusts
 * tokens the hub signs against keys fetched from the hub's
 * `/.well-known/jwks.json`.
 *
 * The trust kernel — JWKS fetch + verify, issuer pin, RFC 7519 string-or-array
 * `aud` handling, revocation — lives in the shared `@openparachute/scope-guard`
 * library so vault, scribe, and channel can't silently drift on the worst place
 * to drift. This file is the channel-side adapter: hub-origin resolution
 * (env-var precedence → expose-state self-heal → loopback fallback), a
 * process-wide guard instance, and re-exports preserving the surface the daemon
 * imports.
 *
 * Audience pin: channel tokens carry `aud: "channel"`. We pass
 * `expectedAudience: "channel"` so a token minted for some other resource
 * (e.g. a vault) can't be replayed against the channel even if it happens to
 * carry channel-shaped scopes. The hub mints `iss: <hub public origin>`, so the
 * resolved hub origin MUST be that public origin for `iss` validation to
 * succeed on an exposed deployment. `PARACHUTE_HUB_ORIGIN` is the explicit
 * contract; when it's unset, `getHubOrigin` self-heals from the hub's persisted
 * `expose-state.json` `hubOrigin` so a manually-relaunched daemon on an exposed
 * box doesn't 401 every token — the loopback fallback is for a co-located,
 * never-exposed dev daemon only.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  createScopeGuard,
  HubJwtError,
  type HubJwtClaims,
  looksLikeJwt,
} from "@openparachute/scope-guard";

const DEFAULT_HUB_LOOPBACK = "http://127.0.0.1:1939";

/**
 * Best-effort read of the hub's persisted public origin from
 * `<root>/expose-state.json` (hub-owned; written by the Tailscale + Cloudflare
 * expose paths). Returns the canonical public origin — preferring the explicit
 * `hubOrigin` field (the URL the hub stamps into token `iss` claims), falling
 * back to synthesizing `https://<canonicalFqdn>` for older state files that
 * predate `hubOrigin`. Returns undefined on any error, when absent, or when the
 * only origin available is loopback (there's nothing to self-heal *to*).
 *
 * `root` is `$PARACHUTE_HOME` if set, otherwise `~/.parachute` — re-derived
 * per-call so tests that flip `PARACHUTE_HOME` (and sandboxed/e2e daemons) see
 * the override rather than a value frozen at import. Mirrors hub's own
 * `publicOriginFromExposeState` (parachute-hub/src/vault-hub-origin-env.ts) and
 * vault's `readExposedFqdn` (parachute-vault/src/mcp-install.ts).
 */
function readExposeStateHubOrigin(): string | undefined {
  try {
    const root = process.env.PARACHUTE_HOME ?? resolve(homedir(), ".parachute");
    const p = resolve(root, "expose-state.json");
    if (!existsSync(p)) return undefined;
    const raw = JSON.parse(readFileSync(p, "utf-8")) as {
      hubOrigin?: string;
      canonicalFqdn?: string;
    };
    const origin =
      raw.hubOrigin ?? (raw.canonicalFqdn ? `https://${raw.canonicalFqdn}` : "");
    const trimmed = origin.replace(/\/$/, "");
    if (!trimmed) return undefined;
    // Never self-heal to a loopback origin — that's the last-resort default, not
    // a public issuer, and persisting it would defeat the env→loopback contract.
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(trimmed)) {
      return undefined;
    }
    return trimmed;
  } catch {
    return undefined;
  }
}

/** The audience channel tokens are minted with; strict-checked on every validate. */
export const CHANNEL_AUDIENCE = "channel" as const;

/**
 * Resolve the hub origin used to fetch JWKS and validate `iss`. Strips a
 * trailing slash so we get a single canonical form.
 *
 * Order: `PARACHUTE_HUB_ORIGIN` env → `expose-state.json` `hubOrigin`
 * (self-heal) → loopback fallback. The env var stays highest precedence (the
 * explicit operator/supervisor contract). The expose-state read is the
 * self-heal: on an exposed deployment the hub mints `iss: <public origin>` and
 * persists that origin to `<root>/expose-state.json`, so a channel daemon
 * started WITHOUT the env (e.g. a manual relaunch) still recovers the hub's
 * real public issuer and validates JWTs — instead of falling straight to
 * loopback and 401'ing EVERY token with `unexpected "iss" claim value`. This
 * mirrors what vault (`chooseHubOrigin`, parachute-vault/src/mcp-install.ts) and
 * hub (`publicOriginFromExposeState`) already do; we used to deliberately skip
 * expose-state, and that's exactly the gap this closes (channel#34). Loopback is
 * the last resort for a co-located, never-exposed dev daemon; we never persist
 * or self-heal *to* loopback. We still don't read `services.json` — the hub is
 * the dispatcher, not a registered service there.
 */
export function getHubOrigin(): string {
  const env = process.env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, "");
  if (env && env.length > 0) return env;
  const exposed = readExposeStateHubOrigin();
  if (exposed) return exposed;
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
