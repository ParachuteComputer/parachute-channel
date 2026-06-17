/**
 * The Schedules page (`/agent/jobs`) — the runner's operator surface (design
 * `2026-06-17-runner-scheduled-agent-turns.md` §Components.6).
 *
 * Why a SIBLING `/jobs` page (not a section on the agents page): the agents page is
 * already the largest surface in the module and is squarely about *creating /
 * watching agents*; scheduling is its own concern with its own list + form + state.
 * A dedicated page keeps each surface single-purpose (matching the existing
 * home/chat/agents/terminal/config one-page-per-concern idiom), slots cleanly into
 * the shared nav, and avoids growing agents-ui.ts further. The picker reuses the
 * SAME vault-channel list (`/.parachute/config`) the agents page reads, so an
 * operator schedules an agent they already created.
 *
 * Idiom (matches agents-ui / admin-ui): the whole page is an HTML string with
 * browser JS as a template-string `<script>`. It reuses `ui-kit`'s `THEME_CSS` +
 * `appShell` + `SHELL_JS` (MOUNT derivation, nav wiring, `escapeHtml`,
 * `setStatus`, `fetchToken`/`authedFetch` — the hub-minted `agent:admin` token
 * bootstrap). All dynamic text is `esc()`'d before innerHTML. Emitted-JS newlines
 * are written `\\n` so they survive into the page script.
 *
 * The page talks to the `/api/jobs*` routes (all `agent:admin`):
 *   - GET    /api/jobs          → list
 *   - POST   /api/jobs          → create
 *   - DELETE /api/jobs/:id      → delete
 *   - POST   /api/jobs/:id/run  → run now
 * Enable/disable is a POST /api/jobs (upsert) with the toggled `enabled`.
 */

import { THEME_CSS, appShell, SHELL_JS } from "./ui-kit.ts";

export const JOBS_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>parachute-agent · schedules</title>
<style>
${THEME_CSS}
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
  textarea, input[type=text], select { width: 100%; box-sizing: border-box; }
  textarea { resize: vertical; min-height: 60px; }
  .presets { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0 0; }
  .presets button { font-size: 0.78rem; padding: 3px 9px; }
  .cron-line { font-family: var(--font-mono); font-size: 0.82rem; color: var(--fg-muted); margin-top: 6px; }
  .cron-line.bad { color: var(--danger); }
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
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th { color: var(--fg-muted); font-weight: 500; font-size: 0.78rem; }
  td.actions { text-align: right; white-space: nowrap; }
  td.actions button { margin-left: 6px; }
  code { font-family: var(--font-mono); color: var(--fg); background: var(--bg-soft); padding: 1px 5px; border-radius: 4px; font-size: 0.8rem; }
  .empty { color: var(--fg-muted); font-size: 0.85rem; padding: 8px 2px; }
  .msg { margin-top: 12px; padding: 10px 12px; border-radius: 8px; font-size: 0.85rem; display: none; white-space: pre-wrap; border: 1px solid transparent; }
  .msg.ok { display: block; background: var(--success-soft); color: var(--success); border-color: var(--success); }
  .msg.err { display: block; background: var(--danger-soft); color: var(--danger); border-color: var(--danger); }
  .laststatus.ok { color: var(--success); }
  .laststatus.err { color: var(--danger); }
  .muted-cell { color: var(--fg-dim); }
</style>
</head>
<body>
  ${appShell({ active: "schedules", tag: "schedules" })}

  <main>
    <!-- Create a schedule -->
    <section id="create-section">
      <h2>Schedule an agent</h2>
      <p class="hint">A scheduled job is an automated human: send a message to an agent on a cron schedule. The runner writes the message as an inbound note; the agent runs its turn as if you typed it. Jobs target <strong>vault-backed agents</strong> only.</p>

      <div class="grid2">
        <div>
          <label for="f-channel">Agent (vault channel)</label>
          <select id="f-channel"></select>
        </div>
        <div>
          <label for="f-id">Job id (slug)</label>
          <input id="f-id" type="text" placeholder="morning-standup" />
        </div>
      </div>

      <div class="field-row" style="margin-top:12px;">
        <label for="f-message">Message to send</label>
        <textarea id="f-message" placeholder="Run the morning weave…"></textarea>
      </div>

      <div class="grid2" style="margin-top:12px;">
        <div>
          <label for="f-cron">Cron (min hour dom mon dow)</label>
          <input id="f-cron" type="text" placeholder="0 8 * * *" />
          <div class="presets" id="cron-presets"></div>
          <div class="cron-line" id="cron-preview"></div>
        </div>
        <div>
          <label for="f-tz">Timezone (IANA, optional)</label>
          <input id="f-tz" type="text" placeholder="America/Los_Angeles" />
          <div class="cron-line" id="tz-default"></div>
        </div>
      </div>

      <div class="row" style="margin-top:14px;">
        <button id="create-btn" class="primary" type="button">Create schedule</button>
      </div>
      <div id="create-msg" class="msg"></div>
    </section>

    <!-- Existing schedules -->
    <section>
      <h2>Schedules</h2>
      <p class="hint">Enable/disable, run now, or delete. <em>Next run</em> is computed from the cron + timezone.</p>
      <div id="jobs-table"></div>
      <div id="list-msg" class="msg"></div>
    </section>
  </main>

