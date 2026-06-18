import { describe, test, expect } from "bun:test";
import { Runner, type TickDriver } from "./runner.ts";
import type { Job } from "./jobs.ts";
import {
  ProgrammaticAgentRegistry,
  type WriteOutbound,
  type WriteRun,
  type RunNote,
} from "./backends/registry.ts";
import type {
  AgentBackend,
  AgentHandle,
  AgentStatus,
  DeliverResult,
  InterimSink,
} from "./backends/types.ts";
import type { AgentSpec } from "./sandbox/types.ts";

/** A controllable clock — tests step time by setting `current`. */
function fakeClock(startIso: string) {
  let current = new Date(startIso);
  return {
    now: () => new Date(current.getTime()),
    set: (iso: string) => {
      current = new Date(iso);
    },
  };
}

/** A manual tick driver — the test calls `runScheduled()` to fire the scheduled fn. */
function manualDriver(): TickDriver & { runScheduled: () => void; scheduledMs: number } {
  let fn: (() => void) | null = null;
  let ms = 0;
  return {
    schedule(f, intervalMs) {
      fn = f;
      ms = intervalMs;
      return { cancel: () => { fn = null; } };
    },
    runScheduled() {
      if (fn) fn();
    },
    get scheduledMs() {
      return ms;
    },
  };
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: "j",
    channel: "uni-dev",
    message: "go",
    schedule: { cron: "0 * * * *", tz: "UTC" }, // hourly, top of hour
    enabled: true,
    createdAt: "2026-06-17T00:00:00.000Z",
    ...over,
  };
}

const silent = { warn: () => {}, error: () => {} };

/** A store stub: jobs the runner loads + a record of persisted bookkeeping. */
function store(jobs: Job[]) {
  const persisted: Array<{ id: string; lastStatus?: string; lastRunAt?: string }> = [];
  return {
    jobs,
    persisted,
    loadJobs: async () => jobs.map((j) => ({ ...j })), // fresh copies each tick (vault-like)
    persistFire: async (j: Job) => {
      persisted.push({ id: j.id, lastStatus: j.lastStatus, lastRunAt: j.lastRunAt });
    },
  };
}

describe("Runner.tick — horizon seeding + due detection", () => {
  test("a job seen for the first time gets a future horizon and does NOT fire", async () => {
    const clock = fakeClock("2026-06-17T10:30:00Z");
    const fired: string[] = [];
    const s = store([job()]);
    const r = new Runner({
      loadJobs: s.loadJobs,
      fire: async (j) => { fired.push(j.id); },
      persistFire: s.persistFire,
      now: clock.now,
      log: silent,
    });
    await r.tick();
    expect(fired).toEqual([]); // seeded horizon is 11:00, not due at 10:30.
  });

  test("fires exactly when the horizon is due, once per slot", async () => {
    const clock = fakeClock("2026-06-17T10:30:00Z");
    const fired: string[] = [];
    const s = store([job()]);
    const r = new Runner({
      loadJobs: s.loadJobs,
      fire: async (j) => { fired.push(j.id); },
      persistFire: s.persistFire,
      now: clock.now,
      log: silent,
    });
    await r.tick(); // seeds horizon 11:00
    expect(fired).toEqual([]);

    clock.set("2026-06-17T11:00:00Z");
    await r.tick(); // due → fires
    expect(fired).toEqual(["j"]);
    expect(s.persisted.at(-1)).toMatchObject({ id: "j", lastStatus: "ok", lastRunAt: "2026-06-17T11:00:00.000Z" });

    clock.set("2026-06-17T11:05:00Z");
    await r.tick(); // next horizon is 12:00 → not due
    expect(fired).toEqual(["j"]);
  });

  test("a disabled job never fires even when its horizon would be due", async () => {
    const clock = fakeClock("2026-06-17T11:00:00Z");
    const fired: string[] = [];
    const s = store([job({ enabled: false })]);
    const r = new Runner({
      loadJobs: s.loadJobs,
      fire: async (j) => { fired.push(j.id); },
      persistFire: s.persistFire,
      now: clock.now,
      log: silent,
    });
    await r.tick();
    clock.set("2026-06-17T12:00:00Z");
    await r.tick();
    expect(fired).toEqual([]);
  });
});

