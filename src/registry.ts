/**
 * Channel registry.
 *
 * Loads named channels from `channels.json` in the channel state dir and
 * instantiates a Transport per entry. A channel is a name bound to a transport
 * kind plus optional transport config.
 *
 * Every channel is explicit: with no `channels.json` the daemon resolves to
 * zero channels. There is NO daemon-global TELEGRAM_BOT_TOKEN synthesis — each
 * telegram channel carries its own per-channel bot token in its config.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { agentEnv } from "./env-compat.ts";
import type { Transport } from "./transport.ts";
import { TelegramTransport, type TelegramTransportConfig } from "./transports/telegram.ts";
import { HttpUiTransport, type HttpUiTransportConfig } from "./transports/http-ui.ts";
import { VaultTransport, type VaultTransportConfig } from "./transports/vault.ts";

export interface ChannelEntry {
  name: string;
  transport: string;
  config?: Record<string, unknown>;
}

export interface ChannelsFile {
  channels: ChannelEntry[];
}

/** A live channel: its config entry plus the instantiated transport. */
export interface Channel {
  name: string;
  transport: Transport;
  entry: ChannelEntry;
}

/**
 * The agent module's state dir. Resolution, in order:
 *
 *   1. `PARACHUTE_AGENT_STATE_DIR` env → its legacy alias
 *      `PARACHUTE_CHANNEL_STATE_DIR` (via {@link agentEnv}) — the explicit override.
 *   2. The new default `~/.parachute/agent`.
 *   3. **Back-compat:** if `~/.parachute/agent` does NOT exist but the legacy
 *      `~/.parachute/channel` DOES, use the legacy dir — so an operator's existing
 *      config/credentials/sessions keep working with no manual move across the
 *      channel→agent rename. Once `~/.parachute/agent` exists (a fresh install, or
 *      after a manual move) it wins and the legacy dir is ignored.
 *
 * `home` is injectable for tests (default `homedir()`) so the home-dir-default +
 * legacy-fallback branches can be exercised against a throwaway dir WITHOUT a
 * process-wide `mock.module("os")` (which leaks `homedir()` into other test files
 * — it broke the live-Seatbelt path-confinement tests when it did).
 *
 * (Migration `parachute-patterns/migrations/2026-06-17-channel-to-agent.md`.)
 */
export function defaultStateDir(home: string = homedir()): string {
  const explicit = agentEnv("STATE_DIR");
  if (explicit) return explicit;
  const agentDir = join(home, ".parachute", "agent");
  if (existsSync(agentDir)) return agentDir;
  const legacyDir = join(home, ".parachute", "channel");
  if (existsSync(legacyDir)) return legacyDir;
  return agentDir;
}

/**
 * Load the state dir's `.env` into process.env if not already set. Generic —
 * an operator may keep arbitrary vars there (e.g. PARACHUTE_HUB_ORIGIN). The
 * daemon no longer consumes TELEGRAM_BOT_TOKEN; telegram tokens live per-channel
 * in channels.json. Mirrors the original daemon's `.env` loading behavior.
 */
export function loadEnvFile(stateDir: string): void {
  const envFile = join(stateDir, ".env");
  try {
    if (existsSync(envFile)) {
      chmodSync(envFile, 0o600);
      for (const line of readFileSync(envFile, "utf8").split("\n")) {
        const m = line.match(/^(\w+)=(.*)$/);
        if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
      }
    }
  } catch {}
}

/** Instantiate the Transport for a single channel entry. */
export function instantiateTransport(entry: ChannelEntry): Transport {
  switch (entry.transport) {
    case "telegram":
      // Thread the channel name in so a missing-token error names the channel.
      return new TelegramTransport({
        ...(entry.config ?? {}),
        name: entry.name,
      } as TelegramTransportConfig);
    case "http-ui":
      // http-ui needs no secret — just a channel name (taken from ctx at start).
      return new HttpUiTransport((entry.config ?? {}) as HttpUiTransportConfig);
    case "vault":
      // vault needs vault name + a write token + the inbound-webhook secret.
      return new VaultTransport((entry.config ?? {}) as unknown as VaultTransportConfig);
    default:
      throw new Error(
        `registry: unknown transport kind "${entry.transport}" for channel "${entry.name}" ` +
          `(known: telegram, http-ui, vault)`,
      );
  }
}

