/**
 * Step-up client-state tests (agent#80, `lib/step-up.ts`):
 *   - the in-memory token holder (current/set/clear + expiry buffer);
 *   - `requestStepUpToken` driving the registered prompt handler;
 *   - the API client calls (exchange / set-PIN / status) attach the Bearer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.ts", () => ({
  getAgentToken: vi.fn(),
  clearCachedToken: vi.fn(),
}));

import * as auth from "./auth.ts";
import {
  currentStepUpToken,
  setStepUpToken,
  clearStepUpToken,
  registerStepUpPrompt,
  requestStepUpToken,
  exchangePin,
  setPin,
  getStepUpStatus,
  _resetStepUpForTest,
} from "./step-up.ts";

const getAgentToken = vi.mocked(auth.getAgentToken);

beforeEach(() => {
  vi.clearAllMocks();
  _resetStepUpForTest();
  getAgentToken.mockResolvedValue("jwt-tok");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A `fetch`-shaped mock so `mock.calls` carries typed [input, init?] tuples. */
function fetchFn(impl: (input: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(impl);
}

describe("token holder", () => {
  it("returns null when nothing is held", () => {
    expect(currentStepUpToken()).toBeNull();
  });

  it("returns a held token while it's well within its window", () => {
    setStepUpToken("tok-1", Date.now() + 60_000);
    expect(currentStepUpToken()).toBe("tok-1");
  });

  it("treats a token within the expiry buffer as gone", () => {
    setStepUpToken("tok-2", Date.now() + 1_000); // < 5s buffer
    expect(currentStepUpToken()).toBeNull();
  });

  it("clearStepUpToken drops it", () => {
    setStepUpToken("tok-3", Date.now() + 60_000);
    clearStepUpToken();
    expect(currentStepUpToken()).toBeNull();
  });
});

describe("requestStepUpToken", () => {
  it("returns the cached token for a 'token' reason without prompting", async () => {
    setStepUpToken("cached", Date.now() + 60_000);
    const handler = vi.fn();
    registerStepUpPrompt(handler);
    expect(await requestStepUpToken("token")).toBe("cached");
    expect(handler).not.toHaveBeenCalled();
  });

  it("drives the prompt when no token is cached", async () => {
    const handler = vi.fn().mockResolvedValue("fresh");
    registerStepUpPrompt(handler);
    expect(await requestStepUpToken("token")).toBe("fresh");
    expect(handler).toHaveBeenCalledWith("token");
  });

  it("always prompts for a 'setup' reason even if a token is cached", async () => {
    setStepUpToken("cached", Date.now() + 60_000);
    const handler = vi.fn().mockResolvedValue(null);
    registerStepUpPrompt(handler);
    await requestStepUpToken("setup");
    expect(handler).toHaveBeenCalledWith("setup");
  });

  it("returns null when no prompt handler is registered", async () => {
    expect(await requestStepUpToken("token")).toBeNull();
  });
});

describe("API client", () => {
  it("getStepUpStatus GETs /step-up with the Bearer", async () => {
    const fetchMock = fetchFn(async () => jsonResponse(200, { configured: true }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await getStepUpStatus();
    expect(res.configured).toBe(true);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toBeInstanceOf(Headers);
    expect(((init as RequestInit).headers as Headers).get("authorization")).toBe("Bearer jwt-tok");
  });

  it("exchangePin posts the PIN and caches the returned token", async () => {
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const fetchMock = fetchFn(async () => jsonResponse(200, { stepUpToken: "minted", expires_at: expiresAt }));
    vi.stubGlobal("fetch", fetchMock);
    const token = await exchangePin("4242");
    expect(token).toBe("minted");
    expect(currentStepUpToken()).toBe("minted");
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify({ pin: "4242" }));
  });

  it("exchangePin throws HttpError (401) on a wrong PIN", async () => {
    vi.stubGlobal("fetch", fetchFn(async () => jsonResponse(401, { error: "invalid_pin" })));
    await expect(exchangePin("0000")).rejects.toMatchObject({ status: 401 });
  });

  it("setPin posts newPin (+ currentPin when rotating)", async () => {
    const fetchMock = fetchFn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await setPin("9999", "4242");
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).body).toBe(JSON.stringify({ newPin: "9999", currentPin: "4242" }));
  });

  it("setPin omits currentPin on first-time set", async () => {
    const fetchMock = fetchFn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await setPin("9999");
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).body).toBe(JSON.stringify({ newPin: "9999" }));
  });
});
