/**
 * Integration tests for the agent-UI-v2 API layer (design
 * 2026-06-18-agent-ui-v2-and-reactivity.md Part 2 Phase 1) on the REAL daemon fetch
 * handler. Four endpoint groups, each with happy-path + auth-gate (401) + validation
 * (400):
 *
 *   - GET    /api/agents        → now includes channel-backend agents (#102)
 *   - GET    /api/agent-defs    → lists the vault-native defs (read-scoped, NO secrets)
 *   - POST   /api/agent-defs    → writes a #agent/definition note + reloads it LIVE
 *   - PATCH  /api/agent-defs/:n → edits + reloads
 *   - DELETE /api/agent-defs/:n → deletes + deregisters
 *   - GET/POST/DELETE /api/agent-vaults → the def-vault list (token-status, no value)
 *
 * The hub JWT validator is stubbed (sentinel tokens → fixed scopes) so the accept
 * paths run without a live hub/JWKS — the same harness daemon-jobs-api.test.ts uses.
 * The def-vault's vault REST is stubbed via an injected `fetchFn` on the registry's
 * DefVaultClient (an in-memory note store), so create/edit/delete exercise the real
 * write+reload path with NO live vault. `addDefVault` is injected so the agent-vaults
 * POST route is exercised without a live hub mint.
 */
import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { HubJwtError, looksLikeJwt } from "@openparachute/scope-guard";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the state dir — the GET/DELETE /api/agent-vaults routes read/write
// `agent-vaults.json` via defaultStateDir(); pin it to a throwaway temp dir so the
// tests never touch the operator's real ~/.parachute/agent (memory:
// feedback_sandbox_destructive_cli). PARACHUTE_AGENT_STATE_DIR short-circuits the
// resolver to this dir.
let stateDir: string;
let priorStateDir: string | undefined;
beforeAll(() => {
  priorStateDir = process.env.PARACHUTE_AGENT_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), "agent-defs-api-state-"));
  process.env.PARACHUTE_AGENT_STATE_DIR = stateDir;
});
afterAll(() => {
  if (priorStateDir === undefined) delete process.env.PARACHUTE_AGENT_STATE_DIR;
  else process.env.PARACHUTE_AGENT_STATE_DIR = priorStateDir;
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {}
});

const ADMIN_TOKEN = "test-admin-token";
const READ_TOKEN = "test-read-token";
mock.module("./hub-jwt.ts", () => ({
  AGENT_AUDIENCE: "agent",
  CHANNEL_AUDIENCE: "channel",
  async validateHubJwt(token: string) {
    const base = { sub: "test", aud: "agent", jti: undefined, clientId: undefined, vaultScope: undefined };
    if (token === ADMIN_TOKEN) return { ...base, scopes: ["agent:read", "agent:send", "agent:admin"] };
    if (token === READ_TOKEN) return { ...base, scopes: ["agent:read"] };
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
import { ChannelQueueRegistry, type ChannelQueueStore } from "./backends/channel-queue.ts";
import type { Channel } from "./registry.ts";
import type { AgentSpec } from "./sandbox/types.ts";
import type { InboundQueueNote, InboundStatus } from "./transports/vault.ts";

const adminAuth = { authorization: "Bearer " + ADMIN_TOKEN, "content-type": "application/json" } as const;
const readAuth = { authorization: "Bearer " + READ_TOKEN, "content-type": "application/json" } as const;

// ---------------------------------------------------------------------------
// A FAKE def-vault: an in-memory note store the registry's DefVaultClient drives via
// an injected `fetchFn`. Models the vault REST routes the client calls:
//   GET    /vault/<v>/api/notes?tag=…           → list defs
//   GET    /vault/<v>/api/notes/<id>            → one note
//   POST   /vault/<v>/api/notes                 → create (assign an id)
//   PATCH  /vault/<v>/api/notes/<id>            → merge content/metadata
//   DELETE /vault/<v>/api/notes/<id>            → remove
// ---------------------------------------------------------------------------
interface FakeNote {
  id: string;
  content?: string;
  tags?: string[];
  metadata: Record<string, unknown>;
}

class FakeDefVault {
  readonly notes = new Map<string, FakeNote>();
  private seq = 0;

  /** Seed a pre-existing def note (so a GET/PATCH/DELETE has something to find). */
  seed(note: FakeNote): void {
    this.notes.set(note.id, note);
  }

  /** The injectable fetch the DefVaultClient uses. Cast to `typeof fetch` (we only
   *  use the call signature, not `fetch.preconnect`). */
  fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    const m = url.pathname.match(/\/vault\/[^/]+\/api\/notes(?:\/(.+))?$/);
    const noteId = m?.[1] ? decodeURIComponent(m[1]) : undefined;

    const j = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (method === "GET" && noteId === undefined) {
      // List defs (tag filter is implicit — every seeded note is a def here).
      return j(Array.from(this.notes.values()));
    }
    if (method === "GET" && noteId !== undefined) {
      const note = this.notes.get(noteId);
      return note ? j(note) : j({ error: "not_found" }, 404);
    }
    if (method === "POST" && noteId === undefined) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        content?: string;
        tags?: string[];
        metadata?: Record<string, unknown>;
        path?: string;
      };
      const id = body.path ?? `note-${++this.seq}`;
      const note: FakeNote = { id, content: body.content, tags: body.tags, metadata: body.metadata ?? {} };
      this.notes.set(id, note);
      return j(note, 200);
    }
    if (method === "PATCH" && noteId !== undefined) {
      const note = this.notes.get(noteId);
      if (!note) return j({ error: "not_found" }, 404);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        content?: string;
        metadata?: Record<string, unknown>;
      };
      if (body.content !== undefined) note.content = body.content;
      if (body.metadata) note.metadata = { ...note.metadata, ...body.metadata };
      return j(note);
    }
    if (method === "DELETE" && noteId !== undefined) {
      this.notes.delete(noteId);
      return j({ ok: true });
    }
    return j({ error: "unhandled", method, path: url.pathname }, 500);
  }) as unknown as typeof fetch;
}

