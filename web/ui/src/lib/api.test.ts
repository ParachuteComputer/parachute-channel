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
  listAgentSecrets,
  listAgentVaults,
  listAgents,
  listChannels,
  listMessages,
  messageStreamUrl,
  normalizeBackend,
  removeAgentSecret,
  removeAgentVault,
  sendMessage,
  setAgentSecret,
  turnEventsUrl,
} from "./api.ts";
import { registerStepUpPrompt, setStepUpToken, _resetStepUpForTest } from "./step-up.ts";

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

describe("normalizeBackend (#150 — daemon wire value → SPA display)", () => {
  it("maps the daemon's `attached` to the display `channel`", () => {
    expect(normalizeBackend("attached")).toBe("channel");
  });
  it("passes `channel` through (older daemon / def endpoints)", () => {
    expect(normalizeBackend("channel")).toBe("channel");
  });
  it("maps `programmatic` to `programmatic`", () => {
    expect(normalizeBackend("programmatic")).toBe("programmatic");
  });
});

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

  it("normalizes the daemon's `attached` backend → the SPA's `channel` display (#150)", async () => {
    // The daemon emits `backend: "attached"` for a channel agent (listAttachedAgents
    // in src/daemon.ts). The SPA must normalize it to `"channel"` at ingestion so the
    // amber `.pill.backend-channel` styling + the "channel" label both apply — without
    // it the row fell through to the bare unstyled `.pill` and read "attached".
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          agents: [
            { name: "eng", session: "eng-agent", workspace: "/w", hasWorkspace: true, backend: "attached", channel: "eng" },
            { name: "auto", session: "auto-agent", workspace: "/w", hasWorkspace: true, backend: "programmatic" },
          ],
        }),
      ),
    );
    const res = await listAgents();
    expect(res.agents[0]!.backend).toBe("channel");
    // The programmatic row is untouched.
    expect(res.agents[1]!.backend).toBe("programmatic");
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

