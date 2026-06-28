/**
 * One-time SSE tickets for the browser EventSource auth path (Layer 2, human↔UI).
 *
 * THE LEAK THIS CLOSES. A browser `EventSource` can't set an `Authorization`
 * header, so the agent SPA used to put the hub JWT directly in the SSE URL
 * (`/ui/events?token=<JWT>`, `/api/channels/<ch>/turn-events?token=<JWT>`). A
 * full bearer JWT in a URL lands in any access log, proxy log, browser history,
 * or network trace — mitigated before only by the token's ~10min TTL. That's a
 * credential-in-a-URL leak.
 *
 * THE FIX. Trade the JWT for an opaque, single-use, very-short-lived TICKET that
 * goes in the URL instead. The SPA presents its bearer JWT to a normal
 * authenticated endpoint (a Bearer header on a `fetch`, no leak), which mints a
 * ticket: a crypto-random 256-bit nonce (base64url) stored ONLY server-side in
 * this TTL'd map, carrying the validated scope(s)/audience of the presenting
 * token. The SPA opens `/ui/events?ticket=<nonce>`; the SSE consume path looks
 * the nonce up, CONSUMES it (deletes immediately — single-use), and establishes
 * the stream with the ticket's scopes. The JWT never appears in a URL or log.
 *
 * SECURITY PROPERTIES (all load-bearing):
 *  - Unguessable: 32 random bytes (256 bits) from `crypto.getRandomValues`,
 *    base64url-encoded. Far above the issue's 128-bit floor.
 *  - Single-use: `consume` DELETES the entry before returning, so a replayed
 *    ticket (a second connect, or a stolen URL) finds nothing → 401.
 *  - Short TTL: default 60s — just long enough to open the connection. An
 *    expired entry is treated as absent (and lazily pruned).
 *  - No scope widening: the ticket stores EXACTLY the scopes the minting token
 *    presented (validated upstream by `requireScope` before `mint` is called).
 *    The consume path asserts the required scope against the stored set, so a
 *    ticket can never authorize more than the JWT that minted it.
 *
 * This is process-local in-memory state by design (mirrors the daemon's other
 * in-process registries). The daemon is single-instance per machine; tickets
 * live ≤60s and are cheap to lose on restart (the SPA just re-mints). A
 * module-level singleton is used because the two consume paths live in different
 * modules (`http-ui.ts`'s `ingestHttp` and the daemon's turn-events route) and
 * both must hit the SAME store — `ingestHttp(req, url)` has no place to thread an
 * instance through. `_resetTicketsForTest` isolates unit tests.
 */

/** A minted ticket's server-side record. Never leaves the process. */
interface TicketRecord {
  /** The validated scopes carried from the minting JWT (the ceiling — never widened). */
  scopes: string[];
  /** Epoch ms after which the ticket is expired (treated as absent). */
  expiresAt: number;
}

/** Default ticket lifetime — long enough to open an EventSource, no longer. */
export const TICKET_TTL_MS = 60_000;

/** Nonce entropy: 32 bytes = 256 bits, well above the 128-bit floor. */
const TICKET_BYTES = 32;

/** The process-local ticket store. nonce → record. */
const tickets = new Map<string, TicketRecord>();

/** base64url-encode bytes (no padding) — URL-safe, no `+`/`/`/`=`. */
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint a single-use ticket carrying `scopes` (a COPY of the validated scopes from
 * the presenting JWT — the caller must have already authenticated + scope-checked
 * the token, so this never widens authority). Returns the opaque nonce + its
 * absolute expiry. TTL defaults to {@link TICKET_TTL_MS}.
 */
export function mintTicket(scopes: readonly string[], ttlMs = TICKET_TTL_MS): {
  ticket: string;
  expiresAt: number;
} {
  pruneExpiredTickets();
  const bytes = new Uint8Array(TICKET_BYTES);
  crypto.getRandomValues(bytes);
  const ticket = base64url(bytes);
  const expiresAt = Date.now() + ttlMs;
  tickets.set(ticket, { scopes: [...scopes], expiresAt });
  return { ticket, expiresAt };
}

/**
 * Consume a ticket: look it up, and if present + unexpired, DELETE it (single-use)
 * and return its scopes. Returns `null` for an absent / expired / already-consumed
 * ticket — the caller maps that to a 401. Deletion happens before return, so two
 * concurrent consumes of the same nonce can't both succeed.
 */
export function consumeTicket(ticket: string | null | undefined): { scopes: string[] } | null {
  if (!ticket) return null;
  const rec = tickets.get(ticket);
  if (!rec) return null;
  // Single-use: remove FIRST, so even an expired hit can't be retried and a
  // concurrent second consume finds nothing.
  tickets.delete(ticket);
  if (Date.now() >= rec.expiresAt) return null;
  return { scopes: rec.scopes };
}

/**
 * Drop every expired ticket. Called opportunistically on each mint so the map
 * can't grow unbounded if some tickets are never consumed; not on a timer (no
 * background work in a possibly-idle daemon). O(n) over a map that's tiny in
 * practice (≤ a handful of live tickets at 60s TTL).
 */
export function pruneExpiredTickets(now = Date.now()): void {
  for (const [k, rec] of tickets) {
    if (now >= rec.expiresAt) tickets.delete(k);
  }
}

/** Test seam: clear all tickets so unit tests start from a clean store. */
export function _resetTicketsForTest(): void {
  tickets.clear();
}

/** Test seam: the current live ticket count (asserts single-use deletion). */
export function _ticketCountForTest(): number {
  return tickets.size;
}
