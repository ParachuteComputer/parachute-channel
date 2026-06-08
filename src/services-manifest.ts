/**
 * Self-registration into `~/.parachute/services.json` on daemon boot.
 *
 * Mirrors `parachute-scribe/src/services-manifest.ts` deliberately — the file
 * shape is the contract between every Parachute module and the hub
 * (`parachute-hub/src/services-manifest.ts` is the canonical reader). Hub reads
 * this to know the module's port, the paths it should reverse-proxy
 * (`/channel/*` over the expose → this daemon on loopback), and the version.
 *
 * Best-effort: any write error is logged + swallowed by the caller. The daemon
 * still serves locally even if registration fails. Honors `PARACHUTE_HOME` so
 * sandboxed/test/e2e daemons never touch the operator's real services.json.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ServiceEntry {
  name: string;
  port: number;
  paths: string[];
  health: string;
  version: string;
  displayName?: string;
  tagline?: string;
  installDir?: string;
  stripPrefix?: boolean;
  /** Hub-stamped fields (e.g. installDir) ride along; the upsert merges. */
  [key: string]: unknown;
}

interface ServicesManifest {
  services: ServiceEntry[];
}

/** Canonical services.json path. Honors PARACHUTE_HOME for sandbox/test runs. */
export function resolveManifestPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.PARACHUTE_HOME ?? join(env.HOME ?? homedir(), ".parachute");
  return join(base, "services.json");
}

function readManifest(path: string): ServicesManifest {
  if (!existsSync(path)) return { services: [] };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { services?: unknown }).services)) {
    throw new Error(`services manifest at ${path} is malformed (missing "services" array)`);
  }
  return raw as ServicesManifest;
}

/**
 * Idempotent upsert of a service entry. Merges into any existing row rather
 * than replacing it — preserves hub-stamped fields the module doesn't own.
 * Atomic write: stages to a tmp file, then renames over the target so a crash
 * mid-write leaves the prior file intact.
 */
export function upsertService(entry: ServiceEntry, path: string = resolveManifestPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const manifest = readManifest(path);
  const idx = manifest.services.findIndex((s) => s.name === entry.name);
  if (idx >= 0) manifest.services[idx] = { ...manifest.services[idx], ...entry };
  else manifest.services.push(entry);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
}
