/**
 * Daemon-level wiring tests for the PROGRAMMATIC agent backend (design
 * 2026-06-16-pluggable-agent-backend.md, the wiring follow-up to PR #73).
 *
 * Exercises the REAL daemon fetch handler + a real {@link ProgrammaticAgentRegistry}
 * backed by a FAKE {@link AgentBackend} (no `claude -p`) + a recorder outbound write
 * (no vault). The hub-jwt validator is mocked (the sentinel-token harness the other
 * daemon tests use) so a known Bearer carries channel:admin/send WITHOUT a live hub.
 *
 * Covered (the prompt's test list):
 *   - spawn with backend:"programmatic" → no tmux session, agent registered,
 *     spec.json carries backend;
 *   - inbound for a programmatic channel → deliver invoked, reply → outbound note;
 *     EMPTY reply → NO note;
 *   - ok:false → no outbound note + no crash/loop (the registry unit test covers the
 *     queue mechanics; here we assert it end-to-end through the inbound route);
 *   - boot re-register: a persisted programmatic spec.json → re-registered;
 *   - /health + GET /api/agents include the programmatic agent with its status;
 *   - mutual exclusion: programmatic vs interactive collision → 409;
 *   - interactive path untouched (a backend:"interactive" / default spawn still hits
 *     the tmux AgentOps).
 */

import { describe, test, expect, mock } from "bun:test";

const ADMIN_TOKEN = "test-admin-token"; // channel:read + send + admin
import { HubJwtError, looksLikeJwt } from "@openparachute/scope-guard";
mock.module("./hub-jwt.ts", () => ({
  CHANNEL_AUDIENCE: "channel",
  async validateHubJwt(token: string) {
    const base = { sub: "test", aud: "channel", jti: undefined, clientId: undefined, vaultScope: undefined };
    if (token === ADMIN_TOKEN) return { ...base, scopes: ["channel:read", "channel:send", "channel:admin"] };
    throw new HubJwtError("issuer", "invalid token");
  },
  HubJwtError,
  looksLikeJwt,
  resetJwksCache() {},
  resetRevocationCache() {},
}));

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFetchHandler,
  contextFor,
  reregisterProgrammaticAgents,
  buildWriteOutbound,
} from "./daemon.ts";
import { ClientRegistry } from "./routing.ts";
import { DeliveryState } from "./delivery-state.ts";
import { ProgrammaticAgentRegistry, type WriteOutbound } from "./backends/registry.ts";
import type { AgentBackend, AgentHandle, AgentStatus, DeliverResult } from "./backends/types.ts";
import type { AgentSpec } from "./sandbox/types.ts";
import { VaultTransport } from "./transports/vault.ts";
import { persistSpec, sessionWorkspace } from "./spawn-agent.ts";
import type { Channel } from "./registry.ts";
import type { AgentOps, AgentInfo, SpawnRequestError } from "./agents.ts";

const adminAuth = { authorization: "Bearer " + ADMIN_TOKEN };

/** A controllable fake backend (no `claude -p`). */
class FakeBackend implements AgentBackend {
  readonly kind = "programmatic";
  readonly calls: { channel: string; message: string }[] = [];
  resultFor: (message: string) => DeliverResult = (m) => ({ ok: true, reply: "reply:" + m });
  async start(spec: AgentSpec): Promise<AgentHandle> {
    return { backend: this.kind, channel: spec.channels[0] as string, name: spec.name, spec };
  }
  async deliver(handle: AgentHandle, message: string): Promise<DeliverResult> {
    this.calls.push({ channel: handle.channel, message });
    return this.resultFor(message);
  }
  async stop(): Promise<void> {}
  async status(): Promise<AgentStatus> {
    return { live: true };
  }
}

/** A stub interactive AgentOps that records spawns + lists, with no real tmux. */
function stubAgentOps(initial: AgentInfo[] = []): AgentOps & { spawned: AgentSpec[]; killed: string[] } {
  const spawned: AgentSpec[] = [];
  const killed: string[] = [];
  return {
    spawned,
    killed,
    async spawn(spec) {
      spawned.push(spec);
      // Minimal SpawnAgentResult — enough for redactSpawnResult.
      return {
        session: spec.name + "-agent",
        workspace: "/tmp/ws/" + spec.name,
        tokens: {},
        mcpConfigJson: "{}",
        wrapped: { argv: [], env: {}, config: { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } } },
        alreadyRunning: false,
      };
    },
    async list() {
      return initial;
    },
    async kill(name) {
      killed.push(name);
      return { killed: true };
    },
    async restart() {
      throw new Error("not used") as unknown as SpawnRequestError;
    },
  };
}

