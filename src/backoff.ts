/**
 * A tiny exponential-backoff circuit breaker for the daemon's repeating loops
 * (agent#187 — the P0 port-exhaustion engine). The reconcile / poll / scheduler
 * loops all run at a FIXED interval; when the thing they call keeps failing (auth
 * broke underneath them, the vault is unreachable), a fixed interval means they
 * hammer the failing dependency forever with zero widening — during the 2026-07-02
 * incident two loops 401'd 859× and 444× at their normal cadence.
 *
 * This is the shared widening primitive: a caller consults {@link Backoff.ready}
 * before each attempt, calls {@link Backoff.fail} on a failure (widening the
 * cooldown), and {@link Backoff.succeed} on a success (closing the breaker). The
 * fixed-interval tick keeps ticking; the breaker just makes most ticks a cheap
 * no-op while a dependency is down, so the failing call is retried on an
 * exponential schedule (base → base·2 → base·4 → … → cap) with jitter instead of
 * every interval.
 *
 * Deterministic by construction: the clock (`now`) and the jitter source
 * (`random`) are injectable, so tests step a fake clock and assert the exact
 * progression. No real `Date.now()` / `Math.random()` appears in the logic.
 */

export interface BackoffConfig {
  /** Cooldown after the FIRST consecutive failure (ms). Default 60s. */
  baseMs?: number;
  /** Maximum cooldown — the widening caps here (ms). Default 30m. */
  capMs?: number;
  /** Exponential factor between consecutive failures. Default 2. */
  factor?: number;
  /**
   * Jitter as a fraction (0..1) of the computed delay, added on top (so the real
   * delay is `delay + delay·jitter·random()` — always ≥ the base delay, never less,
   * so the cap is a floor-preserving ceiling). Default 0.2. Set 0 for a pure schedule.
   */
  jitter?: number;
  /** Monotonic-ish clock in ms. Default `Date.now`. Injected for tests. */
  now?: () => number;
  /** Jitter source in [0,1). Default `Math.random`. Injected for tests. */
  random?: () => number;
}

/** Resolve a base/cap pair from env with sane defaults (no new REQUIRED config). */
export function backoffConfigFromEnv(env: Record<string, string | undefined>): {
  baseMs: number;
  capMs: number;
} {
  const baseMs = parseInt(env.PARACHUTE_AGENT_BACKOFF_BASE_MS ?? "", 10) || 60_000;
  const capMs = parseInt(env.PARACHUTE_AGENT_BACKOFF_CAP_MS ?? "", 10) || 1_800_000;
  return { baseMs, capMs: Math.max(capMs, baseMs) };
}

export class Backoff {
  private readonly baseMs: number;
  private readonly capMs: number;
  private readonly factor: number;
  private readonly jitter: number;
  private readonly now: () => number;
  private readonly random: () => number;

  /** Consecutive failures since the last success (0 = breaker closed). */
  private failures = 0;
  /** Epoch-ms before which no attempt is allowed (0 = ready now). */
  private openUntilMs = 0;

  constructor(cfg?: BackoffConfig) {
    this.baseMs = cfg?.baseMs ?? 60_000;
    this.capMs = Math.max(cfg?.capMs ?? 1_800_000, this.baseMs);
    this.factor = cfg?.factor ?? 2;
    this.jitter = cfg?.jitter ?? 0.2;
    this.now = cfg?.now ?? Date.now;
    this.random = cfg?.random ?? Math.random;
  }

  /** True when an attempt is allowed (the breaker is closed, or its cooldown elapsed). */
  ready(): boolean {
    return this.now() >= this.openUntilMs;
  }

  /** Milliseconds until the next allowed attempt (0 when ready). */
  remainingMs(): number {
    return Math.max(0, this.openUntilMs - this.now());
  }

  /** Consecutive-failure count (for log lines / tests). */
  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Whether the breaker is currently open (in a cooldown window). */
  get isOpen(): boolean {
    return this.failures > 0 && !this.ready();
  }

  /**
   * Record a failure → widen the cooldown exponentially (capped) with jitter, and
   * return the applied delay (ms) so the caller can log "backing off Ns". The next
   * {@link ready} returns false until `now + delay`.
   */
  fail(): number {
    this.failures += 1;
    const exp = this.baseMs * this.factor ** (this.failures - 1);
    const capped = Math.min(this.capMs, exp);
    const delay = capped + capped * this.jitter * this.random();
    this.openUntilMs = this.now() + delay;
    return delay;
  }

  /**
   * Record a success → close the breaker (reset the failure count + cooldown).
   * Returns true when it had been widened (≥1 prior failure), so the caller can
   * emit a one-line "recovered" note only on an actual recovery.
   */
  succeed(): boolean {
    const wasOpen = this.failures > 0;
    this.failures = 0;
    this.openUntilMs = 0;
    return wasOpen;
  }
}
