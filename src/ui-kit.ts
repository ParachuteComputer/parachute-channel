/**
 * Shared UI kit for the agent module's web pages (chat, agents, terminal,
 * config). ONE source of truth for the look + the app shell, so the four pages
 * read as one app instead of four hand-rolled surfaces.
 *
 * Why this exists: every page used to re-implement its own theme, header, nav,
 * buttons, MOUNT derivation, and token fetch. That guaranteed drift (a light
 * admin page vs three dark ones; a nav on some pages, a dead-end on others).
 * This module is the fix at the root — adopt it on every page and the surfaces
 * can't diverge.
 *
 * The look is the canonical Parachute brand (warm/light, teal accent, serif
 * headlines) — consistent with the hub portal, brain, and surfaces. The ONE
 * exception is the terminal CONTENT pane, which stays black like any terminal
 * (`--term-bg`); only the chrome around it is brand-light.
 *
 * Three exports:
 *   - THEME_CSS  — the full stylesheet (tokens + base + shell + components).
 *   - appShell() — the shared <header> markup (brand + nav tabs + status slot).
 *   - SHELL_JS   — shared client JS (MOUNT, nav wiring, token fetch, helpers).
 *
 * Pages drop `<style>${THEME_CSS}</style>` + `${appShell({active})}` +
 * `<script>${SHELL_JS} ...page JS...</script>` and add only their page-specific
 * styles/markup/logic on top.
 */

