/**
 * Static HTML for `/channel/home` — the overview landing (Phase 2 of the
 * channel-UI coherence pass). This is the new DEFAULT page the hub portal lands
 * on (`uiUrl: "/channel/home"`); it orients the operator before they dive into a
 * specific surface.
 *
 * Self-contained document (HTML + inline CSS + inline JS, no build step — the
 * same shape as `daemon.ts`'s chat UI, `agents-ui.ts`, and `terminal-ui.ts`). It
 * adopts the shared UI kit (`THEME_CSS` + `appShell` + `SHELL_JS`) so it reads as
 * a peer of the Agents/Config pages, and shows two at-a-glance cards:
 *
 *   - Channels       — fetched from `<mount>/.parachute/config` (OPEN, no auth):
 *                      each channel's name + transport + a live dot, linking to
 *                      its Chat. Footer: "Configure channels →" (the Config page).
 *   - Running agents — fetched from `<mount>/api/agents` (channel:admin Bearer via
 *                      authedFetch): each agent's name + state, linking to its
 *                      Terminal + Chat. Auto-refreshes every 5s. Footer: "Spawn an
 *                      agent →" (the Agents page).
 *
 * Auth: the page loads OPEN (like the other surfaces); the channels card needs no
 * token, the agents card mints a hub `channel:admin` Bearer (fetchToken) and
 * tolerates failure with a "sign in via the portal" note — an unauthenticated
 * load still shows channels + the quick actions.
 *
 * Vocabulary (settled this phase): a CHANNEL is the messaging pipe; an AGENT is
 * the sandboxed Claude Code session bound to a channel.
 */

import { THEME_CSS, appShell, SHELL_JS } from "./ui-kit.ts";

export const HOME_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>parachute-channel · home</title>
<style>
${THEME_CSS}
  /* ---- Home page layout (page-specific, layered after the shared kit) ------ */
  .app-header { position: sticky; top: 0; z-index: 5; }
  .page-head { margin: 0 0 1.5rem; }
  .overview-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; align-items: start;
  }
  /* Stack the two cards on narrow viewports. */
  @media (max-width: 720px) { .overview-grid { grid-template-columns: 1fr; } }
  .card-surface .card-head {
    display: flex; align-items: baseline; gap: 0.6rem; margin: 0 0 0.9rem;
  }
  .card-surface .card-head .count { color: var(--fg-dim); font-size: 0.85rem; }
  .ov-list { display: flex; flex-direction: column; gap: 0.4rem; margin: 0 0 1rem; }
  .ov-row {
    display: flex; align-items: center; gap: 0.6rem;
    padding: 0.6rem 0.7rem; border: 1px solid var(--border); border-radius: 8px;
    background: var(--bg); transition: border-color 0.12s ease, background 0.12s ease;
  }
  .ov-row:hover { border-color: var(--fg-dim); background: var(--card); }
  .ov-row .name { font-weight: 600; color: var(--fg); }
  .ov-row .spacer { flex: 1 1 auto; }
  .ov-row .links { display: inline-flex; gap: 0.5rem; font-size: 0.85rem; flex: 0 0 auto; }
  .ov-empty { color: var(--fg-muted); font-size: 0.9rem; padding: 0.7rem 0.2rem; }
  .ov-empty a { font-weight: 500; }
  .card-foot {
    margin: 0; padding-top: 0.6rem; border-top: 1px solid var(--border-light);
    font-size: 0.85rem;
  }
  .quick-actions {
    display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center;
    margin: 1.5rem 0 0;
  }
  .quick-actions .spacer { flex: 1 1 auto; }
</style>
</head>
<body>
  ${appShell({ active: "home", tag: "home", status: "loading…" })}

  <main class="page">
    <div class="page-head">
      <h1>Home</h1>
      <p class="subtitle">Your channels and the agents running on them.</p>
    </div>

    <div class="overview-grid">
      <!-- Channels (the messaging pipes) -->
      <section class="card-surface">
        <div class="card-head">
          <h2>Channels</h2>
          <span id="channels-count" class="count"></span>
        </div>
        <div id="channels-list" class="ov-list">
          <div class="ov-empty">Loading channels…</div>
        </div>
        <p class="card-foot"><a id="channels-config" href="#">Configure channels →</a></p>
      </section>

      <!-- Running agents (the sandboxed sessions) -->
      <section class="card-surface">
        <div class="card-head">
          <h2>Running agents</h2>
          <span id="agents-count" class="count"></span>
        </div>
        <div id="agents-list" class="ov-list">
          <div class="ov-empty">Loading agents…</div>
        </div>
        <p class="card-foot"><a id="agents-spawn" href="#">Spawn an agent →</a></p>
      </section>
    </div>

    <div class="quick-actions">
      <a id="qa-spawn" class="btn btn-primary" href="#">Spawn agent</a>
      <a id="qa-chat" class="btn" href="#">Open chat</a>
      <a id="qa-config" class="btn" href="#">Configure</a>
      <span class="spacer"></span>
      <button id="refresh" class="btn btn-sm" type="button">Refresh</button>
    </div>
  </main>

