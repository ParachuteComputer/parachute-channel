#!/usr/bin/env bun
/**
 * parachute-channel daemon — the transport-agnostic orchestrator.
 *
 * Runs as a long-lived HTTP server (launchd, systemd, or manual). It loads a
 * channel registry (name → transport), starts each transport, and routes
 * inbound traffic to the bridges subscribed to that channel. Bridges connect
 * via SSE (`/events?channel=<name>`) for inbound and POST outbound to the HTTP
 * API with a `channel` field.
 *
 * Telegram is one transport behind the registry; the daemon core touches no
 * platform API directly.
 *
 * Default port: 1941 (PARACHUTE_CHANNEL_PORT env).
 */

import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { timingSafeEqual } from "node:crypto";
import { upsertService } from "./services-manifest.ts";

/** Constant-time webhook-secret compare. Length check first (a length mismatch
 *  is never equal); timingSafeEqual on equal-length buffers avoids the
 *  short-circuit timing leak of `===`. Empty configured/presented → never match. */
function webhookSecretMatches(presented: string, configured: string): boolean {
  if (!presented || !configured || presented.length !== configured.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(configured));
}
import type {
  Transport,
  TransportContext,
  InboundMessage,
  ReplyArgs,
  ReactArgs,
  EditArgs,
  PermissionArgs,
  DownloadArgs,
} from "./transport.ts";
import { ChannelConfigError } from "./transport.ts";
import {
  loadRegistry,
  instantiateTransport,
  upsertChannelEntry,
  removeChannelEntry,
  defaultStateDir,
  type Channel,
  type ChannelEntry,
} from "./registry.ts";
import { VaultTransport, CHANNEL_VAULT_TRIGGER_TEMPLATE } from "./transports/vault.ts";
import { ClientRegistry } from "./routing.ts";
import {
  requireScope,
  extractToken,
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_SEND,
  SCOPE_ADMIN,
} from "./auth.ts";
import { validateHubJwt } from "./hub-jwt.ts";
import {
  handleProtectedResource,
  handleAuthorizationServer,
  mcpWwwAuthenticate,
} from "./oauth-discovery.ts";
import {
  handleMcp,
  pushToChannel as mcpPushToChannel,
  pushPermissionVerdict as mcpPushPermissionVerdict,
  mcpSessionCount,
} from "./mcp-http.ts";

// Re-export the shared auth surface so existing importers of the daemon module
// keep working; the canonical home is now `auth.ts` (shared with http-ui.ts).
export { requireScope, SCOPE_READ, SCOPE_WRITE, SCOPE_SEND } from "./auth.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATE_DIR = defaultStateDir();
const INBOX_DIR = join(STATE_DIR, "inbox");
const PORT = parseInt(process.env.PARACHUTE_CHANNEL_PORT ?? "1941", 10);

/** Channel a bridge subscribes to when `?channel=` is omitted (back-compat). */
const DEFAULT_CHANNEL = "telegram";

