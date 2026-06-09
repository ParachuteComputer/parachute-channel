/**
 * Static HTML for `/channel/admin` — the module-owned channel config/admin
 * surface. Part of the modular-UI architecture (P4): modules OWN their config
 * UI; the hub frames/links it via `configUiUrl` in `.parachute/module.json`.
 *
 * Single self-contained document: HTML + inline CSS + inline JS, no build step,
 * no framework. Ships as the rendered string this file exports — the same shape
 * as scribe's `admin-ui.ts` and hub's `oauth-ui.ts`. Testable as a pure
 * function: `renderAdminPage(mount)` returns the HTML for a given mount with no
 * I/O.
 *
 * What the page does on load:
 *   1. Fetch a `channel:admin` Bearer from the hub (cookie-gated mint endpoint,
 *      mirroring the chat UI's `fetchToken()` against `/admin/channel-token`).
 *   2. `GET <mount>/api/channels` (channel:admin) — list configured channels.
 *   3. Render each with name + transport + live status (`GET <mount>/health`).
 *   4. ONE unified add-form with a single transport select. Vault is just
 *      another transport option (the primary/expected one), alongside
 *      `telegram` and `http-ui` (the testing/backup transport). The selected
 *      transport drives which config fields show AND which submit path runs:
 *        - `vault`    → vault picker → the hub-orchestrated link flow:
 *                       `POST <hub-origin>/admin/connections`
 *                       (`credentials: "include"`, `requestedBy: "channel"`).
 *                       The operator clicking the button IS the approval; the
 *                       hub mints the cross-module tokens + registers the vault
 *                       trigger and returns the `claude mcp add` connect lines,
 *                       which we render on success.
 *        - `telegram` → a per-channel bot-token field → `POST <mount>/api/channels`
 *                       with `{ name, transport:"telegram", config:{ token } }`.
 *        - `http-ui`  → no extra fields → `POST <mount>/api/channels` with
 *                       `{ name, transport:"http-ui" }`.
 *   5. A remove button (with confirm) → `DELETE <mount>/api/channels/:name`.
 *
 * Auth posture (mirrors scribe's stateless design):
 *   - When loaded through the hub's reverse proxy to a logged-in operator, the
 *     page fetches a hub-minted `channel:admin` Bearer (cookie-gated) and
 *     attaches it to every `/api/channels` call. The operator never sees it.
 *   - When loaded directly off the daemon (no hub in front, not logged in), the
 *     token fetch fails; the page surfaces a "no auth" banner pointing the
 *     operator at the hub. The channel daemon's `requireScope` gate always
 *     requires a hub JWT — there is no loopback-open fallback (unlike scribe),
 *     so a token is mandatory for the API calls (the PAGE itself still loads
 *     open so it can bootstrap the token fetch).
 *
 * Vault-backed channels are the primary case (modular-UI R2): selecting the
 * `vault` transport calls the hub's `POST /admin/connections` directly. The
 * page is same-origin under the hub proxy, so the operator's hub session cookie
 * flows (`credentials: "include"`) and the hub — the only thing with
 * cross-module authority — mints the tokens + registers the vault trigger on
 * their behalf. The telegram/http-ui adds (which need no cross-module wiring)
 * POST straight to the channel daemon's `/api/channels`. Both paths live in the
 * one add-form, switched by the transport select.
 */

const PALETTE = {
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
  cardBg: "#ffffff",
  danger: "#a3392b",
  dangerSoft: "rgba(163, 57, 43, 0.08)",
  success: "#3d6849",
  successSoft: "rgba(61, 104, 73, 0.08)",
} as const;

const FONT_SERIF = `Georgia, "Times New Roman", serif`;
const FONT_SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
const FONT_MONO = `ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace`;

/**
 * Server-side HTML escape for values interpolated into the rendered document.
 * Escapes the five HTML-significant characters so a value is safe in both text
 * content and a double-quoted attribute value (the two contexts `configUrl`
 * lands in). Mirrors the in-page client-side `escapeHtml` so the two halves of
 * the document share one discipline.
 *
 * Defensive today: `mount` is server-derived (the proxy prefix), never raw user
 * input — but this keeps the footer from becoming a latent XSS sink if that
 * provenance ever changes.
 */
