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
 *   - POST   /api/credentials/claude[/:channel]  → set default / per-channel token
 *   - DELETE /api/credentials/claude/:channel    → remove an override
 *   - GET    /api/agents               → list running agent sessions
 *   - POST   /api/agents               → spawn a sandboxed agent from a spec
 *   - DELETE /api/agents/:name         → kill a session
 *   - GET    /api/vaults               → installed vault instances (the picker)
 *   - GET    /.parachute/config        → channel list (the picker)
 *
 * UX: the DEFAULT flow is one-agent-one-channel — pick a channel, the agent name
 * auto-fills from it, click Spawn. Everything else (extra channels, vault binding,
 * network mode, mounts) lives under "Advanced" for the dynamic cases.
 *
 * Auth: loads OPEN (like /ui, /admin, /terminal), then fetches a hub-minted
 * `channel:admin` Bearer from `<origin>/admin/channel-token` and attaches it to
 * every /api call. Token hygiene: the pasted Claude token is POSTed once and never
 * read back; the spawn result shows scopes but never minted token values.
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
    display: flex; align-items: center; gap: 14px;
    padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel);
    position: sticky; top: 0; z-index: 5;
  }
  header .brand { font-weight: 600; }
  header .brand small { color: var(--muted); font-weight: 400; }
  header nav { display: flex; gap: 12px; }
  header nav a { color: var(--muted); text-decoration: none; font-size: 13px; }
  header nav a:hover { color: var(--fg); text-decoration: underline; }
  header .spacer { margin-left: auto; }
  #status { font-size: 12px; color: var(--muted); }
  #status.live { color: var(--accent); }
  #status.err { color: var(--danger); }
  main { max-width: 940px; margin: 0 auto; padding: 20px; display: grid; gap: 20px; }
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
  .row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .row > .grow { flex: 1 1 160px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grid3 { display: grid; grid-template-columns: 1.4fr 1fr 1.2fr; gap: 12px; }
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
  details { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; }
  details summary { cursor: pointer; color: var(--muted); font-size: 13px; user-select: none; }
  details[open] summary { color: var(--fg); margin-bottom: 12px; }
  .sub { display: grid; gap: 12px; }
  .extra-channels { display: grid; gap: 8px; }
  .extra-channels .crow, .mounts-rows .mrow { display: flex; gap: 8px; align-items: center; }
  .extra-channels .crow select.ch-name { flex: 1 1 auto; }
  .extra-channels .crow select.ch-access { flex: 0 0 130px; }
  .mounts-rows { display: grid; gap: 8px; }
  .mounts-rows .mrow input { flex: 1 1 auto; }
  .mounts-rows .mrow select { flex: 0 0 90px; }
  .msg { margin-top: 12px; padding: 10px 12px; border-radius: 8px; font-size: 13px; display: none; white-space: pre-wrap; }
  .msg.ok { display: block; background: #11241d; color: var(--accent); border: 1px solid #244; }
  .msg.err { display: block; background: #241313; color: var(--danger); border: 1px solid #3a2a2a; }
  code { color: var(--fg); background: #0b0d11; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .scopes { margin: 8px 0 0; font-size: 12px; color: var(--muted); }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); font-size: 13px; padding: 8px 2px; }
  .warnbox { color: var(--warn); font-size: 12px; }
</style>
</head>
<body>
  <header>
    <div class="brand">parachute-channel <small>· agents</small></div>
    <nav>
      <a id="nav-chat" href="#">Chat</a>
      <a id="nav-terminal" href="#">Terminal</a>
      <a id="nav-config" href="#">Config</a>
    </nav>
    <span class="spacer"></span>
    <span id="status">connecting…</span>
  </header>

  <main>
    <!-- Claude credential -->
    <section id="cred-section">
      <h2>Claude credential</h2>
      <p class="hint">A launched session runs on a Claude subscription token from
        <code>claude setup-token</code> — injected per session, never your CLI login.
        Set a default once; override per channel if needed.</p>
      <div class="row">
        <span>Default credential: <span id="cred-default" class="pill off">checking…</span></span>
      </div>
      <div id="cred-overrides" class="scopes"></div>
      <details>
        <summary>Set / rotate a credential</summary>
        <div class="sub">
          <div class="grid2">
            <div>
              <label for="cred-channel">Scope (blank = default/operator)</label>
              <input type="text" id="cred-channel" placeholder="channel name, or blank for default" />
            </div>
            <div>
              <label for="cred-token">Token (oat_… from <code>claude setup-token</code>)</label>
              <input type="password" id="cred-token" placeholder="oat_…" autocomplete="off" />
            </div>
          </div>
          <div class="row">
            <button id="cred-save" class="primary" type="button">Save credential</button>
            <span class="muted" style="font-size:12px;">Stored 0600, never shown again.</span>
          </div>
        </div>
      </details>
      <div id="cred-msg" class="msg"></div>
    </section>

    <!-- Spawn -->
    <section id="spawn-section">
      <h2>Spawn an agent</h2>
      <p class="hint">Launches a sandboxed Claude Code session in tmux, wired to a channel.
        The common case is one agent per channel — pick a channel and spawn. Open Advanced for
        extra channels, a vault, network, or mounts.</p>

      <div class="grid3">
        <div>
          <label for="spawn-channel">Channel <span class="muted">(wake)</span></label>
          <select id="spawn-channel"></select>
        </div>
        <div>
          <label for="spawn-access">Access</label>
          <select id="spawn-access">
            <option value="write" selected>read+write</option>
            <option value="read">read only</option>
          </select>
        </div>
        <div>
          <label for="spawn-name">Agent name</label>
          <input type="text" id="spawn-name" placeholder="(defaults to channel)" autocomplete="off" />
        </div>
      </div>

      <details id="advanced">
        <summary>Advanced — extra channels, vault, network, mounts</summary>
        <div class="sub">
          <div>
            <label>Additional channels <span class="muted">(beyond the wake channel above)</span></label>
            <div id="extra-channels" class="extra-channels"></div>
            <button id="add-channel" class="ghost" type="button" style="margin-top:8px;">+ channel</button>
          </div>

          <div class="grid3">
            <div>
              <label for="vault-name">Vault</label>
              <select id="vault-name"><option value="">(no vault)</option></select>
            </div>
            <div>
              <label for="vault-access">Vault access</label>
              <select id="vault-access">
                <option value="read">read</option>
                <option value="write">write</option>
                <option value="admin">admin</option>
              </select>
            </div>
            <div>
              <label for="vault-tags">Tag scope (optional)</label>
              <input type="text" id="vault-tags" placeholder="#channel-message, …" autocomplete="off" />
            </div>
          </div>

          <div>
            <label for="net-mode">Network</label>
            <select id="net-mode">
              <option value="restricted" selected>Restricted — Anthropic API + hub/vault + listed hosts</option>
              <option value="open">Open — allow ALL network (trusted sessions only)</option>
            </select>
            <div id="egress-wrap" style="margin-top:8px;">
              <label for="egress">Additional allowed hosts (comma-separated)</label>
              <input type="text" id="egress" placeholder="registry.npmjs.org, github.com" autocomplete="off" />
            </div>
            <div id="open-warn" class="warnbox" style="display:none; margin-top:8px;">
              ⚠ Open network removes egress confinement — anything the session can reach, it can send to.
              Use only for sessions you trust.
            </div>
          </div>

          <div>
            <label>Filesystem mounts</label>
            <div id="mounts-rows" class="mounts-rows"></div>
            <button id="add-mount" class="ghost" type="button" style="margin-top:8px;">+ mount</button>
          </div>
        </div>
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
  // Served through the hub the page is /channel/agents; locally /agents. Derive
  // the mount prefix so API + token + nav URLs resolve under the same prefix.
  var MOUNT = location.pathname.replace(/\\/agents\\/?$/, "");
  var statusEl = document.getElementById("status");
  var TOKEN = null;
  var knownChannels = [];

  // Wire nav links under the same mount.
  document.getElementById("nav-chat").href = MOUNT + "/ui";
  document.getElementById("nav-terminal").href = MOUNT + "/terminal";
  document.getElementById("nav-config").href = MOUNT + "/admin";

  function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = cls || ""; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function showMsg(el, text, isErr) {
    // textContent (NOT innerHTML) — server/result strings flow through here, so
    // this deliberately avoids needing esc(): the browser never parses them as HTML.
    el.textContent = text;
    el.className = "msg " + (isErr ? "err" : "ok");
  }
  function clearMsg(el) { el.textContent = ""; el.className = "msg"; }

  // --- token (operator channel:admin, minted by the hub) ------------------
  function fetchToken() {
    return fetch(location.origin + "/admin/channel-token", { credentials: "include" })
      .then(function (r) { if (!r.ok) throw new Error("token " + r.status); return r.json(); })
      .then(function (j) { TOKEN = (j && j.token) ? j.token : null; return TOKEN; })
      .catch(function (err) { TOKEN = null; setStatus("not authenticated", "err"); throw err; });
  }

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
      } else { ov.innerHTML = ""; }
      updateSpawnNote(j.defaultSet, j.channels || []);
      return j;
    }).catch(function (err) {
      document.getElementById("cred-default").textContent = "unknown (" + err.message + ")";
    });
  }

  function updateSpawnNote(defaultSet, overrides) {
    var note = document.getElementById("spawn-note");
    if (!defaultSet && (!overrides || !overrides.length)) {
      note.textContent = "⚠ no Claude credential set — set one above before spawning.";
      note.style.color = "var(--warn)";
    } else { note.textContent = ""; }
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
      showMsg(msg, channel ? ("Saved override for channel " + channel + ".") : "Saved default credential.", false);
      loadCreds();
    }).catch(function (err) { showMsg(msg, "Failed: " + err.message, true); });
  });

  function removeCred(channel) {
    var msg = document.getElementById("cred-msg");
    clearMsg(msg);
    apiJson("/api/credentials/claude/" + encodeURIComponent(channel), { method: "DELETE" }).then(function () {
      showMsg(msg, "Removed override for " + channel + ".", false);
      loadCreds();
    }).catch(function (err) { showMsg(msg, "Failed: " + err.message, true); });
  }

  // --- spawn form ---------------------------------------------------------
  function channelOptions(selected) {
    return knownChannels.map(function (c) {
      return "<option value='" + esc(c) + "'" + (c === selected ? " selected" : "") + ">" + esc(c) + "</option>";
    }).join("");
  }

  // Auto-fill the name from the chosen wake channel until the operator edits it.
  var nameEdited = false;
  var nameEl = document.getElementById("spawn-name");
  var chanEl = document.getElementById("spawn-channel");
  nameEl.addEventListener("input", function () { nameEdited = true; });
  chanEl.addEventListener("change", function () {
    if (!nameEdited) nameEl.value = chanEl.value;
  });

  function extraChannelRow() {
    var div = document.createElement("div");
    div.className = "crow";
    div.innerHTML =
      "<select class='ch-name'>" + channelOptions("") + "</select>" +
      "<select class='ch-access'><option value='write'>read+write</option><option value='read'>read only</option></select>" +
      "<button class='ghost' type='button' title='remove'>✕</button>";
    div.querySelector("button").addEventListener("click", function () { div.remove(); });
    document.getElementById("extra-channels").appendChild(div);
  }
  document.getElementById("add-channel").addEventListener("click", function () { extraChannelRow(); });

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
  }
  document.getElementById("add-mount").addEventListener("click", function () { mountRow(); });

  // Network mode toggle: show host list only when restricted; warn when open.
  var netMode = document.getElementById("net-mode");
  netMode.addEventListener("change", function () {
    var open = netMode.value === "open";
    document.getElementById("egress-wrap").style.display = open ? "none" : "";
    document.getElementById("open-warn").style.display = open ? "" : "none";
  });

  function collectSpec() {
    var wake = chanEl.value;
    if (!wake) throw new Error("pick a channel");
    var name = nameEl.value.trim() || wake;
    var channels = [{ name: wake, access: document.getElementById("spawn-access").value }];
    document.querySelectorAll("#extra-channels .crow").forEach(function (row) {
      var n = row.querySelector(".ch-name").value;
      if (!n) return;
      channels.push({ name: n, access: row.querySelector(".ch-access").value });
    });
    var spec = { name: name, channels: channels };

    var vn = document.getElementById("vault-name").value;
    if (vn) {
      var v = { name: vn, access: document.getElementById("vault-access").value };
      var tags = document.getElementById("vault-tags").value.split(",").map(function (t) { return t.trim(); }).filter(Boolean);
      if (tags.length) v.tags = tags;
      spec.vault = v;
    }

    if (netMode.value === "open") {
      spec.egressUnrestricted = true;
    } else {
      var egress = document.getElementById("egress").value.split(",").map(function (h) { return h.trim(); }).filter(Boolean);
      if (egress.length) spec.egress = egress;
    }

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
        lines.push("Session " + r.session + " is already running (no-op).");
      } else {
        lines.push("Launched " + r.session + ".");
        lines.push("workspace: " + r.workspace);
        if (r.tokens && r.tokens.length) {
          lines.push("scopes:");
          r.tokens.forEach(function (t) { lines.push("  " + t.resource + " → " + t.scope); });
        }
        if (r.mcpServers && r.mcpServers.length) lines.push("MCP servers: " + r.mcpServers.join(", "));
        lines.push("network: " + (r.egressUnrestricted ? "OPEN (all hosts)" : ((r.egress || []).join(", ") || "base only")));
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
  function terminalUrl(channel) { return MOUNT + "/terminal?channel=" + encodeURIComponent(channel); }
  function loadAgents() {
    return apiJson("/api/agents").then(function (j) {
      var host = document.getElementById("agents-table");
      var agents = j.agents || [];
      if (!agents.length) {
        host.innerHTML = "<div class='empty'>No agent sessions running. Spawn one above.</div>";
        return;
      }
      var rows = agents.map(function (a) {
        var att = a.attached ? "<span class='pill attached'>attached</span>" : "<span class='pill detached'>idle</span>";
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
    // name is a server-enforced slug (alphanumeric/dash/underscore, agents.ts), so
    // it carries no HTML/JS-special chars in the confirm string; encodeURI'd anyway.
    if (!confirm("Kill agent " + name + "? This ends its tmux session.")) return;
    apiJson("/api/agents/" + encodeURIComponent(name), { method: "DELETE" }).then(function () {
      loadAgents();
    }).catch(function (err) { alert("Kill failed: " + err.message); });
  }
  document.getElementById("refresh").addEventListener("click", function () { loadAgents(); });

  // --- pickers: channels + vaults -----------------------------------------
  function loadChannels() {
    return fetch(MOUNT + "/.parachute/config").then(function (r) { return r.json(); }).then(function (cfg) {
      knownChannels = (cfg.channels || []).map(function (c) { return c.name; });
      chanEl.innerHTML = knownChannels.length
        ? channelOptions(knownChannels[0])
        : "<option value=''>(no channels — add one in Config)</option>";
      if (knownChannels.length && !nameEdited) nameEl.value = knownChannels[0];
    }).catch(function () {
      chanEl.innerHTML = "<option value=''>(channel list failed)</option>";
    });
  }
  function loadVaults() {
    return apiJson("/api/vaults").then(function (j) {
      var vaults = j.vaults || [];
      var sel = document.getElementById("vault-name");
      sel.innerHTML = "<option value=''>(no vault)</option>" +
        vaults.map(function (v) { return "<option value='" + esc(v) + "'>" + esc(v) + "</option>"; }).join("");
    }).catch(function () { /* leave the (no vault) default */ });
  }

  // --- boot ---------------------------------------------------------------
  setStatus("authenticating…");
  fetchToken().then(function () {
    setStatus("● ready", "live");
    return Promise.all([loadChannels(), loadVaults(), loadCreds(), loadAgents()]);
  }).then(function () {
    setInterval(loadAgents, 5000);
  }).catch(function (err) {
    setStatus("not authenticated", "err");
    showMsg(document.getElementById("spawn-msg"),
      "Open this page through the hub portal, signed in as the operator. " +
      "The agents surface needs a channel:admin token (" + err.message + ").", true);
  });
})();
</script>
</body>
</html>`;