/** Package version + install dir, for services.json self-registration. */
const PKG_VERSION = ((): string => {
  try {
    return JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const INSTALL_DIR = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Registry + routing
// ---------------------------------------------------------------------------

/** Build the per-channel context a transport routes through. */
function contextFor(registry: ClientRegistry, channel: string): TransportContext {
  return {
    channel,
    emit(msg: InboundMessage): void {
      // Route on the bound `channel`, NOT msg.channel — the transport's own
      // channel is authoritative. This makes it impossible for a transport to
      // emit onto another channel (closing a silent cross-channel-leak footgun)
      // even if a future transport sets msg.channel incorrectly.
      registry.routeToChannel(channel, "message", {
        content: msg.content,
        meta: msg.meta,
        source: msg.source,
      });
      // ALSO wake any HTTP MCP sessions on this channel — a session connected
      // over /mcp/<channel> (vs. the stdio bridge over /events) receives the
      // same inbound as a server-pushed notifications/claude/channel. Additive:
      // the SSE path above is untouched.
      mcpPushToChannel(channel, msg.content, msg.meta);
    },
    emitPermissionVerdict(v): void {
      registry.routeToChannel(channel, "permission_verdict", v);
      mcpPushPermissionVerdict(channel, v);
    },
  };
}

/**
 * Instantiate one channel entry, start its transport, and register it in the
 * LIVE channels map — the single per-channel "bring a channel up" path. Boot
 * (`main`) and the config-management hot-add both go through here so they can't
 * drift. If a channel with the same name is already live, its old transport is
 * stopped first (config-API replace semantics).
 *
 * `start()` is awaited so a hot-add only reports success once the transport is
 * actually receiving (e.g. the vault transport has fired its schema upsert). At
 * boot a throw is logged per-channel and doesn't abort the others; the config
 * API surfaces the throw to the caller as a 500.
 */
async function addChannelLive(
  channels: Map<string, Channel>,
  registry: ClientRegistry,
  entry: ChannelEntry,
): Promise<Channel> {
  const existing = channels.get(entry.name);
  if (existing) {
    // Replace: stop the old transport before swapping it out so it releases any
    // resources (pollers, SSE clients) before the new one starts.
    try {
      await existing.transport.stop();
    } catch (err) {
      console.error(`parachute-channel: stopping old transport for "${entry.name}" failed (continuing):`, err);
    }
    channels.delete(entry.name);
  }
  const transport = instantiateTransport(entry);
  const channel: Channel = { name: entry.name, transport, entry };
  channels.set(entry.name, channel);
  await transport.start(contextFor(registry, entry.name));
  return channel;
}

/**
 * Stop a live channel's transport and remove it from the map. Idempotent — a
 * missing name is a no-op returning false. The transport's `stop()` is awaited
 * so it releases resources before we drop the reference.
 */
async function removeChannelLive(
  channels: Map<string, Channel>,
  name: string,
): Promise<boolean> {
  const channel = channels.get(name);
  if (!channel) return false;
  try {
    await channel.transport.stop();
  } catch (err) {
    console.error(`parachute-channel: stopping transport for "${name}" failed (continuing):`, err);
  }
  channels.delete(name);
  return true;
}

// ---------------------------------------------------------------------------
// Built-in chat UI
// ---------------------------------------------------------------------------

/**
 * The built-in chat page — a single self-contained HTML document (no framework,
 * no build step). On load it fetches /.parachute/config, lists the http-ui
 * channels as a picker, opens an EventSource on /ui/events?channel=<sel>, and
 * POSTs sends to /api/channels/<sel>/send. This is the surface for verifying
 * messaging works end to end with no Telegram and no vault.
 */
const CHAT_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>parachute-channel · chat</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --line: #262b36; --fg: #e6e9ef;
    --muted: #8b93a3; --you: #2b5cff; --them: #232936; --accent: #4cc2a0;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column; height: 100vh;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel);
  }
  header .brand { font-weight: 600; }
  header .brand small { color: var(--muted); font-weight: 400; }
  header select {
    margin-left: auto; background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; font: inherit;
  }
  #status { font-size: 12px; color: var(--muted); }
  #status.live { color: var(--accent); }
  #transcript {
    flex: 1; overflow-y: auto; padding: 16px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .msg { max-width: 78%; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; word-wrap: break-word; }
  .msg.you { align-self: flex-end; background: var(--you); color: #fff; border-bottom-right-radius: 4px; }
  .msg.them { align-self: flex-start; background: var(--them); border-bottom-left-radius: 4px; }
  .msg.sys { align-self: center; background: transparent; color: var(--muted); font-size: 12px; font-style: italic; max-width: 90%; }
  .msg.perm { align-self: flex-start; background: #3a2f1a; border: 1px solid #6b5320; color: #ffd98a; max-width: 90%; }
  .files { margin-top: 4px; font-size: 12px; opacity: .85; }
  form {
    display: flex; gap: 8px; padding: 12px 16px;
    border-top: 1px solid var(--line); background: var(--panel);
  }
  #input {
    flex: 1; resize: none; background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; font: inherit; max-height: 120px;
  }
  button {
    background: var(--you); color: #fff; border: 0; border-radius: 8px;
    padding: 0 18px; font: inherit; font-weight: 600; cursor: pointer;
  }
  button:disabled { opacity: .4; cursor: default; }
  details.setup { border-bottom: 1px solid var(--line); background: var(--panel); }
  details.setup > summary {
    cursor: pointer; padding: 8px 16px; color: var(--accent); font-size: 13px; user-select: none;
  }
  details.setup .body { padding: 4px 16px 14px; font-size: 13px; color: var(--muted); }
  details.setup .body p { margin: 8px 0 4px; }
  details.setup pre {
    margin: 4px 0; padding: 10px 12px; background: var(--bg); border: 1px solid var(--line);
    border-radius: 8px; overflow-x: auto; color: var(--fg); font-size: 12px; line-height: 1.45;
  }
  details.setup code { color: var(--fg); }
  details.setup .copy {
    float: right; padding: 1px 8px; font-size: 11px; font-weight: 500; background: var(--them);
    border: 1px solid var(--line); border-radius: 6px;
  }
</style>
</head>
<body>
  <header>
    <div class="brand">parachute-channel <small>· chat</small></div>
    <span id="status">connecting…</span>
    <select id="channel" title="channel"></select>
  </header>
  <details class="setup">
    <summary>Connect a Claude Code session ▾</summary>
    <div class="body">
      <p>Two steps — add the channel by URL (like the vault), then open a session on it:</p>
      <p><b>1.</b> Add it (once — prompts for OAuth the first time):</p>
      <pre><button class="copy" data-copy="snippet-add">copy</button><code id="snippet-add"></code></pre>
      <p><b>2.</b> Open a session on it (run in any directory):</p>
      <pre><button class="copy" data-copy="snippet-launch">copy</button><code id="snippet-launch"></code></pre>
      <p id="setup-note"></p>
    </div>
  </details>
  <div id="transcript"></div>
  <form id="composer">
    <textarea id="input" rows="1" placeholder="Type a message… (Enter to send, Shift+Enter for newline)" autocomplete="off"></textarea>
    <button id="send" type="submit" disabled>Send</button>
  </form>
<script>
(function () {
  var transcript = document.getElementById("transcript");
  var sel = document.getElementById("channel");
  var input = document.getElementById("input");
  var sendBtn = document.getElementById("send");
  var statusEl = document.getElementById("status");
  var form = document.getElementById("composer");
  var es = null;
  // Served through hub the page is /channel/ui; locally it's /ui. Derive the
  // mount prefix so every API/SSE call resolves under the same prefix.
  var MOUNT = location.pathname.replace(/\\/ui\\/?$/, "");

  // ----- Layer 2 auth -----------------------------------------------------
  // The daemon's send + SSE endpoints require a hub-issued channel JWT
  // (aud:channel, scopes channel:read channel:send). The hub mints one for the
  // logged-in portal operator at <hub-origin>/admin/channel-token (cookie-gated,
  // ~10min TTL). We fetch it from the page origin (same origin as the hub when
  // served through the expose) and attach it: Bearer header on POST, ?token= on
  // the EventSource (which can't set headers). A direct-to-daemon / not-logged-in
  // load just leaves the token unset and surfaces a notice — an unguarded dev
  // daemon may still accept the calls, so we don't hard-crash.
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
      .catch(function (err) {
        window.__token = null;
        add("sys", "Not authenticated — open this UI through the hub portal (" + err + ")");
        return null;
      });
  }

  function updateSetup(ch) {
    if (!ch) return;
    // The public origin this channel is reachable at. Served through the hub
    // expose, location.origin IS the hub origin and the channel mounts under
    // /channel; served directly off the daemon, it's the loopback origin with
    // no mount prefix. MOUNT (derived from the page path) captures that prefix.
    var name = "channel-" + ch;
    var url = window.location.origin + MOUNT + "/mcp/" + ch;
    document.getElementById("snippet-add").textContent =
      "claude mcp add --transport http --scope user " + name + " " + url;
    document.getElementById("snippet-launch").textContent =
      "claude --dangerously-load-development-channels=server:" + name + " --dangerously-skip-permissions";
    document.getElementById("setup-note").textContent =
      "Step 1 prompts for OAuth the first time (like adding the vault) — no local file, any machine. " +
      "Step 2 makes that session a live responder for this channel; the flag's name MUST match step 1. " +
      "--scope user makes it available in any directory — drop it to scope to the current project. " +
      "Then messages you send here inject into that idle session and its replies appear here.";
  }

  document.querySelectorAll(".copy").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      var el = document.getElementById(btn.getAttribute("data-copy") || "");
      if (!el) return;
      var txt = el.textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(txt);
      var prev = btn.textContent; btn.textContent = "copied"; setTimeout(function () { btn.textContent = prev; }, 1200);
    });
  });

  function add(kind, text, files) {
    var el = document.createElement("div");
    el.className = "msg " + kind;
    el.textContent = text;
    if (files && files.length) {
      var f = document.createElement("div");
      f.className = "files";
      f.textContent = "📎 " + files.join(", ");
      el.appendChild(f);
    }
    transcript.appendChild(el);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function setStatus(text, live) {
    statusEl.textContent = text;
    statusEl.className = live ? "live" : "";
  }

  function currentChannel() { return sel.value; }

  // Guard so an SSE error triggers at most one token-refresh+reconnect per
  // connect cycle (the token is short-lived; a stale one 401s the stream).
  var sseRetried = false;

  function connect() {
    if (es) { es.close(); es = null; }
    var ch = currentChannel();
    if (!ch) { setStatus("no channel", false); sendBtn.disabled = true; return; }
    updateSetup(ch);
    setStatus("connecting…", false);
    var url = MOUNT + "/ui/events?channel=" + encodeURIComponent(ch);
    if (window.__token) url += "&token=" + encodeURIComponent(window.__token);
    es = new EventSource(url);
    es.onopen = function () { sseRetried = false; setStatus("● live · " + ch, true); sendBtn.disabled = false; };
    es.addEventListener("reply", function (e) {
      try { var d = JSON.parse(e.data); add("them", d.text || "", d.files); }
      catch (_) { add("them", e.data); }
    });
    es.addEventListener("edit", function (e) {
      try { var d = JSON.parse(e.data); add("sys", "(edited) " + (d.text || "")); } catch (_) {}
    });
    es.addEventListener("permission", function (e) {
      try {
        var d = JSON.parse(e.data);
        add("perm", "🔐 permission: " + d.tool_name + "\\n" + (d.description || "") + "\\n" + (d.input_preview || ""));
      } catch (_) {}
    });
    es.addEventListener("close", function () { setStatus("closed", false); });
    es.onerror = function () {
      // A stale/short-lived token 401s the stream. Refresh the token once and
      // reconnect; otherwise let EventSource auto-reconnect (transient network).
      if (!sseRetried && window.__token) {
        sseRetried = true;
        setStatus("re-authenticating…", false);
        if (es) { es.close(); es = null; }
        fetchToken().then(function () { connect(); });
        return;
      }
      setStatus("reconnecting…", false);
    };
  }

  function postSend(ch, text) {
    var headers = { "content-type": "application/json" };
    if (window.__token) headers.authorization = "Bearer " + window.__token;
    return fetch(MOUNT + "/api/channels/" + encodeURIComponent(ch) + "/send", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ text: text }),
    });
  }

  function send() {
    var text = input.value.trim();
    var ch = currentChannel();
    if (!text || !ch) return;
    add("you", text);
    input.value = "";
    autosize();
    postSend(ch, text).then(function (r) {
      if (r.ok) return;
      // The token is short-lived; on a 401 refresh it once and retry the send.
      if (r.status === 401) {
        return fetchToken().then(function (tok) {
          if (!tok) { add("sys", "send failed: not authenticated"); return; }
          return postSend(ch, text).then(function (r2) {
            if (!r2.ok) return r2.json().catch(function(){return {};}).then(function (j) {
              add("sys", "send failed: " + (j.error || r2.status));
            });
          });
        });
      }
      return r.json().catch(function(){return {};}).then(function (j) {
        add("sys", "send failed: " + (j.error || r.status));
      });
    }).catch(function (err) { add("sys", "send failed: " + err); });
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); send(); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener("input", autosize);
  sel.addEventListener("change", function () {
    transcript.innerHTML = "";
    var url = new URL(window.location.href);
    url.searchParams.set("channel", sel.value);
    history.replaceState(null, "", url);
    connect();
  });

  function loadChannelsAndConnect() {
    return fetch(MOUNT + "/.parachute/config").then(function (r) { return r.json(); }).then(function (cfg) {
      var chans = (cfg.channels || []).filter(function (c) { return c.transport === "http-ui"; });
      if (!chans.length) { setStatus("no http-ui channels configured", false); return; }
      var preselect = new URL(window.location.href).searchParams.get("channel");
      chans.forEach(function (c) {
        var opt = document.createElement("option");
        opt.value = c.name; opt.textContent = c.name;
        if (c.name === preselect) opt.selected = true;
        sel.appendChild(opt);
      });
      connect();
    }).catch(function (err) { setStatus("config load failed: " + err, false); });
  }

  // Fetch a hub token first (so SSE + send go out authenticated), then list the
  // channels and connect. A token failure still proceeds — an unguarded dev
  // daemon may accept the calls, and the failure already surfaced a notice.
  fetchToken().then(loadChannelsAndConnect);
})();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Auth gates
//
// Both layers share `requireScope` from `auth.ts` (validate a hub-issued JWT
// against the hub's JWKS via scope-guard, assert a scope). It accepts the token
// from an `Authorization: Bearer` header OR a `?token=` query param.
//
// Layer 1 — bridge / session↔channel. The session↔channel connection is
// authenticated with hub-issued JWTs, exactly like a vault MCP client. A
// launched session has full machine access, so we do NOT rely on loopback trust
// — any session on any machine presents a hub token (`aud: "channel"`, scopes
// `channel:read`/`channel:write`) as a Bearer header and the daemon validates
// it against the hub's JWKS. Scope split: subscribing to inbound events is
// `channel:read`; sending anything out (reply/react/edit/permission/download)
// is `channel:write`.
//
// Layer 2 — human / chat UI — gates the http-ui transport's `send` (POST,
// `channel:send`) + `/ui/events` SSE (`?token=` query, `channel:read`) inside
// `http-ui.ts`'s ingestHttp using the same `requireScope`.
//
// Discovery + the page itself (/health, /.parachute/config[/schema], /ui) stay
// OPEN — non-sensitive, and /ui must load to bootstrap its token fetch.
// ---------------------------------------------------------------------------