export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the admin page. Pure function — returns the HTML string. The page
 * fetches live state on load (the channel list + per-channel health), so the
 * rendered HTML is the same across requests for a given mount.
 *
 * `mount` is the path prefix the in-page fetches must use to reach the daemon's
 * `/api/channels`, `/health`, and the hub's `/admin/channel-token`. When the
 * channel daemon is launched bare (no `--mount`) but accessed through the hub's
 * `/channel` proxy (the hub strips `/channel` before forwarding, so the
 * daemon's request-level path is bare `/admin` even though the public mount is
 * `/channel`), the server-side `mount` is empty. The page ALSO detects the
 * mount at runtime from `window.location.pathname` so the in-page fetches
 * resolve under the public prefix regardless of how the daemon was launched —
 * the same fix scribe shipped (admin#39). Default `""` preserves the bare shape
 * for direct-loopback callers.
 */
export function renderAdminPage(mount = ""): string {
  const channelsUrl = `${mount}/api/channels`;
  const configUrl = `${mount}/.parachute/config`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Channel — Configuration</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <style>${STYLES}</style>
</head>
<body>
  <main>
    <div class="card">
      <header class="card-header">
        <div class="brand">
          <span class="brand-mark">C</span>
          <span class="brand-name">Channel</span>
          <span class="brand-tag">configuration</span>
        </div>
        <h1>Manage channels</h1>
        <p class="subtitle">Add and remove the channels your Claude Code sessions talk over. Each channel is bound to one transport.</p>
      </header>

      <div id="status-banner" class="banner" hidden></div>

      <section class="section" id="list-section">
        <div class="section-head">
          <h2 class="section-title">Configured channels</h2>
          <button type="button" class="btn btn-secondary btn-sm" id="reload-btn">Reload</button>
        </div>
        <div id="channels-loading" class="loading">Loading channels…</div>
        <ul class="channel-list" id="channel-list" hidden></ul>
        <p class="empty" id="channels-empty" hidden>No channels configured yet. Add one below.</p>
      </section>

      <section class="section" id="add-section">
        <div class="section-head">
          <h2 class="section-title">Add a channel</h2>
        </div>
        <p class="section-desc">
          Pick a transport. <strong>Vault</strong> backs the channel with a Parachute vault (durable,
          queryable messages) — the expected choice; the hub wires the connection on your approval.
          <strong>Telegram</strong> runs a bot with its own per-channel token. <strong>http-ui</strong>
          is the built-in chat page, handy for testing or as a backup.
        </p>
        <form id="add-form" class="add-form" novalidate>
          <label class="field">
            <span class="field-label">Name</span>
            <input type="text" name="name" id="f-name" placeholder="e.g. aaron" autocomplete="off" />
            <span class="field-hint">A unique slug — letters, numbers, dash, underscore.</span>
          </label>

          <label class="field">
            <span class="field-label">Transport</span>
            <select name="transport" id="f-transport">
              <option value="vault" selected>vault — back the channel with a Parachute vault</option>
              <option value="telegram">telegram — a Telegram bot</option>
              <option value="http-ui">http-ui — the built-in chat page (for testing / backup)</option>
            </select>
            <span class="field-hint" id="transport-hint"></span>
          </label>

          <!-- vault transport: pick which vault stores this channel's messages -->
          <label class="field" id="field-vault" hidden>
            <span class="field-label">Vault</span>
            <select name="vault" id="f-vault">
              <option value="" disabled selected>Loading vaults…</option>
            </select>
            <span class="field-hint" id="vault-hint">Which vault stores this channel's messages.</span>
          </label>

          <!-- telegram transport: per-channel bot token (required) -->
          <label class="field" id="field-telegram-token" hidden>
            <span class="field-label">Bot token</span>
            <input type="password" name="telegramToken" id="f-telegram-token" placeholder="123456:ABC-..." autocomplete="off" />
            <span class="field-hint">
              From BotFather, for this channel's bot. Required &mdash; each telegram channel carries its
              own token. Stored server-side (never echoed back).
            </span>
          </label>

          <div class="button-row">
            <button type="submit" class="btn btn-primary" id="add-btn">Add channel</button>
          </div>
        </form>
        <div id="link-result" hidden></div>
      </section>

      <footer class="card-footer">
        <p class="footer-hint">
          Live config (resolved, no secrets): <a href="${escapeHtml(configUrl)}">${escapeHtml(configUrl)}</a>.
          Channels file on disk: <code>~/.parachute/channel/channels.json</code>.
        </p>
      </footer>
    </div>
  </main>

  <script>
    // Mount-prefix the page-script's fetch URLs see. Two sources of truth, in
    // priority order:
    //
    //   1. RUNTIME detection from window.location.pathname (load-bearing). The
    //      admin page is served at \`<mount>/admin\`. Strip the trailing
    //      "/admin" to recover \`<mount>\`. Works regardless of launch shape:
    //      direct loopback (mount = ""), through a hub mounted at /channel
    //      (mount = "/channel"), or any custom prefix.
    //
    //   2. SERVER-rendered fallback (the \`${channelsUrl}\` the server
    //      interpolated) — used only when window.location is unavailable.
    //
    // Same shape scribe ships. The hub strips /channel before forwarding, so
    // the daemon's server-side mount is "" even though the browser page URL is
    // /channel/admin and the API lives at /channel/api/channels. Runtime
    // detection captures this without the launcher passing --mount.
    (function () {
      function detectMount() {
        try {
          var path = window.location.pathname.replace(/\\/+$/, "");
          if (path.endsWith("/admin")) return path.slice(0, -"/admin".length);
          return null;
        } catch (_e) {
          return null;
        }
      }
      var runtimeMount = detectMount();
      var serverChannelsUrl = ${JSON.stringify(channelsUrl)};
      if (runtimeMount === null) {
        window.__CHANNEL_MOUNT__ = ${JSON.stringify(mount)};
        window.__CHANNEL_API_URL__ = serverChannelsUrl;
      } else {
        window.__CHANNEL_MOUNT__ = runtimeMount;
        window.__CHANNEL_API_URL__ = runtimeMount + "/api/channels";
      }
    })();
  </script>
  <script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ${FONT_SANS};
    background: ${PALETTE.bg};
    color: ${PALETTE.fg};
    line-height: 1.55;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  main { display: flex; justify-content: center; padding: 2.5rem 1.5rem; }
  .card {
    width: 100%;
    max-width: 44rem;
    background: ${PALETTE.cardBg};
    border: 1px solid ${PALETTE.border};
    border-radius: 12px;
    padding: 2rem 1.75rem;
    box-shadow: 0 1px 2px rgba(44, 42, 38, 0.04), 0 8px 24px rgba(44, 42, 38, 0.06);
  }
  .card-header { margin-bottom: 1.5rem; }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: ${PALETTE.accent};
    font-weight: 500;
    font-size: 0.95rem;
    margin-bottom: 1.25rem;
  }
  .brand-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    background: ${PALETTE.accent};
    color: ${PALETTE.cardBg};
    font-weight: 600;
    font-size: 0.85rem;
    line-height: 1;
  }
  .brand-name { letter-spacing: 0.01em; font-weight: 600; }
  .brand-tag {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.7rem;
    color: ${PALETTE.fgDim};
    border-left: 1px solid ${PALETTE.border};
    padding-left: 0.55rem;
    margin-left: 0.15rem;
  }
  h1 {
    font-family: ${FONT_SERIF};
    font-weight: 400;
    font-size: 1.75rem;
    line-height: 1.2;
    margin: 0 0 0.4rem;
    color: ${PALETTE.fg};
  }
  .subtitle { margin: 0; color: ${PALETTE.fgMuted}; font-size: 0.95rem; }

  .banner {
    margin: 0 0 1.25rem;
    padding: 0.75rem 0.9rem;
    border-radius: 6px;
    font-size: 0.9rem;
    border: 1px solid transparent;
  }
  .banner-error { background: ${PALETTE.dangerSoft}; border-color: ${PALETTE.danger}; color: ${PALETTE.danger}; }
  .banner-success { background: ${PALETTE.successSoft}; border-color: ${PALETTE.success}; color: ${PALETTE.success}; }
  .banner-warn { background: ${PALETTE.bgSoft}; border-color: ${PALETTE.border}; color: ${PALETTE.fgMuted}; }
  .banner code {
    font-family: ${FONT_MONO};
    font-size: 0.85em;
    background: rgba(255,255,255,0.5);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding-top: 1.25rem;
    margin-top: 1.25rem;
    border-top: 1px solid ${PALETTE.borderLight};
  }
  #list-section { border-top: none; padding-top: 0; margin-top: 0; }
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .section-title {
    font-family: ${FONT_SERIF};
    font-weight: 400;
    font-size: 1.2rem;
    margin: 0;
    color: ${PALETTE.fg};
  }
  .section-desc { margin: 0; font-size: 0.85rem; color: ${PALETTE.fgMuted}; }
  .section-desc code, .field-hint code {
    font-family: ${FONT_MONO};
    font-size: 0.85em;
    background: ${PALETTE.bgSoft};
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    color: ${PALETTE.fgMuted};
  }

  .loading {
    padding: 1.25rem;
    background: ${PALETTE.bgSoft};
    border-radius: 6px;
    color: ${PALETTE.fgMuted};
    font-size: 0.9rem;
    text-align: center;
  }
  .empty { margin: 0; color: ${PALETTE.fgDim}; font-size: 0.9rem; font-style: italic; }

  .channel-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .channel-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.7rem 0.9rem;
    border: 1px solid ${PALETTE.border};
    border-radius: 8px;
    background: ${PALETTE.bg};
  }
  .channel-name { font-weight: 600; font-size: 0.95rem; }
  .channel-transport {
    font-family: ${FONT_MONO};
    font-size: 0.78rem;
    color: ${PALETTE.fgMuted};
    background: ${PALETTE.bgSoft};
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
  }
  .channel-vault { font-size: 0.78rem; color: ${PALETTE.fgDim}; }
  .channel-status { margin-left: auto; display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.8rem; }
  .dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; display: inline-block; background: ${PALETTE.fgDim}; }
  .dot.live { background: ${PALETTE.accent}; }
  .channel-status .clients { color: ${PALETTE.fgDim}; }
  .btn-remove {
    font: inherit;
    font-size: 0.8rem;
    font-weight: 500;
    padding: 0.3rem 0.7rem;
    border-radius: 5px;
    border: 1px solid ${PALETTE.border};
    background: transparent;
    color: ${PALETTE.danger};
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .btn-remove:hover { background: ${PALETTE.dangerSoft}; border-color: ${PALETTE.danger}; }
  .btn-remove:disabled { opacity: 0.5; cursor: progress; }

  .add-form { display: flex; flex-direction: column; gap: 1rem; }
  .field { display: flex; flex-direction: column; gap: 0.3rem; }
  /* The author \`display:flex\` above outranks the UA \`[hidden]{display:none}\`
     rule, so a per-transport field with the \`hidden\` attribute would still
     render. Re-assert the hide at matching specificity so applyTransportUI's
     \`field.hidden = …\` toggling actually shows/hides the field. */
  .field[hidden] { display: none; }
  .field-label { font-size: 0.85rem; font-weight: 500; color: ${PALETTE.fgMuted}; letter-spacing: 0.01em; }
  .field-hint { font-size: 0.8rem; color: ${PALETTE.fgDim}; }
  .field-error { font-size: 0.8rem; color: ${PALETTE.danger}; font-weight: 500; }

  select, input[type=text], input[type=password] {
    font: inherit;
    width: 100%;
    padding: 0.55rem 0.7rem;
    border: 1px solid ${PALETTE.border};
    border-radius: 6px;
    background: ${PALETTE.bg};
    color: ${PALETTE.fg};
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  select:focus, input:focus {
    outline: none;
    border-color: ${PALETTE.accent};
    background: ${PALETTE.cardBg};
    box-shadow: 0 0 0 3px ${PALETTE.accentSoft};
  }
  .field-invalid select, .field-invalid input { border-color: ${PALETTE.danger}; }

  .btn {
    font: inherit;
    font-weight: 500;
    padding: 0.6rem 1.1rem;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }
  .btn-sm { padding: 0.3rem 0.7rem; font-size: 0.82rem; }
  .btn-primary { background: ${PALETTE.accent}; color: ${PALETTE.cardBg}; }
  .btn-primary:hover { background: ${PALETTE.accentHover}; }
  .btn-primary:disabled { background: ${PALETTE.fgDim}; cursor: progress; }
  .btn-secondary { background: ${PALETTE.cardBg}; color: ${PALETTE.fgMuted}; border-color: ${PALETTE.border}; }
  .btn-secondary:hover { color: ${PALETTE.fg}; border-color: ${PALETTE.fgDim}; }
  .button-row { display: flex; gap: 0.6rem; margin-top: 0.25rem; }

  #link-result {
    margin-top: 0.75rem;
    padding: 0.9rem 1rem;
    border: 1px solid ${PALETTE.border};
    border-radius: 8px;
    background: ${PALETTE.successSoft};
  }
  .link-result-head { margin: 0 0 0.6rem; font-size: 0.9rem; }
  .connect-label {
    font-size: 0.78rem;
    font-weight: 500;
    color: ${PALETTE.fgMuted};
    margin: 0.5rem 0 0.2rem;
  }
  .connect-line {
    margin: 0;
    padding: 0.55rem 0.7rem;
    background: ${PALETTE.cardBg};
    border: 1px solid ${PALETTE.border};
    border-radius: 6px;
    font-family: ${FONT_MONO};
    font-size: 0.8rem;
    white-space: pre-wrap;
    word-break: break-all;
    color: ${PALETTE.fg};
  }
  #link-result code {
    font-family: ${FONT_MONO};
    font-size: 0.85em;
    background: ${PALETTE.cardBg};
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }

  .card-footer {
    margin-top: 1.75rem;
    padding-top: 1.25rem;
    border-top: 1px solid ${PALETTE.borderLight};
    color: ${PALETTE.fgMuted};
    font-size: 0.82rem;
  }
  .footer-hint { margin: 0; }
  .footer-hint code {
    font-family: ${FONT_MONO};
    font-size: 0.85em;
    background: ${PALETTE.bgSoft};
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    color: ${PALETTE.fg};
  }
  .footer-hint a { color: ${PALETTE.accent}; }
  .footer-hint a:hover { color: ${PALETTE.accentHover}; }

  @media (prefers-color-scheme: dark) {
    body { background: #1a1815; color: #e8e4dc; }
    .card { background: #25221d; border-color: #3a362f; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
    h1, .section-title { color: #f0ece4; }
    .subtitle, .section-desc, .field-label, .field-hint { color: #a8a29a; }
    .channel-row { background: #1f1c18; border-color: #3a362f; }
    .channel-transport { background: #2a2620; }
    select, input[type=text], input[type=password] { background: #1f1c18; border-color: #3a362f; color: #e8e4dc; }
    select:focus, input:focus { background: #25221d; }
    .btn-secondary { background: #25221d; border-color: #3a362f; color: #a8a29a; }
    .btn-secondary:hover { color: #e8e4dc; border-color: #6b6860; }
    .card-footer, .section { border-color: #3a362f; }
    .loading { background: #1f1c18; }
    .section-desc code, .field-hint code, .footer-hint code { background: #2a2620; }
  }

  @media (max-width: 600px) {
    main { padding: 1rem; }
    .card { padding: 1.5rem 1.25rem; border-radius: 10px; }
    h1 { font-size: 1.45rem; }
    .button-row .btn { width: 100%; }
    .channel-row { flex-wrap: wrap; }
    .channel-status { margin-left: 0; }
  }
`;

// Vanilla JS — no bundler, no transpile. Interpolated into the served HTML as a
// String.raw template; avoid literal backticks. Non-ASCII glyphs are unreliable
// in a String.raw block (Bun transpile + String.raw can emit them as visible
// \\u escapes), so icons/dashes use HTML numeric entities via innerHTML or plain
// ASCII via textContent — same discipline as scribe's page-script.
const PAGE_SCRIPT = String.raw`
  "use strict";

  function el(id) { return document.getElementById(id); }

  // Resolved at load by the inline bootstrap script above: the public mount
  // prefix and the /api/channels URL under it.
  var MOUNT = window.__CHANNEL_MOUNT__ || "";
  var API_URL = window.__CHANNEL_API_URL__ || "/api/channels";

  // --- Auth: a channel:admin Bearer minted by the hub --------------------
  // The channel config API (/api/channels) requires a hub JWT with
  // channel:admin. The hub mints one for the logged-in portal operator at
  // <origin>/admin/channel-token (cookie-gated) -- the same endpoint the chat
  // UI uses. We fetch it from the page origin (which IS the hub origin when
  // served through the expose) and attach it as a Bearer on every API call.
  // A direct-to-daemon / not-logged-in load leaves the token null and surfaces
  // a notice -- the daemon's requireScope then 401s the API calls.
  window.__token = null;
  function fetchToken() {
    return fetch(window.location.origin + "/admin/channel-token", { credentials: "include" })
      .then(function (r) {
        if (!r.ok) throw new Error("token " + r.status);
        return r.json();
      })
      .then(function (j) {
        window.__token = j && j.token ? j.token : null;
        return window.__token;
      })
      .catch(function (_err) {
        window.__token = null;
        return null;
      });
  }

  function authHeaders(extra) {
    var h = extra || {};
    if (window.__token) h.authorization = "Bearer " + window.__token;
    return h;
  }

  function setBanner(kind, trustedHtml) {
    var b = el("status-banner");
    b.className = "banner banner-" + kind;
    b.innerHTML = trustedHtml;
    b.hidden = false;
  }
  function clearBanner() {
    var b = el("status-banner");
    b.hidden = true;
    b.innerHTML = "";
    b.className = "banner";
  }
  function noAuthBanner() {
    setBanner(
      "warn",
      "<strong>Not authenticated.</strong> This page needs a <code>channel:admin</code> token, " +
        "minted for the logged-in operator by the hub. Open it through the Parachute hub portal " +
        "(at <code>/channel/admin</code>, signed in) rather than hitting the daemon directly."
    );
  }

  // Reflect whether we hold a channel:admin token in the add-form's affordance,
  // so the operator gets a CLEAR actionable state rather than an Add button that
  // silently 401s. When not authed: disable + relabel the button and explain.
  //
  // Caveat: the channel:admin token gates the telegram + http-ui submit path
  // (POST /api/channels). The VAULT path instead POSTs to the hub's
  // /admin/connections with the hub SESSION COOKIE (not this token), so it can
  // succeed even without a channel:admin token. We keep the disabled/relabel
  // affordance off the channel:admin token (the common case + the clearest
  // signal); the vault path's own 401 handler surfaces a hub-session-specific
  // message if the cookie is what's missing. Called after the list load resolves.
  window.__authed = false;
  function setAddFormAuthState(authed) {
    window.__authed = !!authed;
    // Recompute the button's enabled/label from the CURRENTLY-selected transport
    // (vault gates on vault-availability, not this token); applyTransportUI owns
    // that logic so the two states never fight.
    applyTransportUI();
  }

  // Show only the config fields the selected transport needs, and adjust the
  // button label. Single-select drives one submit path (see addChannel). The
  // add-button's enabled state is per-transport: telegram/http-ui gate on the
  // channel:admin token (__authed); vault gates on vault-availability
  // (__vaultsAvailable) instead, because its submit goes to the hub's
  // Connections engine under the hub SESSION COOKIE (not this token) and
  // handles its own hub-session 401. (See the inner button block.)
  function applyTransportUI() {
    var transport = el("f-transport").value;
    var vaultField = el("field-vault");
    var tgField = el("field-telegram-token");
    var tgInput = el("f-telegram-token");
    var hint = el("transport-hint");
    // Reveal exactly the fields the selected transport needs. Each branch is
    // explicit for ALL THREE transports so no field leaks across a selection:
    //   vault    → show the vault picker, hide the telegram token field.
    //   telegram → show the telegram token field, hide the vault picker.
    //   http-ui  → hide both (no extra config).
    if (vaultField) vaultField.hidden = transport !== "vault";
    if (tgField) tgField.hidden = transport !== "telegram";
    // Gate HTML5 \`required\` on visibility: a hidden-but-required field can't be
    // filled and would block submit. Only require the bot token while it's shown.
    if (tgInput) tgInput.required = transport === "telegram";
    // The connect-a-session result is vault-specific; hide it when switching to
    // a non-vault transport so a prior vault success doesn't linger under an
    // unrelated form.
    var linkResult = el("link-result");
    if (linkResult && transport !== "vault") linkResult.hidden = true;
    var btn = el("add-btn");
    if (hint) {
      if (transport === "vault") {
        hint.innerHTML =
          "Inbound messages become <code>#channel-message</code> notes; a session replies by writing notes. " +
          "Clicking <strong>Add channel</strong> is your approval &mdash; the hub mints the cross-module tokens " +
          "and registers the vault trigger.";
      } else if (transport === "telegram") {
        hint.innerHTML =
          "A Telegram bot with its own per-channel token (below).";
      } else {
        hint.innerHTML =
          "The built-in chat page &mdash; no extra config. Good for testing or as a backup transport.";
      }
    }
    if (btn) {
      // The add button's enabled state: telegram/http-ui need the channel:admin
      // token (__authed); vault needs at least one vault to exist (the vault
      // submit uses the hub session cookie, validated server-side, so we don't
      // gate it on __authed). Relabel to match the selected path.
      if (transport === "vault") {
        btn.disabled = !window.__vaultsAvailable;
        btn.textContent = window.__vaultsAvailable ? "Link to vault" : "No vaults to link";
      } else {
        btn.disabled = !window.__authed;
        btn.textContent = window.__authed ? "Add channel" : "Sign in to the hub to add";
      }
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // --- List + render ------------------------------------------------------
  // Two reads: /api/channels (channel:admin, the authoritative config list:
  // name + transport + vault) and /health (open: live-status + client counts).
  // We join them by name so each row shows config + liveness.
  function fetchHealth() {
    return fetch(MOUNT + "/health")
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function renderChannels(channels, health) {
    var list = el("channel-list");
    var empty = el("channels-empty");
    list.innerHTML = "";
    if (!channels.length) {
      list.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    var liveByName = {};
    if (health && Array.isArray(health.channels)) {
      health.channels.forEach(function (h) { liveByName[h.name] = h; });
    }
    channels.forEach(function (c) {
      var li = document.createElement("li");
      li.className = "channel-row";

      var name = document.createElement("span");
      name.className = "channel-name";
      name.textContent = c.name;
      li.appendChild(name);

      var transport = document.createElement("span");
      transport.className = "channel-transport";
      transport.textContent = c.transport;
      li.appendChild(transport);

      if (c.vault) {
        var v = document.createElement("span");
        v.className = "channel-vault";
        v.textContent = "vault: " + c.vault;
        li.appendChild(v);
      }

      var status = document.createElement("span");
      status.className = "channel-status";
      var h = liveByName[c.name];
      var dot = document.createElement("span");
      // A channel present in /health is live (its transport started). The dot is
      // green when live, grey when configured-but-not-live (e.g. persisted on
      // disk, awaiting a restart to come up).
      dot.className = "dot" + (h ? " live" : "");
      status.appendChild(dot);
      var label = document.createElement("span");
      label.textContent = h ? "live" : "not live";
      status.appendChild(label);
      if (h && typeof h.clients === "number") {
        var clients = document.createElement("span");
        clients.className = "clients";
        clients.textContent = "(" + h.clients + " client" + (h.clients === 1 ? "" : "s") + ")";
        status.appendChild(clients);
      }
      li.appendChild(status);

      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "btn-remove";
      rm.textContent = "Remove";
      rm.addEventListener("click", function () { removeChannel(c.name, rm); });
      li.appendChild(rm);

      list.appendChild(li);
    });
    list.hidden = false;
  }

  function loadChannels() {
    el("channels-loading").hidden = false;
    el("channel-list").hidden = true;
    el("channels-empty").hidden = true;
    return Promise.all([
      fetch(API_URL, { headers: authHeaders() }),
      fetchHealth(),
    ]).then(function (res) {
      var apiRes = res[0];
      var health = res[1];
      el("channels-loading").hidden = true;
      if (apiRes.status === 401 || apiRes.status === 403) {
        noAuthBanner();
        setAddFormAuthState(false);
        renderChannels([], null);
        return;
      }
      if (!apiRes.ok) throw new Error("channels fetch failed (" + apiRes.status + ")");
      setAddFormAuthState(true);
      return apiRes.json().then(function (data) {
        renderChannels((data && data.channels) || [], health);
      });
    }).catch(function (err) {
      el("channels-loading").hidden = true;
      setBanner("error", "<strong>Could not load channels.</strong> " + escapeHtml(err && err.message ? err.message : String(err)));
    });
  }

  // --- Add ----------------------------------------------------------------
  function clearFieldErrors() {
    document.querySelectorAll(".field-error").forEach(function (n) { n.remove(); });
    document.querySelectorAll(".field-invalid").forEach(function (n) { n.classList.remove("field-invalid"); });
  }
  function setFieldError(inputId, message) {
    var input = el(inputId);
    if (!input) return;
    var field = input.closest(".field");
    if (!field) return;
    field.classList.add("field-invalid");
    var e = document.createElement("span");
    e.className = "field-error";
    e.textContent = message;
    field.appendChild(e);
  }

  function addChannel(ev) {
    ev.preventDefault();
    clearBanner();
    clearFieldErrors();
    var name = el("f-name").value.trim();
    var transport = el("f-transport").value;
    if (!name) { setFieldError("f-name", "Required."); return; }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      setFieldError("f-name", "Letters, numbers, dash, underscore only.");
      return;
    }
    // Vault is a transport option, but it submits through the hub-orchestrated
    // connection flow (cookie auth, cross-module token minting) rather than the
    // plain POST /api/channels path. Branch on the selected transport.
    if (transport === "vault") { return addVaultChannel(name); }

    // telegram + http-ui POST straight to the channel daemon. http-ui is fully
    // self-contained (no config). telegram REQUIRES a per-channel bot token in
    // config.token -- there is no daemon-global env fallback anymore, so a blank
    // token can't succeed. Block the submit with a clear field error.
    var config;
    if (transport === "telegram") {
      var tgToken = el("f-telegram-token").value.trim();
      if (!tgToken) {
        setFieldError("f-telegram-token", "Required — each telegram channel needs its own bot token.");
        return;
      }
      config = { token: tgToken };
    }
    var btn = el("add-btn");
    btn.disabled = true;
    var prev = btn.textContent;
    btn.textContent = "Adding...";
    var postBody = { name: name, transport: transport };
    if (config) postBody.config = config;
    fetch(API_URL, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(postBody),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (payload) {
        if (res.status === 401 || res.status === 403) { noAuthBanner(); return; }
        if (res.status === 400) {
          setBanner("error", "<strong>Could not add channel.</strong> " + escapeHtml((payload && payload.error) || "invalid request"));
          return;
        }
        if (!res.ok) {
          setBanner("error", "<strong>Add failed.</strong> " + escapeHtml((payload && payload.error) || ("HTTP " + res.status)));
          return;
        }
        // 200 may still carry restart_needed: true (persisted, hot-add failed).
        if (payload && payload.restart_needed) {
          setBanner(
            "warn",
            "<strong>Saved &mdash; restart needed.</strong> Channel <code>" + escapeHtml(name) +
              "</code> was written to disk but didn't start live: " + escapeHtml(payload.error || "") +
              " Run <code>parachute restart channel</code>."
          );
        } else {
          setBanner("success", "<strong>Channel added.</strong> <code>" + escapeHtml(name) + "</code> (" + escapeHtml(transport) + ") is live.");
        }
        el("f-name").value = "";
        if (el("f-telegram-token")) el("f-telegram-token").value = "";
        loadChannels();
      });
    }).catch(function (err) {
      setBanner("error", "<strong>Network error.</strong> " + escapeHtml(err && err.message ? err.message : String(err)));
    }).then(function () {
      btn.disabled = false;
      btn.textContent = prev;
    });
  }

  // --- Remove -------------------------------------------------------------
  function removeChannel(name, btn) {
    if (!window.confirm("Remove channel \"" + escapeHtml(name) + "\"? Sessions on it will stop receiving messages.")) return;
    clearBanner();
    if (btn) { btn.disabled = true; btn.textContent = "Removing..."; }
    fetch(API_URL + "/" + encodeURIComponent(name), {
      method: "DELETE",
      headers: authHeaders(),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (payload) {
        if (res.status === 401 || res.status === 403) { noAuthBanner(); return; }
        if (!res.ok) {
          setBanner("error", "<strong>Remove failed.</strong> " + escapeHtml((payload && payload.error) || ("HTTP " + res.status)));
          return;
        }
        setBanner("success", "<strong>Channel removed.</strong> <code>" + escapeHtml(name) + "</code> is gone.");
        loadChannels();
      });
    }).catch(function (err) {
      setBanner("error", "<strong>Network error.</strong> " + escapeHtml(err && err.message ? err.message : String(err)));
      if (btn) { btn.disabled = false; btn.textContent = "Remove"; }
    });
  }

  // --- Vault transport: populate the vault picker (modular-UI R2) ----------
  // Populate the vault dropdown from the hub's PUBLIC discovery doc. The page
  // is same-origin with the hub under the /channel proxy, so /.well-known/
  // parachute.json resolves at the hub origin. No token needed -- it's public.
  // The vault picker lives inside the unified add-form (revealed when the vault
  // transport is selected); a no-vaults / load-error state disables the add
  // button only WHILE vault is the selected transport (see applyTransportUI).
  window.__vaultsAvailable = false;
  function loadVaults() {
    return fetch(window.location.origin + "/.well-known/parachute.json", {
      headers: { accept: "application/json" },
      credentials: "include",
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (doc) {
        var sel = el("f-vault");
        var vaults = (doc && Array.isArray(doc.vaults)) ? doc.vaults : [];
        sel.innerHTML = "";
        if (!vaults.length) {
          var opt = document.createElement("option");
          opt.value = "";
          opt.disabled = true;
          opt.selected = true;
          opt.textContent = "No vaults found";
          sel.appendChild(opt);
          window.__vaultsAvailable = false;
          el("vault-hint").textContent =
            "No vaults are installed on this hub yet -- create one in the hub portal first.";
          applyTransportUI();
          return;
        }
        vaults.forEach(function (v, i) {
          var opt = document.createElement("option");
          opt.value = v.name;
          opt.textContent = v.name;
          if (i === 0) opt.selected = true;
          sel.appendChild(opt);
        });
        window.__vaultsAvailable = true;
        applyTransportUI();
      })
      .catch(function () {
        var sel = el("f-vault");
        sel.innerHTML = "";
        var opt = document.createElement("option");
        opt.value = "";
        opt.disabled = true;
        opt.selected = true;
        opt.textContent = "Could not load vaults";
        sel.appendChild(opt);
        window.__vaultsAvailable = false;
        applyTransportUI();
      });
  }

  // The connect-a-session lines the hub returns on a successful connection.
  function renderConnectResult(connection, connect) {
    var box = el("link-result");
    box.innerHTML = "";
    box.hidden = false;
    var head = document.createElement("p");
    head.className = "link-result-head";
    head.innerHTML =
      "<strong>Linked.</strong> Connection <code>" +
      escapeHtml(connection && connection.id ? connection.id : "") +
      "</code> is wired. Connect a session:";
    box.appendChild(head);
    if (connect && (connect.mcpAdd || connect.launch)) {
      [["1 - Register the channel (MCP)", connect.mcpAdd],
       ["2 - Launch a session on the channel", connect.launch]].forEach(function (pair) {
        if (!pair[1]) return;
        var label = document.createElement("div");
        label.className = "connect-label";
        label.textContent = pair[0];
        box.appendChild(label);
        var pre = document.createElement("pre");
        pre.className = "connect-line";
        pre.textContent = pair[1];
        box.appendChild(pre);
      });
      var warn = document.createElement("p");
      warn.className = "field-hint";
      warn.textContent =
        "The launch command runs Claude Code with unrestricted tool access -- run it only on a machine you trust.";
      box.appendChild(warn);
    }
  }

  // The vault submit path of the unified add-form. The name arg is the (already
  // validated) channel name from the shared #f-name input; the vault comes from
  // the #f-vault picker the vault transport reveals.
  function addVaultChannel(name) {
    el("link-result").hidden = true;
    var vault = el("f-vault").value;
    if (!vault) { setFieldError("f-vault", "Pick a vault."); return; }
    var btn = el("add-btn");
    btn.disabled = true;
    var prev = btn.textContent;
    btn.textContent = "Linking...";
    // POST to the HUB's general Connections engine. The page is same-origin
    // under the /channel proxy, so the operator's hub session cookie flows with
    // credentials:"include" -- the click IS the approval. We label provenance
    // requestedBy:"channel" so the hub's Connections view shows it as
    // module-initiated. The body is the canonical vault-backed-channel shape:
    // vault.note.created (filtered to the inbound tag) -> channel.message.deliver.
    var body = {
      requestedBy: "channel",
      source: {
        module: "vault",
        vault: vault,
        event: "note.created",
        filter: {
          tags: ["#channel-message/inbound"],
          has_metadata: ["channel"],
          missing_metadata: ["channel_inbound_rendered_at"]
        }
      },
      sink: { module: "channel", action: "message.deliver", params: { channel: name } }
    };
    fetch(window.location.origin + "/admin/connections", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (payload) {
        if (res.status === 401) {
          setBanner(
            "warn",
            "<strong>Not signed in to the hub.</strong> Linking a vault uses your hub admin session. " +
              "Open this page through the Parachute hub portal (signed in) at <code>/channel/admin</code>, " +
              "then try again."
          );
          return;
        }
        if (res.status === 403) {
          setBanner(
            "error",
            "<strong>Not permitted.</strong> Only the hub admin can link a vault. " +
              escapeHtml((payload && payload.error_description) || "")
          );
          return;
        }
        if (!res.ok) {
          setBanner(
            "error",
            "<strong>Link failed.</strong> " +
              escapeHtml((payload && (payload.error_description || payload.error)) || ("HTTP " + res.status))
          );
          return;
        }
        setBanner("success", "<strong>Vault linked.</strong> Channel <code>" + escapeHtml(name) + "</code> is backed by vault <code>" + escapeHtml(vault) + "</code>.");
        renderConnectResult(payload && payload.connection, payload && payload.connect);
        el("f-name").value = "";
        loadChannels();
      });
    }).catch(function (err) {
      setBanner("error", "<strong>Network error.</strong> " + escapeHtml(err && err.message ? err.message : String(err)));
    }).then(function () {
      btn.disabled = false;
      btn.textContent = prev;
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    el("add-form").addEventListener("submit", addChannel);
    el("f-transport").addEventListener("change", applyTransportUI);
    el("reload-btn").addEventListener("click", function () { clearBanner(); loadChannels(); });
    // Reflect the default-selected transport (vault) immediately: reveal its
    // field + set the hint, so the form is coherent before any interaction.
    applyTransportUI();
    // Fetch the hub token first so the API calls go out authenticated, then
    // list. A token failure still proceeds to loadChannels -- which surfaces the
    // no-auth banner on the resulting 401, so the operator sees one clear notice.
    // The vault dropdown loads in parallel (public discovery doc, no token).
    fetchToken().then(loadChannels);
    loadVaults();
  });
`;