function recorder(): { calls: { channel: string; reply: string; inReplyTo?: string }[]; fn: WriteOutbound } {
  const calls: { channel: string; reply: string; inReplyTo?: string }[] = [];
  const fn: WriteOutbound = async (channel, reply, inReplyTo) => {
    calls.push({ channel, reply, ...(inReplyTo ? { inReplyTo } : {}) });
  };
  return { calls, fn };
}

/** A VaultTransport whose ctx is bound to the programmatic-aware contextFor. */
function vaultChannel(
  name: string,
  registry: ClientRegistry,
  deliveryState: DeliveryState,
  programmatic: ProgrammaticAgentRegistry,
): Channel {
  const t = new VaultTransport({ vault: "default", vaultUrl: "http://127.0.0.1:1940", token: "x" });
  // Bind the REAL programmatic-aware ctx (no network: we don't call ensureSchema).
  (t as unknown as { ctx: unknown }).ctx = contextFor(registry, name, deliveryState, programmatic);
  return { name, transport: t, entry: { name, transport: "vault" } };
}

function buildServer(opts: {
  channels: Map<string, Channel>;
  agentOps?: AgentOps;
  programmatic: ProgrammaticAgentRegistry;
  deliveryState?: DeliveryState;
}) {
  const registry = new ClientRegistry();
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: createFetchHandler(opts.channels, registry, {
      ...(opts.agentOps ? { agentOps: opts.agentOps } : {}),
      programmatic: opts.programmatic,
      ...(opts.deliveryState ? { deliveryState: opts.deliveryState } : {}),
    }),
  });
  return { srv, base: `http://127.0.0.1:${srv.port}` };
}

async function until(pred: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) await new Promise<void>((r) => setTimeout(r, 1));
}

