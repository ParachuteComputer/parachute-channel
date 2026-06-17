/**
 * Static HTML for `/agent/agents` — the PRIMARY "Agents" surface: the unified
 * **create-an-agent** flow (Phase-1 consolidation,
 * `design/2026-06-17-parachute-agent-blueprint.md` §Sequencing step 1).
 *
 * The blueprint collapses today's TWO steps — create-channel (the Config page),
 * then spawn-agent-on-it (this page) — into ONE form: you "configure an agent,
 * then talk to it" (agent ≡ channel, 1:1). The default UX is minimal:
 *
 *     Agent name → Vault (auto-selected if exactly one) → optional System prompt → Create
 *
 * One submit (a) provisions the (vault) channel of that name if it doesn't already
 * exist, then (b) spawns a PROGRAMMATIC agent on it, then (c) lands the operator in
 * chat (`/ui?channel=<name>`). Vault is the default transport; programmatic is the
 * default backend.
 *
 * CLIENT-SIDE ORCHESTRATION (the load-bearing decision): the channel half reuses
 * the EXISTING provisioning paths via the shared `PROVISION_JS`
 * (`src/provision-agent.ts`) — the SAME hub-mediated `/admin/connections` vault
 * flow + `/api/channels` telegram/http-ui flow the Config page runs. The channel
 * daemon does NOT mint vault tokens (it lacks hub authority); the hub does, exactly
 * as on the Config page. No new `/api/agents` fields — the form posts the same body
 * `buildSpecFromBody` already accepts.
 *
 * Advanced disclosure reveals the dynamic cases: use an EXISTING channel (skip
 * provisioning), transport telegram / http-ui (with config), the interactive
 * backend, system-prompt mode, extra channels, vault tags/access, filesystem,
 * network, egress, working directory, mounts.
 *
 * Self-contained document (HTML + inline CSS + inline JS, no build step — the same
 * shape as `terminal-ui.ts` / `home-ui.ts` / `daemon.ts`'s chat UI). It drives the
 * daemon's `agent:admin`-gated JSON API + the hub Connections engine:
 *
 *   - GET    /api/credentials/claude   → credential status (default set? overrides?)
 *   - POST   /api/credentials/claude[/:channel]  → set default / per-channel token
 *   - DELETE /api/credentials/claude/:channel    → remove an override
 *   - GET    /api/credentials/env      → per-channel env-var NAMES (values redacted)
 *   - POST   /api/credentials/env      → set an env var ({ channel?, name, value })
 *   - DELETE /api/credentials/env      → remove an env var ({ channel?, name })
 *   - GET    /api/agents               → list running agent sessions
 *   - POST   /api/agents               → spawn a sandboxed agent from a spec
 *   - POST   /api/agents/:name/restart → per-session restart (re-source env + reconnect)
 *   - DELETE /api/agents/:name         → kill a session
 *   - GET    /api/vaults               → installed vault instances (advanced vault binding)
 *   - GET    /api/channels             → existing channels (the Advanced "use existing" picker + idempotency)
 *   - POST   <origin>/admin/connections → hub-mediated vault-channel provisioning
 *   - GET    <origin>/.well-known/parachute.json → installed vaults (the default Vault picker)
 *   - GET    /.parachute/config        → channel list
 *   - GET    /health                   → live per-channel connection status (mcp_sessions)
 *
 * Auth: loads OPEN (like /ui, /admin, /terminal), then fetches a hub-minted
 * `agent:admin` Bearer from `<origin>/admin/agent-token` and attaches it to the
 * daemon `/api` calls; the vault provisioning path uses the operator's hub SESSION
 * COOKIE (credentials:"include"), not this token. Token hygiene: the pasted Claude
 * token is POSTed once and never read back; the spawn result shows scopes but never
 * minted token values.
 *
 * Vocabulary: an AGENT is the configured, vault-backed Claude actor; a CHANNEL is
 * the messaging pipe it wakes on. In the default vault flow they are 1:1 (the agent
 * IS its channel) — the blueprint's "agent ≡ channel".
 */

import { THEME_CSS, appShell, SHELL_JS } from "./ui-kit.ts";
import { PROVISION_JS } from "./provision-agent.ts";

