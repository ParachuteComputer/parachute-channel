/**
 * Static HTML for `/channel/agents` — the in-page agent management surface
 * (design `design/2026-06-14-sandboxed-agent-sessions.md` §4/§5; the web spawn
 * flow Aaron asked for: "this needs to work through the web interface since
 * that's really the default way of operating").
 *
 * Self-contained document (HTML + inline CSS + inline JS, no build step — the
 * same shape as `terminal-ui.ts` and `daemon.ts`'s chat UI). It drives the
 * daemon's `channel:admin`-gated JSON API:
 *
 *   - GET    /api/credentials/claude   → credential status (default set? overrides?)
 *   - POST   /api/credentials/claude   → set the default operator Claude token
 *   - POST   /api/credentials/claude/:channel  → per-channel override
 *   - DELETE /api/credentials/claude/:channel  → remove an override
 *   - GET    /api/agents               → list running agent sessions
 *   - POST   /api/agents               → spawn a sandboxed agent from a spec
 *   - DELETE /api/agents/:name         → kill a session
 *   - GET    /.parachute/config        → channel list (prefills the spawn form)
 *
 * Auth: the page loads OPEN (like /ui, /admin, /terminal) and then fetches a
 * hub-minted `channel:admin` Bearer from `<origin>/admin/channel-token`
 * (cookie-gated — the operator's logged-in portal session), attaching it to every
 * /api call. A launched session is the most powerful thing this module does, so
 * the whole surface is operator-gated on `channel:admin` — the SAME gate the
 * terminal uses.
 *
 * Token hygiene mirrors the rest of the module: the Claude OAuth token the
 * operator pastes is POSTed once and never read back (the status endpoint returns
 * names/presence only); the spawn result shows scopes/audiences but never the
 * minted token values.
 */

