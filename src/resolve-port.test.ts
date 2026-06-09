/**
 * Port-resolution tests (channel#41).
 *
 * The hub supervisor injects `PORT` from the module's services.json `entry.port`
 * and PROBES that same port for readiness (and reverse-proxies `/channel/*` to
 * it). Pre-#41 the daemon read only `PARACHUTE_CHANNEL_PORT` (default 1941), so
 * it ignored the supervisor's `PORT` and could bind a different port than the
 * supervisor probed — the supervisor then reported `started_but_unbound` and the
 * proxy routed to a dead port. `resolvePort` now honors `PORT` first so the bound
 * port (which is also the self-registered port) matches what the supervisor
 * assigned.
 */
import { describe, test, expect } from "bun:test";
import { resolvePort } from "./daemon.ts";

describe("resolvePort — PORT > PARACHUTE_CHANNEL_PORT > 1941", () => {
  test("honors the supervisor-injected PORT first", () => {
    expect(resolvePort({ PORT: "19415" })).toBe(19415);
  });

  test("PORT wins even when PARACHUTE_CHANNEL_PORT is also set", () => {
    expect(resolvePort({ PORT: "1941", PARACHUTE_CHANNEL_PORT: "19415" })).toBe(1941);
  });

  test("falls back to PARACHUTE_CHANNEL_PORT when PORT is unset (back-compat)", () => {
    expect(resolvePort({ PARACHUTE_CHANNEL_PORT: "2025" })).toBe(2025);
  });

  test("falls back to the canonical 1941 default when neither is set", () => {
    expect(resolvePort({})).toBe(1941);
  });

  test("an EMPTY PORT='' falls through to PARACHUTE_CHANNEL_PORT (|| not ??)", () => {
    // With `??` an empty string is "defined" → parseInt("") = NaN → bind port 0.
    // `||` skips the empty string to the next tier.
    expect(resolvePort({ PORT: "", PARACHUTE_CHANNEL_PORT: "2000" })).toBe(2000);
  });

  test("a non-numeric PORT='abc' falls through to the canonical default", () => {
    // parseInt("abc") = NaN → falsy → falls through past PARACHUTE_CHANNEL_PORT
    // (also unset here) to 1941. No garbage port.
    expect(resolvePort({ PORT: "abc" })).toBe(1941);
  });
});
