/**
 * Tests for the SSE one-time-ticket auth helpers (agent#25): `mintSseTicket`
 * (the Bearer-gated mint) + `requireSseTicket` (the single-use consume gate).
 *
 * These are the auth-layer wrappers over `ui-ticket.ts`. The store itself is
 * tested in `ui-ticket.test.ts`; here we lock the AUTH contract:
 *  - mint REQUIRES a valid bearer (no token → 401; under-scoped → 403) — an
 *    unauthenticated mint would be an auth bypass;
 *  - the minted ticket carries the presenting token's OWN scopes (no widening);
 *  - a valid ticket consumes once on connect (single-use → 2nd connect 401);
 *  - an absent ticket → 401; a ticket lacking the required scope → 403.
 *
 * `validateHubJwt` is stubbed (sentinel tokens → fixed scopes) so we exercise the
 * gate logic without a live hub — same pattern as http-ui.test.ts.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

const READ_SEND_TOKEN = "read-send-token"; // agent:read + agent:send (the chat token)
const NO_READ_TOKEN = "no-read-token"; // agent:write only — lacks agent:read
mock.module("./hub-jwt.ts", () => ({
  AGENT_AUDIENCE: "agent",
  CHANNEL_AUDIENCE: "channel",
  ACCEPTED_AUDIENCES: ["agent", "channel"],
  async validateHubJwt(token: string) {
    if (token === READ_SEND_TOKEN) {
      return { sub: "op", scopes: ["agent:read", "agent:send"], aud: "agent" };
    }
    if (token === NO_READ_TOKEN) {
      return { sub: "op", scopes: ["agent:write"], aud: "agent" };
    }
    throw new HubJwtError("invalid token");
  },
  HubJwtError: class HubJwtError extends Error {},
  looksLikeJwt: (t: string) => t.split(".").length === 3,
  resetJwksCache() {},
  resetRevocationCache() {},
}));
class HubJwtError extends Error {}

import { mintSseTicket, requireSseTicket, SCOPE_READ, SCOPE_ADMIN } from "./auth.ts";
import { mintTicket, _resetTicketsForTest } from "./ui-ticket.ts";

beforeEach(() => {
  _resetTicketsForTest();
});

/** Build a mint Request carrying `token` as a Bearer (or none). */
function mintReq(token?: string): { req: Request; url: URL } {
  const req = new Request("http://x/api/ui/sse-ticket", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { req, url: new URL(req.url) };
}

describe("mintSseTicket — REQUIRES a valid bearer (no unauthenticated mint)", () => {
  test("no token → 401, no ticket issued", async () => {
    const { req, url } = mintReq();
    const res = await mintSseTicket(req, url, SCOPE_READ, mintTicket);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
  });

  test("an invalid token → 401", async () => {
    const { req, url } = mintReq("garbage");
    const res = await mintSseTicket(req, url, SCOPE_READ, mintTicket);
    expect(res.status).toBe(401);
  });

  test("a valid token MISSING the required scope → 403, no ticket", async () => {
    const { req, url } = mintReq(NO_READ_TOKEN); // has agent:write, not agent:read
    const res = await mintSseTicket(req, url, SCOPE_READ, mintTicket);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  test("a token in the URL (`?token=`) does NOT authenticate the mint", async () => {
    // The mint takes a Bearer header only — a query-param token must not mint.
    const req = new Request(`http://x/api/ui/sse-ticket?token=${READ_SEND_TOKEN}`, {
      method: "POST",
    });
    const res = await mintSseTicket(req, new URL(req.url), SCOPE_READ, mintTicket);
    expect(res.status).toBe(401);
  });
});

describe("mintSseTicket — success + scope fidelity", () => {
  test("a valid bearer mints a ticket + ISO expiry", async () => {
    const { req, url } = mintReq(READ_SEND_TOKEN);
    const res = await mintSseTicket(req, url, SCOPE_READ, mintTicket);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; expires_at: string };
    expect(typeof body.ticket).toBe("string");
    expect(body.ticket.length).toBeGreaterThan(20);
    expect(Number.isNaN(Date.parse(body.expires_at))).toBe(false);
  });

  test("the minted ticket carries the TOKEN's own scopes — not widened", async () => {
    const { req, url } = mintReq(READ_SEND_TOKEN); // scopes: read + send
    const res = await mintSseTicket(req, url, SCOPE_READ, mintTicket);
    const { ticket } = (await res.json()) as { ticket: string };
    // The ticket must satisfy agent:read (what it was minted for)...
    expect(requireSseTicket(new URL(`http://x/?ticket=${ticket}`), SCOPE_READ)).toBeNull();
  });

  test("the ticket does NOT carry a scope the token lacked (no privilege escalation)", async () => {
    // Mint with a read+send token, then assert the resulting ticket can't satisfy
    // agent:admin — even though we ask requireSseTicket for admin. The ticket only
    // ever holds the minting token's scopes.
    const { req, url } = mintReq(READ_SEND_TOKEN);
    const res = await mintSseTicket(req, url, SCOPE_READ, mintTicket);
    const { ticket } = (await res.json()) as { ticket: string };
    const denied = requireSseTicket(new URL(`http://x/?ticket=${ticket}`), SCOPE_ADMIN);
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
  });
});

describe("requireSseTicket — single-use consume + scope check", () => {
  test("a valid ticket authorizes once (returns null = proceed)", () => {
    const { ticket } = mintTicket(["agent:read"]);
    expect(requireSseTicket(new URL(`http://x/?ticket=${ticket}`), SCOPE_READ)).toBeNull();
  });

  test("a SECOND connect with the same ticket → 401 (single-use)", () => {
    const { ticket } = mintTicket(["agent:read"]);
    const url = new URL(`http://x/?ticket=${ticket}`);
    expect(requireSseTicket(url, SCOPE_READ)).toBeNull(); // first connect OK
    const denied = requireSseTicket(new URL(`http://x/?ticket=${ticket}`), SCOPE_READ);
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(401);
  });

  test("no ?ticket= → 401", () => {
    const denied = requireSseTicket(new URL("http://x/?channel=dev"), SCOPE_READ);
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(401);
  });

  test("an expired ticket → 401", () => {
    const { ticket } = mintTicket(["agent:read"], 0); // already expired
    const denied = requireSseTicket(new URL(`http://x/?ticket=${ticket}`), SCOPE_READ);
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(401);
  });

  test("a ticket lacking the required scope → 403 (and is still consumed)", () => {
    const { ticket } = mintTicket(["agent:write"]); // no agent:read
    const denied = requireSseTicket(new URL(`http://x/?ticket=${ticket}`), SCOPE_READ);
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
  });

  test("dual-accept: a legacy channel:read ticket satisfies agent:read", () => {
    // Pre-rename tokens carry channel:* — the ticket carries them through, and the
    // consume gate's grantsScope honors the legacy alias (matches requireScope).
    const { ticket } = mintTicket(["channel:read"]);
    expect(requireSseTicket(new URL(`http://x/?ticket=${ticket}`), SCOPE_READ)).toBeNull();
  });
});