export const AGENTS_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>parachute-channel · agents</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --line: #262b36; --fg: #e6e9ef;
    --muted: #8b93a3; --accent: #4cc2a0; --danger: #e0796b; --warn: #d9b25f;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    padding-bottom: 48px;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel);
    position: sticky; top: 0; z-index: 5;
  }
  header .brand { font-weight: 600; }
  header .brand small { color: var(--muted); font-weight: 400; }
  header .spacer { margin-left: auto; }
  #status { font-size: 12px; color: var(--muted); }
  #status.live { color: var(--accent); }
  #status.err { color: var(--danger); }
  main { max-width: 920px; margin: 0 auto; padding: 20px; display: grid; gap: 20px; }
  section {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px;
  }
  section h2 { margin: 0 0 4px; font-size: 15px; }
  section p.hint { margin: 0 0 14px; color: var(--muted); font-size: 13px; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 0 0 4px; }
  input[type=text], input[type=password], select, textarea {
    width: 100%; background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; font: inherit;
  }
  textarea { resize: vertical; min-height: 56px; }
  .row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .row > .grow { flex: 1 1 160px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  button {
    background: var(--bg); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 8px 14px; font: inherit; cursor: pointer;
  }
  button:hover { border-color: var(--muted); }
  button:disabled { opacity: .4; cursor: default; }
  button.primary { background: var(--accent); color: #06140f; border-color: var(--accent); font-weight: 600; }
  button.danger { color: var(--danger); border-color: #3a2a2a; }
  button.danger:hover { border-color: var(--danger); }
  button.ghost { padding: 4px 9px; font-size: 12px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; border: 1px solid var(--line); }
  .pill.on { color: var(--accent); border-color: #244; }
  .pill.off { color: var(--warn); border-color: #443; }
  .pill.attached { color: var(--accent); border-color: #244; }
  .pill.detached { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  td.actions { text-align: right; white-space: nowrap; }
  td.actions a, td.actions button { margin-left: 6px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .channels-rows { display: grid; gap: 8px; margin-bottom: 8px; }
  .channels-rows .crow { display: flex; gap: 8px; align-items: center; }
  .channels-rows .crow input { flex: 1 1 auto; }
  .channels-rows .crow select { flex: 0 0 130px; }
  .mounts-rows { display: grid; gap: 8px; margin-bottom: 8px; }
  .mounts-rows .mrow { display: flex; gap: 8px; align-items: center; }
  .mounts-rows .mrow input { flex: 1 1 auto; }
  .mounts-rows .mrow select { flex: 0 0 90px; }
  .msg { margin-top: 12px; padding: 10px 12px; border-radius: 8px; font-size: 13px; display: none; white-space: pre-wrap; }
  .msg.ok { display: block; background: #11241d; color: var(--accent); border: 1px solid #244; }
  .msg.err { display: block; background: #241313; color: var(--danger); border: 1px solid #3a2a2a; }
  code { color: var(--fg); background: #0b0d11; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  details summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  .scopes { margin: 8px 0 0; font-size: 12px; color: var(--muted); }
  .scopes div { font-family: ui-monospace, Menlo, monospace; }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); font-size: 13px; padding: 8px 2px; }
</style>
</head>
<body>
  <header>
    <div class="brand">parachute-channel <small>· agents</small></div>
    <span class="spacer"></span>
    <span id="status">connecting…</span>
  </header>

  <main>
    <!-- Claude credential -->
    <section id="cred-section">
      <h2>Claude credential</h2>
      <p class="hint">A launched session runs on a Claude subscription token from
        <code>claude setup-token</code> (the 1-year headless auth) — injected per session, never your CLI login.
        Set a default once; override per channel if needed.</p>
      <div class="row">
        <span>Default credential: <span id="cred-default" class="pill off">checking…</span></span>
        <span class="spacer"></span>
      </div>
      <div id="cred-overrides" class="scopes"></div>
      <details style="margin-top:12px;">
        <summary>Set / rotate a credential</summary>
        <div style="margin-top:10px;" class="grid2">
          <div>
            <label for="cred-channel">Scope (blank = default/operator)</label>
            <input type="text" id="cred-channel" placeholder="channel name, or blank for default" />
          </div>
          <div>
            <label for="cred-token">Token (oat_… from <code>claude setup-token</code>)</label>
            <input type="password" id="cred-token" placeholder="oat_…" autocomplete="off" />
          </div>
        </div>
        <div class="row" style="margin-top:10px;">
          <button id="cred-save" class="primary" type="button">Save credential</button>
          <span class="muted" style="font-size:12px;">The token is stored 0600 and never shown again.</span>
        </div>
      </details>
      <div id="cred-msg" class="msg"></div>
    </section>

    <!-- Spawn -->
    <section id="spawn-section">
      <h2>Spawn an agent</h2>
      <p class="hint">Launches a sandboxed Claude Code session in tmux, scoped to the channels (and optional vault)
        you declare. Network egress is deny-by-default beyond the Anthropic API + your hub/vault; filesystem reads
        are scoped to the workspace + declared mounts.</p>
      <div class="grid2">
        <div>
          <label for="spawn-name">Name (slug)</label>
          <input type="text" id="spawn-name" placeholder="e.g. aaron" autocomplete="off" />
        </div>
        <div>
          <label>Channels <span class="muted">(first = wake channel)</span></label>
          <div id="channels-rows" class="channels-rows"></div>
          <button id="add-channel" class="ghost" type="button">+ channel</button>
        </div>
      </div>

      <details style="margin-top:14px;">
        <summary>Vault binding (optional)</summary>
        <div class="grid2" style="margin-top:10px;">
          <div>
            <label for="vault-name">Vault name</label>
            <input type="text" id="vault-name" placeholder="e.g. default (blank = no vault)" autocomplete="off" />
          </div>
          <div>
            <label for="vault-access">Access</label>
            <select id="vault-access">
              <option value="read">read</option>
              <option value="write">write</option>
              <option value="admin">admin</option>
            </select>
          </div>
        </div>
        <div style="margin-top:10px;">
          <label for="vault-tags">Tag scope (optional, comma-separated)</label>
          <input type="text" id="vault-tags" placeholder="e.g. #channel-message" autocomplete="off" />
        </div>
      </details>

      <details style="margin-top:12px;">
        <summary>Network egress (optional)</summary>
        <div style="margin-top:10px;">
          <label for="egress">Additional allowed hosts (comma-separated, beyond the base)</label>
          <input type="text" id="egress" placeholder="e.g. registry.npmjs.org, github.com" autocomplete="off" />
        </div>
      </details>

      <details style="margin-top:12px;">
        <summary>Filesystem mounts (optional)</summary>
        <div id="mounts-rows" class="mounts-rows" style="margin-top:10px;"></div>
        <button id="add-mount" class="ghost" type="button">+ mount</button>
      </details>

      <div class="row" style="margin-top:16px;">
        <button id="spawn-go" class="primary" type="button">Spawn agent</button>
        <span class="muted" id="spawn-note" style="font-size:12px;"></span>
      </div>
      <div id="spawn-msg" class="msg"></div>
    </section>

    <!-- Running agents -->
    <section id="agents-section">
      <div class="row" style="margin-bottom:10px;">
        <h2 style="margin:0;">Running agents</h2>
        <span class="spacer"></span>
        <button id="refresh" class="ghost" type="button">Refresh</button>
      </div>
      <div id="agents-table"></div>
    </section>
  </main>

<script>
(function () {
  // Served through the hub the page is /channel/agents; locally it's /agents.
  // Derive the mount prefix so the API + token URLs resolve under the same prefix
  // (same shape as the terminal + chat UIs).
  var MOUNT = location.pathname.replace(/\\/agents\\/?$/, "");
  var statusEl = document.getElementById("status");
  var TOKEN = null;

  function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = cls || ""; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function showMsg(el, text, isErr) {
    // textContent (NOT innerHTML) — server/result strings (session, workspace,
    // scopes, egress, error messages) flow through here, so this deliberately
    // avoids needing esc(): the browser never parses them as HTML.
    el.textContent = text;
    el.className = "msg " + (isErr ? "err" : "ok");
  }
  function clearMsg(el) { el.textContent = ""; el.className = "msg"; }

  // --- token (operator channel:admin, minted by the hub) ------------------
  function fetchToken() {
    return fetch(location.origin + "/admin/channel-token", { credentials: "include" })
      .then(function (r) { if (!r.ok) throw new Error("token " + r.status); return r.json(); })
      .then(function (j) { TOKEN = (j && j.token) ? j.token : null; return TOKEN; })
      .catch(function (err) {
        TOKEN = null;
        setStatus("not authenticated", "err");
        throw err;
      });
  }

  // Authed fetch against the daemon API. Retries ONCE on a 401 with a fresh token
  // (the channel:admin token is short-lived).
  function api(path, opts, _retried) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (TOKEN) headers["authorization"] = "Bearer " + TOKEN;
    if (opts.body && !headers["content-type"]) headers["content-type"] = "application/json";
    return fetch(MOUNT + path, Object.assign({}, opts, { headers: headers })).then(function (r) {
      if (r.status === 401 && !_retried) {
        return fetchToken().then(function () { return api(path, opts, true); });
      }
      return r;
    });
  }
  function apiJson(path, opts) {
    return api(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error((j && (j.message || j.error)) || ("HTTP " + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  // --- credential status --------------------------------------------------
  function loadCreds() {
    return apiJson("/api/credentials/claude").then(function (j) {
      var dflt = document.getElementById("cred-default");
      dflt.textContent = j.defaultSet ? "set" : "not set";
      dflt.className = "pill " + (j.defaultSet ? "on" : "off");
      var ov = document.getElementById("cred-overrides");
      if (j.channels && j.channels.length) {
        ov.innerHTML = "<div style='margin-top:8px;'>Per-channel overrides:</div>" +
          j.channels.map(function (c) {
            return "<div style='margin-top:4px;'>" + esc(c) +
              " <button class='ghost danger' data-cred-rm='" + esc(c) + "' type='button'>remove</button></div>";
          }).join("");
        ov.querySelectorAll("[data-cred-rm]").forEach(function (btn) {
          btn.addEventListener("click", function () { removeCred(btn.getAttribute("data-cred-rm")); });
        });
      } else {
        ov.innerHTML = "";
      }
      updateSpawnNote(j.defaultSet, j.channels || []);
      return j;
    }).catch(function (err) {
      document.getElementById("cred-default").textContent = "unknown (" + err.message + ")";
    });
  }

  function updateSpawnNote(defaultSet, overrides) {
    var note = document.getElementById("spawn-note");
    if (!defaultSet && (!overrides || !overrides.length)) {
      note.textContent = "⚠ no Claude credential set — spawn will fail until you set one above.";
      note.style.color = "var(--warn)";
    } else {
      note.textContent = "";
    }
  }

  document.getElementById("cred-save").addEventListener("click", function () {
    var msg = document.getElementById("cred-msg");
    clearMsg(msg);
    var channel = document.getElementById("cred-channel").value.trim();
    var token = document.getElementById("cred-token").value;
    if (!token) { showMsg(msg, "Paste a token first.", true); return; }
    var path = channel ? "/api/credentials/claude/" + encodeURIComponent(channel) : "/api/credentials/claude";
    apiJson(path, { method: "POST", body: JSON.stringify({ token: token }) }).then(function () {
      document.getElementById("cred-token").value = "";
      showMsg(msg, channel ? ("Saved override for channel \\"" + channel + "\\".") : "Saved default credential.", false);
      loadCreds();
    }).catch(function (err) { showMsg(msg, "Failed: " + err.message, true); });
  });

  function removeCred(channel) {
    var msg = document.getElementById("cred-msg");
    clearMsg(msg);
    apiJson("/api/credentials/claude/" + encodeURIComponent(channel), { method: "DELETE" }).then(function () {
      showMsg(msg, "Removed override for \\"" + channel + "\\".", false);
      loadCreds();
    }).catch(function (err) { showMsg(msg, "Failed: " + err.message, true); });
  }

  // --- spawn form: channel + mount rows -----------------------------------
  var knownChannels = [];
  function channelRow(value, access) {
    var div = document.createElement("div");
    div.className = "crow";
    var list = knownChannels.map(function (c) { return "<option value='" + esc(c) + "'>"; }).join("");
    div.innerHTML =
      "<input type='text' class='ch-name' placeholder='channel name' list='known-channels' value='" + esc(value || "") + "' />" +
      "<select class='ch-access'>" +
        "<option value='write'" + (access === "read" ? "" : " selected") + ">read+write</option>" +
        "<option value='read'" + (access === "read" ? " selected" : "") + ">read only</option>" +
      "</select>" +
      "<button class='ghost' type='button' title='remove'>✕</button>";
    div.querySelector("button").addEventListener("click", function () { div.remove(); });
    document.getElementById("channels-rows").appendChild(div);
    return div;
  }
  document.getElementById("add-channel").addEventListener("click", function () { channelRow("", "write"); });

  function mountRow() {
    var div = document.createElement("div");
    div.className = "mrow";
    div.innerHTML =
      "<input type='text' class='mt-host' placeholder='host path (/abs/path)' />" +
      "<input type='text' class='mt-mount' placeholder='mount path (/abs/path)' />" +
      "<select class='mt-mode'><option value='ro'>ro</option><option value='rw'>rw</option></select>" +
      "<button class='ghost' type='button' title='remove'>✕</button>";
    div.querySelector("button").addEventListener("click", function () { div.remove(); });
    document.getElementById("mounts-rows").appendChild(div);
    return div;
  }
  document.getElementById("add-mount").addEventListener("click", function () { mountRow(); });

  function collectSpec() {
    var name = document.getElementById("spawn-name").value.trim();
    if (!name) throw new Error("name is required");
    var channels = [];
    document.querySelectorAll("#channels-rows .crow").forEach(function (row) {
      var n = row.querySelector(".ch-name").value.trim();
      if (!n) return;
      channels.push({ name: n, access: row.querySelector(".ch-access").value });
    });
    if (!channels.length) throw new Error("at least one channel is required (the first is the wake channel)");
    var spec = { name: name, channels: channels };

    var vn = document.getElementById("vault-name").value.trim();
    if (vn) {
      var v = { name: vn, access: document.getElementById("vault-access").value };
      var tags = document.getElementById("vault-tags").value.split(",").map(function (t) { return t.trim(); }).filter(Boolean);
      if (tags.length) v.tags = tags;
      spec.vault = v;
    }

    var egress = document.getElementById("egress").value.split(",").map(function (h) { return h.trim(); }).filter(Boolean);
    if (egress.length) spec.egress = egress;

    var mounts = [];
    document.querySelectorAll("#mounts-rows .mrow").forEach(function (row) {
      var host = row.querySelector(".mt-host").value.trim();
      var mount = row.querySelector(".mt-mount").value.trim();
      if (!host || !mount) return;
      mounts.push({ hostPath: host, mountPath: mount, mode: row.querySelector(".mt-mode").value });
    });
    if (mounts.length) spec.mounts = mounts;
    return spec;
  }

  document.getElementById("spawn-go").addEventListener("click", function () {
    var msg = document.getElementById("spawn-msg");
    clearMsg(msg);
    var spec;
    try { spec = collectSpec(); } catch (e) { showMsg(msg, e.message, true); return; }
    var btn = document.getElementById("spawn-go");
    btn.disabled = true; btn.textContent = "Spawning…";
    apiJson("/api/agents", { method: "POST", body: JSON.stringify(spec) }).then(function (r) {
      var lines = [];
      if (r.alreadyRunning) {
        lines.push("Session \\"" + r.session + "\\" is already running (no-op).");
      } else {
        lines.push("Launched \\"" + r.session + "\\".");
        lines.push("workspace: " + r.workspace);
        if (r.tokens && r.tokens.length) {
          lines.push("scopes:");
          r.tokens.forEach(function (t) { lines.push("  " + t.resource + " → " + t.scope); });
        }
        if (r.mcpServers && r.mcpServers.length) lines.push("MCP servers: " + r.mcpServers.join(", "));
        if (r.egress && r.egress.length) lines.push("egress: " + r.egress.join(", "));
      }
      showMsg(msg, lines.join("\\n"), false);
      loadAgents();
    }).catch(function (err) {
      showMsg(msg, "Spawn failed: " + err.message, true);
    }).then(function () {
      btn.disabled = false; btn.textContent = "Spawn agent";
    });
  });

  // --- running agents list ------------------------------------------------
  function terminalUrl(channel) {
    return MOUNT + "/terminal?channel=" + encodeURIComponent(channel);
  }
  function loadAgents() {
    return apiJson("/api/agents").then(function (j) {
      var host = document.getElementById("agents-table");
      var agents = j.agents || [];
      if (!agents.length) {
        host.innerHTML = "<div class='empty'>No agent sessions running. Spawn one above.</div>";
        return;
      }
      var rows = agents.map(function (a) {
        var att = a.attached
          ? "<span class='pill attached'>attached</span>"
          : "<span class='pill detached'>idle</span>";
        return "<tr>" +
          "<td><strong>" + esc(a.name) + "</strong></td>" +
          "<td><code>" + esc(a.session) + "</code></td>" +
          "<td>" + att + "</td>" +
          "<td class='actions'>" +
            "<a href='" + esc(terminalUrl(a.name)) + "' target='_blank' rel='noopener'>terminal ↗</a>" +
            "<button class='ghost danger' data-kill='" + esc(a.name) + "' type='button'>kill</button>" +
          "</td></tr>";
      }).join("");
      host.innerHTML = "<table><thead><tr><th>Agent</th><th>tmux session</th><th>State</th><th></th></tr></thead><tbody>" +
        rows + "</tbody></table>";
      host.querySelectorAll("[data-kill]").forEach(function (btn) {
        btn.addEventListener("click", function () { killAgent(btn.getAttribute("data-kill")); });
      });
    }).catch(function (err) {
      document.getElementById("agents-table").innerHTML = "<div class='empty'>Could not load agents: " + esc(err.message) + "</div>";
    });
  }

  function killAgent(name) {
    // name is a server-enforced slug (alphanumeric/dash/underscore, agents.ts),
    // so it carries no HTML/JS-special chars in the confirm string; it's
    // encodeURI'd into the request path regardless.
    if (!confirm("Kill agent \\"" + name + "\\"? This ends its tmux session.")) return;
    apiJson("/api/agents/" + encodeURIComponent(name), { method: "DELETE" }).then(function () {
      loadAgents();
    }).catch(function (err) { alert("Kill failed: " + err.message); });
  }

  document.getElementById("refresh").addEventListener("click", function () { loadAgents(); });

  // --- channels (prefill the spawn form) ----------------------------------
  function loadChannels() {
    return fetch(MOUNT + "/.parachute/config").then(function (r) { return r.json(); }).then(function (cfg) {
      knownChannels = (cfg.channels || []).map(function (c) { return c.name; });
      var dl = document.getElementById("known-channels");
      dl.innerHTML = knownChannels.map(function (c) { return "<option value='" + esc(c) + "'>"; }).join("");
      // Seed one channel row (prefilled with the first known channel, if any).
      if (!document.querySelector("#channels-rows .crow")) {
        channelRow(knownChannels[0] || "", "write");
      }
    }).catch(function () { channelRow("", "write"); });
  }

  // --- boot ---------------------------------------------------------------
  setStatus("authenticating…");
  fetchToken().then(function () {
    setStatus("● ready", "live");
    return Promise.all([loadChannels(), loadCreds(), loadAgents()]);
  }).then(function () {
    // Poll the running list so kills/exits elsewhere reflect here.
    setInterval(loadAgents, 5000);
  }).catch(function (err) {
    setStatus("not authenticated", "err");
    var msg = document.getElementById("spawn-msg");
    showMsg(msg, "Open this page through the hub portal, signed in as the operator. " +
      "The agents surface needs a channel:admin token (" + err.message + ").", true);
  });
})();
</script>
<datalist id="known-channels"></datalist>
</body>
</html>`;
