import { describe, test, expect } from "bun:test";
import {
  buildDefVaultTriggers,
  defWatchTriggerName,
  inboundTriggerName,
  registerDefVaultTriggers,
  registerAllDefVaultTriggers,
  DEFINITION_TAG,
  INBOUND_TAG,
  type VaultTriggerInput,
} from "./def-vault-triggers.ts";
import type { DefVaultBinding } from "./agent-defs.ts";
import { AGENT_VAULT_TRIGGER_TEMPLATE } from "./transports/vault.ts";

const HUB = "https://hub.example.com";

/**
 * A fake fetch routing the two endpoints the registration path hits:
 *   - POST <hub>/api/auth/mint-token  → returns a scripted token per requested scope
 *   - POST <vaultUrl>/vault/<v>/api/triggers → returns 200 (or a scripted status)
 * Records every call so a test can assert what was posted where.
 */
function fakeFetch(opts?: {
  mintStatus?: (scope: string) => { status: number; json: unknown };
  triggerStatus?: number;
}): {
  fetchFn: typeof fetch;
  mintCalls: Array<{ scope: string; auth: string | null }>;
  triggerCalls: Array<{ url: string; auth: string | null; body: VaultTriggerInput }>;
} {
  const mintCalls: Array<{ scope: string; auth: string | null }> = [];
  const triggerCalls: Array<{ url: string; auth: string | null; body: VaultTriggerInput }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (u.endsWith("/api/auth/mint-token")) {
      const scope = String(body.scope ?? "");
      mintCalls.push({ scope, auth: headers.get("authorization") });
      const scripted = opts?.mintStatus?.(scope);
      if (scripted) {
        return new Response(JSON.stringify(scripted.json), {
          status: scripted.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ token: `tok-for-${scope}`, jti: `jti-${scope}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/api/triggers")) {
      triggerCalls.push({ url: u, auth: headers.get("authorization"), body: body as unknown as VaultTriggerInput });
      const status = opts?.triggerStatus ?? 200;
      return new Response(JSON.stringify({ trigger: { name: body.name } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as unknown as typeof fetch;
  return { fetchFn, mintCalls, triggerCalls };
}

const BINDING: DefVaultBinding = {
  vault: "default",
  vaultUrl: "http://127.0.0.1:1940",
  token: "vault:default:write-token",
};

describe("trigger names mirror the hub's conn_<id> shape", () => {
  test("def-watch names match conn_agentdefs-{create,edit}-<vault> (upsert-replaces the hub's)", () => {
    expect(defWatchTriggerName("default", "create")).toBe("conn_agentdefs-create-default");
    expect(defWatchTriggerName("default", "edit")).toBe("conn_agentdefs-edit-default");
    expect(defWatchTriggerName("work", "create")).toBe("conn_agentdefs-create-work");
  });
  test("inbound name is one-per-vault", () => {
    expect(inboundTriggerName("default")).toBe("conn_agentinbound-default");
  });
});

describe("buildDefVaultTriggers — the bare-keyed shapes", () => {
  const triggers = buildDefVaultTriggers("default", HUB, "BEARER");
  /** Resolve a trigger by name (avoids index-access undefined under strict TS). */
  function byName(name: string): VaultTriggerInput {
    const t = triggers.find((x) => x.name === name);
    if (!t) throw new Error(`no trigger named ${name}`);
    return t;
  }

  test("emits six triggers: def-watch create/edit, inbound, role-watch create/edit, thread-watch create", () => {
    expect(triggers.map((t) => t.name)).toEqual([
      "conn_agentdefs-create-default",
      "conn_agentdefs-edit-default",
      "conn_agentinbound-default",
      // threads-only Phase B′ — the per-role reconcile triggers.
      "conn_roles-create-default",
      "conn_roles-edit-default",
      // Phase 4a dual-discovery — the thread-watch CREATE trigger (create-only by design).
      "conn_threads-create-default",
    ]);
  });

  test("thread-watch trigger is bare `agent/thread`-keyed, CREATE-only, webhooks the thread-discovery endpoint", () => {
    const t = byName("conn_threads-create-default");
    expect(t.when.tags).toEqual(["agent/thread"]);
    expect(t.events).toEqual(["created"]); // create-only — edits churn per-turn; the poll converges them.
    expect(t.action.webhook).toBe(`${HUB}/agent/api/vault/agent-thread`);
    expect(t.action.auth?.bearer).toBe("BEARER");
  });

  test("role-watch triggers are bare `agent/role`-keyed and webhook the role reconcile endpoint", () => {
    for (const name of ["conn_roles-create-default", "conn_roles-edit-default"]) {
      const t = byName(name);
      expect(t.when.tags).toEqual(["agent/role"]);
      expect(t.action.webhook).toBe(`${HUB}/agent/api/vault/role`);
      expect(t.action.send).toBe("json");
      expect(t.action.auth?.bearer).toBe("BEARER");
    }
    expect(byName("conn_roles-create-default").events).toEqual(["created"]);
    expect(byName("conn_roles-edit-default").events).toEqual(["updated"]);
  });

  test("def-watch triggers are BARE-keyed (agent/definition, NOT #agent/definition)", () => {
    expect(DEFINITION_TAG).toBe("agent/definition");
    expect(byName("conn_agentdefs-create-default").when.tags).toEqual(["agent/definition"]);
    expect(byName("conn_agentdefs-edit-default").when.tags).toEqual(["agent/definition"]);
    // Guard against the regression this PR fixes — no stray `#` anywhere in the tag.
    for (const t of triggers) {
      for (const tag of t.when.tags) expect(tag.startsWith("#")).toBe(false);
    }
  });

  test("def-watch create fires on [created], edit on [updated] (no `deleted` — the API caps at created/updated)", () => {
    expect(byName("conn_agentdefs-create-default").events).toEqual(["created"]);
    expect(byName("conn_agentdefs-edit-default").events).toEqual(["updated"]);
    // The vault triggers API only accepts created/updated; deleted would 400.
    for (const t of triggers) {
      for (const e of t.events) expect(["created", "updated"]).toContain(e);
    }
  });

  test("def-watch webhooks the agent-def reload endpoint with the agent:send bearer", () => {
    for (const name of ["conn_agentdefs-create-default", "conn_agentdefs-edit-default"]) {
      const t = byName(name);
      expect(t.action.webhook).toBe(`${HUB}/agent/api/vault/agent-def`);
      expect(t.action.send).toBe("json");
      expect(t.action.auth?.bearer).toBe("BEARER");
    }
  });

  test("inbound trigger: bare inbound tag, has_metadata:[agent], missing_metadata matches the module template", () => {
    const inbound = byName("conn_agentinbound-default");
    // The shape is sourced from AGENT_VAULT_TRIGGER_TEMPLATE so it matches the
    // hub-Connections path exactly (same field names — no drift).
    expect(INBOUND_TAG).toBe("agent/message/inbound");
    expect(inbound.events).toEqual(["created"]);
    expect(inbound.when.tags).toEqual([...AGENT_VAULT_TRIGGER_TEMPLATE.when.tags]);
    expect(inbound.when.has_metadata).toEqual([...AGENT_VAULT_TRIGGER_TEMPLATE.when.has_metadata]);
    expect(inbound.when.missing_metadata).toEqual([...AGENT_VAULT_TRIGGER_TEMPLATE.when.missing_metadata]);
    // Concretely (the canonical field name across module.json + the hub + vault.ts):
    expect(inbound.when.missing_metadata).toEqual(["channel_inbound_rendered_at"]);
  });

  test("inbound trigger webhooks /api/vault/inbound with the agent:send bearer", () => {
    const inbound = byName("conn_agentinbound-default");
    expect(inbound.action.webhook).toBe(`${HUB}/agent/api/vault/inbound`);
    expect(inbound.action.send).toBe("json");
    expect(inbound.action.auth?.bearer).toBe("BEARER");
  });
});

describe("registerDefVaultTriggers — the live registration path", () => {
  test("mints agent:send + vault:<v>:admin, POSTs all five triggers with the admin bearer", async () => {
    const { fetchFn, mintCalls, triggerCalls } = fakeFetch();
    const result = await registerDefVaultTriggers(BINDING, {
      hubOrigin: HUB,
      managerBearer: "OP-BEARER",
      fetchFn,
    });

    // Both scopes minted, each attenuated to the operator bearer.
    expect(mintCalls.map((c) => c.scope).sort()).toEqual(["agent:send", "vault:default:admin"]);
    for (const c of mintCalls) expect(c.auth).toBe("Bearer OP-BEARER");

    // All six triggers registered, posted to the vault's triggers API.
    expect(result.failures).toEqual([]);
    expect(result.registered).toEqual([
      "conn_agentdefs-create-default",
      "conn_agentdefs-edit-default",
      "conn_agentinbound-default",
      "conn_roles-create-default",
      "conn_roles-edit-default",
      "conn_threads-create-default",
    ]);
    expect(triggerCalls).toHaveLength(6);
    for (const c of triggerCalls) {
      expect(c.url).toBe("http://127.0.0.1:1940/vault/default/api/triggers");
      // The ADMIN token (not the write token) authenticates the triggers POST.
      expect(c.auth).toBe("Bearer tok-for-vault:default:admin");
    }
  });

  test("the webhook bearer carried on each trigger is the minted agent:send token", async () => {
    const { fetchFn, triggerCalls } = fakeFetch();
    await registerDefVaultTriggers(BINDING, { hubOrigin: HUB, managerBearer: "OP-BEARER", fetchFn });
    for (const c of triggerCalls) {
      expect(c.body.action.auth?.bearer).toBe("tok-for-agent:send");
    }
  });

  test("an admin-mint refusal (insufficient operator authority) skips registration, no throw", async () => {
    const { fetchFn, mintCalls, triggerCalls } = fakeFetch({
      mintStatus: (scope) =>
        scope.endsWith(":admin")
          ? { status: 400, json: { error: "invalid_scope", error_description: "cannot mint admin" } }
          : { status: 200, json: { token: `tok-for-${scope}` } },
    });
    const result = await registerDefVaultTriggers(BINDING, {
      hubOrigin: HUB,
      managerBearer: "OP-BEARER",
      fetchFn,
    });
    // Admin is minted FIRST and short-circuits — the agent:send mint is never attempted.
    expect(mintCalls.map((c) => c.scope)).toEqual(["vault:default:admin"]);
    expect(triggerCalls).toHaveLength(0);
    expect(result.registered).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("vault:default:admin");
    expect(result.failures[0]).toContain("invalid_scope");
  });

  test("an agent:send mint refusal skips registration entirely", async () => {
    const { fetchFn, mintCalls, triggerCalls } = fakeFetch({
      mintStatus: (scope) =>
        scope === "agent:send"
          ? { status: 403, json: { error: "forbidden" } }
          : { status: 200, json: { token: `tok-for-${scope}` } },
    });
    const result = await registerDefVaultTriggers(BINDING, {
      hubOrigin: HUB,
      managerBearer: "OP-BEARER",
      fetchFn,
    });
    // Admin mint succeeds first, then the webhook-bearer mint fails → no triggers.
    expect(mintCalls.map((c) => c.scope)).toEqual(["vault:default:admin", "agent:send"]);
    expect(triggerCalls).toHaveLength(0);
    expect(result.failures[0]).toContain("agent:send");
  });

  test("a vault non-2xx on the triggers POST is captured per-trigger, never thrown", async () => {
    const { fetchFn, triggerCalls } = fakeFetch({ triggerStatus: 403 });
    const result = await registerDefVaultTriggers(BINDING, {
      hubOrigin: HUB,
      managerBearer: "OP-BEARER",
      fetchFn,
    });
    expect(triggerCalls).toHaveLength(6); // all six attempted
    expect(result.registered).toEqual([]);
    expect(result.failures).toHaveLength(6);
    for (const f of result.failures) expect(f).toContain("HTTP 403");
  });

  test("defaults vaultUrl to the loopback vault when the binding omits it", async () => {
    const { fetchFn, triggerCalls } = fakeFetch();
    await registerDefVaultTriggers(
      { vault: "work", token: "t" },
      { hubOrigin: HUB, managerBearer: "OP", fetchFn },
    );
    for (const c of triggerCalls) {
      expect(c.url).toBe("http://127.0.0.1:1940/vault/work/api/triggers");
    }
  });
});

describe("registerAllDefVaultTriggers — fan-out over bindings", () => {
  test("registers triggers for every binding; one vault's failure doesn't block another", async () => {
    const { fetchFn, triggerCalls } = fakeFetch();
    const results = await registerAllDefVaultTriggers(
      [
        { vault: "default", vaultUrl: "http://127.0.0.1:1940", token: "a" },
        { vault: "work", vaultUrl: "http://127.0.0.1:1940", token: "b" },
      ],
      { hubOrigin: HUB, managerBearer: "OP", fetchFn },
    );
    expect(results.map((r) => r.vault)).toEqual(["default", "work"]);
    expect(results.every((r) => r.failures.length === 0)).toBe(true);
    // 6 triggers × 2 vaults.
    expect(triggerCalls).toHaveLength(12);
    const names = new Set(triggerCalls.map((c) => c.body.name));
    expect(names.has("conn_agentdefs-create-work")).toBe(true);
    expect(names.has("conn_agentinbound-default")).toBe(true);
    expect(names.has("conn_roles-create-work")).toBe(true);
  });
});