describe("Runner.tick — fire-once-on-miss (no stampede)", () => {
  test("a job whose horizon was seeded then time jumps far ahead fires ONCE", async () => {
    const clock = fakeClock("2026-06-17T05:30:00Z");
    let fireCount = 0;
    const s = store([job()]);
    const r = new Runner({
      loadJobs: s.loadJobs,
      fire: async () => { fireCount++; },
      persistFire: s.persistFire,
      now: clock.now,
      log: silent,
    });
    await r.tick(); // seeds horizon 06:00
    // Daemon "down" — next tick is at 11:30, well past 06:00 and several slots.
    clock.set("2026-06-17T11:30:00Z");
    await r.tick();
    expect(fireCount).toBe(1); // exactly once despite 5+ missed slots
    // Horizon recomputed forward from 11:30 → 12:00 (not 07:00).
    expect(s.jobs[0]!.nextRunAt).toBeUndefined(); // store copy untouched; check via next tick
    clock.set("2026-06-17T11:45:00Z");
    await r.tick();
    expect(fireCount).toBe(1); // still not due (next is 12:00)
    clock.set("2026-06-17T12:00:00Z");
    await r.tick();
    expect(fireCount).toBe(2);
  });
});

describe("Runner.tick — overlap guard (idempotent under slow fire)", () => {
  test("a job mid-fire is skipped by an interleaving tick", async () => {
    const clock = fakeClock("2026-06-17T11:00:00Z");
    let resolveFire!: () => void;
    let fireCount = 0;
    const s = store([job()]);
    const r = new Runner({
      loadJobs: s.loadJobs,
      fire: () => {
        fireCount++;
        return new Promise<void>((res) => { resolveFire = res; });
      },
      persistFire: s.persistFire,
      now: clock.now,
      log: silent,
    });
    await r.tick(); // seeds horizon 12:00 — but set clock so it's due:
    clock.set("2026-06-17T12:00:00Z");

    const t1 = r.tick(); // starts a fire that hasn't resolved
    // Let the tick reach the fire (it awaits loadJobs first).
    await new Promise((res) => setTimeout(res, 0));
    expect(fireCount).toBe(1);

    await r.tick(); // interleaving tick — job in-flight → skipped
    expect(fireCount).toBe(1);

    resolveFire();
    await t1;
  });
});

describe("Runner.tick — fire failure recorded, never thrown", () => {
  test("a throwing fire records error status + advances the horizon", async () => {
    const clock = fakeClock("2026-06-17T11:00:00Z");
    const s = store([job()]);
    const r = new Runner({
      loadJobs: s.loadJobs,
      fire: async () => { throw new Error("vault down"); },
      persistFire: s.persistFire,
      now: clock.now,
      log: silent,
    });
    await r.tick(); // seed
    clock.set("2026-06-17T12:00:00Z");
    await r.tick(); // due → fire throws, recorded
    expect(s.persisted.at(-1)).toMatchObject({ id: "j", lastStatus: "error: vault down" });
  });

  test("one bad job does not abort the pass for a good one", async () => {
    const clock = fakeClock("2026-06-17T11:00:00Z");
    const fired: string[] = [];
    const s = store([job({ id: "bad" }), job({ id: "good" })]);
    const r = new Runner({
      loadJobs: s.loadJobs,
      fire: async (j) => {
        if (j.id === "bad") throw new Error("boom");
        fired.push(j.id);
      },
      persistFire: s.persistFire,
      now: clock.now,
      log: silent,
    });
    await r.tick(); // seed both
    clock.set("2026-06-17T12:00:00Z");
    await r.tick(); // both due
    expect(fired).toEqual(["good"]);
    const byId = Object.fromEntries(s.persisted.map((p) => [p.id, p.lastStatus]));
    expect(byId.bad).toMatch(/error/);
    expect(byId.good).toBe("ok");
  });
});

describe("Runner.tick — load failure is a no-op tick", () => {
  test("a loadJobs rejection does not throw out of tick", async () => {
    const r = new Runner({
      loadJobs: async () => { throw new Error("vault unreachable"); },
      fire: async () => {},
      persistFire: async () => {},
      log: silent,
    });
    await r.tick(); // must resolve, not reject
    expect(true).toBe(true);
  });
});

