/**
 * HTTP MCP tests — the per-channel session registry, the wake push, write-scope
 * enforcement on tool dispatch, and the daemon's /mcp/<channel> auth gate.
 *
 * Like daemon.test.ts these need NO live hub: the no-token path in requireScope
 * short-circuits before any JWKS fetch, and the registry/push/tool tests drive
 * the in-memory session set directly with fake servers + a fake transport.
 */
import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import {
  pushToChannel,
  pushPermissionVerdict,
  mcpSessionCount,
  assertMcpSdkStreamContract,
  _resetSessionsForTest,
} from "./mcp-http.ts";
import { createFetchHandler } from "./daemon.ts";
import { ClientRegistry } from "./routing.ts";
import { HttpUiTransport } from "./transports/http-ui.ts";
import type { Channel } from "./registry.ts";
import type { Transport, ReplyArgs } from "./transport.ts";

// ---------------------------------------------------------------------------
// Registry + wake — drive the session set directly via a registration shim.
//
// pushToChannel iterates the channel's session set and calls
// server.notification. We register fake sessions by reaching the same internal
// maps the way handleMcp's onsessioninitialized would. Since those maps are
// module-private, we exercise them through the public surface: register via a
// tiny test-only re-entry that mirrors registerSession. To keep this hermetic
// without exporting internals, we register by spinning handleMcp is overkill;
// instead we assert push reaches a registered session through a captured
// server.notification. We use the exported _registerForTest below.
// ---------------------------------------------------------------------------

import { _registerSessionForTest, _unregisterSessionForTest } from "./mcp-http.ts";

interface FakeServer {
  notes: Array<{ method: string; params: unknown }>;
}

function fakeSession(): { server: { notification: (n: unknown) => void }; captured: FakeServer } {
  const captured: FakeServer = { notes: [] };
  const server = {
    notification(n: unknown) {
      captured.notes.push(n as { method: string; params: unknown });
    },
  };
  return { server, captured };
}

afterEach(() => {
  _resetSessionsForTest();
});

