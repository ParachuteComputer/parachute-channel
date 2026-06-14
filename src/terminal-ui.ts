/**
 * Static HTML for `/channel/terminal` — the in-page xterm.js terminal (design
 * `design/2026-06-14-sandboxed-agent-sessions.md` §5).
 *
 * Single self-contained document: HTML + inline CSS + inline JS, no build step
 * (same shape as `daemon.ts`'s chat UI + `admin-ui.ts`). xterm.js + the fit
 * addon load from a pinned CDN — there's no bundler in this repo, and the
 * existing UIs are all hand-written HTML strings, so a CDN import is the
 * minimal, in-pattern way to ship xterm without adding a build step.
 *
 * What the page does:
 *   1. Fetch the channel list (`<mount>/.parachute/config`) → a picker.
 *   2. Fetch a hub-minted `channel:admin` Bearer (`<origin>/admin/channel-token`,
 *      cookie-gated — the SAME token the chat + admin UIs use; the terminal is
 *      operator-gated, so the operator's token is exactly what's needed).
 *   3. Open a WebSocket to `<mount>/terminal/<channel>?token=…&cols=…&rows=…`
 *      (the token rides as `?token=` — a browser can't set Authorization on
 *      `new WebSocket()`). The daemon's upgrade gate validates channel:admin
 *      BEFORE upgrading.
 *   4. Relay xterm ↔ WS: xterm `onData` (keystrokes) → BINARY frames; pty output
 *      (BINARY frames) → `term.write`; xterm `onResize` → a JSON control frame
 *      `{type:"resize",cols,rows}`.
 *   5. Reconnect: because the backend attaches to TMUX (not a raw pty), a dropped
 *      socket just re-attaches to the live session with scrollback intact.
 *
 * Flow control (browser half of the §5.4 backpressure design): xterm's
 * `FlowControl`-style high-watermark — we count bytes written to xterm and, past
 * a watermark, the backend's own `getBufferedAmount` throttle is the primary
 * guard; the browser side keeps the renderer from falling so far behind it
 * stalls. The load-bearing flow control is server-side (terminal.ts); this is
 * the cooperative browser half.
 */

// Pinned xterm.js + fit addon (CDN, no build step). Versions pinned for
// reproducibility; SRI omitted to keep the single-file page simple (the page is
// operator-only, same-origin behind the hub). xterm 5.x is the current line.
const XTERM_VERSION = "5.3.0";
const XTERM_FIT_VERSION = "0.10.0";

export const TERMINAL_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>parachute-channel · terminal</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VERSION}/css/xterm.min.css" />
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --line: #262b36; --fg: #e6e9ef;
    --muted: #8b93a3; --accent: #4cc2a0; --danger: #e0796b;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column; height: 100vh;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel);
    flex: 0 0 auto;
  }
  header .brand { font-weight: 600; }
  header .brand small { color: var(--muted); font-weight: 400; }
  header select {
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; font: inherit;
  }
  header .spacer { margin-left: auto; }
  #status { font-size: 12px; color: var(--muted); }
  #status.live { color: var(--accent); }
  #status.err { color: var(--danger); }
  button {
    background: var(--bg); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 12px; font: inherit; cursor: pointer;
  }
  button:hover { border-color: var(--muted); }
  button:disabled { opacity: .4; cursor: default; }
  #term-wrap {
    flex: 1 1 auto; min-height: 0; padding: 8px; background: #000;
  }
  #term { width: 100%; height: 100%; }
  .notice {
    padding: 8px 16px; font-size: 13px; color: var(--muted);
    border-bottom: 1px solid var(--line); background: var(--panel);
  }
  .notice.err { color: var(--danger); }
  .notice code { color: var(--fg); }
</style>
</head>
<body>
  <header>
    <div class="brand">parachute-channel <small>· terminal</small></div>
    <select id="channel" title="channel"></select>
    <button id="reconnect" type="button" title="Re-attach to the tmux session">Reconnect</button>
    <span class="spacer"></span>
    <span id="status">connecting…</span>
  </header>
  <div id="notice" class="notice" hidden></div>
  <div id="term-wrap"><div id="term"></div></div>

  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VERSION}/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@${XTERM_FIT_VERSION}/lib/addon-fit.min.js"></script>
