import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  resolveChannelEntries,
  instantiateTransport,
  loadRegistry,
  defaultStateDir,
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

describe("no env synthesis — channels are always explicit", () => {
  test("no channels.json + TELEGRAM_BOT_TOKEN set → [] (env is NOT a token source)", () => {
    process.env.TELEGRAM_BOT_TOKEN = "dummy-token";
    const entries = resolveChannelEntries({ stateDir: dir, loadEnv: false });
    expect(entries).toEqual([]);
  });

  test("no channels.json + token only in state-dir .env → still [] after loadEnv", () => {
    // .env is still loaded (generic vars may live there), but a TELEGRAM_BOT_TOKEN
    // there no longer synthesizes a channel — per-channel config is required.
    writeFileSync(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=from-env-file\n");
    const entries = resolveChannelEntries({ stateDir: dir, loadEnv: true });
    expect(entries).toEqual([]);
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

  test("telegram entry with no token errors clearly (names the channel)", () => {
    const entry: ChannelEntry = { name: "t", transport: "telegram" };
    expect(() => instantiateTransport(entry)).toThrow(
      /telegram channel t requires a per-channel bot token/,
    );
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

// ===========================================================================
// defaultStateDir — channel→agent rename + back-compat resolution.
//
// Resolution order (registry.ts):
//   1. PARACHUTE_AGENT_STATE_DIR env → legacy PARACHUTE_CHANNEL_STATE_DIR (via
//      env-compat.agentEnv) — explicit override.
//   2. ~/.parachute/agent (the NEW default) if it exists.
//   3. Back-compat: ~/.parachute/channel (legacy) if it exists and agent does not.
//   4. ~/.parachute/agent (the new default) when neither exists.
//
// `defaultStateDir(home?)` takes an injectable home so we exercise the
// home-dir-default + legacy-fallback branches against a throwaway dir WITHOUT a
// process-wide `mock.module("os")` — which would leak a faked `homedir()` into
// other test files (it broke the live-Seatbelt path-confinement tests when an
// earlier version did exactly that).
// ===========================================================================

describe("defaultStateDir — env override (new + legacy)", () => {
  const savedAgent = process.env.PARACHUTE_AGENT_STATE_DIR;
  const savedChannel = process.env.PARACHUTE_CHANNEL_STATE_DIR;
  afterEach(() => {
    if (savedAgent === undefined) delete process.env.PARACHUTE_AGENT_STATE_DIR;
    else process.env.PARACHUTE_AGENT_STATE_DIR = savedAgent;
    if (savedChannel === undefined) delete process.env.PARACHUTE_CHANNEL_STATE_DIR;
    else process.env.PARACHUTE_CHANNEL_STATE_DIR = savedChannel;
  });

  test("PARACHUTE_AGENT_STATE_DIR (the new var) wins", () => {
    delete process.env.PARACHUTE_CHANNEL_STATE_DIR;
    process.env.PARACHUTE_AGENT_STATE_DIR = "/tmp/explicit-agent-state";
    expect(defaultStateDir()).toBe("/tmp/explicit-agent-state");
  });

  test("back-compat: legacy PARACHUTE_CHANNEL_STATE_DIR is still honored when the new var is unset", () => {
    delete process.env.PARACHUTE_AGENT_STATE_DIR;
    process.env.PARACHUTE_CHANNEL_STATE_DIR = "/tmp/legacy-channel-state";
    expect(defaultStateDir()).toBe("/tmp/legacy-channel-state");
  });

  test("the new PARACHUTE_AGENT_STATE_DIR takes precedence over the legacy one", () => {
    process.env.PARACHUTE_AGENT_STATE_DIR = "/tmp/new-wins";
    process.env.PARACHUTE_CHANNEL_STATE_DIR = "/tmp/legacy-loses";
    expect(defaultStateDir()).toBe("/tmp/new-wins");
  });
});

describe("defaultStateDir — home-dir default + legacy-dir back-compat", () => {
  let home: string;
  const savedAgent = process.env.PARACHUTE_AGENT_STATE_DIR;
  const savedChannel = process.env.PARACHUTE_CHANNEL_STATE_DIR;

  beforeEach(() => {
    // A throwaway HOME passed straight to defaultStateDir(home); no env override so
    // the existence checks drive resolution. No os mock — see the note above.
    home = mkdtempSync(join(tmpdir(), "agent-home-"));
    delete process.env.PARACHUTE_AGENT_STATE_DIR;
    delete process.env.PARACHUTE_CHANNEL_STATE_DIR;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedAgent === undefined) delete process.env.PARACHUTE_AGENT_STATE_DIR;
    else process.env.PARACHUTE_AGENT_STATE_DIR = savedAgent;
    if (savedChannel === undefined) delete process.env.PARACHUTE_CHANNEL_STATE_DIR;
    else process.env.PARACHUTE_CHANNEL_STATE_DIR = savedChannel;
  });

  test("the new default is ~/.parachute/agent when neither dir exists", () => {
    expect(defaultStateDir(home)).toBe(join(home, ".parachute", "agent"));
  });

  test("uses the new ~/.parachute/agent when it exists", () => {
    mkdirSync(join(home, ".parachute", "agent"), { recursive: true });
    expect(defaultStateDir(home)).toBe(join(home, ".parachute", "agent"));
  });

  test("back-compat: uses legacy ~/.parachute/channel when ~/.parachute/agent is absent", () => {
    mkdirSync(join(home, ".parachute", "channel"), { recursive: true });
    expect(defaultStateDir(home)).toBe(join(home, ".parachute", "channel"));
  });

  test("the new agent dir wins even when the legacy channel dir also exists", () => {
    mkdirSync(join(home, ".parachute", "agent"), { recursive: true });
    mkdirSync(join(home, ".parachute", "channel"), { recursive: true });
    expect(defaultStateDir(home)).toBe(join(home, ".parachute", "agent"));
  });
});
