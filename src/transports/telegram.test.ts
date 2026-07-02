import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  isAllowedFor,
  loadAccess,
  chunkText,
  TelegramTransport,
  type AccessConfig,
} from "./telegram.ts";
import { ChannelConfigError } from "../transport.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Access control — these cases moved here from the daemon. The policy is now a
// pure function (isAllowedFor) so it's testable without a live connection.
// ---------------------------------------------------------------------------

function access(partial: Partial<AccessConfig>): AccessConfig {
  return { dmPolicy: "allowlist", allowFrom: [], groups: {}, pending: {}, ...partial };
}

describe("isAllowedFor", () => {
  test("open policy allows anyone", () => {
    const a = access({ dmPolicy: "open", allowFrom: [] });
    expect(isAllowedFor(a, 999, 999)).toBe(true);
    expect(isAllowedFor(a, 1, -100)).toBe(true);
  });

  test("allowlist: user in allowFrom is allowed, others denied", () => {
    const a = access({ allowFrom: ["42"] });
    expect(isAllowedFor(a, 42, 42)).toBe(true);
    expect(isAllowedFor(a, 7, 7)).toBe(false);
  });

  test("allowInChats group bypass: any member of an allowlisted group gets in", () => {
    const a = access({ allowFrom: ["42"], allowInChats: ["-100200300"] });
    // A user NOT in allowFrom, posting in the allowlisted group → allowed.
    expect(isAllowedFor(a, 999, "-100200300")).toBe(true);
    // Same user in a different group → denied.
    expect(isAllowedFor(a, 999, "-555")).toBe(false);
  });

  test("allowInChats DM gating: requires BOTH allowFrom AND allowInChats", () => {
    const a = access({ allowFrom: ["42"], allowInChats: ["42"] });
    // user 42 DMing (chat_id === user_id) → both lists include 42 → allowed.
    expect(isAllowedFor(a, 42, 42)).toBe(true);
    // user 42 in a chat NOT in allowInChats → denied.
    expect(isAllowedFor(a, 42, 99)).toBe(false);
    // user not in allowFrom → denied even if chat is listed.
    expect(isAllowedFor(access({ allowFrom: ["1"], allowInChats: ["42"] }), 42, 42)).toBe(false);
  });

  test("allowInChats empty array fails closed for DMs", () => {
    const a = access({ allowFrom: ["42"], allowInChats: [] });
    expect(isAllowedFor(a, 42, 42)).toBe(false);
  });

  test("allowInChats absent → user-allowlist only (back-compat, no per-chat gating)", () => {
    const a = access({ allowFrom: ["42"] });
    expect(isAllowedFor(a, 42, 12345)).toBe(true);
    expect(isAllowedFor(a, 42, undefined)).toBe(true);
  });

  test("allowFrom empty + allowlist policy → fail-closed (denies everyone)", () => {
    const a = access({ dmPolicy: "allowlist", allowFrom: [] });
    expect(isAllowedFor(a, 1, 1)).toBe(false);
    expect(isAllowedFor(a, 42, -100)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

describe("chunkText", () => {
  test("short text → single chunk", () => {
    expect(chunkText("hello", 4096)).toEqual(["hello"]);
  });

  test("long text splits into <=maxLen chunks", () => {
    const text = "a".repeat(10000);
    const chunks = chunkText(text, 4096);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    expect(chunks.join("")).toBe(text);
  });

  test("prefers newline breaks when one is available in the back half", () => {
    const head = "x".repeat(3000);
    const tail = "y".repeat(3000);
    const chunks = chunkText(`${head}\n${tail}`, 4096);
    expect(chunks[0]).toBe(head); // broke at the newline, which it stripped
    expect(chunks[1]).toBe(tail);
  });
});

// ---------------------------------------------------------------------------
// Transport shape
// ---------------------------------------------------------------------------

describe("TelegramTransport", () => {
  test("throws ChannelConfigError when no config.token (no env fallback)", () => {
    // The daemon-global TELEGRAM_BOT_TOKEN fallback is gone — a telegram channel
    // MUST carry its own per-channel token. Even with the env var set, a config
    // without a token throws: the env is never read as a token source.
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    try {
      // (1) no config token, env UNSET → throws.
      delete process.env.TELEGRAM_BOT_TOKEN;
      expect(() => new TelegramTransport({ name: "tele-x" })).toThrow(ChannelConfigError);
      expect(() => new TelegramTransport({ name: "tele-x" })).toThrow(
        /telegram channel tele-x requires a per-channel bot token/,
      );

      // (2) no config token, env SET → STILL throws (env is not a token source).
      process.env.TELEGRAM_BOT_TOKEN = "env-tok";
      expect(() => new TelegramTransport({ name: "tele-x" })).toThrow(ChannelConfigError);
    } finally {
      if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prev;
    }
  });

  test("a per-channel config.token constructs, regardless of the env", () => {
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    try {
      // env UNSET → constructs off the per-channel token.
      delete process.env.TELEGRAM_BOT_TOKEN;
      const perChannel = new TelegramTransport({
        token: "per-channel-tok",
        stateDir: "/tmp/parachute-agent-test-precedence",
      });
      expect(perChannel.kind).toBe("telegram");

      // env SET to a DIFFERENT value → the per-channel token is what's used; the
      // env is irrelevant, construction still succeeds with the config token.
      process.env.TELEGRAM_BOT_TOKEN = "env-tok";
      const withEnvNoise = new TelegramTransport({
        token: "per-channel-tok",
        stateDir: "/tmp/parachute-agent-test-precedence",
      });
      expect(withEnvNoise.kind).toBe("telegram");
    } finally {
      if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prev;
    }
  });

  test("kind is 'telegram' and outbound methods exist", () => {
    const t = new TelegramTransport({ token: "tok", stateDir: "/tmp/parachute-agent-test-telegram" });
    expect(t.kind).toBe("telegram");
    expect(typeof t.reply).toBe("function");
    expect(typeof t.react).toBe("function");
    expect(typeof t.edit).toBe("function");
    expect(typeof t.sendPermission).toBe("function");
    expect(typeof t.download).toBe("function");
  });

  test("reply without a chat_id in meta errors clearly", async () => {
    const t = new TelegramTransport({ token: "tok", stateDir: "/tmp/parachute-agent-test-telegram" });
    await expect(t.reply({ channel: "telegram", text: "hi" })).rejects.toThrow(/chat_id is required/);
  });

  test("sendPermission with no allowlisted users throws ChannelConfigError (→ 400, not 500)", async () => {
    // Fresh state dir → no access.json → default access has empty allowFrom.
    const t = new TelegramTransport({ token: "tok", stateDir: "/tmp/parachute-agent-test-noperm" });
    await expect(
      t.sendPermission({
        channel: "telegram",
        request_id: "abcde",
        tool_name: "Bash",
        description: "run a command",
        input_preview: "ls",
      }),
    ).rejects.toBeInstanceOf(ChannelConfigError);
  });
});

// ---------------------------------------------------------------------------
// loadAccess — asymmetric failure handling: missing file is OPEN (fresh
// install, matches the official plugin's default), but an EXISTING file that
// can't be parsed FAILS CLOSED (allowlist, no users) — a corrupt access.json
// must never silently disable gating the operator configured.
// ---------------------------------------------------------------------------

describe("loadAccess", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-access-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("valid file: parsed config is returned as-is", () => {
    const file = join(dir, "access.json");
    writeFileSync(
      file,
      JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["42"], groups: {}, pending: {} }),
    );
    const access = loadAccess(file);
    expect(access.dmPolicy).toBe("allowlist");
    expect(access.allowFrom).toEqual(["42"]);
    expect(isAllowedFor(access, 42, 42)).toBe(true);
    expect(isAllowedFor(access, 7, 7)).toBe(false);
  });

  test("missing file: open by design (fresh install)", () => {
    const access = loadAccess(join(dir, "access.json"));
    expect(access.dmPolicy).toBe("open");
    expect(access.allowFrom).toEqual([]);
    expect(isAllowedFor(access, 999, 999)).toBe(true);
  });

  test("corrupt file (invalid JSON): FAILS CLOSED — allowlist with no users", () => {
    const file = join(dir, "access.json");
    writeFileSync(file, "{ dmPolicy: open,, this is not json");
    const access = loadAccess(file);
    expect(access.dmPolicy).toBe("allowlist");
    expect(access.allowFrom).toEqual([]);
    // Nobody gets through — including ids that a previous valid file allowed.
    expect(isAllowedFor(access, 42, 42)).toBe(false);
    expect(isAllowedFor(access, 999, -100)).toBe(false);
  });

  test("valid JSON but not an object (null / array / scalar): FAILS CLOSED", () => {
    const file = join(dir, "access.json");
    for (const body of ["null", "[]", '"open"', "42"]) {
      writeFileSync(file, body);
      const access = loadAccess(file);
      expect(access.dmPolicy).toBe("allowlist");
      expect(access.allowFrom).toEqual([]);
      expect(isAllowedFor(access, 42, 42)).toBe(false);
    }
  });

  test("valid JSON object missing/mistyping gating fields: FAILS CLOSED cleanly (no throw downstream)", () => {
    const file = join(dir, "access.json");
    const bad = [
      "{}", // the reviewer's case: object check passes, but no gating fields at all
      '{"dmPolicy":"allowlist"}', // allowFrom missing
      '{"allowFrom":["42"]}', // dmPolicy missing
      '{"dmPolicy":"banana","allowFrom":["42"]}', // dmPolicy outside the union
      '{"dmPolicy":"allowlist","allowFrom":"42"}', // allowFrom not an array
      '{"dmPolicy":"allowlist","allowFrom":[42]}', // allowFrom not strings
      '{"dmPolicy":"allowlist","allowFrom":["42"],"allowInChats":"42"}', // allowInChats mistyped
    ];
    for (const body of bad) {
      writeFileSync(file, body);
      const access = loadAccess(file);
      expect(access.dmPolicy).toBe("allowlist");
      expect(access.allowFrom).toEqual([]);
      // The point of the shape check: isAllowedFor gets a well-formed config
      // and denies cleanly — no raw TypeError for the poll loop to retry on.
      expect(isAllowedFor(access, 42, 42)).toBe(false);
      expect(isAllowedFor(access, 42, -100)).toBe(false);
    }
  });

  test("minimal valid file omitting inert groups/pending loads with {} defaults", () => {
    const file = join(dir, "access.json");
    writeFileSync(file, '{"dmPolicy":"allowlist","allowFrom":["42"]}');
    const access = loadAccess(file);
    expect(access.dmPolicy).toBe("allowlist");
    expect(access.groups).toEqual({});
    expect(access.pending).toEqual({});
    expect(isAllowedFor(access, 42, 42)).toBe(true);
    expect(isAllowedFor(access, 7, 7)).toBe(false);
  });
});
