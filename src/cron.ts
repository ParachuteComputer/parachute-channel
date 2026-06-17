/**
 * A tiny, dependency-free cron evaluator for the runner (design
 * `2026-06-17-runner-scheduled-agent-turns.md`).
 *
 * Scope (v1, deliberately narrow):
 *   - FIVE fields only: `minute hour day-of-month month day-of-week`.
 *   - Each field supports `*`, `*​/n` (step), `a-b` (range), `a-b/n` (range+step),
 *     and `a,b,c` (comma list, each element any of the above).
 *   - NO seconds field, NO macros (`@daily`), NO names (`MON`, `JAN`) — numeric only.
 *   - day-of-week: 0-6, Sunday = 0. (7 is NOT accepted as Sunday in v1 — keep the
 *     accepted set tight and unambiguous.)
 *
 * Day-of-month / day-of-week semantics follow standard cron: if BOTH `dom` and
 * `dow` are restricted (neither is `*`), a day matches when EITHER matches (the
 * union). If only one is restricted, only that one constrains. This is the Vixie
 * cron rule and the one operators expect from "0 9 * * 1-5".
 *
 * Timezone correctness — the #1 risk. `nextRunAfter` evaluates the cron fields
 * against the WALL CLOCK in a given IANA timezone (default: the daemon's local
 * tz). It does this by walking forward minute-by-minute from `from`, projecting
 * each candidate instant into the target tz via `Intl.DateTimeFormat` (Bun ships
 * full ICU), and testing the projected wall-clock fields against the cron sets.
 * This is O(minutes-until-next-match); bounded by a hard cap (~366 days of
 * minutes) so a pathological/never-matching spec returns null instead of looping
 * forever. The minute-walk is simple and DST-honest: because we read the wall
 * clock the OS/ICU reports for each real instant, a spring-forward gap simply has
 * no matching instant (the wall time never occurs → that fire is skipped that
 * day), and a fall-back repeat can match twice (both 01:30s exist as distinct
 * instants → both fire). v1 accepts that behavior rather than inventing a policy;
 * see the comment at `nextRunAfter`.
 */

/** A parsed cron expression: the allowed-value Sets per field, plus restriction flags. */
export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  /** day-of-month (1-31). */
  dom: Set<number>;
  /** month (1-12). */
  month: Set<number>;
  /** day-of-week (0-6, Sun=0). */
  dow: Set<number>;
  /** Whether `dom` was `*` (unrestricted) — drives the dom/dow union rule. */
  domStar: boolean;
  /** Whether `dow` was `*` (unrestricted) — drives the dom/dow union rule. */
  dowStar: boolean;
}

/** Inclusive numeric bounds for each of the five fields (v1: numeric only). */
const FIELD_BOUNDS: ReadonlyArray<{ min: number; max: number; name: string }> = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day-of-week" },
];

/** Thrown by `parseCron` on a malformed expression — callers map it to a 400. */
export class CronParseError extends Error {}

/**
 * Parse ONE field token (between the spaces) into the set of allowed integers in
 * `[min, max]`. Supports `*`, `*​/n`, `a`, `a-b`, `a-b/n`, and comma lists of any
 * of those. Throws `CronParseError` on anything out of range or malformed.
 */
