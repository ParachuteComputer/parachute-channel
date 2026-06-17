/**
 * Hub-issued JWT validation. parachute-agent as a resource server: it trusts
 * tokens the hub signs against keys fetched from the hub's
 * `/.well-known/jwks.json`.
 *
 * The trust kernel — JWKS fetch + verify, issuer pin, RFC 7519 string-or-array
 * `aud` handling, revocation — lives in the shared `@openparachute/scope-guard`
 * library so vault, scribe, and agent can't silently drift on the worst place
 * to drift. This file is the agent-side adapter: hub-origin resolution
 * (env-var precedence → expose-state self-heal → loopback fallback), a
 * process-wide guard instance, and re-exports preserving the surface the daemon
 * imports.
 *
 * Audience pin + DUAL-ACCEPT (channel→agent rename,
 * `parachute-patterns/migrations/2026-06-17-channel-to-agent.md` rule 1). New
 * tokens carry `aud: "agent"`; tokens minted before the rename carry
 * `aud: "channel"`. We must keep both valid until live tokens are re-minted, so
 * instead of pinning a single `expectedAudience` we validate WITHOUT the
 * library's strict-audience check and then assert the surfaced `aud` is in the
 * accepted set {@link ACCEPTED_AUDIENCES}. This preserves the resource-server
 * audience backstop (a token minted for some OTHER resource — e.g. a vault — is
 * still rejected because its `aud` is neither `agent` nor `channel`) while
 * accepting both transitional forms. A later contract cycle drops `channel`.
 * The hub mints `iss: <hub public origin>`, so the resolved hub origin MUST be
 * that public origin for `iss` validation to succeed on an exposed deployment.
 * `PARACHUTE_HUB_ORIGIN` is the explicit contract; when it's unset,
 * `getHubOrigin` self-heals from the hub's persisted `expose-state.json`
 * `hubOrigin` so a manually-relaunched daemon on an exposed box doesn't 401
 * every token — the loopback fallback is for a co-located, never-exposed dev
 * daemon only.
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

/**
 * The audiences this resource server accepts (channel→agent dual-accept). The
 * NEW `agent` form plus the legacy `channel` form. A token whose `aud` is neither
 * — e.g. minted for a vault — is rejected, preserving the per-resource backstop.
 */
export const ACCEPTED_AUDIENCES = ["agent", "channel"] as const;

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

/**
 * The canonical audience new agent tokens are minted with. Kept as a named
 * constant for readers + tests; the actual accept-check uses the dual-accept set
 * {@link ACCEPTED_AUDIENCES} so pre-rename `channel` tokens also validate.
 */
export const AGENT_AUDIENCE = "agent" as const;

/**
 * @deprecated Legacy alias for the pre-rename audience. Retained so existing
 * callers/tests keep compiling; new code reads {@link AGENT_AUDIENCE} or checks
 * {@link ACCEPTED_AUDIENCES}. Both `agent` and `channel` validate during the
 * dual-accept window.
 */
export const CHANNEL_AUDIENCE = "channel" as const;

/**
 * Resolve the hub origin used to fetch JWKS and validate `iss`. Strips a
 * trailing slash so we get a single canonical form.
 *
 * Order: `PARACHUTE_HUB_ORIGIN` env → `expose-state.json` `hubOrigin`
 * (self-heal) → loopback fallback. The env var stays highest precedence (the
 * explicit operator/supervisor contract). The expose-state read is the
 * self-heal: on an exposed deployment the hub mints `iss: <public origin>` and
 * persists that origin to `<root>/expose-state.json`, so an agent daemon
 * started WITHOUT the env (e.g. a manual relaunch) still recovers the hub's
 * real public issuer and validates JWTs — instead of falling straight to
 * loopback and 401'ing EVERY token with `unexpected "iss" claim value`. This
 * mirrors what vault (`chooseHubOrigin`, parachute-vault/src/mcp-install.ts) and
 * hub (`publicOriginFromExposeState`) already do; we used to deliberately skip
 * expose-state, and that's exactly the gap this closes (agent#34). Loopback is
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
 * Verify a presented JWT against the hub's JWKS, accepting `aud: "agent"` OR the
 * legacy `aud: "channel"` (dual-accept transition). Throws `HubJwtError` on any
 * failure (bad signature, wrong issuer, wrong/unaccepted audience, expired,
 * missing kid, JWKS unreachable, revoked). On success returns the surfaced
 * claims plus the parsed scope list.
 *
 * Trust pins: `iss` MUST equal the configured hub origin AND `aud` MUST be in
 * {@link ACCEPTED_AUDIENCES}. Without those, a token signed by any RSA key — or
 * one minted for another resource — would pass verification. We do NOT pass the
 * library's single-value `expectedAudience` (it can't express two accepted
 * values); instead we validate the signature/issuer/revocation with the library,
 * then assert the surfaced `aud` membership here — a `"shape"`-class reject that
 * matches what a strict-audience mismatch would have produced.
 */
export async function validateHubJwt(token: string): Promise<HubJwtClaims> {
  const claims = await guard.validateHubJwt(token);
  if (!claims.aud || !ACCEPTED_AUDIENCES.includes(claims.aud as (typeof ACCEPTED_AUDIENCES)[number])) {
    throw new HubJwtError(
      "audience",
      `unexpected "aud" claim value; this resource accepts ${ACCEPTED_AUDIENCES.map((a) => `"${a}"`).join(" or ")}`,
    );
  }
  return claims;
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
