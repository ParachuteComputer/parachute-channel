/**
 * Tests for the unified create-agent page (src/agents-ui.ts) — Parachute Agent
 * Phase-1 consolidation. The page is a self-contained HTML+JS string (the same
 * shape as admin-ui.ts), so these string-pin the served document's shape: the
 * minimal default flow, the Advanced disclosure, the client-side-orchestration
 * decision (reuse the shared ChannelProvision, no server-side vault minting), the
 * channel-reuse idempotency, the unified-form payload shaping (the SAME /api/agents
 * body), and the terminal-link gating (terminal links only for interactive agents).
 *
 * These mirror admin-ui.test.ts's discipline — assert the served strings, no DOM.
 */
import { describe, test, expect } from "bun:test";
import { AGENTS_UI_HTML } from "./agents-ui.ts";

const html = AGENTS_UI_HTML;

describe("create-agent page — the unified primary surface", () => {
  test("leads with the Create an agent section + button", () => {
    expect(html).toContain('id="create-section"');
    expect(html).toContain("Create an agent");
    expect(html).toContain('id="create-go"');
    // The minimal default: name + vault + optional system prompt.
    expect(html).toContain('id="agent-name"');
    expect(html).toContain('id="agent-vault"');
    expect(html).toContain('id="agent-system-prompt"');
  });

  test("vault is the default transport (the new-channel transport leads with vault selected)", () => {
    expect(html).toContain('id="agent-transport"');
    expect(html).toContain('<option value="vault" selected>');
  });

  test("Advanced reveals existing-channel, transports, backend, isolation, mounts", () => {
    expect(html).toContain('id="advanced"');
    expect(html).toContain('id="use-existing"');
    expect(html).toContain('id="existing-channel"');
    expect(html).toContain('id="agent-backend"');
    expect(html).toContain('value="telegram"');
    expect(html).toContain('value="http-ui"');
    expect(html).toContain('id="fs-mode"');
    expect(html).toContain('id="net-mode"');
    expect(html).toContain('id="agent-workspace"');
    expect(html).toContain('id="mounts-rows"');
    // System-prompt mode (append/replace) lives under Advanced.
    expect(html).toContain('<option value="append" selected>Append (default)</option>');
    expect(html).toContain('<option value="replace">Replace</option>');
  });

  test("backend defaults to programmatic; interactive is selectable but not default", () => {
    expect(html).toMatch(/<option value="programmatic" selected>/);
    expect(html).not.toMatch(/<option value="interactive" selected>/);
    expect(html).toContain('<option value="interactive">');
  });
});

describe("client-side orchestration (the load-bearing decision)", () => {
  test("reuses the shared ChannelProvision client — no server-side vault minting", () => {
    expect(html).toContain("window.ChannelProvision");
    expect(html).toContain("Provision.provisionVaultChannel");
    expect(html).toContain("Provision.provisionDaemonChannel");
    expect(html).toContain("Provision.channelExists");
    expect(html).toContain("Provision.listVaults");
    // The vault path goes to the HUB (cookie-gated), not a daemon vault-mint.
    expect(html).toContain("window.location.origin");
  });

  test("the agent spawn posts the SAME /api/agents body (no new API fields)", () => {
    expect(html).toContain('apiJson("/api/agents", { method: "POST"');
    // collectSpec assembles the canonical fields buildSpecFromBody already accepts.
    expect(html).toContain("function collectSpec");
    expect(html).toContain("spec.backend =");
    expect(html).toContain("spec.systemPrompt = sysPrompt");
    expect(html).toContain("spec.workspace = workspace");
  });
});

describe("channel-reuse idempotency", () => {
  test("checks for an existing channel and REUSES it (no double-provision)", () => {
    // ensureChannel first asks channelExists; an existing channel resolves reused.
    expect(html).toContain("function ensureChannel");
    expect(html).toContain("Provision.channelExists");
    expect(html).toContain("chk.exists");
    expect(html).toContain("reused: true");
  });

  test("an existing-channel selection skips provisioning entirely", () => {
    // useExisting === "existing" → channelStep resolves ok without provisioning.
    expect(html).toContain('useExistingEl.value === "existing"');
    expect(html).toContain("Promise.resolve({ ok: true, reused: true })");
  });

  test("a post-provision spawn failure surfaces a clear error (channel may remain)", () => {
    expect(html).toContain("the agent spawn failed");
    expect(html).toContain("may remain");
  });
});

describe("unified-form payload shaping", () => {
  test("resolveWakeChannel: existing mode uses the picker; new mode uses the name", () => {
    expect(html).toContain("function resolveWakeChannel");
    expect(html).toContain("return ch;"); // existing → the picked channel
    expect(html).toContain("return name;"); // new → the agent name
  });

  test("the wake channel is the first channels[] entry; extras append", () => {
    expect(html).toContain("var channels = [{ name: wake,");
    expect(html).toContain("channels.push({ name: n,");
  });

  test("optional fields are omitted when blank (filesystem/network/workspace/prompt)", () => {
    expect(html).toContain('if (fsMode.value === "full") spec.filesystem = "full";');
    expect(html).toContain('if (netMode.value === "restricted")');
    expect(html).toContain("if (workspace) spec.workspace = workspace;");
    expect(html).toContain("if (sysPrompt) {");
  });
});

describe("terminal-link gating (Phase-1 cleanup)", () => {
  test("the per-agent terminal link is shown ONLY for interactive agents", () => {
    // The running-agents list gates the terminal link behind !prog (interactive).
    expect(html).toContain("if (!prog) {");
    expect(html).toContain("terminal ↗");
  });

  test("reveals the Terminal nav entry only when an interactive agent exists", () => {
    expect(html).toContain("setTerminalNavVisible(agents.some(function (a) { return a.backend !== \"programmatic\"; }))");
  });

  test("the /terminal helper + route are preserved (capability not deleted)", () => {
    expect(html).toContain("function terminalUrl");
    expect(html).toContain("/terminal?agent=");
  });

  test("an interactive launch surfaces its sandbox posture (mcp/filesystem/network)", () => {
    // Security-relevant: the operator must be able to verify an interactive agent's
    // isolation matches what they selected. These lines render on an interactive
    // (non-programmatic, non-alreadyRunning) launch result.
    expect(html).toContain("MCP servers: ");
    expect(html).toContain('"filesystem: "');
    expect(html).toContain('"network: "');
    // Programmatic auto-navigates to chat; interactive does NOT (the posture lines +
    // Terminal-attach affordance stay on screen).
    expect(html).toContain("if (prog) {");
    expect(html).toContain("window.location.href = chatUrl(wake)");
  });
});

describe("vocabulary + safety", () => {
  test("uses Create vocabulary (the unified create-agent flow), not Spawn", () => {
    expect(html).toContain("Create agent");
    expect(html).not.toContain("Spawn an agent");
  });

  test("the page still loads OPEN and mints a channel:admin Bearer", () => {
    expect(html).toContain("fetchToken()");
    expect(html).toContain("channel:admin token");
  });
});
