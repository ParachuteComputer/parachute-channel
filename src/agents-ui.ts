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

import { THEME_CSS, appShell, SHELL_JS } from "./ui-kit.ts";

export const AGENTS_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>parachute-channel · agents</title>
<style>
${THEME_CSS}
  /* ---- Agents page layout (page-specific, layered after the shared kit) ---- */
  .app-header { position: sticky; top: 0; z-index: 5; }
  body { padding-bottom: 48px; }
  main { max-width: 940px; margin: 0 auto; padding: 20px; display: grid; gap: 20px; }
  section {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px;
    box-shadow: 0 1px 2px rgba(44,42,38,0.04), 0 8px 24px rgba(44,42,38,0.06);
  }
  section h2 { margin: 0 0 4px; font-size: 1.2rem; }
  section p.hint { margin: 0 0 14px; color: var(--fg-muted); font-size: 0.85rem; }
  label { display: block; font-size: 0.78rem; color: var(--fg-muted); margin: 0 0 4px; }
  .row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .row > .grow { flex: 1 1 160px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grid3 { display: grid; grid-template-columns: 1.4fr 1fr 1.2fr; gap: 12px; }
  /* The agents page predates the kit's .btn classes; keep its bare <button>
     selectors working by mapping them onto the brand tokens. .primary/.danger/
     .ghost are page-local button modifiers (distinct from the kit's .btn-*). */
  button {
    background: var(--card); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 8px 14px; font: inherit; cursor: pointer;
  }
  button:hover { border-color: var(--fg-dim); }
  button:disabled { opacity: .4; cursor: default; }
  button.primary { background: var(--accent); color: #06140f; border-color: var(--accent); font-weight: 600; }
  button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  button.danger { color: var(--danger); border-color: var(--border); background: transparent; }
  button.danger:hover { border-color: var(--danger); background: var(--danger-soft); }
  button.ghost { padding: 4px 9px; font-size: 12px; background: transparent; border-color: transparent; color: var(--fg-muted); }
  button.ghost:hover { background: var(--bg-soft); color: var(--fg); }
  .pill.detached { color: var(--fg-dim); }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th { color: var(--fg-muted); font-weight: 500; font-size: 0.78rem; }
  td.actions { text-align: right; white-space: nowrap; }
  td.actions a, td.actions button { margin-left: 6px; }
  details { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 12px; }
  details summary { cursor: pointer; color: var(--fg-muted); font-size: 0.85rem; user-select: none; }
  details[open] summary { color: var(--fg); margin-bottom: 12px; }
  .sub { display: grid; gap: 12px; }
  .extra-channels { display: grid; gap: 8px; }
  .extra-channels .crow, .mounts-rows .mrow { display: flex; gap: 8px; align-items: center; }
  .extra-channels .crow select.ch-name { flex: 1 1 auto; }
  .extra-channels .crow select.ch-access { flex: 0 0 130px; }
  .mounts-rows { display: grid; gap: 8px; }
  .mounts-rows .mrow input { flex: 1 1 auto; }
  .mounts-rows .mrow select { flex: 0 0 90px; }
  .msg { margin-top: 12px; padding: 10px 12px; border-radius: 8px; font-size: 0.85rem; display: none; white-space: pre-wrap; border: 1px solid transparent; }
  .msg.ok { display: block; background: var(--success-soft); color: var(--success); border-color: var(--success); }
  .msg.err { display: block; background: var(--danger-soft); color: var(--danger); border-color: var(--danger); }
  code { font-family: var(--font-mono); color: var(--fg); background: var(--bg-soft); padding: 1px 5px; border-radius: 4px; font-size: 0.8rem; }
  .scopes { margin: 8px 0 0; font-size: 0.78rem; color: var(--fg-muted); }
  .empty { color: var(--fg-muted); font-size: 0.85rem; padding: 8px 2px; }
</style>
</head>
<body>
  ${appShell({ active: "agents", tag: "agents" })}

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
            <label for="fs-mode">Filesystem</label>
            <select id="fs-mode">
              <option value="workspace" selected>Sandboxed to its workspace (default) — can't read your files or secrets</option>
              <option value="full">Full read access — can read your whole disk (use with care)</option>
            </select>
            <div id="fs-warn" class="muted" style="display:none; font-size:12px; margin-top:8px;">
              Default: the agent reads only its own workspace + mounts + the claude runtime. Your home
              tree (including <code>~/.parachute/operator.token</code>, SSH keys, other projects) is
              unreadable. Writes are always confined to the workspace. Switch to Full read only when an
              agent genuinely needs to see across your disk and you trust it not to leak.
            </div>
          </div>

          <div>
            <label for="net-mode">Network</label>
            <select id="net-mode">
              <option value="open" selected>Open — full internet (default)</option>
              <option value="restricted">Restricted — Anthropic + hub/vault + listed hosts only (untrusted input)</option>
            </select>
            <div id="egress-wrap" style="display:none; margin-top:8px;">
              <label for="egress">Additional allowed hosts (comma-separated)</label>
              <input type="text" id="egress" placeholder="registry.npmjs.org, github.com" autocomplete="off" />
            </div>
            <div id="net-note" class="muted" style="display:none; font-size:12px; margin-top:8px;">
              Open is safe as the default because the workspace filesystem sandbox already keeps your
              secrets unreadable — open network can't exfiltrate what the agent can't see. Choose
              Restricted to also bound where an agent fed untrusted input can reach.
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
${SHELL_JS}
(function () {
  // MOUNT, setStatus, escapeHtml, fetchToken (caches on window.__token),
  // authedFetch all come from SHELL_JS. Wire the shared nav for the agents view.
  wireShell("agents");
  var knownChannels = [];

  // esc is the page-local name for the shared escapeHtml (used widely below).
  var esc = escapeHtml;

  function showMsg(el, text, isErr) {
    // textContent (NOT innerHTML) — server/result strings flow through here, so
    // this deliberately avoids needing esc(): the browser never parses them as HTML.
    el.textContent = text;
    el.className = "msg " + (isErr ? "err" : "ok");
  }
  function clearMsg(el) { el.textContent = ""; el.className = "msg"; }

  // --- token + API --------------------------------------------------------
  // fetchToken (SHELL_JS) mints + caches the channel:admin Bearer on
  // window.__token. api() is the agents-page JSON wrapper: it prefixes MOUNT,
  // attaches the Bearer + a JSON content-type, and retries once on 401.
  function api(path, opts, _retried) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (window.__token) headers["authorization"] = "Bearer " + window.__token;
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

  // Filesystem toggle: show the caution note only when Full read is selected.
  var fsMode = document.getElementById("fs-mode");
  function syncFsMode() {
    document.getElementById("fs-warn").style.display = fsMode.value === "full" ? "" : "none";
  }
  fsMode.addEventListener("change", syncFsMode);
  syncFsMode(); // default is workspace → note hidden

  // Network toggle: show the additional-hosts field only when Restricted; show the
  // "open is safe" note when Open (the default).
  var netMode = document.getElementById("net-mode");
  function syncNetMode() {
    var open = netMode.value === "open";
    document.getElementById("egress-wrap").style.display = open ? "none" : "";
    document.getElementById("net-note").style.display = open ? "" : "none";
  }
  netMode.addEventListener("change", syncNetMode);
  syncNetMode(); // default is open → show the note, hide the hosts field

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

    if (fsMode.value === "full") spec.filesystem = "full"; // else workspace (default)
    if (netMode.value === "restricted") {
      spec.network = "restricted";
      var egress = document.getElementById("egress").value.split(",").map(function (h) { return h.trim(); }).filter(Boolean);
      if (egress.length) spec.egress = egress;
    }
    // defaults (omitted): filesystem "workspace" (scoped reads) + network "open".

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
        lines.push("filesystem: " + (r.filesystem || "workspace") +
          (r.filesystem === "full" ? " (reads whole disk)" : " (sandboxed to workspace)"));
        lines.push("network: " + (r.network || "open") +
          (r.network === "restricted" ? " (egress: " + ((r.egress || []).join(", ") || "base only") + ")" : " (full internet)"));
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
  // The terminal attaches to an AGENT (its tmux session), so the link carries the
  // agent name as ?agent= (the terminal page also accepts the legacy ?channel=).
  function terminalUrl(agent) { return MOUNT + "/terminal?agent=" + encodeURIComponent(agent); }
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