// ---------------------------------------------------------------------------
// Step-up gate (agent#80): a `403 step_up_required` drives the prompt, then the
// request retries once with the `X-Step-Up-Token` header attached.
// ---------------------------------------------------------------------------
describe("authedFetch — step-up gate (403 step_up_required)", () => {
  beforeEach(() => {
    _resetStepUpForTest();
  });

  it("prompts for the PIN, then retries once with X-Step-Up-Token; success", async () => {
    // The prompt handler mints + caches a token (as the real exchange would).
    registerStepUpPrompt(async () => {
      setStepUpToken("step-tok", Date.now() + 300_000);
      return "step-tok";
    });
    const fetchMock = fetchFn(async () => jsonResponse(403, { error: "step_up_required", reason: "token" }));
    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, { error: "step_up_required", reason: "token" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, scope: "default", name: "GH_TOKEN" }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await setAgentSecret({ name: "GH_TOKEN", value: "ghp_x" });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The first call had no step-up header; the retry carries the minted token.
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("x-step-up-token")).toBeNull();
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get("x-step-up-token")).toBe("step-tok");
  });

  it("surfaces the 403 when the operator cancels the prompt (returns null)", async () => {
    registerStepUpPrompt(async () => null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { error: "step_up_required", reason: "token" })),
    );
    await expect(setAgentSecret({ name: "GH_TOKEN", value: "ghp_x" })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("a PLAIN 403 (not step_up_required) surfaces normally — no prompt", async () => {
    const handler = vi.fn();
    registerStepUpPrompt(handler);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { error: "insufficient_scope" })),
    );
    await expect(setAgentSecret({ name: "GH_TOKEN", value: "ghp_x" })).rejects.toMatchObject({
      status: 403,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("attaches a HELD step-up token up-front (no prompt needed)", async () => {
    setStepUpToken("held-tok", Date.now() + 300_000);
    const fetchMock = fetchFn(async () => jsonResponse(200, { ok: true, scope: "default", name: "GH_TOKEN" }));
    vi.stubGlobal("fetch", fetchMock);
    await setAgentSecret({ name: "GH_TOKEN", value: "ghp_x" });
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("x-step-up-token")).toBe("held-tok");
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

describe("chat SSE URL builders (Phase 4d — one-time ticket auth, agent#25)", () => {
  it("messageStreamUrl appends &ticket= under the agent mount (origin-relative)", () => {
    // apiBase() is "/agent/api" in vitest → MOUNT "/agent". Auth rides as a
    // one-time ticket — NOT the hub JWT — so it never leaks into an access log.
    expect(messageStreamUrl("eng", "tkt-abc")).toBe(
      "/agent/ui/events?channel=eng&ticket=tkt-abc",
    );
  });

  it("messageStreamUrl encodes the channel + ticket", () => {
    expect(messageStreamUrl("eng team", "a/b c")).toBe(
      "/agent/ui/events?channel=eng%20team&ticket=a%2Fb%20c",
    );
  });

  it("messageStreamUrl omits the ticket when null (unguarded dev daemon)", () => {
    expect(messageStreamUrl("eng", null)).toBe("/agent/ui/events?channel=eng");
  });

  it("turnEventsUrl appends ?ticket= under the agent mount (origin-relative)", () => {
    expect(turnEventsUrl("eng", "tkt-abc")).toBe(
      "/agent/api/channels/eng/turn-events?ticket=tkt-abc",
    );
  });

  it("turnEventsUrl encodes the channel + ticket", () => {
    expect(turnEventsUrl("eng team", "a/b")).toBe(
      "/agent/api/channels/eng%20team/turn-events?ticket=a%2Fb",
    );
  });

  it("turnEventsUrl omits the ticket when null", () => {
    expect(turnEventsUrl("eng", null)).toBe("/agent/api/channels/eng/turn-events");
  });
});

describe("agent secrets / env (#36)", () => {
  it("listAgentSecrets GETs /agent/api/credentials/env (names only)", async () => {
    const fetchMock = fetchFn(async () =>
      jsonResponse(200, { default: [], channels: { eng: ["GH_TOKEN"] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await listAgentSecrets();
    expect(res.channels.eng).toEqual(["GH_TOKEN"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/agent/api/credentials/env");
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("setAgentSecret POSTs { channel, name, value } with the Bearer", async () => {
    const fetchMock = fetchFn(async () => jsonResponse(200, { ok: true, scope: "channel", channel: "eng", name: "GH_TOKEN" }));
    vi.stubGlobal("fetch", fetchMock);

    await setAgentSecret({ channel: "eng", name: "GH_TOKEN", value: "ghp_x" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/agent/api/credentials/env");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ channel: "eng", name: "GH_TOKEN", value: "ghp_x" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer jwt-tok");
  });

  it("removeAgentSecret DELETEs WITH a JSON body { channel, name }", async () => {
    const fetchMock = fetchFn(async () => jsonResponse(200, { ok: true, scope: "channel", channel: "eng", name: "GH_TOKEN", removed: true }));
    vi.stubGlobal("fetch", fetchMock);

    await removeAgentSecret({ channel: "eng", name: "GH_TOKEN" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/agent/api/credentials/env");
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeTruthy(); // DELETE carries a body (not all clients support this)
    expect(JSON.parse(String(init?.body))).toEqual({ channel: "eng", name: "GH_TOKEN" });
  });

  it("setAgentSecret surfaces a 400 (denylisted name) as an HttpError", async () => {
    vi.stubGlobal(
      "fetch",
      fetchFn(async () => jsonResponse(400, { error: "ANTHROPIC_API_KEY is reserved" })),
    );
    await expect(setAgentSecret({ channel: "eng", name: "ANTHROPIC_API_KEY", value: "x" })).rejects.toMatchObject({
      status: 400,
    });
  });
});