<script>
${SHELL_JS}
(function () {
  // MOUNT, setStatus, escapeHtml, fetchToken (caches on window.__token),
  // authedFetch all come from SHELL_JS. Wire the shared nav for the home view.
  wireShell("home");
  var esc = escapeHtml;

  var channelsList = document.getElementById("channels-list");
  var channelsCount = document.getElementById("channels-count");
  var agentsList = document.getElementById("agents-list");
  var agentsCount = document.getElementById("agents-count");

  // Static cross-surface links (resolved under the runtime mount prefix).
  function wireLinks() {
    document.getElementById("channels-config").href = MOUNT + "/admin";
    document.getElementById("agents-spawn").href = MOUNT + "/agents";
    document.getElementById("qa-spawn").href = MOUNT + "/agents";
    document.getElementById("qa-chat").href = MOUNT + "/ui";
    document.getElementById("qa-config").href = MOUNT + "/admin";
  }

  function chatUrl(channel) { return MOUNT + "/ui?channel=" + encodeURIComponent(channel); }
  function terminalUrl(agent) { return MOUNT + "/terminal?agent=" + encodeURIComponent(agent); }

  // --- channels (OPEN config + health, no token needed) -------------------
  // The config listing + /health are non-sensitive and served PUBLIC, so the
  // channels card renders even on an unauthenticated load. Config gives the
  // channel list + transport; /health gives real liveness (which channels the
  // daemon has actually loaded) + client counts — so the dot reflects truth
  // rather than always showing green.
  function loadChannels() {
    return Promise.all([
      fetch(MOUNT + "/.parachute/config").then(function (r) { if (!r.ok) throw new Error("config " + r.status); return r.json(); }),
      fetch(MOUNT + "/health").then(function (r) { return r.ok ? r.json() : { channels: [] }; }).catch(function () { return { channels: [] }; }),
    ])
      .then(function (res) {
        var cfg = res[0], health = res[1] || {};
        var live = {};
        (health.channels || []).forEach(function (c) { live[c.name] = c; });
        var chans = cfg.channels || [];
        channelsCount.textContent = chans.length ? String(chans.length) : "";
        if (!chans.length) {
          channelsList.innerHTML = "<div class='ov-empty'>No channels yet. " +
            "<a href='" + MOUNT + "/admin'>Add one in Config →</a></div>";
          return;
        }
        channelsList.innerHTML = chans.map(function (c) {
          var h = live[c.name];
          var dot = h ? "<span class='dot live' title='loaded'></span>" : "<span class='dot' title='configured, not loaded'></span>";
          var clients = h && h.clients ? "<span class='count'>" + h.clients + (h.clients === 1 ? " client" : " clients") + "</span>" : "";
          return "<div class='ov-row'>" +
            dot +
            "<span class='name'>" + esc(c.name) + "</span>" +
            "<span class='pill'>" + esc(c.transport || "channel") + "</span>" +
            "<span class='spacer'></span>" +
            clients +
            "<span class='links'>" +
              "<a href='" + esc(chatUrl(c.name)) + "'>chat →</a>" +
            "</span>" +
          "</div>";
        }).join("");
      })
      .catch(function (err) {
        channelsCount.textContent = "";
        channelsList.innerHTML = "<div class='ov-empty'>Could not load channels (" + esc(err.message) + ").</div>";
      });
  }

  // --- running agents (channel:admin Bearer via authedFetch) --------------
  function loadAgents() {
    return authedFetch(MOUNT + "/api/agents")
      .then(function (r) { if (!r.ok) { var e = new Error("agents " + r.status); e.status = r.status; throw e; } return r.json(); })
      .then(function (j) {
        var agents = j.agents || [];
        agentsCount.textContent = agents.length ? String(agents.length) : "";
        if (!agents.length) {
          agentsList.innerHTML = "<div class='ov-empty'>No agents running — " +
            "<a href='" + MOUNT + "/agents'>Spawn one →</a></div>";
          return;
        }
        agentsList.innerHTML = agents.map(function (a) {
          var state = a.attached
            ? "<span class='pill attached'>attached</span>"
            : "<span class='pill'>running</span>";
          return "<div class='ov-row'>" +
            "<span class='name'>" + esc(a.name) + "</span>" +
            state +
            "<span class='spacer'></span>" +
            "<span class='links'>" +
              "<a href='" + esc(terminalUrl(a.name)) + "'>terminal →</a>" +
              "<a href='" + esc(chatUrl(a.name)) + "'>chat →</a>" +
            "</span>" +
          "</div>";
        }).join("");
      })
      .catch(function (err) {
        agentsCount.textContent = "";
        if (err.status === 401) {
          agentsList.innerHTML = "<div class='ov-empty'>Sign in via the portal to see running agents.</div>";
        } else {
          agentsList.innerHTML = "<div class='ov-empty'>Could not load agents (" + esc(err.message) + ").</div>";
        }
      });
  }

  function refreshAll() {
    return Promise.all([loadChannels(), loadAgents()]);
  }

  document.getElementById("refresh").addEventListener("click", function () { refreshAll(); });

  // --- boot ---------------------------------------------------------------
  // Mint the channel:admin Bearer first so the agents card is authed; tolerate a
  // failed mint (unauthenticated load) — channels still render, agents shows the
  // sign-in note. Then auto-refresh agents every 5s (like the Agents page).
  wireLinks();
  fetchToken()
    .then(function () { setStatus("● ready", "live"); })
    .catch(function () { setStatus("sign in via the portal", "err"); })
    .then(refreshAll)
    .then(function () { setInterval(loadAgents, 5000); });
})();
</script>
</body>
</html>`;
