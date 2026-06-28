/**
 * Unit tests for the step-up auth PRIMITIVE (agent#80, `src/step-up.ts`):
 * PIN set/verify (hashed+salted, never plaintext), the step-up token store (TTL +
 * REUSE-within-window), and the brute-force rate-limiter/lockout.
 *
 * These exercise the pure module against a throwaway state dir — no daemon, no hub.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  STEP_UP_PIN_RE,
  isValidPinFormat,
  isStepUpConfigured,
  setStepUpPin,
  verifyStepUpPin,
  stepUpFilePath,
  StepUpPinFormatError,
  mintStepUpToken,
  isStepUpTokenValid,
  revokeStepUpToken,
  _resetStepUpTokensForTest,
  _stepUpTokenCountForTest,
  StepUpRateLimiter,
  stepUpLimiter,
} from "./step-up.ts";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "agent-stepup-"));
  _resetStepUpTokensForTest();
  stepUpLimiter.reset();
});

afterEach(() => {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// PIN format + storage
// ---------------------------------------------------------------------------
describe("PIN format", () => {
  test("accepts 4–12 digits", () => {
    expect(isValidPinFormat("1234")).toBe(true);
    expect(isValidPinFormat("123456789012")).toBe(true);
    expect(STEP_UP_PIN_RE.test("4242")).toBe(true);
  });
  test("rejects too-short / too-long / non-digit / non-string", () => {
    expect(isValidPinFormat("123")).toBe(false);
    expect(isValidPinFormat("1234567890123")).toBe(false);
    expect(isValidPinFormat("12ab")).toBe(false);
    expect(isValidPinFormat("")).toBe(false);
    expect(isValidPinFormat(1234 as unknown)).toBe(false);
    expect(isValidPinFormat(null)).toBe(false);
  });
});

describe("PIN set / verify", () => {
  test("not configured before any set; configured after", async () => {
    expect(isStepUpConfigured(stateDir)).toBe(false);
    await setStepUpPin("4242", stateDir);
    expect(isStepUpConfigured(stateDir)).toBe(true);
  });

  test("verify succeeds for the right PIN, fails for the wrong PIN", async () => {
    await setStepUpPin("4242", stateDir);
    expect(await verifyStepUpPin("4242", stateDir)).toBe(true);
    expect(await verifyStepUpPin("0000", stateDir)).toBe(false);
  });

  test("verify returns false when no PIN is configured", async () => {
    expect(await verifyStepUpPin("4242", stateDir)).toBe(false);
  });

  test("rotating the PIN: the old PIN stops verifying, the new one works", async () => {
    await setStepUpPin("4242", stateDir);
    await setStepUpPin("9999", stateDir);
    expect(await verifyStepUpPin("4242", stateDir)).toBe(false);
    expect(await verifyStepUpPin("9999", stateDir)).toBe(true);
  });

  test("setStepUpPin rejects a malformed PIN", async () => {
    await expect(setStepUpPin("12", stateDir)).rejects.toBeInstanceOf(StepUpPinFormatError);
    expect(isStepUpConfigured(stateDir)).toBe(false);
  });

  test("the PIN is stored HASHED+SALTED — never plaintext — at 0600", async () => {
    await setStepUpPin("4242", stateDir);
    const path = stepUpFilePath(stateDir);
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf8");
    // The plaintext PIN must NOT appear anywhere in the file.
    expect(raw.includes("4242")).toBe(false);
    // argon2id PHC string marker present (salt embedded).
    expect(raw.includes("$argon2id$")).toBe(true);
    // 0600 perms.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("two sets of the SAME PIN produce DIFFERENT hashes (random salt)", async () => {
    await setStepUpPin("4242", stateDir);
    const first = readFileSync(stepUpFilePath(stateDir), "utf8");
    await setStepUpPin("4242", stateDir);
    const second = readFileSync(stepUpFilePath(stateDir), "utf8");
    expect(first).not.toBe(second);
    // Both still verify.
    expect(await verifyStepUpPin("4242", stateDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step-up token store — TTL + REUSE-within-window
// ---------------------------------------------------------------------------
describe("step-up token", () => {
  test("a freshly minted token is valid", () => {
    const { token } = mintStepUpToken();
    expect(isStepUpTokenValid(token)).toBe(true);
  });

  test("an unknown / null / empty token is invalid", () => {
    expect(isStepUpTokenValid("nope")).toBe(false);
    expect(isStepUpTokenValid(null)).toBe(false);
    expect(isStepUpTokenValid(undefined)).toBe(false);
    expect(isStepUpTokenValid("")).toBe(false);
  });

  test("REUSABLE within its window — repeated checks all pass (unlike a single-use ticket)", () => {
    const { token } = mintStepUpToken();
    expect(isStepUpTokenValid(token)).toBe(true);
    expect(isStepUpTokenValid(token)).toBe(true);
    expect(isStepUpTokenValid(token)).toBe(true);
    // Still in the store (not consumed).
    expect(_stepUpTokenCountForTest()).toBe(1);
  });

  test("expires after its TTL (and is lazily pruned)", () => {
    const { token, expiresAt } = mintStepUpToken(1000);
    // Just before expiry → valid.
    expect(isStepUpTokenValid(token, expiresAt - 1)).toBe(true);
    // At/after expiry → invalid, and pruned.
    expect(isStepUpTokenValid(token, expiresAt)).toBe(false);
    expect(_stepUpTokenCountForTest()).toBe(0);
  });

  test("revoke makes a token immediately invalid", () => {
    const { token } = mintStepUpToken();
    revokeStepUpToken(token);
    expect(isStepUpTokenValid(token)).toBe(false);
  });

  test("the token is an opaque high-entropy nonce (base64url, ≥ 43 chars)", () => {
    const { token } = mintStepUpToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url, no padding
  });

  test("two mints produce distinct tokens", () => {
    const a = mintStepUpToken().token;
    const b = mintStepUpToken().token;
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Rate-limiter / lockout
// ---------------------------------------------------------------------------
describe("step-up rate limiter (lockout)", () => {
  test("allows up to maxAttempts, then locks out with a retry-after", () => {
    const rl = new StepUpRateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(rl.checkAndRecord("k", t0).allowed).toBe(true);
    expect(rl.checkAndRecord("k", t0 + 1).allowed).toBe(true);
    expect(rl.checkAndRecord("k", t0 + 2).allowed).toBe(true);
    const denied = rl.checkAndRecord("k", t0 + 3);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  test("a denied attempt is NOT counted again — the window stays anchored", () => {
    const rl = new StepUpRateLimiter(2, 60_000);
    const t0 = 1_000_000;
    rl.checkAndRecord("k", t0);
    rl.checkAndRecord("k", t0 + 1);
    // Flood of denials shouldn't push the reset further out.
    const d1 = rl.checkAndRecord("k", t0 + 2);
    const d2 = rl.checkAndRecord("k", t0 + 3);
    expect(d1.allowed).toBe(false);
    expect(d2.allowed).toBe(false);
    // Reset is anchored to the FIRST admitted attempt + window.
    expect(d2.retryAfterSeconds).toBe(60);
  });

  test("the window slides — old attempts age out and free the bucket", () => {
    const rl = new StepUpRateLimiter(2, 60_000);
    const t0 = 1_000_000;
    rl.checkAndRecord("k", t0);
    rl.checkAndRecord("k", t0 + 1);
    expect(rl.checkAndRecord("k", t0 + 2).allowed).toBe(false);
    // After the window passes, attempts are admitted again.
    expect(rl.checkAndRecord("k", t0 + 60_001).allowed).toBe(true);
  });

  test("clear() resets a key's bucket (the success path)", () => {
    const rl = new StepUpRateLimiter(2, 60_000);
    const t0 = 1_000_000;
    rl.checkAndRecord("k", t0);
    rl.checkAndRecord("k", t0 + 1);
    expect(rl.checkAndRecord("k", t0 + 2).allowed).toBe(false);
    rl.clear("k");
    expect(rl.checkAndRecord("k", t0 + 3).allowed).toBe(true);
  });

  test("keys are independent", () => {
    const rl = new StepUpRateLimiter(1, 60_000);
    const t0 = 1_000_000;
    expect(rl.checkAndRecord("a", t0).allowed).toBe(true);
    expect(rl.checkAndRecord("a", t0 + 1).allowed).toBe(false);
    // A different key is unaffected.
    expect(rl.checkAndRecord("b", t0 + 2).allowed).toBe(true);
  });
});
