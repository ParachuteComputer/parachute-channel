/**
 * The runner — a scheduler that fires scheduled jobs (design
 * `2026-06-17-runner-scheduled-agent-turns.md`).
 *
 * It does NOT execute anything. On each tick it loads the current jobs (from the
 * VAULT-NATIVE store), asks each enabled job "are you due?" and, if so, FIRES it —
 * where "fire" means "inject an inbound note onto the job's vault channel." The
 * existing vault trigger → agent-turn → outbound flow does all the work. The
 * runner is a clock that authors messages.
 *
 * Determinism is the design's hard requirement: the testable core takes an
 * INJECTABLE clock (`now`), INJECTABLE load + fire + persist fns, and an
 * INJECTABLE tick driver. The daemon's boot supplies the real ones (`Date`, the
 * vault job store, the vault-inject fire, a `setInterval` tick); tests supply
 * fakes and step time by hand. No real `setInterval`/`Date.now()` appears in
 * `tick()` itself.
 *
 * Storage-agnostic: the runner never touches the vault directly. It calls:
 *   - `loadJobs()`        → the current jobs (the store queries the vault),
 *   - `fire(job)`         → inject the inbound note (the transport writes it),
 *   - `persistFire(job)`  → write back lastRunAt/lastStatus (the store PATCHes).
 *
 * `nextRunAt` is COMPUTED IN MEMORY and NEVER persisted. The runner keeps a small
 * per-job horizon map (keyed by id) across ticks so a job fires once per slot; a
 * job seen for the first time gets a horizon computed from now (and won't fire
 * until that horizon passes — so a freshly-created job never back-fires on its
 * first tick).
 *
 * Catch-up policy = FIRE-ONCE-ON-MISS: if a job's horizon is already in the past
 * on a tick (the daemon was down across one or more slots), the job fires ONCE and
 * the horizon is recomputed forward from now — never replaying every missed slot.
 *
 * Idempotency under overlap: a job that's mid-fire (its async fire hasn't resolved)
 * is SKIPPED on subsequent ticks, so a slow vault write can't be double-fired.
 */

import { nextRunAfter } from "./cron.ts";
import type { Job } from "./jobs.ts";
import { Backoff, type BackoffConfig } from "./backoff.ts";

/** Load the current jobs (the vault-native store queries the vault). Async. */
export type LoadJobsFn = () => Promise<Job[]>;

/** Fire a job: inject its message as an inbound note onto its channel. Async. */
export type FireFn = (job: Job) => Promise<void>;

/** Persist a job's bookkeeping (lastRunAt/lastStatus) after a fire. Async. */
export type PersistFireFn = (job: Job) => Promise<void>;

/** A scheduler driver: schedule `fn` to run every `ms`, return a cancel handle. */
export interface TickDriver {
  schedule(fn: () => void, ms: number): { cancel: () => void };
}

export interface RunnerOptions {
  /** Load the current jobs (queries the vault each tick). */
  loadJobs: LoadJobsFn;
  /** Fire a due job (inject the inbound note). */
  fire: FireFn;
  /** Persist a job's bookkeeping after a fire. */
  persistFire: PersistFireFn;
  /** Clock — injected for determinism. Default `() => new Date()`. */
  now?: () => Date;
  /** Tick driver — injected for determinism. Default a real-setInterval driver. */
  driver?: TickDriver;
  /** Tick interval (ms). Default 30s. */
  intervalMs?: number;
  /** Log sink (errors per job/tick never throw out). Default `console`. */
  log?: { warn: (msg: string) => void; error: (msg: string) => void };
  /**
   * Circuit-breaker tuning for the `loadJobs` failure loop (agent#187). When
   * `loadJobs` keeps failing (auth broke underneath the daemon, vault unreachable),
   * the fixed tick otherwise re-hits it every interval forever; this widens the retry
   * exponentially (base → cap) instead. `now` is overridden to the runner's own clock
   * so a fake-clock test drives the breaker in lockstep with the tick. Sane defaults —
   * no config required.
   */
  loadBackoff?: BackoffConfig;
}