<script>
${SHELL_JS}
(function () {
  // MOUNT, setStatus, escapeHtml, fetchToken (caches on window.__token),
  // authedFetch all come from SHELL_JS. Wire the shared nav for this view.
  wireShell("schedules");
  var esc = escapeHtml;
  var vaultChannels = [];

  // The default IANA timezone the daemon would use when a job omits tz — shown so
  // the operator knows what "no tz" resolves to. Computed from the BROWSER here as
  // a hint; the daemon evaluates against ITS local tz, but for an owner-operated
  // single box they're the same. Labeled as a hint, not a guarantee.
  var BROWSER_TZ = (function () {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return "UTC"; }
  })();

  var PRESETS = [
    { label: "daily 8am", cron: "0 8 * * *" },
    { label: "hourly", cron: "0 * * * *" },
    { label: "every 15m", cron: "*/15 * * * *" },
    { label: "weekdays 9am", cron: "0 9 * * 1-5" },
    { label: "weekly Mon 8am", cron: "0 8 * * 1" }
  ];

  function showMsg(el, text, isErr) {
    el.textContent = text; // textContent, not innerHTML — result strings aren't HTML.
    el.className = "msg " + (isErr ? "err" : "ok");
  }
  function clearMsg(el) { el.textContent = ""; el.className = "msg"; }

  // --- token + API (agent:admin Bearer; one 401 retry) ------------------
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

  // --- vault-channel picker (from the OPEN /.parachute/config) -------------
  function loadChannels() {
    return fetch(MOUNT + "/.parachute/config").then(function (r) { return r.json(); }).then(function (cfg) {
      vaultChannels = (cfg.channels || [])
        .filter(function (c) { return c.transport === "vault"; })
        .map(function (c) { return c.name; });
      var sel = document.getElementById("f-channel");
      if (!vaultChannels.length) {
        sel.innerHTML = "<option value=''>(no vault agents — create one on the Agents page)</option>";
        document.getElementById("create-btn").disabled = true;
      } else {
        sel.innerHTML = vaultChannels.map(function (c) {
          return "<option value='" + esc(c) + "'>" + esc(c) + "</option>";
        }).join("");
        document.getElementById("create-btn").disabled = false;
      }
    }).catch(function () {
      document.getElementById("f-channel").innerHTML = "<option value=''>(couldn't load agents)</option>";
    });
  }

  // --- cron preview (a light client-side parse for feedback; the SERVER is the
  //     source of truth — it 400s a bad cron on create) ---------------------
  function describeCron(expr) {
    var parts = String(expr || "").trim().split(/\\s+/);
    if (parts.length !== 5) return { ok: false, text: "cron needs 5 fields: min hour dom mon dow" };
    return { ok: true, text: "min=" + parts[0] + " hour=" + parts[1] + " dom=" + parts[2] + " mon=" + parts[3] + " dow=" + parts[4] };
  }
  function refreshCronPreview() {
    var el = document.getElementById("cron-preview");
    var d = describeCron(document.getElementById("f-cron").value);
    el.textContent = d.text;
    el.className = "cron-line" + (d.ok ? "" : " bad");
  }

  // --- list ---------------------------------------------------------------
  function fmtTime(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  }
  function statusCell(s) {
    if (!s) return "<span class='muted-cell'>—</span>";
    var isErr = s.indexOf("error") === 0;
    return "<span class='laststatus " + (isErr ? "err" : "ok") + "'>" + esc(s) + "</span>";
  }

  function renderJobs(jobs) {
    var t = document.getElementById("jobs-table");
    if (!jobs || !jobs.length) {
      t.innerHTML = "<div class='empty'>No schedules yet. Create one above.</div>";
      return;
    }
    var rows = jobs.map(function (j) {
      var cron = esc(j.schedule && j.schedule.cron ? j.schedule.cron : "");
      var tz = j.schedule && j.schedule.tz ? j.schedule.tz : "";
      var enabled = j.enabled !== false;
      return "<tr>" +
        "<td><code>" + esc(j.id) + "</code></td>" +
        "<td>" + esc(j.channel) + "</td>" +
        "<td><code>" + cron + "</code>" + (tz ? "<br><span class='muted-cell'>" + esc(tz) + "</span>" : "") + "</td>" +
        "<td>" + esc(fmtTime(j.nextRunAt)) + "</td>" +
        "<td>" + statusCell(j.lastStatus) + (j.lastRunAt ? "<br><span class='muted-cell'>" + esc(fmtTime(j.lastRunAt)) + "</span>" : "") + "</td>" +
        "<td class='actions'>" +
          "<button class='ghost' data-toggle='" + esc(j.id) + "'>" + (enabled ? "disable" : "enable") + "</button>" +
          "<button class='ghost' data-run='" + esc(j.id) + "'>run now</button>" +
          "<button class='ghost danger' data-del='" + esc(j.id) + "'>delete</button>" +
        "</td>" +
      "</tr>";
    }).join("");
    t.innerHTML = "<table><thead><tr>" +
      "<th>id</th><th>agent</th><th>cron</th><th>next run</th><th>last status</th><th></th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>";

    // Wire row actions. We keep a copy of the loaded jobs keyed by id for toggle.
    var byId = {};
    jobs.forEach(function (j) { byId[j.id] = j; });
    t.querySelectorAll("[data-run]").forEach(function (b) {
      b.addEventListener("click", function () { runNow(b.getAttribute("data-run")); });
    });
    t.querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", function () { delJob(b.getAttribute("data-del")); });
    });
    t.querySelectorAll("[data-toggle]").forEach(function (b) {
      b.addEventListener("click", function () { toggleJob(byId[b.getAttribute("data-toggle")]); });
    });
  }

  function loadJobs() {
    clearMsg(document.getElementById("list-msg"));
    return apiJson("/api/jobs").then(function (j) {
      renderJobs(j.jobs || []);
      setStatus("ready", "live");
    }).catch(function (err) {
      document.getElementById("jobs-table").innerHTML = "";
      showMsg(document.getElementById("list-msg"), "Couldn't load schedules: " + err.message, true);
      setStatus("error", "err");
    });
  }

  // --- create / toggle / run / delete -------------------------------------
  function createJob() {
    var msg = document.getElementById("create-msg");
    clearMsg(msg);
    var channel = document.getElementById("f-channel").value;
    var id = document.getElementById("f-id").value.trim();
    var message = document.getElementById("f-message").value;
    var cron = document.getElementById("f-cron").value.trim();
    var tz = document.getElementById("f-tz").value.trim();
    if (!channel) { showMsg(msg, "Pick a vault agent first.", true); return; }
    var schedule = { cron: cron };
    if (tz) schedule.tz = tz;
    var body = { id: id, channel: channel, message: message, schedule: schedule, enabled: true };
    var btn = document.getElementById("create-btn");
    btn.disabled = true;
    apiJson("/api/jobs", { method: "POST", body: JSON.stringify(body) }).then(function () {
      showMsg(msg, "Scheduled.", false);
      document.getElementById("f-id").value = "";
      document.getElementById("f-message").value = "";
      return loadJobs();
    }).catch(function (err) {
      showMsg(msg, err.message, true);
    }).then(function () { btn.disabled = false; });
  }

  function toggleJob(job) {
    if (!job) return;
    var body = {
      id: job.id, channel: job.channel, message: job.message,
      schedule: job.schedule, enabled: !(job.enabled !== false)
    };
    apiJson("/api/jobs", { method: "POST", body: JSON.stringify(body) })
      .then(loadJobs)
      .catch(function (err) { showMsg(document.getElementById("list-msg"), err.message, true); });
  }

  function runNow(id) {
    showMsg(document.getElementById("list-msg"), "Running " + id + "…", false);
    apiJson("/api/jobs/" + encodeURIComponent(id) + "/run", { method: "POST" }).then(function (r) {
      showMsg(document.getElementById("list-msg"), "Ran " + id + " (" + (r.status || "ok") + ").", false);
      return loadJobs();
    }).catch(function (err) {
      showMsg(document.getElementById("list-msg"), "Run failed: " + err.message, true);
    });
  }

  function delJob(id) {
    if (!window.confirm("Delete schedule '" + id + "'?")) return;
    apiJson("/api/jobs/" + encodeURIComponent(id), { method: "DELETE" })
      .then(loadJobs)
      .catch(function (err) { showMsg(document.getElementById("list-msg"), err.message, true); });
  }

  // --- wire static UI -----------------------------------------------------
  function renderPresets() {
    var c = document.getElementById("cron-presets");
    c.innerHTML = PRESETS.map(function (p, i) {
      return "<button type='button' data-preset='" + i + "'>" + esc(p.label) + "</button>";
    }).join("");
    c.querySelectorAll("[data-preset]").forEach(function (b) {
      b.addEventListener("click", function () {
        document.getElementById("f-cron").value = PRESETS[+b.getAttribute("data-preset")].cron;
        refreshCronPreview();
      });
    });
  }

  document.getElementById("create-btn").addEventListener("click", createJob);
  document.getElementById("f-cron").addEventListener("input", refreshCronPreview);
  document.getElementById("tz-default").textContent = "no tz → daemon local (" + BROWSER_TZ + ")";
  renderPresets();
  refreshCronPreview();

  // Boot: mint the agent:admin token, then load the picker + the list. A failed
  // token mint still lets the page render (it shows the load error in-place).
  fetchToken().then(function () {
    return Promise.all([loadChannels(), loadJobs()]);
  }).catch(function () {
    loadChannels();
    showMsg(document.getElementById("list-msg"), "Not signed in to the hub — open this from the portal.", true);
  });
})();
</script>
</body>
</html>`;