describe("Runner.tick — deleted jobs prune their horizon", () => {
  test("a job removed from the store stops being tracked", async () => {
    const clock = fakeClock("2026-06-17T10:30:00Z");
    let current: Job[] = [job()];
    const r = new Runner({
      loadJobs: async () => current.map((j) => ({ ...j })),
      fire: async () => {},
      persistFire: async () => {},
      now: clock.now,
      log: silent,
    });
    await r.tick(); // seeds horizon for "j"
    current = []; // job deleted from the vault
    await r.tick(); // prunes — no throw, nothing to fire
    expect(true).toBe(true);
  });
});

describe("Runner.runNow — fire on demand", () => {
  test("fires immediately regardless of schedule + persists bookkeeping", async () => {
    const clock = fakeClock("2026-06-17T10:30:00Z");
    const fired: string[] = [];
    const s = store([job()]);
    const r = new Runner({
      loadJobs: s.loadJobs,
      fire: async (j) => { fired.push(j.id); },
      persistFire: s.persistFire,
      now: clock.now,
      log: silent,
    });
    const status = await r.runNow("j");
    expect(status).toBe("ok");
    expect(fired).toEqual(["j"]);
    expect(s.persisted.at(-1)).toMatchObject({ id: "j", lastRunAt: "2026-06-17T10:30:00.000Z" });
  });

  test("runNow on an unknown id throws", async () => {
    const r = new Runner({
      loadJobs: async () => [],
      fire: async () => {},
      persistFire: async () => {},
      log: silent,
    });
    await expect(r.runNow("nope")).rejects.toThrow(/no job/);
  });

  test("runNow records an error status without throwing on a fire failure", async () => {
    const s = store([job()]);
    const r = new Runner({
      loadJobs: s.loadJobs,
      fire: async () => { throw new Error("nope"); },
      persistFire: s.persistFire,
      log: silent,
    });
    const status = await r.runNow("j");
    expect(status).toMatch(/error: nope/);
  });
});

