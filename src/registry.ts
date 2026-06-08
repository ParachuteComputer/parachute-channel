/**
 * Channel registry.
 *
 * Loads named channels from `channels.json` in the channel state dir and
 * instantiates a Transport per entry. A channel is a name bound to a transport
 * kind plus optional transport config.
 *
 * Backwards-compat: if `channels.json` is absent but a Telegram bot token is
 * available (TELEGRAM_BOT_TOKEN env, set directly or loaded from the state-dir
 * `.env`), a single default channel `{ name: "telegram", transport: "telegram" }`
 * is synthesized so existing single-bot installs keep working with zero config.
 */

import { readFileSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
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

export function defaultStateDir(): string {
  return (
    process.env.PARACHUTE_CHANNEL_STATE_DIR ?? join(homedir(), ".parachute", "channel")
  );
}

/**
 * Load TELEGRAM_BOT_TOKEN (and any other vars) from the state dir's `.env` into
 * process.env if not already set. Mirrors the original daemon's behavior.
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
      return new TelegramTransport((entry.config ?? {}) as TelegramTransportConfig);
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
 * otherwise synthesizes a default telegram channel when a token is available.
 *
 * `loadEnv` (default true) loads the state-dir `.env` so the token fallback can
 * see a `.env`-only token. Tests pass `loadEnv: false` to stay hermetic.
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

  // Backwards-compat: no channels.json → synthesize a default telegram channel
  // when a bot token is available.
  if (process.env.TELEGRAM_BOT_TOKEN) {
    return [{ name: "telegram", transport: "telegram" }];
  }

  return [];
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
