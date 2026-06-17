/**
 * Tests for the shared channel-provisioning client (src/provision-channel.ts) —
 * the module the Config page and the unified create-agent flow BOTH use so they
 * can't drift on how they provision channels.
 *
 * Two halves:
 *   1. `vaultConnectionBody()` — the pure, canonical hub-Connections request body
 *      for a vault-backed channel (the trigger filter is the loop-avoidance
 *      contract). Asserted directly.
 *   2. `PROVISION_JS` — the browser-side client injected into the pages. We assert
 *      its string contract (backtick-free so it interpolates safely; exposes the
 *      `window.ChannelProvision` namespace), then EVALUATE it against a stubbed
 *      window + fetch to exercise each function's real behavior (the same code the
 *      pages run in the browser).
 */
import { describe, test, expect } from "bun:test";
import { vaultConnectionBody, PROVISION_JS } from "./provision-channel.ts";

describe("vaultConnectionBody (the canonical vault-backed-channel connection)", () => {
  test("builds vault.note.created (inbound tag) → channel.message.deliver", () => {
    const body = vaultConnectionBody("eng", "default");
    expect(body.requestedBy).toBe("channel");
    expect(body.source.module).toBe("vault");
    expect(body.source.vault).toBe("default");
    expect(body.source.event).toBe("note.created");
    // The inbound-tag filter is the loop-avoidance contract (CLAUDE.md "Vault
    // integration"): fire on the inbound CHILD tag only; require channel metadata;
    // skip already-rendered notes.
    expect(body.source.filter.tags).toEqual(["#channel-message/inbound"]);
    expect(body.source.filter.has_metadata).toEqual(["channel"]);
    expect(body.source.filter.missing_metadata).toEqual(["channel_inbound_rendered_at"]);
    expect(body.sink.module).toBe("channel");
    expect(body.sink.action).toBe("message.deliver");
    expect(body.sink.params.channel).toBe("eng");
  });

  test("the channel name rides as the sink param (the route key)", () => {
    expect(vaultConnectionBody("release-bot", "v").sink.params.channel).toBe("release-bot");
  });
});

describe("PROVISION_JS string contract", () => {
  test("is backtick-free — safe to interpolate into a host template literal", () => {
    expect(PROVISION_JS.includes("`")).toBe(false);
  });

  test("exposes the window.ChannelProvision namespace with the four client fns", () => {
    expect(PROVISION_JS).toContain("window.ChannelProvision");
    for (const fn of ["channelExists", "provisionVaultChannel", "provisionDaemonChannel", "listVaults"]) {
      expect(PROVISION_JS).toContain(fn + ":");
    }
  });
});

// Evaluate PROVISION_JS against a stubbed window + fetch, exactly as the browser
// would, and hand back the live ChannelProvision namespace so we can exercise the
// real functions. `fetchImpl` is the per-test fetch stub; `origin` seeds
// window.location.origin (used by the vault + discovery calls).
function loadProvision(fetchImpl: typeof fetch, origin = "https://hub.example") {
  const win: Record<string, unknown> = { location: { origin } };
  const factory = new Function(
    "window",
    "fetch",
    PROVISION_JS + "\nreturn window.ChannelProvision;",
  ) as (w: unknown, f: unknown) => {
    channelExists: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
    provisionVaultChannel: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
    provisionDaemonChannel: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
    listVaults: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
    vaultConnectionBody: (name: string, vault: string) => Record<string, unknown>;
  };
  return factory(win, fetchImpl);
}

// A minimal Response-shaped object the eval'd client reads (status, ok, json()).
function resp(status: number, jsonBody: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(jsonBody),
  } as unknown as Response;
}

describe("ChannelProvision.channelExists (idempotency check)", () => {
  test("reports an existing channel by name (the reuse signal)", async () => {
    const P = loadProvision((() =>
      Promise.resolve(resp(200, { channels: [{ name: "eng", transport: "vault" }] }))) as unknown as typeof fetch);
    const out = await P.channelExists({ apiUrl: "/api/channels", token: "t", name: "eng" });
    expect(out.ok).toBe(true);
    expect(out.exists).toBe(true);
    expect(out.transport).toBe("vault");
  });

  test("reports absence when no channel matches the name", async () => {
    const P = loadProvision((() =>
      Promise.resolve(resp(200, { channels: [{ name: "other", transport: "http-ui" }] }))) as unknown as typeof fetch);
    const out = await P.channelExists({ apiUrl: "/api/channels", token: "t", name: "eng" });
    expect(out.ok).toBe(true);
    expect(out.exists).toBe(false);
  });

  test("a 401/403 list surfaces { ok:false, auth:true } (never throws)", async () => {
    const P = loadProvision((() => Promise.resolve(resp(401, {}))) as unknown as typeof fetch);
    const out = await P.channelExists({ apiUrl: "/api/channels", name: "eng" });
    expect(out.ok).toBe(false);
    expect(out.auth).toBe(true);
  });
});

