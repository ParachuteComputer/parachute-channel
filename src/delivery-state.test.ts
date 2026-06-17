/**
 * DeliveryState tests — the per-channel high-water-mark that gates backlog replay.
 *
 * Covered:
 *  - monotonic advance (never rewinds; reports whether it moved);
 *  - default-to-bootTime for an unknown channel (so a first connect never replays
 *    ancient history);
 *  - persist + reload across a simulated restart (a new instance reads the file);
 *  - blank-ts advance is a no-op (we never mark to an empty ts).
 *
 * Each test points the store at a throwaway temp dir, so there's no shared global
 * state and no touch of the real `~/.parachute/agent/`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DeliveryState } from "./delivery-state.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "channel-delivery-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("getLastDelivered default", () => {
  test("an unknown channel returns the boot-time default mark, not epoch", () => {
    const boot = "2026-06-16T12:00:00.000Z";
    const ds = new DeliveryState({ stateDir: dir, defaultMark: boot });
    expect(ds.getLastDelivered("never-seen")).toBe(boot);
  });

  test("defaultMark defaults to ~now when omitted", () => {
    const before = Date.now();
    const ds = new DeliveryState({ stateDir: dir });
    const mark = Date.parse(ds.getLastDelivered("x"));
    const after = Date.now();
    expect(mark).toBeGreaterThanOrEqual(before);
    expect(mark).toBeLessThanOrEqual(after + 1000);
  });
});

describe("advance is monotonic", () => {
  test("moves forward + reports true; a stale/equal ts is a no-op reporting false", () => {
    const ds = new DeliveryState({ stateDir: dir, defaultMark: "2026-01-01T00:00:00.000Z" });
    expect(ds.advance("c", "2026-06-16T10:00:00.000Z")).toBe(true);
    expect(ds.getLastDelivered("c")).toBe("2026-06-16T10:00:00.000Z");

    // An OLDER ts must not rewind the mark.
    expect(ds.advance("c", "2026-06-16T09:00:00.000Z")).toBe(false);
    expect(ds.getLastDelivered("c")).toBe("2026-06-16T10:00:00.000Z");

    // The SAME ts is also a no-op (strictly-greater advance).
    expect(ds.advance("c", "2026-06-16T10:00:00.000Z")).toBe(false);
    expect(ds.getLastDelivered("c")).toBe("2026-06-16T10:00:00.000Z");

    // A NEWER ts advances again.
    expect(ds.advance("c", "2026-06-16T11:00:00.000Z")).toBe(true);
    expect(ds.getLastDelivered("c")).toBe("2026-06-16T11:00:00.000Z");
  });

  test("a blank ts never advances the mark", () => {
    const ds = new DeliveryState({ stateDir: dir, defaultMark: "2026-01-01T00:00:00.000Z" });
    expect(ds.advance("c", "")).toBe(false);
    expect(ds.getLastDelivered("c")).toBe("2026-01-01T00:00:00.000Z");
  });

  test("per-channel marks are independent", () => {
    const ds = new DeliveryState({ stateDir: dir, defaultMark: "2026-01-01T00:00:00.000Z" });
    ds.advance("a", "2026-06-16T10:00:00.000Z");
    expect(ds.getLastDelivered("a")).toBe("2026-06-16T10:00:00.000Z");
    // b is untouched — still the default.
    expect(ds.getLastDelivered("b")).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("persist + reload (simulated restart)", () => {
  test("a fresh instance reads the persisted marks (the restart case)", () => {
    const ds1 = new DeliveryState({ stateDir: dir, defaultMark: "2026-01-01T00:00:00.000Z" });
    ds1.advance("eng", "2026-06-16T10:00:00.000Z");
    ds1.advance("ops", "2026-06-16T11:00:00.000Z");
    expect(existsSync(join(dir, "delivery-state.json"))).toBe(true);

    // Simulate a daemon restart: a brand-new instance with a LATER boot default.
    // The persisted per-channel marks must win over the new default — that's what
    // makes the replay-the-gap behavior work across a bounce.
    const ds2 = new DeliveryState({ stateDir: dir, defaultMark: "2026-06-16T12:00:00.000Z" });
    expect(ds2.getLastDelivered("eng")).toBe("2026-06-16T10:00:00.000Z");
    expect(ds2.getLastDelivered("ops")).toBe("2026-06-16T11:00:00.000Z");
    // A channel with no persisted mark still falls back to the new boot default.
    expect(ds2.getLastDelivered("brand-new")).toBe("2026-06-16T12:00:00.000Z");
  });

  test("the persisted file is valid JSON of channel→ts", () => {
    const ds = new DeliveryState({ stateDir: dir, defaultMark: "2026-01-01T00:00:00.000Z" });
    ds.advance("eng", "2026-06-16T10:00:00.000Z");
    const onDisk = JSON.parse(readFileSync(join(dir, "delivery-state.json"), "utf8"));
    expect(onDisk).toEqual({ eng: "2026-06-16T10:00:00.000Z" });
  });

  test("a corrupt file is tolerated — starts empty, the default covers unknowns", () => {
    writeFileSync(join(dir, "delivery-state.json"), "{ not json");
    const ds = new DeliveryState({ stateDir: dir, defaultMark: "2026-06-16T12:00:00.000Z" });
    expect(ds.getLastDelivered("eng")).toBe("2026-06-16T12:00:00.000Z");
    // Still usable: advance + persist overwrites the corrupt file.
    expect(ds.advance("eng", "2026-06-16T13:00:00.000Z")).toBe(true);
  });
});
