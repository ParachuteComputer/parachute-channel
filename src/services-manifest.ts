/**
 * Self-registration into `~/.parachute/services.json` on daemon boot.
 *
 * Mirrors `parachute-scribe/src/services-manifest.ts` deliberately — the file
 * shape is the contract between every Parachute module and the hub
 * (`parachute-hub/src/services-manifest.ts` is the canonical reader). Hub reads
 * this to know the module's port, the paths it should reverse-proxy
 * (`/agent/*` over the expose → this daemon on loopback), and the version.
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
 * List the vault instance names installed on this host, from the vault module's
 * registered `paths` (`/vault/<name>` → `<name>`). Used by the agents page's vault
 * picker so an operator chooses from real vaults instead of typing a name blind.
 * Best-effort: returns `[]` if the manifest is absent/unreadable (the picker then
 * falls back to free text). Deduped + sorted; `default` floated first if present.
 */
export function listVaultNames(path: string = resolveManifestPath()): string[] {
  let manifest: ServicesManifest;
  try {
    manifest = readManifest(path);
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const svc of manifest.services) {
    for (const p of svc.paths ?? []) {
      // `paths` are operator-registered route prefixes, not URLs — take the literal
      // segment (no decodeURIComponent: a stray %2F could synthesize a slash-bearing
      // vault name, and real vault names are plain slugs).
      const m = /^\/vault\/([^/]+)/.exec(p);
      if (m && m[1]) names.add(m[1]);
    }
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  // Float "default" to the front — it's the conventional primary vault.
  return sorted.sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : 0));
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
