/**
 * Step-up auth (PIN) client state for the agent SPA (agent#80).
 *
 * The dangerous `agent:admin` actions (set credentials, open a terminal, spawn a
 * `filesystem: full` agent) require a SECOND factor: a short-lived **step-up
 * token** the operator gets by entering their PIN. The daemon enforces it
 * SERVER-SIDE — this module is just the client convenience:
 *
 *   - holds the active step-up token in MEMORY for the session (never
 *     localStorage — same posture as the agent Bearer in `lib/auth.ts`);
 *   - exposes the step-up API client calls (status / exchange / set-PIN);
 *   - bridges the data layer (`lib/api.ts`) to the UI: when a gated request comes
 *     back `403 step_up_required`, `authedFetch` calls {@link requestStepUpToken},
 *     which a React provider has wired to a PIN-prompt modal. The modal exchanges
 *     the PIN for a token, this module caches it, and the request retries with
 *     `X-Step-Up-Token`.
 *
 * The token is REUSABLE within its ~5min window, so one PIN entry covers a short
 * burst of gated actions; on expiry the next gated request re-prompts.
 */

import { apiBase, HttpError } from "./api.ts";
import { getAgentToken, clearCachedToken } from "./auth.ts";

/** The header the daemon reads the step-up token from. */
export const STEP_UP_HEADER = "x-step-up-token";

interface HeldToken {
  token: string;
  expiresAt: number; // epoch ms
}

/** In-memory step-up token (never persisted). */
let held: HeldToken | null = null;

/** Slack kept before treating a held token as expired. */
const EXPIRY_BUFFER_MS = 5_000;

/** The currently-valid step-up token, or null if none / expired. */
export function currentStepUpToken(): string | null {
  if (!held) return null;
  if (held.expiresAt - Date.now() <= EXPIRY_BUFFER_MS) {
    held = null;
    return null;
  }
  return held.token;
}

/** Cache a freshly-exchanged token. */
export function setStepUpToken(token: string, expiresAt: number): void {
  held = { token, expiresAt };
}

/** Drop the held token (e.g. after a 403 with a token we thought was valid). */
export function clearStepUpToken(): void {
  held = null;
}

// ---------------------------------------------------------------------------
// API client — the step-up endpoints (all agent:admin, Bearer via lib/auth).
// ---------------------------------------------------------------------------

/** Authenticated fetch with the agent Bearer + a single 401 re-mint-retry. Mirrors
 *  `lib/api.ts:authedFetch` but does NOT attach a step-up token (these endpoints
 *  are the step-up surface itself — they're never step-up-gated). */
async function adminFetch(suffix: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAgentToken();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(`${apiBase()}${suffix}`, { ...init, headers });
  if (res.status !== 401) return res;
  clearCachedToken();
  const fresh = await getAgentToken();
  if (!fresh) return res;
  const retry = new Headers(init.headers);
  retry.set("accept", "application/json");
  retry.set("authorization", `Bearer ${fresh}`);
  return fetch(`${apiBase()}${suffix}`, { ...init, headers: retry });
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? "";
  } catch {
    return await res.text().catch(() => "");
  }
}

/** `GET /api/step-up` → whether a PIN is configured (UI: setup vs prompt). */
export async function getStepUpStatus(): Promise<{ configured: boolean }> {
  const res = await adminFetch("/step-up");
  if (!res.ok) throw new HttpError(res.status, (await errorDetail(res)) || `step-up status failed: ${res.status}`);
  return (await res.json()) as { configured: boolean };
}

/**
 * `POST /api/step-up { pin }` → exchange the PIN for a step-up token. On success
 * caches it and returns it. Throws `HttpError` on a wrong PIN (401), lockout (429),
 * or not-configured (409) so the modal can show the right message.
 */
export async function exchangePin(pin: string): Promise<string> {
  const res = await adminFetch("/step-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) {
    throw new HttpError(res.status, (await errorDetail(res)) || `PIN exchange failed: ${res.status}`);
  }
  const body = (await res.json()) as { stepUpToken: string; expires_at: string };
  const expiresAt = new Date(body.expires_at).getTime();
  setStepUpToken(body.stepUpToken, expiresAt);
  return body.stepUpToken;
}

/**
 * `POST /api/step-up/pin { newPin, currentPin? }` → set (first time) or rotate the
 * PIN. `currentPin` is required when a PIN already exists. Throws `HttpError`
 * (400 bad format, 401 wrong current PIN, 429 lockout).
 */
export async function setPin(newPin: string, currentPin?: string): Promise<void> {
  const res = await adminFetch("/step-up/pin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newPin, ...(currentPin ? { currentPin } : {}) }),
  });
  if (!res.ok) {
    throw new HttpError(res.status, (await errorDetail(res)) || `set PIN failed: ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// The data-layer → UI bridge. A React provider registers a prompt handler; the
// data layer calls `requestStepUpToken()` on a `403 step_up_required`.
// ---------------------------------------------------------------------------

/** `reason: "setup"` → run first-time PIN setup; `"token"` → prompt for the PIN. */
export type StepUpReason = "setup" | "token";

type PromptHandler = (reason: StepUpReason) => Promise<string | null>;

let promptHandler: PromptHandler | null = null;

/** Register the modal's prompt handler (called once by the provider on mount). */
export function registerStepUpPrompt(handler: PromptHandler | null): void {
  promptHandler = handler;
}

/**
 * Obtain a step-up token: return the cached one if valid, else drive the UI prompt
 * (which exchanges the PIN). Returns null when no prompt handler is registered or
 * the operator cancels. Called by `lib/api.ts:authedFetch` on a 403 step_up_required.
 */
export async function requestStepUpToken(reason: StepUpReason): Promise<string | null> {
  const cached = currentStepUpToken();
  if (cached && reason === "token") return cached;
  if (!promptHandler) return null;
  return promptHandler(reason);
}

/** Test seam: reset all module state. */
export function _resetStepUpForTest(): void {
  held = null;
  promptHandler = null;
}
