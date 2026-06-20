/**
 * Daemon-level wiring tests for the PROGRAMMATIC agent backend (design
 * 2026-06-16-pluggable-agent-backend.md, the wiring follow-up to PR #73).
 *
 * Exercises the REAL daemon fetch handler + a real {@link ProgrammaticAgentRegistry}
 * backed by a FAKE {@link AgentBackend} (no `claude -p`) + a recorder outbound write
 * (no vault). The hub-jwt validator is mocked (the sentinel-token harness the other
 * daemon tests use) so a known Bearer carries agent:admin/send WITHOUT a live hub.
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

import { describe, test, expect, mock, afterEach } from "bun:test";

const ADMIN_TOKEN = "test-admin-token"; // agent:read + send + admin
import { HubJwtError, looksLikeJwt } from "@openparachute/scope-guard";
mock.module("./hub-jwt.ts", () => ({
  AGENT_AUDIENCE: "agent",
  CHANNEL_AUDIENCE: "channel",
  async validateHubJwt(token: string) {
    const base = { sub: "test", aud: "agent", jti: undefined, clientId: undefined, vaultScope: undefined };
    if (token === ADMIN_TOKEN) return { ...base, scopes: ["agent:read", "agent:send", "agent:admin"] };
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
  buildWriteCallback,
  callbackFieldsFromMeta,
} from "./daemon.ts";
import { ClientRegistry } from "./routing.ts";
import { DeliveryState } from "./delivery-state.ts";
import {
  ProgrammaticAgentRegistry,
  MAX_DELEGATION_DEPTH,
  type WriteOutbound,
  type WriteCallback,
  type CallbackMeta,
} from "./backends/registry.ts";
import type { AgentBackend, AgentHandle, AgentStatus, DeliverResult } from "./backends/types.ts";
import type { AgentSpec } from "./sandbox/types.ts";
import { VaultTransport } from "./transports/vault.ts";
import { persistSpec, sessionWorkspace } from "./spawn-agent.ts";
import type { Channel } from "./registry.ts";
import type { AgentInfo } from "./agents.ts";

const adminAuth = { authorization: "Bearer " + ADMIN_TOKEN };

// ---------------------------------------------------------------------------
// Real-home safety guard (agent#75)
//
// A phantom `eng` programmatic agent appeared on a LIVE box because a test write
// escaped isolation into the real `~/.parachute/agent/sessions/`. Boot re-register
// then scanned it and resurrected the agent. Every test here that persists a spec /
// touches the agent state dir MUST write ONLY to a per-test temp dir. The `afterEach`
// real-home assertion below is the backstop; `withTempStateDir` is the easy-path helper
// future state-touching tests should reach for.
//
// `realSessionsDir()` is the operator's REAL sessions dir, derived the SAME way the
// daemon derives it (`~/.parachute/agent/sessions`) but WITHOUT honoring
// PARACHUTE_AGENT_STATE_DIR — so it's the genuine home even while a test has the env
// var pointed at a temp dir. A new test session/spec dir appearing under it is the
// leak signature.
import { homedir } from "node:os";
import { readdirSync } from "node:fs";

function realSessionsDir(): string {
  return join(homedir(), ".parachute", "agent", "sessions");
}

function listRealSessions(): string[] {
  try {
    return readdirSync(realSessionsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return []; // no real sessions dir on this machine → nothing to leak into
  }
}

// Snapshot the real sessions dir before the suite; after EACH test assert nothing new
// landed in it. Catches any spec write (or `setupProgrammaticSpawn` / boot re-register
// path) that escaped its temp-dir guard. We compare set membership, not exact equality,
// so a concurrently-running operator daemon spawning a legit agent doesn't false-fail
// — only a NEW dir attributable to a test trips it (the test-fixture names are distinct
// slugs like `eng`/`watcher`/`prog-test` that wouldn't normally be live).
const realSessionsBaseline = new Set(listRealSessions());

afterEach(() => {
  const now = listRealSessions();
  const leaked = now.filter((n) => !realSessionsBaseline.has(n));
  expect(
    leaked,
    `test wrote ${leaked.length} new session dir(s) into the REAL ${realSessionsDir()} ` +
      `(${leaked.join(", ")}) — every spec/state write must be inside a temp dir ` +
      `(PARACHUTE_AGENT_STATE_DIR + mkdtemp). See agent#75.`,
  ).toEqual([]);
});

/**
 * Run `fn` with PARACHUTE_AGENT_STATE_DIR pointed at a fresh mkdtemp dir, so
 * `defaultStateDir()` / `defaultSessionsDir()` (and anything that derives from them —
 * `setupProgrammaticSpawn`, the credentials store, boot re-register's default arg)
 * resolve UNDER the temp dir, never the operator's real home. Restores the prior env
 * value and removes the temp dir in `finally`, even on throw. This is the temp-dir
 * discipline the prompt calls the model — use it for any test that may write state.
 */
