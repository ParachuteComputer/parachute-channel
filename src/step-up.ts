/**
 * Step-up auth (PIN) for high-privilege agent-admin actions (agent#80).
 *
 * ## The risk this closes
 *
 * A single authenticated `agent:admin` session (the operator's hub cookie traded
 * for an `agent:admin` Bearer) can today do ANYTHING dangerous with no re-confirm:
 *   - set/rotate credentials (the Claude OAuth token + the generic env store)
 *     → exfiltrate vault / channel / Claude tokens,
 *   - open a TERMINAL → a raw host shell,
 *   - spawn a `filesystem: full` (unsandboxed) agent → read the whole disk.
 * "One session = total control over the operator's vault + tokens."
 *
 * ## The design (mirrors hub's admin-lock PIN, design `2026-06-17-admin-ui-lock.md`)
 *
 * A SECOND factor on top of `agent:admin`: an operator-set PIN, exchanged for a
 * short-lived **step-up token**. The dangerous endpoints require BOTH a valid
 * `agent:admin` Bearer AND a valid step-up token; everything else stays
 * frictionless.
 *
 *   1. **PIN, set once by the operator** (`setStepUpPin`). Stored HASHED + SALTED
 *      (`Bun.password.hash`, argon2id — salt is embedded in the PHC string) in
 *      `~/.parachute/agent/step-up.json`, mode 0600. NEVER plaintext, NEVER logged,
 *      NEVER returned. Setting/changing it requires the current `agent:admin`
 *      session and, if a PIN already exists, the current PIN.
 *   2. **Step-up exchange** (`mintStepUpToken` after `verifyStepUpPin`): an opaque
 *      256-bit CSPRNG nonce, TTL ~5min, held server-side in a TTL'd map. REUSABLE
 *      within its window (unlike the single-use SSE ticket) — one PIN entry buys a
 *      short working window across several gated actions.
 *   3. **Gate** (`requireStepUp` in `auth.ts`): the dangerous endpoints assert a
 *      valid step-up token (header `X-Step-Up-Token`, or `?step_up=` for the
 *      terminal WebSocket which can't set a header) in addition to `agent:admin`.
 *      A missing/expired token → `403 { error: "step_up_required" }`, distinct from
 *      a plain 401 (no/invalid Bearer), so the UI knows to PROMPT vs RE-AUTH.
 *
 * ## Security properties (all load-bearing)
 *
 *   - PIN hashed + salted (argon2id); never logged / returned. The hash never
 *     leaves this module — the only readers are `verifyStepUpPin` + `setStepUpPin`.
 *   - Rate-limited with LOCKOUT ({@link stepUpLimiter}): a compromised `agent:admin`
 *     session can't brute-force the PIN. 5 wrong PINs / 5 min, mirroring hub's
 *     `unlockLimiter`.
 *   - Step-up token: opaque (256-bit nonce), short TTL, SERVER-SIDE only. It NEVER
 *     widens scope — it's a second factor ON TOP of `agent:admin`, never a
 *     substitute. A request still needs its own valid `agent:admin` Bearer.
 *   - No secret in any log: neither the PIN nor the hash nor the token is ever
 *     written to a log line.
 *
 * Process-local in-memory token state by design (mirrors `ui-ticket.ts` + the
 * daemon's other in-process registries). The daemon is single-instance per
 * machine; tokens live ≤5min and are cheap to lose on restart (the UI re-prompts).
 */

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { defaultStateDir } from "./registry.ts";

// ---------------------------------------------------------------------------
// PIN storage (argon2id hash in step-up.json, mode 0600)
// ---------------------------------------------------------------------------

/**
 * PIN format: 4–12 digits. A numeric PIN is the phone-lock affordance (mirrors
 * hub's `ADMIN_LOCK_PIN_RE`). The real defense is the rate-limiter + the fact the
 * session is already `agent:admin`-authenticated — this is a second, convenience-
 * grade re-confirm gate, not a high-entropy secret.
 */
export const STEP_UP_PIN_RE = /^[0-9]{4,12}$/;

/** Whether a candidate string is a well-formed PIN (format check only). */
export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === "string" && STEP_UP_PIN_RE.test(pin);
}

/** The on-disk `step-up.json` shape. Namespaced so a future field can coexist. */
interface StepUpFile {
  /** argon2id PHC hash of the operator PIN (salt embedded). Never plaintext. */
  pinHash?: string;
}

