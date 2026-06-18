/**
 * api.ts unit tests — the API base derivation, the Bearer-attaching authed
 * fetch with a single 401 re-mint-and-retry, and the three typed list helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.ts", () => ({
  getAgentToken: vi.fn(),
  clearCachedToken: vi.fn(),
}));

import * as auth from "./auth.ts";
import {
  apiBase,
  HttpError,
  listAgentDefs,
  listAgentVaults,
  listAgents,
} from "./api.ts";

const getAgentToken = vi.mocked(auth.getAgentToken);
const clearCachedToken = vi.mocked(auth.clearCachedToken);

beforeEach(() => {
  vi.clearAllMocks();
  getAgentToken.mockResolvedValue("jwt-tok");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A `fetch`-shaped mock so `mock.calls` carries [input, init?] tuples. */
function fetchFn(impl: (input: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(impl);
}

describe("apiBase", () => {
  it("falls back to /agent/api when the mount isn't an /app sub-path (dev origin root)", () => {
    // In vitest BASE_URL is "/", so the /app match fails → canonical fallback.
    expect(apiBase()).toBe("/agent/api");
  });
});

describe("listAgents / listAgentDefs / listAgentVaults", () => {
  it("attaches the Bearer and hits the right endpoint", async () => {
    const fetchMock = fetchFn(async () => jsonResponse(200, { agents: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listAgents();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/agent/api/agents");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer jwt-tok");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("listAgentDefs hits /agent/api/agent-defs and parses defs", async () => {
    const defs = [
      {
        noteId: "n1",
        name: "eng",
        backend: "channel",
        vault: "default",
        status: "enabled",
        pending: [],
        systemPromptPreview: "You are…",
        wants: ["vault:default"],
        channel: "eng",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { defs })),
    );
    const res = await listAgentDefs();
    expect(res.defs).toHaveLength(1);
    expect(res.defs[0]!.name).toBe("eng");
  });

  it("listAgentVaults hits /agent/api/agent-vaults and parses vaults", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          vaults: [{ vault: "default", url: "http://127.0.0.1:1940", tokenPresent: true }],
        }),
      ),
    );
    const res = await listAgentVaults();
    expect(res.vaults[0]!.tokenPresent).toBe(true);
  });

  it("omits the Authorization header when no token is available", async () => {
    getAgentToken.mockResolvedValue(null);
    const fetchMock = fetchFn(async () => jsonResponse(200, { agents: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listAgents();

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("re-mints and retries once on a 401, then succeeds", async () => {
    getAgentToken.mockResolvedValueOnce("stale").mockResolvedValueOnce("fresh");
    const fetchMock = fetchFn(async () => new Response("", { status: 401 }));
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse(200, { agents: [{ name: "a" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await listAgents();

    expect(clearCachedToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First with the stale token, second with the freshly minted one.
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("authorization")).toBe(
      "Bearer stale",
    );
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get("authorization")).toBe(
      "Bearer fresh",
    );
    expect(res.agents).toHaveLength(1);
  });

  it("throws HttpError carrying the status + server error message on a non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, { error: "boom" })),
    );
    await expect(listAgents()).rejects.toMatchObject({
      name: "HttpError",
      status: 500,
      message: "boom",
    });
  });

  it("surfaces a persistent 401 as an HttpError when no fresh token mints", async () => {
    getAgentToken.mockResolvedValueOnce("stale").mockResolvedValueOnce(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    await expect(listAgents()).rejects.toBeInstanceOf(HttpError);
  });
});
