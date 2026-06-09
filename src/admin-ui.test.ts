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
import { renderAdminPage } from "./admin-ui.ts";

describe("renderAdminPage", () => {
  test("renders the channel config chrome", () => {
    const html = renderAdminPage("");
    expect(html).toContain("<title>Channel — Configuration</title>");
    expect(html).toContain("Manage channels");
    // The add-form offers ONLY the two cross-module-free transports.
    expect(html).toContain('value="http-ui"');
    expect(html).toContain('value="telegram"');
    // Vault-backed channels are explicitly NOT creatable here.
    expect(html).not.toContain('value="vault"');
    expect(html).toContain("hub's Connections view");
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

  test("preserves the existing manifest contract (name, port, scopes)", async () => {
    const m = JSON.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>;
    expect(m.name).toBe("channel");
    expect(m.port).toBe(1941);
    expect(m.uiUrl).toBe("/channel/ui");
    const scopes = m.scopes as { defines?: string[] } | undefined;
    expect(scopes?.defines).toContain("channel:admin");
  });
});