export const AGENTS_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>parachute-agent · agents</title>
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
  /* The primary Create button — a touch larger than the page's default button. */
  button.create { padding: 10px 22px; font-size: 0.95rem; }
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
  .sub-group { border: 1px solid var(--border-light); border-radius: 8px; padding: 12px 14px; display: grid; gap: 12px; }
  .sub-group > .sub-title { font-size: 0.82rem; font-weight: 600; color: var(--fg); margin: 0; }
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
  /* Env-var chips: name + inline remove, grouped per scope. */
  .env-block { margin: 6px 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .env-scope { font-size: 0.78rem; color: var(--fg-muted); font-weight: 500; }
  .env-chip { display: inline-flex; align-items: center; gap: 2px; background: var(--bg-soft); border: 1px solid var(--border); border-radius: 6px; padding: 2px 4px 2px 8px; }
  .env-chip code { background: transparent; padding: 0; font-size: 0.8rem; }
  .env-chip button { padding: 0 6px; font-size: 14px; line-height: 1; }
  /* Connection-status pill on the running-agents list (mcp_sessions from /health). */
  .pill.connected { color: var(--success); }
  .pill.idle-conn { color: var(--fg-dim); }
  .field-row { margin-top: 12px; }
  .field-row textarea {
    width: 100%; box-sizing: border-box; font: inherit; padding: 8px 10px;
    border: 1px solid var(--border); border-radius: 6px; background: var(--card);
    color: var(--fg); resize: vertical;
  }
</style>
</head>
<body>
  ${appShell({ active: "agents", tag: "agents" })}

  <main>
    <!-- Create an agent (the unified flow — primary surface) -->
    <section id="create-section">
      <h2>Create an agent</h2>
      <p class="hint">Configure an agent, then talk to it. The default is one agent on its own
        vault-backed channel running the reliable <strong>Programmatic</strong> backend — name it,
        pick a vault, add an optional role, and Create. We provision the channel (if needed) and the
        agent in one step, then drop you into its chat. Open <strong>Advanced</strong> for an existing
        channel, Telegram / HTTP-UI transports, the interactive backend, extra channels, vault scope,
        filesystem, network, working directory, or mounts.</p>

      <div class="grid2">
        <div>
          <label for="agent-name">Agent name</label>
          <input type="text" id="agent-name" placeholder="e.g. release-bot" autocomplete="off" />
        </div>
        <div>
          <label for="agent-vault">Vault <span class="muted">(the channel's backing store)</span></label>
          <select id="agent-vault"><option value="">(loading vaults…)</option></select>
        </div>
      </div>

      <div class="field-row">
        <label for="agent-system-prompt">System prompt <span class="muted">(optional — the agent's role)</span></label>
        <textarea id="agent-system-prompt" rows="3" placeholder="e.g. You are the release assistant. Keep replies terse and action-oriented."></textarea>
      </div>

      <details id="advanced">
        <summary>Advanced — existing channel, transport, backend, isolation, mounts</summary>
        <div class="sub">
          <!-- Existing channel vs. provision a new one -->
          <div class="sub-group">
            <p class="sub-title">Channel</p>
            <div>
              <label for="use-existing">Channel source</label>
              <select id="use-existing">
                <option value="new" selected>Create a new channel named after the agent (default)</option>
                <option value="existing">Use an existing channel</option>
              </select>
            </div>
            <div id="existing-wrap" style="display:none;">
              <label for="existing-channel">Existing channel <span class="muted">(the wake channel)</span></label>
              <select id="existing-channel"></select>
              <div class="muted" style="font-size:12px; margin-top:6px;">
                The agent wakes on this channel; no new channel is provisioned.
              </div>
            </div>
            <div id="new-transport-wrap">
              <div class="grid2">
                <div>
                  <label for="agent-transport">Transport <span class="muted">(of the new channel)</span></label>
                  <select id="agent-transport">
                    <option value="vault" selected>Vault — durable, queryable (default)</option>
                    <option value="telegram">Telegram — a bot with its own token</option>
                    <option value="http-ui">HTTP-UI — built-in chat (testing / backup)</option>
                  </select>
                </div>
                <div>
                  <label for="agent-access">Channel access</label>
                  <select id="agent-access">
                    <option value="write" selected>read+write</option>
                    <option value="read">read only</option>
                  </select>
                </div>
              </div>
              <div id="telegram-token-wrap" style="display:none; margin-top:8px;">
                <label for="agent-telegram-token">Telegram bot token <span class="muted">(required)</span></label>
                <input type="password" id="agent-telegram-token" placeholder="123456:ABC-…" autocomplete="off" />
                <div class="muted" style="font-size:12px; margin-top:6px;">
                  Each Telegram channel carries its own per-channel bot token (no daemon-global fallback).
                </div>
              </div>
            </div>
          </div>

          <!-- Backend -->
          <div class="sub-group">
            <p class="sub-title">Backend</p>
            <div>
              <label for="agent-backend">Backend</label>
              <select id="agent-backend">
                <option value="programmatic" selected>Programmatic — clean per-message turns, reliable (recommended)</option>
                <option value="interactive">Interactive — watch / drive a live tmux session (advanced)</option>
              </select>
              <div id="backend-note" class="muted" style="font-size:12px; margin-top:8px;"></div>
            </div>
          </div>

          <!-- System-prompt mode -->
          <div class="sub-group">
            <p class="sub-title">System prompt mode</p>
            <div class="row" style="align-items:center;">
              <div>
                <label for="agent-prompt-mode" style="display:inline; margin-right:6px;">Mode</label>
                <select id="agent-prompt-mode">
                  <option value="append" selected>Append (default)</option>
                  <option value="replace">Replace</option>
                </select>
              </div>
              <span class="muted" style="font-size:12px;">Append keeps Claude Code's capable base and adds your role; Replace gives full control.</span>
            </div>
          </div>

          <!-- Extra channels -->
          <div class="sub-group">
            <p class="sub-title">Additional channels <span class="muted" style="font-weight:400;">(beyond the wake channel)</span></p>
            <div id="extra-channels" class="extra-channels"></div>
            <button id="add-channel" class="ghost" type="button" style="justify-self:start;">+ channel</button>
          </div>

          <!-- Vault binding (extra: tags / access for the agent's vault scope) -->
          <div class="sub-group">
            <p class="sub-title">Vault binding <span class="muted" style="font-weight:400;">(the agent's vault read/write scope)</span></p>
            <div class="grid3">
              <div>
                <label for="vault-name">Vault</label>
                <select id="vault-name"><option value="">(channel's vault)</option></select>
              </div>
              <div>
                <label for="vault-access">Vault access</label>
                <select id="vault-access">
                  <option value="read">read</option>
                  <option value="write" selected>write</option>
                  <option value="admin">admin</option>
                </select>
              </div>
              <div>
                <label for="vault-tags">Tag scope (optional)</label>
                <input type="text" id="vault-tags" placeholder="#agent-message/inbound, …" autocomplete="off" />
              </div>
            </div>
            <div class="muted" style="font-size:12px;">
              Leave the Vault blank to grant the agent the same vault that backs its channel. Set it to
              scope the agent's vault access explicitly.
            </div>
          </div>

          <!-- Isolation -->
          <div class="sub-group">
            <p class="sub-title">Isolation</p>
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
              <label for="agent-workspace">Working directory <span class="muted">(optional — absolute host path)</span></label>
              <input type="text" id="agent-workspace" placeholder="/Users/you/Code/my-repo" autocomplete="off" />
              <div class="muted" style="font-size:12px; margin-top:8px;">
                The directory the agent works in (its cwd, read-write). Leave blank and it works in its own
                private session dir. Set a real repo path to have it work there — that dir can be shared with
                other agents, runner jobs, or scripts. Its private config &amp; tokens (<code>.mcp.json</code>)
                always stay in the per-agent session dir, never written here.
              </div>
            </div>

            <div>
              <label>Filesystem mounts</label>
              <div id="mounts-rows" class="mounts-rows"></div>
              <button id="add-mount" class="ghost" type="button" style="justify-self:start;">+ mount</button>
            </div>
          </div>
        </div>
      </details>

      <div class="row" style="margin-top:16px;">
        <button id="create-go" class="primary create" type="button">Create agent</button>
        <span class="muted" id="create-note" style="font-size:12px;"></span>
      </div>
      <div id="create-msg" class="msg"></div>
    </section>

    <!-- Claude credential -->
    <section id="cred-section">
      <h2>Claude credential</h2>
      <p class="hint">A launched agent runs on a Claude subscription token from
        <code>claude setup-token</code> — injected per agent, never your CLI login.
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

    <!-- Per-channel env / credentials (GH_TOKEN, CLOUDFLARE_API_TOKEN, …) -->
    <section id="env-section">
      <h2>Channel env / credentials</h2>
      <p class="hint">Scope a channel's agent extra secrets &mdash; a
        <code>GH_TOKEN</code>, <code>CLOUDFLARE_API_TOKEN</code>, etc. These are injected
        into the agent's shell (its <code>gh</code>/<code>git</code>/build tooling) &mdash;
        Claude's own login is never touched. Set a default for every channel, or override per
        channel. After setting one, hit <strong>Restart / reconnect</strong> on a running agent
        to apply it.</p>
      <div id="env-list" class="scopes"></div>
      <details>
        <summary>Set an env var</summary>
        <div class="sub">
          <div class="grid3">
            <div>
              <label for="env-channel">Channel (blank = default/all)</label>
              <input type="text" id="env-channel" placeholder="channel name, or blank for default" autocomplete="off" />
            </div>
            <div>
              <label for="env-name">Name</label>
              <input type="text" id="env-name" placeholder="GH_TOKEN" autocomplete="off" />
            </div>
            <div>
              <label for="env-value">Value</label>
              <input type="password" id="env-value" placeholder="ghp_…" autocomplete="off" />
            </div>
          </div>
          <div class="row">
            <button id="env-save" class="primary" type="button">Save env var</button>
            <span class="muted" style="font-size:12px;">Stored 0600, never shown again. <code>ANTHROPIC_API_KEY</code> &amp; the Claude-auth vars are reserved.</span>
          </div>
        </div>
      </details>
      <div id="env-msg" class="msg"></div>
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
${PROVISION_JS}
(function () {
  // MOUNT, setStatus, escapeHtml, fetchToken (caches on window.__token),
  // authedFetch all come from SHELL_JS. ChannelProvision (the shared
  // provisioning client) comes from PROVISION_JS. Wire the shared nav.
  wireShell("agents");
  var Provision = window.ChannelProvision;
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
  // fetchToken (SHELL_JS) mints + caches the agent:admin Bearer on
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
      updateCreateNote(j.defaultSet, j.channels || []);
      return j;
    }).catch(function (err) {
      document.getElementById("cred-default").textContent = "unknown (" + err.message + ")";
    });
  }

  function updateCreateNote(defaultSet, overrides) {
    var note = document.getElementById("create-note");
    if (!defaultSet && (!overrides || !overrides.length)) {
      note.textContent = "⚠ no Claude credential set — set one below before creating.";
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

  // --- per-channel env vars (GH_TOKEN, CLOUDFLARE_API_TOKEN, …) ------------
  // GET /api/credentials/env returns { default:[names], channels:{ch:[names]} } —
  // NAMES only, values are never returned. Render each as a removable chip; the
  // scope ("default" or a channel) rides on the delete button.
  function envChip(scope, name) {
    // scope is "" for the default layer, else the channel name. Data-attrs are
    // server-enforced shapes (env name regex; channel slug) but esc() anyway.
    return "<span class='env-chip'><code>" + esc(name) + "</code>" +
      "<button class='ghost danger' data-env-scope='" + esc(scope) + "' data-env-name='" + esc(name) +
      "' type='button' title='remove'>&times;</button></span>";
  }
  function loadEnv() {
    return apiJson("/api/credentials/env").then(function (j) {
      var host = document.getElementById("env-list");
      var blocks = [];
      var dflt = (j && j.default) || [];
      if (dflt.length) {
        blocks.push("<div class='env-block'><span class='env-scope'>default (all channels):</span> " +
          dflt.map(function (n) { return envChip("", n); }).join(" ") + "</div>");
      }
      var chans = (j && j.channels) || {};
      Object.keys(chans).sort().forEach(function (ch) {
        var names = chans[ch] || [];
        if (!names.length) return;
        blocks.push("<div class='env-block'><span class='env-scope'>" + esc(ch) + ":</span> " +
          names.map(function (n) { return envChip(ch, n); }).join(" ") + "</div>");
      });
      host.innerHTML = blocks.length ? blocks.join("") :
        "<div class='muted' style='font-size:13px;'>No env vars set. Add one below to scope a channel's agent a token.</div>";
      host.querySelectorAll("[data-env-name]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          removeEnv(btn.getAttribute("data-env-scope") || "", btn.getAttribute("data-env-name"));
        });
      });
      return j;
    }).catch(function (err) {
      document.getElementById("env-list").innerHTML =
        "<div class='muted' style='font-size:13px;'>Could not load env vars: " + esc(err.message) + "</div>";
    });
  }
  document.getElementById("env-save").addEventListener("click", function () {
    var msg = document.getElementById("env-msg");
    clearMsg(msg);
    var channel = document.getElementById("env-channel").value.trim();
    var name = document.getElementById("env-name").value.trim();
    var value = document.getElementById("env-value").value;
    if (!name) { showMsg(msg, "Enter a variable name (e.g. GH_TOKEN).", true); return; }
    if (!value) { showMsg(msg, "Enter a value.", true); return; }
    var body = { name: name, value: value };
    if (channel) body.channel = channel;
    apiJson("/api/credentials/env", { method: "POST", body: JSON.stringify(body) }).then(function () {
      document.getElementById("env-name").value = "";
      document.getElementById("env-value").value = "";
      showMsg(msg, "Saved " + name + (channel ? (" for channel " + channel) : " (default)") +
        ". Restart an agent to apply it.", false);
      loadEnv();
    }).catch(function (err) { showMsg(msg, "Failed: " + err.message, true); });
  });
  function removeEnv(scope, name) {
    var msg = document.getElementById("env-msg");
    clearMsg(msg);
    var body = { name: name };
    if (scope) body.channel = scope;
    apiJson("/api/credentials/env", { method: "DELETE", body: JSON.stringify(body) }).then(function () {
      showMsg(msg, "Removed " + name + (scope ? (" for " + scope) : " (default)") + ".", false);
      loadEnv();
    }).catch(function (err) { showMsg(msg, "Failed: " + err.message, true); });
  }

  // --- create-agent form: dynamic UI --------------------------------------
  function channelOptions(selected) {
    return knownChannels.map(function (c) {
      return "<option value='" + esc(c) + "'" + (c === selected ? " selected" : "") + ">" + esc(c) + "</option>";
    }).join("");
  }

  var nameEl = document.getElementById("agent-name");
  var useExistingEl = document.getElementById("use-existing");
  var existingChannelEl = document.getElementById("existing-channel");
  var transportEl = document.getElementById("agent-transport");

  // Channel source toggle: "new" provisions a channel named after the agent;
  // "existing" reuses one from the list (skips provisioning).
  function syncChannelSource() {
    var existing = useExistingEl.value === "existing";
    document.getElementById("existing-wrap").style.display = existing ? "" : "none";
    document.getElementById("new-transport-wrap").style.display = existing ? "none" : "";
  }
  useExistingEl.addEventListener("change", syncChannelSource);
  syncChannelSource();

  // Transport toggle (new-channel path): reveal the Telegram bot-token field only
  // for telegram. vault + http-ui need no extra field here (vault picks the vault
  // up top; http-ui is self-contained).
  function syncTransport() {
    document.getElementById("telegram-token-wrap").style.display =
      transportEl.value === "telegram" ? "" : "none";
  }
  transportEl.addEventListener("change", syncTransport);
  syncTransport();

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

  // Backend toggle (under Advanced). PROGRAMMATIC is the default + recommended path
  // (reliable — no deaf-on-restart / reconnect class). INTERACTIVE (the original
  // tmux session you watch/drive via terminal attach) is the buggier opt-in.
  var backendMode = document.getElementById("agent-backend");
  function syncBackendMode() {
    var note = document.getElementById("backend-note");
    if (backendMode.value === "programmatic") {
      note.textContent = "Programmatic (default): no live terminal. Each message runs one on-demand claude -p turn " +
        "(resumes the prior conversation) and its reply is posted back to the channel. No idle session to go " +
        "deaf, no reconnect — reliable, ideal for fire-and-forget 'do a task, report back'.";
    } else {
      note.textContent = "Interactive (advanced): an idle Claude Code session in a tmux pane you can attach to (Terminal ↗). " +
        "Messages inject into the live session; you watch it work — but it's currently less stable (deaf-on-restart / " +
        "reconnect class). Use Programmatic unless you specifically want a live session.";
    }
  }
  backendMode.addEventListener("change", syncBackendMode);
  syncBackendMode(); // default is programmatic

  // --- create-agent form: spec shaping ------------------------------------
  // Resolve the wake channel: in "existing" mode it's the picked channel; in
  // "new" mode it's the agent name (the channel is provisioned under that name).
  function resolveWakeChannel(name) {
    if (useExistingEl.value === "existing") {
      var ch = existingChannelEl.value;
      if (!ch) throw new Error("pick an existing channel (Advanced → Channel)");
      return ch;
    }
    return name;
  }

  // Build the /api/agents spec — the SAME body buildSpecFromBody() accepts (no new
  // fields). Throws Error on a validation miss. wake is the resolved wake channel.
  function collectSpec(name, wake) {
    var channels = [{ name: wake, access: document.getElementById("agent-access").value }];
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

    // Working directory. Only send when non-blank — the server treats a blank value
    // as unset (the agent works in its private session dir).
    var workspace = document.getElementById("agent-workspace").value.trim();
    if (workspace) spec.workspace = workspace;

    var mounts = [];
    document.querySelectorAll("#mounts-rows .mrow").forEach(function (row) {
      var host = row.querySelector(".mt-host").value.trim();
      var mount = row.querySelector(".mt-mount").value.trim();
      if (!host || !mount) return;
      mounts.push({ hostPath: host, mountPath: mount, mode: row.querySelector(".mt-mode").value });
    });
    if (mounts.length) spec.mounts = mounts;

    // Backend — programmatic is the default; send the selected backend EXPLICITLY.
    spec.backend = backendMode.value === "interactive" ? "interactive" : "programmatic";

    // System prompt (the agent's role). Only send when non-blank.
    var sysPrompt = document.getElementById("agent-system-prompt").value.trim();
    if (sysPrompt) {
      spec.systemPrompt = sysPrompt;
      spec.systemPromptMode = document.getElementById("agent-prompt-mode").value === "replace" ? "replace" : "append";
    }
    return spec;
  }

  // --- create-agent form: orchestration -----------------------------------
  // ONE submit: (1) provision the channel if it doesn't already exist (reusing the
  // shared ChannelProvision client — the SAME hub-mediated vault flow + daemon
  // telegram/http-ui flow the Config page runs), then (2) POST /api/agents to spawn
  // the agent on it, then (3) land in chat. Idempotent: an existing channel is
  // REUSED (no error, no double-provision). A spawn failure after provisioning
  // surfaces a clear error — the channel may remain (acceptable; retry or manage on
  // Config).
  function setCreating(on) {
    var btn = document.getElementById("create-go");
    btn.disabled = on;
    btn.textContent = on ? "Creating…" : "Create agent";
  }

  // Provision the wake channel for a NEW-channel create. Returns a Promise resolving
  // { ok:true } when the channel exists (created now or already present), else
  // { ok:false, message }. Uses ChannelProvision throughout.
  function ensureChannel(name, transport) {
    // First, idempotency: does a channel with this name already exist? If so, REUSE
    // it regardless of transport (don't double-provision, don't error).
    return Provision.channelExists({ apiUrl: MOUNT + "/api/channels", token: window.__token, name: name })
      .then(function (chk) {
        if (chk.ok && chk.exists) {
          return { ok: true, reused: true, transport: chk.transport };
        }
        // If the existence check itself failed with auth (the agent:admin list
        // 401/403'd), we can't know whether the channel already exists — so for the
        // DAEMON transports we must NOT blindly re-POST (that could 409 a duplicate
        // or overwrite an existing channel's config). Surface the auth error and let
        // the operator sign in + retry; the idempotent reuse path needs a readable
        // list. The VAULT path is exempt: it uses the hub session cookie (not this
        // token), so a list 401 doesn't predict a hub-cookie failure — fall through
        // and let provisionVaultChannel report its own auth state.
        if (chk.auth && transport !== "vault") {
          return { ok: false, message: "not signed in — the page needs an agent:admin token to check/create the channel (open it through the hub portal, signed in)." };
        }
        // Provision per transport:
        if (transport === "vault") {
          var vault = document.getElementById("agent-vault").value;
          if (!vault) return { ok: false, message: "pick a vault for the new channel" };
          return Provision.provisionVaultChannel({ origin: window.location.origin, name: name, vault: vault })
            .then(function (res) {
              if (res.ok) return { ok: true, connect: res.connect, connection: res.connection };
              if (res.auth) return { ok: false, message: "not signed in to the hub — open this page through the hub portal (signed in) to provision a vault channel." };
              if (res.forbidden) return { ok: false, message: "not permitted to link a vault: " + (res.error || "") };
              return { ok: false, message: "vault channel provisioning failed: " + (res.error || "unknown error") };
            });
        }
        if (transport === "telegram") {
          var tgToken = document.getElementById("agent-telegram-token").value.trim();
          if (!tgToken) return { ok: false, message: "a Telegram channel needs its own bot token (Advanced → Channel)" };
          return Provision.provisionDaemonChannel({ apiUrl: MOUNT + "/api/channels", token: window.__token, name: name, transport: "telegram", config: { token: tgToken } })
            .then(daemonProvisionResult);
        }
        // http-ui
        return Provision.provisionDaemonChannel({ apiUrl: MOUNT + "/api/channels", token: window.__token, name: name, transport: "http-ui" })
          .then(daemonProvisionResult);
      });
  }
  function daemonProvisionResult(res) {
    if (res.ok) return { ok: true, restart_needed: res.restart_needed, restart_error: res.error };
    if (res.auth) return { ok: false, message: "not signed in — the page needs an agent:admin token (open it through the hub portal, signed in)." };
    return { ok: false, message: "channel provisioning failed: " + (res.error || "unknown error") };
  }

  function createAgent() {
    var msg = document.getElementById("create-msg");
    clearMsg(msg);
    var name = nameEl.value.trim();
    if (!name) { showMsg(msg, "Enter an agent name.", true); return; }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      showMsg(msg, "Agent name: letters, numbers, dash, underscore only.", true);
      return;
    }

    var existing = useExistingEl.value === "existing";
    var transport = transportEl.value;
    var wake;
    var spec;
    try {
      wake = resolveWakeChannel(name);
      spec = collectSpec(name, wake);
    } catch (e) { showMsg(msg, e.message, true); return; }

    setCreating(true);

    // Step 1 — channel. Existing-channel mode skips provisioning entirely.
    var channelStep = existing
      ? Promise.resolve({ ok: true, reused: true })
      : ensureChannel(wake, transport);

    channelStep.then(function (chRes) {
      if (!chRes.ok) {
        showMsg(msg, chRes.message || "could not provision the channel.", true);
        setCreating(false);
        return;
      }
      // Step 2 — spawn the agent (the SAME /api/agents body as before). On a
      // post-provision spawn failure, surface a clear error (the channel may
      // remain; that's acceptable — retry or manage it on Config).
      return apiJson("/api/agents", { method: "POST", body: JSON.stringify(spec) }).then(function (r) {
        var lines = [];
        var prog = r.backend === "programmatic";
        // On REUSE, name the existing channel's transport — it may differ from the
        // one selected (the operator picked vault but a same-named telegram channel
        // already existed). Reuse is intended (don't double-provision), but the
        // transport divergence must be VISIBLE so it isn't a silent surprise.
        var verb = chRes.reused
          ? ("Reused existing channel" + (chRes.transport ? " (transport: " + chRes.transport + ")" : ""))
          : "Provisioned channel";
        lines.push(verb + " " + wake + (chRes.restart_needed ? " (restart needed: " + (chRes.restart_error || "") + ")" : "") + ".");
        if (prog) {
          lines.push((r.alreadyRunning ? "Re-registered" : "Created") + " programmatic agent " + r.name + ".");
          lines.push("workspace: " + r.workspace);
          lines.push("Opening chat…");
        } else if (r.alreadyRunning) {
          lines.push("Agent " + (r.session || r.name) + " is already running (no-op).");
        } else {
          // Interactive launch — surface the agent's SANDBOX POSTURE so the operator
          // can verify the isolation matches what they selected (security-relevant).
          lines.push("Launched " + (r.session || r.name) + " (interactive).");
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
          lines.push("Open the agent's chat or attach via Terminal ↗ (Running agents, below).");
        }
        showMsg(msg, lines.join("\\n"), false);
        loadAgents();
        if (prog) {
          // Step 3 (programmatic only) — land the operator in the agent's chat. A
          // short beat so the success banner is visible, then navigate. INTERACTIVE
          // agents are NOT auto-navigated: the sandbox-posture lines above + the
          // Terminal-attach affordance stay on screen for the operator to verify.
          setTimeout(function () { window.location.href = chatUrl(wake); }, 900);
        } else {
          setCreating(false);
        }
      }).catch(function (err) {
        showMsg(msg,
          "Channel is ready, but the agent spawn failed: " + err.message +
          (existing ? "" : "\\nThe channel \\"" + wake + "\\" may remain — retry, or manage it on Config."),
          true);
        loadAgents();
        setCreating(false);
      });
    }).catch(function (err) {
      showMsg(msg, "Create failed: " + (err && err.message ? err.message : String(err)), true);
      setCreating(false);
    });
  }
  document.getElementById("create-go").addEventListener("click", createAgent);

  // --- running agents list ------------------------------------------------
  // The terminal attaches to an AGENT (its tmux session), so the link carries the
  // agent name as ?agent= (the terminal page also accepts the legacy ?channel=).
  // Surfaced only for INTERACTIVE agents (programmatic has no tmux to attach).
  function terminalUrl(agent) { return MOUNT + "/terminal?agent=" + encodeURIComponent(agent); }
  // /api/agents returns { name, session, attached } — it does NOT carry the
  // agent's wake channel(s). The default is one-agent-one-channel (the agent name
  // IS its wake channel), so the Chat link uses the agent name as the channel.
  function chatUrl(channel) { return MOUNT + "/ui?channel=" + encodeURIComponent(channel); }
  // /health is OPEN (no token) and carries per-channel { mcp_sessions, clients }.
  function fetchHealth() {
    return fetch(MOUNT + "/health").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function connectionCell(h) {
    if (!h) return "<span class='pill idle-conn' title='no matching channel in /health'>—</span>";
    var sessions = (typeof h.mcp_sessions === "number") ? h.mcp_sessions : 0;
    var clients = (typeof h.clients === "number") ? h.clients : 0;
    if (sessions + clients > 0) {
      return "<span class='pill connected'>● connected</span> " +
        "<span class='muted' style='font-size:11px;'>(" + sessions + " mcp, " + clients + " sse)</span>";
    }
    return "<span class='pill idle-conn'>○ not connected</span>";
  }
  function loadAgents() {
    return Promise.all([apiJson("/api/agents"), fetchHealth()]).then(function (res) {
      var j = res[0];
      var health = res[1];
      var liveByChannel = {};
      if (health && Array.isArray(health.channels)) {
        health.channels.forEach(function (c) { liveByChannel[c.name] = c; });
      }
      var host = document.getElementById("agents-table");
      var agents = j.agents || [];
      // Reveal the Terminal nav link only when an INTERACTIVE agent exists (it's
      // the only backend with a live terminal to attach). Programmatic-only → the
      // standalone Terminal entry stays hidden (Phase-1 nav cleanup).
      setTerminalNavVisible(agents.some(function (a) { return a.backend !== "programmatic"; }));
      if (!agents.length) {
        host.innerHTML = "<div class='empty'>No agents running. Create one above.</div>";
        return;
      }
      var rows = agents.map(function (a) {
        var prog = a.backend === "programmatic";
        // Backend column: a small label so it's obvious which agents are which.
        var backendCell = prog
          ? "<span class='pill connected' title='no tmux — on-demand claude -p turns'>programmatic</span>"
          : "<span class='pill detached' title='tmux session you can attach to'>interactive</span>";
        // State column: interactive uses tmux attached; programmatic uses its live
        // turn status (idle | working | queued:N) reported by the server.
        var stateCell = prog
          ? "<span class='pill' title='turn status'>" + esc(a.status || "idle") + "</span>"
          : (a.attached ? "<span class='pill attached'>attached</span>" : "<span class='pill detached'>idle</span>");
        // Connection column: programmatic has no live subscriber to count — show
        // its turn status instead of the SSE/MCP counts. Interactive uses /health.
        var connCell = prog
          ? "<span class='pill connected'>● " + esc(a.status || "idle") + "</span>"
          : connectionCell(liveByChannel[a.name]);
        // Actions: programmatic has no terminal to attach (no tmux) — the terminal
        // link is surfaced ONLY for interactive agents (Phase-1 cleanup). Chat link
        // always applies (the channel transcript shows its replies).
        var actions = "<a href='" + esc(chatUrl(a.name)) + "'>chat →</a>";
        if (!prog) {
          actions += "<a href='" + esc(terminalUrl(a.name)) + "' target='_blank' rel='noopener'>terminal ↗</a>";
        }
        actions += "<button class='ghost' data-restart='" + esc(a.name) + "' type='button' title='" +
          (prog ? "Reset the conversation (next message starts fresh)" : "Re-source env + reconnect this session") + "'>" +
          (prog ? "reset" : "restart / reconnect") + "</button>" +
          "<button class='ghost danger' data-kill='" + esc(a.name) + "' type='button'>" + (prog ? "deregister" : "kill") + "</button>";
        // A small badge when the agent carries a per-channel system prompt (the role),
        // showing the composition mode (append/replace) — the text itself isn't surfaced.
        var promptBadge = a.systemPromptMode
          ? " <span class='pill' title='system prompt set (" + esc(a.systemPromptMode) +
            " mode)' style='font-size:11px;'>role: " + esc(a.systemPromptMode) + "</span>"
          : "";
        // A badge when the agent works from a shared working dir (the workspace
        // seam) — the path is the title so it's visible on hover without crowding.
        var wdBadge = a.workingDir
          ? " <span class='pill' title='working dir: " + esc(a.workingDir) +
            "' style='font-size:11px;'>workdir</span>"
          : "";
        return "<tr>" +
          "<td><strong>" + esc(a.name) + "</strong>" + promptBadge + wdBadge + "</td>" +
          "<td>" + backendCell + "</td>" +
          "<td>" + stateCell + "</td>" +
          "<td>" + connCell + "</td>" +
          "<td class='actions'>" + actions + "</td></tr>";
      }).join("");
      host.innerHTML = "<table><thead><tr><th>Agent</th><th>Backend</th><th>State</th><th>Connection</th><th></th></tr></thead><tbody>" +
        rows + "</tbody></table>";
      host.querySelectorAll("[data-kill]").forEach(function (btn) {
        btn.addEventListener("click", function () { killAgent(btn.getAttribute("data-kill")); });
      });
      host.querySelectorAll("[data-restart]").forEach(function (btn) {
        btn.addEventListener("click", function () { restartAgent(btn.getAttribute("data-restart"), btn); });
      });
    }).catch(function (err) {
      document.getElementById("agents-table").innerHTML = "<div class='empty'>Could not load agents: " + esc(err.message) + "</div>";
    });
  }

  function killAgent(name) {
    // name is a server-enforced slug (alphanumeric/dash/underscore, agents.ts), so
    // it carries no HTML/JS-special chars in the confirm string; encodeURI'd anyway.
    if (!confirm("Kill agent " + name + "? This ends its session.")) return;
    apiJson("/api/agents/" + encodeURIComponent(name), { method: "DELETE" }).then(function () {
      loadAgents();
    }).catch(function (err) { alert("Kill failed: " + err.message); });
  }

  // Restart = kill + re-spawn from the persisted spec, re-resolving env + the Claude
  // credential — so setting a token then applying it is one click. A fresh spawn
  // (NOT claude -c): the prior conversation context is not resumed (the channel MCP
  // reconnects either way). The server returns 400 if there's no persisted spec (an
  // older session) — surfaced as a clear message.
  function restartAgent(name, btn) {
    if (!confirm("Restart agent " + name + "? It re-sources env (picks up newly-set credentials) and reconnects. The current conversation context is not resumed.")) return;
    var orig = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "restarting…"; }
    apiJson("/api/agents/" + encodeURIComponent(name) + "/restart", { method: "POST" }).then(function (r) {
      var msg = document.getElementById("create-msg");
      clearMsg(msg);
      showMsg(msg, "Restarted " + (r.session || (name + "-agent")) + " — env re-sourced, session reconnected.", false);
      loadAgents();
    }).catch(function (err) {
      alert("Restart failed: " + err.message);
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    });
  }
  document.getElementById("refresh").addEventListener("click", function () { loadAgents(); });

  // --- pickers: channels + vaults -----------------------------------------
  // A ?channel=<name> query param (from a "Create agent" link on another surface)
  // pre-fills the agent name AND switches Advanced → Channel to that existing
  // channel, so the form lands ready-to-go. Only honored when the channel exists.
  function requestedChannel() {
    try { return new URL(window.location.href).searchParams.get("channel") || ""; }
    catch (_e) { return ""; }
  }
  function loadChannels() {
    return fetch(MOUNT + "/.parachute/config").then(function (r) { return r.json(); }).then(function (cfg) {
      knownChannels = (cfg.channels || []).map(function (c) { return c.name; });
      // Populate the Advanced "existing channel" picker.
      if (!knownChannels.length) {
        existingChannelEl.innerHTML = "<option value=''>(no channels yet)</option>";
      } else {
        existingChannelEl.innerHTML = channelOptions(knownChannels[0]);
      }
      // If arrived with ?channel=<name> for an EXISTING channel, pre-fill the name +
      // switch to the existing-channel path (the deep-link from Config/Home/Chat).
      var want = requestedChannel();
      if (want && knownChannels.indexOf(want) >= 0) {
        if (!nameEl.value) nameEl.value = want;
        useExistingEl.value = "existing";
        existingChannelEl.value = want;
        syncChannelSource();
      }
    }).catch(function () {
      existingChannelEl.innerHTML = "<option value=''>(channel list failed)</option>";
    });
  }
  // The DEFAULT Vault picker (the primary create flow) reads the hub's PUBLIC
  // discovery doc via ChannelProvision.listVaults. Per the blueprint: auto-select
  // when exactly one vault exists (no real choice — it's pre-chosen); with several,
  // the first is the default but the operator picks. Either way the FIRST option is
  // selected (a <select> defaults to its first option regardless); the explicit
  // selected attribute on index 0 just makes that intent visible in the markup.
  function loadDefaultVaults() {
    return Provision.listVaults({ origin: window.location.origin }).then(function (res) {
      var sel = document.getElementById("agent-vault");
      var vaults = (res && res.ok && res.vaults) ? res.vaults : [];
      if (!vaults.length) {
        sel.innerHTML = "<option value=''>(no vaults — create one in the hub portal)</option>";
        return;
      }
      sel.innerHTML = vaults.map(function (v, i) {
        return "<option value='" + esc(v) + "'" + (i === 0 ? " selected" : "") + ">" + esc(v) + "</option>";
      }).join("");
    }).catch(function () {
      document.getElementById("agent-vault").innerHTML = "<option value=''>(could not load vaults)</option>";
    });
  }
  // The Advanced vault-BINDING picker (the agent's own vault scope) reads the
  // daemon's installed-vaults endpoint (agent:admin). Distinct from the channel's
  // backing vault — this is the vault the agent itself reads/writes.
  function loadBindingVaults() {
    return apiJson("/api/vaults").then(function (j) {
      var vaults = j.vaults || [];
      var sel = document.getElementById("vault-name");
      sel.innerHTML = "<option value=''>(channel's vault)</option>" +
        vaults.map(function (v) { return "<option value='" + esc(v) + "'>" + esc(v) + "</option>"; }).join("");
    }).catch(function () { /* leave the (channel's vault) default */ });
  }

  // --- boot ---------------------------------------------------------------
  setStatus("authenticating…");
  fetchToken().then(function () {
    setStatus("● ready", "live");
    return Promise.all([loadChannels(), loadDefaultVaults(), loadBindingVaults(), loadCreds(), loadEnv(), loadAgents()]);
  }).then(function () {
    setInterval(loadAgents, 5000);
  }).catch(function (err) {
    setStatus("not authenticated", "err");
    // Even unauthenticated, the public vault picker + channel list can load (the
    // vault provisioning path uses the hub cookie). Surface the auth note but still
    // populate what we can so the form isn't a dead-end.
    loadChannels();
    loadDefaultVaults();
    showMsg(document.getElementById("create-msg"),
      "Open this page through the hub portal, signed in as the operator. " +
      "Creating an agent needs an agent:admin token (" + err.message + ").", true);
  });
})();
</script>
</body>
</html>`;
