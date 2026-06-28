/**
 * Static HTML for `/agent/terminal` — the in-page xterm.js terminal (design
 * `design/2026-06-14-sandboxed-agent-sessions.md` §5).
 *
 * Single self-contained document: HTML + inline CSS + inline JS, no build step
 * (same shape as `daemon.ts`'s chat UI + `admin-ui.ts`). xterm.js + the fit addon
 * are served SAME-ORIGIN by the daemon (`/terminal/assets/*`, see
 * `terminal-assets.ts`) — NOT from a CDN. The original CDN load broke whenever the
 * operator's network or the hub's CSP blocked jsdelivr; vendoring + same-origin
 * serving fixes that ("xterm.js failed to load — CDN blocked?").
 *
 * What the page does:
 *   1. Compute the mount prefix, then dynamically load the same-origin xterm
 *      assets (CSS + JS), THEN boot — the `<script src>`/`<link>` can't be static
 *      because their correct URL depends on the runtime mount prefix.
 *   2. Fetch the channel list (`<mount>/.parachute/config`) → a picker.
 *   3. Fetch a hub-minted `agent:admin` Bearer (`<origin>/admin/agent-token`).
 *   4. Open a WebSocket to `<mount>/terminal/<channel>?token=…&cols=…&rows=…`.
 *      The daemon's upgrade gate validates agent:admin BEFORE upgrading.
 *   5. Relay xterm ↔ WS: keystrokes → BINARY frames; pty output (BINARY) →
 *      `term.write`; resize → a JSON control frame `{type:"resize",cols,rows}`.
 *   6. Reconnect: the backend attaches to TMUX, so a dropped socket re-attaches to
 *      the live session with scrollback intact.
 */

import { THEME_CSS, appShell, SHELL_JS } from "./ui-kit.ts";

export const TERMINAL_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>parachute-agent · terminal</title>
<style>
${THEME_CSS}
  /* ---- Terminal-pane layout (page-specific, layered after the shared kit) -- */
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; height: 100vh; }
  .app-header { flex: 0 0 auto; }
  /* The terminal CONTENT pane stays dark — a terminal is black everywhere. Only
     the chrome (header/nav) above is the brand-light kit. */
  #term-wrap {
    flex: 1 1 auto; min-height: 0; padding: 8px; background: var(--term-bg);
  }
  #term { width: 100%; height: 100%; }
  .notice {
    padding: 0.6rem 1.1rem; font-size: 0.9rem; color: var(--fg-muted);
    border-bottom: 1px solid var(--border); background: var(--card);
  }
  .notice.err { color: var(--danger); }
  .notice code { font-family: var(--font-mono); color: var(--fg); }
</style>
</head>
<body>
  ${appShell({
    active: "terminal",
    tag: "terminal",
    status: "loading…",
    controls:
      '<select id="agent" class="btn-sm" title="agent session" style="width:auto;"></select>' +
      '<button id="reconnect" type="button" class="btn btn-sm" title="Re-attach to the agent session">Reconnect</button>',
  })}
  <div id="notice" class="notice" hidden></div>
  <div id="term-wrap"><div id="term"></div></div>

