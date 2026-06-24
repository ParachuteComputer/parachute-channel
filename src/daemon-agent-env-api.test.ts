/**
 * Integration tests for GET /api/agents/<name>/env — the EFFECTIVE-ENV operability
 * endpoint (see what env vars an agent's `claude -p` turn will run with, NAMES ONLY).
 *
 * The endpoint composes three tagged sources — `default` (operator env.default),
 * `channel` (per-agent override env.channels[<agent>]), and `grant:<service>` (service
 * env vars an APPROVED grant WOULD inject) — in precedence order channel > default >
 * grant, marking shadowed lower-precedence entries `overridden:true`.
 *
 * Load-bearing assertions (the security posture):
 *   - VALUES NEVER appear in the response (only names) — across all three layers.
 *   - grant env names are derived WITHOUT a material fetch (the GrantsClient's
 *     getMaterial is asserted NEVER called).
 *   - resilient when the grants/hub is unreachable at instantiate (env layers + a
 *     degraded grant status still come back; the read never 500s).
 *
 * Harness mirrors daemon-agent-defs-api.test.ts: the hub JWT validator is stubbed
 * (sentinel tokens → fixed scopes); the def-vault REST is an in-memory fake; the state
 * dir is sandboxed so the env-store writes never touch the operator's ~/.parachute.
 */
import { describe, test, expect, mock, beforeAll, afterAll, beforeEach } from "bun:test";
import { HubJwtError, looksLikeJwt } from "@openparachute/scope-guard";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the state dir — the route reads the env store via describeChannelEnv() →
// defaultStateDir(); the tests seed it via setChannelEnvVar(). Pin to a throwaway dir
// so we never touch the operator's real ~/.parachute/agent (feedback_sandbox_destructive_cli).
let stateDir: string;
let priorStateDir: string | undefined;
beforeAll(() => {
  priorStateDir = process.env.PARACHUTE_AGENT_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), "agent-env-api-state-"));
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
import { GrantsClient } from "./grants.ts";
import {
  setChannelEnvVar,
  removeChannelEnvVar,
  readCredentialsFile,
} from "./credentials.ts";
import type { Channel } from "./registry.ts";

const adminAuth = { authorization: "Bearer " + ADMIN_TOKEN } as const;
const readAuth = { authorization: "Bearer " + READ_TOKEN } as const;

// ---------------------------------------------------------------------------
// A FAKE def-vault REST (in-memory) — the registry's DefVaultClient drives it via an
// injected fetchFn. Only the routes the registry calls (list / patch-status) matter.
// ---------------------------------------------------------------------------
interface FakeNote {
  id: string;
  content?: string;
  tags?: string[];
  metadata: Record<string, unknown>;
}
class FakeDefVault {
  readonly notes = new Map<string, FakeNote>();
  seed(note: FakeNote): void {
    this.notes.set(note.id, note);
  }
  fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    const m = url.pathname.match(/\/vault\/[^/]+\/api\/notes(?:\/(.+))?$/);
    const noteId = m?.[1] ? decodeURIComponent(m[1]) : undefined;
    const j = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && noteId === undefined) return j(Array.from(this.notes.values()));
    if (method === "GET" && noteId !== undefined) {
      const note = this.notes.get(noteId);
      return note ? j(note) : j({ error: "not_found" }, 404);
    }
    if (method === "PATCH" && noteId !== undefined) {
      const note = this.notes.get(noteId);
      if (!note) return j({ error: "not_found" }, 404);
      const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string; metadata?: Record<string, unknown> };
      if (body.content !== undefined) note.content = body.content;
      if (body.metadata) note.metadata = { ...note.metadata, ...body.metadata };
      return j(note);
    }
    return j({ error: "unhandled", method, path: url.pathname }, 500);
  }) as unknown as typeof fetch;
}

/** No-op InstantiateDeps — instantiate runs (own-vault) without real channel/spawn I/O. */
function noopDeps(): InstantiateDeps {
  return {
    ensureChannel: async () => {},
    setupAndRegister: async () => {},
    deregister: async () => true,
    removeChannel: async () => true,
  };
}

/**
 * A GrantsClient over a controllable hub fetch. registerGrant returns a status we set
 * per connection key (so a `wants:` connection resolves to `approved`/`pending`).
 * getMaterial is FORBIDDEN — the read endpoint must never fetch material; if it does,
 * the test fails loudly. Records the URLs hit so we can assert no `/material` call.
 */
