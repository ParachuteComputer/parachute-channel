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
import { upsertService } from "./services-manifest.ts";
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
import { loadRegistry, defaultStateDir, type Channel } from "./registry.ts";
import { ClientRegistry } from "./routing.ts";
import { requireScope, SCOPE_READ, SCOPE_WRITE } from "./auth.ts";

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

/** Absolute path to the bridge a Claude Code session spawns — shown in /ui setup. */
const BRIDGE_PATH = join(import.meta.dir, "bridge.ts");

/** Loopback origin a co-located bridge connects to (shown in /ui setup — the
 *  bridge talks to this daemon directly, NOT through hub/the expose). */
const DAEMON_ORIGIN = `http://127.0.0.1:${PORT}`;

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
    },
    emitPermissionVerdict(v): void {
      registry.routeToChannel(channel, "permission_verdict", v);
    },
  };
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
      <p>1. In the working directory you'll run Claude Code from, create <code>.mcp.json</code>:</p>
      <pre><button class="copy" data-copy="mcp">copy</button><code id="snippet-mcp"></code></pre>
      <p>2. Launch Claude Code from that directory:</p>
      <pre><button class="copy" data-copy="launch">copy</button><code id="snippet-launch"></code></pre>
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
  var BRIDGE_PATH = ${JSON.stringify(BRIDGE_PATH).replace(/</g, "\\u003c")};
  // The bridge talks to the daemon directly on loopback (not through hub).
  var DAEMON_ORIGIN = ${JSON.stringify(DAEMON_ORIGIN)};
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
    var mcp = {
      mcpServers: {
        "parachute-channel": {
          command: "bun",
          args: [BRIDGE_PATH],
          env: { PARACHUTE_CHANNEL_URL: DAEMON_ORIGIN, PARACHUTE_CHANNEL_NAME: ch },
        },
      },
    };
    document.getElementById("snippet-mcp").textContent = JSON.stringify(mcp, null, 2);
    document.getElementById("snippet-launch").textContent =
      "claude --dangerously-load-development-channels=server:parachute-channel";
    document.getElementById("setup-note").textContent =
      "On first launch, confirm the dev-channels prompt (\\"I am using this for local development\\"). " +
      "After that, messages you send here inject directly into that idle session, and its replies appear here.";
  }

  document.querySelectorAll(".copy").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      var id = btn.getAttribute("data-copy") === "mcp" ? "snippet-mcp" : "snippet-launch";
      var txt = document.getElementById(id).textContent;
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
        })),
        total_clients: registry.size,
      });
    }

    // Self-describing config (runner pattern) — read-only, no secrets.
    if (req.method === "GET" && url.pathname === "/.parachute/config") {
      return json({
        channels: [...channels.values()].map((c) => ({
          name: c.name,
          transport: c.transport.kind,
        })),
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
                  enum: ["telegram", "http-ui"],
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

    // Built-in chat UI — a global channel-picker page across all http-ui
    // channels. Served by the daemon (not a transport) because it spans every
    // http-ui channel; the per-channel send + SSE routes live in the transport.
    if (req.method === "GET" && url.pathname === "/ui") {
      return new Response(CHAT_UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
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

  for (const channel of channels.values()) {
    channel.transport.start(contextFor(registry, channel.name)).catch((err) => {
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
