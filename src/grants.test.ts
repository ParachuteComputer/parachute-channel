/**
 * Unit tests for agent connectors — approval-gated grants (design
 * 2026-06-17-agent-connectors-4b.md, slice 4b-1).
 *
 * Deterministic — `fetch` is INJECTED into GrantsClient (no global mock, nothing to
 * restore); the parse + status + injection helpers are pure. Covered:
 *   - parseWants: every spec form (vault verb + tag-scope, env/mcp service merge,
 *     mcp:url), malformed → WantsParseError, array vs comma-string input;
 *   - connectionKey: stable across re-parse + tag ordering;
 *   - GrantsClient: register (PUT) / list (GET) / material (GET, 404+409→null) — the
 *     wire contract + the manager-bearer auth header;
 *   - resolveConnectionStatus: enabled iff all approved, else pending listing keys;
 *   - resolveInjectedGrants: vault→mcp-entry, service env, service mcp, mcp-material
 *     injection (4b-2: approved→mcp-entry keyed by grant id; unapproved→absent),
 *     fresh-fetch-each-call (not cached), per-material-fault isolation.
 */

import { describe, test, expect } from "bun:test";
import {
  parseWants,
  connectionKey,
  resolveConnectionStatus,
  resolveInjectedGrants,
  serviceEnvVar,
  serviceMcpUrl,
  grantVaultEntryKey,
  grantServiceEntryKey,
  grantMcpEntryKey,
  GrantsClient,
  GrantsApiError,
  WantsParseError,
  type ConnectionSpec,
  type GrantMaterial,
} from "./grants.ts";

// ---------------------------------------------------------------------------
// parseWants
// ---------------------------------------------------------------------------

describe("parseWants — spec forms", () => {
  test("vault:<name>:<verb>", () => {
    expect(parseWants("vault:research:read")).toEqual([
      { kind: "vault", target: "research", access: "read" },
    ]);
    expect(parseWants("vault:ops:write")).toEqual([
      { kind: "vault", target: "ops", access: "write" },
    ]);
  });

  test("vault with one or more #tag suffixes", () => {
    expect(parseWants("vault:research:read#published")).toEqual([
      { kind: "vault", target: "research", access: "read", tags: ["#published"] },
    ]);
    expect(parseWants("vault:research:read#published#wip")).toEqual([
      { kind: "vault", target: "research", access: "read", tags: ["#published", "#wip"] },
    ]);
  });

  test("env:<service> → service inject:[env]", () => {
    expect(parseWants("env:github")).toEqual([
      { kind: "service", target: "github", inject: ["env"] },
    ]);
  });

  test("mcp:<service> (non-url) → service inject:[mcp]", () => {
    expect(parseWants("mcp:github")).toEqual([
      { kind: "service", target: "github", inject: ["mcp"] },
    ]);
  });

  test("env:<svc> + mcp:<svc> for the same service MERGE → inject:[env,mcp]", () => {
    expect(parseWants("env:github, mcp:github")).toEqual([
      { kind: "service", target: "github", inject: ["env", "mcp"] },
    ]);
    // Order-independent: mcp first then env still merges to [env,mcp] (canonical order).
    expect(parseWants("mcp:github, env:github")).toEqual([
      { kind: "service", target: "github", inject: ["env", "mcp"] },
    ]);
  });

  test("mcp:<https-url> → kind mcp (parsed; deferred to 4b-2)", () => {
    expect(parseWants("mcp:https://remote.example.com/mcp")).toEqual([
      { kind: "mcp", target: "https://remote.example.com/mcp" },
    ]);
    expect(parseWants("mcp:http://localhost:9000/mcp")).toEqual([
      { kind: "mcp", target: "http://localhost:9000/mcp" },
    ]);
  });

  test("a mixed list keeps first-seen order; services merge in place", () => {
    const got = parseWants(
      "vault:research:read#pub, env:github, vault:ops:write, mcp:github, env:cloudflare",
    );
    expect(got).toEqual([
      { kind: "vault", target: "research", access: "read", tags: ["#pub"] },
      { kind: "service", target: "github", inject: ["env", "mcp"] }, // merged at first pos
      { kind: "vault", target: "ops", access: "write" },
      { kind: "service", target: "cloudflare", inject: ["env"] },
    ]);
  });

  test("accepts a real array (a vault that didn't stringify)", () => {
    expect(parseWants(["vault:a:read", "env:github"])).toEqual([
      { kind: "vault", target: "a", access: "read" },
      { kind: "service", target: "github", inject: ["env"] },
    ]);
  });

  test("empty / undefined / null → []", () => {
    expect(parseWants(undefined)).toEqual([]);
    expect(parseWants(null)).toEqual([]);
    expect(parseWants("")).toEqual([]);
    expect(parseWants("  ,  ")).toEqual([]);
    expect(parseWants([])).toEqual([]);
  });
});