/** Absolute path to the step-up.json store in a state dir. */
export function stepUpFilePath(stateDir?: string): string {
  return join(stateDir ?? defaultStateDir(), "step-up.json");
}

/** Read `step-up.json`. Returns `{}` when absent. */
function readStepUpFile(stateDir?: string): StepUpFile {
  const file = stepUpFilePath(stateDir);
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8")) as StepUpFile;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`step-up: ${file} must be a JSON object`);
  }
  return parsed;
}

/**
 * Persist `step-up.json` 0600 — it holds the PIN hash. Creates the state dir if
 * needed; `chmod`s 0600 unconditionally (writeFileSync's `mode` only applies on
 * CREATE, so an existing file under a looser umask is tightened on every write) —
 * the exact discipline `credentials.ts` / `registry.ts` keep for secrets.
 */
function writeStepUpFile(file: StepUpFile, stateDir?: string): void {
  const dir = stateDir ?? defaultStateDir();
  mkdirSync(dir, { recursive: true });
  const path = stepUpFilePath(dir);
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** True iff a step-up PIN is configured (the feature is set up for this install). */
export function isStepUpConfigured(stateDir?: string): boolean {
  const h = readStepUpFile(stateDir).pinHash;
  return typeof h === "string" && h.length > 0;
}

/** Thrown by {@link setStepUpPin} when the PIN format is rejected. */
export class StepUpPinFormatError extends Error {
  constructor() {
    super("PIN must be 4–12 digits");
    this.name = "StepUpPinFormatError";
  }
}

/**
 * Set (first-time) or rotate the step-up PIN. Hashes with argon2id
 * (`Bun.password.hash` — salted, salt embedded in the PHC string). The CALLER
 * must enforce that:
 *   - the request is `agent:admin`-authenticated, and
 *   - if a PIN ALREADY exists, the current PIN was verified first
 *     ({@link verifyStepUpPin}) — rotating a PIN needs the old one.
 * This function trusts that gating; it only validates format + writes the hash.
 *
 * Returns nothing. Throws {@link StepUpPinFormatError} on a malformed PIN.
 */
export async function setStepUpPin(newPin: string, stateDir?: string): Promise<void> {
  if (!isValidPinFormat(newPin)) throw new StepUpPinFormatError();
  const hash = await Bun.password.hash(newPin, "argon2id");
  const file = readStepUpFile(stateDir);
  file.pinHash = hash;
  writeStepUpFile(file, stateDir);
}

/**
 * Verify a submitted PIN against the stored hash. Returns false when no PIN is
 * configured (defensive — callers gate on {@link isStepUpConfigured} first) or the
 * hash is malformed. The CALLER must run the rate-limiter BEFORE this (a wrong PIN
 * must count toward the lockout). The PIN is never logged.
 */
export async function verifyStepUpPin(pin: string, stateDir?: string): Promise<boolean> {
  if (typeof pin !== "string" || pin.length === 0) return false;
  const hash = readStepUpFile(stateDir).pinHash;
  if (typeof hash !== "string" || hash.length === 0) return false;
  try {
    return await Bun.password.verify(pin, hash);
  } catch {
    // Corrupt / unparseable hash — fail closed.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step-up token store — opaque nonce, TTL'd, REUSABLE within its window
// ---------------------------------------------------------------------------

/**
 * Default step-up token lifetime — 5 min (the issue's ~5min). Long enough for an
 * operator to set a credential / open a terminal / spawn after one PIN entry,
 * short enough that a stolen token (or a walk-away) is bounded.
 */
export const STEP_UP_TOKEN_TTL_MS = 5 * 60 * 1000;

/** Nonce entropy: 32 bytes = 256 bits, matching the SSE ticket's floor. */
const STEP_UP_TOKEN_BYTES = 32;

/** A minted step-up token's server-side record. Never leaves the process. */
interface StepUpTokenRecord {
  /** Epoch ms after which the token is expired (treated as absent). */
  expiresAt: number;
}

/** The process-local step-up token store. nonce → record. */
const stepUpTokens = new Map<string, StepUpTokenRecord>();

/** base64url-encode bytes (no padding) — URL-safe, no `+`/`/`/`=`. */
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pruneExpiredStepUpTokens(now = Date.now()): void {
  for (const [k, rec] of stepUpTokens) {
    if (now >= rec.expiresAt) stepUpTokens.delete(k);
  }
}

/**
 * Mint a step-up token valid for `ttlMs` (default {@link STEP_UP_TOKEN_TTL_MS}).
 * The CALLER must have already verified the PIN — this never authenticates. The
 * token is opaque (no scope/claims rides in it); it is purely a "the PIN was
 * entered recently" capability checked alongside the `agent:admin` Bearer.
 * Returns the nonce + its absolute expiry.
 */
export function mintStepUpToken(ttlMs = STEP_UP_TOKEN_TTL_MS): {
  token: string;
  expiresAt: number;
} {
  pruneExpiredStepUpTokens();
  const bytes = new Uint8Array(STEP_UP_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  const token = base64url(bytes);
  const expiresAt = Date.now() + ttlMs;
  stepUpTokens.set(token, { expiresAt });
  return { token, expiresAt };
}

/**
 * Whether a step-up token is currently valid. REUSABLE within its window (does NOT
 * delete on read — unlike the single-use SSE ticket), so one PIN entry buys a short
 * window across several gated actions. An absent / expired token returns false (and
 * an expired one is lazily pruned). Pure in-memory lookup — no I/O, no secret log.
 */
export function isStepUpTokenValid(token: string | null | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const rec = stepUpTokens.get(token);
  if (!rec) return false;
  if (now >= rec.expiresAt) {
    stepUpTokens.delete(token);
    return false;
  }
  return true;
}

/** Explicitly revoke a step-up token ("lock now"). Idempotent. */
export function revokeStepUpToken(token: string | null | undefined): void {
  if (token) stepUpTokens.delete(token);
}

/** Test seam: clear the in-memory token store. */
export function _resetStepUpTokensForTest(): void {
  stepUpTokens.clear();
}

/** Test seam: the live step-up token count. */
export function _stepUpTokenCountForTest(): number {
  return stepUpTokens.size;
}

// ---------------------------------------------------------------------------
// PIN brute-force limiter (lockout) — mirrors hub's admin-lock unlockLimiter
// ---------------------------------------------------------------------------

/**
 * 5 wrong PINs / 5-min sliding window before lockout. The step-up exchange is
 * already `agent:admin`-gated, so the threat is a COMPROMISED session (stolen
 * cookie → minted Bearer) grinding argon2id PIN verifications without bound. Keyed
 * per-session (the validated token's subject) so an attacker can't get a fresh
 * bucket by rotating something cheap. Same floor + posture as hub's `unlockLimiter`.
 */
export const STEP_UP_MAX_ATTEMPTS = 5;
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

export interface RateLimitResult {
  /** True if the attempt is admitted; the caller proceeds to the PIN check. */
  allowed: boolean;
  /** Seconds until the bucket frees up (only set when denied). Always >= 1. */
  retryAfterSeconds?: number;
}

/**
 * A small sliding-window rate limiter (the shape mirrors hub's `RateLimiter`,
 * inlined here to keep the agent module dependency-free). Each key keeps the last
 * N admitted attempt timestamps; on a new attempt we prune anything older than the
 * window, count what remains, and allow/deny. `now` is injectable for tests.
 */
export class StepUpRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Record an attempt and return whether it's admitted. A DENIED attempt is NOT
   * recorded (so a flood of denials can't push the reset further out). `now` is
   * epoch ms (injectable).
   */
  checkAndRecord(key: string, now = Date.now()): RateLimitResult {
    const cutoff = now - this.windowMs;
    const pruned = (this.buckets.get(key) ?? []).filter((t) => t > cutoff);
    if (pruned.length >= this.maxAttempts) {
      const resetAtMs = (pruned[0] ?? now) + this.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - now) / 1000));
      this.buckets.set(key, pruned);
      return { allowed: false, retryAfterSeconds };
    }
    pruned.push(now);
    this.buckets.set(key, pruned);
    return { allowed: true };
  }

  /** Clear a key's bucket (called on a SUCCESSFUL PIN entry so it resets). */
  clear(key: string): void {
    this.buckets.delete(key);
  }

  /** Test seam: wipe all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}

/** The singleton PIN-attempt limiter (all step-up exchanges share one bucket map). */
export const stepUpLimiter = new StepUpRateLimiter(STEP_UP_MAX_ATTEMPTS, STEP_UP_WINDOW_MS);
