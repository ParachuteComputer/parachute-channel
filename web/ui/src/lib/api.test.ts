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
  addAgentVault,
  apiBase,
  connectSessionCommand,
  createAgentDef,
  deleteAgentDef,
  editAgentDef,
  getAgentDef,
  HttpError,
  listAgentDefs,
  listAgentVaults,
  listAgents,
  listChannels,
  listMessages,
  messageStreamUrl,
  removeAgentVault,
  sendMessage,
  turnEventsUrl,
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

describe("createAgentDef (POST)", () => {
  it("POSTs the JSON body with the Bearer + content-type to /agent/api/agent-defs", async () => {
    const fetchMock = fetchFn(async () => jsonResponse(201, { ok: true, def: { name: "eng" } }));
    vi.stubGlobal("fetch", fetchMock);

    const body = {
      vault: "default",
      name: "eng",
      backend: "channel" as const,
      systemPrompt: "You are…",
      metadata: { mode: "single-threaded" },
    };
    const res = await createAgentDef(body);

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/agent/api/agent-defs");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer jwt-tok");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual(body);
  });

  it("re-mints and retries once on a 401, then succeeds", async () => {
    getAgentToken.mockResolvedValueOnce("stale").mockResolvedValueOnce("fresh");
    const fetchMock = fetchFn(async () => jsonResponse(201, { ok: true, def: { name: "a" } }));
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse(201, { ok: true, def: { name: "a" } }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await createAgentDef({
      vault: "default",
      name: "a",
      backend: "programmatic",
      systemPrompt: "",
      metadata: { mode: "single-threaded" },
    });

    expect(clearCachedToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("authorization")).toBe(
      "Bearer stale",
    );
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get("authorization")).toBe(
      "Bearer fresh",
    );
    expect(res.ok).toBe(true);
  });

  it("throws HttpError with the daemon error message on a 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(400, { error: "no def-vaults configured" })),
    );
    await expect(
      createAgentDef({
        vault: "default",
        name: "x",
        backend: "programmatic",
        systemPrompt: "",
        metadata: { mode: "single-threaded" },
      }),
    ).rejects.toMatchObject({ name: "HttpError", status: 400, message: "no def-vaults configured" });
  });
});