describe("parseWants — malformed → WantsParseError", () => {
  test("no kind prefix (no colon)", () => {
    expect(() => parseWants("github")).toThrow(WantsParseError);
  });
  test("unknown kind", () => {
    expect(() => parseWants("smtp:server")).toThrow(/unknown kind/);
  });
  test("vault without a verb", () => {
    expect(() => parseWants("vault:research")).toThrow(/needs a verb/);
  });
  test("vault with a bad verb", () => {
    expect(() => parseWants("vault:research:admin")).toThrow(/read.*write/);
    expect(() => parseWants("vault:research:delete")).toThrow(WantsParseError);
  });
  test("vault with a non-slug name", () => {
    // The list is comma/space-separated, so a slug-breaking char is `.`/`@`/… not a space.
    expect(() => parseWants("vault:bad.name:read")).toThrow(/slug/);
  });
  test("service with a non-slug name", () => {
    expect(() => parseWants("env:bad.name")).toThrow(/slug/);
  });
  test("mcp with a non-http(s) url-looking target is treated as a service slug → bad slug", () => {
    // "ftp://x" doesn't match http(s) → treated as a service name → not a slug.
    expect(() => parseWants("mcp:ftp://x")).toThrow(/slug/);
  });
  test("a service whose env-var collides with the Claude-auth denylist is rejected at parse", () => {
    // `claude-code-oauth` → CLAUDE_CODE_OAUTH_TOKEN (denylisted). Caught at define-time.
    expect(() => parseWants("env:claude-code-oauth")).toThrow(/protected env var/);
  });
  test("one malformed entry in a list throws (no half-parse)", () => {
    expect(() => parseWants("vault:a:read, garbage")).toThrow(WantsParseError);
  });
});

// ---------------------------------------------------------------------------
// connectionKey — stable identity
// ---------------------------------------------------------------------------

describe("connectionKey", () => {
  test("stable across a re-parse of the same wants entry", () => {
    const a = parseWants("vault:research:read#a#b")[0]!;
    const b = parseWants("vault:research:read#a#b")[0]!;
    expect(connectionKey(a)).toBe(connectionKey(b));
  });
  test("tag order does not change the key", () => {
    const ab = parseWants("vault:r:read#a#b")[0]!;
    const ba = parseWants("vault:r:read#b#a")[0]!;
    expect(connectionKey(ab)).toBe(connectionKey(ba));
  });
  test("service key reflects merged inject; vault key reflects verb", () => {
    expect(connectionKey({ kind: "service", target: "github", inject: ["env", "mcp"] })).toBe(
      "env+mcp:github",
    );
    expect(connectionKey({ kind: "vault", target: "ops", access: "write" })).toBe("vault:ops:write");
    expect(connectionKey({ kind: "mcp", target: "https://x/mcp" })).toBe("mcp:https://x/mcp");
  });
});

// ---------------------------------------------------------------------------
// GrantsClient — the wire contract
// ---------------------------------------------------------------------------

const HUB = "https://hub.example.com";
const BEARER = "MANAGER-OPERATOR-TOKEN";

function clientWith(fetchFn: typeof fetch): GrantsClient {
  return new GrantsClient({ hubOrigin: HUB, managerBearer: BEARER, fetchFn });
}

