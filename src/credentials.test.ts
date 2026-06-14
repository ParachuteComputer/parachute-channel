/**
 * Per-channel Claude OAuth credential store (design §6).
 *
 * Covers: store/retrieve round-trip, 0600 on the secret file, redaction (the
 * raw token never appears in the inspection helper / serialized output), and
 * default-vs-override resolution (override wins, falls back to default, errors
 * when neither). All hermetic under a throwaway state dir.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  setDefaultClaudeCredential,
  setChannelClaudeCredential,
  removeChannelClaudeCredential,
  resolveClaudeCredential,
  describeClaudeCredentials,
  readCredentialsFile,
  credentialsFilePath,
  CredentialNotConfiguredError,
} from "./credentials.ts";

const DEFAULT_TOKEN = "oat_DEFAULT-OPERATOR-TOKEN-SECRET";
const OVERRIDE_TOKEN = "oat_PER-CHANNEL-OVERRIDE-SECRET";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "channel-creds-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("store / retrieve round-trip", () => {
  test("default token: set then resolve returns it", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    expect(resolveClaudeCredential("any-channel", dir)).toBe(DEFAULT_TOKEN);
  });

  test("per-channel override: set then resolve returns it for that channel", () => {
    setChannelClaudeCredential("aaron-dev", OVERRIDE_TOKEN, dir);
    expect(resolveClaudeCredential("aaron-dev", dir)).toBe(OVERRIDE_TOKEN);
  });

  test("setting one slice preserves the other (read-modify-write)", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    setChannelClaudeCredential("aaron-dev", OVERRIDE_TOKEN, dir);
    setChannelClaudeCredential("ops", "oat_OPS", dir);
    const file = readCredentialsFile(dir);
    expect(file.claude!.default).toBe(DEFAULT_TOKEN);
    expect(file.claude!.channels!["aaron-dev"]).toBe(OVERRIDE_TOKEN);
    expect(file.claude!.channels!["ops"]).toBe("oat_OPS");
  });

  test("empty token is rejected (never persists a blank credential)", () => {
    expect(() => setDefaultClaudeCredential("", dir)).toThrow(/non-empty token/);
    expect(() => setChannelClaudeCredential("c", "", dir)).toThrow(/non-empty token/);
    expect(existsSync(credentialsFilePath(dir))).toBe(false);
  });
});

describe("0600 on the secret file", () => {
  test("the credentials file is written 0600 (holds a secret)", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    const file = credentialsFilePath(dir);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a subsequent write keeps it 0600 (chmod is unconditional)", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    // Loosen perms behind the store's back, then write again → must re-tighten.
    const fs = require("fs") as typeof import("fs");
    fs.chmodSync(credentialsFilePath(dir), 0o644);
    setChannelClaudeCredential("c", OVERRIDE_TOKEN, dir);
    expect(statSync(credentialsFilePath(dir)).mode & 0o777).toBe(0o600);
  });
});

describe("redaction — the raw token never leaks via the inspection helper", () => {
  test("describeClaudeCredentials reports presence + channel names, NOT the token", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    setChannelClaudeCredential("aaron-dev", OVERRIDE_TOKEN, dir);
    setChannelClaudeCredential("ops", "oat_OPS", dir);
    const desc = describeClaudeCredentials(dir);
    expect(desc.defaultSet).toBe(true);
    expect(desc.channels).toEqual(["aaron-dev", "ops"]); // sorted, names only
    const serialized = JSON.stringify(desc);
    expect(serialized).not.toContain(DEFAULT_TOKEN);
    expect(serialized).not.toContain(OVERRIDE_TOKEN);
    expect(serialized).not.toContain("oat_OPS");
  });

  test("describe on an empty store: defaultSet false, no channels", () => {
    const desc = describeClaudeCredentials(dir);
    expect(desc).toEqual({ defaultSet: false, channels: [] });
  });
});

describe("default-vs-override resolution", () => {
  test("override WINS over the default for its channel", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    setChannelClaudeCredential("aaron-dev", OVERRIDE_TOKEN, dir);
    expect(resolveClaudeCredential("aaron-dev", dir)).toBe(OVERRIDE_TOKEN);
    // A different channel with no override falls back to the default.
    expect(resolveClaudeCredential("other", dir)).toBe(DEFAULT_TOKEN);
  });

  test("falls back to the default when the channel has no override", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    expect(resolveClaudeCredential("never-configured", dir)).toBe(DEFAULT_TOKEN);
  });

  test("ERRORS when neither an override nor a default is set", () => {
    expect(() => resolveClaudeCredential("ghost", dir)).toThrow(CredentialNotConfiguredError);
    expect(() => resolveClaudeCredential("ghost", dir)).toThrow(/no Claude credential for channel "ghost"/);
  });

  test("removing an override falls back to the default; removing a missing one is a no-op", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    setChannelClaudeCredential("aaron-dev", OVERRIDE_TOKEN, dir);
    expect(removeChannelClaudeCredential("aaron-dev", dir)).toBe(true);
    expect(resolveClaudeCredential("aaron-dev", dir)).toBe(DEFAULT_TOKEN); // back to default
    expect(removeChannelClaudeCredential("aaron-dev", dir)).toBe(false); // already gone
    // The default is untouched by an override removal.
    expect(readCredentialsFile(dir).claude!.default).toBe(DEFAULT_TOKEN);
  });

  test("resolution is read dynamically — a rotate takes effect on the next resolve", () => {
    setDefaultClaudeCredential(DEFAULT_TOKEN, dir);
    expect(resolveClaudeCredential("c", dir)).toBe(DEFAULT_TOKEN);
    setDefaultClaudeCredential("oat_ROTATED", dir);
    expect(resolveClaudeCredential("c", dir)).toBe("oat_ROTATED");
  });
});