function grantsClientWith(statusByKeyHint: Record<string, string>) {
  const calls: string[] = [];
  let materialFetched = false;
  const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url.pathname}`);
    const j = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname.endsWith("/material")) {
      materialFetched = true;
      return j({ error: "material must never be fetched by a names-only read" }, 500);
    }
    if (method === "PUT" && url.pathname === "/admin/grants") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { agent: string; connection: { kind: string; target: string; inject?: string[] } };
      // Re-derive the same key the registry will look up. For a service it's
      // `<inject-joined>:<target>`; we key the hint by the bare service target for ease.
      const status = statusByKeyHint[body.connection.target] ?? "pending";
      return j({ id: `grant-${body.connection.target}`, agent: body.agent, connection: body.connection, status });
    }
    if (method === "GET" && url.pathname === "/admin/grants") return j({ grants: [] });
    if (method === "POST" && url.pathname === "/admin/grants/reconcile") return j({ pruned: 0 });
    return j({ error: "unhandled", method, path: url.pathname }, 500);
  }) as unknown as typeof fetch;
  const client = new GrantsClient({ hubOrigin: "http://hub.test", managerBearer: "mgr", fetchFn });
  return { client, calls, get materialFetched() { return materialFetched; } };
}

function serverWith(channels: Map<string, Channel>, agentDefs?: AgentDefRegistry) {
  const registry = new ClientRegistry();
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: createFetchHandler(channels, registry, agentDefs ? { agentDefs } : {}),
  });
  return { srv, base: `http://127.0.0.1:${srv.port}` };
}

const emptyChannels = () => new Map<string, Channel>();

// Clean the env store between tests so layer assertions are deterministic.
function wipeEnvStore() {
  const f = readCredentialsFile(stateDir);
  for (const n of Object.keys(f.env?.default ?? {})) removeChannelEnvVar(null, n, stateDir);
  for (const [ch, vars] of Object.entries(f.env?.channels ?? {})) {
    for (const n of Object.keys(vars)) removeChannelEnvVar(ch, n, stateDir);
  }
}
beforeEach(() => wipeEnvStore());

// Secret sentinels — assert these VALUES never appear in any response body.
const SECRET_VALUES = ["ghp_supersecret", "cf_supersecret", "default_secret_val", "grant_token_secret"];
function assertNoSecretValues(bodyText: string) {
  for (const v of SECRET_VALUES) expect(bodyText).not.toContain(v);
}

describe("GET /api/agents/<name>/env — auth + shape", () => {
  test("no Authorization → 401 (admin-gated)", async () => {
    const { srv, base } = serverWith(emptyChannels());
    const res = await fetch(`${base}/api/agents/uni-dev/env`);
    expect(res.status).toBe(401);
    srv.stop();
  });

  test("a read-only token → 403 (admin scope required; authenticated but insufficient)", async () => {
    const { srv, base } = serverWith(emptyChannels());
    const res = await fetch(`${base}/api/agents/uni-dev/env`, { headers: readAuth });
    expect(res.status).toBe(403);
    srv.stop();
  });

  test("no def registered → env-store layers only + a note (never a 500)", async () => {
    setChannelEnvVar(null, "DEFAULT_VAR", "default_secret_val", stateDir);
    setChannelEnvVar("uni-dev", "CHANNEL_VAR", "ghp_supersecret", stateDir);
    const { srv, base } = serverWith(emptyChannels()); // NO agentDefs wired.
    const res = await fetch(`${base}/api/agents/uni-dev/env`, { headers: adminAuth });
    expect(res.status).toBe(200);
    const text = await res.text();
    assertNoSecretValues(text);
    const body = JSON.parse(text) as { env: Array<{ name: string; source: string }>; note?: string };
    expect(body.note).toBeDefined();
    const names = body.env.map((e) => e.name).sort();
    expect(names).toEqual(["CHANNEL_VAR", "DEFAULT_VAR"]);
    expect(body.env.find((e) => e.name === "DEFAULT_VAR")!.source).toBe("default");
    expect(body.env.find((e) => e.name === "CHANNEL_VAR")!.source).toBe("channel");
    srv.stop();
  });
});