describe("per-channel MCP session registry + wake push", () => {
  test("pushToChannel reaches a session on A and NOT one on B", () => {
    const a = fakeSession();
    const b = fakeSession();
    _registerSessionForTest("A", "sid-a", a.server as never, ["agent:read", "agent:write"]);
    _registerSessionForTest("B", "sid-b", b.server as never, ["agent:read"]);

    const delivered = pushToChannel("A", "hello A", { foo: "bar" });
    expect(delivered).toBe(1);
    expect(a.captured.notes).toHaveLength(1);
    expect(a.captured.notes[0]!.method).toBe("notifications/claude/agent");
    expect((a.captured.notes[0]!.params as { content: string }).content).toBe("hello A");
    // Source is stamped + caller meta merged.
    expect((a.captured.notes[0]!.params as { meta: Record<string, string> }).meta).toMatchObject({
      source: "parachute-agent",
      foo: "bar",
    });
    // B got nothing.
    expect(b.captured.notes).toHaveLength(0);
  });

  test("two sessions on the same channel both get the wake", () => {
    const a1 = fakeSession();
    const a2 = fakeSession();
    _registerSessionForTest("A", "sid-a1", a1.server as never, ["agent:read"]);
    _registerSessionForTest("A", "sid-a2", a2.server as never, ["agent:read"]);
    expect(mcpSessionCount("A")).toBe(2);
    const delivered = pushToChannel("A", "broadcast", {});
    expect(delivered).toBe(2);
    expect(a1.captured.notes).toHaveLength(1);
    expect(a2.captured.notes).toHaveLength(1);
  });

  test("pushPermissionVerdict pushes the permission method", () => {
    const a = fakeSession();
    _registerSessionForTest("A", "sid-a", a.server as never, ["agent:read"]);
    const delivered = pushPermissionVerdict("A", { request_id: "r1", behavior: "allow" });
    expect(delivered).toBe(1);
    expect(a.captured.notes[0]!.method).toBe("notifications/claude/agent/permission");
    expect(a.captured.notes[0]!.params).toMatchObject({ request_id: "r1", behavior: "allow" });
  });

  test("push to an unknown channel delivers to nobody (0)", () => {
    expect(pushToChannel("nope", "x", {})).toBe(0);
    expect(pushPermissionVerdict("nope", { request_id: "r", behavior: "deny" })).toBe(0);
  });

  test("a streamless session (registered, no live GET stream) is NOT counted as delivered", () => {
    // The bug this guards: a session that POSTed `initialize` but hasn't opened (or
    // has dropped) its standalone GET stream is registered, but the SDK silently
    // drops any notification to it. If pushToChannel counted it, the daemon would
    // advance the channel's delivery mark and the message would be lost.
    const a = fakeSession();
    _registerSessionForTest("A", "sid-streamless", a.server as never, ["agent:read"], {
      streamless: true,
    });
    expect(mcpSessionCount("A")).toBe(1); // it IS registered…
    expect(pushToChannel("A", "into the void", {})).toBe(0); // …but NOT deliverable
    expect(a.captured.notes).toHaveLength(0); // not even attempted
    // Permission verdicts honor the same gate.
    expect(pushPermissionVerdict("A", { request_id: "r", behavior: "allow" })).toBe(0);
  });

  test("pushToChannel counts only the live-stream sessions in a mixed set", () => {
    const live = fakeSession();
    const dead = fakeSession();
    _registerSessionForTest("A", "sid-live", live.server as never, ["agent:read"]);
    _registerSessionForTest("A", "sid-streamless", dead.server as never, ["agent:read"], {
      streamless: true,
    });
    expect(mcpSessionCount("A")).toBe(2); // both registered
    expect(pushToChannel("A", "hi", {})).toBe(1); // only the one with a live stream
    expect(live.captured.notes).toHaveLength(1);
    expect(dead.captured.notes).toHaveLength(0);
  });

  test("the installed MCP SDK still keys the standalone GET stream as we expect (contract guard)", () => {
    // If this fails, the SDK renamed the internal sessionHasLivePushStream reads —
    // HTTP-MCP delivery would silently break. Catch it here, not in production.
    expect(assertMcpSdkStreamContract()).toBe(true);
  });

  test("mcpSessionCount tracks registration + reset", () => {
    expect(mcpSessionCount("A")).toBe(0);
    const a = fakeSession();
    _registerSessionForTest("A", "sid-a", a.server as never, ["agent:read"]);
    expect(mcpSessionCount("A")).toBe(1);
    _resetSessionsForTest();
    expect(mcpSessionCount("A")).toBe(0);
  });

  test("unregister cleans up the session and drops the empty channel set (no leak)", () => {
    _registerSessionForTest("A", "sid-a1", fakeSession().server as never, ["agent:read"]);
    _registerSessionForTest("A", "sid-a2", fakeSession().server as never, ["agent:read"]);
    expect(mcpSessionCount("A")).toBe(2);
    _unregisterSessionForTest("A", "sid-a1");
    expect(mcpSessionCount("A")).toBe(1); // the other session survives
    _unregisterSessionForTest("A", "sid-a2");
    expect(mcpSessionCount("A")).toBe(0); // empty set removed — no orphaned channel entry
    // a push to the now-cleaned channel reaches nobody
    expect(pushToChannel("A", "hi", {})).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tool dispatch — a reply tool call routes to the channel's transport.
// ---------------------------------------------------------------------------

describe("tool dispatch routes to the channel's transport + enforces write scope", () => {
  function fakeTransport(): { transport: Transport; replies: ReplyArgs[] } {
    const replies: ReplyArgs[] = [];
    const transport: Transport = {
      kind: "fake",
      async start() {},
      async stop() {},
      async reply(args: ReplyArgs) {
        replies.push(args);
        return { sent: ["msg-1"] };
      },
    };
    return { transport, replies };
  }

  test("a write-scoped reply call reaches transport.reply with the channel + args", async () => {
    const { transport, replies } = fakeTransport();
    const { callReplyTool } = await import("./mcp-http.ts");
    const result = await callReplyTool("A", transport, ["agent:read", "agent:write"], {
      text: "hi there",
      chat_id: "42",
    });
    expect(result.isError).toBeUndefined();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ channel: "A", text: "hi there", meta: { chat_id: "42" } });
  });

  test("a read-only token cannot call reply (write scope enforced)", async () => {
    const { transport, replies } = fakeTransport();
    const { callReplyTool } = await import("./mcp-http.ts");
    const result = await callReplyTool("A", transport, ["agent:read"], { text: "blocked" });
    expect(result.isError).toBe(true);
    expect(replies).toHaveLength(0);
    expect((result.content[0] as { text: string }).text).toContain("agent:write");
  });

  test("DUAL-ACCEPT: a pre-rename token with the LEGACY channel:write scope can still call reply", async () => {
    // The write-tool gate must dual-accept (grantsScope), not raw-includes — else
    // a pre-rename token connects + is woken but silently can't send (channel#…).
    const { transport, replies } = fakeTransport();
    const { callReplyTool } = await import("./mcp-http.ts");
    const result = await callReplyTool("A", transport, ["channel:read", "channel:write"], {
      text: "legacy-send",
    });
    expect(result.isError).toBeUndefined();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ channel: "A", text: "legacy-send" });
  });
});

// ---------------------------------------------------------------------------
// Daemon auth gate — POST /mcp/<channel> with no bearer → 401 (pre-JWKS).
// ---------------------------------------------------------------------------

describe("daemon /mcp/<channel> auth gate", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;

  beforeAll(async () => {
    const registry = new ClientRegistry();
    const transport = new HttpUiTransport({ channel: "ui1" });
    await transport.start({ channel: "ui1", emit: () => {}, emitPermissionVerdict: () => {} });
    const channels = new Map<string, Channel>([
      ["ui1", { name: "ui1", transport, entry: { name: "ui1", transport: "http-ui" } }],
    ]);
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: createFetchHandler(channels, registry),
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("POST /mcp/ui1 with an initialize body and no bearer → 401", async () => {
    const res = await fetch(`${base}/mcp/ui1`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
  });

  test("POST /mcp/unknown-channel → 404 (channel miss, before auth body)", async () => {
    const res = await fetch(`${base}/mcp/does-not-exist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(404);
  });
});