describe("ChannelProvision.provisionVaultChannel (hub-mediated)", () => {
  test("POSTs the canonical body to <origin>/admin/connections with the cookie", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const P = loadProvision(((url: string, init: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return Promise.resolve(resp(200, { connection: { id: "c1" }, connect: { mcpAdd: "x" } }));
    }) as unknown as typeof fetch);
    const out = await P.provisionVaultChannel({ origin: "https://hub.example", name: "eng", vault: "default" });
    expect(seenUrl).toBe("https://hub.example/admin/connections");
    expect(seenInit?.method).toBe("POST");
    expect((seenInit as RequestInit & { credentials?: string }).credentials).toBe("include");
    const sentBody = JSON.parse(String(seenInit?.body));
    // The browser-side body MATCHES the server-side vaultConnectionBody — the whole
    // point of sharing the helper (no drift between surfaces).
    expect(sentBody).toEqual(vaultConnectionBody("eng", "default"));
    expect(out.ok).toBe(true);
    expect((out.connection as { id: string }).id).toBe("c1");
  });

  test("401 → { auth:true }; 403 → { forbidden:true }; other → { error }", async () => {
    const auth = await loadProvision((() => Promise.resolve(resp(401, {}))) as unknown as typeof fetch)
      .provisionVaultChannel({ origin: "o", name: "n", vault: "v" });
    expect(auth.ok).toBe(false);
    expect(auth.auth).toBe(true);

    const forbidden = await loadProvision((() =>
      Promise.resolve(resp(403, { error_description: "nope" }))) as unknown as typeof fetch)
      .provisionVaultChannel({ origin: "o", name: "n", vault: "v" });
    expect(forbidden.ok).toBe(false);
    expect(forbidden.forbidden).toBe(true);
    expect(forbidden.error).toBe("nope");

    const err = await loadProvision((() =>
      Promise.resolve(resp(500, { error: "boom" }))) as unknown as typeof fetch)
      .provisionVaultChannel({ origin: "o", name: "n", vault: "v" });
    expect(err.ok).toBe(false);
    expect(err.error).toBe("boom");
  });
});

describe("ChannelProvision.provisionDaemonChannel (telegram / http-ui)", () => {
  test("POSTs { name, transport, config } to the daemon with the Bearer", async () => {
    let seenInit: RequestInit | undefined;
    const P = loadProvision(((_url: string, init: RequestInit) => {
      seenInit = init;
      return Promise.resolve(resp(200, {}));
    }) as unknown as typeof fetch);
    const out = await P.provisionDaemonChannel({
      apiUrl: "/api/channels", token: "tok", name: "tg", transport: "telegram", config: { token: "bot" },
    });
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tok");
    const sent = JSON.parse(String(seenInit?.body));
    expect(sent).toEqual({ name: "tg", transport: "telegram", config: { token: "bot" } });
    expect(out.ok).toBe(true);
  });

  test("omits config for http-ui (just name + transport)", async () => {
    let seenInit: RequestInit | undefined;
    const P = loadProvision(((_url: string, init: RequestInit) => {
      seenInit = init;
      return Promise.resolve(resp(200, {}));
    }) as unknown as typeof fetch);
    await P.provisionDaemonChannel({ apiUrl: "/api/channels", token: "t", name: "web", transport: "http-ui" });
    const sent = JSON.parse(String(seenInit?.body));
    expect(sent).toEqual({ name: "web", transport: "http-ui" });
  });

  test("carries restart_needed through on a 200 (persisted, hot-add failed)", async () => {
    const P = loadProvision((() =>
      Promise.resolve(resp(200, { restart_needed: true, error: "port busy" }))) as unknown as typeof fetch);
    const out = await P.provisionDaemonChannel({ apiUrl: "/api/channels", name: "x", transport: "http-ui" });
    expect(out.ok).toBe(true);
    expect(out.restart_needed).toBe(true);
  });

  test("401/403 → { ok:false, auth:true } (never throws)", async () => {
    const out = await loadProvision((() => Promise.resolve(resp(403, {}))) as unknown as typeof fetch)
      .provisionDaemonChannel({ apiUrl: "/api/channels", name: "x", transport: "http-ui" });
    expect(out.ok).toBe(false);
    expect(out.auth).toBe(true);
  });
});

describe("ChannelProvision.listVaults (hub public discovery)", () => {
  test("maps the discovery doc's vaults to names", async () => {
    const P = loadProvision((() =>
      Promise.resolve(resp(200, { vaults: [{ name: "default" }, { name: "team" }] }))) as unknown as typeof fetch);
    const out = await P.listVaults({ origin: "https://hub.example" });
    expect(out.ok).toBe(true);
    expect(out.vaults).toEqual(["default", "team"]);
  });

  test("a failed discovery fetch resolves { ok:false } (never throws)", async () => {
    const out = await loadProvision((() => Promise.resolve(resp(404, {}))) as unknown as typeof fetch)
      .listVaults({ origin: "o" });
    expect(out.ok).toBe(false);
  });
});

// The browser-side vaultConnectionBody (inside PROVISION_JS) MUST agree with the
// server-side export — otherwise the two pages would register divergent triggers.
describe("browser/server vaultConnectionBody parity", () => {
  test("the eval'd browser body equals the exported server body", () => {
    const P = loadProvision((() => Promise.resolve(resp(200, {}))) as unknown as typeof fetch);
    expect(P.vaultConnectionBody("eng", "default")).toEqual(vaultConnectionBody("eng", "default"));
  });
});
