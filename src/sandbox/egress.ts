/**
 * Network egress composition (design §3.3, §4.4).
 *
 * Egress is the load-bearing control for a session fed foreign-authored channel
 * input: every allowlisted host is an exfiltration path, not just a fetch path.
 * So the policy is:
 *
 *   - DENY all egress by default (the sandbox-runtime's `allowedDomains: []`
 *     means no network — see its README "Network Isolation (allow-only)").
 *   - A NON-REMOVABLE BASE allowlist of `{ the Anthropic API host(s), the
 *     hub/vault origin }` is ALWAYS included — what every arm needs to think and
 *     to do its scoped work.
 *   - The spec's `egress[]` is ADDITIVE only. A spec cannot drop the base or
 *     override it away; it can only widen with hosts of its own.
 *
 * The base is anchored in code, not config, precisely so a spec (which may be
 * generated from foreign-influenced input down the line) can never quietly strip
 * the host's own control-plane reachability or — worse — replace the Anthropic
 * host with an attacker endpoint.
 */

/**
 * The Anthropic API hosts every arm needs to reach to run `claude`. Includes the
 * wildcard so regional/edge subdomains resolve; the bare apex covers the canonical
 * host. Held in code as part of the non-removable base.
 */
export const ANTHROPIC_EGRESS_HOSTS: readonly string[] = [
  "api.anthropic.com",
  "*.anthropic.com",
] as const;

/** A hostname (no scheme/port/path) extracted from an origin or passed through. */
export type EgressHost = string;

/**
 * Reduce an origin (`https://host:port`) or a bare host to the hostname the
 * sandbox-runtime allowlist matches on. The runtime matches on domain, not
 * scheme or port, so we strip both. A bare hostname passes through unchanged.
 * Returns null for an unparseable/empty input (callers skip nulls).
 */
export function hostFromOrigin(originOrHost: string | undefined | null): EgressHost | null {
  if (!originOrHost) return null;
  const trimmed = originOrHost.trim();
  if (trimmed.length === 0) return null;
  // If it parses as a URL, take its hostname. Otherwise treat the whole thing as
  // a host (possibly with a :port we strip).
  try {
    const u = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const h = u.hostname;
    return h.length > 0 ? h : null;
  } catch {
    const noPort = trimmed.replace(/:\d+$/, "");
    return noPort.length > 0 ? noPort : null;
  }
}

export interface EgressBaseInput {
  /**
   * The hub origin (also the vault origin in the co-located deploy — the vault is
   * reached under the hub's path-proxy). Origin or bare host; reduced to a host.
   */
  hubOrigin: string;
  /**
   * Optional distinct vault origin, if the vault is reached at a different host
   * than the hub. Usually omitted (co-located). Origin or bare host.
   */
  vaultOrigin?: string;
  /**
   * Override the Anthropic hosts (tests). Defaults to {@link ANTHROPIC_EGRESS_HOSTS}.
   */
  anthropicHosts?: readonly string[];
}

/**
 * Build the NON-REMOVABLE base egress allowlist: the Anthropic API host(s) plus
 * the hub/vault origin host(s). This is what every arm gets regardless of spec.
 * Deduped, loopback/local hosts preserved (a co-located dev hub is loopback).
 */
export function baseEgressAllowlist(input: EgressBaseInput): EgressHost[] {
  const anthropic = input.anthropicHosts ?? ANTHROPIC_EGRESS_HOSTS;
  const hosts: EgressHost[] = [...anthropic];
  const hub = hostFromOrigin(input.hubOrigin);
  if (hub) hosts.push(hub);
  const vault = hostFromOrigin(input.vaultOrigin);
  if (vault) hosts.push(vault);
  return dedupePreserveOrder(hosts);
}

/**
 * Compose the final egress allowlist: the non-removable base UNIONED with the
 * spec's additive `egress[]`. The base is always present and always first; spec
 * hosts are appended. Because we recompute the base from code on every call and
 * union (never start from the spec), a spec that tries to omit or "override" the
 * base still gets it — the contract the test in egress.test.ts pins.
 *
 * Each spec host is normalized through {@link hostFromOrigin} so an arm may
 * declare either bare hosts (`registry.npmjs.org`) or full origins
 * (`https://registry.npmjs.org`) and they land the same.
 */
export function composeEgressAllowlist(
  base: EgressBaseInput,
  specEgress: readonly string[] | undefined,
): EgressHost[] {
  const baseHosts = baseEgressAllowlist(base);
  const additions: EgressHost[] = [];
  for (const e of specEgress ?? []) {
    const h = hostFromOrigin(e);
    if (h) additions.push(h);
  }
  return dedupePreserveOrder([...baseHosts, ...additions]);
}

function dedupePreserveOrder(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