function parseField(token: string, min: number, max: number, fieldName: string): { set: Set<number>; star: boolean } {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new CronParseError(`cron ${fieldName}: empty field`);
  }
  const set = new Set<number>();
  // A field is `*` only if EVERY comma-element is `*` / `*​/n` over the full range.
  // We track whether the literal token was a bare `*` (no list, no step) for the
  // dom/dow union rule — a stepped `*​/2` is a restriction, not "unrestricted".
  const star = trimmed === "*";

  for (const part of trimmed.split(",")) {
    const elem = part.trim();
    if (elem.length === 0) {
      throw new CronParseError(`cron ${fieldName}: empty list element in "${token}"`);
    }

    // Split off an optional step (`/n`).
    let rangePart = elem;
    let step = 1;
    const slash = elem.indexOf("/");
    if (slash >= 0) {
      rangePart = elem.slice(0, slash);
      const stepStr = elem.slice(slash + 1);
      if (!/^\d+$/.test(stepStr)) {
        throw new CronParseError(`cron ${fieldName}: bad step "/${stepStr}" in "${token}"`);
      }
      step = parseInt(stepStr, 10);
      if (step <= 0) {
        throw new CronParseError(`cron ${fieldName}: step must be >= 1 in "${token}"`);
      }
    }

    // Resolve the range the step applies over.
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [aStr, bStr, ...rest] = rangePart.split("-");
      if (rest.length > 0 || aStr === undefined || bStr === undefined) {
        throw new CronParseError(`cron ${fieldName}: bad range "${rangePart}" in "${token}"`);
      }
      if (!/^\d+$/.test(aStr) || !/^\d+$/.test(bStr)) {
        throw new CronParseError(`cron ${fieldName}: non-numeric range "${rangePart}" in "${token}"`);
      }
      lo = parseInt(aStr, 10);
      hi = parseInt(bStr, 10);
      if (lo > hi) {
        throw new CronParseError(`cron ${fieldName}: descending range "${rangePart}" in "${token}"`);
      }
    } else {
      // A single number, optionally with a step (`5/2` means 5,7,9,… to max — the
      // step extends a bare number to the field max, matching common cron impls).
      if (!/^\d+$/.test(rangePart)) {
        throw new CronParseError(`cron ${fieldName}: non-numeric value "${rangePart}" in "${token}"`);
      }
      lo = parseInt(rangePart, 10);
      hi = slash >= 0 ? max : lo;
    }

    if (lo < min || hi > max) {
      throw new CronParseError(
        `cron ${fieldName}: value out of range (${lo}-${hi}); allowed ${min}-${max}`,
      );
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }

  if (set.size === 0) {
    throw new CronParseError(`cron ${fieldName}: no values matched in "${token}"`);
  }
  return { set, star };
}

/**
 * Parse a 5-field cron expression into a {@link ParsedCron}. Throws
 * `CronParseError` (message names the offending field) on anything malformed.
 * Whitespace between fields is any run of spaces/tabs.
 */
export function parseCron(expr: string): ParsedCron {
  if (typeof expr !== "string") {
    throw new CronParseError("cron expression must be a string");
  }
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      `cron expression must have exactly 5 fields (min hour dom mon dow); got ${fields.length}: "${expr}"`,
    );
  }
  const minute = parseField(fields[0]!, FIELD_BOUNDS[0]!.min, FIELD_BOUNDS[0]!.max, "minute");
  const hour = parseField(fields[1]!, FIELD_BOUNDS[1]!.min, FIELD_BOUNDS[1]!.max, "hour");
  const dom = parseField(fields[2]!, FIELD_BOUNDS[2]!.min, FIELD_BOUNDS[2]!.max, "day-of-month");
  const month = parseField(fields[3]!, FIELD_BOUNDS[3]!.min, FIELD_BOUNDS[3]!.max, "month");
  const dow = parseField(fields[4]!, FIELD_BOUNDS[4]!.min, FIELD_BOUNDS[4]!.max, "day-of-week");
  return {
    minute: minute.set,
    hour: hour.set,
    dom: dom.set,
    month: month.set,
    dow: dow.set,
    domStar: dom.star,
    dowStar: dow.star,
  };
}

