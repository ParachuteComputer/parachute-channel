/**
 * Backoff circuit breaker (agent#187) — the shared widening primitive behind the
 * daemon's repeating-loop failure backoff. Driven by a FAKE clock + zero jitter so
 * the progression is exact and deterministic (no real Date.now / Math.random).
 */

import { describe, test, expect } from "bun:test";
import { Backoff, backoffConfigFromEnv } from "./backoff.ts";

/** A steppable fake clock in ms. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe("Backoff", () => {
  test("starts ready (breaker closed) with no failures", () => {
    const clock = fakeClock();
    const b = new Backoff({ now: clock.now });
    expect(b.ready()).toBe(true);
    expect(b.isOpen).toBe(false);
    expect(b.consecutiveFailures).toBe(0);
    expect(b.remainingMs()).toBe(0);
  });

  test("exponential progression base→base·2→base·4→…→cap (jitter 0)", () => {
    const clock = fakeClock();
    const b = new Backoff({ baseMs: 60_000, capMs: 1_800_000, factor: 2, jitter: 0, now: clock.now });
    // Each fail() returns the applied delay; the schedule is 60s, 2m, 4m, 8m, 16m, then capped 30m.
    expect(b.fail()).toBe(60_000); // #1
    expect(b.fail()).toBe(120_000); // #2
    expect(b.fail()).toBe(240_000); // #3
    expect(b.fail()).toBe(480_000); // #4
    expect(b.fail()).toBe(960_000); // #5
    expect(b.fail()).toBe(1_800_000); // #6 — 1920s would exceed the cap → clamped to 30m
    expect(b.fail()).toBe(1_800_000); // #7 — stays at the cap
    expect(b.consecutiveFailures).toBe(7);
  });

  test("ready() gates by the cooldown; elapses exactly at the delay", () => {
    const clock = fakeClock(1_000);
    const b = new Backoff({ baseMs: 60_000, jitter: 0, now: clock.now });
    const delay = b.fail(); // opens until now+60s
    expect(delay).toBe(60_000);
    expect(b.ready()).toBe(false);
    expect(b.isOpen).toBe(true);
    expect(b.remainingMs()).toBe(60_000);

    clock.advance(59_999);
    expect(b.ready()).toBe(false);
    expect(b.remainingMs()).toBe(1);

    clock.advance(1); // exactly at the horizon
    expect(b.ready()).toBe(true);
    expect(b.remainingMs()).toBe(0);
  });

  test("succeed() closes the breaker + resets the count; returns true only when it had widened", () => {
    const clock = fakeClock();
    const b = new Backoff({ baseMs: 60_000, jitter: 0, now: clock.now });
    expect(b.succeed()).toBe(false); // never failed → not a recovery

    b.fail();
    b.fail();
    expect(b.consecutiveFailures).toBe(2);
    expect(b.succeed()).toBe(true); // was widened → a real recovery
    expect(b.consecutiveFailures).toBe(0);
    expect(b.ready()).toBe(true);
    expect(b.isOpen).toBe(false);
    // A subsequent failure starts the schedule over from the base.
    expect(b.fail()).toBe(60_000);
  });

  test("jitter adds a bounded positive amount on top of the base delay (never below the schedule)", () => {
    const clock = fakeClock();
    // random()=1 → full jitter: delay = base + base·jitter·1 = 60s·(1+0.2) = 72s.
    const b = new Backoff({ baseMs: 60_000, jitter: 0.2, now: clock.now, random: () => 1 });
    expect(b.fail()).toBe(72_000);
    // random()=0 → no jitter: exactly the base.
    const b2 = new Backoff({ baseMs: 60_000, jitter: 0.2, now: clock.now, random: () => 0 });
    expect(b2.fail()).toBe(60_000);
  });

  test("cap is a floor-preserving ceiling — the jittered delay is capped·(1+jitter·random)", () => {
    const clock = fakeClock();
    const b = new Backoff({ baseMs: 60_000, capMs: 100_000, factor: 2, jitter: 0.5, now: clock.now, random: () => 1 });
    b.fail(); // 60s (< cap)
    b.fail(); // 120s → capped to 100s, then +50% jitter → 150s
    expect(b.remainingMs()).toBe(150_000);
  });
});

describe("backoffConfigFromEnv", () => {
  test("defaults to 60s base / 30m cap with an empty env", () => {
    expect(backoffConfigFromEnv({})).toEqual({ baseMs: 60_000, capMs: 1_800_000 });
  });

  test("reads the overrides", () => {
    expect(
      backoffConfigFromEnv({ PARACHUTE_AGENT_BACKOFF_BASE_MS: "5000", PARACHUTE_AGENT_BACKOFF_CAP_MS: "90000" }),
    ).toEqual({ baseMs: 5_000, capMs: 90_000 });
  });

  test("clamps cap ≥ base (a nonsensical cap<base can't invert the schedule)", () => {
    expect(
      backoffConfigFromEnv({ PARACHUTE_AGENT_BACKOFF_BASE_MS: "120000", PARACHUTE_AGENT_BACKOFF_CAP_MS: "1000" }),
    ).toEqual({ baseMs: 120_000, capMs: 120_000 });
  });

  test("ignores non-numeric env (falls back to defaults)", () => {
    expect(backoffConfigFromEnv({ PARACHUTE_AGENT_BACKOFF_BASE_MS: "abc" })).toEqual({
      baseMs: 60_000,
      capMs: 1_800_000,
    });
  });
});
