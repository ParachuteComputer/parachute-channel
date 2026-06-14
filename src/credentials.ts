/**
 * Per-channel Claude OAuth credential store (design §6).
 *
 * The Claude `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, the documented
 * 1-year headless/CI auth path) is the credential a launched agent session runs
 * on — injected into the sandbox at launch as the session's auth (NEVER
 * `ANTHROPIC_API_KEY`, which would silently route onto API billing; see
 * `spawn-agent.ts`). This module persists that secret, following the SAME
 * file-store discipline `registry.ts` uses for per-channel transport tokens:
 * a read-modify-write JSON file, written 0600 and `chmod`-ed 0600 unconditionally
 * (so an existing file created under a looser umask is tightened on every write).
 *
 * Two principal levels (design §6 — "default one operator token; per-channel
 * override"):
 *
 *   - a **default / operator-level** token, used when a channel has no override,
 *   - a **per-channel override**, the multi-principal seam (multi-user isn't a
 *     rewrite — just populating per-channel, eventually per-principal, tokens).
 *
 * Resolution (`resolveClaudeCredential`): channel override ?? default ?? error.
 *
 * The secret lives in its OWN file (`credentials.json`), separate from
 * `channels.json`: the default/operator token isn't tied to any single channel,
 * and the credential lifecycle (set the operator token once, override per
 * channel) is distinct from the channel-registry lifecycle. The file is
 * NAMESPACED by credential type (`{ claude: { ... } }`) so a future credential
 * type can coexist without a schema migration.
 *
 * Redaction discipline: the raw token is NEVER returned by the listing/inspection
 * helper (`describeClaudeCredentials`) and NEVER logged — exactly the posture the
 * config API + transports already keep for `config.token` / `webhookSecret`.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { defaultStateDir } from "./registry.ts";

/** The Claude-credential slice of the store. */
export interface ClaudeCredentialStore {
  /** Default / operator-level OAuth token, used when a channel has no override. */
  default?: string;
  /** Per-channel overrides, keyed by channel name. */
  channels?: Record<string, string>;
}

/** The on-disk `credentials.json` shape (namespaced by credential type). */
export interface CredentialsFile {
  claude?: ClaudeCredentialStore;
}

/** The default credential reference an unspecified spec resolves against. */
export const DEFAULT_CREDENTIAL_REF = "operator" as const;

/** Absolute path to the credentials.json store in a state dir. */
export function credentialsFilePath(stateDir?: string): string {
  return join(stateDir ?? defaultStateDir(), "credentials.json");
}

/**
 * Read `credentials.json` as a plain `CredentialsFile`. Returns an empty `{}` if
 * the file is absent. Mirrors `registry.readChannelsFile` — the read half of the
 * read-modify-write the setters use.
 */
export function readCredentialsFile(stateDir?: string): CredentialsFile {
  const file = credentialsFilePath(stateDir);
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8")) as CredentialsFile;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`credentials: ${file} must be a JSON object`);
  }
  return parsed;
}

/**
 * Persist the store back to `credentials.json` with 0600 perms — the file holds
 * the Claude OAuth secret. Creates the state dir if needed. `chmod`s 0600
 * unconditionally (writeFileSync's `mode` only applies on CREATE, so an existing
 * file created under a looser umask is tightened on every write) — the exact
 * discipline `registry.upsertChannelEntry` keeps for the secret-bearing
 * channels.json.
 */
function writeCredentialsFile(file: CredentialsFile, stateDir?: string): void {
  const dir = stateDir ?? defaultStateDir();
  mkdirSync(dir, { recursive: true });
  const path = credentialsFilePath(dir);
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Set the default / operator-level Claude OAuth token. Used by any channel that
 * has no per-channel override. Read-modify-write so existing per-channel
 * overrides are preserved.
 */
export function setDefaultClaudeCredential(token: string, stateDir?: string): void {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("credentials: a non-empty token is required");
  }
  const file = readCredentialsFile(stateDir);
  const claude = file.claude ?? {};
  claude.default = token;
  file.claude = claude;
  writeCredentialsFile(file, stateDir);
}

/**
 * Set a per-channel Claude OAuth override. Wins over the default for that channel.
 * Read-modify-write so the default + other channels' overrides are preserved.
 */
export function setChannelClaudeCredential(
  channel: string,
  token: string,
  stateDir?: string,
): void {
  if (typeof channel !== "string" || channel.length === 0) {
    throw new Error("credentials: a channel name is required");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("credentials: a non-empty token is required");
  }
  const file = readCredentialsFile(stateDir);
  const claude = file.claude ?? {};
  const channels = claude.channels ?? {};
  channels[channel] = token;
  claude.channels = channels;
  file.claude = claude;
  writeCredentialsFile(file, stateDir);
}

/**
 * Remove a per-channel override (the channel falls back to the default after
 * this). Returns true if an override existed, false if there was nothing to
 * remove. The default token is untouched.
 */
export function removeChannelClaudeCredential(channel: string, stateDir?: string): boolean {
  const file = readCredentialsFile(stateDir);
  const channels = file.claude?.channels;
  if (!channels || !(channel in channels)) return false;
  delete channels[channel];
  writeCredentialsFile(file, stateDir);
  return true;
}

/** Thrown when neither a per-channel override nor a default token is configured. */
export class CredentialNotConfiguredError extends Error {
  constructor(channel: string) {
    super(
      `no Claude credential for channel "${channel}": set a per-channel override or the ` +
        `default/operator token (POST /api/credentials/claude). Get one with ` +
        `\`claude setup-token\`.`,
    );
    this.name = "CredentialNotConfiguredError";
  }
}

/**
 * Resolve the Claude OAuth token a session on `channel` should run on:
 *
 *   channel override ?? default ?? throw CredentialNotConfiguredError
 *
 * Read at resolve time (not cached) so a token set/rotated via the config API
 * takes effect on the next spawn without a daemon restart — the dynamic-read
 * discipline. Throwing (rather than returning empty) means a misconfigured
 * install fails loud BEFORE a session launches with no auth.
 */
export function resolveClaudeCredential(channel: string, stateDir?: string): string {
  const claude = readCredentialsFile(stateDir).claude;
  const override = claude?.channels?.[channel];
  if (override) return override;
  const fallback = claude?.default;
  if (fallback) return fallback;
  throw new CredentialNotConfiguredError(channel);
}

/**
 * Describe the credential store for an operator-facing read WITHOUT leaking the
 * secret: whether a default is set, and which channels carry an override (names
 * only). The raw token is never returned — same redaction posture the config
 * API keeps for transport tokens. (`GET /api/credentials/claude`.)
 */
export function describeClaudeCredentials(
  stateDir?: string,
): { defaultSet: boolean; channels: string[] } {
  const claude = readCredentialsFile(stateDir).claude;
  return {
    defaultSet: Boolean(claude?.default),
    channels: Object.keys(claude?.channels ?? {}).sort(),
  };
}
