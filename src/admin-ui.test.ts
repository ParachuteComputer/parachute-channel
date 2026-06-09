/**
 * Tests for `renderAdminPage()` (the module-owned channel config UI) + the
 * `.parachute/module.json` declaration that the modular-UI architecture (P4)
 * adds.
 *
 * `renderAdminPage` is a pure function — these assert the rendered HTML carries
 * the right mount-aware shape (the load-bearing fix for the "hub strips
 * /channel before forwarding" case where server-side `mount` is empty but the
 * browser page URL is `/channel/admin`), and that the page targets the right
 * endpoints. No DOM tests — just verify the served strings.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderAdminPage, escapeHtml } from "./admin-ui.ts";

describe("renderAdminPage", () => {
  test("renders the channel config chrome", () => {
    const html = renderAdminPage("");
    expect(html).toContain("<title>Channel — Configuration</title>");
    expect(html).toContain("Manage channels");
    // The simple add-form offers ONLY the two cross-module-free transports.
    expect(html).toContain('value="http-ui"');
    expect(html).toContain('value="telegram"');
    // The simple-add transport <select> never offers a literal vault transport —
    // vault-backed channels go through the dedicated "Link to a vault" form,
    // whose vault <select> is populated dynamically (no static value="vault").
    expect(html).not.toContain('value="vault"');
    // The vault-link flow is its own section now (modular-UI R2).
    expect(html).toContain("Link to a vault");
  });

  test("server-side mount appears in the visible chrome links (proxied)", () => {
    const html = renderAdminPage("/channel");
    // Footer "live config" link is built from the server-side mount.
    expect(html).toContain('href="/channel/.parachute/config"');
    // The bootstrap fallback API URL is the JSON-encoded mounted path.
    expect(html).toContain('"/channel/api/channels"');
  });

  test("empty server-side mount → bare-root links (direct loopback)", () => {
    const html = renderAdminPage("");
    expect(html).toContain('href="/.parachute/config"');
    expect(html).toContain('"/api/channels"');
  });

  test("inline script carries runtime mount detection", () => {
    const html = renderAdminPage("");
    // Strips the trailing /admin to recover the public mount at runtime, so the
    // page works at /admin (direct) AND /channel/admin (proxied) regardless of
    // how the daemon was launched.
    expect(html).toContain("window.location.pathname");
    expect(html).toContain('"/admin"');
    expect(html).toContain("window.__CHANNEL_MOUNT__");
    expect(html).toContain("window.__CHANNEL_API_URL__");
  });

  test("add-form targets /api/channels and the page lists channels there", () => {
    const html = renderAdminPage("");
    // The page-script POSTs/GETs/DELETEs against API_URL (= <mount>/api/channels).
    expect(html).toContain("var API_URL");
    expect(html).toContain('/api/channels');
    // Remove uses DELETE.
    expect(html).toContain('method: "DELETE"');
    expect(html).toContain('method: "POST"');
  });

  test("obtains a channel:admin Bearer from the hub's cookie-gated mint", () => {
    const html = renderAdminPage("");
    // Mirrors the chat UI's fetchToken(): GET <origin>/admin/channel-token with
    // credentials so the hub mints from the operator's session cookie.
    expect(html).toContain("/admin/channel-token");
    expect(html).toContain('credentials: "include"');
    expect(html).toContain("Bearer ");
  });

  test("surfaces a no-auth banner pointing at the hub", () => {
    const html = renderAdminPage("");
    expect(html).toContain("channel:admin");
    expect(html).toContain("Parachute hub portal");
  });

  test("renders the same HTML for a given mount (pure function)", () => {
    expect(renderAdminPage("/channel")).toBe(renderAdminPage("/channel"));
    expect(renderAdminPage("")).toBe(renderAdminPage(""));
  });
});

describe("link-to-vault flow (modular-UI R2)", () => {
  test("renders a dedicated Link-to-a-vault section with a vault picker + channel name", () => {
    const html = renderAdminPage("");
    expect(html).toContain('id="link-vault-section"');
    expect(html).toContain('id="link-form"');
    expect(html).toContain('id="f-vault"');
    expect(html).toContain('id="f-link-name"');
    expect(html).toContain('id="link-btn"');
    // The approval framing is explicit: clicking the button is the approval.
    expect(html).toContain("clicking the button is your approval");
  });

  test("loads the vault list from the hub's public discovery doc (same-origin)", () => {
    const html = renderAdminPage("");
    expect(html).toContain("function loadVaults");
    expect(html).toContain("/.well-known/parachute.json");
  });

  test("submit POSTs the canonical vault-backed-channel body to the hub's Connections engine", () => {
    const html = renderAdminPage("");
    // POSTs to the HUB origin's /admin/connections (NOT a channel path).
    expect(html).toContain('window.location.origin + "/admin/connections"');
    // Same-origin cookie flows because the page is proxied under /channel.
    expect(html).toContain('credentials: "include"');
    // Provenance labels the connection module-initiated.
    expect(html).toContain('requestedBy: "channel"');
    // The canonical source/sink: vault.note.created (inbound tag) → channel.message.deliver.
    expect(html).toContain('event: "note.created"');
    expect(html).toContain("#channel-message/inbound");
    expect(html).toContain('action: "message.deliver"');
    // The chosen channel name rides as the sink action param.
    expect(html).toContain("params: { channel: name }");
  });

  test("renders the connect-a-session lines the hub returns on success", () => {
    const html = renderAdminPage("");
    expect(html).toContain("function renderConnectResult");
    expect(html).toContain("payload.connect");
    expect(html).toContain('id="link-result"');
  });

  test("surfaces a clear actionable message on a 401 from the hub", () => {
    const html = renderAdminPage("");
    // The link handler distinguishes 401 (not signed in to the hub) from other
    // failures with a specific, actionable banner.
    expect(html).toContain("Not signed in to the hub");
  });
});

describe("add-channel affordance (the unusable-add fix)", () => {
  test("disables + relabels the Add button when there is no channel:admin token", () => {
    const html = renderAdminPage("");
    // The add-form is reflected as authed/not-authed so the operator never sees
    // an Add button that silently 401s — the core of the 'no way to add' fix.
    expect(html).toContain("function setAddFormAuthState");
    expect(html).toContain("Sign in to the hub to add");
    // It's driven off the channel-list load resolving (authed) or 401 (not).
    expect(html).toContain("setAddFormAuthState(true)");
    expect(html).toContain("setAddFormAuthState(false)");
  });
});

describe("escape hardening (channel#37)", () => {
  test("escapeHtml neutralizes the five HTML metacharacters", () => {
    expect(escapeHtml(`<script>alert("x&y")</script>'`)).toBe(
      "&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;&#39;",
    );
  });

  test("the footer configUrl interpolation is escaped, not raw", () => {
    // A mount carrying HTML metacharacters must render escaped in BOTH the href
    // attribute and the link text of the footer "live config" link — so it can
    // never break out into markup at that interpolation site (channel#37).
    const html = renderAdminPage('"><img src=x onerror=alert(1)>');
    // Isolate the footer link the interpolation builds. Slice from "Live config"
    // to the FIRST `</a>` AFTER it (the page now has earlier anchors, e.g. the
    // add-section's "Link to a vault" jump link), so the window is the footer.
    const liveStart = html.indexOf("Live config");
    const footer = html.slice(liveStart, html.indexOf("</a>", liveStart) + 4);
    // The raw markup-breakout never appears in the footer link.
    expect(footer).not.toContain("<img src=x onerror=alert(1)>");
    expect(footer).not.toContain('"><img');
    // The escaped form is what lands instead, in both href and text.
    expect(footer).toContain(escapeHtml('"><img src=x onerror=alert(1)>/.parachute/config'));
  });

  test("a normal mount still renders a clean, working footer link", () => {
    const html = renderAdminPage("/channel");
    expect(html).toContain('href="/channel/.parachute/config"');
  });

  test("the remove-confirm interpolates the channel name through escapeHtml", () => {
    // The confirm() string is built from the channel name (a runtime value); the
    // page-script must route it through escapeHtml so a name with HTML
    // metacharacters renders escaped rather than as a latent sink.
    const html = renderAdminPage("");
    expect(html).toContain('window.confirm("Remove channel \\"" + escapeHtml(name) + "\\"?');
  });
});

describe("module.json — modular-UI (P4) declaration", () => {
  // The manifest sits at <repo>/.parachute/module.json; this test file is in
  // <repo>/src, so go up one.
  const manifestPath = join(import.meta.dir, "..", ".parachute", "module.json");

  test("parses as JSON and carries the new fields", async () => {
    const raw = await Bun.file(manifestPath).text();
    const m = JSON.parse(raw) as Record<string, unknown>;
    expect(m.configUiUrl).toBe("/channel/admin");
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
    expect(deliver?.scope).toBe("channel:send");
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
    // channel.message.deliver, labeled module-initiated.
    expect(tmpl?.requestedBy).toBe("channel");
    expect(tmpl?.source?.module).toBe("vault");
    expect(tmpl?.source?.event).toBe("note.created");
    expect(tmpl?.source?.filter?.tags).toContain("#channel-message/inbound");
    expect(tmpl?.sink?.module).toBe("channel");
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

  test("preserves the existing manifest contract (name, port, scopes)", async () => {
    const m = JSON.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>;
    expect(m.name).toBe("channel");
    expect(m.port).toBe(1941);
    expect(m.uiUrl).toBe("/channel/ui");
    const scopes = m.scopes as { defines?: string[] } | undefined;
    expect(scopes?.defines).toContain("channel:admin");
  });
});
