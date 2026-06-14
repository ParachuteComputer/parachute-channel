import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveManifestPath, upsertService, listVaultNames, type ServiceEntry } from "./services-manifest.ts";

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), "pc-manifest-")), "services.json");
}

const CHANNEL: ServiceEntry = {
  name: "parachute-channel",
  port: 1941,
  paths: ["/channel"],
  health: "/health",
  version: "0.1.0",
  displayName: "Channel",
  stripPrefix: true,
};

describe("resolveManifestPath", () => {
  test("honors PARACHUTE_HOME (sandbox for tests/e2e)", () => {
    expect(resolveManifestPath({ PARACHUTE_HOME: "/tmp/sandbox" })).toBe("/tmp/sandbox/services.json");
  });
  test("falls back to HOME/.parachute", () => {
    expect(resolveManifestPath({ HOME: "/home/x" })).toBe("/home/x/.parachute/services.json");
  });
});

describe("upsertService", () => {
  test("creates the manifest with the entry on first write", () => {
    const path = tmp();
    upsertService(CHANNEL, path);
    const m = JSON.parse(readFileSync(path, "utf8"));
    expect(m.services).toHaveLength(1);
    expect(m.services[0].name).toBe("parachute-channel");
    expect(m.services[0].paths).toEqual(["/channel"]);
    expect(m.services[0].stripPrefix).toBe(true);
  });

  test("carries startCmd so the hub supervisor can start/restart/adopt the module (channel#34)", () => {
    const path = tmp();
    upsertService({ ...CHANNEL, startCmd: ["parachute-channel"] }, path);
    const m = JSON.parse(readFileSync(path, "utf8"));
    expect(m.services[0].startCmd).toEqual(["parachute-channel"]);
  });

  test("is idempotent — re-registering the same name does not duplicate", () => {
    const path = tmp();
    upsertService(CHANNEL, path);
    upsertService({ ...CHANNEL, version: "0.1.1" }, path);
    const m = JSON.parse(readFileSync(path, "utf8"));
    expect(m.services).toHaveLength(1);
    expect(m.services[0].version).toBe("0.1.1"); // module wins for fields it owns
  });

  test("merges — preserves hub-stamped fields the module doesn't author", () => {
    const path = tmp();
    // hub stamped installDir onto the row; module re-registers without it.
    writeFileSync(path, JSON.stringify({ services: [{ ...CHANNEL, installDir: "/hub/stamped" }] }));
    upsertService(CHANNEL, path);
    const m = JSON.parse(readFileSync(path, "utf8"));
    expect(m.services[0].installDir).toBe("/hub/stamped");
  });

  test("preserves other modules' entries", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ services: [{ name: "parachute-vault", port: 1940, paths: ["/vault/default"], health: "/vault/default/health", version: "0.5.2" }] }));
    upsertService(CHANNEL, path);
    const m = JSON.parse(readFileSync(path, "utf8"));
    expect(m.services).toHaveLength(2);
    expect(m.services.map((s: ServiceEntry) => s.name).sort()).toEqual(["parachute-channel", "parachute-vault"]);
  });

  test("throws on a malformed manifest rather than clobbering it", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ not_services: true }));
    expect(() => upsertService(CHANNEL, path)).toThrow(/malformed/);
    expect(existsSync(path)).toBe(true); // original left intact
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ not_services: true }); // content untouched
  });
});

describe("listVaultNames", () => {
  test("extracts vault names from the vault module's /vault/<name> paths, default first", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ services: [
      { name: "parachute-vault", port: 1940, paths: ["/vault/boulder", "/vault/default", "/vault/techne"], health: "x", version: "1" },
      { name: "parachute-channel", port: 1941, paths: ["/channel"], health: "x", version: "1" },
    ] }));
    expect(listVaultNames(path)).toEqual(["default", "boulder", "techne"]);
  });

  test("dedupes across services and ignores non-vault paths", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ services: [
      { name: "a", port: 1, paths: ["/vault/x", "/other"], health: "x", version: "1" },
      { name: "b", port: 2, paths: ["/vault/x", "/vault/y"], health: "x", version: "1" },
    ] }));
    expect(listVaultNames(path).sort()).toEqual(["x", "y"]);
  });

  test("returns [] when the manifest is absent or unreadable", () => {
    expect(listVaultNames(join(tmpdir(), "does-not-exist-" + Math.floor(performance.now()), "services.json"))).toEqual([]);
  });
});
