import { describe, test, expect } from "bun:test";
import { parseCron, nextRunAfter, CronParseError, type ParsedCron } from "./cron.ts";

/** Helper: the wall-clock fields of an instant in a tz (for asserting matches). */
function wall(date: Date, tz: string): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(date);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let h = parseInt(g("hour"), 10);
  if (h === 24) h = 0;
  return {
    y: parseInt(g("year"), 10),
    mo: parseInt(g("month"), 10),
    d: parseInt(g("day"), 10),
    h,
    mi: parseInt(g("minute"), 10),
    wd: WD[g("weekday")] ?? -1,
  };
}

describe("parseCron — field parsing", () => {
  test("a fully-wild expression matches every minute", () => {
    const p = parseCron("* * * * *");
    expect(p.minute.size).toBe(60);
    expect(p.hour.size).toBe(24);
    expect(p.dom.size).toBe(31);
    expect(p.month.size).toBe(12);
    expect(p.dow.size).toBe(7);
    expect(p.domStar).toBe(true);
    expect(p.dowStar).toBe(true);
  });

  test("concrete fields parse to single-value sets", () => {
    const p = parseCron("53 7 * * *");
    expect([...p.minute]).toEqual([53]);
    expect([...p.hour]).toEqual([7]);
    expect(p.domStar).toBe(true);
    expect(p.dowStar).toBe(true);
  });

  test("step (*​/15) expands to the stepped set", () => {
    const p = parseCron("*/15 * * * *");
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    // A stepped minute field is NOT a bare star — but minute has no union rule,
    // so what matters is the value set. (domStar/dowStar only track dom/dow.)
  });

  test("ranges expand inclusively (1-5)", () => {
    const p = parseCron("0 9 * * 1-5");
    expect([...p.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(p.dowStar).toBe(false);
  });

  test("comma lists union their elements (0,30)", () => {
    const p = parseCron("0,30 * * * *");
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 30]);
  });

  test("range + step (0-30/10)", () => {
    const p = parseCron("0-30/10 * * * *");
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 10, 20, 30]);
  });

  test("bare number with step extends to field max (5/2 in hour)", () => {
    const p = parseCron("0 5/2 * * *");
    expect([...p.hour].sort((a, b) => a - b)).toEqual([5, 7, 9, 11, 13, 15, 17, 19, 21, 23]);
  });
});

describe("parseCron — error cases", () => {
  test("wrong field count throws", () => {
    expect(() => parseCron("* * * *")).toThrow(CronParseError);
    expect(() => parseCron("* * * * * *")).toThrow(/5 fields/);
  });
  test("out-of-range value throws (minute 60)", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
  });
  test("out-of-range hour throws (24)", () => {
    expect(() => parseCron("0 24 * * *")).toThrow(/out of range/);
  });
  test("dow 7 is rejected in v1 (Sunday is 0 only)", () => {
    expect(() => parseCron("0 0 * * 7")).toThrow(/out of range/);
  });
  test("non-numeric value throws", () => {
    expect(() => parseCron("MON * * * *")).toThrow(CronParseError);
  });
  test("descending range throws", () => {
    expect(() => parseCron("0 9-5 * * *")).toThrow(/descending/);
  });
  test("zero step throws", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
  });
  test("empty field throws", () => {
    expect(() => parseCron("0 , * * *")).toThrow(CronParseError);
  });
});

