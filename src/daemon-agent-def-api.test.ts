/**
 * Daemon route test for the vault-native agent-def RELOAD webhook
 * (POST /api/vault/agent-def, design 2026-06-17-vault-native-agents Phase 4a).
 *
 * Auth mirrors /api/vault/inbound: hub JWT, scope agent:send, uniform-401. The
 * AgentDefRegistry is injected with a recorder for its `reload`, so we assert the
 * route's dispatch (auth → parse → route to vault → reload) without a real vault.
 * Uses the same sentinel-token `mock.module("./hub-jwt.ts")` harness as the other
 * daemon route tests (file-scoped).
 */
import { describe, test, expect, mock } from "bun:test";

const SEND_TOKEN = "test-send-token"; // agent:send
import { HubJwtError, looksLikeJwt } from "@openparachute/scope-guard";
mock.module("./hub-jwt.ts", () => ({
  AGENT_AUDIENCE: "agent",
  CHANNEL_AUDIENCE: "channel",
  async validateHubJwt(token: string) {
    const base = { sub: "test", aud: "agent", jti: undefined, clientId: undefined, vaultScope: undefined };
    if (token === SEND_TOKEN) return { ...base, scopes: ["agent:read", "agent:send"] };
    throw new HubJwtError("issuer", "invalid token");
  },
  HubJwtError,
  looksLikeJwt,
  resetJwksCache() {},
  resetRevocationCache() {},
}));

import { createFetchHandler } from "./daemon.ts";
import { ClientRegistry } from "./routing.ts";
import { AgentDefRegistry, type InstantiateDeps } from "./agent-defs.ts";
import type { Channel } from "./registry.ts";

/** A registry whose `reload` is recorded; one bound def-vault by default. */
function recordingRegistry(opts?: { vaults?: string[] }) {
  const reloads: Array<{ vault: string; noteId: string; event?: string }> = [];
  const noopDeps: InstantiateDeps = {
    ensureChannel: async () => {},
    setupAndRegister: async () => {},
    deregister: async () => true,
    removeChannel: async () => true,
  };
  const reg = new AgentDefRegistry(noopDeps, {
    bindings: (opts?.vaults ?? ["default"]).map((v) => ({ vault: v, token: "t" })),
  });
  // Override reload to record (avoid any vault I/O).
  reg.reload = (async (vault: string, noteId: string, event?: "created" | "updated" | "deleted") => {
    reloads.push({ vault, noteId, event });
    return "instantiated";
  }) as typeof reg.reload;
  return { reg, reloads };
}

function serverWith(channels: Map<string, Channel>, agentDefs?: AgentDefRegistry) {
  const registry = new ClientRegistry();
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: createFetchHandler(channels, registry, agentDefs ? { agentDefs } : undefined),
  });
  return { srv, base: `http://127.0.0.1:${srv.port}` };
}

const emptyChannels = () => new Map<string, Channel>();
const auth = { authorization: `Bearer ${SEND_TOKEN}`, "content-type": "application/json" };

describe("POST /api/vault/agent-def", () => {
  test("no Authorization → 401", async () => {
    const { reg } = recordingRegistry();
    const { srv, base } = serverWith(emptyChannels(), reg);
    const res = await fetch(`${base}/api/vault/agent-def`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: { id: "n" } }),
    });
    expect(res.status).toBe(401);
    srv.stop();
  });

  test("authed reload routes to the registry with vault + noteId + event (single-vault default)", async () => {
    const { reg, reloads } = recordingRegistry();
    const { srv, base } = serverWith(emptyChannels(), reg);
    const res = await fetch(`${base}/api/vault/agent-def`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ event: "updated", note: { id: "Agents/uni-dev" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reloaded: string };
    expect(body.ok).toBe(true);
    expect(body.reloaded).toBe("instantiated");
    // vault defaulted to the sole bound def-vault.
    expect(reloads).toEqual([{ vault: "default", noteId: "Agents/uni-dev", event: "updated" }]);
    srv.stop();
  });

  test("explicit body.vault is honored", async () => {
    const { reg, reloads } = recordingRegistry({ vaults: ["default", "research"] });
    const { srv, base } = serverWith(emptyChannels(), reg);
    const res = await fetch(`${base}/api/vault/agent-def`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ event: "deleted", vault: "research", note: { id: "Agents/r" } }),
    });
    expect(res.status).toBe(200);
    expect(reloads).toEqual([{ vault: "research", noteId: "Agents/r", event: "deleted" }]);
    srv.stop();
  });

  test("multiple def-vaults + no explicit vault → 400 (ambiguous)", async () => {
    const { reg, reloads } = recordingRegistry({ vaults: ["default", "research"] });
    const { srv, base } = serverWith(emptyChannels(), reg);
    const res = await fetch(`${base}/api/vault/agent-def`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ note: { id: "n" } }),
    });
    expect(res.status).toBe(400);
    expect(reloads).toHaveLength(0);
    srv.stop();
  });

  test("missing note.id → 400", async () => {
    const { reg } = recordingRegistry();
    const { srv, base } = serverWith(emptyChannels(), reg);
    const res = await fetch(`${base}/api/vault/agent-def`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ event: "created" }),
    });
    expect(res.status).toBe(400);
    srv.stop();
  });

  test("no agentDefs configured → clean no-op ack (200, reloaded: skipped)", async () => {
    const { srv, base } = serverWith(emptyChannels()); // no registry
    const res = await fetch(`${base}/api/vault/agent-def`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ note: { id: "n" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reloaded: string };
    expect(body.reloaded).toBe("skipped");
    srv.stop();
  });
});