/** The wall-clock fields of an instant projected into a given IANA timezone. */
interface WallClock {
  minute: number;
  hour: number;
  /** day-of-month (1-31). */
  dom: number;
  /** month (1-12). */
  month: number;
  /** day-of-week (0-6, Sun=0). */
  dow: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Project a real instant (`Date`) into its wall-clock fields IN `tz` via
 * `Intl.DateTimeFormat`. Throws if `tz` is not a valid IANA zone (the formatter
 * throws a RangeError — we let it propagate so `nextRunAfter`'s caller surfaces
 * "bad timezone" rather than silently using UTC).
 */
function wallClockInTz(date: Date, tz: string): WallClock {
  // `en-US` with explicit numeric parts + `weekday: short` gives stable,
  // locale-independent token shapes we can parse back to integers.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(date);

  const get = (type: string): string => {
    const p = parts.find((x) => x.type === type);
    return p ? p.value : "";
  };

  // `hour12: false` can emit "24" for midnight in some ICU versions; normalize.
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0;

  return {
    minute: parseInt(get("minute"), 10),
    hour,
    dom: parseInt(get("day"), 10),
    month: parseInt(get("month"), 10),
    dow: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** Does a wall clock satisfy the parsed cron? (applies the dom/dow union rule). */
function matches(parsed: ParsedCron, wc: WallClock): boolean {
  if (!parsed.minute.has(wc.minute)) return false;
  if (!parsed.hour.has(wc.hour)) return false;
  if (!parsed.month.has(wc.month)) return false;

  // Standard cron dom/dow rule: if BOTH are restricted, match on EITHER (union).
  // If only one is restricted, only that one constrains. If both are `*`, both
  // pass trivially.
  const domOk = parsed.dom.has(wc.dom);
  const dowOk = parsed.dow.has(wc.dow);
  if (!parsed.domStar && !parsed.dowStar) {
    return domOk || dowOk;
  }
  if (!parsed.domStar) return domOk;
  if (!parsed.dowStar) return dowOk;
  return true; // both `*`
}

/** Does ONLY the date part (month + dom/dow union) match? Used for coarse day-skip. */
function dateMatches(parsed: ParsedCron, wc: WallClock): boolean {
  if (!parsed.month.has(wc.month)) return false;
  const domOk = parsed.dom.has(wc.dom);
  const dowOk = parsed.dow.has(wc.dow);
  if (!parsed.domStar && !parsed.dowStar) return domOk || dowOk;
  if (!parsed.domStar) return domOk;
  if (!parsed.dowStar) return dowOk;
  return true;
}

/**
 * The hard cap for the forward search, expressed in DAYS. A sparse spec like
 * "Feb 29" can legitimately be up to ~4 years out; cap at 5 years so it resolves
 * while a truly never-matching spec (impossible with numeric-only fields, but
 * cheap insurance) returns null instead of looping. Day-coarse skipping keeps the
 * search O(days-until-match) + O(minutes-within-the-day), not O(total minutes).
 */
const MAX_LOOKAHEAD_DAYS = 5 * 366;

/**
 * Return the next instant STRICTLY AFTER `from` whose wall-clock-in-`tz` matches
 * `expr`, or `null` if no match within ~5 years (effectively a never-firing spec).
 *
 * STRICTLY AFTER is load-bearing: the runner persists `nextRunAt` and re-derives
 * forward from a fired instant, so returning `from` itself would double-fire on
 * the same minute. We advance to the start of the NEXT minute first, then search
 * forward at cron's one-minute resolution.
 *
 * Search strategy (so a sparse spec like Feb 29 doesn't take a million minute
 * steps): a single FORWARD-ONLY minute cursor with a DAY-SKIP fast path. On each
 * step we read the cursor's wall clock; if the cursor's wall DATE (month + dom/dow
 * union) can't match, we skip the cursor forward to the next wall-midnight in one
 * jump instead of crawling minute-by-minute through the dead day. On a date that
 * DOES qualify, we walk its minutes testing the full predicate. So the cost is
 * O(days-to-match) date-checks + O(minutes-in-the-few-matching-days) minute-checks.
 *
 * Forward-only is what keeps strictly-after honest: the cursor starts at the first
 * minute AFTER `from` and never rewinds, so the first match it reaches is the
 * earliest instant > `from`. (We deliberately do NOT rewind to wall-midnight on
 * the matching day — that could surface a match earlier than `from`.)
 *
 * Timezone + DST: each candidate is a real instant; we read the wall clock the
 * target tz reports for it. So a spring-forward gap (e.g. 02:00→03:00) has no
 * matching instant for a 02:30 spec that day — it's simply skipped (the next
 * day fires). A fall-back repeat (01:30 occurring twice) yields two distinct
 * matching instants — both fire. v1 documents and accepts this rather than
 * inventing skip/dedup policy; jobs are coarse ("daily 8am"), and the
 * fire-once-on-miss catch-up in the runner bounds any practical surprise.
 *
 * The day-skip advances to the next WALL-midnight (00:00 of the next wall-day IN
 * `zone`), computed from the wall clock we already read — NOT to UTC-midnight. This
 * is load-bearing in a negative-offset zone: UTC-midnight there is ~17:00 of the
 * wall-day, so jumping to it would strand the forward-only cursor in the *evening*
 * and the crawl could never reach that wall-day's MORNING (a `0 9 * * *` would be
 * missed; a sparse-dom morning job would never fire). Instead we step the cursor by
 * the minutes from this wall-instant to the next wall-midnight
 * (`(23-hour)*60 + (60-minute)`), which lands at/just-before the next wall-day's
 * 00:00. A DST transition can make the landing 23:00 or 01:00 of the wall-day — the
 * main loop self-corrects with a few minute steps, and it never lands in the
 * evening. The minute-walk remains the source of truth, so no offset arithmetic can
 * desync it. (Each skip advances ≥1 minute, so the search always terminates.)
 *
 * `from` defaults to now; `tz` defaults to the daemon's local timezone (resolved
 * from `Intl.DateTimeFormat().resolvedOptions().timeZone`).
 */
export function nextRunAfter(expr: string | ParsedCron, tz?: string, from: Date = new Date()): Date | null {
  const parsed = typeof expr === "string" ? parseCron(expr) : expr;
  const zone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Validate the zone once (and fail loudly) by projecting `from`. An invalid IANA
  // zone throws RangeError here, which propagates to the caller as a clear error.
  wallClockInTz(from, zone);

  // Start at the top of the NEXT minute after `from` (strictly-after + minute
  // resolution: zero the seconds/ms and step one minute past `from`'s minute).
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  // Bound the search by DATE-CHECKS (one per distinct wall-day we touch), so a
  // sparse "Feb 29" still resolves while a never-matching spec terminates. We
  // count days touched, not minutes, since the day-skip collapses dead days.
  let daysTouched = 0;
  let lastSkipKey = "";

  // Cap the total minute steps generously: matching days are few, and each gets a
  // bounded (~25h) minute scan; a hard ceiling is belt-and-suspenders against an
  // infinite loop. 5y of days × ~1500 min is the theoretical worst case, but the
  // day-skip means we never get near it for real specs.
  const MAX_MINUTE_STEPS = MAX_LOOKAHEAD_DAYS * 24 * 60;

  for (let i = 0; i < MAX_MINUTE_STEPS; i++) {
    const wc = wallClockInTz(cursor, zone);
    if (dateMatches(parsed, wc)) {
      if (matches(parsed, wc)) return new Date(cursor.getTime());
      // Date qualifies but this minute/hour doesn't — crawl one minute.
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
      continue;
    }
    // Date does NOT qualify — DAY-SKIP: jump to the next WALL-midnight (00:00 of
    // the next wall-day IN `zone`), computed from the wall clock we already have.
    // Each distinct dead wall-day counts once against the lookahead bound.
    //
    // CRITICAL: we must advance to the next *wall*-midnight, NOT UTC-midnight. In a
    // negative-offset zone (e.g. America/Los_Angeles, UTC-7/8) UTC-midnight is
    // ~17:00 of the wall-day — so zeroing the UTC clock would land the cursor in
    // the *evening* of a wall-day and the forward-only crawl could never reach that
    // wall-day's MORNING (a `0 9 * * *` would be missed every cycle; a sparse-dom
    // morning job would exhaust the search → null). Stepping by the minutes from
    // THIS wall-instant to the next wall-midnight lands the cursor AT/BEFORE the
    // morning of the next wall-day, so the crawl reaches it.
    //
    // `mins` is the minutes remaining in this wall-day plus one (to roll into the
    // next day's 00:00): (23 - hour)*60 covers the whole hours left, +(60 - minute)
    // covers the rest of this minute's hour AND the +1 minute to cross midnight.
    // A DST transition can make the landing 23:00 or 01:00 of the wall-day rather
    // than exactly 00:00 — harmless: the main loop self-corrects with a few minute
    // steps, and it never lands at the evening (17:00) the UTC bump produced.
    const skipKey = `${wc.month}-${wc.dom}`;
    if (skipKey !== lastSkipKey) {
      lastSkipKey = skipKey;
      if (++daysTouched > MAX_LOOKAHEAD_DAYS) return null;
    }
    const mins = (23 - wc.hour) * 60 + (60 - wc.minute);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + mins);
  }
  return null;
}