describe("nextRunAfter — strict advance + concrete schedules", () => {
  const LA = "America/Los_Angeles";

  test("'53 7 * * *' in LA returns 07:53 LA, strictly after `from`", () => {
    // from = 2026-06-17 06:00 LA → next is 07:53 the SAME day.
    const from = new Date("2026-06-17T13:00:00Z"); // 06:00 LA (PDT, UTC-7)
    const next = nextRunAfter("53 7 * * *", LA, from)!;
    expect(next).not.toBeNull();
    const w = wall(next, LA);
    expect(w.h).toBe(7);
    expect(w.mi).toBe(53);
    expect(w.d).toBe(17);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  test("'53 7 * * *' when already past today rolls to tomorrow", () => {
    const from = new Date("2026-06-17T15:00:00Z"); // 08:00 LA, past 07:53
    const next = nextRunAfter("53 7 * * *", LA, from)!;
    const w = wall(next, LA);
    expect(w.h).toBe(7);
    expect(w.mi).toBe(53);
    expect(w.d).toBe(18); // tomorrow
  });

  test("hourly '0 * * * *' returns the next top-of-hour", () => {
    const from = new Date("2026-06-17T10:17:00Z");
    const next = nextRunAfter("0 * * * *", "UTC", from)!;
    expect(next.toISOString()).toBe("2026-06-17T11:00:00.000Z");
  });

  test("never returns `from` itself even when `from` is an exact match (no double-fire)", () => {
    // from is exactly 11:00:00 UTC, which '0 * * * *' matches — must advance to 12:00.
    const from = new Date("2026-06-17T11:00:00Z");
    const next = nextRunAfter("0 * * * *", "UTC", from)!;
    expect(next.toISOString()).toBe("2026-06-17T12:00:00.000Z");
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  test("'*​/15 * * * *' steps to the next quarter-hour", () => {
    const from = new Date("2026-06-17T10:07:30Z");
    const next = nextRunAfter("*/15 * * * *", "UTC", from)!;
    expect(next.toISOString()).toBe("2026-06-17T10:15:00.000Z");
  });

  test("'0 9 * * 1-5' (weekday 9am) skips the weekend", () => {
    // 2026-06-19 is a Friday; from = Fri 10:00 UTC → next match is Mon 09:00.
    const fri = new Date("2026-06-19T10:00:00Z");
    expect(wall(fri, "UTC").wd).toBe(5); // Friday
    const next = nextRunAfter("0 9 * * 1-5", "UTC", fri)!;
    const w = wall(next, "UTC");
    expect(w.wd).toBe(1); // Monday
    expect(w.h).toBe(9);
    expect(w.d).toBe(22); // 2026-06-22 is the Monday
  });

  test("end-of-month rollover ('0 0 1 * *' → first of next month)", () => {
    const from = new Date("2026-01-31T12:00:00Z");
    const next = nextRunAfter("0 0 1 * *", "UTC", from)!;
    expect(next.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  test("end-of-year rollover ('0 0 1 1 *' → next Jan 1)", () => {
    const from = new Date("2026-12-31T23:59:00Z");
    const next = nextRunAfter("0 0 1 1 *", "UTC", from)!;
    expect(next.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  test("leap day ('0 0 29 2 *' fires on Feb 29 2028, skips non-leap years)", () => {
    // From mid-2026, the next Feb 29 is in 2028 (2026/2027 are not leap years).
    const from = new Date("2026-06-01T00:00:00Z");
    const next = nextRunAfter("0 0 29 2 *", "UTC", from)!;
    const w = wall(next, "UTC");
    expect(w.y).toBe(2028);
    expect(w.mo).toBe(2);
    expect(w.d).toBe(29);
  });

  test("dom AND dow both restricted → matches on EITHER (cron union rule)", () => {
    // '0 0 13 * 5' = midnight on the 13th OR any Friday. From 2026-02-01:
    // the first Friday (the 6th) comes before the 13th.
    const from = new Date("2026-02-01T00:00:00Z");
    const next = nextRunAfter("0 0 13 * 5", "UTC", from)!;
    const w = wall(next, "UTC");
    // 2026-02-06 is a Friday → that's the union hit before the 13th.
    expect(w.d).toBe(6);
    expect(w.wd).toBe(5);
  });

  test("a tz offset actually shifts the fire instant (UTC vs LA differ)", () => {
    const from = new Date("2026-06-17T00:00:00Z");
    const utc = nextRunAfter("0 12 * * *", "UTC", from)!;
    const la = nextRunAfter("0 12 * * *", LA, from)!;
    // 12:00 LA (PDT, UTC-7) is 19:00Z; 12:00 UTC is 12:00Z. They must differ by 7h.
    expect(utc.toISOString()).toBe("2026-06-17T12:00:00.000Z");
    expect(la.toISOString()).toBe("2026-06-17T19:00:00.000Z");
  });

  test("defaults: no tz uses local zone; no `from` uses now (returns a future instant)", () => {
    const next = nextRunAfter("* * * * *");
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  test("an invalid IANA tz throws (not silently UTC)", () => {
    expect(() => nextRunAfter("* * * * *", "Not/AZone", new Date())).toThrow();
  });
});

describe("nextRunAfter — DST behavior (documented v1)", () => {
  const LA = "America/Los_Angeles";

  test("spring-forward: a 02:30 spec is SKIPPED on the gap day, fires next day", () => {
    // 2026-03-08 is the US spring-forward (02:00 → 03:00 PST→PDT). 02:30 never
    // occurs that day. from = 2026-03-08 00:00 LA.
    const from = new Date("2026-03-08T08:00:00Z"); // 00:00 LA (PST, UTC-8)
    const next = nextRunAfter("30 2 * * *", LA, from)!;
    const w = wall(next, LA);
    // The 02:30 wall time does not exist on the 8th → first match is the 9th.
    expect(w.d).toBe(9);
    expect(w.h).toBe(2);
    expect(w.mi).toBe(30);
  });

  test("fall-back: a 01:30 spec yields a valid instant (both repeats are real instants)", () => {
    // 2026-11-01 is the US fall-back (02:00 → 01:00 PDT→PST). 01:30 occurs twice.
    // We only assert nextRunAfter returns a real matching instant (v1 fires on the
    // first one it walks to); the dual-fire behavior is documented, not policed.
    const from = new Date("2026-11-01T07:00:00Z"); // 00:00 LA (PDT, UTC-7)
    const next = nextRunAfter("30 1 * * *", LA, from)!;
    const w = wall(next, LA);
    expect(w.d).toBe(1);
    expect(w.h).toBe(1);
    expect(w.mi).toBe(30);
  });
});

// ===========================================================================
// REGRESSION GUARD — day-skip in a NEGATIVE-OFFSET timezone (the morning-miss bug).
//
// The day-skip fast path (taken whenever dom/dow restricts the date) used to jump
// to UTC-midnight, which in America/Los_Angeles is ~17:00 of the wall-day; the
// forward-only crawl then started in the EVENING and could never reach that
// wall-day's MORNING. Result: morning weekday/sparse-dom jobs in PT were missed
// (skipped to a later day) or never fired at all (returned null). These cases
// FAIL on the old UTC-midnight code and PASS on the wall-midnight fix. They're
// all in a negative-offset tz (where UTC-midnight ≠ wall-midnight) — the only
// place the bug is visible — and they all exercise the day-skip (restricted dom
// or dow), unlike the `*`-dom/dow cases above which never enter the skip path.
// ===========================================================================
describe("nextRunAfter — day-skip in a negative-offset tz (morning-miss regression)", () => {
  const LA = "America/Los_Angeles";

  test("'0 9 * * 1-5' from a Saturday → MONDAY 09:00 PT (not Tuesday — the morning isn't skipped)", () => {
    // 2026-06-20 is a Saturday. The next weekday-9am is MONDAY the 22nd at 09:00 PT.
    // The OLD code skipped Monday's morning (landed at Sun 17:00 wall after the
    // UTC-midnight jump, crawled past Mon 09:00 having started Monday at 17:00…),
    // returning TUESDAY. The fix returns Monday.
    const sat = new Date("2026-06-20T18:00:00Z"); // ~11:00 Sat LA
    expect(wall(sat, LA).wd).toBe(6); // Saturday
    const next = nextRunAfter("0 9 * * 1-5", LA, sat)!;
    expect(next).not.toBeNull();
    const w = wall(next, LA);
    expect(w.wd).toBe(1); // MONDAY (not 2/Tuesday)
    expect(w.h).toBe(9);
    expect(w.mi).toBe(0);
    expect(w.d).toBe(22); // 2026-06-22 is the Monday
  });

  test("'0 6 1 * *' (sparse dom, morning) in PT → the 1st at 06:00 PT, NOT null", () => {
    // The OLD code returned NULL here: every month's 1st has its morning stranded
    // behind the UTC-midnight jump, so the sparse-dom search exhausted → null. The
    // canonical "any sparse-dom morning job in PT never runs" failure.
    const midMonth = new Date("2026-06-15T19:00:00Z"); // ~12:00 Jun 15 LA
    const next = nextRunAfter("0 6 1 * *", LA, midMonth);
    expect(next).not.toBeNull();
    const w = wall(next!, LA);
    expect(w.d).toBe(1);
    expect(w.h).toBe(6);
    expect(w.mi).toBe(0);
    expect(w.mo).toBe(7); // the next 1st is July 1
  });

  test("'30 7 15 * *' (restricted-dom morning generic) in PT → the 15th at 07:30 PT", () => {
    const from = new Date("2026-06-10T19:00:00Z"); // ~12:00 Jun 10 LA, before the 15th
    const next = nextRunAfter("30 7 15 * *", LA, from);
    expect(next).not.toBeNull();
    const w = wall(next!, LA);
    expect(w.d).toBe(15);
    expect(w.h).toBe(7);
    expect(w.mi).toBe(30);
    expect(w.mo).toBe(6); // June 15
  });

  test("the canonical morning weave '53 7 * * 1-5' (weekday, restricted dow) fires Mon 07:53 PT", () => {
    // dow restricted → day-skip path active (unlike the all-`*` '53 7 * * *' which
    // works even on the buggy code). From a Sunday → Monday 07:53 PT.
    const sun = new Date("2026-06-21T18:00:00Z"); // ~11:00 Sun LA
    expect(wall(sun, LA).wd).toBe(0); // Sunday
    const next = nextRunAfter("53 7 * * 1-5", LA, sun)!;
    const w = wall(next, LA);
    expect(w.wd).toBe(1); // Monday
    expect(w.h).toBe(7);
    expect(w.mi).toBe(53);
  });

  test("strictly-after still holds across a negative-offset day-skip", () => {
    // from is exactly a matching morning instant; must advance to the NEXT match.
    const at0900 = new Date("2026-06-22T16:00:00Z"); // 09:00 Mon LA (PDT) — matches '0 9 * * 1-5'
    expect(wall(at0900, LA)).toMatchObject({ wd: 1, h: 9, mi: 0 });
    const next = nextRunAfter("0 9 * * 1-5", LA, at0900)!;
    expect(next.getTime()).toBeGreaterThan(at0900.getTime());
    const w = wall(next, LA);
    expect(w.wd).toBe(2); // the next weekday match is Tuesday 09:00
    expect(w.h).toBe(9);
  });

  test("day-skip works in a POSITIVE-offset tz too (Tokyo, UTC+9) — morning not skipped", () => {
    // Symmetric check: in a positive-offset zone UTC-midnight is ~09:00 wall, a
    // different failure shape; assert the fix is correct here as well.
    const TOKYO = "Asia/Tokyo";
    const from = new Date("2026-06-14T03:00:00Z"); // 12:00 Jun 14 Tokyo
    const next = nextRunAfter("0 6 15 * *", TOKYO, from)!;
    const w = wall(next, TOKYO);
    expect(w.d).toBe(15);
    expect(w.h).toBe(6);
    expect(w.mi).toBe(0);
  });
});

describe("nextRunAfter — accepts a pre-parsed ParsedCron", () => {
  test("reuses a ParsedCron without re-parsing", () => {
    const parsed: ParsedCron = parseCron("0 0 * * *");
    const next = nextRunAfter(parsed, "UTC", new Date("2026-06-17T12:00:00Z"))!;
    expect(next.toISOString()).toBe("2026-06-18T00:00:00.000Z");
  });
});
