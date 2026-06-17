/**
 * Env-var back-compat shim for the channel → agent rename
 * (migration `parachute-patterns/migrations/2026-06-17-channel-to-agent.md`).
 *
 * The module's wire env vars moved from the `PARACHUTE_CHANNEL_*` prefix to
 * `PARACHUTE_AGENT_*`. To keep an operator's existing config/launchers working
 * across the cutover with no manual edit, every wire-var READ goes through
 * {@link agentEnv}: it prefers the NEW `PARACHUTE_AGENT_<key>` and FALLS BACK to
 * the old `PARACHUTE_CHANNEL_<key>` when the new one is unset/empty.
 *
 * Scope: the FOUR wire vars only — `URL`, `STATE_DIR`, `TOKEN`, `PORT`. The
 * DOMAIN var `PARACHUTE_CHANNEL_NAME` (which channel a bridge subscribes to) is
 * NOT renamed — the "channel" concept (a named messaging endpoint) survives the
 * rename; only the module identity moved. So `NAME` stays `PARACHUTE_CHANNEL_NAME`
 * and never routes through here.
 *
 * The fallback is the transitional path; a later contract cycle can drop the old
 * prefix once every launcher/config has migrated.
 */

/** The wire env-var suffixes that gained an `AGENT` alias (old `CHANNEL` prefix still read). */
export type AgentEnvKey = "URL" | "STATE_DIR" | "TOKEN" | "PORT";

/**
 * Resolve a wire env var, preferring `PARACHUTE_AGENT_<key>` and falling back to
 * the legacy `PARACHUTE_CHANNEL_<key>`. Returns `undefined` when neither is set
 * (an empty string counts as unset, so a blank new var still falls through to a
 * meaningful old one). `env` is injectable for tests.
 */
export function agentEnv(
  key: AgentEnvKey,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const next = env[`PARACHUTE_AGENT_${key}`];
  if (next !== undefined && next !== "") return next;
  const legacy = env[`PARACHUTE_CHANNEL_${key}`];
  if (legacy !== undefined && legacy !== "") return legacy;
  return undefined;
}