/** A real `setInterval`-backed tick driver (the daemon uses this; tests don't). */
export function realTickDriver(): TickDriver {
  return {
    schedule(fn, ms) {
      const t = setInterval(fn, ms);
      // Don't keep the process alive solely for the runner tick.
      if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
      return { cancel: () => clearInterval(t) };
    },
  };
}

const DEFAULT_INTERVAL_MS = 30_000;

export class Runner {
  private readonly loadJobs: LoadJobsFn;
  private readonly fire: FireFn;
  private readonly persistFire: PersistFireFn;
  private readonly now: () => Date;
  private readonly driver: TickDriver;
  private readonly intervalMs: number;
  private readonly log: { warn: (msg: string) => void; error: (msg: string) => void };

  /**
   * Per-job next-fire horizon (ISO), COMPUTED IN MEMORY and carried across ticks.
   * Keyed by job id. Seeded the first time a job is seen; recomputed forward after
   * each fire. Not persisted — the vault store doesn't carry nextRunAt.
   */
  private readonly horizons = new Map<string, string>();
  /** Job ids currently mid-fire — skipped by an interleaving tick (overlap guard). */
  private readonly inFlight = new Set<string>();
  private handle: { cancel: () => void } | undefined;
  /** Circuit breaker for the `loadJobs` failure loop (agent#187). */
  private readonly loadBackoff: Backoff;

  constructor(opts: RunnerOptions) {
    this.loadJobs = opts.loadJobs;
    this.fire = opts.fire;
    this.persistFire = opts.persistFire;
    this.now = opts.now ?? (() => new Date());
    this.driver = opts.driver ?? realTickDriver();
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.log = opts.log ?? {
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
    };
    // Share the runner's clock so the breaker and the tick advance together (tests step
    // one fake clock). Caller-supplied base/cap/jitter still apply; `now` is authoritative.
    this.loadBackoff = new Backoff({
      ...opts.loadBackoff,
      now: () => this.now().getTime(),
    });
  }

  /**
   * The stable per-job key for horizon + in-flight tracking. Prefer the vault
   * `noteId` (globally unique across channels/vaults) so two jobs that share a
   * SLUG in different channels don't collide; fall back to the slug `id` for an
   * in-memory job that hasn't been persisted yet (tests).
   */
  private keyOf(job: Job): string {
    return job.noteId ?? job.id;
  }

  /** Compute the next fire instant for a job after `from`, or null on a bad cron. */
  private computeNext(job: Job, from: Date): Date | null {
    try {
      return nextRunAfter(job.schedule.cron, job.schedule.tz, from);
    } catch (err) {
      this.log.warn(`runner: job "${job.id}" has an unschedulable cron: ${(err as Error).message}`);
      return null;
    }
  }

  /** Start the periodic tick. Idempotent (a second start is a no-op). */
  start(): void {
    if (this.handle) return;
    this.handle = this.driver.schedule(() => {
      // A tick must never throw out (it'd kill the interval). `tick()` already
      // guards; this is belt-and-suspenders for an unexpected throw.
      void this.tick().catch((err) => this.log.error(`runner: tick failed: ${err}`));
    }, this.intervalMs);
  }

  /** Stop the tick. Safe to call when not started. */
  stop(): void {
    this.handle?.cancel();
    this.handle = undefined;
  }

