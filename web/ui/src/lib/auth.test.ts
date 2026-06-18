/**
 * auth.ts unit tests — the agent:admin mint, token cache, and 401 re-mint.
 *
 * The module holds module-scoped state (cached token, in-flight promise). Each
 * test does a dynamic import after `vi.resetModules()` so the cache starts empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("window", {
    location: { origin: "https://hub.example", pathname: "/agent/app/" },
  } as unknown as Window & typeof globalThis);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("getAgentToken", () => {
  it("mints from <origin>/admin/agent-token with credentials:include and caches it", async () => {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { token: "jwt-1", expires_at: expiresAt, scopes: ["agent:admin"] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = await import("./auth.ts");
    expect(await auth.getAgentToken()).toBe("jwt-1");
    // Second call hits the cache, not the wire.
    expect(await auth.getAgentToken()).toBe("jwt-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.example/admin/agent-token",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("returns null on a 401 (no session) and drops the cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    const auth = await import("./auth.ts");
    expect(await auth.getAgentToken()).toBeNull();
  });

  it("returns null on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const auth = await import("./auth.ts");
    expect(await auth.getAgentToken()).toBeNull();
  });

  it("dedupes concurrent in-flight mint requests", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = await import("./auth.ts");
    const a = auth.getAgentToken();
    const b = auth.getAgentToken();
    resolveFetch(
      jsonResponse(200, {
        token: "jwt-shared",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    expect(await a).toBe("jwt-shared");
    expect(await b).toBe("jwt-shared");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches when the cached token is within the refresh buffer of expiry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          token: "jwt-near-expiry",
          // 10s out — well inside the 30s refresh buffer.
          expires_at: new Date(Date.now() + 10_000).toISOString(),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          token: "jwt-fresh",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const auth = await import("./auth.ts");
    expect(await auth.getAgentToken()).toBe("jwt-near-expiry");
    expect(await auth.getAgentToken()).toBe("jwt-fresh");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clearCachedToken forces a re-mint on the next call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          token: "jwt-a",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          token: "jwt-b",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const auth = await import("./auth.ts");
    expect(await auth.getAgentToken()).toBe("jwt-a");
    auth.clearCachedToken();
    expect(await auth.getAgentToken()).toBe("jwt-b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
