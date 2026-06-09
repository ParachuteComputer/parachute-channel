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
    // ONE unified add-form, single transport <select>, with vault as a first-
    // class option alongside telegram + http-ui (Aaron: vault is just another
    // transport option, not a separate section).
    expect(html).toContain('value="vault"');
    expect(html).toContain('value="telegram"');
    expect(html).toContain('value="http-ui"');
    // http-ui is de-emphasized as the testing / backup transport.
    expect(html).toContain("for testing / backup");
  });

  test("vault is the default-selected transport (the expected choice)", () => {
    const html = renderAdminPage("");
    // The vault <option> carries `selected` — vault leads the list and is the
    // default, matching its primary/expected role.
    expect(html).toContain('<option value="vault" selected>');
    // The separate "Link to a vault" SECTION is gone — unified into the add-form.
    expect(html).not.toContain('id="link-vault-section"');
    expect(html).not.toContain('id="link-form"');
    expect(html).not.toContain('id="link-btn"');
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

describe("unified transport select drives fields + submit path", () => {
  test("the vault transport reveals a vault picker inside the one add-form", () => {
    const html = renderAdminPage("");
    // The vault picker is a (hidden-by-default) field IN the add-form, revealed
    // when the vault transport is selected — not a separate section.
    expect(html).toContain('id="field-vault"');
    expect(html).toContain('id="f-vault"');
    // The telegram transport reveals a per-channel bot-token field.
    expect(html).toContain('id="field-telegram-token"');
    expect(html).toContain('id="f-telegram-token"');
    // applyTransportUI is what shows/hides the per-transport fields.
    expect(html).toContain("function applyTransportUI");
    expect(html).toContain('addEventListener("change", applyTransportUI)');
  });

  test("the vault submit path POSTs the canonical connection body to the hub", () => {
    const html = renderAdminPage("");
    // Selecting vault routes addChannel → addVaultChannel → the hub flow.
    expect(html).toContain('if (transport === "vault") { return addVaultChannel(name); }');
    expect(html).toContain("function addVaultChannel");
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
    // The chosen channel name (the shared #f-name input) rides as the sink param.
    expect(html).toContain("params: { channel: name }");
    // The approval framing is explicit: clicking Add is the approval.
    expect(html).toContain("is your approval");
  });

  test("the telegram submit path REQUIRES a per-channel bot token in config.token", () => {
    const html = renderAdminPage("");
    // The telegram path reads the bot-token field; a blank token is now a hard
    // error (no env fallback), so submit is blocked with a field error.
    expect(html).toContain('el("f-telegram-token").value');
    expect(html).toContain("config = { token: tgToken }");
    expect(html).toContain('setFieldError("f-telegram-token"');
    // The POST body carries config when present.
    expect(html).toContain("if (config) postBody.config = config;");
    expect(html).toContain('method: "POST"');
  });

  test("the http-ui transport posts just name + transport (no config)", () => {
    const html = renderAdminPage("");
    // The base POST body is name + transport; config is only attached for telegram.
    expect(html).toContain("var postBody = { name: name, transport: transport };");
  });

  test("loads the vault list from the hub's public discovery doc (same-origin)", () => {
    const html = renderAdminPage("");
    expect(html).toContain("function loadVaults");
    expect(html).toContain("/.well-known/parachute.json");
  });

  test("renders the connect-a-session lines the hub returns on success", () => {
    const html = renderAdminPage("");
    expect(html).toContain("function renderConnectResult");
    expect(html).toContain("payload.connect");
    expect(html).toContain('id="link-result"');
  });

  test("surfaces a clear actionable message on a 401 from the hub", () => {
    const html = renderAdminPage("");
    // The vault submit handler distinguishes 401 (not signed in to the hub) from
    // other failures with a specific, actionable banner.
    expect(html).toContain("Not signed in to the hub");
  });
});

describe("telegram per-channel config copy (Aaron's feedback)", () => {
  test("the misleading 'no extra config / uses the daemon TELEGRAM_BOT_TOKEN' hint is gone", () => {
    const html = renderAdminPage("");
    // The old static hint claimed telegram needs no config and shares one daemon
    // token. That's wrong now — each channel can carry its own bot token.
    expect(html).not.toContain("No extra config needed");
  });

  test("the telegram bot-token field explains the REQUIRED per-channel token", () => {
    const html = renderAdminPage("");
    expect(html).toContain("Bot token");
    // Accurate copy: each telegram channel carries its OWN token; required.
    expect(html).toContain("each telegram channel carries its");
    expect(html).toContain("Required");
    // The misleading env-fallback claim is gone — the daemon no longer reads
    // a global TELEGRAM_BOT_TOKEN, so the field hint must not advertise one.
    expect(html).not.toContain("env is used as a fallback");
    // The field is a password input (sensitive) and never echoed back.
    expect(html).toContain('id="f-telegram-token"');
    expect(html).toContain('type="password"');
  });

  test("per-transport fields hide via .field[hidden] (CSS specificity fix)", () => {
    const html = renderAdminPage("");
    // .field declares display:flex, which outranks the UA [hidden] rule — so the
    // hidden attribute alone wouldn't hide the telegram token field on the
    // default (vault) selection. This rule re-asserts the hide at matching
    // specificity. Without it, the bot-token field shows when telegram isn't
    // selected (Aaron's bug 1).
    expect(html).toContain(".field[hidden] { display: none; }");
  });

  test("applyTransportUI gates the bot-token's HTML5 required on visibility", () => {
    const html = renderAdminPage("");
    // A hidden-but-required field blocks submit; only require it while shown.
    expect(html).toContain('tgInput.required = transport === "telegram"');
  });
});

describe("add-channel affordance (the unusable-add fix)", () => {
  test("disables + relabels the Add button when there is no channel:admin token", () => {
    const html = renderAdminPage("");
    // The add-form is reflected as authed/not-authed so the operator never sees
    // an Add button that silently 401s — the core of the 'no way to add' fix.
    // For telegram/http-ui, applyTransportUI gates the button on __authed.
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