async function withTempStateDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "channel-state-"));
  const prev = process.env.PARACHUTE_AGENT_STATE_DIR;
  process.env.PARACHUTE_AGENT_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PARACHUTE_AGENT_STATE_DIR;
    else process.env.PARACHUTE_AGENT_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

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
  programmatic: ProgrammaticAgentRegistry;
  deliveryState?: DeliveryState;
}) {
  const registry = new ClientRegistry();
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: createFetchHandler(opts.channels, registry, {
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
    // withTempStateDir points PARACHUTE_AGENT_STATE_DIR at a fresh mkdtemp dir so
    // defaultStateDir/defaultSessionsDir resolve under <dir> (NOT the operator's real
    // ~/.parachute) and restores + cleans up on exit — the temp-dir discipline a
    // state-touching test must follow (agent#75). The afterEach backstop double-checks.
    await withTempStateDir(async (dir) => {
      const backend = new FakeBackend();
      const rec = recorder();
      const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
      // Seed a default Claude credential so setupProgrammaticSpawn's early resolve
      // succeeds against the temp store (no real store touched).
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "credentials.json"), JSON.stringify({ claude: { default: "oat_test" } }), { mode: 0o600 });

      const { srv, base } = buildServer({
        channels: new Map(),
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
      }
    });
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
          tags: ["#agent/message", "#agent/message/inbound"],
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

describe("inbound for an EXPECTED-but-not-yet-registered channel → queued pending, not dropped (agent#121)", () => {
  async function inbound(base: string, channel: string, noteId: string, content: string) {
    return fetch(`${base}/api/vault/inbound`, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify({
        note: {
          id: noteId,
          content,
          tags: ["#agent/message", "#agent/message/inbound"],
          metadata: { channel, direction: "inbound", sender: "aaron", ts: "2026-06-16T00:00:01Z" },
        },
      }),
    });
  }

  test("the inbound handler 200s AND the message is buffered pending (not dropped); register() replays it", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    // The desync: the channel is LIVE + EXPECTED (the def-instantiation path marked it) but
    // the programmatic agent is NOT yet registered. Before the fix, emit() would fall through
    // to a 0-subscriber push and DROP the message (the vault 200s + never retries → lost).
    programmatic.expectChannel("eng");
    expect(programmatic.hasChannel("eng")).toBe(false);

    const registry = new ClientRegistry();
    const deliveryState = new DeliveryState();
    const channels = new Map<string, Channel>([
      ["eng", vaultChannel("eng", registry, deliveryState, programmatic)],
    ]);
    const { srv, base } = buildServer({ channels, programmatic, deliveryState });
    try {
      // Inbound arrives BEFORE the agent is live → handler still 200s (the daemon now OWNS
      // the message; a 4xx/5xx would strand it in the vault's _pending_at forever).
      const res = await inbound(base, "eng", "note-1", "early message");
      expect(res.status).toBe(200);
      // It was buffered pending — NOT delivered to the (absent) worker, NOT dropped.
      await until(() => programmatic.pendingCount("eng") === 1);
      expect(programmatic.pendingCount("eng")).toBe(1);
      expect(backend.calls).toHaveLength(0);

      // The agent registers (instantiation completes) → the pending buffer replays.
      await programmatic.register({ name: "eng", channels: ["eng"], backend: "programmatic" });
      await until(() => rec.calls.length === 1);
      expect(backend.calls).toEqual([{ channel: "eng", message: "early message" }]);
      expect(rec.calls).toEqual([{ channel: "eng", reply: "reply:early message", inReplyTo: "note-1" }]);
      expect(programmatic.pendingCount("eng")).toBe(0);
    } finally {
      srv.stop(true);
    }
  });

  test("an inbound for an UNEXPECTED channel still 200s (no 4xx that would strand the vault trigger)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    // NOT expected, NOT registered — nothing maps to it. The handler must still 200 (a non-2xx
    // would leave the vault webhook stuck in _pending_at), even though there's nothing to run.
    const registry = new ClientRegistry();
    const deliveryState = new DeliveryState();
    const channels = new Map<string, Channel>([
      ["orphan", vaultChannel("orphan", registry, deliveryState, programmatic)],
    ]);
    const { srv, base } = buildServer({ channels, programmatic, deliveryState });
    try {
      const res = await inbound(base, "orphan", "note-1", "to nobody");
      expect(res.status).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 5));
      // Nothing queued (not expected), nothing ran — logged + dropped, but never a 4xx.
      expect(programmatic.pendingCount("orphan")).toBe(0);
      expect(backend.calls).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });
});

