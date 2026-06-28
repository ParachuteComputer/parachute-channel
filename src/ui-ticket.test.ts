/**
 * Unit tests for the one-time SSE ticket store (agent#25) — the primitive that
 * lets a browser EventSource authenticate WITHOUT putting the hub JWT in the URL.
 *
 * The security contract this locks:
 *  - unguessable nonce (≥128 bits, base64url, URL-safe);
 *  - single-use (a second consume of the same ticket fails);
 *  - short TTL (an expired ticket fails);
 *  - scope fidelity (consume returns exactly what mint stored — never widened).
 *
 * Pure in-memory store, no JWKS / no network. `_resetTicketsForTest` isolates cases.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  mintTicket,
  consumeTicket,
  pruneExpiredTickets,
  _resetTicketsForTest,
  _ticketCountForTest,
  TICKET_TTL_MS,
} from "./ui-ticket.ts";

beforeEach(() => {
  _resetTicketsForTest();
});

describe("mintTicket", () => {
  test("returns an opaque base64url nonce with ≥128 bits of entropy", () => {
    const { ticket } = mintTicket(["agent:read"]);
    // base64url alphabet only (no +, /, =).
    expect(ticket).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes → ~43 base64url chars (well above the 22-char/128-bit floor).
    expect(ticket.length).toBeGreaterThanOrEqual(22);
  });

  test("each mint is distinct (random nonce)", () => {
    const a = mintTicket(["agent:read"]).ticket;
    const b = mintTicket(["agent:read"]).ticket;
    expect(a).not.toBe(b);
  });

  test("returns an absolute expiry ~TTL in the future", () => {
    const before = Date.now();
    const { expiresAt } = mintTicket(["agent:read"]);
    expect(expiresAt).toBeGreaterThanOrEqual(before + TICKET_TTL_MS - 50);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + TICKET_TTL_MS + 50);
  });
});

describe("consumeTicket — single-use", () => {
  test("a valid, unexpired ticket consumes once and returns its scopes", () => {
    const { ticket } = mintTicket(["agent:read", "agent:send"]);
    const got = consumeTicket(ticket);
    expect(got).not.toBeNull();
    expect(got!.scopes).toEqual(["agent:read", "agent:send"]);
  });

  test("a SECOND consume of the same ticket fails (single-use)", () => {
    const { ticket } = mintTicket(["agent:read"]);
    expect(consumeTicket(ticket)).not.toBeNull(); // first use OK
    expect(consumeTicket(ticket)).toBeNull(); // replay → rejected
  });

  test("an unknown / never-minted ticket fails", () => {
    expect(consumeTicket("not-a-real-ticket")).toBeNull();
  });

  test("a null/empty ticket fails", () => {
    expect(consumeTicket(null)).toBeNull();
    expect(consumeTicket(undefined)).toBeNull();
    expect(consumeTicket("")).toBeNull();
  });

  test("consuming deletes the entry (store shrinks)", () => {
    const { ticket } = mintTicket(["agent:read"]);
    expect(_ticketCountForTest()).toBe(1);
    consumeTicket(ticket);
    expect(_ticketCountForTest()).toBe(0);
  });
});

describe("consumeTicket — TTL", () => {
  test("an expired ticket fails (TTL=0) AND is removed (no lingering entry)", () => {
    const { ticket } = mintTicket(["agent:read"], 0); // already expired
    expect(consumeTicket(ticket)).toBeNull();
    // Even an expired hit deletes — a replayed expired ticket can't be retried.
    expect(_ticketCountForTest()).toBe(0);
  });

  test("a ticket consumed within its TTL succeeds", () => {
    const { ticket } = mintTicket(["agent:read"], 10_000);
    expect(consumeTicket(ticket)).not.toBeNull();
  });
});

describe("scope fidelity — no widening", () => {
  test("consume returns EXACTLY the scopes mint stored, nothing more", () => {
    const { ticket } = mintTicket(["agent:read"]);
    const got = consumeTicket(ticket);
    expect(got!.scopes).toEqual(["agent:read"]);
    expect(got!.scopes).not.toContain("agent:send");
    expect(got!.scopes).not.toContain("agent:admin");
  });

  test("mint copies the scope array (later caller mutation can't leak in)", () => {
    const scopes = ["agent:read"];
    const { ticket } = mintTicket(scopes);
    scopes.push("agent:admin"); // mutate the caller's array AFTER minting
    const got = consumeTicket(ticket);
    expect(got!.scopes).toEqual(["agent:read"]); // the ticket kept its own copy
  });
});

describe("pruneExpiredTickets", () => {
  test("drops expired entries, keeps live ones", () => {
    // Mint the live one FIRST, then the expired one — so the expired-mint's own
    // opportunistic prune (which runs BEFORE inserting) doesn't drop our live
    // entry, and both are present when we call pruneExpiredTickets directly.
    const live = mintTicket(["agent:read"], 10_000).ticket;
    mintTicket(["agent:read"], 0); // expired
    expect(_ticketCountForTest()).toBe(2);
    pruneExpiredTickets();
    expect(_ticketCountForTest()).toBe(1);
    expect(consumeTicket(live)).not.toBeNull();
  });

  test("mint opportunistically prunes so the store can't grow unbounded", () => {
    mintTicket(["agent:read"], 0); // expired, never consumed
    mintTicket(["agent:read"], 0); // expired, never consumed
    // A fresh mint prunes the two dead entries first → only the new one remains.
    mintTicket(["agent:read"], 10_000);
    expect(_ticketCountForTest()).toBe(1);
  });
});
