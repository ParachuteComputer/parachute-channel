import { describe, test, expect } from "bun:test";
import {
  mintScopedToken,
  agentScope,
  vaultScope,
  MintError,
  type MintTokenDeps,
} from "./mint-token.ts";

/** A fake hub mint endpoint. Records the request; returns a scripted response. */
function fakeHub(
  handler: (body: Record<string, unknown>, headers: Headers) => { status: number; json: unknown },
): { fetchFn: typeof fetch; calls: Array<{ body: Record<string, unknown>; auth: string | null }> } {
  const calls: Array<{ body: Record<string, unknown>; auth: string | null }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ body, auth: headers.get("authorization") });
    const { status, json } = handler(body, headers);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function depsWith(fetchFn: typeof fetch): MintTokenDeps {
  return { hubOrigin: "https://hub.example.com", managerBearer: "MANAGER-BEARER", fetchFn };
}

describe("scope string helpers", () => {
  test("agentScope", () => {
    expect(agentScope({ write: false })).toBe("agent:read");
    expect(agentScope({ write: true })).toBe("agent:read agent:write");
  });
  test("vaultScope", () => {
    expect(vaultScope("default", "read")).toBe("vault:default:read");
    expect(vaultScope("work", "write")).toBe("vault:work:write");
  });
});

describe("mintScopedToken — happy path", () => {
  test("POSTs to /api/auth/mint-token with the manager bearer + scope, returns the token", async () => {
    const hub = fakeHub((body) => ({
      status: 200,
      json: {
        jti: "j1",
        token: "MINTED-TOKEN",
        expires_at: "2026-09-01T00:00:00Z",
        scope: body.scope,
      },
    }));
    const res = await mintScopedToken({ scope: "agent:read agent:write" }, depsWith(hub.fetchFn));
    expect(res.token).toBe("MINTED-TOKEN");
    expect(res.jti).toBe("j1");
    // Presented the MANAGER's bearer (the attenuation principal).
    expect(hub.calls[0]!.auth).toBe("Bearer MANAGER-BEARER");
    expect(hub.calls[0]!.body.scope).toBe("agent:read agent:write");
  });

  test("passes audience + permissions (scoped_tags) through to the hub", async () => {
    const hub = fakeHub(() => ({
      status: 200,
      json: { jti: "j", token: "T", expires_at: "", scope: "vault:default:read" },
    }));
    await mintScopedToken(
      {
        scope: "vault:default:read",
        audience: "vault.default",
        permissions: { scoped_tags: ["agent/message"] },
      },
      depsWith(hub.fetchFn),
    );
    expect(hub.calls[0]!.body.audience).toBe("vault.default");
    expect(hub.calls[0]!.body.permissions).toEqual({ scoped_tags: ["agent/message"] });
  });
});

describe("mintScopedToken — attenuation + error surfacing", () => {
  test("CAPABILITY ATTENUATION: the hub's 400 invalid_scope (over-broad request) becomes a MintError", async () => {
    // Simulate the hub's canGrant guard: a vault:default:read manager bearer
    // requests vault:default:write → the hub refuses 400 invalid_scope. The
    // attenuation bound lives in the hub; this asserts the client surfaces the
    // refusal as a hard error (never launches a session with an ungrantable cred).
    const hub = fakeHub((body) => {
      // Manager bearer in this scenario only holds vault:default:read; a write
      // request exceeds it → hub returns 400.
      if (String(body.scope).includes(":write")) {
        return {
          status: 400,
          json: {
            error: "invalid_scope",
            error_description:
              "scope vault:default:write is not grantable by this bearer; use OAuth flow or operator rotation",
          },
        };
      }
      return { status: 200, json: { jti: "j", token: "ok", expires_at: "", scope: body.scope } };
    });

    // The grantable read mint succeeds.
    const ok = await mintScopedToken({ scope: "vault:default:read" }, depsWith(hub.fetchFn));
    expect(ok.token).toBe("ok");

    // The over-broad write mint is refused — surfaced as a MintError carrying the code.
    let err: unknown;
    try {
      await mintScopedToken({ scope: "vault:default:write" }, depsWith(hub.fetchFn));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MintError);
    expect((err as MintError).status).toBe(400);
    expect((err as MintError).code).toBe("invalid_scope");
  });

  test("a 403 insufficient_scope (no minting authority) becomes a MintError", async () => {
    const hub = fakeHub(() => ({
      status: 403,
      json: { error: "insufficient_scope", error_description: "bearer holds no minting authority" },
    }));
    let err: unknown;
    try {
      await mintScopedToken({ scope: "agent:read" }, depsWith(hub.fetchFn));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MintError);
    expect((err as MintError).status).toBe(403);
    expect((err as MintError).code).toBe("insufficient_scope");
  });

  test("a 200 with no token becomes a MintError (never returns a credential-less success)", async () => {
    const hub = fakeHub(() => ({ status: 200, json: { jti: "j", expires_at: "" } }));
    await expect(mintScopedToken({ scope: "agent:read" }, depsWith(hub.fetchFn))).rejects.toBeInstanceOf(MintError);
  });

  test("a network failure to reach the hub becomes a MintError (status 0)", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    let err: unknown;
    try {
      await mintScopedToken({ scope: "agent:read" }, depsWith(fetchFn));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MintError);
    expect((err as MintError).status).toBe(0);
  });
});