  /**
   * One scheduling pass. Loads the current jobs; for each enabled, not-in-flight
   * job whose horizon is due (≤ now), fires it once and advances the horizon
   * forward from now. A job seen for the first time gets a horizon computed (it
   * won't fire this tick — it's in the future). Per-job failures are caught and
   * recorded; one bad job never aborts the pass. A load failure is logged and the
   * tick is a no-op (it retries next interval). Awaitable for deterministic tests.
   */
  async tick(): Promise<void> {
    const at = this.now();
    // BACKOFF GATE (agent#187): while the breaker is open (loadJobs has been failing), most
    // ticks are a cheap no-op — we don't re-hit the failing dependency every interval.
    if (!this.loadBackoff.ready()) return;
    let jobs: Job[];
    try {
      jobs = await this.loadJobs();
    } catch (err) {
      const delay = this.loadBackoff.fail();
      this.log.error(
        `runner: loadJobs failed (skipping this tick; backing off ${Math.round(delay / 1000)}s after ` +
          `${this.loadBackoff.consecutiveFailures} consecutive failure(s)): ${(err as Error).message}`,
      );
      return;
    }
    // A clean load closes the breaker; log once on an actual recovery (was widened).
    if (this.loadBackoff.succeed()) {
      this.log.warn(`runner: loadJobs recovered — resuming normal ${Math.round(this.intervalMs / 1000)}s cadence.`);
    }

    // Prune horizons for jobs that no longer exist (deleted), so the map can't grow.
    const liveKeys = new Set(jobs.map((j) => this.keyOf(j)));
    for (const key of [...this.horizons.keys()]) {
      if (!liveKeys.has(key)) this.horizons.delete(key);
    }

    const fires: Array<Promise<void>> = [];
    for (const job of jobs) {
      if (!job.enabled) continue;
      const key = this.keyOf(job);
      if (this.inFlight.has(key)) continue; // overlap guard — already firing.

      let horizon = this.horizons.get(key);
      if (!horizon) {
        // First time we've seen this job — seed a horizon from now. Future → not
        // due this tick (a freshly-created job never back-fires on first sight).
        const next = this.computeNext(job, at);
        if (!next) continue; // unschedulable cron — skip (logged in computeNext).
        horizon = next.toISOString();
        this.horizons.set(key, horizon);
        job.nextRunAt = horizon;
        continue;
      }

      job.nextRunAt = horizon;
      if (new Date(horizon).getTime() <= at.getTime()) {
        fires.push(this.fireOne(job, at));
      }
    }
    await Promise.allSettled(fires);
  }

  /**
   * Fire one due job: mark in-flight, inject, record bookkeeping, recompute the
   * horizon FORWARD FROM NOW (fire-once-on-miss — never replay missed slots),
   * persist the bookkeeping. Never throws — a fire failure is recorded as
   * `lastStatus: "error: …"` and still advances the horizon (so it retries the
   * next slot rather than getting stuck).
   */
  private async fireOne(job: Job, at: Date): Promise<void> {
    const key = this.keyOf(job);
    this.inFlight.add(key);
    try {
      await this.fire(job);
      job.lastStatus = "ok";
    } catch (err) {
      job.lastStatus = `error: ${(err as Error).message}`;
      this.log.error(`runner: job "${job.id}" fire failed: ${(err as Error).message}`);
    } finally {
      job.lastRunAt = at.toISOString();
      // Recompute the horizon from NOW (not the missed slot) — fire-once-on-miss.
      const next = this.computeNext(job, at);
      if (next) {
        this.horizons.set(key, next.toISOString());
        job.nextRunAt = next.toISOString();
      } else {
        this.horizons.delete(key);
        job.nextRunAt = undefined;
      }
      this.inFlight.delete(key);
      // Persist the bookkeeping (lastRunAt/lastStatus) — best-effort.
      try {
        await this.persistFire(job);
      } catch (err) {
        this.log.warn(`runner: persist bookkeeping for "${job.id}" failed (continuing): ${(err as Error).message}`);
      }
    }
  }

  /**
   * Fire a single job immediately, on demand (the "Run now" API). Loads jobs to
   * find it, bypasses the schedule + due check but honors the overlap guard and
   * records bookkeeping exactly like a scheduled fire. Returns the resulting
   * `lastStatus`. Throws only if the job is unknown; a fire failure is recorded
   * and returned, not thrown.
   */
  async runNow(id: string): Promise<string> {
    const jobs = await this.loadJobs();
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error(`runner: no job with id "${id}"`);
    if (this.inFlight.has(this.keyOf(job))) return job.lastStatus ?? "already running";
    await this.fireOne(job, this.now());
    return job.lastStatus ?? "ok";
  }
}