describe("Runner — driver wiring (start/stop)", () => {
  test("start schedules the tick on the injected driver; stop cancels", async () => {
    const clock = fakeClock("2026-06-17T12:00:00Z");
    const driver = manualDriver();
    const fired: string[] = [];
    // Pre-seed via a horizon that's already due: a tick first seeds (future), so
    // to observe a fire through the driver we drive twice with time advanced.
    const s = store([job()]);
    const r = new Runner({
      loadJobs: s.loadJobs,
      fire: async (j) => { fired.push(j.id); },
      persistFire: s.persistFire,
      now: clock.now,
      driver,
      intervalMs: 30_000,
      log: silent,
    });
    r.start();
    expect(driver.scheduledMs).toBe(30_000);

    driver.runScheduled(); // tick 1 — seeds horizon 13:00
    await new Promise((res) => setTimeout(res, 0));
    expect(fired).toEqual([]);

    clock.set("2026-06-17T13:00:00Z");
    driver.runScheduled(); // tick 2 — due → fires
    await new Promise((res) => setTimeout(res, 0));
    expect(fired).toEqual(["j"]);

    r.stop();
    fired.length = 0;
    clock.set("2026-06-17T14:00:00Z");
    driver.runScheduled(); // cancelled — no-op
    await new Promise((res) => setTimeout(res, 0));
    expect(fired).toEqual([]);
  });

  test("start is idempotent (a second start does not double-schedule)", () => {
    let scheduleCalls = 0;
    const driver: TickDriver = {
      schedule(_fn, _ms) {
        scheduleCalls++;
        return { cancel: () => {} };
      },
    };
    const r = new Runner({
      loadJobs: async () => [],
      fire: async () => {},
      persistFire: async () => {},
      driver,
      log: silent,
    });
    r.start();
    r.start();
    expect(scheduleCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Runner ↔ mode-aware deliver — a scheduled fire honors the DEF's mode.
//
// The runner is mode-AGNOSTIC: `fire(job)` just authors a synthetic inbound onto the
// job's channel. The def's `mode` governs downstream at the deliver chokepoint. This
// is what fixes "a scheduled job silently resumes the chat thread" — the operator
// expresses ephemerality via `mode: one-shot` on the DEF, and the runner's fire then
// runs an ephemeral turn + leaves a run note (a resident def's fire resumes the
// thread as today). We wire the runner's `fire` to the REAL registry enqueue path
// (fire → enqueue → mode-aware deliver) so the end-to-end behavior is asserted, not
// just the runner-in-isolation contract.
// ---------------------------------------------------------------------------

/** A fake backend that records whether each turn resumed, keyed off the spec's mode. */
class ModeFakeBackend implements AgentBackend {
  readonly kind = "programmatic";
  readonly resumed = new Map<string, boolean>(); // channel → did this turn resume?
  private readonly sessionId = new Map<string, string>(); // channel → persisted id

  async start(spec: AgentSpec): Promise<AgentHandle> {
    return { backend: this.kind, channel: spec.channels[0] as string, name: spec.name, spec };
  }
  async deliver(handle: AgentHandle, message: string, _onInterim?: InterimSink): Promise<DeliverResult> {
    // Mirror the real backend's mode semantics so the runner-path assertion is faithful.
    const oneShot = handle.spec?.mode === "one-shot";
    const prior = oneShot ? undefined : this.sessionId.get(handle.channel);
    this.resumed.set(handle.channel, prior !== undefined);
    if (!oneShot) this.sessionId.set(handle.channel, "sess-" + handle.channel);
    return { ok: true, reply: "did: " + message };
  }
  async stop(_handle: AgentHandle): Promise<void> {}
  async status(_handle: AgentHandle): Promise<AgentStatus> {
    return { live: true };
  }
  /** Seed a prior session id (as if a previous turn established one). */
  seed(channel: string, id: string): void {
    this.sessionId.set(channel, id);
  }
}

const noopOutbound: WriteOutbound = async () => {};
function runRec(): { runs: RunNote[]; fn: WriteRun } {
  const runs: RunNote[] = [];
  return { runs, fn: async (r) => void runs.push(r) };
}
async function flushTurns(pred: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) await new Promise<void>((r) => setTimeout(r, 1));
}

/** Wire a runner whose `fire` enqueues onto the registry (the real fire→deliver path). */
function wireRunner(reg: ProgrammaticAgentRegistry, clock = fakeClock("2026-06-17T10:30:00Z")) {
  return new Runner({
    loadJobs: async () => [],
    fire: async (j: Job) => {
      reg.enqueue(j.channel, { content: j.message });
    },
    persistFire: async () => {},
    now: clock.now,
    log: silent,
  });
}

describe("Runner — a scheduled fire honors the def's mode", () => {
  test("a ONE-SHOT def's scheduled fire is ephemeral (no resume) + writes a run note", async () => {
    const backend = new ModeFakeBackend();
    const runs = runRec();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: noopOutbound, writeRun: runs.fn });
    await reg.register({ name: "digest", channels: ["digest"], mode: "one-shot", definition: "Agents/digest" });
    // Even with a prior session id seeded, a one-shot fire must NOT resume.
    backend.seed("digest", "sess-OLD");

    const r = wireRunner(reg);
    // runNow needs the job in the store; drive `fire` directly (the runner's fire is
    // what we're testing routes through the mode-aware deliver).
    await r["fire"](job({ id: "digest-job", channel: "digest", message: "run the digest" }));
    await flushTurns(() => runs.runs.length === 1);

    // Ephemeral: the scheduled fire did NOT resume the chat thread.
    expect(backend.resumed.get("digest")).toBe(false);
    // …and it left a run record (the one-shot's record, since there's no resumed transcript).
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]!.mode).toBe("one-shot");
    expect(runs.runs[0]!.status).toBe("ok");
    expect(runs.runs[0]!.input).toBe("run the digest");
  });

  test("REGRESSION: a RESIDENT def's scheduled fire RESUMES the thread + writes NO run note", async () => {
    const backend = new ModeFakeBackend();
    const runs = runRec();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: noopOutbound, writeRun: runs.fn });
    // No mode → resident (the default = today's behavior).
    await reg.register({ name: "uni-dev", channels: ["uni-dev"] });
    backend.seed("uni-dev", "sess-EXISTING"); // a prior turn established the thread.

    const r = wireRunner(reg);
    await r["fire"](job({ id: "uni-job", channel: "uni-dev", message: "daily check-in" }));
    await flushTurns(() => backend.resumed.has("uni-dev"));
    // Let any erroneous run-note write land, then assert none did.
    await new Promise<void>((r2) => setTimeout(r2, 5));

    // A resident def's scheduled fire RESUMES the existing chat thread (today's behavior).
    expect(backend.resumed.get("uni-dev")).toBe(true);
    // …and writes NO run note — the channel transcript is its record.
    expect(runs.runs).toHaveLength(0);
  });
});
