/**
 * Unit tests for the shared UI kit (src/ui-kit.ts) — the foundation every
 * channel page adopts. Guards the shell contract (active-tab marking, controls
 * slot, nav set) + the token/CSS invariants the pages depend on.
 */
import { describe, test, expect } from "bun:test";
import { THEME_CSS, SHELL_JS, appShell, NAV_VIEWS, BRAND } from "./ui-kit.ts";

describe("appShell", () => {
  test("renders the brand + all four nav tabs, marking only the active one", () => {
    const h = appShell({ active: "agents" });
    expect(h).toContain("app-header");
    expect(h).toContain('class="brand-mark"');
    for (const v of NAV_VIEWS) expect(h).toContain(`data-view="${v.view}"`);
    // active tab gets class="active"; others don't.
    expect(h).toContain('data-view="agents" href="#" class="active"');
    expect(h).toContain('data-view="chat" href="#"');
    expect(h).not.toContain('data-view="chat" href="#" class="active"');
  });

  test("status defaults, and a custom status + tag suffix render", () => {
    expect(appShell({ active: "chat" })).toContain('id="status"');
    const h = appShell({ active: "chat", status: "● ready", tag: "chat" });
    expect(h).toContain("● ready");
    expect(h).toContain("· chat");
  });

  test("controls slot is injected before the status when provided, omitted otherwise", () => {
    const withCtl = appShell({ active: "terminal", controls: "<button id='reconnect'>Reconnect</button>" });
    expect(withCtl).toContain("app-controls");
    expect(withCtl).toContain("id='reconnect'");
    expect(appShell({ active: "terminal" })).not.toContain("app-controls");
  });

  test("nav covers exactly chat/agents/terminal/config (no Home yet)", () => {
    expect(NAV_VIEWS.map((v) => v.view)).toEqual(["chat", "agents", "terminal", "config"]);
  });
});

describe("THEME_CSS", () => {
  test("declares the brand tokens incl. the warm-light bg, accent, warn, and dark term pane", () => {
    expect(THEME_CSS).toContain(":root");
    expect(THEME_CSS).toContain(`--bg: ${BRAND.bg}`); // #faf8f4, the warm light brand
    expect(THEME_CSS).toContain(`--accent: ${BRAND.accent}`);
    expect(THEME_CSS).toContain(`--warn: ${BRAND.warn}`);
    expect(THEME_CSS).toContain(`--term-bg: ${BRAND.termBg}`); // #000 — the only intended black
  });
  test("ships the shared component layer (shell + buttons + banners + pills)", () => {
    for (const sel of [".app-nav", ".app-nav a.active", ".btn-primary", ".banner-warn", ".pill.warn"]) {
      expect(THEME_CSS).toContain(sel);
    }
  });
  test("carries NO leftover dark-console tokens (the pages unified on the brand)", () => {
    expect(THEME_CSS).not.toContain("#0f1115");
    expect(THEME_CSS).not.toContain("--panel");
  });
});

describe("SHELL_JS", () => {
  test("provides MOUNT derivation, nav wiring, token fetch, and helpers", () => {
    for (const sym of ["var MOUNT", "function wireShell", "function escapeHtml", "function setStatus", "function fetchToken", "function authedFetch"]) {
      expect(SHELL_JS).toContain(sym);
    }
    // It hits the hub channel-token endpoint with the operator cookie.
    expect(SHELL_JS).toContain("/admin/channel-token");
    expect(SHELL_JS).toContain('credentials: "include"');
  });
  test("is safe to interpolate — no naked backtick that could break a host literal", () => {
    expect(SHELL_JS.includes("`")).toBe(false);
  });
});