describe("getAgentDef / editAgentDef / deleteAgentDef (Phase 4a def write paths)", () => {
  it("getAgentDef GETs /agent/api/agent-defs/<encoded id> and parses the full def", async () => {
    const full = {
      noteId: "Agents/uni-dev",
      name: "uni-dev",
      backend: "channel",
      vault: "default",
      mode: "multi-threaded",
      wants: ["vault:x:read"],
      systemPrompt: "The FULL body",
      status: "enabled",
    };
    const fetchMock = fetchFn(async () => jsonResponse(200, { def: full }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAgentDef("Agents/uni-dev");
    expect(res.def.systemPrompt).toBe("The FULL body");
    expect(res.def.mode).toBe("multi-threaded");
    const [url, init] = fetchMock.mock.calls[0]!;
    // The slash in the note id is URL-encoded into one path segment.
    expect(url).toBe("/agent/api/agent-defs/Agents%2Funi-dev");
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer jwt-tok");
  });

  it("editAgentDef PATCHes the encoded id with the body (mode in metadata.mode)", async () => {
    const fetchMock = fetchFn(async () => jsonResponse(200, { ok: true, def: { name: "uni-dev" } }));
    vi.stubGlobal("fetch", fetchMock);

    const body = { systemPrompt: "New body", metadata: { mode: "multi-threaded" }, wants: "vault:x:read" };
    const res = await editAgentDef("Agents/uni-dev", body);
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/agent/api/agent-defs/Agents%2Funi-dev");
    expect(init?.method).toBe("PATCH");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual(body);
  });

  it("deleteAgentDef DELETEs the encoded id (no body)", async () => {
    const fetchMock = fetchFn(async () =>
      jsonResponse(200, { ok: true, vault: "default", name: "uni-dev", removed: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await deleteAgentDef("Agents/uni-dev");
    expect(res.removed).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/agent/api/agent-defs/Agents%2Funi-dev");
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
  });
});

describe("addAgentVault / removeAgentVault (Phase 4a def-vault write paths)", () => {
  it("addAgentVault POSTs the body to /agent/api/agent-vaults", async () => {
    const fetchMock = fetchFn(async () =>
      jsonResponse(201, { ok: true, vault: { vault: "research", url: "http://x", tokenPresent: true } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await addAgentVault({ vault: "research", url: "http://x" });
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/agent/api/agent-vaults");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ vault: "research", url: "http://x" });
  });

  it("removeAgentVault DELETEs /agent/api/agent-vaults/<encoded name>", async () => {
    const fetchMock = fetchFn(async () => jsonResponse(200, { ok: true, vault: "research", removed: true }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await removeAgentVault("research");
    expect(res.removed).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/agent/api/agent-vaults/research");
    expect(init?.method).toBe("DELETE");
  });
});

describe("connectSessionCommand", () => {
  it("builds the `claude mcp add` one-liner mirroring the daemon snippet", () => {
    // In vitest apiBase() is "/agent/api" → MOUNT "/agent". Origin from the arg.
    expect(connectSessionCommand("eng", "https://my.parachute.computer")).toBe(
      "claude mcp add --transport http --scope user agent-eng https://my.parachute.computer/agent/mcp/eng",
    );
  });
});

describe("chat — listChannels / listMessages / sendMessage (Phase 4d)", () => {
  it("listChannels GETs /agent/api/channels with the Bearer", async () => {
    const fetchMock = fetchFn(async () =>
      jsonResponse(200, { channels: [{ name: "eng", transport: "vault", vault: "default" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await listChannels();
    expect(res.channels[0]!.name).toBe("eng");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/agent/api/channels");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer jwt-tok");
  });

  it("listMessages GETs /agent/api/channels/<encoded>/messages and parses messages", async () => {
    const messages = [
      { id: "n1", text: "hi", direction: "inbound", sender: "operator", ts: "2026-06-18T00:00:00Z" },
    ];
    const fetchMock = fetchFn(async () => jsonResponse(200, { messages }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await listMessages("eng team");
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]!.direction).toBe("inbound");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/agent/api/channels/eng%20team/messages");
  });

  it("sendMessage POSTs { text } to /agent/api/channels/<encoded>/send", async () => {
    const fetchMock = fetchFn(async () => jsonResponse(200, { ok: true, id: "note-9" }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await sendMessage("eng", "hello there");
    expect(res.id).toBe("note-9");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/agent/api/channels/eng/send");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ text: "hello there" });
  });

  it("sendMessage re-mints + retries once on a 401, then succeeds", async () => {
    getAgentToken.mockResolvedValueOnce("stale").mockResolvedValueOnce("fresh");
    const fetchMock = fetchFn(async () => jsonResponse(200, { ok: true, id: "n" }));
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, id: "n" }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await sendMessage("eng", "x");
    expect(clearCachedToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get("authorization")).toBe(
      "Bearer fresh",
    );
    expect(res.ok).toBe(true);
  });
});

describe("chat SSE URL builders (Phase 4d)", () => {
  it("messageStreamUrl appends &token= under the agent mount (origin-relative)", () => {
    // apiBase() is "/agent/api" in vitest → MOUNT "/agent".
    expect(messageStreamUrl("eng", "jwt-abc")).toBe(
      "/agent/ui/events?channel=eng&token=jwt-abc",
    );
  });

  it("messageStreamUrl encodes the channel + token", () => {
    expect(messageStreamUrl("eng team", "a/b c")).toBe(
      "/agent/ui/events?channel=eng%20team&token=a%2Fb%20c",
    );
  });

  it("messageStreamUrl omits the token when null (unguarded dev daemon)", () => {
    expect(messageStreamUrl("eng", null)).toBe("/agent/ui/events?channel=eng");
  });

  it("turnEventsUrl appends ?token= under the agent mount (origin-relative)", () => {
    expect(turnEventsUrl("eng", "jwt-abc")).toBe(
      "/agent/api/channels/eng/turn-events?token=jwt-abc",
    );
  });

  it("turnEventsUrl encodes the channel + token", () => {
    expect(turnEventsUrl("eng team", "a/b")).toBe(
      "/agent/api/channels/eng%20team/turn-events?token=a%2Fb",
    );
  });

  it("turnEventsUrl omits the token when null", () => {
    expect(turnEventsUrl("eng", null)).toBe("/agent/api/channels/eng/turn-events");
  });
});
