import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  resolveChannelEntries,
  instantiateTransport,
  loadRegistry,
  type ChannelEntry,
} from "./registry.ts";

let dir: string;
const savedToken = process.env.TELEGRAM_BOT_TOKEN;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "channel-registry-"));
  delete process.env.TELEGRAM_BOT_TOKEN;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
});

describe("default-channel synthesis (back-compat)", () => {
  test("no channels.json + TELEGRAM_BOT_TOKEN set → single default telegram channel", () => {
    process.env.TELEGRAM_BOT_TOKEN = "dummy-token";
    const entries = resolveChannelEntries({ stateDir: dir, loadEnv: false });
    expect(entries).toEqual([{ name: "telegram", transport: "telegram" }]);
  });

  test("no channels.json + token only in state-dir .env → synthesized after loadEnv", () => {
    writeFileSync(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=from-env-file\n");
    const entries = resolveChannelEntries({ stateDir: dir, loadEnv: true });
    expect(entries).toEqual([{ name: "telegram", transport: "telegram" }]);
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("from-env-file");
  });

  test("no channels.json + no token → empty list (caller decides to error)", () => {
    const entries = resolveChannelEntries({ stateDir: dir, loadEnv: false });
    expect(entries).toEqual([]);
  });
});

describe("explicit channels.json parsing", () => {
  test("parses multiple named channels", () => {
    const file = {
      channels: [
        { name: "tele-aaron", transport: "telegram", config: { token: "t1" } },
        { name: "ops", transport: "telegram", config: { token: "t2" } },
      ],
    };
    writeFileSync(join(dir, "channels.json"), JSON.stringify(file));
    const entries = resolveChannelEntries({ stateDir: dir, loadEnv: false });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.name).toBe("tele-aaron");
    expect(entries[1]!.transport).toBe("telegram");
  });

  test("channels.json takes precedence over the token fallback", () => {
    process.env.TELEGRAM_BOT_TOKEN = "dummy";
    writeFileSync(
      join(dir, "channels.json"),
      JSON.stringify({ channels: [{ name: "explicit", transport: "telegram", config: { token: "x" } }] }),
    );
    const entries = resolveChannelEntries({ stateDir: dir, loadEnv: false });
    expect(entries).toEqual([{ name: "explicit", transport: "telegram", config: { token: "x" } }]);
  });

  test("missing 'channels' array throws clearly", () => {
    writeFileSync(join(dir, "channels.json"), JSON.stringify({ nope: true }));
    expect(() => resolveChannelEntries({ stateDir: dir, loadEnv: false })).toThrow(/channels/);
  });

  test("entry missing name or transport throws clearly", () => {
    writeFileSync(join(dir, "channels.json"), JSON.stringify({ channels: [{ name: "x" }] }));
    expect(() => resolveChannelEntries({ stateDir: dir, loadEnv: false })).toThrow(/transport/);
  });
});

describe("instantiateTransport", () => {
  test("telegram entry yields a telegram transport", () => {
    const entry: ChannelEntry = { name: "t", transport: "telegram", config: { token: "tok" } };
    const t = instantiateTransport(entry);
    expect(t.kind).toBe("telegram");
  });

  test("unknown transport kind errors clearly", () => {
    const entry: ChannelEntry = { name: "weird", transport: "carrier-pigeon" };
    expect(() => instantiateTransport(entry)).toThrow(/unknown transport kind "carrier-pigeon"/);
  });

  test("telegram entry with no token errors clearly", () => {
    const entry: ChannelEntry = { name: "t", transport: "telegram" };
    expect(() => instantiateTransport(entry)).toThrow(/token required/);
  });
});

describe("loadRegistry", () => {
  test("builds a live channel map keyed by name", () => {
    writeFileSync(
      join(dir, "channels.json"),
      JSON.stringify({
        channels: [
          { name: "a", transport: "telegram", config: { token: "t1", stateDir: dir } },
          { name: "b", transport: "telegram", config: { token: "t2", stateDir: dir } },
        ],
      }),
    );
    const reg = loadRegistry({ stateDir: dir, loadEnv: false });
    expect([...reg.keys()].sort()).toEqual(["a", "b"]);
    expect(reg.get("a")!.transport.kind).toBe("telegram");
  });

  test("duplicate channel names throw", () => {
    writeFileSync(
      join(dir, "channels.json"),
      JSON.stringify({
        channels: [
          { name: "dup", transport: "telegram", config: { token: "t1", stateDir: dir } },
          { name: "dup", transport: "telegram", config: { token: "t2", stateDir: dir } },
        ],
      }),
    );
    expect(() => loadRegistry({ stateDir: dir, loadEnv: false })).toThrow(/duplicate channel name/);
  });

  test("unknown transport kind surfaces from loadRegistry", () => {
    writeFileSync(
      join(dir, "channels.json"),
      JSON.stringify({ channels: [{ name: "x", transport: "smoke-signal" }] }),
    );
    expect(() => loadRegistry({ stateDir: dir, loadEnv: false })).toThrow(/unknown transport kind/);
  });
});
