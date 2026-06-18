/**
 * Unit tests for the def-vault config (design 2026-06-17-vault-native-agents,
 * Phase 4a "Commit 3"). Sandboxed to a throwaway state dir (NEVER the operator's
 * ~/.parachute); the mint is driven by an injected fetch — deterministic, no real hub.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readDefVaultsFile,
  writeDefVaultsFile,
  defVaultsFilePath,
  resolveDefVaults,
  DEFAULT_DEF_VAULT_NAME,
} from "./def-vaults.ts";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "agent-defvaults-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake hub mint endpoint returning a scripted token. */
function fakeMint(token: string): { fetchFn: typeof fetch; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ token, jti: "j", expires_at: "", scope: "vault:default:write" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("agent-vaults.json read/write", () => {
  test("readDefVaultsFile returns null when absent", () => {
    expect(readDefVaultsFile(freshDir())).toBeNull();
  });

  test("write then read round-trips; file is 0600", () => {
    const dir = freshDir();
    writeDefVaultsFile({ vaults: [{ vault: "default", vaultUrl: "http://x", token: "t" }] }, dir);
    const back = readDefVaultsFile(dir);
    expect(back?.vaults).toEqual([{ vault: "default", vaultUrl: "http://x", token: "t" }]);
    const mode = statSync(defVaultsFilePath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("a malformed file throws (operator error, not silently defaulted)", () => {
    const dir = freshDir();
    writeFileSync(defVaultsFilePath(dir), JSON.stringify({ nope: true }));
    expect(() => readDefVaultsFile(dir)).toThrow(/"vaults" array/);
  });

  test("an entry missing vault throws", () => {
    const dir = freshDir();
    writeFileSync(defVaultsFilePath(dir), JSON.stringify({ vaults: [{ token: "t" }] }));
    expect(() => readDefVaultsFile(dir)).toThrow(/non-empty "vault"/);
  });
});

describe("resolveDefVaults", () => {
  test("explicit agent-vaults.json wins (multi-vault, verbatim tokens, no mint)", async () => {
    const dir = freshDir();
    writeDefVaultsFile(
      {
        vaults: [
          { vault: "default", vaultUrl: "http://127.0.0.1:1940", token: "tok-default" },
          { vault: "research", vaultUrl: "http://127.0.0.1:1940", token: "tok-research" },
        ],
      },
      dir,
    );
    const { fetchFn, calls } = fakeMint("SHOULD-NOT-BE-USED");
    const bindings = await resolveDefVaults({ stateDir: dir, managerBearer: "op", fetchFn });
    expect(bindings.map((b) => b.vault)).toEqual(["default", "research"]);
    expect(bindings[0]!.token).toBe("tok-default");
    expect(bindings[1]!.token).toBe("tok-research");
    // No mint when the file carries tokens.
    expect(calls).toHaveLength(0);
  });

  test("no file + a manager bearer → mints a default vault:default:write token + persists", async () => {
    const dir = freshDir();
    const { fetchFn, calls } = fakeMint("minted-token");
    const bindings = await resolveDefVaults({
      stateDir: dir,
      hubOrigin: "http://127.0.0.1:1939",
      managerBearer: "operator-bearer",
      fetchFn,
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ vault: DEFAULT_DEF_VAULT_NAME, token: "minted-token" });
    // Minted with the vault:default:write scope, attenuated to the operator bearer.
    expect(calls[0]!.scope).toBe("vault:default:write");
    // Persisted so a restart reuses it (no re-mint).
    expect(existsSync(defVaultsFilePath(dir))).toBe(true);
    const persisted = readDefVaultsFile(dir);
    expect(persisted?.vaults[0]!.token).toBe("minted-token");
  });

  test("persist:false → mints but does NOT write the file", async () => {
    const dir = freshDir();
    const { fetchFn } = fakeMint("minted");
    const bindings = await resolveDefVaults({
      stateDir: dir,
      managerBearer: "op",
      fetchFn,
      persist: false,
    });
    expect(bindings).toHaveLength(1);
    expect(existsSync(defVaultsFilePath(dir))).toBe(false);
  });

  test("no file + no manager bearer → NO bindings (vault-native path idle; channels.json unaffected)", async () => {
    const bindings = await resolveDefVaults({ stateDir: freshDir(), managerBearer: null });
    expect(bindings).toEqual([]);
  });

  test("a mint failure → no bindings (best-effort; boot is not crashed)", async () => {
    const dir = freshDir();
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "invalid_scope" }), { status: 400 })) as unknown as typeof fetch;
    const bindings = await resolveDefVaults({ stateDir: dir, managerBearer: "op", fetchFn });
    expect(bindings).toEqual([]);
    // Nothing persisted on a failed mint.
    expect(existsSync(defVaultsFilePath(dir))).toBe(false);
  });
});