describe("spawn with backend:'programmatic'", () => {
  test("→ no tmux spawn, agent registered, spec.json carries backend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prog-spawn-"));
    try {
      const backend = new FakeBackend();
      const rec = recorder();
      const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
      const ops = stubAgentOps();
      // Point the channel state dir at our temp via PARACHUTE_CHANNEL_STATE_DIR so
      // defaultStateDir → <dir> and the sessions dir + credentials store land under
      // it (NOT the operator's real ~/.parachute).
      const prevStateDir = process.env.PARACHUTE_CHANNEL_STATE_DIR;
      process.env.PARACHUTE_CHANNEL_STATE_DIR = dir;
      // Seed a default Claude credential so setupProgrammaticSpawn's early resolve
      // succeeds against the temp store (no real store touched).
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "credentials.json"), JSON.stringify({ claude: { default: "oat_test" } }), { mode: 0o600 });

      const { srv, base } = buildServer({
        channels: new Map(),
        agentOps: ops,
        programmatic,
      });
      try {
        const res = await fetch(`${base}/api/agents`, {
          method: "POST",
          headers: { ...adminAuth, "content-type": "application/json" },
          body: JSON.stringify({ name: "eng", channels: ["eng"], backend: "programmatic" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { backend: string; name: string; channel: string };
        expect(body.backend).toBe("programmatic");
        expect(body.name).toBe("eng");
        expect(body.channel).toBe("eng");

        // No tmux spawn happened (the interactive AgentOps.spawn was never called).
        expect(ops.spawned).toHaveLength(0);
        // The agent is registered in the live registry.
        expect(programmatic.hasName("eng")).toBe(true);
        expect(programmatic.hasChannel("eng")).toBe(true);
        // spec.json on disk carries backend:"programmatic".
        const specPath = join(sessionWorkspace(join(dir, "sessions"), "eng"), "spec.json");
        expect(existsSync(specPath)).toBe(true);
        const persisted = JSON.parse(readFileSync(specPath, "utf-8")) as AgentSpec;
        expect(persisted.backend).toBe("programmatic");
      } finally {
        srv.stop(true);
        if (prevStateDir === undefined) delete process.env.PARACHUTE_CHANNEL_STATE_DIR;
        else process.env.PARACHUTE_CHANNEL_STATE_DIR = prevStateDir;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("inbound for a programmatic channel → deliver → outbound note", () => {
  async function inbound(base: string, channel: string, noteId: string, content: string) {
    return fetch(`${base}/api/vault/inbound`, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify({
        note: {
          id: noteId,
          content,
          tags: ["#channel-message", "#channel-message/inbound"],
          metadata: { channel, direction: "inbound", sender: "aaron", ts: "2026-06-16T00:00:01Z" },
        },
      }),
    });
  }

  test("a registered programmatic channel: inbound → deliver invoked, reply → outbound note", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await programmatic.register({ name: "eng", channels: ["eng"], backend: "programmatic" });

    const registry = new ClientRegistry();
    const deliveryState = new DeliveryState();
    const channels = new Map<string, Channel>([
      ["eng", vaultChannel("eng", registry, deliveryState, programmatic)],
    ]);
    const { srv, base } = buildServer({ channels, programmatic, deliveryState });
    try {
      const res = await inbound(base, "eng", "note-1", "hello there");
      expect(res.status).toBe(200);
      await until(() => rec.calls.length === 1);
      // deliver invoked with the inbound content.
      expect(backend.calls).toEqual([{ channel: "eng", message: "hello there" }]);
      // reply written as an outbound note, threaded to the inbound note id.
      expect(rec.calls).toEqual([{ channel: "eng", reply: "reply:hello there", inReplyTo: "note-1" }]);
    } finally {
      srv.stop(true);
    }
  });

  test("EMPTY reply → NO outbound note", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: true, reply: "" });
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await programmatic.register({ name: "eng", channels: ["eng"], backend: "programmatic" });

    const registry = new ClientRegistry();
    const deliveryState = new DeliveryState();
    const channels = new Map<string, Channel>([
      ["eng", vaultChannel("eng", registry, deliveryState, programmatic)],
    ]);
    const { srv, base } = buildServer({ channels, programmatic, deliveryState });
    try {
      await inbound(base, "eng", "note-1", "tool-only work");
      await until(() => backend.calls.length === 1);
      await new Promise<void>((r) => setTimeout(r, 5));
      expect(backend.calls).toHaveLength(1);
      expect(rec.calls).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });

  test("ok:false → no outbound note + no crash/loop", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: false, error: "mint refused" });
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await programmatic.register({ name: "eng", channels: ["eng"], backend: "programmatic" });

    const registry = new ClientRegistry();
    const deliveryState = new DeliveryState();
    const channels = new Map<string, Channel>([
      ["eng", vaultChannel("eng", registry, deliveryState, programmatic)],
    ]);
    const { srv, base } = buildServer({ channels, programmatic, deliveryState });
    try {
      await inbound(base, "eng", "note-1", "do it");
      await until(() => backend.calls.length === 1);
      await new Promise<void>((r) => setTimeout(r, 5));
      expect(backend.calls).toHaveLength(1);
      expect(rec.calls).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });
});

describe("boot re-register", () => {
  test("a persisted programmatic spec.json → re-registered on start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prog-boot-"));
    try {
      const sessionsDir = join(dir, "sessions");
      // Persist an interactive spec (should be SKIPPED) + a programmatic spec.
      persistSpec(sessionWorkspace(sessionsDir, "watcher"), { name: "watcher", channels: ["watch"] });
      persistSpec(sessionWorkspace(sessionsDir, "eng"), { name: "eng", channels: ["eng"], backend: "programmatic" });

      const backend = new FakeBackend();
      const rec = recorder();
      const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });

      const count = await reregisterProgrammaticAgents(programmatic, sessionsDir);
      expect(count).toBe(1);
      expect(programmatic.hasName("eng")).toBe(true);
      // The interactive spec was NOT re-registered as programmatic.
      expect(programmatic.hasName("watcher")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no sessions dir → 0 re-registered (clean first boot)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    const count = await reregisterProgrammaticAgents(programmatic, join(tmpdir(), "does-not-exist-" + Date.now()));
    expect(count).toBe(0);
  });
});

