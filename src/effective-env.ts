/**
 * Effective env-var NAME resolution for an agent's `claude -p` turn (operability —
 * agent#audit "see what env a turn runs with"). The operability win: an operator can
 * SEE, names-only, which env vars a programmatic turn will actually run with — the
 * exact view that would have made the `FIREFLIES_API_TOKEN`-vs-`_KEY` mix-up obvious
 * at a glance. NO VALUES, ever — this mirrors the redaction posture of
 * {@link describeChannelEnv} (credentials.ts), which returns names and never secrets.
 *
 * THE THREE SOURCES (each entry is tagged with where it came from):
 *   1. `"default"`        — the operator-level default layer (credentials.json `env.default`).
 *   2. `"channel"`        — the per-agent override layer (`env.channels[<agent>]`; for a
 *                            vault-native agent the channel key == the agent name).
 *   3. `"grant:<service>"`— a service env var that an APPROVED grant WOULD inject at
 *                            spawn (github → `GITHUB_TOKEN`). Derived from the def's
 *                            already-resolved connection list (kind:"service",
 *                            status:"approved") via {@link serviceEnvVar} — NO grant
 *                            MATERIAL is fetched (this is a read endpoint; we list the
 *                            NAMES that would be injected, never the secret token).
 *
 * PRECEDENCE (highest → lowest): channel > default > grant. This mirrors the spawn-time
 * merge exactly:
 *   - {@link resolveChannelEnv} merges `{ ...env.default, ...env.channels[ch] }` — the
 *     channel layer wins over the default on a key collision.
 *   - `buildAgentChildEnv` (spawn-agent.ts) is fed `{ ...grantEnv, ...channelEnv }` (see
 *     the precedence comment in backends/programmatic.ts) — the channel/operator store
 *     wins over a granted-service var on a collision.
 * So a name present in multiple layers resolves to its HIGHEST-precedence source; the
 * shadowed lower-precedence entries are still listed, marked `overridden: true`, so a
 * "default has X but the channel also sets X" is visible.
 *
 * The Claude-auth denylist (`ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` /
 * `CLAUDE_CODE_OAUTH_TOKEN`) never appears here: the env-store setters reject it,
 * `resolveChannelEnv` strips it, and `serviceEnvVar` can never map a grant onto it
 * (the parse-time guard in grants.ts rejects such a service). `describeChannelEnv`
 * surfaces only what the store actually holds, so a denylisted name can't ride in.
 */

import { describeChannelEnv } from "./credentials.ts";
import { serviceEnvVar } from "./grants.ts";

/** Where a resolved env-var NAME came from. `grant:<service>` names the service. */
export type EnvSource = "default" | "channel" | `grant:${string}`;

/** One resolved env-var NAME + its source. NEVER carries a value. */
export interface EffectiveEnvEntry {
  /** The env-var name (e.g. `GITHUB_TOKEN`). Never a value. */
  name: string;
  /** The layer this entry comes from (`default` | `channel` | `grant:<service>`). */
  source: EnvSource;
  /**
   * True when this entry is SHADOWED by a higher-precedence layer that sets the same
   * name — so a lower-precedence "also has X" is visible. Omitted (not `false`) on the
   * winning entry to keep the wire shape lean.
   */
  overridden?: boolean;
}

/** The `GET /api/agents/<name>/env` response shape — NAMES ONLY, never values. */
export interface EffectiveEnvResult {
  /**
   * Every resolved env-var name across the three sources, each tagged. A name set in
   * more than one layer appears ONCE PER LAYER it's set in; the shadowed lower-precedence
   * copies carry `overridden: true`. Sorted by name, then by precedence (winner first).
   */
  env: EffectiveEnvEntry[];
  /**
   * A non-fatal advisory (e.g. the grants layer couldn't be derived because no def is
   * registered for this agent). Omitted when everything resolved cleanly. NEVER an error
   * that 500s the read — the env-store layers always come back.
   */
  note?: string;
}

/** Precedence rank — HIGHER wins. channel > default > grant. */
function rank(source: EnvSource): number {
  if (source === "channel") return 3;
  if (source === "default") return 2;
  return 1; // grant:<service>
}

/**
 * The approved-grant SERVICE env-var names an agent's def WOULD inject at spawn, each
 * tagged `grant:<service>`. Derived purely from the def's ALREADY-RESOLVED connection
 * list (the grant LIST/status the registry resolved at instantiate, echoed on
 * {@link AgentDefDetail.connections}) — we read `connections` filtered to a `service`
 * kind that the hub reports `approved`, and map the target through {@link serviceEnvVar}.
 *
 * NO grant MATERIAL is fetched here: a service grant injects its token under
 * `serviceEnvVar(target)` (grants.ts `resolveInjectedGrants`), so the NAME is fully
 * determined by the service target alone — the secret is irrelevant to a names-only view.
 * Only `kind:"service"` grants inject an env var (vault/mcp grants inject an MCP server,
 * not an env var), so we ignore those.
 */
