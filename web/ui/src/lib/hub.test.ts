/**
 * hub.ts unit tests — the cookie-authed def-reload connection provisioning.
 *
 * Each test stubs `window.location.origin` + `fetch` and asserts the wire shape
 * (origin-rooted path, `credentials: "include"`, the connection bodies/ids) and
 * the status/teardown/error logic. No real network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConnectionRow,
  approveAgentGrant,
  defReloadStatus,
  ensureDefReloadConnections,
  HubError,
  isDaemonDirectOrigin,
  listConnections,
  teardownDefReloadConnections,
} from "./hub.ts";

beforeEach(() => {
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

/** A def-reload connection row (semantic match), parameterized by vault + event. */
function reloadRow(id: string, vault: string, event: string): ConnectionRow {
  return {
    id,
    source: { module: "vault", vault, event },
    sink: { module: "agent", action: "definition.reload" },
  };
}

describe("listConnections", () => {
  it("GETs <origin>/admin/connections with credentials:include and returns the array", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, connections: [reloadRow("x", "research", "note.created")] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const conns = await listConnections();
    expect(conns).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.example/admin/connections",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("throws a HubError with a friendly 401 message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    await expect(listConnections()).rejects.toMatchObject({
      name: "HubError",
      status: 401,
    });
  });

  it("maps a 404 to the hub-proxied-URL hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    await expect(listConnections()).rejects.toThrow(/hub-proxied URL/);
  });
});

describe("defReloadStatus", () => {
  it("active only when BOTH create and edit connectors are present (matched by semantics)", () => {
    const both = [
      reloadRow("a", "research", "note.created"),
      reloadRow("b", "research", "note.updated"),
    ];
    expect(defReloadStatus("research", both)).toEqual({ create: true, edit: true, active: true });

    const onlyCreate = [reloadRow("a", "research", "note.created")];
    expect(defReloadStatus("research", onlyCreate)).toEqual({
      create: true,
      edit: false,
      active: false,
    });

    expect(defReloadStatus("research", [])).toEqual({
      create: false,
      edit: false,
      active: false,
    });
  });

  it("does not match a different vault or a non-reload sink", () => {
    const other = [
      reloadRow("a", "OTHER", "note.created"),
      // right vault/event but a different sink action (e.g. message.deliver)
      {
        id: "c",
        source: { module: "vault", vault: "research", event: "note.created" },
        sink: { module: "agent", action: "message.deliver" },
      } as ConnectionRow,
    ];
    expect(defReloadStatus("research", other).active).toBe(false);
    expect(defReloadStatus("research", other).create).toBe(false);
  });
});

describe("ensureDefReloadConnections", () => {
  it("POSTs both connectors with the canonical ids, events, filter, and sink", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, { ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureDefReloadConnections("research");
    expect(result).toEqual({ ok: true, failures: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    const create = bodies.find((b) => b.source.event === "note.created");
    const edit = bodies.find((b) => b.source.event === "note.updated");

    expect(create).toMatchObject({
      id: "agentdefs-create-research",
      requestedBy: "agent",
      source: { module: "vault", vault: "research", filter: { tags: ["agent/definition"] } },
      sink: { module: "agent", action: "definition.reload" },
    });
    expect(edit).toMatchObject({ id: "agentdefs-edit-research", source: { event: "note.updated" } });

    // POST, JSON content-type, cookie-authed.
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");
    }
  });

  it("reports a partial failure without throwing when one connector fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(jsonResponse(400, { error: "invalid_source" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureDefReloadConnections("research");
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
  });

  it("throws when BOTH connectors fail (the no-session / wrong-origin case)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    await expect(ensureDefReloadConnections("research")).rejects.toMatchObject({
      name: "HubError",
      status: 401,
    });
  });

  it("throws HubError(400) when the hub rejects both bodies (the validation failure mode)", async () => {
    // The pre-fix hub 400'd every def-reload POST ("agent sink requires
    // sink.params.channel"); guard the total-failure throw carries that status
    // (not a generic wrap) so the UI surfaces the real reason.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(400, { error: "invalid_request", error_description: "bad" })),
    );
    await expect(ensureDefReloadConnections("research")).rejects.toMatchObject({
      name: "HubError",
      status: 400,
    });
  });
});