/**
 * Build the daemon's HTTP fetch handler over a channel registry + client
 * registry. Extracted as a factory so tests can exercise routing + the auth
 * gate on an ephemeral `Bun.serve` without booting the real daemon (and without
 * a live hub — the no-token 401 path short-circuits before JWKS).
 */
export function createFetchHandler(
  channels: Map<string, Channel>,
  registry: ClientRegistry,
): (req: Request) => Promise<Response> {
  /** Resolve the transport for a channel name, or null on miss. */
  function transportFor(channel: string | undefined): Transport | null {
    if (!channel) return null;
    return channels.get(channel)?.transport ?? null;
  }

  function channelError(channel: string | undefined): Response {
    if (!channel) {
      return json({ error: "missing 'channel' field in request body" }, 400);
    }
    return json(
      {
        error: `unknown channel "${channel}" — known channels: ${[...channels.keys()].join(", ") || "(none)"}`,
      },
      400,
    );
  }

  function methodMissing(channel: string, method: string): Response {
    const kind = channels.get(channel)?.transport.kind ?? "unknown";
    return json(
      { error: `transport "${kind}" for channel "${channel}" does not support ${method}` },
      400,
    );
  }

  // Idempotency for the vault inbound webhook: a small bounded set of recently-
  // seen note ids so a duplicate trigger delivery doesn't double-wake the
  // session. Bounded by eviction (oldest-out) so it can't grow unbounded.
  const seenInboundNoteIds = new Set<string>();
  const SEEN_INBOUND_CAP = 2048;
  function markSeen(noteId: string): boolean {
    if (seenInboundNoteIds.has(noteId)) return false; // already processed
    seenInboundNoteIds.add(noteId);
    if (seenInboundNoteIds.size > SEEN_INBOUND_CAP) {
      // Evict the oldest insertion (Set preserves insertion order).
      const oldest = seenInboundNoteIds.values().next().value;
      if (oldest !== undefined) seenInboundNoteIds.delete(oldest);
    }
    return true;
  }

  return async function fetch(req) {
    const url = new URL(req.url);

    // Health check — per-channel client counts.
    if (url.pathname === "/health") {
      return json({
        status: "ok",
        channels: [...channels.values()].map((c) => ({
          name: c.name,
          kind: c.transport.kind,
          clients: registry.countForChannel(c.name),
          mcp_sessions: mcpSessionCount(c.name),
        })),
        total_clients: registry.size,
      });
    }

    // Self-describing config (runner pattern) — read-only, no secrets.
    //
    // `triggerTemplate` is MODULE-OWNED DATA: the prescribed vault trigger this
    // channel needs the hub to register on its behalf (PR 3). The hub GETs this,
    // substitutes the channel name into the `<channel>` placeholders, fills the
    // `<hub-origin>` in `action.webhook`, and injects `action.auth.bearer` (a
    // minted channel:send JWT) — so the channel owns its own trigger shape rather
    // than the hub hardcoding it.
    if (req.method === "GET" && url.pathname === "/.parachute/config") {
      return json({
        channels: [...channels.values()].map((c) => ({
          name: c.name,
          transport: c.transport.kind,
        })),
        triggerTemplate: CHANNEL_VAULT_TRIGGER_TEMPLATE,
      });
    }

    if (req.method === "GET" && url.pathname === "/.parachute/config/schema") {
      return json({
        title: "parachute-channel config",
        description: "Named channels, each bound to a transport.",
        type: "object",
        properties: {
          channels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Unique channel name bridges subscribe to." },
                transport: {
                  type: "string",
                  enum: ["telegram", "http-ui", "vault"],
                  description: "Transport kind backing this channel.",
                },
                config: {
                  type: "object",
                  description: "Transport-specific config (secrets live here, not returned by /config).",
                },
              },
              required: ["name", "transport"],
            },
          },
        },
        required: ["channels"],
      });
    }

    // ---------------------------------------------------------------------
    // Channel config-management API — the hub writes channels.json + hot-adds
    // the channel to the LIVE daemon, so a frictionless setup never hand-edits a
    // file or restarts the daemon. Gated on a hub JWT with `channel:admin`.
    //
    //   POST   /api/channels        { name, transport, config } → write + hot-add
    //   GET    /api/channels        → list (name + transport + vault; NO secrets)
    //   DELETE /api/channels/:name  → stop + unregister + remove from channels.json
    //
    // Externally hub strips `/channel`, so these are `<hub>/channel/api/channels`.
    // ---------------------------------------------------------------------
    if (url.pathname === "/api/channels" && (req.method === "GET" || req.method === "POST")) {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;

      if (req.method === "GET") {
        // List configured channels — surface ONLY name + transport + vault (for a
        // vault transport). NEVER the token/secret: this is an admin read, but the
        // file holds credentials we don't echo back.
        return json({
          channels: [...channels.values()].map((c) => {
            const out: { name: string; transport: string; vault?: string } = {
              name: c.name,
              transport: c.transport.kind,
            };
            const v = (c.entry.config as { vault?: unknown } | undefined)?.vault;
            if (typeof v === "string") out.vault = v;
            return out;
          }),
        });
      }

      // POST — create/replace a channel.
      let cfgBody: { name?: unknown; transport?: unknown; config?: unknown };
      try {
        cfgBody = (await req.json()) as typeof cfgBody;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (typeof cfgBody.name !== "string" || cfgBody.name.length === 0) {
        return json({ error: "body.name (string) is required" }, 400);
      }
      if (typeof cfgBody.transport !== "string" || cfgBody.transport.length === 0) {
        return json({ error: "body.transport (string) is required" }, 400);
      }
      const entry: ChannelEntry = {
        name: cfgBody.name,
        transport: cfgBody.transport,
        config:
          cfgBody.config && typeof cfgBody.config === "object"
            ? (cfgBody.config as Record<string, unknown>)
            : undefined,
      };
      // Validate the entry by instantiating it FIRST (constructor throws on a
      // missing required field — e.g. a vault channel with no token). We do this
      // before writing channels.json so a bad request never persists a broken
      // entry. `addChannelLive` re-instantiates; the throwaway here is the gate.
      try {
        instantiateTransport(entry);
      } catch (err) {
        return json({ error: `invalid channel config: ${(err as Error).message}` }, 400);
      }
      // Persist FIRST (chmod 600 — holds a token), then hot-add to the live
      // daemon. If the hot-add throws, the file is already written, so a daemon
      // restart would still pick it up; we surface the error AND a restart hint.
      try {
        // Resolve the state dir at request time (defaultStateDir reads the env)
        // so the persisted file always lands where the daemon would next read it,
        // even if the env was set after module load (and so it's testable).
        upsertChannelEntry(entry, defaultStateDir());
      } catch (err) {
        return json({ error: `failed to write channels.json: ${(err as Error).message}` }, 500);
      }
      try {
        await addChannelLive(channels, registry, entry);
      } catch (err) {
        return json(
          {
            ok: true,
            name: entry.name,
            transport: entry.transport,
            live: false,
            restart_needed: true,
            error: `channel persisted but hot-add failed: ${(err as Error).message}`,
          },
          200,
        );
      }
      return json({ ok: true, name: entry.name, transport: entry.transport, live: true });
    }

    const delMatch = url.pathname.match(/^\/api\/channels\/([^/]+)$/);
    if (delMatch && req.method === "DELETE") {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;
      const name = decodeURIComponent(delMatch[1]!);
      const wasLive = await removeChannelLive(channels, name);
      // Always rewrite channels.json (idempotent) so the file matches the live
      // state even if the channel was only on disk (added before a restart).
      try {
        removeChannelEntry(name, defaultStateDir());
      } catch (err) {
        return json({ error: `failed to update channels.json: ${(err as Error).message}` }, 500);
      }
      if (!wasLive) {
        // Not in the live map. Either never live, or removed from disk only.
        return json({ ok: true, name, removed: false }, 200);
      }
      return json({ ok: true, name, removed: true });
    }

    // ---------------------------------------------------------------------
    // OAuth discovery for the HTTP MCP surface — RFC 9728 + RFC 8414, in the
    // PATH-INSERTION form (`.well-known` ABOVE the resource path). This is the
    // shape a Claude Code HTTP-MCP client probes when adding the channel by URL
    // (the same shape vault serves). For the resource at `/mcp/<channel>`:
    //
    //   /.well-known/oauth-protected-resource/mcp/<channel>
    //   /.well-known/oauth-authorization-server/mcp/<channel>
    //
    // Both are PUBLIC (no auth) — they have to be reachable before the client
    // holds a token. Externally they're `<hub>/channel/.well-known/...`; hub's
    // stripPrefix removes `/channel`, so the daemon matches the bare path and
    // re-adds the prefix in the advertised URLs via x-forwarded-host.
    // ---------------------------------------------------------------------
    if (req.method === "GET") {
      const prm = url.pathname.match(/^\/\.well-known\/oauth-protected-resource\/mcp\/([^/]+)$/);
      if (prm) return handleProtectedResource(req, decodeURIComponent(prm[1]!));
      const asm = url.pathname.match(/^\/\.well-known\/oauth-authorization-server\/mcp\/([^/]+)$/);
      if (asm) return handleAuthorizationServer(req, decodeURIComponent(asm[1]!));
    }

    // SSE event stream — bridges subscribe by channel. Bridge-facing: requires
    // a hub JWT with `channel:read`.
    if (req.method === "GET" && url.pathname === "/events") {
      const denied = await requireScope(req, url, SCOPE_READ);
      if (denied) return denied;
      let channel = url.searchParams.get("channel") ?? undefined;
      if (!channel) {
        channel = DEFAULT_CHANNEL;
        console.warn(
          `parachute-channel: /events without ?channel= — defaulting to "${DEFAULT_CHANNEL}". ` +
            `This back-compat default is deprecated; pass ?channel=<name>.`,
        );
      }
      const subscribedChannel = channel;
      const clientId = crypto.randomUUID();
      const stream = new ReadableStream<string>({
        start(controller) {
          registry.add(clientId, {
            channel: subscribedChannel,
            enqueue: (payload) => controller.enqueue(payload),
          });
          controller.enqueue(": connected\n\n");
        },
        cancel() {
          registry.remove(clientId);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    // Reply — bridge-facing: requires `channel:write`.
    if (req.method === "POST" && url.pathname === "/api/reply") {
      const denied = await requireScope(req, url, SCOPE_WRITE);
      if (denied) return denied;
      try {
        const body = (await req.json()) as {
          channel?: string;
          chat_id?: string;
          text?: string;
          reply_to?: string;
          files?: string[];
          meta?: Record<string, string>;
        };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        const result = await transport.reply(toReplyArgs(body));
        return json({ sent: result.sent });
      } catch (err) {
        return errResponse(err);
      }
    }

    // React — bridge-facing: requires `channel:write`.
    if (req.method === "POST" && url.pathname === "/api/react") {
      const denied = await requireScope(req, url, SCOPE_WRITE);
      if (denied) return denied;
      try {
        const body = (await req.json()) as {
          channel?: string;
          chat_id?: string;
          message_id: string;
          emoji: string;
          meta?: Record<string, string>;
        };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        if (!transport.react) return methodMissing(body.channel!, "react");
        const args: ReactArgs = {
          channel: body.channel!,
          message_id: body.message_id,
          emoji: body.emoji,
          meta: mergeMeta(body),
        };
        await transport.react(args);
        return json({ ok: true });
      } catch (err) {
        return errResponse(err);
      }
    }

    // Edit message — bridge-facing: requires `channel:write`.
    if (req.method === "POST" && url.pathname === "/api/edit") {
      const denied = await requireScope(req, url, SCOPE_WRITE);
      if (denied) return denied;
      try {
        const body = (await req.json()) as {
          channel?: string;
          chat_id?: string;
          message_id: string;
          text: string;
          meta?: Record<string, string>;
        };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        if (!transport.edit) return methodMissing(body.channel!, "edit");
        const args: EditArgs = {
          channel: body.channel!,
          message_id: body.message_id,
          text: body.text,
          meta: mergeMeta(body),
        };
        await transport.edit(args);
        return json({ ok: true });
      } catch (err) {
        return errResponse(err);
      }
    }

    // Permission prompt — bridge forwards permission_request here.
    // Bridge-facing: requires `channel:write`.
    if (req.method === "POST" && url.pathname === "/api/permission") {
      const denied = await requireScope(req, url, SCOPE_WRITE);
      if (denied) return denied;
      try {
        const body = (await req.json()) as {
          channel?: string;
          request_id: string;
          tool_name: string;
          description: string;
          input_preview: string;
        };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        if (!transport.sendPermission) return methodMissing(body.channel!, "sendPermission");
        const args: PermissionArgs = {
          channel: body.channel!,
          request_id: body.request_id,
          tool_name: body.tool_name,
          description: body.description,
          input_preview: body.input_preview,
        };
        const result = await transport.sendPermission(args);
        return json({ sent: result.sent });
      } catch (err) {
        return errResponse(err);
      }
    }

    // Download attachment — bridge-facing: requires `channel:write`.
    if (req.method === "POST" && url.pathname === "/api/download") {
      const denied = await requireScope(req, url, SCOPE_WRITE);
      if (denied) return denied;
      try {
        const body = (await req.json()) as { channel?: string; file_id: string };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        if (!transport.download) return methodMissing(body.channel!, "download");
        const args: DownloadArgs = { channel: body.channel!, file_id: body.file_id };
        const result = await transport.download(args);
        return json({ path: result.path });
      } catch (err) {
        return errResponse(err);
      }
    }

    // Vault inbound webhook — a vault trigger POSTs here when a new
    // `#channel-message/inbound` note appears. Resolves the target channel from
    // `note.metadata.channel`, asserts it's a vault-transport channel, and hands
    // the note to that transport's `ingestInbound`, which `ctx.emit`s it →
    // wakes the subscribed bridge / MCP session.
    //
    // Auth — two paths, in order:
    //   1. PREFERRED: `Authorization: Bearer <hub JWT>` (aud:channel, scope
    //      `channel:send` — the trigger is effectively "posting an inbound
    //      message"). The hub registers the trigger with `action.auth.bearer`
    //      set to a minted channel:send token, so a fresh setup never touches a
    //      shared secret. Validated via the same scope-guard path as the bridge.
    //   2. DEPRECATED back-compat: a shared `?secret=` (or `X-Channel-Webhook-Secret`)
    //      validated against the target channel's vault-transport `webhookSecret`,
    //      for existing manual setups whose triggers still ride the secret in the
    //      URL. Logs a one-line deprecation warning when used.
    // A request with NEITHER → 401. We keep the uniform-401 (no channel
    // enumeration) behavior on both paths.
    if (req.method === "POST" && url.pathname === "/api/vault/inbound") {
      let body: {
        trigger?: string;
        event?: string;
        note?: { id?: string; path?: string; content?: string; tags?: string[]; metadata?: Record<string, unknown> };
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const note = body.note;
      if (!note || typeof note.id !== "string" || !note.id) {
        return json({ error: "body must include note.id" }, 400);
      }
      const channelName =
        typeof note.metadata?.channel === "string" ? note.metadata.channel : undefined;
      if (!channelName) {
        return json({ error: "note.metadata.channel is required to route the message" }, 400);
      }
      const ch = channels.get(channelName);
      const vt = ch?.transport instanceof VaultTransport ? ch.transport : undefined;

      // Branch on Authorization-header PRESENCE, not token truthiness. A
      // whitespace-only `Authorization: Bearer   ` (which extractBearer trims to
      // empty/falsy) must NOT fall through to the `?secret=` path — that would let
      // a caller who knows the secret but lacks a valid JWT force the secret path.
      // Any Authorization header at all → JWT path, full stop; a malformed/empty
      // token fails hard via requireScope's 401. The deprecated `?secret=`
      // fallback runs ONLY when there is no Authorization header.
      const authHeader = req.headers.get("authorization");
      if (authHeader !== null) {
        // JWT path — validate the hub token, require channel:send. This is a
        // tailnet-reachable webhook, so we keep it uniform-401: any auth failure
        // (missing/malformed/expired token OR insufficient scope OR unknown
        // channel) collapses to the SAME 401, so it can't be probed for valid
        // scopes or channel names. (requireScope would otherwise distinguish 401
        // vs 403 — fine for the operator-facing config API, but this endpoint
        // stays opaque.)
        const denied = await requireScope(req, url, SCOPE_SEND);
        if (denied || !vt) {
          return json({ error: "unauthorized" }, 401);
        }
      } else {
        // DEPRECATED shared-secret fallback — only reachable with NO Authorization
        // header. The secret is per-channel, so resolve the channel first, then
        // constant-time compare. Uniform 401 for an unknown vault channel, a
        // channel with no configured secret (nothing to validate against), OR a
        // bad secret — never reveal which (no channel enumeration on this
        // tailnet-reachable endpoint). webhookSecretMatches treats an empty/absent
        // configured secret as never-matching, so a JWT-only channel (no secret)
        // can't be opened by a `?secret=` request.
        const presented =
          url.searchParams.get("secret") ?? req.headers.get("x-channel-webhook-secret") ?? "";
        if (!vt || !webhookSecretMatches(presented, vt.webhookSecret ?? "")) {
          return json({ error: "unauthorized" }, 401);
        }
        console.warn(
          `parachute-channel: /api/vault/inbound authenticated via DEPRECATED ?secret= shared secret ` +
            `for channel "${channelName}". Migrate to a hub-JWT trigger (action.auth.bearer, scope channel:send).`,
        );
      }
      // Idempotency: a duplicate trigger delivery for the same note must not
      // double-wake. First-seen → process; already-seen → ack without emitting.
      if (markSeen(note.id)) {
        vt.ingestInbound({ id: note.id, content: note.content, tags: note.tags, metadata: note.metadata });
      }
      // Never write back to the note — the v1 trigger handles its own
      // created/rendered_at markers vault-side.
      return json({ ok: true });
    }

    // Built-in chat UI — a global channel-picker page across all http-ui
    // channels. Served by the daemon (not a transport) because it spans every
    // http-ui channel; the per-channel send + SSE routes live in the transport.
    if (req.method === "GET" && url.pathname === "/ui") {
      return new Response(CHAT_UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Stateful HTTP MCP — a session connects directly over HTTP (URL + OAuth,
    // no stdio bridge): POST/GET/DELETE /mcp/<channel>. Externally this is
    // `<hub>/channel/mcp/<channel>`; hub's stripPrefix removes `/channel`, so the
    // daemon sees `/mcp/<channel>`. A session needs `channel:read` to connect +
    // receive the wake; the reply/react/edit tools additionally require
    // `channel:write`, enforced inside the tool handlers from the connection's
    // own scopes. This endpoint is ADDITIVE — the stdio bridge over /events is
    // unchanged.
    const mcpMatch = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (mcpMatch) {
      const channel = decodeURIComponent(mcpMatch[1]!);
      const transport = transportFor(channel);
      if (!transport) {
        return json(
          {
            error: `unknown channel "${channel}" — known channels: ${[...channels.keys()].join(", ") || "(none)"}`,
          },
          404,
        );
      }
      // Gate on channel:read — short-circuits to 401 pre-JWKS when no token is
      // presented (testable without a live hub, same as the other endpoints).
      // On a 401 (no/invalid bearer), decorate with the RFC 9728
      // `WWW-Authenticate` challenge so a Claude Code HTTP-MCP client knows
      // where to discover OAuth (mirrors vault's withMcpChallenge). The other
      // endpoints (/events, /api/*) stay plain 401 — only the /mcp path drives
      // a spec OAuth client, so only it carries the challenge.
      const denied = await requireScope(req, url, SCOPE_READ);
      if (denied) {
        if (denied.status === 401) {
          const headers = new Headers(denied.headers);
          headers.set("WWW-Authenticate", mcpWwwAuthenticate(req, channel));
          return new Response(await denied.text(), { status: 401, headers });
        }
        return denied;
      }
      // Re-validate to surface the caller's scopes for the write-tool checks.
      // (requireScope already proved the token valid + carrying channel:read;
      // this second pass hits the warm JWKS cache.) A token present but missing
      // here would have been rejected above, so claims must resolve.
      let scopes: string[] = [];
      try {
        const token = extractToken(req, url);
        if (token) scopes = (await validateHubJwt(token)).scopes;
      } catch {
        // Unreachable in practice (requireScope passed); fall back to read-only.
        scopes = [SCOPE_READ];
      }
      return handleMcp(req, channel, transport, scopes);
    }

    // Give each transport a chance to handle a route the daemon didn't. Runs
    // after the daemon's own built-in routes and before the final 404. A
    // transport returns a Response if it owns the path, or null to pass.
    for (const ch of channels.values()) {
      const res = await ch.transport.ingestHttp?.(req, url);
      if (res) return res;
    }

    return json({ error: "not found" }, 404);
  };
}

// ---------------------------------------------------------------------------
// Request helpers (module-scope; hoisted, referenced from inside the factory)
// ---------------------------------------------------------------------------

/**
 * Map a thrown error to a response: ChannelConfigError → 400 (operator must fix
 * config), anything else → 500 (runtime fault). Lets callers distinguish the two.
 */
function errResponse(err: unknown): Response {
  if (err instanceof ChannelConfigError) return json({ error: err.message }, 400);
  return json({ error: String(err) }, 500);
}

/**
 * Build the meta map for outbound calls. Telegram addressing historically came
 * in as a top-level `chat_id`; preserve that by folding it into `meta.chat_id`
 * while letting an explicit `meta` object take precedence/extend.
 */
function mergeMeta(body: { chat_id?: string; meta?: Record<string, string> }): Record<string, string> {
  const meta: Record<string, string> = { ...(body.meta ?? {}) };
  if (body.chat_id !== undefined && meta.chat_id === undefined) meta.chat_id = body.chat_id;
  return meta;
}

function toReplyArgs(body: {
  channel?: string;
  chat_id?: string;
  text?: string;
  reply_to?: string;
  files?: string[];
  meta?: Record<string, string>;
}): ReplyArgs {
  return {
    channel: body.channel!,
    text: body.text,
    files: body.files,
    reply_to: body.reply_to,
    meta: mergeMeta(body),
  };
}

// ---------------------------------------------------------------------------
// Boot — load the registry, bind Bun.serve, start every transport.
//
// Gated on `import.meta.main` so importing this module (e.g. from a test that
// only wants `createFetchHandler` / `requireScope`) does NOT load the registry,
// bind a port, or `process.exit` on a missing config.
// ---------------------------------------------------------------------------

function main(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(INBOX_DIR, { recursive: true });

  let channels: Map<string, Channel>;
  try {
    channels = loadRegistry({ stateDir: STATE_DIR });
  } catch (err) {
    console.error(`parachute-channel: failed to load channel registry: ${err}`);
    process.exit(1);
  }

  if (channels.size === 0) {
    console.error(
      `parachute-channel: no channels configured.\n` +
        `  Add ${join(STATE_DIR, "channels.json")} or set TELEGRAM_BOT_TOKEN\n` +
        `  (env or ${join(STATE_DIR, ".env")}) for a default telegram channel.`,
    );
    process.exit(1);
  }

  const registry = new ClientRegistry();

  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: createFetchHandler(channels, registry),
  });

  console.log(`parachute-channel: daemon listening on http://127.0.0.1:${PORT}`);
  console.log(`parachute-channel: state dir: ${STATE_DIR}`);
  console.log(
    `parachute-channel: ${channels.size} channel(s): ${[...channels.values()]
      .map((c) => `${c.name}→${c.transport.kind}`)
      .join(", ")}`,
  );

  // Self-register into ~/.parachute/services.json so hub lists this module in the
  // portal and reverse-proxies `<expose>/channel/*` → this loopback daemon.
  // Best-effort: a failure must not stop the daemon from serving locally. Honors
  // PARACHUTE_HOME, so sandboxed/e2e daemons never touch the real services.json.
  try {
    upsertService({
      name: "parachute-channel",
      port: PORT,
      paths: ["/channel"],
      health: "/health",
      version: PKG_VERSION,
      displayName: "Channel",
      tagline: "Chat with your Claude Code sessions — a channel per session.",
      installDir: INSTALL_DIR,
      stripPrefix: true,
      uiUrl: "/channel/ui", // portal "Open UI" link (also in module.json; written here in case hub reads it from services.json)
    });
    console.log(`parachute-channel: self-registered into services.json (port ${PORT}, mount /channel)`);
  } catch (err) {
    console.error(`parachute-channel: services.json self-registration failed (continuing): ${err}`);
  }

  // Start each channel via the same single-channel add path the config API uses
  // (`addChannelLive`), so boot and hot-add can't drift. The map already holds
  // the channels (from `loadRegistry`); addChannelLive replaces-in-place, which
  // for a freshly-instantiated boot transport means stop()→re-instantiate→start.
  // Per-channel failures are logged and don't abort the others; the daemon must
  // still serve the channels that did come up.
  for (const channel of [...channels.values()]) {
    addChannelLive(channels, registry, channel.entry).catch((err) => {
      console.error(`parachute-channel: transport "${channel.name}" start failed:`, err);
    });
  }

  // Graceful shutdown — stop all transports.
  async function shutdown(): Promise<void> {
    await Promise.allSettled([...channels.values()].map((c) => c.transport.stop()));
    server.stop();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) main();