/** The Parachute brand palette + fonts, promoted from the original admin page. */
export const BRAND = {
  bg: "#faf8f4",
  bgSoft: "#f3f0ea",
  fg: "#2c2a26",
  fgMuted: "#6b6860",
  fgDim: "#9a9690",
  accent: "#4cc2a0",
  accentHover: "#3da689",
  accentSoft: "rgba(76, 194, 160, 0.10)",
  border: "#e4e0d8",
  borderLight: "#ece9e2",
  card: "#ffffff",
  danger: "#a3392b",
  dangerSoft: "rgba(163, 57, 43, 0.08)",
  success: "#3d6849",
  successSoft: "rgba(61, 104, 73, 0.08)",
  // A warm amber for warnings (distinct from danger-red and accent-teal) — fits
  // the warm-light palette. Used for "needs attention" states (e.g. no credential
  // set yet, a permission prompt) that aren't errors.
  warn: "#8a6d1b",
  warnSoft: "rgba(184, 134, 11, 0.12)",
  // The terminal content pane stays dark — a terminal is black everywhere.
  termBg: "#000000",
  termFg: "#e6e9ef",
  fontSans: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`,
  fontSerif: `Georgia, "Times New Roman", serif`,
  fontMono: `ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace`,
} as const;

/** The navigable views, in nav order. Home is the default landing (Phase 2). */
export const NAV_VIEWS = [
  { view: "home", label: "Home", path: "/home" },
  { view: "chat", label: "Chat", path: "/ui" },
  { view: "agents", label: "Agents", path: "/agents" },
  { view: "schedules", label: "Schedules", path: "/jobs" },
  { view: "terminal", label: "Terminal", path: "/terminal" },
  { view: "config", label: "Config", path: "/admin" },
] as const;

export type ShellView = (typeof NAV_VIEWS)[number]["view"];

/**
 * The shared stylesheet: CSS custom properties (the brand tokens) + base
 * element styles + the app-shell header/nav + the component layer (buttons,
 * cards, banners, inputs, fields, pills, sections). Every page includes this
 * verbatim and layers only page-specific rules on top.
 */
export const THEME_CSS = `
  :root {
    --bg: ${BRAND.bg};
    --bg-soft: ${BRAND.bgSoft};
    --fg: ${BRAND.fg};
    --fg-muted: ${BRAND.fgMuted};
    --fg-dim: ${BRAND.fgDim};
    --accent: ${BRAND.accent};
    --accent-hover: ${BRAND.accentHover};
    --accent-soft: ${BRAND.accentSoft};
    --border: ${BRAND.border};
    --border-light: ${BRAND.borderLight};
    --card: ${BRAND.card};
    --danger: ${BRAND.danger};
    --danger-soft: ${BRAND.dangerSoft};
    --success: ${BRAND.success};
    --success-soft: ${BRAND.successSoft};
    --warn: ${BRAND.warn};
    --warn-soft: ${BRAND.warnSoft};
    --term-bg: ${BRAND.termBg};
    --term-fg: ${BRAND.termFg};
    --font-sans: ${BRAND.fontSans};
    --font-serif: ${BRAND.fontSerif};
    --font-mono: ${BRAND.fontMono};
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: var(--font-sans);
    background: var(--bg);
    color: var(--fg);
    line-height: 1.55;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { color: var(--accent-hover); text-decoration: underline; }
  code, pre { font-family: var(--font-mono); }

  /* ---- App shell: the shared top bar on every page ------------------------ */
  .app-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.6rem 1.1rem;
    background: var(--card);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .app-brand { display: inline-flex; align-items: center; gap: 0.5rem; flex: 0 0 auto; }
  .brand-mark {
    display: inline-flex; align-items: center; justify-content: center;
    width: 1.5rem; height: 1.5rem; border-radius: 50%;
    background: var(--accent); color: var(--card);
    font-weight: 600; font-size: 0.85rem; line-height: 1;
  }
  .brand-name { font-weight: 600; letter-spacing: 0.01em; color: var(--fg); }
  .brand-name small { color: var(--fg-dim); font-weight: 400; }
  .app-nav { display: flex; align-items: center; gap: 0.15rem; flex-wrap: wrap; }
  .app-nav a {
    color: var(--fg-muted);
    text-decoration: none;
    font-size: 0.9rem;
    padding: 0.3rem 0.6rem;
    border-radius: 6px;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .app-nav a:hover { background: var(--bg-soft); color: var(--fg); text-decoration: none; }
  .app-nav a.active { background: var(--accent-soft); color: var(--accent-hover); font-weight: 600; }
  .app-controls { display: inline-flex; align-items: center; gap: 0.5rem; flex: 0 0 auto; }
  .app-status { font-size: 0.8rem; color: var(--fg-dim); flex: 0 0 auto; }
  .app-status.live { color: var(--accent-hover); }
  .app-status.err { color: var(--danger); }
  .spacer { flex: 1 1 auto; }

  /* ---- Buttons ----------------------------------------------------------- */
  .btn {
    font: inherit;
    font-weight: 500;
    padding: 0.5rem 0.9rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--fg);
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  }
  .btn:hover { border-color: var(--fg-dim); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: #06140f; font-weight: 600; }
  .btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn-secondary { background: var(--bg-soft); }
  .btn-danger { color: var(--danger); border-color: var(--border); background: transparent; }
  .btn-danger:hover { background: var(--danger-soft); border-color: var(--danger); }
  .btn-ghost { background: transparent; border-color: transparent; color: var(--fg-muted); }
  .btn-ghost:hover { background: var(--bg-soft); color: var(--fg); }
  .btn-sm { font-size: 0.8rem; padding: 0.3rem 0.7rem; }

  /* ---- Cards / sections -------------------------------------------------- */
  .card-surface {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.5rem 1.5rem;
    box-shadow: 0 1px 2px rgba(44,42,38,0.04), 0 8px 24px rgba(44,42,38,0.06);
  }
  h1 { font-family: var(--font-serif); font-weight: 400; font-size: 1.6rem; line-height: 1.2; margin: 0 0 0.4rem; color: var(--fg); }
  h2, .section-title { font-family: var(--font-serif); font-weight: 400; font-size: 1.2rem; margin: 0; color: var(--fg); }
  .subtitle, .muted { margin: 0; color: var(--fg-muted); font-size: 0.95rem; }
  .dim { color: var(--fg-dim); }

  /* ---- Banners / notices ------------------------------------------------- */
  .banner {
    margin: 0 0 1rem;
    padding: 0.75rem 0.9rem;
    border-radius: 6px;
    font-size: 0.9rem;
    border: 1px solid transparent;
  }
  .banner-error, .banner-err { background: var(--danger-soft); border-color: var(--danger); color: var(--danger); }
  .banner-success, .banner-ok { background: var(--success-soft); border-color: var(--success); color: var(--success); }
  .banner-warn { background: var(--warn-soft); border-color: var(--warn); color: var(--warn); }
  .banner code { font-family: var(--font-mono); font-size: 0.85em; background: rgba(255,255,255,0.5); padding: 0.05rem 0.3rem; border-radius: 3px; }

  /* ---- Inputs / fields --------------------------------------------------- */
  select, input[type=text], input[type=password], textarea {
    font: inherit;
    width: 100%;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--card);
    color: var(--fg);
  }
  select:focus, input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  .field { display: flex; flex-direction: column; gap: 0.3rem; }
  .field[hidden] { display: none; }
  .field-label { font-size: 0.85rem; font-weight: 500; color: var(--fg-muted); letter-spacing: 0.01em; }
  .field-hint { font-size: 0.8rem; color: var(--fg-dim); }
  .field-error { font-size: 0.8rem; color: var(--danger); font-weight: 500; }

  /* ---- Pills (status badges) -------------------------------------------- */
  .pill { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.78rem; padding: 0.1rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); color: var(--fg-muted); background: var(--bg-soft); }
  .pill.on, .pill.attached { color: var(--accent-hover); border-color: var(--accent); background: var(--accent-soft); }
  .pill.off { color: var(--fg-dim); }
  .pill.warn { color: var(--warn); border-color: var(--warn); background: var(--warn-soft); }
  .dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; display: inline-block; background: var(--fg-dim); }
  .dot.live { background: var(--accent); }

  /* ---- Generic page main ------------------------------------------------- */
  .page { max-width: 60rem; margin: 0 auto; padding: 1.5rem 1.25rem; }