describe("teardownDefReloadConnections", () => {
  it("DELETEs the canonical ids AND any semantically-matching connection id", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, { ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // A pair wired via the hub builder carries hub-derived ids, not ours.
    const existing = [
      reloadRow("conn_hubmade_create", "research", "note.created"),
      reloadRow("conn_hubmade_edit", "research", "note.updated"),
    ];
    await teardownDefReloadConnections("research", existing);

    const deletedIds = fetchMock.mock.calls.map((c) =>
      decodeURIComponent((c[0] as string).replace("https://hub.example/admin/connections/", "")),
    );
    // canonical ids + the two hub-made ids (deduped)
    expect(new Set(deletedIds)).toEqual(
      new Set([
        "agentdefs-create-research",
        "agentdefs-edit-research",
        "conn_hubmade_create",
        "conn_hubmade_edit",
      ]),
    );
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).method).toBe("DELETE");
    }
  });

  it("ignores a 404 (already gone) but throws on a real failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    await expect(teardownDefReloadConnections("research")).resolves.toBeUndefined();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 403 })),
    );
    await expect(teardownDefReloadConnections("research")).rejects.toMatchObject({
      name: "HubError",
      status: 403,
    });
  });
});

describe("approveAgentGrant", () => {
  it("OAuth start (no token): POSTs an empty body, credentials:include, returns authorizeUrl", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, {
        id: "grant_abc",
        agent: "uni-dev",
        connection: { kind: "mcp", target: "https://remote/mcp" },
        status: "pending",
        authorizeUrl: "https://remote/oauth/authorize?x=1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const listing = await approveAgentGrant("grant_abc");
    expect(listing.authorizeUrl).toBe("https://remote/oauth/authorize?x=1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.example/admin/grants/grant_abc/approve",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    // No token → empty JSON body.
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("static bearer (with token): sends { token } and returns the approved listing (no redirect)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, {
        id: "grant_abc",
        agent: "uni-dev",
        connection: { kind: "mcp", target: "https://remote/mcp" },
        status: "approved",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const listing = await approveAgentGrant("grant_abc", "static-bearer-tok");
    expect(listing.status).toBe("approved");
    expect(listing.authorizeUrl).toBeUndefined();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ token: "static-bearer-tok" });
  });

  it("URL-encodes the grant id and maps a 404 to the hub-proxied-URL hint (daemon-direct)", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(approveAgentGrant("grant/with slash")).rejects.toThrow(/hub-proxied URL/);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.example/admin/grants/grant%2Fwith%20slash/approve",
      expect.anything(),
    );
  });

  it("throws a HubError with the status on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    await expect(approveAgentGrant("grant_abc")).rejects.toMatchObject({
      name: "HubError",
      status: 401,
    });
  });
});

describe("isDaemonDirectOrigin", () => {
  it("true on the agent daemon's loopback origin (cookie can't flow there)", () => {
    vi.stubGlobal("window", {
      location: { origin: "http://127.0.0.1:1941", hostname: "127.0.0.1", port: "1941" },
    } as unknown as Window & typeof globalThis);
    expect(isDaemonDirectOrigin()).toBe(true);
  });

  it("false on the hub-proxied origin (the cookie→hub Connect works)", () => {
    vi.stubGlobal("window", {
      location: { origin: "https://hub.example", hostname: "hub.example", port: "" },
    } as unknown as Window & typeof globalThis);
    expect(isDaemonDirectOrigin()).toBe(false);
  });

  it("false on a loopback HUB port (a local operator on the hub itself)", () => {
    vi.stubGlobal("window", {
      location: { origin: "http://127.0.0.1:1939", hostname: "127.0.0.1", port: "1939" },
    } as unknown as Window & typeof globalThis);
    expect(isDaemonDirectOrigin()).toBe(false);
  });
});

describe("HubError", () => {
  it("carries the status", () => {
    const e = new HubError(418, "teapot");
    expect(e.status).toBe(418);
    expect(e.name).toBe("HubError");
  });
});
