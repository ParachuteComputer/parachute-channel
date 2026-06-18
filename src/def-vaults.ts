/**
 * Def-vault binding/config — which vault(s) the module reads `#agent/definition`
 * notes from, and the token it uses (design `2026-06-17-vault-native-agents.md`,
 * Phase 4a "Commit 3").
 *
 * Modelled on `channels.json`: a small JSON file in the agent state dir
 * (`agent-vaults.json`) holding a LIST of def-vaults. The architecture is a list
 * (NOT single-vault) so opening up multi-vault later is appending an entry, not a
 * refactor (design "Decided: multi-vault — any vault can define agents"). It
 * DEFAULTS to a single entry for the local `default` vault when no file exists.
 *
 * The token is a `vault:<name>:write` hub JWT — read (query the defs) + write (stamp
 * the `status` field + the agents' message/job notes). For the default local vault,
 * when the file carries no token we MINT one at boot the same way channels/jobs get
 * theirs (`mint-token.ts`, attenuated to the operator bearer). PER-VAULT SCOPING
 * (load-bearing, 4a): the token is scoped to its own vault only — an agent defined in
 * vault X reaches only X. The file is read 0600 (it can carry a token).
 *
 * This path is ADDITIVE to `channels.json` — both coexist. channels.json defines
 * channels the old way; def-vaults define vault-native agents. Neither replaces the
 * other.
 */

import { readFileSync, existsSync, writeFileSync, chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { defaultStateDir } from "./registry.ts";
import { mintScopedToken, vaultScope, MintError } from "./mint-token.ts";
import type { DefVaultBinding } from "./agent-defs.ts";

/** The local vault every install has by default — the design's `default` vault. */
export const DEFAULT_DEF_VAULT_NAME = "default";
/** The loopback vault REST origin (the local vault daemon). */
export const DEFAULT_DEF_VAULT_URL = "http://127.0.0.1:1940";
/** The loopback HUB origin (the mint-token endpoint lives on the hub, NOT the vault). */
export const DEFAULT_HUB_ORIGIN = "http://127.0.0.1:1939";

/** The on-disk shape of `agent-vaults.json`. */
export interface DefVaultsFile {
  /** The def-vaults this install reads agent definitions from (default: one). */
  vaults: DefVaultBinding[];
}

/** Absolute path to `agent-vaults.json` in a state dir. */
export function defVaultsFilePath(stateDir?: string): string {
  return join(stateDir ?? defaultStateDir(), "agent-vaults.json");
}

/**
 * Read `agent-vaults.json` as a plain {@link DefVaultsFile}. Returns null if the
 * file is absent (the caller then applies the single-`default` default). Throws on a
 * malformed file (a present-but-broken config is an operator error worth surfacing,
 * not silently defaulting away).
 */
export function readDefVaultsFile(stateDir?: string): DefVaultsFile | null {
  const file = defVaultsFilePath(stateDir);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as DefVaultsFile;
  if (!parsed || !Array.isArray(parsed.vaults)) {
    throw new Error(`def-vaults: ${file} must have a "vaults" array`);
  }
  for (const v of parsed.vaults) {
    if (!v || typeof v.vault !== "string" || v.vault.length === 0) {
      throw new Error(`def-vaults: each entry needs a non-empty "vault" (got ${JSON.stringify(v)})`);
    }
  }
  return parsed;
}

/**
 * Persist `agent-vaults.json` (0600 — it can carry a token). Creates the state dir
 * if needed. Used to materialize the default config after a boot mint so a restart
 * reuses the same binding instead of re-minting.
 */
export function writeDefVaultsFile(file: DefVaultsFile, stateDir?: string): void {
  const dir = stateDir ?? defaultStateDir();
  mkdirSync(dir, { recursive: true });
  const path = defVaultsFilePath(dir);
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Wiring for the boot resolve (injected for tests — no real hub/mint/fs). */
export interface ResolveDefVaultsDeps {
  /** Agent state dir (default: the resolved state dir). */
  stateDir?: string;
  /** Hub origin for the default-vault token mint. */
  hubOrigin?: string;
  /** The operator bearer the default-vault mint is attenuated against. null = no mint. */
  managerBearer?: string | null;
  /** fetch override for the mint client (tests). */
  fetchFn?: typeof fetch;
  /** Persist the minted default config back to disk so a restart reuses it. Default true. */
  persist?: boolean;
}

/**
 * Resolve the def-vault bindings for this install. Order:
 *
 *   1. `agent-vaults.json` present → use its entries verbatim (each carries its own
 *      token). This is the multi-vault + explicit-token path.
 *   2. Absent → the SINGLE-`default` default: a binding for the local `default`
 *      vault. If a `managerBearer` is available, MINT a `vault:default:write` token
 *      (attenuated to the operator bearer) and — when `persist` — write the resulting
 *      config so a restart reuses it (no re-mint). With no manager bearer (hub not
 *      provisioned yet), we return NO bindings (the module starts idle on the
 *      vault-native path; channels.json still works) rather than a tokenless binding
 *      that would 401 on every query.
 *
 * Returns the bindings to hand the {@link AgentDefRegistry}. Best-effort on the mint:
 * a mint failure is logged + yields no bindings (don't crash boot — the channels.json
 * path is unaffected).
 */
export async function resolveDefVaults(deps: ResolveDefVaultsDeps = {}): Promise<DefVaultBinding[]> {
  const stateDir = deps.stateDir ?? defaultStateDir();

  // 1. Explicit config file wins.
  const file = readDefVaultsFile(stateDir);
  if (file) {
    return file.vaults.map((v) => ({
      vault: v.vault,
      ...(v.vaultUrl ? { vaultUrl: v.vaultUrl } : {}),
      token: v.token,
    }));
  }

  // 2. Default: the local `default` vault. Mint its write token if we can.
  if (!deps.managerBearer) {
    console.warn(
      "agent-defs: no operator token — skipping the default def-vault (the vault-native " +
        "agent path is idle until the hub is provisioned; channels.json is unaffected).",
    );
    return [];
  }
  let token: string;
  try {
    const minted = await mintScopedToken(
      { scope: vaultScope(DEFAULT_DEF_VAULT_NAME, "write") },
      {
        hubOrigin: deps.hubOrigin ?? DEFAULT_HUB_ORIGIN,
        managerBearer: deps.managerBearer,
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      },
    );
    token = minted.token;
  } catch (err) {
    const detail = err instanceof MintError ? err.message : (err as Error).message;
    console.error(`agent-defs: minting the default def-vault token failed (continuing): ${detail}`);
    return [];
  }

  const binding: DefVaultBinding = {
    vault: DEFAULT_DEF_VAULT_NAME,
    vaultUrl: DEFAULT_DEF_VAULT_URL,
    token,
  };
  // Materialize the config so a restart reuses this binding (no re-mint each boot).
  if (deps.persist !== false) {
    try {
      writeDefVaultsFile({ vaults: [binding] }, stateDir);
    } catch (err) {
      console.warn(`agent-defs: persisting the default def-vault config failed (continuing): ${(err as Error).message}`);
    }
  }
  return [binding];
}