`;

/**
 * Render the shared app-shell header. `active` highlights the current view;
 * `controls` is an optional HTML slot for page-specific header controls (the
 * terminal's agent picker + Reconnect, the chat/terminal channel select) placed
 * before the status. `status` seeds the status text (default "connecting…").
 * Nav hrefs are placeholders wired client-side by SHELL_JS (so they resolve
 * under the hub proxy mount). `tag` is an optional brand suffix (e.g. "agents").
 */
export function appShell(opts: { active: ShellView; controls?: string; status?: string; tag?: string }): string {
  const links = NAV_VIEWS.map((v) => {
    const cls = v.view === opts.active ? ' class="active"' : "";
    return `<a data-view="${v.view}" href="#"${cls}>${v.label}</a>`;
  }).join("");
  const tag = opts.tag ? ` <small>· ${opts.tag}</small>` : "";
  const controls = opts.controls ? `<span class="app-controls">${opts.controls}</span>` : "";
  const status = opts.status ?? "connecting…";
  return `<header class="app-header">
    <span class="app-brand"><span class="brand-mark">A</span><span class="brand-name">Agent${tag}</span></span>
    <nav class="app-nav">${links}</nav>
    <span class="spacer"></span>
    ${controls}
    <span id="status" class="app-status">${status}</span>
  </header>`;
}

/**
 * Shared client JS, injected into each page's <script> (interpolated as
 * `${SHELL_JS}` — its content, including any backticks, is inserted at runtime,
 * so it never collides with the host page's own template literal). Provides:
 *   - MOUNT      — the public path prefix (handles loopback + hub /agent proxy)
 *   - wireShell  — set nav hrefs from MOUNT + mark the active tab
 *   - escapeHtml — text/attribute-safe escape (mirrors the server-side one)
 *   - setStatus  — update the shared #status element
 *   - fetchToken / authedFetch — hub agent-token fetch with one 401 retry
 * Pages keep their own stream logic (SSE/WS) but reuse fetchToken for the token.
 */
export const SHELL_JS = `
  // Public mount prefix: "" on loopback, "/agent" behind the hub proxy.
  var MOUNT = window.location.pathname.replace(/\\/(home|ui|admin|agents|jobs|terminal)(\\/[^?]*)?\\/?$/, "");
  var NAV_MAP = { home: "/home", chat: "/ui", agents: "/agents", schedules: "/jobs", terminal: "/terminal", config: "/admin" };
  function wireShell(active) {
    var links = document.querySelectorAll(".app-nav a[data-view]");
    for (var i = 0; i < links.length; i++) {
      var v = links[i].getAttribute("data-view");
      if (NAV_MAP[v] != null) links[i].setAttribute("href", MOUNT + NAV_MAP[v]);
      if (v === active) links[i].classList.add("active");
      else links[i].classList.remove("active");
    }
    // Terminal-nav cleanup (Parachute Agent Phase 1): programmatic is the default
    // backend, which has no live terminal — so the standalone Terminal nav entry is
    // HIDDEN by default. It's only meaningful when an INTERACTIVE agent exists.
    // Pages that know the interactive-agent count call setTerminalNavVisible(true)
    // to reveal it; the Terminal page itself reveals it (you're already on it). The
    // /terminal ROUTE + page stay fully functional regardless — only the nav chrome
    // is gated, never the capability.
    setTerminalNavVisible(active === "terminal");
  }
  // Show/hide the standalone Terminal nav link. Default hidden (see wireShell);
  // a page reveals it once it learns an interactive agent is running. Idempotent.
  function setTerminalNavVisible(show) {
    var link = document.querySelector('.app-nav a[data-view="terminal"]');
    if (link) link.style.display = show ? "" : "none";
  }
  // Reveal the Terminal nav entry IFF ≥1 interactive agent is running. Pages that
  // don't otherwise list agents (chat, config) call this on boot so they don't
  // STRAND an operator who has a live interactive session: GET /api/agents
  // (agent:admin via authedFetch) and reveal when any agent's backend isn't
  // programmatic. Best-effort + never throws — a failed/401 fetch leaves the
  // default-hidden state (the /terminal route still works regardless). The agents
  // + home pages drive the link directly from their own list and don't need this.
  function revealTerminalNavIfInteractive() {
    return authedFetch(MOUNT + "/api/agents")
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (j) {
        var agents = (j && j.agents) || [];
        if (agents.some(function (a) { return a.backend !== "programmatic"; })) {
          setTerminalNavVisible(true);
        }
      })
      .catch(function () { /* leave default-hidden */ });
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  // Render a SMALL, SAFE subset of Markdown to HTML. XSS-safe by construction:
  // the input is escapeHtml'd FIRST (so no raw HTML can survive), THEN a limited
  // set of patterns is applied to the already-escaped string. Supports fenced
  // code blocks, inline code, bold, italic, links (http/https only), and line
  // breaks. Anything else passes through as escaped text. Returns trusted HTML —
  // assign it via innerHTML. Shared so Phase 4's vault-backed chat reuses it.
  //
  // No literal backtick appears in this source (SHELL_JS is asserted backtick-
  // free so it is safe to interpolate into a host template literal); the fence +
  // inline-code markers are built from char code 96 at runtime.
  function renderMarkdown(text) {
    var BT = String.fromCharCode(96); // the backtick character
    var escaped = escapeHtml(String(text == null ? "" : text));
    // 1. Fenced code blocks: a run of 3+ backticks, optional language token on
    //    the open line, body until the closing fence. Pull these out FIRST and
    //    park them as placeholders so inline rules never touch code contents.
    // (These dynamic regexes are built via new RegExp from strings inside SHELL_JS,
    //  which is itself a template literal then eval'd, so regex backslashes are
    //  written four-deep in this source to survive both unescapes to a single
    //  regex escape at runtime. The placeholder NUL sentinels are written the
    //  same way so they reach the runtime as a real NUL.)
    var blocks = [];
    var fence = new RegExp(BT + "{3,}([^\\\\n]*)\\\\n([\\\\s\\\\S]*?)" + BT + "{3,}", "g");
    escaped = escaped.replace(fence, function (_m, _lang, code) {
      blocks.push(code.replace(/\\n$/, ""));
      return "\\u0000B" + (blocks.length - 1) + "\\u0000";
    });
    // 2. Inline code: a single backtick run. Park it too so bold/italic/link
    //    rules never fire inside code.
    var inlines = [];
    var inline = new RegExp(BT + "([^" + BT + "\\\\n]+)" + BT, "g");
    escaped = escaped.replace(inline, function (_m, code) {
      inlines.push(code);
      return "\\u0000I" + (inlines.length - 1) + "\\u0000";
    });
    // 3. Links: [text](url) — only http/https URLs survive; anything else (e.g.
    //    javascript:) renders as inert escaped text. The URL is already HTML-
    //    escaped; we re-escape the double-quote for the attribute context.
    escaped = escaped.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function (m, label, url) {
      if (!/^https?:\\/\\//i.test(url)) return m;
      var safeUrl = url.replace(/"/g, "&quot;");
      return '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
    });
    // 4. Bold (**x**) then italic (*x* / _x_). Bold first so ** is consumed
    //    before the single-* italic rule sees it.
    escaped = escaped.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");
    escaped = escaped.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, "$1<em>$2</em>");
    escaped = escaped.replace(/(^|[^_])_([^_\\n]+)_/g, "$1<em>$2</em>");
    // 5. Line breaks → <br>.
    escaped = escaped.replace(/\\n/g, "<br>");
    // 6. Restore the parked code spans (their contents stay escaped, never parsed).
    escaped = escaped.replace(/\\u0000I(\\d+)\\u0000/g, function (_m, i) {
      return "<code>" + inlines[+i] + "</code>";
    });
    escaped = escaped.replace(/\\u0000B(\\d+)\\u0000/g, function (_m, i) {
      return "<pre><code>" + blocks[+i] + "</code></pre>";
    });
    return escaped;
  }
  function setStatus(text, kind) {
    var el = document.getElementById("status");
    if (!el) return;
    el.textContent = text;
    el.className = "app-status" + (kind ? " " + kind : "");
  }
  // Hub-minted agent token (cookie-gated to the logged-in operator). Cached on
  // window.__token; pages attach it as a Bearer header and/or ?token= param.
  // (Endpoint renamed /admin/channel-token → /admin/agent-token in the
  // channel→agent rename; the hub 301-redirects the old path for old bookmarks.)
  function fetchToken() {
    return fetch(window.location.origin + "/admin/agent-token", { credentials: "include" })
      .then(function (r) { if (!r.ok) throw new Error("token " + r.status); return r.json(); })
      .then(function (j) { window.__token = j && j.token ? j.token : null; return window.__token; })
      .catch(function (err) { window.__token = null; throw err; });
  }
  // fetch() with the agent Bearer + a single token-refresh retry on 401.
  function authedFetch(url, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (window.__token) headers["authorization"] = "Bearer " + window.__token;
    return fetch(url, Object.assign({}, opts, { headers: headers })).then(function (r) {
      if (r.status !== 401) return r;
      return fetchToken().then(function (tok) {
        if (!tok) return r;
        var h2 = Object.assign({}, opts.headers || {}, { authorization: "Bearer " + tok });
        return fetch(url, Object.assign({}, opts, { headers: h2 }));
      });
    });
  }
`;
