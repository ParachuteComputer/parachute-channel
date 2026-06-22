/**
 * Unit tests for vault-native agent definitions (design
 * 2026-06-17-vault-native-agents, Phase 4a).
 *
 * Three layers, all deterministic — `fetch` is stubbed (restored in afterEach, NO
 * global mock.module leak) and the registry's side-effects are INJECTED so the
 * lifecycle is exercised without a daemon, a vault, a sandbox, or tmux:
 *   - parseAgentDef: note (body + metadata) → AgentSpec, defaults + validation;
 *   - DefVaultClient: the def query encoding + the status PATCH;
 *   - AgentDefRegistry: instantiate / reload (update + delete) / deregister, with a
 *     recorder for ensureChannel / setupAndRegister / deregister / removeChannel.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  parseAgentDef,
  resolveDefStatus,
  DefVaultClient,
  AgentDefRegistry,
  AgentDefParseError,
  AgentDefWriteError,
  type DefVaultBinding,
  type InstantiateDeps,
} from "./agent-defs.ts";
import { GrantsClient, connectionKey, type ConnectionSpec } from "./grants.ts";
import type { AgentSpec } from "./sandbox/types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// parseAgentDef — note → AgentSpec
// ---------------------------------------------------------------------------

describe("parseAgentDef", () => {
  test("maps body → systemPrompt, metadata → spec; defaults backend=programmatic, own-vault binding", () => {
    const def = parseAgentDef(
      {
        id: "Agents/uni-dev",
        content: "You are uni-dev, the development agent for the Parachute project.",
        metadata: { name: "uni-dev" },
      },
      { vault: "default" },
    );
    expect(def.noteId).toBe("Agents/uni-dev");
    expect(def.name).toBe("uni-dev");
    const spec = def.spec;
    expect(spec.name).toBe("uni-dev");
    // Wake channel = the agent name (agent ≡ channel).
    expect(spec.channels).toEqual(["uni-dev"]);
    expect(spec.backend).toBe("programmatic");
    // Own-vault binding (4a): the def-vault, write-scoped.
    expect(spec.vault).toEqual({ name: "default", access: "write" });
    // The note BODY is the system prompt.
    expect(spec.systemPrompt).toBe(
      "You are uni-dev, the development agent for the Parachute project.",
    );
    // No declared connections → resolves enabled.
    expect(def.declaredConnections).toEqual([]);
    expect(resolveDefStatus(def)).toEqual({ status: "enabled" });
  });

  test("parses the full config knobs (backend, mode, workspace, filesystem, network, egress)", () => {
    const def = parseAgentDef(
      {
        id: "n1",
        content: "role prose",
        metadata: {
          name: "builder",
          backend: "programmatic",
          systemPromptMode: "replace",
          workspace: "/Users/me/code/proj",
          filesystem: "full",
          network: "restricted",
          egress: "api.github.com, registry.npmjs.org",
        },
      },
      { vault: "default" },
    );
    const spec = def.spec;
    expect(spec.systemPromptMode).toBe("replace");
    expect(spec.workspace).toBe("/Users/me/code/proj");
    expect(spec.filesystem).toBe("full");
    expect(spec.network).toBe("restricted");
    expect(spec.egress).toEqual(["api.github.com", "registry.npmjs.org"]);
  });

  test("metadata.model → spec.model (alias or full id); absent → undefined", () => {
    const withModel = parseAgentDef(
      { id: "n1", content: "x", metadata: { name: "a", model: "opus" } },
      { vault: "default" },
    );
    expect(withModel.spec.model).toBe("opus");

    const fullId = parseAgentDef(
      { id: "n1", content: "x", metadata: { name: "a", model: "claude-opus-4-8" } },
      { vault: "default" },
    );
    expect(fullId.spec.model).toBe("claude-opus-4-8");

    const noModel = parseAgentDef(
      { id: "n1", content: "x", metadata: { name: "a" } },
      { vault: "default" },
    );
    expect(noModel.spec.model).toBeUndefined();
  });

  test("a malformed model (spaces/control chars) is a parse error, not a silent passthrough", () => {
    expect(() =>
      parseAgentDef(
        { id: "n", content: "x", metadata: { name: "a", model: "opus 4.8" } },
        { vault: "v" },
      ),
    ).toThrow(/not a valid model name/);
  });

  test("a blank body → no systemPrompt (CC default untouched), no mode flag", () => {
    const def = parseAgentDef(
      { id: "n1", content: "   \n  ", metadata: { name: "a", systemPromptMode: "replace" } },
      { vault: "default" },
    );
    expect("systemPrompt" in def.spec).toBe(false);
    expect("systemPromptMode" in def.spec).toBe(false);
  });

  test("parses `uses` connections (NOT granted in 4a) → status pending listing them", () => {
    const def = parseAgentDef(
      {
        id: "n1",
        content: "role",
        metadata: { name: "researcher", uses: "github, vault:research:read" },
      },
      { vault: "default" },
    );
    expect(def.declaredConnections).toEqual(["github", "vault:research:read"]);
    expect(resolveDefStatus(def)).toEqual({
      status: "pending",
      pending: ["github", "vault:research:read"],
    });
  });

  test("parses an array-valued `uses` field too", () => {
    const def = parseAgentDef(
      { id: "n1", content: "role", metadata: { name: "x", uses: ["github", "cloudflare"] } },
      { vault: "default" },
    );
    expect(def.declaredConnections).toEqual(["github", "cloudflare"]);
  });

  test("parses the structured `wants:` field into connection specs (4b)", () => {
    const def = parseAgentDef(
      {
        id: "n1",
        content: "role",
        metadata: {
          name: "researcher",
          wants: "vault:research:read#published, env:github, mcp:github, mcp:https://remote/mcp",
        },
      },
      { vault: "default" },
    );
    expect(def.wants).toEqual([
      { kind: "vault", target: "research", access: "read", tags: ["#published"] },
      { kind: "service", target: "github", inject: ["env", "mcp"] }, // merged
      { kind: "mcp", target: "https://remote/mcp" },
    ]);
    // No grants client wired (pure resolveDefStatus) → pending listing the conn keys.
    expect(resolveDefStatus(def)).toEqual({
      status: "pending",
      pending: def.wants.map((c) => connectionKey(c)),
    });
  });

  test("a def with no `wants:` → wants is [] (own-vault only → enabled)", () => {
    const def = parseAgentDef(
      { id: "n1", content: "role", metadata: { name: "x" } },
      { vault: "default" },
    );
    expect(def.wants).toEqual([]);
    expect(resolveDefStatus(def)).toEqual({ status: "enabled" });
  });

  test("a MALFORMED `wants:` makes the WHOLE def a parse error (no half-instantiate)", () => {
    expect(() =>
      parseAgentDef(
        { id: "n1", content: "role", metadata: { name: "x", wants: "vault:research" } },
        { vault: "default" },
      ),
    ).toThrow(AgentDefParseError);
    expect(() =>
      parseAgentDef(
        { id: "n1", content: "role", metadata: { name: "x", wants: "smtp:server" } },
        { vault: "default" },
      ),
    ).toThrow(/unknown kind/);
  });

  test("parses JSON-array mounts; ignores malformed entries", () => {
    const def = parseAgentDef(
      {
        id: "n1",
        content: "role",
        metadata: {
          name: "x",
          mounts: JSON.stringify([
            { hostPath: "/data", mountPath: "/data", mode: "ro" },
            { hostPath: "relative", mountPath: "/x", mode: "ro" }, // dropped (not absolute)
            { hostPath: "/y", mountPath: "/y", mode: "bogus" }, // dropped (bad mode)
          ]),
        },
      },
      { vault: "default" },
    );
    expect(def.spec.mounts).toEqual([{ hostPath: "/data", mountPath: "/data", mode: "ro" }]);
  });

  test("rejects a note with no metadata.name", () => {
    expect(() => parseAgentDef({ id: "n1", content: "x", metadata: {} }, { vault: "default" })).toThrow(
      AgentDefParseError,
    );
  });

  test("rejects a non-slug name", () => {
    expect(() =>
      parseAgentDef({ id: "n1", content: "x", metadata: { name: "has spaces" } }, { vault: "default" }),
    ).toThrow(/slug/);
  });

  test("rejects a bad backend / filesystem / network value", () => {
    expect(() =>
      parseAgentDef({ id: "n", content: "x", metadata: { name: "a", backend: "weird" } }, { vault: "v" }),
    ).toThrow(/backend/);
    expect(() =>
      parseAgentDef({ id: "n", content: "x", metadata: { name: "a", filesystem: "weird" } }, { vault: "v" }),
    ).toThrow(/filesystem/);
    expect(() =>
      parseAgentDef({ id: "n", content: "x", metadata: { name: "a", network: "weird" } }, { vault: "v" }),
    ).toThrow(/network/);
  });

  test("rejects backend:interactive (retired — design 2026-06-18)", () => {
    expect(() =>
      parseAgentDef({ id: "n", content: "x", metadata: { name: "a", backend: "interactive" } }, { vault: "v" }),
    ).toThrow(/interactive/);
  });

  test("accepts backend:channel (design 2026-06-18-channel-backend), threads it onto the spec", () => {
    const def = parseAgentDef(
      { id: "Agents/laptop", content: "You are the laptop agent.", metadata: { name: "laptop", backend: "channel" } },
      { vault: "default" },
    );
    expect(def.spec.backend).toBe("channel");
    expect(def.name).toBe("laptop");
    // The body is still the system prompt (the session adopts it on next-message).
    expect(def.spec.systemPrompt).toBe("You are the laptop agent.");
    // Wake channel = the agent name (agent ≡ channel) — same collapse as programmatic.
    expect(def.spec.channels).toEqual(["laptop"]);
  });

  // --- execution-lifecycle mode (the Phase-3 prerequisite) ---

  test("mode defaults to single-threaded when omitted (= today's behavior)", () => {
    const def = parseAgentDef(
      { id: "Agents/uni-dev", content: "role", metadata: { name: "uni-dev" } },
      { vault: "default" },
    );
    expect(def.spec.mode).toBe("single-threaded");
    // The def note id is threaded onto the spec as provenance (for the `#agent/thread` note).
    expect(def.spec.definition).toBe("Agents/uni-dev");
  });

  test("accepts mode:single-threaded explicitly", () => {
    const def = parseAgentDef(
      { id: "n1", content: "role", metadata: { name: "a", mode: "single-threaded" } },
      { vault: "v" },
    );
    expect(def.spec.mode).toBe("single-threaded");
  });

  test("accepts mode:multi-threaded, threads it onto the spec", () => {
    const def = parseAgentDef(
      { id: "Agents/digest", content: "Run the daily digest.", metadata: { name: "digest", mode: "multi-threaded" } },
      { vault: "default" },
    );
    expect(def.spec.mode).toBe("multi-threaded");
    expect(def.spec.definition).toBe("Agents/digest");
  });

  test("rejects an UNKNOWN mode value with AgentDefParseError", () => {
    expect(() =>
      parseAgentDef({ id: "n", content: "x", metadata: { name: "a", mode: "weird" } }, { vault: "v" }),
    ).toThrow(/mode must be "single-threaded" or "multi-threaded"/);
  });

  test("DUAL-ACCEPTs the legacy aliases (resident→single, one-shot/per-thread→multi)", () => {
    const resident = parseAgentDef(
      { id: "n1", content: "x", metadata: { name: "a", mode: "resident" } },
      { vault: "v" },
    );
    expect(resident.spec.mode).toBe("single-threaded");

    const oneShot = parseAgentDef(
      { id: "n2", content: "x", metadata: { name: "b", mode: "one-shot" } },
      { vault: "v" },
    );
    expect(oneShot.spec.mode).toBe("multi-threaded");

    const perThread = parseAgentDef(
      { id: "n3", content: "x", metadata: { name: "c", mode: "per-thread" } },
      { vault: "v" },
    );
    expect(perThread.spec.mode).toBe("multi-threaded");
  });

  test("rejects a relative workspace path", () => {
    expect(() =>
      parseAgentDef({ id: "n", content: "x", metadata: { name: "a", workspace: "rel/path" } }, { vault: "v" }),
    ).toThrow(/absolute/);
  });

  test("does NOT read any secret field off the note (only references)", () => {
    // A note that tries to smuggle a token must NOT end up on the spec.
    const def = parseAgentDef(
      { id: "n", content: "x", metadata: { name: "a", token: "sekret", CLAUDE_CODE_OAUTH_TOKEN: "sekret2" } },
      { vault: "v" },
    );
    expect(JSON.stringify(def.spec)).not.toContain("sekret");
  });
});

// ---------------------------------------------------------------------------
// DefVaultClient — the def query + the status PATCH
// ---------------------------------------------------------------------------

const binding: DefVaultBinding = {
  vault: "default",
  vaultUrl: "http://127.0.0.1:1940",
  token: "write-token",
};

describe("DefVaultClient", () => {
  test("listDefNotes queries by the EXACT #agent/definition tag (encoded) with Bearer", async () => {
    const urls: string[] = [];
    let auth = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
      return new Response(
        JSON.stringify([
          { id: "Agents/uni-dev", content: "role A", metadata: { name: "uni-dev" } },
          { id: "Agents/researcher", content: "role B", metadata: { name: "researcher" } },
          { id: "", content: "no id", metadata: { name: "skip" } }, // dropped (no id)
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const client = new DefVaultClient(binding);
    const notes = await client.listDefNotes();
    expect(urls).toHaveLength(1);
    // `#agent/definition` → `%23agent%2Fdefinition` (both `#` and `/` encoded).
    expect(urls[0]).toContain("tag=%23agent%2Fdefinition");
    expect(urls[0]).toContain("include_content=true");
    expect(auth).toBe("Bearer write-token");
    expect(notes.map((n) => n.id)).toEqual(["Agents/uni-dev", "Agents/researcher"]);
  });

  test("listDefNotes throws on a non-ok vault response", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const client = new DefVaultClient(binding);
    await expect(client.listDefNotes()).rejects.toThrow(/list defs failed \(500\)/);
  });

  test("patchStatus PATCHes status + clears pending when enabled", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const client = new DefVaultClient(binding);
    await client.patchStatus("Agents/uni-dev", "enabled");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/api/notes/");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.metadata.status).toBe("enabled");
    // Always sets pending (empty here) so a prior list doesn't go stale.
    expect(body.metadata.pending).toBe("");
    // MUST carry the vault mutation precondition or the PATCH 428s (the real-vault
    // bug this guards): `force: true` since status is the module's own derived field.
    expect(body.force).toBe(true);
  });

  test("patchStatus writes the pending list joined when pending", async () => {
    let captured: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)).metadata;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const client = new DefVaultClient(binding);
    await client.patchStatus("n", "pending", ["github", "vault:research:read"]);
    expect(captured.status).toBe("pending");
    expect(captured.pending).toBe("github, vault:research:read");
  });

  test("getNote returns null on 404", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    const client = new DefVaultClient(binding);
    expect(await client.getNote("gone")).toBeNull();
  });

  test("createNote POSTs body + the def tag + metadata, returns the created note", async () => {
    let captured: { url: string; method: string; body: Record<string, unknown> } | null = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ id: "Agents/newbot", content: "P", metadata: { name: "newbot" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = new DefVaultClient(binding);
    const created = await client.createNote({
      content: "P",
      metadata: { name: "newbot", backend: "programmatic" },
      path: "Agents/newbot",
    });
    expect(created.id).toBe("Agents/newbot");
    expect(captured!.method).toBe("POST");
    expect(captured!.url).toContain("/vault/default/api/notes");
    expect(captured!.body.tags).toEqual(["#agent/definition"]);
    expect(captured!.body.content).toBe("P");
    expect((captured!.body.metadata as Record<string, string>).name).toBe("newbot");
    expect(captured!.body.path).toBe("Agents/newbot");
  });

  test("createNote throws on a non-ok vault response", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const client = new DefVaultClient(binding);
    await expect(
      client.createNote({ content: "x", metadata: { name: "x" } }),
    ).rejects.toThrow(/create def failed \(500\)/);
  });

  test("patchNote sends content/metadata with force:true (the 428 guard)", async () => {
    let body: Record<string, unknown> = {};
    let method = "";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      method = init?.method ?? "GET";
      body = JSON.parse(String(init?.body));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const client = new DefVaultClient(binding);
    await client.patchNote("Agents/newbot", { content: "new", metadata: { wants: "vault:r:read" } });
    expect(method).toBe("PATCH");
    expect(body.content).toBe("new");
    expect((body.metadata as Record<string, string>).wants).toBe("vault:r:read");
    expect(body.force).toBe(true); // satisfies the vault's mutation precondition.
  });

  test("deleteNote DELETEs the note; a 404 is OK (gone is gone)", async () => {
    let method = "";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      method = init?.method ?? "GET";
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const client = new DefVaultClient(binding);
    await client.deleteNote("Agents/gone"); // must NOT throw on 404.
    expect(method).toBe("DELETE");
  });

  test("deleteNote throws on a non-404 error", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const client = new DefVaultClient(binding);
    await expect(client.deleteNote("n")).rejects.toThrow(/delete def n failed \(500\)/);
  });
});

// ---------------------------------------------------------------------------
// AgentDefRegistry — reactive lifecycle (instantiate / reload / deregister)
// ---------------------------------------------------------------------------

/** A recorder for the injected instantiate side-effects. */
function recorderDeps() {
  const calls = {
    ensured: [] as string[],
    registered: [] as AgentSpec[],
    deregistered: [] as string[],
    removed: [] as string[],
  };
  const deps: InstantiateDeps = {
    ensureChannel: async (name) => {
      calls.ensured.push(name);
    },
    setupAndRegister: async (spec) => {
      calls.registered.push(spec);
    },
    deregister: async (name) => {
      calls.deregistered.push(name);
      return true;
    },
    removeChannel: async (name) => {
      calls.removed.push(name);
      return true;
    },
  };
  return { deps, calls };
}

