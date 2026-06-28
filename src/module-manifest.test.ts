/**
 * `.parachute/module.json` manifest contract tests.
 *
 * Moved out of the (now-deleted) admin-ui.test.ts in Phase 4c — the admin PAGE
 * retired into the SPA, but the manifest declarations it validated (modular-UI
 * fields, channel events, vault-trigger actions, connectionTemplates, the
 * existing name/port/scopes contract) are still load-bearing for the hub.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("module.json — modular-UI declaration", () => {
  // The manifest sits at <repo>/.parachute/module.json; this test file is in
  // <repo>/src, so go up one.
  const manifestPath = join(import.meta.dir, "..", ".parachute", "module.json");

  test("parses as JSON and carries the modular-UI fields (SPA mount after Phase 4c)", async () => {
    const raw = await Bun.file(manifestPath).text();
    const m = JSON.parse(raw) as Record<string, unknown>;
    // Phase 4c retired the server-rendered config page; configUiUrl now points
    // at the SPA app mount the hub frames.
    expect(m.configUiUrl).toBe("/agent/app/");
    expect(m.focus).toBe("experimental");
    expect(m.adminCapabilities).toEqual(["config"]);
  });

  test("declares the channel events (message.received / message.sent)", async () => {
    const m = JSON.parse(await Bun.file(manifestPath).text()) as {
      events?: Array<{ key: string; title: string }>;
    };
    const keys = (m.events ?? []).map((e) => e.key);
    expect(keys).toContain("message.received");
    expect(keys).toContain("message.sent");
    for (const e of m.events ?? []) expect(typeof e.title).toBe("string");
  });

  test("declares the message.deliver action with a vault-trigger provision", async () => {
    const m = JSON.parse(await Bun.file(manifestPath).text()) as {
      actions?: Array<{ key: string; title: string; provision?: { type?: string } }>;
    };
    const deliver = (m.actions ?? []).find((a) => a.key === "message.deliver");
    expect(deliver).toBeDefined();
    expect(deliver?.provision?.type).toBe("vault-trigger");
  });

  test("message.deliver declares the hub-connection wiring (endpoint + scope)", async () => {
    // The hub's general Connections engine (P5) wires a `vault-trigger` action
    // GENERICALLY: the webhook the vault calls back on is derived from the sink
    // action's `endpoint` (hub-proxied under the module's mount), and the bearer
    // the vault re-presents is minted at the action's declared `scope` — NOT a
    // channel-hardcoded path in hub code. So the deliver action must carry both.
    const m = JSON.parse(await Bun.file(manifestPath).text()) as {
      actions?: Array<{ key: string; endpoint?: string; scope?: string }>;
    };
    const deliver = (m.actions ?? []).find((a) => a.key === "message.deliver");
    expect(deliver?.endpoint).toBe("/api/vault/inbound");
    expect(deliver?.scope).toBe("agent:send");
  });

  test("declares a connectionTemplate for the parameterized link-to-vault connection (R2)", async () => {
    const m = JSON.parse(await Bun.file(manifestPath).text()) as {
      connectionTemplates?: Array<{
        key: string;
        requestedBy?: string;
        source?: { module?: string; event?: string; filter?: { tags?: string[] } };
        sink?: { module?: string; action?: string };
        parameters?: Array<{ key: string; target: string }>;
      }>;
    };
    const tmpl = (m.connectionTemplates ?? []).find((t) => t.key === "link-to-vault");
    expect(tmpl).toBeDefined();
    // The module declares WHAT it wants: vault.note.created (inbound tag) →
    // agent.message.deliver, labeled module-initiated.
    expect(tmpl?.requestedBy).toBe("agent");
    expect(tmpl?.source?.module).toBe("vault");
    expect(tmpl?.source?.event).toBe("note.created");
    expect(tmpl?.source?.filter?.tags).toContain("agent/message/inbound");
    expect(tmpl?.sink?.module).toBe("agent");
    expect(tmpl?.sink?.action).toBe("message.deliver");
    // It's PARAMETERIZED — the operator picks the vault + names the channel.
    const paramKeys = (tmpl?.parameters ?? []).map((p) => p.key);
    expect(paramKeys).toContain("vault");
    expect(paramKeys).toContain("channel");
    // The parameters point at the connection-body targets the UI fills in.
    const vaultParam = (tmpl?.parameters ?? []).find((p) => p.key === "vault");
    expect(vaultParam?.target).toBe("source.vault");
    const channelParam = (tmpl?.parameters ?? []).find((p) => p.key === "channel");
    expect(channelParam?.target).toBe("sink.params.channel");
  });

  test("declares the definition.reload action with a vault-trigger provision (Connector 1)", async () => {
    // Make a vault #agent/definition change flow LIVE into the registry: the
    // hub provisions a vault trigger that webhooks /api/vault/agent-def with an
    // agent:send bearer, and the daemon re-reads + re-instantiates that one def.
    const m = JSON.parse(await Bun.file(manifestPath).text()) as {
      actions?: Array<{ key: string; provision?: { type?: string }; endpoint?: string; scope?: string }>;
    };
    const reload = (m.actions ?? []).find((a) => a.key === "definition.reload");
    expect(reload).toBeDefined();
    expect(reload?.provision?.type).toBe("vault-trigger");
    // Wiring mirrors message.deliver: the webhook endpoint the daemon already
    // serves, and the agent:send scope that endpoint gates on (daemon.ts).
    expect(reload?.endpoint).toBe("/api/vault/agent-def");
    expect(reload?.scope).toBe("agent:send");
  });

  test("declares TWO def-reload templates (created + updated) — the hub binds one event per connection", async () => {
    // A connection carries a single `source.event` (admin-connections.ts:
    // eventsForSourceEvent maps one note.<verb> → one trigger verb), so create
    // and edit reactivity are two connections / two templates. note.deleted is
    // deliberately ABSENT — the hub rejects it (Connector 2, platform-blocked).
    const m = JSON.parse(await Bun.file(manifestPath).text()) as {
      connectionTemplates?: Array<{
        key: string;
        requestedBy?: string;
        source?: { module?: string; event?: string; filter?: { tags?: string[] } };
        sink?: { module?: string; action?: string };
        parameters?: Array<{ key: string; target: string }>;
      }>;
    };
    const templates = m.connectionTemplates ?? [];
    const onCreate = templates.find((t) => t.key === "reload-defs-on-create");
    const onEdit = templates.find((t) => t.key === "reload-defs-on-edit");
    expect(onCreate).toBeDefined();
    expect(onEdit).toBeDefined();

    for (const tmpl of [onCreate, onEdit]) {
      expect(tmpl?.requestedBy).toBe("agent");
      expect(tmpl?.source?.module).toBe("vault");
      // Filters on the def tag — and ONLY that tag (no inbound-message keys).
      expect(tmpl?.source?.filter?.tags).toEqual(["agent/definition"]);
      expect(tmpl?.sink?.module).toBe("agent");
      expect(tmpl?.sink?.action).toBe("definition.reload");
      // Parameterized: the operator picks which def-vault. No channel param
      // (a def-vault connection has no reply path — it's read-driven reload).
      const paramKeys = (tmpl?.parameters ?? []).map((p) => p.key);
      expect(paramKeys).toEqual(["vault"]);
      const vaultParam = (tmpl?.parameters ?? []).find((p) => p.key === "vault");
      expect(vaultParam?.target).toBe("source.vault");
    }

    // The two halves differ ONLY in the source event.
    expect(onCreate?.source?.event).toBe("note.created");
    expect(onEdit?.source?.event).toBe("note.updated");
    // No template subscribes deleted (would 400 at the hub).
    expect(templates.some((t) => t.source?.event === "note.deleted")).toBe(false);
  });

  test("preserves the existing manifest contract (name, port, uiUrl, scopes)", async () => {
    const m = JSON.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>;
    expect(m.name).toBe("agent");
    expect(m.port).toBe(1941);
    // Phase 4c: uiUrl points at the SPA app root (the retired /home page is gone).
    expect(m.uiUrl).toBe("/agent/app/");
    const scopes = m.scopes as { defines?: string[] } | undefined;
    expect(scopes?.defines).toContain("agent:admin");
  });
});