describe("/health + GET /api/agents include programmatic agents", () => {
  test("/health lists the programmatic agent with backend + status", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await programmatic.register({ name: "eng", channels: ["eng"], backend: "programmatic" });

    const { srv, base } = buildServer({ channels: new Map(), programmatic });
    try {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        programmatic_agents: { name: string; channel: string; backend: string; status: string }[];
      };
      expect(body.programmatic_agents).toEqual([
        { name: "eng", channel: "eng", backend: "programmatic", status: "idle" },
      ]);
    } finally {
      srv.stop(true);
    }
  });

  test("GET /api/agents merges interactive + programmatic agents", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await programmatic.register({ name: "eng", channels: ["eng"], backend: "programmatic" });

    const ops = stubAgentOps([
      { name: "aaron", session: "aaron-agent", attached: true, workspace: "/s/aaron", hasWorkspace: true, backend: "interactive" },
    ]);
    const { srv, base } = buildServer({ channels: new Map(), agentOps: ops, programmatic });
    try {
      const res = await fetch(`${base}/api/agents`, { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: AgentInfo[] };
      const byName = Object.fromEntries(body.agents.map((a) => [a.name, a]));
      expect(byName.aaron!.backend).toBe("interactive");
      expect(byName.eng!.backend).toBe("programmatic");
      expect(byName.eng!.status).toBe("idle");
    } finally {
      srv.stop(true);
    }
  });
});

describe("mutual exclusion (design step 7)", () => {
  test("programmatic spawn when an interactive tmux session holds the name → 409", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    const ops = stubAgentOps([
      { name: "eng", session: "eng-agent", attached: true, workspace: "/s/eng", hasWorkspace: true, backend: "interactive" },
    ]);
    const { srv, base } = buildServer({ channels: new Map(), agentOps: ops, programmatic });
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "eng", channels: ["eng"], backend: "programmatic" }),
      });
      expect(res.status).toBe(409);
      expect(programmatic.hasName("eng")).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("a DIFFERENT programmatic name onto an already-claimed channel → 409 (no orphan)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await programmatic.register({ name: "eng-a", channels: ["eng"], backend: "programmatic" });
    const ops = stubAgentOps();
    const { srv, base } = buildServer({ channels: new Map(), agentOps: ops, programmatic });
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "eng-b", channels: ["eng"], backend: "programmatic" }),
      });
      expect(res.status).toBe(409);
      // The prior agent is untouched (not orphaned by an overwrite).
      expect(programmatic.getByChannel("eng")?.name).toBe("eng-a");
      expect(programmatic.hasName("eng-b")).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("interactive spawn when a programmatic agent holds the channel → 409 (tmux NOT spawned)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await programmatic.register({ name: "eng", channels: ["eng"], backend: "programmatic" });
    const ops = stubAgentOps();
    const { srv, base } = buildServer({ channels: new Map(), agentOps: ops, programmatic });
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "eng", channels: ["eng"] }), // interactive (default)
      });
      expect(res.status).toBe(409);
      expect(ops.spawned).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });
});

describe("interactive path untouched", () => {
  test("a default (no backend) spawn still hits the interactive tmux AgentOps", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    const ops = stubAgentOps();
    const { srv, base } = buildServer({ channels: new Map(), agentOps: ops, programmatic });
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "aaron", channels: ["aaron"] }),
      });
      expect(res.status).toBe(200);
      // The interactive AgentOps.spawn ran; nothing landed in the programmatic registry.
      expect(ops.spawned.map((s) => s.name)).toEqual(["aaron"]);
      expect(programmatic.hasName("aaron")).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("DELETE a programmatic agent deregisters it (no tmux kill)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await programmatic.register({ name: "eng", channels: ["eng"], backend: "programmatic" });
    const ops = stubAgentOps();
    const { srv, base } = buildServer({ channels: new Map(), agentOps: ops, programmatic });
    try {
      const res = await fetch(`${base}/api/agents/eng`, { method: "DELETE", headers: adminAuth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { backend: string; killed: boolean };
      expect(body.backend).toBe("programmatic");
      expect(body.killed).toBe(true);
      expect(programmatic.hasName("eng")).toBe(false);
      // The interactive kill (tmux) was NOT called for the programmatic agent.
      expect(ops.killed).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });
});
