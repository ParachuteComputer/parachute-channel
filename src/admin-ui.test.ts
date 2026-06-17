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
    // The daemon-transport submit goes through the SHARED provisioning client
    // (ChannelProvision.provisionDaemonChannel — src/provision-channel.ts), which
    // attaches config when present. The page hands it the assembled config.
    expect(html).toContain("ChannelProvision.provisionDaemonChannel");
    // provisionDaemonChannel builds the POST body (name + transport + optional
    // config) internally; the shared client carries config only when given.
    expect(html).toContain("if (opts.config) postBody.config = opts.config;");
    expect(html).toContain('method: "POST"');
  });

  test("the http-ui transport posts just name + transport (no config)", () => {
    const html = renderAdminPage("");
    // The shared provisioning client's base POST body is name + transport; config
    // is only attached when the caller supplies it (telegram). http-ui passes no
    // config, so the body stays name + transport.
    expect(html).toContain("var postBody = { name: opts.name, transport: opts.transport };");
  });

  test("loads the vault list from the hub's public discovery doc (same-origin)", () => {
    const html = renderAdminPage("");
    // loadVaults delegates the fetch to the shared ChannelProvision.listVaults,
    // which reads the hub's public discovery doc.
    expect(html).toContain("function loadVaults");
    expect(html).toContain("ChannelProvision.listVaults");
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

  test("reveals the Terminal nav if an interactive agent exists (no stranding)", () => {
    const html = renderAdminPage("");
    // The config page hides the standalone Terminal entry by default (Phase-1 nav
    // cleanup) but doesn't list agents — so it calls the shared reveal helper to
    // avoid stranding an operator who has a live interactive session.
    expect(html).toContain("revealTerminalNavIfInteractive()");
  });

  test("preserves the 400-vs-other add-channel banner distinction", () => {
    const html = renderAdminPage("");
    // Even after routing through the shared provisioning client, a request
    // rejection (400) keeps its distinct copy from an infrastructure failure.
    expect(html).toContain("Could not add channel");
    expect(html).toContain("Add failed");
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

describe("vault-backed delete composes hub connection teardown (boundary C2)", () => {
  // Lifecycle symmetry (hub-module-boundary charter; migration Phase C2):
  // deleting a vault-backed channel must cascade the hub-side identity
  // artifacts the link flow provisioned — the registered vault trigger + the
  // long-lived minted tokens, both held on the hub connection record. The page
  // composes hub teardown FIRST, then the daemon mechanics. Same string-pin
  // harness as the rest of this file: assert the served page-script's shape.
  const html = renderAdminPage("");

  test("remove branches on transport: vault routes through the composed teardown", () => {
    expect(html).toContain(
      'if (channel && channel.transport === "vault") { removeVaultChannel(name, btn); return; }',
    );
    expect(html).toContain("function removeVaultChannel");
    // The row's Remove button hands over the whole channel record (the list
    // payload carries name + transport + vault), so the branch can see the
    // transport.
    expect(html).toContain("removeChannel(c, rm)");
  });

  test("drives connections-list → connections-DELETE → daemon-DELETE, in that order", () => {
    // (a) The list read lives in removeVaultChannel: cookie-gated, same-origin
    // (credentials:"include" — the same-origin fetch carries a matching Origin
    // header, so the hub's C1 CSRF belt passes automatically).
    const vaultFn = html.slice(
      html.indexOf("function removeVaultChannel"),
      html.indexOf("function teardownConnections"),
    );
    expect(vaultFn).toContain('window.location.origin + "/admin/connections"');
    expect(vaultFn).toContain('credentials: "include"');
    // The hub teardown gates the daemon mechanics: finishMechanics only runs
    // from teardownConnections' completion callback (or the no-record branch).
    expect(vaultFn).toContain("teardownConnections(matches, 0, [], function (failedDetail, warnings)");
    expect(vaultFn).toContain("finishMechanics(name, btn, { tornDown: matches, warnings: warnings })");
    // (b) The item DELETE lives in teardownConnections, credentials included.
    const tdFn = html.slice(
      html.indexOf("function teardownConnections"),
      html.indexOf("function askProceedMechanicsOnly"),
    );
    expect(tdFn).toContain('window.location.origin + "/admin/connections/" + encodeURIComponent(rec.id)');
    expect(tdFn).toContain('method: "DELETE"');
    expect(tdFn).toContain('credentials: "include"');
    // (c) The daemon mechanics run in finishMechanics, AFTER the hub side —
    // through the same DELETE /api/channels path as before (channel:admin
    // Bearer), tolerating already-gone (the hub's channel-sink step may have
    // removed the entry first).
    const fmFn = html.slice(
      html.indexOf("function finishMechanics"),
      html.indexOf("document.addEventListener"),
    );
    expect(fmFn).toContain("deleteChannelConfig(name, { treat404AsGone: true })");
  });

  test("identifies the channel's record by its sink, with the hub's id fallback", () => {
    // Match: sink.module === "channel" && sink.params.channel === name; when
    // params.channel is absent, fall back to record-id-as-channel-name — the
    // exact fallback the hub's own teardownConnection applies, so the page
    // tears down precisely what the hub would.
    expect(html).toContain("function connectionMatchesChannel");
    expect(html).toContain('c.sink.module !== "channel"');
    expect(html).toContain("p.channel === name");
    expect(html).toContain("return c.id === name");
  });

  test("hub-teardown failure surfaces the explicit two-step state (no silent fallthrough)", () => {
    expect(html).toContain("function askProceedMechanicsOnly");
    // The ask is an explicit confirm with both outcomes spelled out…
    expect(html).toContain("OK = remove config only. Cancel = keep the channel.");
    // …Cancel keeps the channel and says so…
    expect(html).toContain("Removal cancelled.");
    expect(html).toContain("was left intact.");
    // …OK marks the state so the final banner says the hub side did NOT run.
    expect(html).toContain("finishMechanics(name, btn, { hubFailed: detail, warnings: [] })");
    expect(html).toContain("hub teardown did NOT run.");
    // Every hub-side failure routes through the ask: list 401 / list non-OK /
    // list parse failure / network error, and a per-connection DELETE failure.
    expect(html).toContain("not signed in to the hub (the connections list returned 401)");
    expect(html).toContain('"the hub connections list returned HTTP " + res.status');
    expect(html).toContain("could not parse the hub connections list");
    expect(html).toContain("network error reaching the hub: ");
    expect(html).toContain(
      "if (failedDetail !== null) { askProceedMechanicsOnly(name, btn, failedDetail); return; }",
    );
    // The ask's confirm routes its runtime values through escapeHtml — one
    // escaping discipline page-wide, matching the first remove confirm.
    expect(html).toContain(
      '"Hub teardown failed for channel \\"" + escapeHtml(name) + "\\":\\n" + escapeHtml(detail) +',
    );
  });

  test("daemon 401 after hub teardown keeps the partial-state context", () => {
    // If the daemon DELETE 401s AFTER the hub teardown already ran, the page
    // must not show only the generic no-auth banner — the operator is in a
    // partially-torn-down state (hub side done, channel entry still on disk)
    // and needs to know that, plus the remediation: sign in, retry the remove.
    const fmFn = html.slice(
      html.indexOf("function finishMechanics"),
      html.indexOf("document.addEventListener"),
    );
    expect(fmFn).toContain("if (state.tornDown && state.tornDown.length)");
    expect(fmFn).toContain("The hub connection teardown already completed");
    expect(fmFn).toContain("The channel entry remains");
    expect(fmFn).toContain("and retry the remove.");
    // The plain 401 with no hub context still gets the generic banner.
    expect(fmFn).toContain("noAuthBanner()");
  });

  test("legacy vault channel with no hub record: mechanics-only + informational note", () => {
    // No record found (linked pre-Connections-era, or via the legacy
    // /admin/channels path) → proceed with the daemon delete and show the
    // manual-cleanup note instead of pretending a full teardown happened.
    expect(html).toContain("finishMechanics(name, btn, { legacyNote: true, warnings: [] })");
    expect(html).toContain("No hub connection record was found");
    // Era-relative phrasing ("before the Connections engine existed"), not a
    // calendar date — it ages better (reviewer nit on #46).
    expect(html).toContain("the Connections engine existed");
    expect(html).toContain("hub admin");
    // Accurate cross-reference: the hub's DELETE /vaults cascade scans
    // channel's list and reports such channels as orphaned_channels.
    expect(html).toContain("orphaned_channels");
  });

  test("non-vault delete keeps the simple daemon-only path", () => {
    // The non-vault branch goes straight to the daemon mechanics — no
    // treat404AsGone, no hub calls — with the same success banner as before.
    expect(html).toContain("deleteChannelConfig(name, {}).then(function (out)");
    expect(html).toContain("</code> is gone.");
    // The daemon DELETE still targets <mount>/api/channels/<name> with the
    // channel:admin Bearer (authHeaders), exactly as today.
    expect(html).toContain('API_URL + "/" + encodeURIComponent(name)');
    expect(html).toContain("headers: authHeaders()");
  });

  test("hub partial teardown (207) and legacy-mint records surface as warnings, not failures", () => {
    // A 207 from the hub = record removed, some steps failed — carried into
    // the final banner as notes; rec.legacy = pre-B0 unregistered mints that
    // ride to expiry, surfaced honestly rather than claiming revocation.
    expect(html).toContain("payload.partial && Array.isArray(payload.errors)");
    expect(html).toContain("Partial-teardown notes: ");
    expect(html).toContain("ride to their original expiry");
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
    expect(m.uiUrl).toBe("/channel/home");
    const scopes = m.scopes as { defines?: string[] } | undefined;
    expect(scopes?.defines).toContain("channel:admin");
  });
});