/** Recorder InstantiateDeps — captures the instantiate/teardown calls, no real I/O. */
function recordingDeps() {
  const calls: { ensure: string[]; register: string[]; deregister: string[]; removeChannel: string[] } = {
    ensure: [],
    register: [],
    deregister: [],
    removeChannel: [],
  };
  const deps: InstantiateDeps = {
    ensureChannel: async (name) => {
      calls.ensure.push(name);
    },
    setupAndRegister: async (spec) => {
      calls.register.push(spec.name);
    },
    deregister: async (name) => {
      calls.deregister.push(name);
      return true;
    },
    removeChannel: async (name) => {
      calls.removeChannel.push(name);
      return true;
    },
  };
  return { deps, calls };
}

/** Build an AgentDefRegistry bound to one fake def-vault, with recorder deps. */
function registryWithFakeVault(opts?: { vault?: string; fake?: FakeDefVault }) {
  const vault = opts?.vault ?? "default";
  const fake = opts?.fake ?? new FakeDefVault();
  const { deps, calls } = recordingDeps();
  const reg = new AgentDefRegistry(deps, {
    bindings: [{ vault, vaultUrl: "http://127.0.0.1:1940", token: "vtok" }],
    fetchFn: fake.fetch,
  });
  return { reg, fake, calls, vault };
}

type AddDefVault = (args: { vault: string; url?: string }) => Promise<{
  vault: string;
  url: string;
  tokenPresent: boolean;
}>;

function serverWith(
  channels: Map<string, Channel>,
  o?: {
    agentDefs?: AgentDefRegistry;
    channelQueue?: ChannelQueueRegistry;
    addDefVault?: AddDefVault;
  },
) {
  const registry = new ClientRegistry();
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: createFetchHandler(channels, registry, {
      ...(o?.agentDefs ? { agentDefs: o.agentDefs } : {}),
      ...(o?.channelQueue ? { channelQueue: o.channelQueue } : {}),
      ...(o?.addDefVault ? { addDefVault: o.addDefVault } : {}),
    }),
  });
  return { srv, base: `http://127.0.0.1:${srv.port}` };
}

const emptyChannels = () => new Map<string, Channel>();

