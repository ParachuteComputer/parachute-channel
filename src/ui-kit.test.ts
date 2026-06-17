/**
 * Unit tests for the shared UI kit (src/ui-kit.ts) — the foundation every
 * channel page adopts. Guards the shell contract (active-tab marking, controls
 * slot, nav set) + the token/CSS invariants the pages depend on.
 */
import { describe, test, expect } from "bun:test";
import { THEME_CSS, SHELL_JS, appShell, NAV_VIEWS, BRAND } from "./ui-kit.ts";

describe("appShell", () => {
  test("renders the brand + all nav tabs, marking only the active one", () => {
    const h = appShell({ active: "agents" });
    expect(h).toContain("app-header");
    expect(h).toContain('class="brand-mark"');
    for (const v of NAV_VIEWS) expect(h).toContain(`data-view="${v.view}"`);
    // active tab gets class="active"; others don't.
    expect(h).toContain('data-view="agents" href="#" class="active"');
    expect(h).toContain('data-view="chat" href="#"');
    expect(h).not.toContain('data-view="chat" href="#" class="active"');
  });

  test("marks Home active when it is the current view", () => {
    const h = appShell({ active: "home" });
    expect(h).toContain('data-view="home" href="#" class="active"');
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

  test("nav covers exactly home/chat/agents/schedules/terminal/config, Home first", () => {
    expect(NAV_VIEWS.map((v) => v.view)).toEqual([
      "home",
      "chat",
      "agents",
      "schedules",
      "terminal",
      "config",
    ]);
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
    for (const sym of ["var MOUNT", "function wireShell", "function escapeHtml", "function setStatus", "function fetchToken", "function authedFetch", "function setTerminalNavVisible"]) {
      expect(SHELL_JS).toContain(sym);
    }
    // It hits the hub agent-token endpoint with the operator cookie.
    expect(SHELL_JS).toContain("/admin/agent-token");
    expect(SHELL_JS).toContain('credentials: "include"');
  });

  // Terminal-nav cleanup (Parachute Agent Phase 1): wireShell hides the standalone
  // Terminal nav entry by default (programmatic backend has no terminal); pages
  // reveal it via setTerminalNavVisible when an interactive agent exists. The
  // Terminal page itself (active === "terminal") shows it.
  test("wireShell gates the Terminal nav link via setTerminalNavVisible", () => {
    expect(SHELL_JS).toContain('a[data-view="terminal"]');
    // wireShell defaults the terminal entry to its own-page-only visibility.
    expect(SHELL_JS).toContain('setTerminalNavVisible(active === "terminal")');
  });
  test("is safe to interpolate — no naked backtick that could break a host literal", () => {
    expect(SHELL_JS.includes("`")).toBe(false);
  });
  test("exports a renderMarkdown helper (reused by the chat transcript)", () => {
    expect(SHELL_JS).toContain("function renderMarkdown");
  });
});

// renderMarkdown lives inside SHELL_JS (vanilla JS, no DOM). Evaluate SHELL_JS in
// a fresh function scope and hand back its renderMarkdown so we can exercise it
// directly — the same code the chat page runs in the browser.
function loadRenderMarkdown(): (text: string) => string {
  // SHELL_JS defines `var MOUNT = window.location...` at the top; stub a minimal
  // window so that line doesn't throw when evaluated outside a browser.
  const factory = new Function(
    "window",
    SHELL_JS + "\nreturn renderMarkdown;",
  ) as (w: unknown) => (text: string) => string;
  return factory({ location: { pathname: "/ui" } });
}

describe("renderMarkdown (SHELL_JS, XSS-safe Markdown subset)", () => {
  const renderMarkdown = loadRenderMarkdown();

  test("escapes raw HTML first — a <script> tag never survives as markup", () => {
    const out = renderMarkdown("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("renders bold and italic", () => {
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("an *italic* word")).toContain("<em>italic</em>");
  });

  test("renders inline code and fenced code blocks", () => {
    const bt = String.fromCharCode(96);
    expect(renderMarkdown(bt + "inline" + bt)).toContain("<code>inline</code>");
    const fenced = renderMarkdown(bt + bt + bt + "\nconst x = 1;\n" + bt + bt + bt);
    expect(fenced).toContain("<pre><code>");
    expect(fenced).toContain("const x = 1;");
  });

  test("does not apply inline rules inside code spans", () => {
    const bt = String.fromCharCode(96);
    const out = renderMarkdown(bt + "**not bold**" + bt);
    expect(out).toContain("<code>**not bold**</code>");
    expect(out).not.toContain("<strong>");
  });

  test("renders http/https links as anchors with the url preserved", () => {
    const out = renderMarkdown("[site](https://example.com/x)");
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain(">site</a>");
    expect(out).toContain('rel="noopener noreferrer"');
  });

  test("rejects javascript: URLs — renders inert escaped text, no anchor", () => {
    const out = renderMarkdown("[click](javascript:alert(1))");
    // No anchor and no href is produced — the would-be URL never reaches markup.
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("href=");
    // The markdown is left as inert escaped text (safe — not an executable link).
    expect(out).toContain("[click]");
  });

  test("rejects data: URLs too — only http/https survive as anchors", () => {
    const out = renderMarkdown("[x](data:text/html,<script>alert(1)</script>)");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("href=");
    // any escaped markup inside is inert text, never executable.
    expect(out).not.toContain("<script>");
  });

  test("escapes other canonical XSS vectors (img onerror, svg onload)", () => {
    const out1 = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(out1).not.toContain("<img");
    expect(out1).toContain("&lt;img");
    const out2 = renderMarkdown('<svg onload=alert(1)>');
    expect(out2).not.toContain("<svg");
    expect(out2).toContain("&lt;svg");
  });

  test("converts newlines to <br>", () => {
    expect(renderMarkdown("line1\nline2")).toContain("line1<br>line2");
  });
});