export function approvedGrantEnvNames(
  connections: ReadonlyArray<{ kind: string; target: string; status: string }> | undefined,
): EffectiveEnvEntry[] {
  if (!connections) return [];
  const out: EffectiveEnvEntry[] = [];
  for (const c of connections) {
    if (c.kind !== "service" || c.status !== "approved") continue;
    out.push({ name: serviceEnvVar(c.target), source: `grant:${c.target}` as EnvSource });
  }
  return out;
}

/**
 * Compose the effective env-var NAME set for an agent from the three sources +
 * precedence/overridden marking. PURE over its inputs (the env-store description + the
 * def's connections) so it's unit-testable without a live hub/vault and never does I/O
 * itself (the route resolves the inputs).
 *
 * `channelEnv` is the env-store description ({@link describeChannelEnv} output);
 * `connections` is the agent's def connections (or undefined when no def is registered —
 * then the grant layer is simply empty, the env-store layers still resolve).
 *
 * Per name, every layer that sets it contributes an entry; the highest-precedence one is
 * the winner (no `overridden`), the rest carry `overridden: true`. Sorted by name, then
 * winner-first within a name.
 */
export function composeEffectiveEnv(
  agent: string,
  channelEnv: { default: string[]; channels: Record<string, string[]> },
  connections: ReadonlyArray<{ kind: string; target: string; status: string }> | undefined,
): EffectiveEnvEntry[] {
  const entries: EffectiveEnvEntry[] = [];
  for (const name of channelEnv.default) entries.push({ name, source: "default" });
  for (const name of channelEnv.channels[agent] ?? []) entries.push({ name, source: "channel" });
  entries.push(...approvedGrantEnvNames(connections));

  // Group by name; within a name, the highest-rank source wins (no `overridden`), the
  // rest are marked shadowed. Stable: a name appears once per layer that sets it.
  const byName = new Map<string, EffectiveEnvEntry[]>();
  for (const e of entries) {
    const arr = byName.get(e.name);
    if (arr) arr.push(e);
    else byName.set(e.name, [e]);
  }
  const result: EffectiveEnvEntry[] = [];
  for (const [, group] of byName) {
    group.sort((a, b) => rank(b.source) - rank(a.source));
    group.forEach((e, i) => {
      result.push(i === 0 ? { name: e.name, source: e.source } : { name: e.name, source: e.source, overridden: true });
    });
  }
  result.sort((a, b) => a.name.localeCompare(b.name) || rank(b.source) - rank(a.source));
  return result;
}

/**
 * Resolve the full {@link EffectiveEnvResult} for an agent — the env-store layers (always
 * available, read fresh from `credentials.json` via {@link describeChannelEnv}) plus the
 * approved-grant service env names derived from the def's connections.
 *
 * RESILIENCE: the env-store layers ALWAYS resolve (a local file read). The grant layer
 * depends on the def being registered — `connections` is undefined when no def is found
 * (agent not vault-native, or the registry is idle); we still return the env-store layers
 * and attach a `note` rather than failing. The grant status itself was already resolved at
 * instantiate (no live hub call here), so a hub outage at READ time can't sink this view —
 * it reflects the last-resolved grant status, names only.
 */
export function resolveEffectiveEnv(
  agent: string,
  opts: {
    /** Override the env-store description (tests). Defaults to {@link describeChannelEnv}. */
    describeEnv?: () => { default: string[]; channels: Record<string, string[]> };
    /** The def's connections (kind/target/status). Undefined → no def registered. */
    connections?: ReadonlyArray<{ kind: string; target: string; status: string }>;
    /** True when a def IS registered for this agent (so an empty grant layer isn't flagged). */
    hasDef: boolean;
  },
): EffectiveEnvResult {
  const channelEnv = (opts.describeEnv ?? describeChannelEnv)();
  const env = composeEffectiveEnv(agent, channelEnv, opts.connections);
  if (!opts.hasDef) {
    return {
      env,
      note:
        `no vault-native #agent/definition found for "${agent}" — showing the env-store layers ` +
        `only (operator default + per-agent override); approved-grant service env names are ` +
        `unavailable without a registered def.`,
    };
  }
  return { env };
}