describe("GET /api/agents/<name>/env — composes all three sources + precedence", () => {
  /** Build a registry with one live def for `uni-dev` declaring `env:github`, with the
   *  grant status the hub reports for it. Returns the registry + the grants probe. */
  async function liveDefRegistry(githubGrantStatus: string) {
    const fake = new FakeDefVault();
    fake.seed({
      id: "Agents/uni-dev",
      content: "You are uni-dev.",
      tags: ["#agent/definition"],
      metadata: { name: "uni-dev", backend: "programmatic", mode: "single-threaded", wants: "env:github" },
    });
    const grants = grantsClientWith({ github: githubGrantStatus });
    const reg = new AgentDefRegistry(noopDeps(), {
      bindings: [{ vault: "default", vaultUrl: "http://127.0.0.1:1940", token: "vtok" }],
      fetchFn: fake.fetch,
      grants: grants.client,
    });
    await reg.loadAll(); // instantiate → registers the grant + resolves status (no material fetch).
    return { reg, grants };
  }

  test("default + channel + approved-grant env merge, channel wins on collision, grant names derived WITHOUT material fetch, VALUES never returned", async () => {
    // Seed the env store: a default-only var, a channel-only var, and a COLLISION on
    // GITHUB_TOKEN (both the channel override AND the github grant target the same name).
    setChannelEnvVar(null, "DEFAULT_VAR", "default_secret_val", stateDir);
    setChannelEnvVar(null, "GITHUB_TOKEN", "default_secret_val", stateDir); // default layer also sets it
    setChannelEnvVar("uni-dev", "CHANNEL_VAR", "ghp_supersecret", stateDir);
    setChannelEnvVar("uni-dev", "GITHUB_TOKEN", "ghp_supersecret", stateDir); // channel override (wins)

    const { reg, grants } = await liveDefRegistry("approved"); // github grant approved → injects GITHUB_TOKEN
    const { srv, base } = serverWith(emptyChannels(), reg);
    const res = await fetch(`${base}/api/agents/uni-dev/env`, { headers: adminAuth });
    expect(res.status).toBe(200);
    const text = await res.text();
    // SECURITY: no value ever leaks, from any of the three layers.
    assertNoSecretValues(text);
    expect(text).not.toContain('"value"');

    const body = JSON.parse(text) as { env: Array<{ name: string; source: string; overridden?: boolean }>; note?: string };
    expect(body.note).toBeUndefined(); // a def IS registered → no degraded note.

    // CHANNEL_VAR — channel only.
    const channelVar = body.env.filter((e) => e.name === "CHANNEL_VAR");
    expect(channelVar).toHaveLength(1);
    expect(channelVar[0]!.source).toBe("channel");
    expect(channelVar[0]!.overridden).toBeUndefined();

    // DEFAULT_VAR — default only.
    const defaultVar = body.env.filter((e) => e.name === "DEFAULT_VAR");
    expect(defaultVar).toHaveLength(1);
    expect(defaultVar[0]!.source).toBe("default");

    // GITHUB_TOKEN — set in ALL THREE layers; winner is channel, the other two shadowed.
    const gh = body.env.filter((e) => e.name === "GITHUB_TOKEN");
    expect(gh).toHaveLength(3);
    const winner = gh.find((e) => !e.overridden)!;
    expect(winner.source).toBe("channel"); // channel > default > grant
    const shadowed = gh.filter((e) => e.overridden);
    expect(shadowed.map((e) => e.source).sort()).toEqual(["default", "grant:github"]);

    // The grant env NAME was derived (GITHUB_TOKEN, tagged grant:github) — and the
    // grants client was NEVER asked for material (only PUT register at instantiate).
    expect(grants.materialFetched).toBe(false);
    expect(grants.calls.some((c) => c.includes("/material"))).toBe(false);
    srv.stop();
  });

  test("a PENDING (not approved) grant does NOT contribute an env name", async () => {
    const { reg, grants } = await liveDefRegistry("pending"); // github grant pending → no inject
    const { srv, base } = serverWith(emptyChannels(), reg);
    const res = await fetch(`${base}/api/agents/uni-dev/env`, { headers: adminAuth });
    const body = (await res.json()) as { env: Array<{ name: string; source: string }> };
    // No grant: layer at all (nothing approved), and no env-store vars seeded.
    expect(body.env.filter((e) => e.source.startsWith("grant:"))).toHaveLength(0);
    expect(body.env.find((e) => e.name === "GITHUB_TOKEN")).toBeUndefined();
    expect(grants.materialFetched).toBe(false);
    srv.stop();
  });
});

describe("GET /api/agents/<name>/env — resilient when grants/hub unreachable", () => {
  test("a def whose grant registration fails (hub down) still returns env-store layers, no 500", async () => {
    // The env store has layers even though the hub is unreachable.
    setChannelEnvVar(null, "DEFAULT_VAR", "default_secret_val", stateDir);
    setChannelEnvVar("uni-dev", "CHANNEL_VAR", "ghp_supersecret", stateDir);

    const fake = new FakeDefVault();
    fake.seed({
      id: "Agents/uni-dev",
      content: "You are uni-dev.",
      tags: ["#agent/definition"],
      metadata: { name: "uni-dev", backend: "programmatic", mode: "single-threaded", wants: "env:github" },
    });
    // A grants client whose hub fetch always throws — registerGrant fails at instantiate,
    // so the connection resolves as pending (not approved); the load still succeeds own-vault.
    const downFetch = (async () => {
      throw new Error("ECONNREFUSED hub down");
    }) as unknown as typeof fetch;
    const reg = new AgentDefRegistry(noopDeps(), {
      bindings: [{ vault: "default", vaultUrl: "http://127.0.0.1:1940", token: "vtok" }],
      fetchFn: fake.fetch,
      grants: new GrantsClient({ hubOrigin: "http://hub.test", managerBearer: "mgr", fetchFn: downFetch }),
    });
    await reg.loadAll();

    const { srv, base } = serverWith(emptyChannels(), reg);
    const res = await fetch(`${base}/api/agents/uni-dev/env`, { headers: adminAuth });
    expect(res.status).toBe(200); // NOT a 500.
    const text = await res.text();
    assertNoSecretValues(text);
    const body = JSON.parse(text) as { env: Array<{ name: string; source: string }> };
    // Env-store layers came back even with the hub down; no approved grant → no grant layer.
    const names = body.env.map((e) => e.name).sort();
    expect(names).toEqual(["CHANNEL_VAR", "DEFAULT_VAR"]);
    expect(body.env.filter((e) => e.source.startsWith("grant:"))).toHaveLength(0);
    srv.stop();
  });
});