/** A live channels map containing `names` as keys — only membership matters to the
 *  boot re-register channel-existence guard (`channels.has(wakeChannel)`), so the
 *  transport is an inert stub. Mirrors a channels.json-derived map at the keys level. */
function liveChannels(names: string[]): Map<string, Channel> {
  const m = new Map<string, Channel>();
  for (const name of names) {
    const transport = { kind: "vault" } as unknown as Channel["transport"];
    m.set(name, { name, transport, entry: { name, transport: "vault" } });
  }
  return m;
}

describe("boot re-register", () => {
  test("a persisted programmatic spec whose channel IS configured → re-registered on start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prog-boot-"));
    try {
      const sessionsDir = join(dir, "sessions");
      // Persist a legacy NO-backend spec (a pre-field/retired-interactive spec → inert,
      // SKIPPED) + a programmatic spec.
      persistSpec(sessionWorkspace(sessionsDir, "watcher"), { name: "watcher", channels: ["watch"] });
      persistSpec(sessionWorkspace(sessionsDir, "eng"), { name: "eng", channels: ["eng"], backend: "programmatic" });

      const backend = new FakeBackend();
      const rec = recorder();
      const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });

      // Both wake channels ("eng", "watch") are live — so the ONLY skip is the
      // no-backend (retired-interactive) one, not the channel-existence guard.
      const count = await reregisterProgrammaticAgents(programmatic, liveChannels(["eng", "watch"]), sessionsDir);
      expect(count).toBe(1);
      expect(programmatic.hasName("eng")).toBe(true);
      // The no-backend spec was NOT re-registered (inert; never migrated to programmatic).
      expect(programmatic.hasName("watcher")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("orphan guard: a programmatic spec whose channel is NOT configured → SKIPPED (no phantom)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prog-boot-orphan-"));
    try {
      const sessionsDir = join(dir, "sessions");
      // Three spec dirs in the SAME temp sessions dir:
      //  (a) programmatic, channel "eng" — CONFIGURED → re-registered.
      //  (b) programmatic, channel "ghost" — NOT configured (orphaned/leaked) → SKIPPED.
      //  (c) legacy no-backend spec — interactive → SKIPPED regardless of channel.
      persistSpec(sessionWorkspace(sessionsDir, "eng"), { name: "eng", channels: ["eng"], backend: "programmatic" });
      persistSpec(sessionWorkspace(sessionsDir, "stray"), { name: "stray", channels: ["ghost"], backend: "programmatic" });
      persistSpec(sessionWorkspace(sessionsDir, "legacy"), { name: "legacy", channels: ["eng"] });

      const backend = new FakeBackend();
      const rec = recorder();
      const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });

      // Only "eng" is a live channel; "ghost" is not configured.
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
      let count: number;
      try {
        count = await reregisterProgrammaticAgents(programmatic, liveChannels(["eng"]), sessionsDir);
      } finally {
        console.log = origLog;
      }

      // Exactly the configured-channel agent was re-registered.
      expect(count).toBe(1);
      expect(programmatic.hasName("eng")).toBe(true);
      // The orphan (channel not configured) was SKIPPED — no phantom agent.
      expect(programmatic.hasName("stray")).toBe(false);
      expect(programmatic.hasChannel("ghost")).toBe(false);
      // The legacy no-backend (interactive) spec was SKIPPED too.
      expect(programmatic.hasName("legacy")).toBe(false);
      // And the orphan skip emitted the one-line notice naming the missing channel.
      expect(
        logs.some((l) => l.includes('skipping re-register of "stray"') && l.includes('channel "ghost" not configured')),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a programmatic spec with NO channel → SKIPPED (nothing to key/route on)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prog-boot-nochan-"));
    try {
      const sessionsDir = join(dir, "sessions");
      persistSpec(sessionWorkspace(sessionsDir, "headless"), { name: "headless", channels: [], backend: "programmatic" });

      const backend = new FakeBackend();
      const rec = recorder();
      const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });

      const count = await reregisterProgrammaticAgents(programmatic, liveChannels([]), sessionsDir);
      expect(count).toBe(0);
      expect(programmatic.hasName("headless")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no sessions dir → 0 re-registered (clean first boot)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    const count = await reregisterProgrammaticAgents(
      programmatic,
      liveChannels([]),
      join(tmpdir(), "does-not-exist-" + Date.now()),
    );
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

  test("GET /api/agents lists registered programmatic agents (no interactive tmux merge)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await programmatic.register({ name: "eng", channels: ["eng"], backend: "programmatic" });

    const { srv, base } = buildServer({ channels: new Map(), programmatic });
    try {
      const res = await fetch(`${base}/api/agents`, { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: AgentInfo[] };
      const byName = Object.fromEntries(body.agents.map((a) => [a.name, a]));
      // Only the programmatic agent — the interactive tmux merge was retired.
      expect(Object.keys(byName)).toEqual(["eng"]);
      expect(byName.eng!.backend).toBe("programmatic");
      expect(byName.eng!.status).toBe("idle");
    } finally {
      srv.stop(true);
    }
  });
});

