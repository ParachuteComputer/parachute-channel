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
  type DefVaultBinding,
  type InstantiateDeps,
} from "./agent-defs.ts";
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