// ===========================================================================
// GET /api/agents — includes channel-backend agents (#102)
// ===========================================================================
describe("GET /api/agents includes channel-backend agents (#102)", () => {
  /** A minimal channel-queue store with a pending count we control. */
  function storeWithPending(count: number): ChannelQueueStore {
    const notes: InboundQueueNote[] = Array.from({ length: count }, (_, i) => ({
      id: `in-${i}`,
      text: `m${i}`,
      sender: "operator",
      ts: `2026-01-0${i + 1}`,
      status: "pending" as InboundStatus,
    }));
    return {
      listInboundQueue: async () => notes,
      setInboundStatus: async () => {},
      reply: async () => ({ sent: [] }),
    };
  }

  function channelSpec(name: string, vault?: string): AgentSpec {
    return {
      name,
      channels: [name],
      backend: "channel",
      ...(vault ? { vault: { name: vault, access: "write" } } : {}),
      systemPrompt: "You are the laptop agent.",
    };
  }

  test("a registered channel agent appears with backend:channel + queued status + channel + vault", async () => {
    const channelQueue = new ChannelQueueRegistry();
    channelQueue.register(channelSpec("laptop", "research"), storeWithPending(2));
    const { srv, base } = serverWith(emptyChannels(), { channelQueue });
    const res = await fetch(`${base}/api/agents`, { headers: adminAuth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
    const laptop = body.agents.find((a) => a.name === "laptop");
    expect(laptop).toBeDefined();
    expect(laptop!.backend).toBe("channel");
    expect(laptop!.status).toBe("queued:2");
    expect(laptop!.channel).toBe("laptop");
    expect(laptop!.vault).toBe("research");
    // No secret leaked.
    expect(JSON.stringify(laptop)).not.toContain("vtok");
    expect(JSON.stringify(laptop)).not.toContain("token");
    srv.stop();
  });

  test("an empty pending queue → status idle", async () => {
    const channelQueue = new ChannelQueueRegistry();
    channelQueue.register(channelSpec("idlebot"), storeWithPending(0));
    const { srv, base } = serverWith(emptyChannels(), { channelQueue });
    const res = await fetch(`${base}/api/agents`, { headers: adminAuth });
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
    expect(body.agents.find((a) => a.name === "idlebot")!.status).toBe("idle");
    srv.stop();
  });

  test("no Authorization → 401 (admin-gated)", async () => {
    const { srv, base } = serverWith(emptyChannels(), { channelQueue: new ChannelQueueRegistry() });
    const res = await fetch(`${base}/api/agents`);
    expect(res.status).toBe(401);
    srv.stop();
  });
});

// ===========================================================================
// GET /api/agent-defs — list the vault-native defs (read-scoped, no secrets)
// ===========================================================================
describe("GET /api/agent-defs", () => {
  test("no Authorization → 401", async () => {
    const { reg } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-defs`);
    expect(res.status).toBe(401);
    srv.stop();
  });

  test("read scope is enough (a read token lists)", async () => {
    const { reg } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-defs`, { headers: readAuth });
    expect(res.status).toBe(200);
    srv.stop();
  });

  test("returns the live defs with the detail shape + NO secrets", async () => {
    const fake = new FakeDefVault();
    fake.seed({
      id: "Agents/uni-dev",
      content: "a".repeat(500), // long prompt → preview truncates to 200.
      tags: ["#agent/definition"],
      metadata: { name: "uni-dev", backend: "channel" },
    });
    const { reg } = registryWithFakeVault({ fake });
    await reg.loadAll(); // instantiate the seeded def.
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-defs`, { headers: readAuth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { defs: Array<Record<string, unknown>> };
    expect(body.defs).toHaveLength(1);
    const d = body.defs[0]!;
    expect(d.noteId).toBe("Agents/uni-dev");
    expect(d.name).toBe("uni-dev");
    expect(d.backend).toBe("channel");
    expect(d.vault).toBe("default");
    expect(d.status).toBe("enabled");
    expect(d.channel).toBe("uni-dev");
    expect((d.systemPromptPreview as string).length).toBe(200); // truncated.
    // No token/secret in the listing.
    expect(JSON.stringify(d)).not.toContain("vtok");
    srv.stop();
  });

  test("no agentDefs configured → empty list (200)", async () => {
    const { srv, base } = serverWith(emptyChannels());
    const res = await fetch(`${base}/api/agent-defs`, { headers: readAuth });
    expect(res.status).toBe(200);
    expect((await res.json()) as { defs: unknown[] }).toEqual({ defs: [] });
    srv.stop();
  });
});

// ===========================================================================
// POST /api/agent-defs — write a #agent/definition note + reload it LIVE
// ===========================================================================
describe("POST /api/agent-defs", () => {
  test("no Authorization → 401", async () => {
    const { reg } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-defs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vault: "default", name: "x", backend: "programmatic" }),
    });
    expect(res.status).toBe(401);
    srv.stop();
  });

  test("read scope is insufficient → 403 (admin required)", async () => {
    const { reg } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-defs`, {
      method: "POST",
      headers: readAuth,
      body: JSON.stringify({ vault: "default", name: "x", backend: "programmatic" }),
    });
    expect(res.status).toBe(403);
    srv.stop();
  });

  test("writes a note + the def becomes LIVE (instantiate ran)", async () => {
    const { reg, fake, calls } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-defs`, {
      method: "POST",
      headers: adminAuth,
      body: JSON.stringify({
        vault: "default",
        name: "newbot",
        backend: "programmatic",
        systemPrompt: "You are newbot.",
        wants: "vault:research:read",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; def: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.def.name).toBe("newbot");
    expect(body.def.backend).toBe("programmatic");
    expect(body.def.status).toBe("pending"); // declared a `wants:` → pending (own-vault runs).
    expect(body.def.wants).toEqual(["vault:research:read"]);
    // The note was written to the fake vault, tagged the def tag, body = prompt.
    const written = [...fake.notes.values()].find((n) => n.metadata.name === "newbot");
    expect(written).toBeDefined();
    expect(written!.tags).toContain("#agent/definition");
    expect(written!.content).toBe("You are newbot.");
    expect(written!.metadata.backend).toBe("programmatic");
    // It instantiated LIVE (the per-note reload ran ensureChannel + register) — not
    // dependent on a trigger or the 60s poll.
    expect(calls.ensure).toContain("newbot");
    expect(calls.register).toContain("newbot");
    // And it shows up in the live listing now.
    const list = await (await fetch(`${base}/api/agent-defs`, { headers: readAuth })).json() as {
      defs: Array<{ name: string }>;
    };
    expect(list.defs.map((d) => d.name)).toContain("newbot");
    srv.stop();
  });

  test("validation: missing vault → 400", async () => {
    const { reg } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-defs`, {
      method: "POST",
      headers: adminAuth,
      body: JSON.stringify({ name: "x", backend: "programmatic" }),
    });
    expect(res.status).toBe(400);
    srv.stop();
  });

  test("validation: bad backend → 400", async () => {
    const { reg } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-defs`, {
      method: "POST",
      headers: adminAuth,
      body: JSON.stringify({ vault: "default", name: "x", backend: "interactive" }),
    });
    expect(res.status).toBe(400);
    srv.stop();
  });

  test("validation: bad name slug → 400", async () => {
    const { reg } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-defs`, {
      method: "POST",
      headers: adminAuth,
      body: JSON.stringify({ vault: "default", name: "bad name!", backend: "programmatic" }),
    });
    expect(res.status).toBe(400);
    srv.stop();
  });

  test("validation: unknown vault → 400", async () => {
    const { reg } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-defs`, {
      method: "POST",
      headers: adminAuth,
      body: JSON.stringify({ vault: "nope", name: "x", backend: "programmatic" }),
    });
    expect(res.status).toBe(400);
    srv.stop();
  });
});

// ===========================================================================
// PATCH /api/agent-defs/:noteId — edit + reload
// ===========================================================================
describe("PATCH /api/agent-defs/:noteId", () => {
  async function liveDefServer() {
    const fake = new FakeDefVault();
    fake.seed({
      id: "Agents/uni-dev",
      content: "old prompt",
      tags: ["#agent/definition"],
      metadata: { name: "uni-dev", backend: "programmatic" },
    });
    const { reg, calls } = registryWithFakeVault({ fake });
    await reg.loadAll();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    return { srv, base, fake, calls };
  }

  test("no Authorization → 401", async () => {
    const { srv, base } = await liveDefServer();
    const res = await fetch(`${base}/api/agent-defs/${encodeURIComponent("Agents/uni-dev")}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ systemPrompt: "new" }),
    });
    expect(res.status).toBe(401);
    srv.stop();
  });

  test("edits the note body + re-instantiates LIVE", async () => {
    const { srv, base, fake, calls } = await liveDefServer();
    calls.register.length = 0; // clear the loadAll register call.
    const res = await fetch(`${base}/api/agent-defs/${encodeURIComponent("Agents/uni-dev")}`, {
      method: "PATCH",
      headers: adminAuth,
      body: JSON.stringify({ systemPrompt: "new prompt" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; def: { name: string } };
    expect(body.ok).toBe(true);
    expect(body.def.name).toBe("uni-dev");
    // The note body was updated in the vault.
    expect(fake.notes.get("Agents/uni-dev")!.content).toBe("new prompt");
    // It re-instantiated (the reload ran register again).
    expect(calls.register).toContain("uni-dev");
    srv.stop();
  });

  test("PATCH a note that isn't a live def → 404", async () => {
    const { srv, base } = await liveDefServer();
    const res = await fetch(`${base}/api/agent-defs/${encodeURIComponent("Agents/ghost")}`, {
      method: "PATCH",
      headers: adminAuth,
      body: JSON.stringify({ systemPrompt: "x" }),
    });
    expect(res.status).toBe(404);
    srv.stop();
  });

  test("validation: bad systemPrompt type → 400", async () => {
    const { srv, base } = await liveDefServer();
    const res = await fetch(`${base}/api/agent-defs/${encodeURIComponent("Agents/uni-dev")}`, {
      method: "PATCH",
      headers: adminAuth,
      body: JSON.stringify({ systemPrompt: 42 }),
    });
    expect(res.status).toBe(400);
    srv.stop();
  });
});

// ===========================================================================
// DELETE /api/agent-defs/:noteId — delete + deregister
// ===========================================================================
describe("DELETE /api/agent-defs/:noteId", () => {
  async function liveDefServer() {
    const fake = new FakeDefVault();
    fake.seed({
      id: "Agents/uni-dev",
      content: "p",
      tags: ["#agent/definition"],
      metadata: { name: "uni-dev", backend: "programmatic" },
    });
    const { reg, calls } = registryWithFakeVault({ fake });
    await reg.loadAll();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    return { srv, base, fake, calls, reg };
  }

  test("no Authorization → 401", async () => {
    const { srv, base } = await liveDefServer();
    const res = await fetch(`${base}/api/agent-defs/${encodeURIComponent("Agents/uni-dev")}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
    srv.stop();
  });

  test("deletes the note + deregisters the agent", async () => {
    const { srv, base, fake, calls, reg } = await liveDefServer();
    const res = await fetch(`${base}/api/agent-defs/${encodeURIComponent("Agents/uni-dev")}`, {
      method: "DELETE",
      headers: adminAuth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; name: string; removed: boolean };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("uni-dev");
    expect(body.removed).toBe(true);
    // The note is gone from the vault.
    expect(fake.notes.has("Agents/uni-dev")).toBe(false);
    // The agent was deregistered + its channel removed.
    expect(calls.deregister).toContain("uni-dev");
    expect(calls.removeChannel).toContain("uni-dev");
    // No longer in the live listing.
    expect(reg.listDetailed()).toHaveLength(0);
    srv.stop();
  });

  test("DELETE a note that isn't a live def → 404", async () => {
    const { srv, base } = await liveDefServer();
    const res = await fetch(`${base}/api/agent-defs/${encodeURIComponent("Agents/ghost")}`, {
      method: "DELETE",
      headers: adminAuth,
    });
    expect(res.status).toBe(404);
    srv.stop();
  });
});

// ===========================================================================
// GET/POST/DELETE /api/agent-vaults — the def-vault list
// ===========================================================================
describe("GET /api/agent-vaults", () => {
  test("no Authorization → 401", async () => {
    const { reg } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-vaults`);
    expect(res.status).toBe(401);
    srv.stop();
  });

  test("read scope insufficient → 403", async () => {
    const { reg } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-vaults`, { headers: readAuth });
    expect(res.status).toBe(403);
    srv.stop();
  });

  test("lists the bound vaults with token-status, NO token value", async () => {
    const { reg } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-vaults`, { headers: adminAuth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vaults: Array<{ vault: string; url: string; tokenPresent: boolean }> };
    const v = body.vaults.find((x) => x.vault === "default");
    expect(v).toBeDefined();
    // No raw token in the payload — only the boolean presence.
    expect(JSON.stringify(body)).not.toContain("vtok");
    expect(v!.tokenPresent).toBe(true);
    expect(v!.url).toBe("http://127.0.0.1:1940");
    srv.stop();
  });
});

describe("POST /api/agent-vaults", () => {
  test("no Authorization → 401", async () => {
    const { reg } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-vaults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vault: "research" }),
    });
    expect(res.status).toBe(401);
    srv.stop();
  });

  test("adds a def-vault (injected addDefVault ran) → 201 + re-resolves live", async () => {
    const { reg } = registryWithFakeVault();
    const researchVault = new FakeDefVault(); // hermetic — no real loopback.
    const added: Array<{ vault: string; url?: string }> = [];
    const addDefVault = async (args: { vault: string; url?: string }) => {
      added.push(args);
      // Mirror the real path: register the vault (fake fetch) so a later GET lists it
      // + a loadAll converges its defs.
      reg.addVault(
        { vault: args.vault, vaultUrl: args.url ?? "http://127.0.0.1:1940", token: "minted" },
        researchVault.fetch,
      );
      await reg.loadAll();
      return { vault: args.vault, url: args.url ?? "http://127.0.0.1:1940", tokenPresent: true };
    };
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg, addDefVault });
    const res = await fetch(`${base}/api/agent-vaults`, {
      method: "POST",
      headers: adminAuth,
      body: JSON.stringify({ vault: "research" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; vault: { vault: string; tokenPresent: boolean } };
    expect(body.ok).toBe(true);
    expect(body.vault.vault).toBe("research");
    expect(body.vault.tokenPresent).toBe(true);
    // The injected hook ran (mint+persist+load) and the vault is now bound.
    expect(added).toEqual([{ vault: "research" }]);
    expect(reg.vaultNames()).toContain("research");
    srv.stop();
  });

  test("validation: missing vault → 400", async () => {
    const { reg } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg, addDefVault: async () => { throw new Error("should not run"); } });
    const res = await fetch(`${base}/api/agent-vaults`, {
      method: "POST",
      headers: adminAuth,
      body: JSON.stringify({ url: "http://x" }),
    });
    expect(res.status).toBe(400);
    srv.stop();
  });

  test("validation: bad vault slug → 400", async () => {
    const { reg } = registryWithFakeVault();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg, addDefVault: async () => { throw new Error("should not run"); } });
    const res = await fetch(`${base}/api/agent-vaults`, {
      method: "POST",
      headers: adminAuth,
      body: JSON.stringify({ vault: "bad vault!" }),
    });
    expect(res.status).toBe(400);
    srv.stop();
  });

  test("a duplicate / failed add → 400 with the error", async () => {
    const { reg } = registryWithFakeVault();
    const addDefVault = async () => {
      throw new Error('def-vault "default" is already configured');
    };
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg, addDefVault });
    const res = await fetch(`${base}/api/agent-vaults`, {
      method: "POST",
      headers: adminAuth,
      body: JSON.stringify({ vault: "default" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("already configured") });
    srv.stop();
  });
});