describe("GrantsClient.registerGrant (PUT /admin/grants)", () => {
  test("PUTs { agent, connection } with the manager bearer; returns the record", async () => {
    let captured: { url: string; method?: string; auth?: string; body?: unknown } = { url: "" };
    const conn: ConnectionSpec = { kind: "vault", target: "research", access: "read" };
    const client = clientWith((async (url: string | URL | Request, init?: RequestInit) => {
      captured = {
        url: String(url),
        method: init?.method,
        auth: (init?.headers as Record<string, string>)?.authorization,
        body: JSON.parse(String(init?.body)),
      };
      return new Response(
        JSON.stringify({ id: "g1", agent: "researcher", connection: conn, status: "pending" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);

    const rec = await client.registerGrant("researcher", conn);
    expect(captured.url).toBe(`${HUB}/admin/grants`);
    expect(captured.method).toBe("PUT");
    expect(captured.auth).toBe(`Bearer ${BEARER}`);
    expect(captured.body).toEqual({ agent: "researcher", connection: conn });
    expect(rec).toEqual({ id: "g1", agent: "researcher", connection: conn, status: "pending" });
  });

  test("throws GrantsApiError carrying the status on a non-ok response", async () => {
    const client = clientWith((async () => new Response("nope", { status: 403 })) as unknown as typeof fetch);
    await expect(
      client.registerGrant("a", { kind: "vault", target: "v", access: "read" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("GrantsClient.listGrants (GET /admin/grants?agent=)", () => {
  test("GETs with the agent query + bearer; returns the grants array", async () => {
    let url = "";
    let auth = "";
    const client = clientWith((async (u: string | URL | Request, init?: RequestInit) => {
      url = String(u);
      auth = (init?.headers as Record<string, string>)?.authorization ?? "";
      return new Response(
        JSON.stringify({
          grants: [
            { id: "g1", agent: "a", connection: { kind: "vault", target: "v", access: "read" }, status: "approved" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);

    const grants = await client.listGrants("a");
    expect(url).toBe(`${HUB}/admin/grants?agent=a`);
    expect(auth).toBe(`Bearer ${BEARER}`);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.status).toBe("approved");
  });

  test("missing grants array → [] (defensive)", async () => {
    const client = clientWith((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch);
    expect(await client.listGrants("a")).toEqual([]);
  });

  test("throws on a non-ok response", async () => {
    const client = clientWith((async () => new Response("err", { status: 500 })) as unknown as typeof fetch);
    await expect(client.listGrants("a")).rejects.toThrow(GrantsApiError);
  });
});

describe("GrantsClient.getMaterial (GET /admin/grants/<id>/material)", () => {
  test("returns the vault material on 200", async () => {
    const mat: GrantMaterial = { kind: "vault", token: "VTOK", mcpUrl: "https://v/mcp" };
    let url = "";
    const client = clientWith((async (u: string | URL | Request) => {
      url = String(u);
      return new Response(JSON.stringify(mat), { status: 200 });
    }) as typeof fetch);
    expect(await client.getMaterial("g1")).toEqual(mat);
    expect(url).toBe(`${HUB}/admin/grants/g1/material`);
  });

  test("404 (unknown id) → null", async () => {
    const client = clientWith((async () => new Response("no", { status: 404 })) as unknown as typeof fetch);
    expect(await client.getMaterial("ghost")).toBeNull();
  });

  test("409 (not approved) → null", async () => {
    const client = clientWith((async () => new Response("pending", { status: 409 })) as unknown as typeof fetch);
    expect(await client.getMaterial("g-pending")).toBeNull();
  });

  test("any other non-ok throws", async () => {
    const client = clientWith((async () => new Response("boom", { status: 500 })) as unknown as typeof fetch);
    await expect(client.getMaterial("g1")).rejects.toThrow(GrantsApiError);
  });
});

describe("GrantsClient.reconcileGrants (POST /admin/grants/reconcile) — #96 grant-GC", () => {
  test("POSTs { agent, liveConnections } (specs, not keys) with the manager bearer; returns { pruned, prunedIds }", async () => {
    let captured: { url: string; method?: string; auth?: string; body?: unknown } = { url: "" };
    const client = clientWith((async (url: string | URL | Request, init?: RequestInit) => {
      captured = {
        url: String(url),
        method: init?.method,
        auth: (init?.headers as Record<string, string>)?.authorization,
        body: JSON.parse(String(init?.body)),
      };
      return new Response(JSON.stringify({ pruned: 2, prunedIds: ["g1", "g2"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    // We send the live connection SPECS, not pre-computed keys (the hub re-derives
    // keys with its own connectionKey — no cross-repo key-format dependency).
    const live: ConnectionSpec[] = [
      { kind: "vault", target: "research", access: "read" },
      { kind: "service", target: "github", inject: ["env", "mcp"] },
    ];
    const out = await client.reconcileGrants("researcher", live);
    expect(captured.url).toBe(`${HUB}/admin/grants/reconcile`);
    expect(captured.method).toBe("POST");
    expect(captured.auth).toBe(`Bearer ${BEARER}`);
    // The field name MUST stay "agent" (deferred rename B1 is NOT in scope).
    expect(captured.body).toEqual({ agent: "researcher", liveConnections: live });
    expect(out).toEqual({ pruned: 2, prunedIds: ["g1", "g2"] });
  });

  test("an empty liveConnections array (the def is gone → prune ALL) is sent verbatim", async () => {
    let body: unknown;
    const client = clientWith((async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ pruned: 3, prunedIds: ["a", "b", "c"] }), { status: 200 });
    }) as typeof fetch);
    const out = await client.reconcileGrants("gone", []);
    expect(body).toEqual({ agent: "gone", liveConnections: [] });
    expect(out.pruned).toBe(3);
  });

  test("a response with no prunedIds → { pruned } only (defensive)", async () => {
    const client = clientWith((async () => new Response(JSON.stringify({ pruned: 0 }), { status: 200 })) as unknown as typeof fetch);
    expect(await client.reconcileGrants("a", [])).toEqual({ pruned: 0 });
  });

  test("a non-JSON / empty 200 body → pruned defaults to 0 (never throws)", async () => {
    const client = clientWith((async () => new Response("", { status: 200 })) as unknown as typeof fetch);
    expect(await client.reconcileGrants("a", [])).toEqual({ pruned: 0 });
  });

  test("throws GrantsApiError carrying the status on a non-ok response", async () => {
    const client = clientWith((async () => new Response("nope", { status: 403 })) as unknown as typeof fetch);
    await expect(client.reconcileGrants("a", [])).rejects.toMatchObject({ status: 403 });
    await expect(client.reconcileGrants("a", [])).rejects.toThrow(GrantsApiError);
  });
});

// ---------------------------------------------------------------------------
// resolveConnectionStatus
// ---------------------------------------------------------------------------

describe("resolveConnectionStatus", () => {
  const vault: ConnectionSpec = { kind: "vault", target: "research", access: "read" };
  const svc: ConnectionSpec = { kind: "service", target: "github", inject: ["env"] };

  test("no connections → enabled", () => {
    expect(resolveConnectionStatus([], new Map())).toEqual({ status: "enabled" });
  });
  test("all approved → enabled", () => {
    const m = new Map([
      [connectionKey(vault), "approved"],
      [connectionKey(svc), "approved"],
    ]);
    expect(resolveConnectionStatus([vault, svc], m)).toEqual({ status: "enabled" });
  });
  test("any unapproved (pending / missing) → pending listing the keys", () => {
    const m = new Map([[connectionKey(vault), "approved"]]); // svc missing
    expect(resolveConnectionStatus([vault, svc], m)).toEqual({
      status: "pending",
      pending: [connectionKey(svc)],
    });
  });
  test("a pending grant status counts as not approved", () => {
    const m = new Map([[connectionKey(vault), "pending"]]);
    expect(resolveConnectionStatus([vault], m)).toEqual({
      status: "pending",
      pending: [connectionKey(vault)],
    });
  });
});

// ---------------------------------------------------------------------------
// service env / mcp maps
// ---------------------------------------------------------------------------

describe("service env var + mcp url maps", () => {
  test("known services map to canonical env var names", () => {
    expect(serviceEnvVar("github")).toBe("GITHUB_TOKEN");
    expect(serviceEnvVar("cloudflare")).toBe("CLOUDFLARE_API_TOKEN");
  });
  test("unknown service defaults to <TARGET>_TOKEN upper-snake", () => {
    expect(serviceEnvVar("my-svc")).toBe("MY_SVC_TOKEN");
    expect(serviceEnvVar("openai")).toBe("OPENAI_TOKEN");
  });
  test("github has a known MCP url; an unknown service has none", () => {
    expect(serviceMcpUrl("github")).toMatch(/^https:\/\//);
    expect(serviceMcpUrl("cloudflare")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveInjectedGrants — approved grants → mcp entries + env
// ---------------------------------------------------------------------------

/** A grants client whose list returns `grants` + whose material is keyed by grant id. */
function injectionClient(opts: {
  grants: Array<{ id: string; connection: ConnectionSpec; status: string }>;
  material?: Record<string, GrantMaterial | "404" | "409" | "throw">;
  onMaterialCall?: (id: string) => void;
}): GrantsClient {
  const fetchFn = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/admin/grants/")) {
      const id = u.split("/admin/grants/")[1]!.replace("/material", "");
      opts.onMaterialCall?.(id);
      const m = opts.material?.[id];
      if (!m || m === "404") return new Response("no", { status: 404 });
      if (m === "409") return new Response("pending", { status: 409 });
      if (m === "throw") return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(m), { status: 200 });
    }
    // list
    return new Response(
      JSON.stringify({
        grants: opts.grants.map((g) => ({ id: g.id, agent: "a", connection: g.connection, status: g.status })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return new GrantsClient({ hubOrigin: HUB, managerBearer: BEARER, fetchFn });
}

describe("grant entry keys — namespaced + mutually distinct", () => {
  test("grantMcpEntryKey returns grant-mcp-<slug>", () => {
    expect(grantMcpEntryKey("g1")).toBe("grant-mcp-g1");
  });
  test("the three grant entry keys + the def-vault key never collide for the same slug", () => {
    const slug = "x";
    const keys = [
      grantVaultEntryKey(slug),
      grantServiceEntryKey(slug),
      grantMcpEntryKey(slug),
      `parachute-vault-${slug}`, // the agent's OWN def-vault entry prefix
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("resolveInjectedGrants", () => {
  test("approved vault grant → an MCP entry (namespaced key)", async () => {
    const conn: ConnectionSpec = { kind: "vault", target: "research", access: "read" };
    const client = injectionClient({
      grants: [{ id: "g1", connection: conn, status: "approved" }],
      material: { g1: { kind: "vault", token: "VTOK", mcpUrl: "https://hub/vault/research/mcp" } },
    });
    const out = await resolveInjectedGrants(client, "a");
    expect(out.mcpEntries).toEqual([
      { name: grantVaultEntryKey("research"), url: "https://hub/vault/research/mcp", token: "VTOK" },
    ]);
    expect(out.env).toEqual({});
  });

  test("approved service grant (env) → an env var, no MCP entry", async () => {
    const conn: ConnectionSpec = { kind: "service", target: "github", inject: ["env"] };
    const client = injectionClient({
      grants: [{ id: "g1", connection: conn, status: "approved" }],
      material: { g1: { kind: "service", token: "GHTOK", inject: ["env"] } },
    });
    const out = await resolveInjectedGrants(client, "a");
    expect(out.env).toEqual({ GITHUB_TOKEN: "GHTOK" });
    expect(out.mcpEntries).toEqual([]);
  });

  test("approved service grant (mcp) → an MCP entry for the known service URL", async () => {
    const conn: ConnectionSpec = { kind: "service", target: "github", inject: ["mcp"] };
    const client = injectionClient({
      grants: [{ id: "g1", connection: conn, status: "approved" }],
      material: { g1: { kind: "service", token: "GHTOK", inject: ["mcp"] } },
    });
    const out = await resolveInjectedGrants(client, "a");
    expect(out.mcpEntries).toEqual([
      { name: grantServiceEntryKey("github"), url: serviceMcpUrl("github")!, token: "GHTOK" },
    ]);
    expect(out.env).toEqual({});
  });

  test("service granted env+mcp → both an env var AND an MCP entry", async () => {
    const conn: ConnectionSpec = { kind: "service", target: "github", inject: ["env", "mcp"] };
    const client = injectionClient({
      grants: [{ id: "g1", connection: conn, status: "approved" }],
      material: { g1: { kind: "service", token: "GHTOK", inject: ["env", "mcp"] } },
    });
    const out = await resolveInjectedGrants(client, "a");
    expect(out.env).toEqual({ GITHUB_TOKEN: "GHTOK" });
    expect(out.mcpEntries).toEqual([
      { name: grantServiceEntryKey("github"), url: serviceMcpUrl("github")!, token: "GHTOK" },
    ]);
  });

  test("service with inject:[mcp] but no known MCP url → env kept, mcp skipped (no throw)", async () => {
    const conn: ConnectionSpec = { kind: "service", target: "cloudflare", inject: ["env", "mcp"] };
    const client = injectionClient({
      grants: [{ id: "g1", connection: conn, status: "approved" }],
      material: { g1: { kind: "service", token: "CFTOK", inject: ["env", "mcp"] } },
    });
    const out = await resolveInjectedGrants(client, "a");
    expect(out.env).toEqual({ CLOUDFLARE_API_TOKEN: "CFTOK" });
    expect(out.mcpEntries).toEqual([]); // no known cloudflare MCP url → skipped
  });

  test("only APPROVED grants are fetched (pending/revoked skipped, no material call)", async () => {
    const called: string[] = [];
    const client = injectionClient({
      grants: [
        { id: "g1", connection: { kind: "vault", target: "a", access: "read" }, status: "pending" },
        { id: "g2", connection: { kind: "service", target: "github", inject: ["env"] }, status: "revoked" },
        { id: "g3", connection: { kind: "vault", target: "b", access: "read" }, status: "approved" },
      ],
      material: { g3: { kind: "vault", token: "BTOK", mcpUrl: "https://hub/vault/b/mcp" } },
      onMaterialCall: (id) => called.push(id),
    });
    const out = await resolveInjectedGrants(client, "a");
    // Only the approved grant's material was fetched.
    expect(called).toEqual(["g3"]);
    expect(out.mcpEntries).toEqual([
      { name: grantVaultEntryKey("b"), url: "https://hub/vault/b/mcp", token: "BTOK" },
    ]);
  });

  test("approved mcp grant (4b-2) → an MCP entry keyed by grant id, no env", async () => {
    const conn: ConnectionSpec = { kind: "mcp", target: "https://remote.example.com/vault/eng/mcp" };
    const client = injectionClient({
      grants: [{ id: "gmcp", connection: conn, status: "approved" }],
      material: { gmcp: { kind: "mcp", token: "MTOK", mcpUrl: "https://remote.example.com/vault/eng/mcp" } },
    });
    const out = await resolveInjectedGrants(client, "a");
    expect(out.mcpEntries).toEqual([
      { name: grantMcpEntryKey("gmcp"), url: "https://remote.example.com/vault/eng/mcp", token: "MTOK" },
    ]);
    expect(out.env).toEqual({});
  });

  test("an unapproved/pending mcp grant injects NOTHING (getMaterial 409 → absent)", async () => {
    // A pending mcp grant has no material yet — the hub 409s /material → null → absent.
    const client = injectionClient({
      grants: [{ id: "gmcp", connection: { kind: "mcp", target: "https://remote/mcp" }, status: "pending" }],
      material: { gmcp: "409" },
    });
    const out = await resolveInjectedGrants(client, "a");
    expect(out.mcpEntries).toEqual([]);
    expect(out.env).toEqual({});
  });

  test("an approved mcp grant whose material 404s (race) → absent, not an error", async () => {
    const client = injectionClient({
      grants: [{ id: "gmcp", connection: { kind: "mcp", target: "https://remote/mcp" }, status: "approved" }],
      material: { gmcp: "404" },
    });
    const out = await resolveInjectedGrants(client, "a");
    expect(out.mcpEntries).toEqual([]);
    expect(out.env).toEqual({});
  });

  test("mixed: approved vault + mcp + service(env) grants all inject with distinct keys", async () => {
    const client = injectionClient({
      grants: [
        { id: "gv", connection: { kind: "vault", target: "research", access: "read" }, status: "approved" },
        { id: "gm", connection: { kind: "mcp", target: "https://remote/eng/mcp" }, status: "approved" },
        { id: "gs", connection: { kind: "service", target: "github", inject: ["env"] }, status: "approved" },
      ],
      material: {
        gv: { kind: "vault", token: "VTOK", mcpUrl: "https://hub/vault/research/mcp" },
        gm: { kind: "mcp", token: "MTOK", mcpUrl: "https://remote/eng/mcp" },
        gs: { kind: "service", token: "GHTOK", inject: ["env"] },
      },
    });
    const out = await resolveInjectedGrants(client, "a");
    expect(out.mcpEntries).toEqual([
      { name: grantVaultEntryKey("research"), url: "https://hub/vault/research/mcp", token: "VTOK" },
      { name: grantMcpEntryKey("gm"), url: "https://remote/eng/mcp", token: "MTOK" },
    ]);
    expect(out.env).toEqual({ GITHUB_TOKEN: "GHTOK" });
    // The vault + mcp MCP-entry keys are distinct.
    expect(out.mcpEntries[0]!.name).not.toBe(out.mcpEntries[1]!.name);
  });

  test("two approved mcp grants for distinct remotes → two entries, keyed by id (no collision)", async () => {
    // The rationale for keying grantMcpEntryKey on the grant id (not the URL): two
    // distinct remote MCPs must get distinct entry names. This is that guarantee.
    const client = injectionClient({
      grants: [
        { id: "gm1", connection: { kind: "mcp", target: "https://eng.example/vault/eng/mcp" }, status: "approved" },
        { id: "gm2", connection: { kind: "mcp", target: "https://ops.example/vault/ops/mcp" }, status: "approved" },
      ],
      material: {
        gm1: { kind: "mcp", token: "T1", mcpUrl: "https://eng.example/vault/eng/mcp" },
        gm2: { kind: "mcp", token: "T2", mcpUrl: "https://ops.example/vault/ops/mcp" },
      },
    });
    const out = await resolveInjectedGrants(client, "a");
    expect(out.mcpEntries).toEqual([
      { name: grantMcpEntryKey("gm1"), url: "https://eng.example/vault/eng/mcp", token: "T1" },
      { name: grantMcpEntryKey("gm2"), url: "https://ops.example/vault/ops/mcp", token: "T2" },
    ]);
    expect(out.mcpEntries[0]!.name).not.toBe(out.mcpEntries[1]!.name);
    expect(out.env).toEqual({});
  });

  test("a single material fetch fault is isolated — the other grants still inject", async () => {
    const client = injectionClient({
      grants: [
        { id: "g1", connection: { kind: "vault", target: "a", access: "read" }, status: "approved" },
        { id: "g2", connection: { kind: "service", target: "github", inject: ["env"] }, status: "approved" },
      ],
      material: {
        g1: "throw", // 500 → fetch throws GrantsApiError → skipped
        g2: { kind: "service", token: "GHTOK", inject: ["env"] },
      },
    });
    const out = await resolveInjectedGrants(client, "a");
    expect(out.mcpEntries).toEqual([]); // g1's vault entry skipped
    expect(out.env).toEqual({ GITHUB_TOKEN: "GHTOK" }); // g2 still injected
  });

  test("a list failure propagates (caller spawns without grants)", async () => {
    const fetchFn = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const client = new GrantsClient({ hubOrigin: HUB, managerBearer: BEARER, fetchFn });
    await expect(resolveInjectedGrants(client, "a")).rejects.toThrow(GrantsApiError);
  });

  test("material is fetched FRESH each call (not cached across spawns)", async () => {
    const called: string[] = [];
    const client = injectionClient({
      grants: [{ id: "g1", connection: { kind: "vault", target: "a", access: "read" }, status: "approved" }],
      material: { g1: { kind: "vault", token: "VTOK", mcpUrl: "https://hub/vault/a/mcp" } },
      onMaterialCall: (id) => called.push(id),
    });
    await resolveInjectedGrants(client, "a");
    await resolveInjectedGrants(client, "a");
    // Two spawns → two material fetches (no cache between them — revocation takes
    // effect next spawn precisely because we re-fetch).
    expect(called).toEqual(["g1", "g1"]);
  });
});