<script>
${SHELL_JS}
(function () {
  // The picker lists running AGENTS (an agent's tmux session is what the terminal
  // attaches to), so its id is "agent" — not "channel". See loadAgentsAndConnect.
  var sel = document.getElementById("agent");
  var noticeEl = document.getElementById("notice");
  var reconnectBtn = document.getElementById("reconnect");
  var termHost = document.getElementById("term");

  // MOUNT, setStatus, escapeHtml, fetchToken, authedFetch come from SHELL_JS.
  // Wire the shared nav (hrefs + active tab) for the terminal view.
  wireShell("terminal");

  function showNotice(html, isErr) {
    noticeEl.innerHTML = html;
    noticeEl.className = "notice" + (isErr ? " err" : "");
    noticeEl.hidden = false;
  }
  function clearNotice() { noticeEl.hidden = true; noticeEl.innerHTML = ""; }

  // --- same-origin asset loading ------------------------------------------
  // xterm CSS + JS are served by the daemon at <mount>/terminal/assets/* (NOT a
  // CDN). Their correct URL depends on MOUNT, so we inject them at runtime, then
  // boot once xterm is defined.
  function loadAssets(cb) {
    var base = MOUNT + "/terminal/assets/";
    var link = document.createElement("link");
    link.rel = "stylesheet"; link.href = base + "xterm.css";
    document.head.appendChild(link);
    loadScript(base + "xterm.js", function () {
      loadScript(base + "addon-fit.js", cb);
    });
  }
  function loadScript(src, cb) {
    var s = document.createElement("script");
    s.src = src;
    s.onload = cb;
    s.onerror = function () {
      setStatus("xterm unavailable", "err");
      showNotice("Failed to load the terminal renderer from <code>" + src + "</code>. " +
        "You can always attach on the host: <code>tmux attach -t &lt;agent-name&gt;-agent</code>.", true);
    };
    document.head.appendChild(s);
  }

  setStatus("loading renderer…");
  loadAssets(boot);

  function boot() {
    if (typeof window.Terminal !== "function") {
      setStatus("xterm unavailable", "err");
      showNotice("The terminal renderer didn't initialize. " +
        "You can always attach on the host: <code>tmux attach -t &lt;agent-name&gt;-agent</code>.", true);
      return;
    }
    setStatus("connecting…");

  // --- xterm setup --------------------------------------------------------
  var term = new window.Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: { background: "#000000", foreground: "#e6e9ef" },
    convertEol: false,
  });
  var fit = null;
  try {
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
  } catch (_e) { fit = null; }
  term.open(termHost);
  doFit();

  var ws = null;
  var manualClose = false;
  var reconnectTimer = null;
  var enc = new TextEncoder();

  function currentAgent() { return sel.value; }

  function doFit() {
    if (!fit) return;
    try { fit.fit(); } catch (_e) {}
  }

  // --- token (operator agent:admin, minted by the hub) ------------------
  // The shared fetchToken (SHELL_JS) does the mint + caches it on window.__token,
  // and REJECTS on failure. ensureToken wraps it with the terminal's own notice
  // affordance so a not-authenticated load explains itself, then resolves to null
  // (never rejects) — the WS attach validates the token anyway.
  function ensureToken() {
    return fetchToken().catch(function (err) {
      showNotice("Not authenticated — open this page through the hub portal, signed in " +
        "as the operator. The terminal needs an <code>agent:admin</code> token (" + err + ").", true);
      return null;
    });
  }

  // --- step-up PIN (agent#80) --------------------------------------------
  // A terminal is a raw host shell — the most dangerous capability — so the WS
  // upgrade requires a STEP-UP TOKEN on top of the agent:admin Bearer. The WS
  // can't set a header, so we present it as a step_up query param. We fetch the step-up
  // status, prompt for the PIN (or set one first), exchange it for a short-TTL
  // token, and cache it on window.__stepUp. Re-prompt on expiry / WS auth-fail.
  // This page is server-rendered (no React) so the prompt is a native dialog.
  function authedJson(suffix, init) {
    init = init || {};
    var headers = init.headers || {};
    headers["accept"] = "application/json";
    if (window.__token) headers["authorization"] = "Bearer " + window.__token;
    init.headers = headers;
    return fetch(MOUNT + "/api" + suffix, init);
  }
  function ensureStepUp() {
    if (window.__stepUp && window.__stepUpExp && Date.now() < window.__stepUpExp - 5000) {
      return Promise.resolve(window.__stepUp);
    }
    return authedJson("/step-up").then(function (r) {
      return r.json();
    }).then(function (s) {
      if (!s.configured) {
        var np = window.prompt("Set a step-up PIN (4-12 digits) — required to open a terminal:");
        if (!np) return null;
        var confirm = window.prompt("Confirm the PIN:");
        if (confirm !== np) { showNotice("The PINs didn't match — try again.", true); return null; }
        return authedJson("/step-up/pin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ newPin: np }),
        }).then(function (r) {
          if (!r.ok) { showNotice("Could not set the PIN (must be 4-12 digits).", true); return null; }
          return exchangePin(np);
        });
      }
      var pin = window.prompt("Enter your step-up PIN to open a terminal:");
      if (!pin) return null;
      return exchangePin(pin);
    });
  }
  function exchangePin(pin) {
    return authedJson("/step-up", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: pin }),
    }).then(function (r) {
      if (r.status === 401) { showNotice("Incorrect PIN.", true); return null; }
      if (r.status === 429) { showNotice("Too many PIN attempts — wait a minute.", true); return null; }
      if (!r.ok) { showNotice("Step-up failed (" + r.status + ").", true); return null; }
      return r.json();
    }).then(function (body) {
      if (!body || !body.stepUpToken) return null;
      window.__stepUp = body.stepUpToken;
      window.__stepUpExp = body.expires_at ? new Date(body.expires_at).getTime() : Date.now() + 5 * 60000;
      return window.__stepUp;
    });
  }

  // --- WebSocket relay ----------------------------------------------------
  // The path segment is the AGENT name — the daemon attaches to that agent's tmux
  // session (<name>-agent). NOT a channel.
  function wsUrl(agent) {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var dims = "cols=" + term.cols + "&rows=" + term.rows;
    var u = proto + "//" + location.host + MOUNT + "/terminal/" + encodeURIComponent(agent) + "?" + dims;
    if (window.__token) u += "&token=" + encodeURIComponent(window.__token);
    if (window.__stepUp) u += "&step_up=" + encodeURIComponent(window.__stepUp);
    return u;
  }

  function connect() {
    var agent = currentAgent();
    if (!agent) { setStatus("no agent"); return; }
    if (ws) { manualClose = true; try { ws.close(); } catch (_e) {} ws = null; }
    manualClose = false;
    clearNotice();
    // Step-up FIRST — a terminal needs the PIN-minted token (agent#80). Only open
    // the socket once we hold one; a cancelled prompt leaves the page idle.
    setStatus("step-up…");
    ensureStepUp().then(function (tok) {
      if (!tok) { setStatus("step-up required", "err"); return; }
      openSocket(agent);
    }).catch(function () {
      setStatus("step-up failed", "err");
      showNotice("Could not complete step-up. Reload and try again.", true);
    });
  }

  function openSocket(agent) {
    setStatus("connecting…");
    doFit();
    var socket = new WebSocket(wsUrl(agent));
    socket.binaryType = "arraybuffer";
    ws = socket;

    socket.onopen = function () {
      setStatus("● attached · " + agent, "live");
      sendResize();
      term.focus();
    };
    socket.onmessage = function (ev) {
      if (typeof ev.data === "string") { term.write(ev.data); return; }
      term.write(new Uint8Array(ev.data));
    };
    socket.onclose = function (ev) {
      if (socket !== ws) return;
      ws = null;
      if (manualClose) return;
      if (ev.code === 1013) {
        setStatus("disconnected (too slow)", "err");
        showNotice("The terminal fell too far behind and was disconnected. Reconnecting will " +
          "re-attach to the live session (scrollback intact via tmux).", true);
      } else if (ev.code === 1000) {
        setStatus("session ended");
        showNotice("The agent's tmux session ended (or detached). Spawn an agent from the " +
          "<a href='" + MOUNT + "/agents'>Agents</a> page, then Reconnect.", false);
        return;
      } else {
        setStatus("reconnecting…", "err");
      }
      scheduleReconnect();
    };
    socket.onerror = function () {};
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      ensureToken().then(function () { connect(); });
    }, 1500);
  }

  // xterm input (keystrokes / paste) → BINARY frame to the pty.
  term.onData(function (data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(enc.encode(data));
    }
  });

  // Resize → a JSON CONTROL frame (distinct from the binary input frames).
  function sendResize() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  }
  term.onResize(function () { sendResize(); });
  window.addEventListener("resize", function () { doFit(); });

  reconnectBtn.addEventListener("click", function () {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    ensureToken().then(function () { connect(); });
  });

  sel.addEventListener("change", function () {
    term.reset();
    var url = new URL(window.location.href);
    url.searchParams.set("agent", sel.value);
    url.searchParams.delete("channel"); // migrate the legacy param name
    history.replaceState(null, "", url);
    connect();
  });

  // --- boot: list running AGENTS, then connect ----------------------------
  // The terminal attaches to an AGENT's tmux session (name-agent), so the picker
  // lists running agents (operator-gated /api/agents), NOT channels — an agent has
  // its own name, which isn't necessarily a configured channel. authedFetch (from
  // SHELL_JS) attaches the Bearer + retries once on 401.
  function requestedAgent() {
    var u = new URL(window.location.href);
    var p = u.searchParams.get("agent") || u.searchParams.get("channel") || "";
    var pathA = (location.pathname.match(/\\/terminal\\/([^/]+)/) || [])[1];
    if (pathA && pathA !== "assets") p = decodeURIComponent(pathA);
    return p;
  }
  function loadAgentsAndConnect() {
    return authedFetch(MOUNT + "/api/agents")
      .then(function (r) { if (!r.ok) throw new Error("agents " + r.status); return r.json(); })
      .then(function (j) {
        var names = (j.agents || []).map(function (a) { return a.name; });
        var want = requestedAgent();
        // Keep the requested agent selectable even if the list is momentarily
        // stale (e.g. just spawned) — the upgrade validates the session at attach.
        if (want && names.indexOf(want) < 0) names.unshift(want);
        if (!names.length) {
          setStatus("no agents running");
          showNotice("No agent sessions running. Spawn one on the " +
            "<a href='" + MOUNT + "/agents'>Agents</a> page, then reload.", false);
          return;
        }
        names.forEach(function (n) {
          var opt = document.createElement("option");
          opt.value = n; opt.textContent = n;
          if (n === want) opt.selected = true;
          sel.appendChild(opt);
        });
        connect();
      })
      .catch(function (err) {
        setStatus("agent list failed", "err");
        showNotice("Could not load agents (" + err + "). Open this page through the hub " +
          "portal signed in as the operator.", true);
      });
  }

  ensureToken().then(loadAgentsAndConnect);
  } // end boot()
})();
</script>
</body>
</html>`;