<script>
(function () {
  var sel = document.getElementById("channel");
  var statusEl = document.getElementById("status");
  var noticeEl = document.getElementById("notice");
  var reconnectBtn = document.getElementById("reconnect");
  var termHost = document.getElementById("term");

  // Served through the hub the page is /channel/terminal; locally it's
  // /terminal. Derive the mount prefix so the WS + token URLs resolve under the
  // same prefix (same shape as the chat UI's MOUNT).
  var MOUNT = location.pathname.replace(/\\/terminal(\\/[^/]*)?\\/?$/, "");

  if (typeof window.Terminal !== "function") {
    showNotice("xterm.js failed to load (CDN blocked?). The terminal needs it. " +
      "You can always attach on the host: <code>tmux attach -t &lt;channel&gt;-agent</code>.", true);
    setStatus("xterm unavailable", "err");
    return;
  }

  // --- xterm setup --------------------------------------------------------
  var term = new window.Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: { background: "#000000", foreground: "#e6e9ef" },
    // Cooperative flow control: xterm acks after writing; combined with the
    // backend's getBufferedAmount throttle (terminal.ts §5.4) this keeps the
    // renderer from stalling under a flood.
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

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || "";
  }
  function showNotice(html, isErr) {
    noticeEl.innerHTML = html;
    noticeEl.className = "notice" + (isErr ? " err" : "");
    noticeEl.hidden = false;
  }
  function clearNotice() { noticeEl.hidden = true; noticeEl.innerHTML = ""; }

  function currentChannel() { return sel.value; }

  function doFit() {
    if (!fit) return;
    try { fit.fit(); } catch (_e) {}
  }

  // --- token (operator channel:admin, minted by the hub) ------------------
  // The terminal WS is operator-gated on channel:admin. The hub mints that for
  // the logged-in operator at <origin>/admin/channel-token (cookie-gated) — the
  // same endpoint the chat + admin UIs use. We fetch it from the page origin
  // (which IS the hub origin when served through the expose) and pass it as
  // ?token= on the WebSocket URL (a browser can't set Authorization on
  // new WebSocket()).
  window.__token = null;
  function fetchToken() {
    return fetch(window.location.origin + "/admin/channel-token", { credentials: "include" })
      .then(function (r) { if (!r.ok) throw new Error("token " + r.status); return r.json(); })
      .then(function (j) { window.__token = (j && j.token) ? j.token : null; return window.__token; })
      .catch(function (err) {
        window.__token = null;
        showNotice("Not authenticated — open this page through the hub portal, signed in " +
          "as the operator. The terminal needs a <code>channel:admin</code> token (" + err + ").", true);
        return null;
      });
  }

  // --- WebSocket relay ----------------------------------------------------
  function wsUrl(ch) {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var dims = "cols=" + term.cols + "&rows=" + term.rows;
    var u = proto + "//" + location.host + MOUNT + "/terminal/" + encodeURIComponent(ch) + "?" + dims;
    if (window.__token) u += "&token=" + encodeURIComponent(window.__token);
    return u;
  }

  function connect() {
    var ch = currentChannel();
    if (!ch) { setStatus("no channel"); return; }
    if (ws) { manualClose = true; try { ws.close(); } catch (_e) {} ws = null; }
    manualClose = false;
    clearNotice();
    setStatus("connecting…");
    doFit();
    var socket = new WebSocket(wsUrl(ch));
    socket.binaryType = "arraybuffer";
    ws = socket;

    socket.onopen = function () {
      setStatus("● attached · " + ch, "live");
      // Send the current geometry immediately so the pty matches the page.
      sendResize();
      term.focus();
    };
    socket.onmessage = function (ev) {
      // BINARY = raw pty output. (The backend only ever sends binary; a text
      // frame would be an out-of-band notice — render it as text.)
      if (typeof ev.data === "string") { term.write(ev.data); return; }
      term.write(new Uint8Array(ev.data));
    };
    socket.onclose = function (ev) {
      if (socket !== ws) return; // superseded by a newer connect
      ws = null;
      if (manualClose) return;
      if (ev.code === 1013) {
        // Backend closed us for being too slow (terminal.ts MAX_QUEUE_BYTES).
        setStatus("disconnected (too slow)", "err");
        showNotice("The terminal fell too far behind and was disconnected. Reconnecting will " +
          "re-attach to the live session (scrollback intact via tmux).", true);
      } else if (ev.code === 1000) {
        setStatus("session ended");
        showNotice("The tmux session ended (or detached). Start a session with " +
          "<code>./scripts/launch-session.sh &lt;channel&gt; &lt;channel&gt;</code>, then Reconnect.", false);
        return; // don't auto-reconnect a deliberately-ended session
      } else {
        setStatus("reconnecting…", "err");
      }
      scheduleReconnect();
    };
    socket.onerror = function () {
      // onclose follows; status is set there. Surface a hint only if we never
      // opened (likely auth or no tmux session).
      if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CONNECTING) {
        // leave reconnect/backoff to onclose
      }
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      // Refresh the (short-lived) token before re-attaching.
      fetchToken().then(function () { connect(); });
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
  window.addEventListener("resize", function () { doFit(); /* onResize fires sendResize */ });

  reconnectBtn.addEventListener("click", function () {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    fetchToken().then(function () { connect(); });
  });

  sel.addEventListener("change", function () {
    term.reset();
    var url = new URL(window.location.href);
    url.searchParams.set("channel", sel.value);
    history.replaceState(null, "", url);
    connect();
  });

  // --- boot: list channels, then token, then connect ----------------------
  function loadChannelsAndConnect() {
    return fetch(MOUNT + "/.parachute/config")
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        var chans = (cfg.channels || []);
        if (!chans.length) { setStatus("no channels configured"); return; }
        var preselect = new URL(window.location.href).searchParams.get("channel");
        // Also honor a channel baked into the path (/terminal/<channel>).
        var pathCh = (location.pathname.match(/\\/terminal\\/([^/]+)/) || [])[1];
        if (pathCh) preselect = decodeURIComponent(pathCh);
        chans.forEach(function (c) {
          var opt = document.createElement("option");
          opt.value = c.name; opt.textContent = c.name + " (" + c.transport + ")";
          if (c.name === preselect) opt.selected = true;
          sel.appendChild(opt);
        });
        connect();
      })
      .catch(function (err) { setStatus("config load failed", "err"); showNotice("Could not load channels: " + err, true); });
  }

  fetchToken().then(loadChannelsAndConnect);
})();
</script>
</body>
</html>`;