/** A fetch that serves a def list + records PATCHes, keyed by query. */
function vaultFetch(opts: {
  defs?: Array<{ id: string; content?: string; metadata?: Record<string, unknown> }>;
  byId?: Record<string, { id: string; content?: string; metadata?: Record<string, unknown> } | null>;
  patches?: Array<{ id: string; status?: string; pending?: string }>;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (method === "PATCH") {
      const id = decodeURIComponent(u.split("/api/notes/")[1]!);
      const meta = JSON.parse(String(init?.body)).metadata as Record<string, string>;
      opts.patches?.push({ id, status: meta.status, pending: meta.pending });
      return new Response(null, { status: 200 });
    }
    if (u.includes("/api/notes?") && u.includes("tag=%23agent%2Fdefinition")) {
      return new Response(JSON.stringify(opts.defs ?? []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // GET one note by id (reload path).
    const m = u.match(/\/api\/notes\/([^?]+)/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const note = opts.byId?.[id] ?? null;
      if (!note) return new Response("no", { status: 404 });
      return new Response(JSON.stringify(note), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
}

describe("AgentDefRegistry — lifecycle", () => {
  test("loadAll instantiates each def: ensureChannel + setupAndRegister + status stamp", async () => {
    const { deps, calls } = recorderDeps();
    const patches: Array<{ id: string; status?: string; pending?: string }> = [];
    const fetchFn = vaultFetch({
      defs: [
        { id: "Agents/uni-dev", content: "role A", metadata: { name: "uni-dev" } },
        { id: "Agents/researcher", content: "role B", metadata: { name: "researcher", uses: "github" } },
      ],
      patches,
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    const n = await reg.loadAll();
    expect(n).toBe(2);
    expect(calls.ensured).toEqual(["uni-dev", "researcher"]);
    expect(calls.registered.map((s) => s.name)).toEqual(["uni-dev", "researcher"]);
    // Both agents bind their own vault, write-scoped (own-vault, 4a).
    expect(calls.registered[0]!.vault).toEqual({ name: "default", access: "write" });
    expect(calls.registered[0]!.backend).toBe("programmatic");
    // Status stamped: uni-dev enabled (no connections), researcher pending (declares github).
    const uni = patches.find((p) => p.id === "Agents/uni-dev")!;
    const res = patches.find((p) => p.id === "Agents/researcher")!;
    expect(uni.status).toBe("enabled");
    expect(uni.pending).toBe("");
    expect(res.status).toBe("pending");
    expect(res.pending).toBe("github");
    // The live set reflects both.
    expect(reg.list().map((d) => d.name).sort()).toEqual(["researcher", "uni-dev"]);
  });

  test("a malformed def is skipped (status error) and does NOT abort the others", async () => {
    const { deps, calls } = recorderDeps();
    const patches: Array<{ id: string; status?: string; pending?: string }> = [];
    const fetchFn = vaultFetch({
      defs: [
        { id: "bad", content: "x", metadata: {} }, // no name → parse error
        { id: "Agents/ok", content: "role", metadata: { name: "ok" } },
      ],
      patches,
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    const n = await reg.loadAll();
    expect(n).toBe(1); // only the good one
    expect(calls.registered.map((s) => s.name)).toEqual(["ok"]);
    expect(patches.find((p) => p.id === "bad")!.status).toBe("error");
  });

  test("an instantiate failure stamps error and does not record a live def", async () => {
    const { deps } = recorderDeps();
    // Make registration fail (e.g. missing Claude credential at setup).
    deps.setupAndRegister = async () => {
      throw new Error("CredentialNotConfigured: set the Claude credential");
    };
    const patches: Array<{ id: string; status?: string }> = [];
    const fetchFn = vaultFetch({
      defs: [{ id: "Agents/x", content: "role", metadata: { name: "x" } }],
      patches,
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    const n = await reg.loadAll();
    expect(n).toBe(0);
    expect(reg.list()).toHaveLength(0);
    expect(patches.find((p) => p.id === "Agents/x")!.status).toBe("error");
  });

  test("reload(updated) re-instantiates the changed def (idempotent replace)", async () => {
    const { deps, calls } = recorderDeps();
    const fetchFn = vaultFetch({
      byId: { "Agents/uni-dev": { id: "Agents/uni-dev", content: "NEW role", metadata: { name: "uni-dev" } } },
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    const result = await reg.reload("default", "Agents/uni-dev", "updated");
    expect(result).toBe("instantiated");
    expect(calls.registered).toHaveLength(1);
    expect(calls.registered[0]!.systemPrompt).toBe("NEW role");
    expect(reg.list().map((d) => d.name)).toEqual(["uni-dev"]);
  });

  test("reload(deleted) deregisters + removes the channel without a fetch", async () => {
    const { deps, calls } = recorderDeps();
    // Seed a live def first via loadAll, then delete it.
    const fetchFn = vaultFetch({
      defs: [{ id: "Agents/uni-dev", content: "role", metadata: { name: "uni-dev" } }],
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    await reg.loadAll();
    expect(reg.list()).toHaveLength(1);

    const result = await reg.reload("default", "Agents/uni-dev", "deleted");
    expect(result).toBe("deregistered");
    expect(calls.deregistered).toEqual(["uni-dev"]);
    expect(calls.removed).toEqual(["uni-dev"]);
    expect(reg.list()).toHaveLength(0);
  });

  test("reload of a note that re-reads as gone (no event) deregisters", async () => {
    const { deps, calls } = recorderDeps();
    const fetchFn = vaultFetch({
      defs: [{ id: "Agents/uni-dev", content: "role", metadata: { name: "uni-dev" } }],
      byId: { "Agents/uni-dev": null }, // a later GET says it's gone
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    await reg.loadAll();
    const result = await reg.reload("default", "Agents/uni-dev"); // no event → fetch → 404
    expect(result).toBe("deregistered");
    expect(calls.deregistered).toEqual(["uni-dev"]);
  });

  test("loadAll TEARS DOWN a removed def — deregister + removeChannel (the no-delete-trigger path)", async () => {
    // There is no vault `deleted` trigger (the hub maps only created/updated), so a def
    // deleted out-of-band never fires the reactive teardown — the poll is the ONLY
    // convergence path and must deregister, not just prune grants. Regression for the
    // orphan-agent bug (a deleted agent kept answering until the daemon restarted).
    const { deps, calls } = recorderDeps();
    const present: Array<{ id: string; content?: string; metadata?: Record<string, unknown> }> = [
      { id: "Agents/uni", content: "role", metadata: { name: "uni" } },
      { id: "Agents/researcher", content: "role", metadata: { name: "researcher" } },
    ];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "PATCH") return new Response(null, { status: 200 });
      if (u.includes("/api/notes?") && u.includes("tag=%23agent%2Fdefinition")) {
        return new Response(JSON.stringify(present), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    await reg.loadAll(); // both live
    expect(calls.deregistered).toEqual([]); // nothing torn down on a clean load
    present.splice(1, 1); // delete researcher out-of-band (no delete trigger fires)
    await reg.loadAll(); // confident read now sees only uni → researcher is a confirmed removal
    expect(calls.deregistered).toEqual(["researcher"]);
    expect(calls.removed).toEqual(["researcher"]);
    expect(reg.list().map((d) => d.name)).toEqual(["uni"]); // gone from the live set
  });

  test("loadAll SKIPS removed-def teardown on a truncated (page-cap) read — no spurious deregister", async () => {
    // A list at the page cap may be partial. Since the removed-def diff now does a
    // DESTRUCTIVE teardown, a truncated read that omits the tail must NOT be mistaken for
    // deletions — the guard defers the diff rather than tearing down live agents.
    const { deps, calls } = recorderDeps();
    const initial: Array<{ id: string; content?: string; metadata?: Record<string, unknown> }> = [
      { id: "Agents/uni", content: "role", metadata: { name: "uni" } },
      { id: "Agents/researcher", content: "role", metadata: { name: "researcher" } },
    ];
    // A full page (>= the 500 cap) that omits both originals — a truncated page, NOT a
    // signal that both were deleted.
    const truncated = Array.from({ length: 500 }, (_, i) => ({
      id: `Agents/filler-${i}`,
      content: "role",
      metadata: { name: `filler-${i}` },
    }));
    let current = initial;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "PATCH") return new Response(null, { status: 200 });
      if (u.includes("/api/notes?") && u.includes("tag=%23agent%2Fdefinition")) {
        return new Response(JSON.stringify(current), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    await reg.loadAll(); // confident: uni + researcher live
    expect(calls.deregistered).toEqual([]);
    current = truncated; // the next poll returns a truncated page
    await reg.loadAll();
    // Guard tripped → NO teardown despite the originals being absent from the page.
    expect(calls.deregistered).toEqual([]);
    expect(calls.removed).toEqual([]);

    // The guard DEFERS the decision, it doesn't LOSE it: the truncated pass left the
    // seen-set intact (it skipped rebuildSeenDefs), so a later CONFIDENT pass that
    // genuinely drops researcher still catches it as a removal and tears it down.
    current = [{ id: "Agents/uni", content: "role", metadata: { name: "uni" } }];
    calls.deregistered.length = 0;
    calls.removed.length = 0;
    await reg.loadAll();
    expect(calls.deregistered).toContain("researcher");
    expect(calls.removed).toContain("researcher");
  });

  test("reload for an unknown def-vault is a safe skip", async () => {
    const { deps } = recorderDeps();
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn: vaultFetch({}) });
    expect(await reg.reload("ghost-vault", "n")).toBe("skipped");
  });

  test("a def-vault list failure does not sink the others (best-effort per vault)", async () => {
    const { deps, calls } = recorderDeps();
    const b2: DefVaultBinding = { vault: "research", vaultUrl: "http://127.0.0.1:1940", token: "t2" };
    // vault `default` 500s its list; `research` serves one def.
    const fetchFn = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/vault/default/")) return new Response("boom", { status: 500 });
      if (u.includes("/vault/research/") && u.includes("tag=%23agent%2Fdefinition")) {
        return new Response(JSON.stringify([{ id: "r1", content: "role", metadata: { name: "r" } }]), {
          status: 200,
        });
      }
      return new Response(null, { status: 200 }); // PATCHes etc.
    }) as typeof fetch;
    const reg = new AgentDefRegistry(deps, { bindings: [binding, b2], fetchFn });
    const n = await reg.loadAll();
    expect(n).toBe(1);
    expect(calls.registered.map((s) => s.name)).toEqual(["r"]);
  });

  test("findLiveByNote returns the single match (vault + detail)", async () => {
    const { deps } = recorderDeps();
    const fetchFn = vaultFetch({
      defs: [{ id: "Agents/uni-dev", content: "role", metadata: { name: "uni-dev" } }],
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    await reg.loadAll();
    const found = reg.findLiveByNote("Agents/uni-dev");
    expect(found).not.toBeNull();
    expect(found!.vault).toBe("default");
    expect(found!.detail.name).toBe("uni-dev");
    expect(reg.findLiveByNote("Agents/ghost")).toBeNull();
  });

  test("findLiveByNote throws 409 when the SAME noteId is live in two def-vaults (#106 ambiguity)", async () => {
    const { deps } = recorderDeps();
    const b2: DefVaultBinding = { vault: "research", vaultUrl: "http://127.0.0.1:1940", token: "t2" };
    // The vaultFetch helper serves the same def list for ANY vault → both `default` and
    // `research` vend a def at the SAME note path, so two live entries share the noteId.
    const fetchFn = vaultFetch({
      defs: [{ id: "Agents/shared", content: "role", metadata: { name: "shared" } }],
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding, b2], fetchFn });
    await reg.loadAll();
    // The note id is live in BOTH vaults — picking one is non-deterministic, so it throws
    // a 409-class AgentDefWriteError rather than silently mutating an arbitrary one.
    let caught: unknown;
    try {
      reg.findLiveByNote("Agents/shared");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentDefWriteError);
    expect((caught as AgentDefWriteError).status).toBe(409);
    expect((caught as AgentDefWriteError).message).toContain("ambiguous");
    // The PATCH/DELETE write paths surface the same 409 (they resolve via findLiveByNote).
    await expect(reg.editDef("Agents/shared", { systemPrompt: "x" })).rejects.toMatchObject({ status: 409 });
    await expect(reg.deleteDef("Agents/shared")).rejects.toMatchObject({ status: 409 });
  });

  test("listDetailed carries the def mode (default single-threaded; multi-threaded when declared)", async () => {
    const { deps } = recorderDeps();
    const fetchFn = vaultFetch({
      defs: [
        { id: "Agents/uni-dev", content: "role", metadata: { name: "uni-dev" } }, // no mode → default
        { id: "Agents/digest", content: "role", metadata: { name: "digest", mode: "multi-threaded" } },
      ],
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    await reg.loadAll();
    const byName = new Map(reg.listDetailed().map((d) => [d.name, d]));
    expect(byName.get("uni-dev")!.mode).toBe("single-threaded");
    expect(byName.get("digest")!.mode).toBe("multi-threaded");
  });

  test("getFullDef returns the FULL system prompt + mode/backend/wants (not the preview)", async () => {
    const { deps } = recorderDeps();
    const longPrompt = "P".repeat(500); // longer than the 200-char preview cap.
    const fetchFn = vaultFetch({
      defs: [
        {
          id: "Agents/uni-dev",
          content: longPrompt,
          metadata: { name: "uni-dev", backend: "channel", mode: "multi-threaded", wants: "vault:research:read" },
        },
      ],
      byId: {
        "Agents/uni-dev": {
          id: "Agents/uni-dev",
          content: longPrompt,
          metadata: { name: "uni-dev", backend: "channel", mode: "multi-threaded", wants: "vault:research:read" },
        },
      },
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    await reg.loadAll();
    const full = await reg.getFullDef("Agents/uni-dev");
    expect(full).not.toBeNull();
    expect(full!.noteId).toBe("Agents/uni-dev");
    expect(full!.name).toBe("uni-dev");
    expect(full!.backend).toBe("channel");
    expect(full!.mode).toBe("multi-threaded");
    expect(full!.vault).toBe("default");
    expect(full!.wants).toEqual(["vault:research:read"]);
    // The FULL body, NOT the truncated preview.
    expect(full!.systemPrompt).toBe(longPrompt);
    expect(full!.systemPrompt.length).toBe(500);
  });

  test("getFullDef returns null for a note that isn't a live def", async () => {
    const { deps } = recorderDeps();
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn: vaultFetch({}) });
    expect(await reg.getFullDef("Agents/ghost")).toBeNull();
  });

  test("soleVaultName resolves the single binding (the reload-webhook default)", () => {
    const { deps } = recorderDeps();
    const reg = new AgentDefRegistry(deps, { bindings: [binding] });
    expect(reg.soleVaultName()).toBe("default");
    expect(reg.vaultCount).toBe(1);
    reg.addVault({ vault: "research", token: "t" });
    expect(reg.soleVaultName()).toBeUndefined();
    expect(reg.vaultCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AgentDefRegistry — 4b grant registration + status (design 2026-06-17-agent-connectors-4b)
// ---------------------------------------------------------------------------

/** A fake GrantsClient that records PUTs + reconcile POSTs and returns a configurable
 *  per-connection status. The hub isn't deployed in the test env — this mocks its
 *  grants API (register PUT + reconcile POST, #96 grant-GC). */
function fakeGrantsClient(opts: {
  /** connectionKey → the status the hub returns on register. Default "pending". */
  statusByKey?: Record<string, string>;
  /** Record each registered (agent, connection). */
  registered?: Array<{ agent: string; connection: ConnectionSpec }>;
  /** Record each reconcile (agent, liveConnections) — the #96 grant-GC call. */
  reconciled?: Array<{ agent: string; liveConnections: ConnectionSpec[] }>;
  /** How many grants the hub reports pruned per reconcile (default 0). */
  prunedPerReconcile?: number;
  /** Make reconcile POSTs 500 (to assert the failure is swallowed). */
  reconcileFails?: boolean;
}): GrantsClient {
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/admin/grants/reconcile") && (init?.method ?? "GET") === "POST") {
      const body = JSON.parse(String(init?.body)) as { agent: string; liveConnections: ConnectionSpec[] };
      opts.reconciled?.push({ agent: body.agent, liveConnections: body.liveConnections });
      if (opts.reconcileFails) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ pruned: opts.prunedPerReconcile ?? 0, prunedIds: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/admin/grants") && (init?.method ?? "GET") === "PUT") {
      const body = JSON.parse(String(init?.body)) as { agent: string; connection: ConnectionSpec };
      opts.registered?.push({ agent: body.agent, connection: body.connection });
      const key = connectionKey(body.connection);
      const status = opts.statusByKey?.[key] ?? "pending";
      return new Response(
        JSON.stringify({ id: `g-${key}`, agent: body.agent, connection: body.connection, status }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return new GrantsClient({ hubOrigin: "https://hub.example.com", managerBearer: "MGR", fetchFn });
}

describe("AgentDefRegistry — grant registration + status (4b)", () => {
  test("registers each `wants:` connection as a pending grant on instantiate", async () => {
    const { deps } = recorderDeps();
    const registered: Array<{ agent: string; connection: ConnectionSpec }> = [];
    const grants = fakeGrantsClient({ registered }); // all default "pending"
    const patches: Array<{ id: string; status?: string; pending?: string }> = [];
    const fetchFn = vaultFetch({
      defs: [
        {
          id: "Agents/researcher",
          content: "role",
          metadata: { name: "researcher", wants: "vault:research:read, env:github" },
        },
      ],
      patches,
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    await reg.loadAll();

    // Both connections were registered for the agent.
    expect(registered.map((r) => r.connection.target).sort()).toEqual(["github", "research"]);
    expect(registered.every((r) => r.agent === "researcher")).toBe(true);
    // None approved → status pending listing the connection keys.
    const p = patches.find((x) => x.id === "Agents/researcher")!;
    expect(p.status).toBe("pending");
    expect(p.pending).toContain("vault:research:read");
    expect(p.pending).toContain("env:github");
  });

  test("status = enabled only once EVERY connection is approved", async () => {
    const { deps } = recorderDeps();
    const vaultConn: ConnectionSpec = { kind: "vault", target: "research", access: "read" };
    const svcConn: ConnectionSpec = { kind: "service", target: "github", inject: ["env"] };
    const grants = fakeGrantsClient({
      statusByKey: {
        [connectionKey(vaultConn)]: "approved",
        [connectionKey(svcConn)]: "approved",
      },
    });
    const patches: Array<{ id: string; status?: string; pending?: string }> = [];
    const fetchFn = vaultFetch({
      defs: [
        { id: "Agents/r", content: "role", metadata: { name: "r", wants: "vault:research:read, env:github" } },
      ],
      patches,
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    await reg.loadAll();
    const p = patches.find((x) => x.id === "Agents/r")!;
    expect(p.status).toBe("enabled");
    expect(p.pending).toBe("");
    expect(reg.list().find((d) => d.name === "r")!.status).toBe("enabled");
  });

  test("partial approval → pending listing only the UNAPPROVED connection keys", async () => {
    const { deps } = recorderDeps();
    const vaultConn: ConnectionSpec = { kind: "vault", target: "research", access: "read" };
    const grants = fakeGrantsClient({
      statusByKey: { [connectionKey(vaultConn)]: "approved" }, // github stays pending
    });
    const patches: Array<{ id: string; status?: string; pending?: string }> = [];
    const fetchFn = vaultFetch({
      defs: [
        { id: "Agents/r", content: "role", metadata: { name: "r", wants: "vault:research:read, env:github" } },
      ],
      patches,
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    await reg.loadAll();
    const p = patches.find((x) => x.id === "Agents/r")!;
    expect(p.status).toBe("pending");
    expect(p.pending).toBe("env:github"); // only the unapproved one
    // The agent STILL instantiated (own-vault runs regardless of grant approval).
    expect(reg.list().find((d) => d.name === "r")).toBeDefined();
  });

  test("an mcp-kind want registers + stays pending (parsed, not granted in 4b-1)", async () => {
    const { deps } = recorderDeps();
    const registered: Array<{ agent: string; connection: ConnectionSpec }> = [];
    const grants = fakeGrantsClient({ registered }); // mcp stays "pending"
    const patches: Array<{ id: string; status?: string; pending?: string }> = [];
    const fetchFn = vaultFetch({
      defs: [
        { id: "Agents/r", content: "role", metadata: { name: "r", wants: "mcp:https://remote/mcp" } },
      ],
      patches,
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    await reg.loadAll();
    expect(registered).toHaveLength(1);
    expect(registered[0]!.connection).toEqual({ kind: "mcp", target: "https://remote/mcp" });
    const p = patches.find((x) => x.id === "Agents/r")!;
    expect(p.status).toBe("pending");
    expect(p.pending).toBe("mcp:https://remote/mcp");
  });

  test("a malformed `wants:` stamps status error (does not register or instantiate)", async () => {
    const { deps, calls } = recorderDeps();
    const registered: Array<{ agent: string; connection: ConnectionSpec }> = [];
    const grants = fakeGrantsClient({ registered });
    const patches: Array<{ id: string; status?: string }> = [];
    const fetchFn = vaultFetch({
      defs: [{ id: "Agents/bad", content: "role", metadata: { name: "bad", wants: "vault:research" } }],
      patches,
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    const n = await reg.loadAll();
    expect(n).toBe(0);
    expect(calls.registered).toHaveLength(0); // never instantiated
    expect(registered).toHaveLength(0); // never registered a grant
    expect(patches.find((p) => p.id === "Agents/bad")!.status).toBe("error");
  });

  test("a grant-registration FAILURE is non-fatal → connection counts as pending", async () => {
    const { deps, calls } = recorderDeps();
    // A grants client whose PUT 500s.
    const fetchFn500 = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/admin/grants") && init?.method === "PUT") {
        return new Response("boom", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const grants = new GrantsClient({ hubOrigin: "https://hub.example.com", managerBearer: "MGR", fetchFn: fetchFn500 });
    const patches: Array<{ id: string; status?: string; pending?: string }> = [];
    const fetchFn = vaultFetch({
      defs: [{ id: "Agents/r", content: "role", metadata: { name: "r", wants: "vault:research:read" } }],
      patches,
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    const count = await reg.loadAll();
    // The agent STILL instantiated (own-vault) — a hub blip never blocks it.
    expect(count).toBe(1);
    expect(calls.registered.map((s) => s.name)).toEqual(["r"]);
    const p = patches.find((x) => x.id === "Agents/r")!;
    expect(p.status).toBe("pending");
    expect(p.pending).toBe("vault:research:read");
  });

  test("setGrantsClient(null) → falls back to the pure status (no registration)", async () => {
    const { deps } = recorderDeps();
    const patches: Array<{ id: string; status?: string; pending?: string }> = [];
    const fetchFn = vaultFetch({
      defs: [{ id: "Agents/r", content: "role", metadata: { name: "r", wants: "vault:research:read" } }],
      patches,
    });
    // No grants client at all → resolveDefStatus fallback (pending listing conn keys).
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    reg.setGrantsClient(null);
    await reg.loadAll();
    const p = patches.find((x) => x.id === "Agents/r")!;
    expect(p.status).toBe("pending");
    expect(p.pending).toBe("vault:research:read");
  });
});

// ---------------------------------------------------------------------------
// AgentDefRegistry — grant garbage-collection / reconcile (#96)
// ---------------------------------------------------------------------------

describe("AgentDefRegistry — grant-GC reconcile (#96)", () => {
  test("a successful load reconciles with the def's CURRENT live connection specs", async () => {
    const { deps } = recorderDeps();
    const reconciled: Array<{ agent: string; liveConnections: ConnectionSpec[] }> = [];
    const grants = fakeGrantsClient({ reconciled });
    const fetchFn = vaultFetch({
      defs: [
        {
          id: "Agents/researcher",
          content: "role",
          metadata: { name: "researcher", wants: "vault:research:read, env:github, mcp:github" },
        },
      ],
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    await reg.loadAll();

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]!.agent).toBe("researcher");
    // The SPECS sent MUST equal the parsed wants (env:github + mcp:github MERGE to one
    // service connection with inject ["env","mcp"]). The hub re-derives the keys.
    const wants: ConnectionSpec[] = [
      { kind: "vault", target: "research", access: "read" },
      { kind: "service", target: "github", inject: ["env", "mcp"] },
    ];
    expect(reconciled[0]!.liveConnections).toEqual(wants);
  });

  test("a def with NO wants still reconciles with empty liveConnections (prunes any leftover)", async () => {
    const { deps } = recorderDeps();
    const reconciled: Array<{ agent: string; liveConnections: ConnectionSpec[] }> = [];
    const grants = fakeGrantsClient({ reconciled });
    const fetchFn = vaultFetch({
      defs: [{ id: "Agents/uni", content: "role", metadata: { name: "uni" } }],
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    await reg.loadAll();
    expect(reconciled).toEqual([{ agent: "uni", liveConnections: [] }]);
  });

  test("a REMOVED def (present in a prior load, gone now) → reconcile(agent, []) + teardown", async () => {
    const { deps, calls } = recorderDeps();
    const reconciled: Array<{ agent: string; liveConnections: ConnectionSpec[] }> = [];
    const grants = fakeGrantsClient({ reconciled });
    // Two notes present at first; the second load drops "researcher".
    const present: Array<{ id: string; content?: string; metadata?: Record<string, unknown> }> = [
      { id: "Agents/uni", content: "role", metadata: { name: "uni" } },
      { id: "Agents/researcher", content: "role", metadata: { name: "researcher", wants: "vault:research:read" } },
    ];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "PATCH") return new Response(null, { status: 200 });
      if (u.endsWith("/admin/grants/reconcile") || u.endsWith("/admin/grants")) {
        // delegate to the fake grants client's fetch by re-issuing through it isn't
        // possible here; instead record reconcile directly.
        if (u.endsWith("/admin/grants/reconcile") && method === "POST") {
          const body = JSON.parse(String(init?.body)) as { agent: string; liveConnections: ConnectionSpec[] };
          reconciled.push({ agent: body.agent, liveConnections: body.liveConnections });
          return new Response(JSON.stringify({ pruned: 0, prunedIds: [] }), { status: 200 });
        }
        if (method === "PUT") {
          const body = JSON.parse(String(init?.body)) as { agent: string; connection: ConnectionSpec };
          return new Response(
            JSON.stringify({ id: "g", agent: body.agent, connection: body.connection, status: "pending" }),
            { status: 200 },
          );
        }
      }
      if (u.includes("/api/notes?") && u.includes("tag=%23agent%2Fdefinition")) {
        return new Response(JSON.stringify(present), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    await reg.loadAll(); // first confident read — both present
    // Drop researcher; second confident read sees only uni.
    present.splice(1, 1);
    reconciled.length = 0; // ignore the first-load reconciles; focus on the removal
    await reg.loadAll();

    // The removed agent gets a prune-ALL reconcile.
    const removal = reconciled.find((r) => r.agent === "researcher");
    expect(removal).toEqual({ agent: "researcher", liveConnections: [] });
    // uni (still present, no wants) reconciles with [] too — that's its clean-load prune,
    // NOT a removal; distinguished by the agent name.
    expect(reconciled.find((r) => r.agent === "uni")).toEqual({ agent: "uni", liveConnections: [] });
    // AND it's torn down (not just grant-pruned): the only auto path for a delete.
    expect(calls.deregistered).toEqual(["researcher"]);
    expect(calls.removed).toEqual(["researcher"]);
  });

  test("a delete reload → reconcile(agent, []) (confirmed removal)", async () => {
    const { deps } = recorderDeps();
    const reconciled: Array<{ agent: string; liveConnections: ConnectionSpec[] }> = [];
    const grants = fakeGrantsClient({ reconciled });
    const fetchFn = vaultFetch({
      defs: [{ id: "Agents/uni", content: "role", metadata: { name: "uni" } }],
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    await reg.loadAll();
    reconciled.length = 0; // drop the clean-load reconcile; focus on the delete
    const result = await reg.reload("default", "Agents/uni", "deleted");
    expect(result).toBe("deregistered");
    expect(reconciled).toEqual([{ agent: "uni", liveConnections: [] }]);
  });

  test("a reload that re-reads as GONE (404) → reconcile(agent, []) (confirmed removal)", async () => {
    const { deps } = recorderDeps();
    const reconciled: Array<{ agent: string; liveConnections: ConnectionSpec[] }> = [];
    const grants = fakeGrantsClient({ reconciled });
    const fetchFn = vaultFetch({
      defs: [{ id: "Agents/uni", content: "role", metadata: { name: "uni" } }],
      byId: { "Agents/uni": null }, // a later GET says it's gone
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    await reg.loadAll();
    reconciled.length = 0;
    const result = await reg.reload("default", "Agents/uni"); // no event → GET → 404
    expect(result).toBe("deregistered");
    expect(reconciled).toEqual([{ agent: "uni", liveConnections: [] }]);
  });

  test("SAFETY: a PARSE-FAILING def NEVER reconciles (no prune from an error)", async () => {
    const { deps } = recorderDeps();
    const reconciled: Array<{ agent: string; liveConnections: ConnectionSpec[] }> = [];
    const grants = fakeGrantsClient({ reconciled });
    const fetchFn = vaultFetch({
      defs: [
        { id: "Agents/bad", content: "role", metadata: { name: "bad", wants: "vault:research" } }, // malformed wants
        { id: "Agents/noname", content: "role", metadata: {} }, // no name → parse error
      ],
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    const n = await reg.loadAll();
    expect(n).toBe(0); // nothing instantiated
    // NEITHER parse-failing def reconciled — a transient parse error must not nuke grants.
    expect(reconciled).toEqual([]);
  });

  test("SAFETY: a parse-failing def is NOT later flagged removed (its grants survive)", async () => {
    const { deps } = recorderDeps();
    const reconciled: Array<{ agent: string; liveConnections: ConnectionSpec[] }> = [];
    const grants = fakeGrantsClient({ reconciled });
    // First load: a CLEAN def. Second load: the SAME note now parse-fails (a transient
    // bad edit). It must NOT be treated as a removal (it's still present in the vault).
    const note: { id: string; content?: string; metadata?: Record<string, unknown> } = {
      id: "Agents/uni",
      content: "role",
      metadata: { name: "uni" },
    };
    const present = [note];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "PATCH") return new Response(null, { status: 200 });
      if (u.endsWith("/admin/grants/reconcile") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { agent: string; liveConnections: ConnectionSpec[] };
        reconciled.push({ agent: body.agent, liveConnections: body.liveConnections });
        return new Response(JSON.stringify({ pruned: 0 }), { status: 200 });
      }
      if (u.includes("/api/notes?") && u.includes("tag=%23agent%2Fdefinition")) {
        return new Response(JSON.stringify(present), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    await reg.loadAll(); // clean → reconcile(uni, [])
    // Now make the same note malformed (remove its name) and reload all.
    note.metadata = { name: "uni", wants: "vault:research" }; // malformed wants → parse error
    reconciled.length = 0;
    await reg.loadAll();
    // The note is STILL present (just unparseable) → NOT a removal → no reconcile at all.
    expect(reconciled).toEqual([]);
  });

  test("SAFETY: a vault LIST failure does NOT prune (no confident read)", async () => {
    const { deps } = recorderDeps();
    const reconciled: Array<{ agent: string; liveConnections: ConnectionSpec[] }> = [];
    const grants = fakeGrantsClient({ reconciled });
    let listShouldFail = false;
    const present = [{ id: "Agents/uni", content: "role", metadata: { name: "uni" } }];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "PATCH") return new Response(null, { status: 200 });
      if (u.endsWith("/admin/grants/reconcile") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { agent: string; liveConnections: ConnectionSpec[] };
        reconciled.push({ agent: body.agent, liveConnections: body.liveConnections });
        return new Response(JSON.stringify({ pruned: 0 }), { status: 200 });
      }
      if (u.includes("/api/notes?") && u.includes("tag=%23agent%2Fdefinition")) {
        if (listShouldFail) return new Response("boom", { status: 500 });
        return new Response(JSON.stringify(present), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    await reg.loadAll(); // confident → seen set = {uni}
    reconciled.length = 0;
    listShouldFail = true;
    await reg.loadAll(); // list 500s → NOT a confident read → no removal diff, no prune
    expect(reconciled).toEqual([]);
  });

  test("a reconcile HTTP failure is swallowed — the load does NOT throw / still instantiates", async () => {
    const { deps, calls } = recorderDeps();
    const reconciled: Array<{ agent: string; liveConnections: ConnectionSpec[] }> = [];
    const grants = fakeGrantsClient({ reconciled, reconcileFails: true }); // reconcile POST 500s
    const patches: Array<{ id: string; status?: string }> = [];
    const fetchFn = vaultFetch({
      defs: [{ id: "Agents/uni", content: "role", metadata: { name: "uni" } }],
      patches,
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    // Must not throw out of loadAll despite the 500.
    const n = await reg.loadAll();
    expect(n).toBe(1);
    expect(calls.registered.map((s) => s.name)).toEqual(["uni"]); // still instantiated
    expect(reconciled).toEqual([{ agent: "uni", liveConnections: [] }]); // it was attempted
  });

  test("no grants client → reconcile is a no-op (the vault-native path still runs)", async () => {
    const { deps, calls } = recorderDeps();
    const fetchFn = vaultFetch({
      defs: [{ id: "Agents/uni", content: "role", metadata: { name: "uni", wants: "vault:research:read" } }],
    });
    // No grants client → no reconcile attempted; the agent still instantiates own-vault.
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    const n = await reg.loadAll();
    expect(n).toBe(1);
    expect(calls.registered.map((s) => s.name)).toEqual(["uni"]);
  });
});

// ---------------------------------------------------------------------------
// FIX 4 (delete ordering: vault-delete first, then deregister) + FIX 5 (grant-GC
// failure on delete is surfaced, not swallowed) — PR #3.
// ---------------------------------------------------------------------------

/**
 * A fetch that serves the def list + by-id GET (so an agent instantiates) and routes
 * a DELETE to a configurable outcome (`deleteStatus`). Records DELETEs so a test can
 * assert the note-delete was attempted. Reconcile/PATCH succeed by default.
 */
function vaultFetchWithDelete(opts: {
  defs: Array<{ id: string; content?: string; metadata?: Record<string, unknown> }>;
  deleteStatus?: number; // the status the DELETE returns (default 204 = success)
  deletes?: string[]; // record each DELETEd note id
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (method === "DELETE") {
      const id = decodeURIComponent(u.split("/api/notes/")[1]!);
      opts.deletes?.push(id);
      const status = opts.deleteStatus ?? 204;
      return new Response(status >= 400 ? "delete failed" : null, { status });
    }
    if (method === "PATCH") return new Response(null, { status: 200 });
    if (u.includes("/api/notes?") && u.includes("tag=%23agent%2Fdefinition")) {
      return new Response(JSON.stringify(opts.defs), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
}

describe("AgentDefRegistry — deleteDef ordering + grant-GC surfacing (FIX 4/5, PR #3)", () => {
  test("FIX 4: a vault-delete failure leaves the def REGISTERED (not orphaned)", async () => {
    const { deps, calls } = recorderDeps();
    const deletes: string[] = [];
    const fetchFn = vaultFetchWithDelete({
      defs: [{ id: "Agents/uni", content: "role", metadata: { name: "uni" } }],
      deleteStatus: 502, // the vault note delete 502s
      deletes,
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    await reg.loadAll();
    expect(reg.findLiveByNote("Agents/uni")).not.toBeNull(); // live before delete.

    // The delete throws (the vault note delete failed) BEFORE any deregister.
    await expect(reg.deleteDef("Agents/uni")).rejects.toThrow(/delete def Agents\/uni failed \(502\)/);

    // FIX 4 invariant: the agent is STILL registered (the in-memory def was NOT torn down
    // on a failed vault delete) — it re-converges on the next poll rather than orphaning.
    expect(reg.findLiveByNote("Agents/uni")).not.toBeNull();
    expect(calls.deregistered).toEqual([]); // nothing was deregistered.
    expect(deletes).toEqual(["Agents/uni"]); // the delete WAS attempted (and failed).
  });

  test("FIX 4: a successful vault-delete deregisters cleanly", async () => {
    const { deps, calls } = recorderDeps();
    const deletes: string[] = [];
    const fetchFn = vaultFetchWithDelete({
      defs: [{ id: "Agents/uni", content: "role", metadata: { name: "uni" } }],
      deleteStatus: 204,
      deletes,
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn });
    await reg.loadAll();

    const removed = await reg.deleteDef("Agents/uni");
    expect(removed.name).toBe("uni");
    expect(removed.grantsReconciled).toBe(true); // no grants client → nothing to reconcile = ok.
    // Now deregistered + removed from the live set.
    expect(reg.findLiveByNote("Agents/uni")).toBeNull();
    expect(calls.deregistered).toEqual(["uni"]);
    expect(deletes).toEqual(["Agents/uni"]);
  });

  test("FIX 5: a grant-reconcile failure on delete is SURFACED (grantsReconciled:false) — the note-delete still completes", async () => {
    const { deps, calls } = recorderDeps();
    const reconciled: Array<{ agent: string; liveConnections: ConnectionSpec[] }> = [];
    const grants = fakeGrantsClient({ reconciled, reconcileFails: true }); // reconcile POST 500s
    const deletes: string[] = [];
    const fetchFn = vaultFetchWithDelete({
      defs: [{ id: "Agents/uni", content: "role", metadata: { name: "uni" } }],
      deleteStatus: 204,
      deletes,
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    await reg.loadAll();
    reconciled.length = 0;

    // The delete must NOT throw (grant GC is best-effort) but MUST report the partial
    // success so the caller doesn't claim a clean full success (orphaned grants).
    const removed = await reg.deleteDef("Agents/uni");
    expect(removed.name).toBe("uni");
    expect(removed.grantsReconciled).toBe(false); // FIX 5: the failure is surfaced, not swallowed.
    // The note-delete + deregister STILL completed (the def IS gone).
    expect(reg.findLiveByNote("Agents/uni")).toBeNull();
    expect(calls.deregistered).toEqual(["uni"]);
    expect(deletes).toEqual(["Agents/uni"]);
    // The reconcile WAS attempted (prune-all on the removed agent) — it just failed on the hub.
    expect(reconciled).toEqual([{ agent: "uni", liveConnections: [] }]);
  });

  test("FIX 5: a SUCCESSFUL grant-reconcile on delete reports grantsReconciled:true", async () => {
    const { deps } = recorderDeps();
    const reconciled: Array<{ agent: string; liveConnections: ConnectionSpec[] }> = [];
    const grants = fakeGrantsClient({ reconciled }); // reconcile succeeds
    const fetchFn = vaultFetchWithDelete({
      defs: [{ id: "Agents/uni", content: "role", metadata: { name: "uni" } }],
      deleteStatus: 204,
    });
    const reg = new AgentDefRegistry(deps, { bindings: [binding], fetchFn, grants });
    await reg.loadAll();
    const removed = await reg.deleteDef("Agents/uni");
    expect(removed.grantsReconciled).toBe(true);
  });
});