describe("channel exclusion", () => {
  test("a DIFFERENT programmatic name onto an already-claimed channel → 409 (no orphan)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await programmatic.register({ name: "eng-a", channels: ["eng"], backend: "programmatic" });
    const { srv, base } = buildServer({ channels: new Map(), programmatic });
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
});

describe("backend default + interactive rejection", () => {
  // A NEW request that OMITS `backend` routes to the PROGRAMMATIC registry (the
  // default since 2026-06-16); the interactive backend is retired (rejected, below).
  test("a default (no backend) spawn hits the PROGRAMMATIC registry", async () => {
    // Temp-dir isolation via withTempStateDir (agent#75) — the spawn persists a
    // spec.json under defaultSessionsDir, which must resolve under the temp dir.
    await withTempStateDir(async (dir) => {
      const backend = new FakeBackend();
      const rec = recorder();
      const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
      // Seed a default Claude credential so setupProgrammaticSpawn's early credential
      // resolve succeeds (no real store).
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "credentials.json"), JSON.stringify({ claude: { default: "oat_test" } }), { mode: 0o600 });

      const { srv, base } = buildServer({ channels: new Map(), programmatic });
      try {
        const res = await fetch(`${base}/api/agents`, {
          method: "POST",
          headers: { ...adminAuth, "content-type": "application/json" },
          body: JSON.stringify({ name: "aaron", channels: ["aaron"] }), // no backend → programmatic
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { backend: string }).backend).toBe("programmatic");
        // It landed in the programmatic registry.
        expect(programmatic.hasName("aaron")).toBe(true);
      } finally {
        srv.stop(true);
      }
    });
  });

  test("an explicit backend:\"interactive\" spawn is REJECTED (retired) → 400", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    const { srv, base } = buildServer({ channels: new Map(), programmatic });
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "aaron", channels: ["aaron"], backend: "interactive" }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("retired");
      // Nothing landed in the programmatic registry.
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
    const { srv, base } = buildServer({ channels: new Map(), programmatic });
    try {
      const res = await fetch(`${base}/api/agents/eng`, { method: "DELETE", headers: adminAuth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { backend: string; killed: boolean };
      expect(body.backend).toBe("programmatic");
      expect(body.killed).toBe(true);
      expect(programmatic.hasName("eng")).toBe(false);
    } finally {
      srv.stop(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// AGENT-TO-AGENT CALLBACK ROUTING ("reply_to") — the DAEMON-side wiring (design
// 2026-06-20-agent-callbacks.md). The registry unit test owns the drain mechanics; here we
// verify the WIRING: callbackFieldsFromMeta extraction + coercion, the contextFor.emit fork
// threading the callback fields off `msg.meta` onto the QueuedMessage end-to-end, and
// buildWriteCallback's own-it-don't-strand posture for an unknown reply_to channel.
// ───────────────────────────────────────────────────────────────────────────────

/** A recorder WriteCallback for the wiring tests. */
function callbackRec(): { calls: { channel: string; content: string; meta: CallbackMeta }[]; fn: WriteCallback } {
  const calls: { channel: string; content: string; meta: CallbackMeta }[] = [];
  const fn: WriteCallback = async (channel, content, meta) => {
    calls.push({ channel, content, meta });
  };
  return { calls, fn };
}

describe("callbackFieldsFromMeta — extraction + string→number coercion", () => {
  test("present fields are extracted; delegation_depth coerced to an integer", () => {
    const got = callbackFieldsFromMeta({
      reply_to: "orchestrator",
      correlation_id: "corr-1",
      delegation_depth: "3",
      // unrelated note metadata must be ignored.
      channel: "worker",
      ts: "2026-06-20T00:00:00Z",
    });
    expect(got).toEqual({ replyTo: "orchestrator", correlationId: "corr-1", delegationDepth: 3 });
  });

  test("absent reply_to → empty (a non-delegated turn); a clean spread no-op", () => {
    expect(callbackFieldsFromMeta({ channel: "worker", ts: "x" })).toEqual({});
    expect(callbackFieldsFromMeta(undefined)).toEqual({});
  });

  test("garbage / absent / non-positive delegation_depth reads as 0 (omitted)", () => {
    expect(callbackFieldsFromMeta({ reply_to: "o", delegation_depth: "abc" })).toEqual({ replyTo: "o" });
    expect(callbackFieldsFromMeta({ reply_to: "o", delegation_depth: "-5" })).toEqual({ replyTo: "o" });
    expect(callbackFieldsFromMeta({ reply_to: "o" })).toEqual({ replyTo: "o" });
  });
});

describe("contextFor.emit threads reply_to → a callback end-to-end through the real fork", () => {
  test("an inbound emit carrying reply_to metadata → the drain delivers a callback to that channel", async () => {
    const backend = new FakeBackend();
    backend.resultFor = (m) => ({ ok: true, reply: "reply:" + m });
    const out = recorder();
    const cb = callbackRec();
    const programmatic = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: out.fn,
      writeCallback: cb.fn,
    });
    await programmatic.register({ name: "worker", channels: ["worker"], backend: "programmatic" });

    const registry = new ClientRegistry();
    const deliveryState = new DeliveryState();
    const ctx = contextFor(registry, "worker", deliveryState, programmatic);

    // Simulate a vault inbound note whose metadata carried the callback fields — the SAME
    // shape ingestInbound flattens onto `meta` (all string-valued, incl. delegation_depth).
    ctx.emit({
      channel: "worker",
      content: "do the sub-task",
      meta: {
        note_id: "inbound-99",
        reply_to: "orchestrator",
        correlation_id: "corr-xyz",
        delegation_depth: "1",
        source: "vault",
      },
      source: "vault",
    });

    await until(() => cb.calls.length === 1);
    expect(cb.calls[0]!.channel).toBe("orchestrator");
    expect(cb.calls[0]!.meta.status).toBe("ok");
    expect(cb.calls[0]!.meta.source_channel).toBe("worker");
    expect(cb.calls[0]!.meta.correlation_id).toBe("corr-xyz");
    expect(cb.calls[0]!.meta.delegation_depth).toBe("2"); // incoming "1" → 1, +1 hop.
  });

  test("an inbound emit WITHOUT reply_to → no callback (the common path)", async () => {
    const backend = new FakeBackend();
    const out = recorder();
    const cb = callbackRec();
    const programmatic = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: out.fn,
      writeCallback: cb.fn,
    });
    await programmatic.register({ name: "worker", channels: ["worker"], backend: "programmatic" });
    const ctx = contextFor(new ClientRegistry(), "worker", new DeliveryState(), programmatic);

    ctx.emit({ channel: "worker", content: "plain", meta: { note_id: "n1", source: "vault" }, source: "vault" });
    await until(() => out.calls.length === 1);
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(cb.calls).toHaveLength(0);
  });
});

describe("buildWriteCallback — own-it-don't-strand for an unknown reply_to channel", () => {
  const meta: CallbackMeta = {
    callback: "true",
    status: "ok",
    source_channel: "worker",
    source_thread: "thread-1",
    delegation_depth: "1",
  };

  test("an unknown reply_to channel → LOGS + returns (no throw, so the drain isn't stranded)", async () => {
    const channels = new Map<string, Channel>(); // empty — the reply_to channel is gone.
    const write = buildWriteCallback(channels);
    // Must NOT throw (the registry would otherwise log it as a callback error, but the
    // own-it posture is to no-op cleanly for a torn-down sender).
    await expect(write("ghost-orchestrator", "[callback] worker finished (ok)", meta)).resolves.toBeUndefined();
  });

  test("a live VaultTransport reply_to channel → writeCallback is invoked on it", async () => {
    const vt = new VaultTransport({ vault: "default", vaultUrl: "http://127.0.0.1:1940", token: "x" });
    // Bind a ctx so `this.channel` resolves, and stub writeCallback so we don't hit the network.
    (vt as unknown as { ctx: unknown }).ctx = { channel: "orchestrator", emit() {}, emitPermissionVerdict() {} };
    let captured: { content: string; meta: CallbackMeta } | undefined;
    (vt as unknown as { writeCallback: unknown }).writeCallback = async (content: string, m: CallbackMeta) => {
      captured = { content, meta: m };
      return { sent: ["cb-note-1"] };
    };
    const channels = new Map<string, Channel>([
      ["orchestrator", { name: "orchestrator", transport: vt, entry: { name: "orchestrator", transport: "vault" } }],
    ]);
    const write = buildWriteCallback(channels);
    await write("orchestrator", "[callback] worker finished (ok)", meta);
    expect(captured).toBeDefined();
    expect(captured!.meta.source_channel).toBe("worker");
    expect(captured!.content).toContain("[callback]");
  });
});