/**
 * Resolve the channel entries for this install. Reads channels.json if present;
 * otherwise resolves to `[]` (no channels) — explicit per-channel config is
 * required, there is no env-token synthesis.
 *
 * `loadEnv` (default true) still loads the state-dir `.env` for any generic vars
 * an operator keeps there. Tests pass `loadEnv: false` to stay hermetic.
 */
export function resolveChannelEntries(opts: {
  stateDir?: string;
  loadEnv?: boolean;
} = {}): ChannelEntry[] {
  const stateDir = opts.stateDir ?? defaultStateDir();
  if (opts.loadEnv !== false) loadEnvFile(stateDir);

  const channelsFile = join(stateDir, "channels.json");
  if (existsSync(channelsFile)) {
    const parsed = JSON.parse(readFileSync(channelsFile, "utf8")) as ChannelsFile;
    if (!parsed || !Array.isArray(parsed.channels)) {
      throw new Error(`registry: ${channelsFile} must have a "channels" array`);
    }
    for (const entry of parsed.channels) {
      if (!entry.name || !entry.transport) {
        throw new Error(
          `registry: each channel needs "name" and "transport" (got ${JSON.stringify(entry)})`,
        );
      }
    }
    return parsed.channels;
  }

  // No channels.json → no channels. Explicit per-channel config is now
  // required; there is no daemon-global TELEGRAM_BOT_TOKEN synthesis. Each
  // telegram channel carries its OWN bot token in channels.json (created via
  // the admin UI), so the daemon never depends on a global env token.
  return [];
}

/** Absolute path to the channels.json registry file in a state dir. */
export function channelsFilePath(stateDir?: string): string {
  return join(stateDir ?? defaultStateDir(), "channels.json");
}

/**
 * Read the channels.json registry as a plain `ChannelsFile`, WITHOUT
 * instantiating transports or synthesizing the telegram fallback. Returns an
 * empty `{ channels: [] }` if the file is absent. Used by the config-management
 * API to read-modify-write the file while the daemon holds the live channels.
 */
export function readChannelsFile(stateDir?: string): ChannelsFile {
  const file = channelsFilePath(stateDir);
  if (!existsSync(file)) return { channels: [] };
  const parsed = JSON.parse(readFileSync(file, "utf8")) as ChannelsFile;
  if (!parsed || !Array.isArray(parsed.channels)) {
    throw new Error(`registry: ${file} must have a "channels" array`);
  }
  return parsed;
}

/**
 * Upsert a channel entry into channels.json (preserving every other entry) and
 * write it back with 0600 perms — the file holds transport tokens/secrets. If an
 * entry with the same name exists it's REPLACED in place (same position);
 * otherwise the new entry is appended. Creates the state dir if needed. Returns
 * the persisted file contents.
 */
export function upsertChannelEntry(entry: ChannelEntry, stateDir?: string): ChannelsFile {
  const dir = stateDir ?? defaultStateDir();
  mkdirSync(dir, { recursive: true });
  const file = channelsFilePath(dir);
  const current = readChannelsFile(dir);
  const idx = current.channels.findIndex((c) => c.name === entry.name);
  if (idx >= 0) current.channels[idx] = entry;
  else current.channels.push(entry);
  writeFileSync(file, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync's mode only applies on CREATE; chmod unconditionally so an
  // existing file (created before this code, or with a looser umask) is tightened.
  chmodSync(file, 0o600);
  return current;
}

/**
 * Remove a channel entry from channels.json by name, preserving the rest. Returns
 * the persisted file contents, or null if the file didn't exist. A no-op (name
 * absent) still rewrites the file (idempotent) when the file exists.
 */
export function removeChannelEntry(name: string, stateDir?: string): ChannelsFile | null {
  const dir = stateDir ?? defaultStateDir();
  const file = channelsFilePath(dir);
  if (!existsSync(file)) return null;
  const current = readChannelsFile(dir);
  current.channels = current.channels.filter((c) => c.name !== name);
  writeFileSync(file, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return current;
}

/**
 * Build the live channel map: resolve entries, instantiate each transport.
 * Throws if an entry names an unknown transport kind.
 */
export function loadRegistry(opts: {
  stateDir?: string;
  loadEnv?: boolean;
} = {}): Map<string, Channel> {
  const entries = resolveChannelEntries(opts);
  const channels = new Map<string, Channel>();
  for (const entry of entries) {
    if (channels.has(entry.name)) {
      throw new Error(`registry: duplicate channel name "${entry.name}"`);
    }
    channels.set(entry.name, {
      name: entry.name,
      transport: instantiateTransport(entry),
      entry,
    });
  }
  return channels;
}