describe("DELETE /api/agent-vaults/:name", () => {
  /** A registry with TWO bound vaults so a delete doesn't hit the last-vault guard. */
  function twoVaultRegistry() {
    const { deps, calls } = recordingDeps();
    const reg = new AgentDefRegistry(deps, {
      bindings: [
        { vault: "default", vaultUrl: "http://127.0.0.1:1940", token: "t1" },
        { vault: "research", vaultUrl: "http://127.0.0.1:1940", token: "t2" },
      ],
    });
    return { reg, calls };
  }

  test("no Authorization → 401", async () => {
    const { reg } = twoVaultRegistry();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-vaults/research`, { method: "DELETE" });
    expect(res.status).toBe(401);
    srv.stop();
  });

  test("removes a non-last def-vault → 200 + dropped from the registry", async () => {
    const { reg } = twoVaultRegistry();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-vaults/research`, { method: "DELETE", headers: adminAuth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; vault: string; removed: boolean };
    expect(body).toMatchObject({ ok: true, vault: "research", removed: true });
    expect(reg.vaultNames()).not.toContain("research");
    expect(reg.vaultNames()).toContain("default");
    srv.stop();
  });

  test("removing the LAST def-vault is guarded → 400 (would orphan the module)", async () => {
    const { reg } = registryWithFakeVault(); // single bound vault.
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-vaults/default`, { method: "DELETE", headers: adminAuth });
    expect(res.status).toBe(400);
    // Still bound (not removed).
    expect(reg.vaultNames()).toContain("default");
    srv.stop();
  });

  test("removing an unknown def-vault → 200 removed:false (idempotent)", async () => {
    const { reg } = twoVaultRegistry();
    const { srv, base } = serverWith(emptyChannels(), { agentDefs: reg });
    const res = await fetch(`${base}/api/agent-vaults/nope`, { method: "DELETE", headers: adminAuth });
    expect(res.status).toBe(200);
    expect((await res.json()) as { removed: boolean }).toMatchObject({ removed: false });
    srv.stop();
  });
});
