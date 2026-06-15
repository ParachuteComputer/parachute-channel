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
 * Port resolution (see `resolvePort`): the hub supervisor's injected `PORT`
 * wins, then the back-compat `PARACHUTE_CHANNEL_PORT` override, then the
 * compiled-in canonical default 1941. The daemon binds AND self-registers the
 * resolved port, so the supervisor's probe/proxy and the bound port never
 * disagree (channel#41).
 */

import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { timingSafeEqual } from "node:crypto";
import { upsertService, listVaultNames } from "./services-manifest.ts";

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
import {
  setDefaultClaudeCredential,
  setChannelClaudeCredential,
  removeChannelClaudeCredential,
  describeClaudeCredentials,
} from "./credentials.ts";
import { ClientRegistry } from "./routing.ts";
import {
  requireScope,
  extractToken,
  json as authJson,
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_SEND,
  SCOPE_ADMIN,
  SCOPE_TERMINAL,
} from "./auth.ts";
import {
  createTerminalWsHandlers,
  type TerminalWsData,
} from "./terminal.ts";
import { TERMINAL_UI_HTML } from "./terminal-ui.ts";
import { serveTerminalAsset } from "./terminal-assets.ts";
import { AGENTS_UI_HTML } from "./agents-ui.ts";
import { HOME_UI_HTML } from "./home-ui.ts";
import {
  createRealAgentOps,
  buildSpecFromBody,
  redactSpawnResult,
  SpawnRequestError,
  AGENT_NAME_SLUG,
  type AgentOps,
} from "./agents.ts";
import { SpawnDepsError } from "./spawn-deps.ts";
import { CredentialNotConfiguredError } from "./credentials.ts";
import { MintError } from "./mint-token.ts";
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
import { renderAdminPage } from "./admin-ui.ts";
import { THEME_CSS, appShell, SHELL_JS } from "./ui-kit.ts";

// Re-export the shared auth surface so existing importers of the daemon module
// keep working; the canonical home is now `auth.ts` (shared with http-ui.ts).
export { requireScope, SCOPE_READ, SCOPE_WRITE, SCOPE_SEND } from "./auth.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATE_DIR = defaultStateDir();
const INBOX_DIR = join(STATE_DIR, "inbox");

/**
 * Resolve the HTTP port the daemon binds (and self-registers in services.json),
 * honoring sources in priority order:
 *
 *   1. `PORT` — the hub supervisor injects this from the module's services.json
 *      `entry.port` (the canonical pattern vault/scribe follow). It is the port
 *      the supervisor ALSO probes for readiness and proxies `/channel/*` to, so
 *      the daemon MUST bind it or the supervisor reports `started_but_unbound`
 *      and the proxy routes to a dead port (channel#41).
 *   2. `PARACHUTE_CHANNEL_PORT` — back-compat manual override for a daemon run
 *      outside the supervisor (the pre-#41 env var; still honored).
 *   3. `1941` — the compiled-in canonical default.
 *
 * Pre-#41 the daemon read only `PARACHUTE_CHANNEL_PORT`, so it ignored the
 * supervisor's `PORT` and bound 1941 regardless — the supervisor's injected
 * port and the bound port could disagree, stranding the proxy. Honoring `PORT`
 * first closes that gap.
 *
 * Read at call time (not at import) so tests can drive each tier deterministically.
 *
 * Uses `||` (not `??`) for the fall-through so an EMPTY-string env value falls
 * through rather than being treated as "set": `PORT=""` with `??` would yield
 * `parseInt("")` = NaN and bind port 0 / garbage. `||` skips the empty string
 * to the next tier — matches vault's defensive `parseInt(...) || ... || DEFAULT`.
 * The final `"1941"` literal also guards a non-numeric value (`PORT="abc"` →
 * `parseInt` NaN → falsy → falls through to the default).
 */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  return (
    parseInt(env.PORT ?? "", 10) ||
    parseInt(env.PARACHUTE_CHANNEL_PORT ?? "", 10) ||
    1941
  );
}

const PORT = resolvePort();

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

/**
 * The argv the hub supervisor should spawn to (re)start this module — written
 * into our services.json row so `parachute restart channel` / reboot-survival /
 * adopt all have a command to run. Without it the supervisor knows the port but
 * not how to start the process, so a manually-run `bun src/daemon.ts` daemon
 * can't be supervised (channel#34).
 *
 * Sourced from our own `.parachute/module.json` `startCmd` (the canonical
 * declaration the hub already prefers when it can read the install dir),
 * falling back to the package.json `bin` name when the manifest is unreadable.
 * The bin (`parachute-channel` → `src/daemon.ts`) runs the daemon directly and
 * ignores extra argv, so the literal command is stable regardless of any
 * subcommand the hub's first-party fallback might carry.
 */
export function resolveStartCmd(installDir: string): string[] {
  try {
    const manifest = JSON.parse(
      readFileSync(join(installDir, ".parachute", "module.json"), "utf8"),
    ) as { startCmd?: unknown };
    if (
      Array.isArray(manifest.startCmd) &&
      manifest.startCmd.length > 0 &&
      manifest.startCmd.every((a) => typeof a === "string")
    ) {
      return manifest.startCmd as string[];
    }
  } catch {
    // fall through to the bin-name default
  }
  return ["parachute-channel"];
}

const START_CMD: string[] = resolveStartCmd(INSTALL_DIR);

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
export const CHAT_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>parachute-channel · chat</title>
<style>
${THEME_CSS}
  /* ---- Chat page layout + transcript (page-specific, after the shared kit) -- */
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; height: 100vh; }
  .app-header { flex: 0 0 auto; }
  #transcript {
    flex: 1; overflow-y: auto; padding: 16px;
    display: flex; flex-direction: column; gap: 8px;
  }
  /* Light-theme message bubbles. "you" = accent; "them" = soft surface; "sys" =
     muted/italic system line; "perm" = a warn style for permission prompts. */
  /* Bodies render Markdown (renderMarkdown -> innerHTML): newlines become <br>
     and code blocks become <pre>, so the bubble itself wraps normally rather than
     preserving raw whitespace (which would double the line breaks). */
  .msg { max-width: 78%; padding: 8px 12px; border-radius: 12px; white-space: normal; word-wrap: break-word; overflow-wrap: anywhere; }
  .msg.you { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
  .msg.them { align-self: flex-start; background: var(--bg-soft); color: var(--fg); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
  .msg.sys { align-self: center; background: transparent; color: var(--fg-muted); font-size: 0.8rem; font-style: italic; max-width: 90%; }
  .msg.perm { align-self: flex-start; background: var(--warn-soft); border: 1px solid var(--warn); border-left: 3px solid var(--warn); color: var(--warn); max-width: 90%; }
  /* Markdown bits inside a bubble: inline code + fenced blocks, links, emphasis. */
  .msg code { font-family: var(--font-mono); font-size: 0.85em; background: rgba(0,0,0,0.06); padding: 0.05rem 0.3rem; border-radius: 4px; }
  .msg.you code { background: rgba(255,255,255,0.22); }
  .msg pre { margin: 6px 0; padding: 8px 10px; background: rgba(0,0,0,0.06); border-radius: 8px; overflow-x: auto; }
  .msg pre code { background: transparent; padding: 0; font-size: 0.82em; }
  .msg.you pre { background: rgba(255,255,255,0.18); }
  .msg a { text-decoration: underline; }
  .msg.you a { color: #fff; }
  .files { margin-top: 4px; font-size: 0.8rem; opacity: .85; }
  .files .file-name { font-family: var(--font-mono); }
  /* Permission bubble: Approve/Deny row + the follow-up note. */
  .perm-actions { display: flex; gap: 8px; margin-top: 8px; }
  .perm-note { margin-top: 8px; font-size: 0.78rem; color: var(--fg-muted); font-style: italic; }
  form {
    display: flex; gap: 8px; padding: 12px 16px;
    border-top: 1px solid var(--border); background: var(--card);
  }
  #input {
    flex: 1; resize: none;
    border-radius: 8px; padding: 10px 12px; max-height: 120px;
  }
  #send { flex: 0 0 auto; }
  details.setup { border-bottom: 1px solid var(--border); background: var(--card); }
  details.setup > summary {
    cursor: pointer; padding: 8px 16px; color: var(--accent-hover); font-size: 0.85rem; user-select: none;
  }
  details.setup .body { padding: 4px 16px 14px; font-size: 0.85rem; color: var(--fg-muted); }
  details.setup .body p { margin: 8px 0 4px; }
  details.setup pre {
    margin: 4px 0; padding: 10px 12px; background: var(--bg-soft); border: 1px solid var(--border);
    border-radius: 8px; overflow-x: auto; color: var(--fg); font-size: 0.8rem; line-height: 1.45;
  }
  details.setup code { font-family: var(--font-mono); color: var(--fg); }
  details.setup .copy {
    float: right; padding: 1px 8px; font-size: 0.7rem; font-weight: 500; background: var(--bg-soft);
    color: var(--fg-muted); border: 1px solid var(--border); border-radius: 6px; cursor: pointer;
  }
</style>
</head>
<body>
  ${appShell({
    active: "chat",
    tag: "chat",
    controls: '<select id="channel" class="btn-sm" title="channel" style="width:auto;"></select>',
  })}
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
    <button id="send" type="submit" class="btn btn-primary" disabled>Send</button>
  </form>
<script>
${SHELL_JS}
(function () {
  var transcript = document.getElementById("transcript");
  var sel = document.getElementById("channel");
  var input = document.getElementById("input");
  var sendBtn = document.getElementById("send");
  var form = document.getElementById("composer");
  var es = null;
  // Vault-backed chat state: the selected channel's transport kind, the poll
  // timer, and the set of note ids already rendered (dedup the poll + reconcile
  // optimistic echoes). MOUNT, escapeHtml, fetchToken (caches on window.__token),
  // authedFetch come from SHELL_JS. Wire the shared nav for the chat view.
  var channelTransports = {}; // name -> transport kind ("vault" | "http-ui" | ...)
  var pollTimer = null;
  var seenIds = {}; // note id -> true, for the vault poll dedup
  var POLL_MS = 3500;
  wireShell("chat");

  function transportFor(ch) { return channelTransports[ch] || ""; }
  function isVault(ch) { return transportFor(ch) === "vault"; }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ----- Layer 2 auth -----------------------------------------------------
  // The daemon's send + SSE endpoints require a hub-issued channel JWT
  // (aud:channel, scopes channel:read channel:send). The shared fetchToken
  // (SHELL_JS) mints one for the logged-in portal operator at
  // <hub-origin>/admin/channel-token (cookie-gated, ~10min TTL) and caches it on
  // window.__token; it REJECTS on failure. ensureToken wraps it with the chat's
  // own notice (a "sys" transcript line) so a not-authenticated load explains
  // itself, then resolves to null — an unguarded dev daemon may still accept the
  // calls, so we don't hard-crash.
  function ensureToken() {
    return fetchToken().catch(function (err) {
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
    // Message bodies render through renderMarkdown (SHELL_JS) — a SMALL, XSS-safe
    // Markdown subset (escapes first, then a bounded set of patterns). Trusted
    // HTML out, so assign via innerHTML. Phase 4's vault-backed chat reuses it.
    el.innerHTML = renderMarkdown(text);
    if (files && files.length) {
      // ATTACHMENTS: a reply's files is a string[] of file PATHS on the daemon
      // host (the bridge documents reply files as absolute paths, e.g.
      // /abs/path.png). There is NO endpoint that serves a reply attachment
      // as a downloadable blob: the daemon's POST /api/download goes the OTHER
      // way (a Telegram file_id -> a server-local path) and requires
      // channel:write, which the chat page's token (channel:read channel:send)
      // does not hold. So we render the names clearly rather than fabricate a
      // download link. Making these downloadable needs new backend work (a
      // blob-serving route scoped to channel:read) — left for a follow-up.
      var f = document.createElement("div");
      f.className = "files";
      var label = document.createElement("span");
      label.textContent = "📎 ";
      f.appendChild(label);
      files.forEach(function (name, i) {
        if (i) f.appendChild(document.createTextNode(", "));
        var n = document.createElement("span");
        n.className = "file-name";
        // Show the basename (paths are host-local); title carries the full path.
        var base = String(name).split("/").pop() || String(name);
        n.textContent = base;
        n.title = String(name);
        f.appendChild(n);
      });
      el.appendChild(f);
    }
    transcript.appendChild(el);
    transcript.scrollTop = transcript.scrollHeight;
  }

  // Render one vault transcript message, deduped by note id. Direction mapping:
  // the human/operator is INBOUND -> "you" (right bubble); the session reply is
  // OUTBOUND -> "them" (left). This mirrors the transport's direction semantics,
  // not the chat's local point of view. Returns true if it rendered (new id).
  function addVaultMessage(m) {
    if (!m || !m.id || seenIds[m.id]) return false;
    seenIds[m.id] = true;
    var kind = m.direction === "outbound" ? "them" : "you";
    add(kind, m.text || "");
    return true;
  }

  // Poll a vault channel's transcript: re-query, append only unseen ids. This is
  // how a session's replies + messages from other clients (Telegram, other
  // browsers) show up. Reconciles optimistic echoes too — an echo we already
  // rendered locally is in seenIds (we key it on the returned note id at send
  // time), so the round-tripped note isn't double-rendered.
  function pollVault(ch) {
    if (!ch || ch !== currentChannel() || !isVault(ch)) return;
    authedFetch(MOUNT + "/api/channels/" + encodeURIComponent(ch) + "/messages").then(function (r) {
      if (!r.ok) {
        if (r.status === 401) { setStatus("re-authenticating…", ""); ensureToken(); return; }
        return r.json().catch(function(){return {};}).then(function (j) {
          setStatus("history error: " + (j.error || r.status), "err");
        });
      }
      return r.json().then(function (data) {
        // Channel may have changed while the request was in flight.
        if (ch !== currentChannel()) return;
        var msgs = (data && data.messages) || [];
        var appended = 0;
        msgs.forEach(function (m) { if (addVaultMessage(m)) appended++; });
        setStatus("● live · " + ch, "live");
      });
    }).catch(function (err) { setStatus("history error: " + err, "err"); });
  }

  // Load a vault channel: clear, fetch the transcript once (render history), then
  // start polling. Sets the composer live. authedFetch attaches the bearer.
  function connectVault(ch) {
    stopPolling();
    if (es) { es.close(); es = null; }
    seenIds = {};
    setStatus("loading history…", "");
    authedFetch(MOUNT + "/api/channels/" + encodeURIComponent(ch) + "/messages").then(function (r) {
      if (ch !== currentChannel()) return;
      if (!r.ok) {
        if (r.status === 401) {
          return ensureToken().then(function () { if (ch === currentChannel()) connectVault(ch); });
        }
        return r.json().catch(function(){return {};}).then(function (j) {
          setStatus("history error: " + (j.error || r.status), "err");
          sendBtn.disabled = false; // a transient read failure shouldn't block sending
          pollTimer = setInterval(function () { pollVault(ch); }, POLL_MS);
        });
      }
      return r.json().then(function (data) {
        if (ch !== currentChannel()) return;
        var msgs = (data && data.messages) || [];
        msgs.forEach(function (m) { addVaultMessage(m); });
        setStatus("● live · " + ch, "live");
        sendBtn.disabled = false;
        pollTimer = setInterval(function () { pollVault(ch); }, POLL_MS);
      });
    }).catch(function (err) {
      if (ch !== currentChannel()) return;
      setStatus("history error: " + err, "err");
      sendBtn.disabled = false;
      pollTimer = setInterval(function () { pollVault(ch); }, POLL_MS);
    });
  }

  // Render a permission prompt as an interactive bubble with Approve / Deny.
  //
  // SCOPE NOTE (flagged): submitting a verdict has NO daemon endpoint today, and
  // the chat page's token is channel:read + channel:send only. The existing
  // POST /api/permission is the OUTBOUND prompt (bridge -> channel,
  // transport.sendPermission) gated channel:write — NOT a verdict sink; the
  // verdict path (ctx.emitPermissionVerdict -> bridges/MCP sessions) has no HTTP
  // route the browser can call. So the buttons are wired to a clear, honest
  // "needs backend + channel:write" state rather than a call that would 401 or
  // hit the wrong endpoint. When the verdict route + scope land (Phase 4), swap
  // the handler body for the real POST. We deliberately do NOT weaken the gate.
  function addPermission(d) {
    var el = document.createElement("div");
    el.className = "msg perm";
    var head = document.createElement("div");
    head.innerHTML = renderMarkdown("🔐 **permission:** " + (d.tool_name || "") +
      "\\n" + (d.description || "") + "\\n" + (d.input_preview || ""));
    el.appendChild(head);
    var actions = document.createElement("div");
    actions.className = "perm-actions";
    var note = document.createElement("div");
    note.className = "perm-note";
    function disableWithNote(verdict) {
      approve.disabled = true; deny.disabled = true;
      note.textContent = "Recorded your choice (" + verdict + ") in the UI. Approving/denying " +
        "from chat needs a verdict endpoint + a channel:write token — follow-up. " +
        "For now respond in the session's terminal.";
    }
    var approve = document.createElement("button");
    approve.type = "button";
    approve.className = "btn btn-sm btn-primary";
    approve.textContent = "Approve";
    approve.addEventListener("click", function () { disableWithNote("approve"); });
    var deny = document.createElement("button");
    deny.type = "button";
    deny.className = "btn btn-sm btn-danger";
    deny.textContent = "Deny";
    deny.addEventListener("click", function () { disableWithNote("deny"); });
    actions.appendChild(approve);
    actions.appendChild(deny);
    el.appendChild(actions);
    el.appendChild(note);
    transcript.appendChild(el);
    transcript.scrollTop = transcript.scrollHeight;
  }

  // setStatus(text, kind) comes from SHELL_JS — it updates the shared #status
  // element the appShell header renders. Kinds: "live" | "err" | "" (default).
  function currentChannel() { return sel.value; }

  // Guard so an SSE error triggers at most one token-refresh+reconnect per
  // connect cycle (the token is short-lived; a stale one 401s the stream).
  var sseRetried = false;

  function connect() {
    if (es) { es.close(); es = null; }
    stopPolling();
    var ch = currentChannel();
    if (!ch) { setStatus("no channel", ""); sendBtn.disabled = true; return; }
    updateSetup(ch);
    // Vault channels read/write the durable #channel-message store via the daemon
    // (load transcript + poll); http-ui channels use the ephemeral SSE path below.
    if (isVault(ch)) { connectVault(ch); return; }
    setStatus("connecting…", "");
    var url = MOUNT + "/ui/events?channel=" + encodeURIComponent(ch);
    if (window.__token) url += "&token=" + encodeURIComponent(window.__token);
    es = new EventSource(url);
    es.onopen = function () { sseRetried = false; setStatus("● live · " + ch, "live"); sendBtn.disabled = false; };
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
        addPermission(d);
      } catch (_) {}
    });
    es.addEventListener("close", function () { setStatus("closed", ""); });
    es.onerror = function () {
      // A stale/short-lived token 401s the stream. Refresh the token once and
      // reconnect; otherwise let EventSource auto-reconnect (transient network).
      if (!sseRetried && window.__token) {
        sseRetried = true;
        setStatus("re-authenticating…", "");
        if (es) { es.close(); es = null; }
        ensureToken().then(function () { connect(); });
        return;
      }
      setStatus("reconnecting…", "");
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

  // Reconcile a vault send: the POST returns the created note id. Key it into
  // the SAME seenIds object the send started against (captured at call time as
  // ids, NOT the live seenIds var — a channel switch reassigns seenIds to a fresh
  // empty object, and we must not write this id into a different channel's set) so
  // the round-tripped note isn't rendered a second time on the next poll (the
  // optimistic echo already shows it).
  function reconcileVaultEcho(r, ids) {
    return r.json().catch(function(){return {};}).then(function (j) {
      if (j && j.id) ids[j.id] = true;
    });
  }

  function send() {
    var text = input.value.trim();
    var ch = currentChannel();
    if (!text || !ch) return;
    var vault = isVault(ch);
    var ids = seenIds; // bind the current channel's dedup set for reconcile
    add("you", text); // optimistic echo (vault: operator=inbound="you"; http-ui: local)
    input.value = "";
    autosize();
    postSend(ch, text).then(function (r) {
      if (r.ok) { if (vault) return reconcileVaultEcho(r, ids); return; }
      // The token is short-lived; on a 401 refresh it once and retry the send.
      if (r.status === 401) {
        return ensureToken().then(function (tok) {
          if (!tok) { add("sys", "send failed: not authenticated"); return; }
          return postSend(ch, text).then(function (r2) {
            if (r2.ok) { if (vault) return reconcileVaultEcho(r2, ids); return; }
            return r2.json().catch(function(){return {};}).then(function (j) {
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

  // No channels at all: don't dead-end. Drop a forward CTA into the transcript
  // pointing at Config (to add a channel) + Home, and disable the composer.
  function showNoChannelCta() {
    setStatus("no channels", "");
    sendBtn.disabled = true;
    var el = document.createElement("div");
    el.className = "msg sys";
    var p = document.createElement("div");
    p.textContent = "No channels yet — add one in Config →";
    el.appendChild(p);
    var links = document.createElement("div");
    links.style.marginTop = "6px";
    var add = document.createElement("a");
    add.href = MOUNT + "/admin";
    add.textContent = "Add a channel →";
    var sep = document.createTextNode("   ");
    var home = document.createElement("a");
    home.href = MOUNT + "/home";
    home.textContent = "Home";
    links.appendChild(add);
    links.appendChild(sep);
    links.appendChild(home);
    el.appendChild(links);
    transcript.appendChild(el);
  }

  function loadChannelsAndConnect() {
    return fetch(MOUNT + "/.parachute/config").then(function (r) { return r.json(); }).then(function (cfg) {
      // Show ALL channels and pick behavior by transport — vault channels read
      // the durable transcript + poll; http-ui channels use the ephemeral SSE.
      var chans = (cfg.channels || []);
      channelTransports = {};
      chans.forEach(function (c) { channelTransports[c.name] = c.transport; });
      if (!chans.length) { showNoChannelCta(); return; }
      var preselect = new URL(window.location.href).searchParams.get("channel");
      chans.forEach(function (c) {
        var opt = document.createElement("option");
        // Tag the kind in the label so it's obvious which channels are durable.
        opt.value = c.name; opt.textContent = c.name + " (" + c.transport + ")";
        if (c.name === preselect) opt.selected = true;
        sel.appendChild(opt);
      });
      connect();
    }).catch(function (err) { setStatus("config load failed: " + err, "err"); });
  }

  // Fetch a hub token first (so SSE + send go out authenticated), then list the
  // channels and connect. A token failure still proceeds — an unguarded dev
  // daemon may accept the calls, and the failure already surfaced a notice.
  ensureToken().then(loadChannelsAndConnect);
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
 * Decide whether a terminal WebSocket upgrade is authorized + which tmux session
 * it targets. Pure over its inputs (no `server.upgrade`, no pty) so the auth +
 * routing layer is unit-testable without a live hub or a real socket — the same
 * shape the HTTP gate tests rely on.
 *
 * Auth: OPERATOR-GATED on `channel:admin` (`SCOPE_TERMINAL`). The token rides in
 * as a `?token=` query param (browsers can't set Authorization on
 * `new WebSocket()`), so `allowQueryParam: true`. The no-token path
 * short-circuits to 401 before any JWKS fetch (testable offline).
 *
 * The path segment is an AGENT name — the tmux session is `<name>-agent`. An agent
 * has its OWN name (chosen at spawn), which is NOT necessarily a configured
 * channel (the 1:1 channel↔session assumption from the launch-session.sh era no
 * longer holds — an operator can name an agent anything). So we DON'T require the
 * name to be a known channel; we slug-guard it (it lands UNESCAPED in a tmux `-t`
 * target) and let the attach handle a non-existent session — `tmux attach` to a
 * missing session fails cleanly and the relay closes 1000 ("session ended"), no
 * reconnect loop. Operator-only behind channel:admin, so there's no enumeration
 * concern. (`channels` is no longer consulted; kept in the signature for the
 * stable call shape.)
 *
 * Returns either `{ ok: true, ... }` with the tmux session name (`<name>-agent`)
 * + the client's requested geometry, or `{ ok: false, response }` carrying the
 * deny Response the caller returns as-is.
 */
export async function authorizeTerminalUpgrade(
  req: Request,
  url: URL,
  _channels: Map<string, Channel>,
  agentName: string,
): Promise<
  | { ok: true; channel: string; session: string; cols: number; rows: number }
  | { ok: false; response: Response }
> {
  // Slug-guard: the name lands unescaped in a tmux `-t <session>` target and the
  // session string `<name>-agent`. Reject anything that isn't a strict slug.
  if (!AGENT_NAME_SLUG.test(agentName)) {
    return {
      ok: false,
      response: authJson(
        { error: `invalid agent name "${agentName}" (alphanumeric, dash, underscore only)` },
        400,
      ),
    };
  }
  // Operator-grade gate. allowQueryParam: true — the only way a browser
  // WebSocket can present the token (no Authorization header on `new WebSocket`).
  const denied = await requireScope(req, url, SCOPE_TERMINAL, true);
  if (denied) return { ok: false, response: denied };

  // tmux session name convention: `<name>-agent`. Attach a viewer pty to THIS
  // session; the session itself is created by the spawn path.
  const session = `${agentName}-agent`;
  const cols = clampQueryDim(url.searchParams.get("cols"), 80);
  const rows = clampQueryDim(url.searchParams.get("rows"), 24);
  return { ok: true, channel: agentName, session, cols, rows };
}

/** Is this request a WebSocket upgrade? (case-insensitive `Upgrade: websocket`). */
export function isWebSocketUpgrade(req: Request): boolean {
  return (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

/** Parse + clamp a `?cols=`/`?rows=` query dim to [1, 9999], with a fallback. */
function clampQueryDim(raw: string | null, fallback: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n > 9999 ? 9999 : n;
}

/**
 * Build the daemon's HTTP fetch handler over a channel registry + client
 * registry. Extracted as a factory so tests can exercise routing + the auth
 * gate on an ephemeral `Bun.serve` without booting the real daemon (and without
 * a live hub — the no-token 401 path short-circuits before JWKS).
 *
 * `server` is the `Bun.serve` instance (passed as `fetch`'s 2nd arg at runtime),
 * needed for `server.upgrade()` on the terminal WS route. It's optional so the
 * existing tests (which call the handler with one arg) keep working — a terminal
 * upgrade request with no server falls through to the normal 426-style refusal.
 */
export function createFetchHandler(
  channels: Map<string, Channel>,
  registry: ClientRegistry,
  opts?: { agentOps?: AgentOps },
): (req: Request, server?: { upgrade: (req: Request, opts: { data: TerminalWsData }) => boolean }) => Promise<Response> {
  // Spawn/list/kill operations behind the web agents surface. Lazily defaulted to
  // the real ops (resolve-deps + real tmux); tests inject a stub so the routes are
  // exercised without a hub, a sandbox, or a tmux server. Built once per handler.
  const agentOps: AgentOps = opts?.agentOps ?? createRealAgentOps();
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

  return async function fetch(req, server) {
    const url = new URL(req.url);

    // -------------------------------------------------------------------
    // Terminal WebSocket upgrade — `/terminal/<agent>` (design §5).
    //
    // The in-page xterm.js terminal attaches to the channel's tmux session
    // (`<channel>-agent`) via Bun's native pty. Externally this is
    // `<hub>/channel/terminal/<channel>`; the hub strips `/channel` (stripPrefix)
    // and forwards the `Upgrade: websocket` over its Bun-native WS bridge (which
    // honors channel's `websocket: true` declaration), so the daemon sees the
    // bare `/terminal/<channel>` upgrade here. OPERATOR-GATED on channel:admin
    // (the most dangerous capability), token via `?token=`. Must run BEFORE the
    // generic routing so the upgrade isn't 404'd.
    const termMatch = url.pathname.match(/^\/terminal\/([^/]+)$/);
    if (termMatch && isWebSocketUpgrade(req)) {
      const channelName = decodeURIComponent(termMatch[1]!);
      const decision = await authorizeTerminalUpgrade(req, url, channels, channelName);
      if (!decision.ok) return decision.response;
      if (!server?.upgrade) {
        // No server handle (e.g. a unit test calling the handler directly, or a
        // build where Bun.serve didn't pass it) — the upgrade can't happen here.
        return authJson(
          { error: "websocket upgrade unavailable on this server" },
          503,
        );
      }
      const data: TerminalWsData = {
        session: decision.session,
        channel: decision.channel,
        cols: decision.cols,
        rows: decision.rows,
      };
      const upgraded = server.upgrade(req, { data });
      if (upgraded) {
        // Bun's contract: return undefined from fetch after a successful upgrade
        // — the socket now belongs to the websocket handlers.
        return undefined as unknown as Response;
      }
      return authJson({ error: "websocket upgrade failed" }, 400);
    }

    // Terminal renderer assets (xterm.js + addon-fit + css) served SAME-ORIGIN
    // (design §5; replaces the CDN load that broke behind strict networks/CSP).
    // Public like the page itself — these are vendored static JS/CSS, no secrets.
    // Must run BEFORE the `/terminal/<channel>` page match (this is a 2-segment
    // path the single-segment termMatch wouldn't catch, but keep it explicit).
    const assetMatch = url.pathname.match(/^\/terminal\/assets\/([^/]+)$/);
    if (req.method === "GET" && assetMatch) {
      const served = serveTerminalAsset(decodeURIComponent(assetMatch[1]!));
      return served ?? json({ error: "not found" }, 404);
    }

    // Terminal view (the xterm.js page) — `/terminal` or `/terminal/<channel>`
    // as a plain GET (no upgrade) serves the page; the page then opens the WS to
    // `/terminal/<channel>`. Loads OPEN (like /ui and /admin) so it can bootstrap
    // its hub-minted channel:admin token fetch; the WS upgrade above is what's
    // gated. Served by the daemon (spans every channel via a picker).
    if (req.method === "GET" && (url.pathname === "/terminal" || termMatch)) {
      return new Response(TERMINAL_UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Agent management page (the web spawn/list/kill surface, design §4/§5) —
    // `/agents`. Loads OPEN (like /ui, /admin, /terminal) so it can bootstrap its
    // hub-minted channel:admin token; the `/api/agents` + `/api/credentials/*`
    // calls it makes are what `requireScope` gates. Served by the daemon (spans
    // every channel via the spawn form + the running-agents list).
    if (req.method === "GET" && url.pathname === "/agents") {
      return new Response(AGENTS_UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Home / overview landing (Phase 2) — `/home`, the DEFAULT page the hub
    // portal lands on (`uiUrl: "/channel/home"`). Loads OPEN (like /ui, /admin,
    // /terminal, /agents): the channels card reads the public config, the agents
    // card mints a hub-minted channel:admin token client-side and tolerates a
    // failed mint. Served by the daemon (spans every channel + agent).
    if (req.method === "GET" && url.pathname === "/home") {
      return new Response(HOME_UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

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
    // Claude OAuth credential store (design §6) — the per-channel secret a
    // launched agent session runs on (`CLAUDE_CODE_OAUTH_TOKEN`). Same
    // `channel:admin` gate + 0600 file-store + redaction-on-read posture as the
    // channel config API above. The token comes from `claude setup-token`.
    //
    //   GET    /api/credentials/claude          → { defaultSet, channels:[names] } (NO secret)
    //   POST   /api/credentials/claude          { token } → set the default/operator token
    //   POST   /api/credentials/claude/:channel { token } → set a per-channel override
    //   DELETE /api/credentials/claude/:channel → remove an override (falls back to default)
    //
    // Externally hub strips `/channel`, so these are `<hub>/channel/api/credentials/claude`.
    // ---------------------------------------------------------------------
    if (url.pathname === "/api/credentials/claude" && (req.method === "GET" || req.method === "POST")) {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;

      if (req.method === "GET") {
        // Inspect WITHOUT leaking the secret: whether a default is set + which
        // channels carry an override (names only).
        return json(describeClaudeCredentials(defaultStateDir()));
      }

      // POST — set the default / operator-level token.
      let credBody: { token?: unknown };
      try {
        credBody = (await req.json()) as typeof credBody;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (typeof credBody.token !== "string" || credBody.token.length === 0) {
        return json({ error: "body.token (non-empty string) is required" }, 400);
      }
      try {
        setDefaultClaudeCredential(credBody.token, defaultStateDir());
      } catch (err) {
        return json({ error: `failed to write credentials.json: ${(err as Error).message}` }, 500);
      }
      // Echo back only the fact of the write — never the token.
      return json({ ok: true, scope: "default" });
    }

    const credMatch = url.pathname.match(/^\/api\/credentials\/claude\/([^/]+)$/);
    if (credMatch && (req.method === "POST" || req.method === "DELETE")) {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;
      const channel = decodeURIComponent(credMatch[1]!);

      if (req.method === "DELETE") {
        let removed: boolean;
        try {
          removed = removeChannelClaudeCredential(channel, defaultStateDir());
        } catch (err) {
          return json({ error: `failed to update credentials.json: ${(err as Error).message}` }, 500);
        }
        return json({ ok: true, channel, removed });
      }

      // POST — set a per-channel override.
      let credBody: { token?: unknown };
      try {
        credBody = (await req.json()) as typeof credBody;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (typeof credBody.token !== "string" || credBody.token.length === 0) {
        return json({ error: "body.token (non-empty string) is required" }, 400);
      }
      try {
        setChannelClaudeCredential(channel, credBody.token, defaultStateDir());
      } catch (err) {
        return json({ error: `failed to write credentials.json: ${(err as Error).message}` }, 500);
      }
      return json({ ok: true, scope: "channel", channel });
    }

    // ---------------------------------------------------------------------
    // Agent management API (the web spawn/list/kill surface, design §4/§5) —
    // the SAME least-privilege launch path as the operator CLI
    // (`scripts/spawn-agent.ts`), driven from the browser. Operator-gated on
    // `channel:admin` (a launched session is the most powerful thing this module
    // does, so the whole surface uses the same gate as the terminal).
    //
    //   GET    /api/agents          → list running agent tmux sessions (no secrets)
    //   POST   /api/agents          { name, channels, vault?, egress?, mounts? } → spawn
    //   DELETE /api/agents/:name    → kill the session
    //
    // Externally hub strips `/channel`, so these are `<hub>/channel/api/agents`.
    // The spawn response surfaces scopes/audiences but NEVER the minted token
    // values (redactSpawnResult); the launch resolves its deps lazily so a
    // credential set via the creds API takes effect without a daemon restart.
    // ---------------------------------------------------------------------
    if (url.pathname === "/api/agents" && (req.method === "GET" || req.method === "POST")) {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;

      if (req.method === "GET") {
        try {
          return json({ agents: await agentOps.list() });
        } catch (err) {
          return json({ error: `failed to list agents: ${(err as Error).message}` }, 500);
        }
      }

      // POST — spawn a sandboxed agent from a spec.
      let spawnBody: unknown;
      try {
        spawnBody = await req.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      let spec;
      try {
        spec = buildSpecFromBody(spawnBody);
      } catch (err) {
        if (err instanceof SpawnRequestError) return json({ error: err.message }, 400);
        throw err;
      }
      try {
        const result = await agentOps.spawn(spec);
        return json(redactSpawnResult(result));
      } catch (err) {
        // A missing operator token (no manager bearer) → 503: the daemon can't
        // mint child tokens until the hub is provisioned.
        if (err instanceof SpawnDepsError) return json({ error: err.message }, 503);
        // A missing Claude credential → 400 with the fix (set it via the creds API
        // / the page's credential form).
        if (err instanceof CredentialNotConfiguredError) return json({ error: err.message }, 400);
        // An over-broad / refused mint (the hub's canGrant) → surface the hub's status.
        if (err instanceof MintError) {
          return json({ error: `token mint failed: ${err.message}` }, err.status >= 400 && err.status < 600 ? err.status : 502);
        }
        // A bad slug (spawnAgent's guard) or any other launch fault.
        return json({ error: (err as Error).message }, 400);
      }
    }

    const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (agentMatch && req.method === "DELETE") {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;
      const name = decodeURIComponent(agentMatch[1]!);
      try {
        const { killed } = await agentOps.kill(name);
        return json({ ok: true, name, killed });
      } catch (err) {
        if (err instanceof SpawnRequestError) return json({ error: err.message }, 400);
        return json({ error: `failed to kill agent: ${(err as Error).message}` }, 500);
      }
    }

    // Installed vault instances (for the agents page's vault picker) — derived
    // from the vault module's registered `/vault/<name>` paths in services.json.
    // No secrets; channel:admin-gated to match the rest of the agents surface.
    if (url.pathname === "/api/vaults" && req.method === "GET") {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;
      return json({ vaults: listVaultNames() });
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

    // Transcript read — GET /api/channels/<ch>/messages (chat-facing; gated on
    // `channel:read`, same as /ui/events). The built-in chat polls this to render
    // a channel's durable history and pick up replies + messages from other
    // clients (Telegram, other browsers). Behavior by transport:
    //   - vault → loadTranscript() against the channel's vault (the daemon does
    //     the vault I/O with the channel's stored vault token — the chat's
    //     channel:read token never touches the vault).
    //   - http-ui → that transport's traffic is ephemeral (SSE-only, no buffer),
    //     so there's no durable transcript to replay → { messages: [] }.
    //   - other (telegram) → no transcript surface here → { messages: [] }.
    // 404 for an unknown channel. Externally `<hub>/channel/api/channels/<ch>/messages`.
    {
      const msgMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
      if (req.method === "GET" && msgMatch) {
        const denied = await requireScope(req, url, SCOPE_READ);
        if (denied) return denied;
        const channelName = decodeURIComponent(msgMatch[1]!);
        const ch = channels.get(channelName);
        if (!ch) {
          return json(
            {
              error: `unknown channel "${channelName}" — known channels: ${[...channels.keys()].join(", ") || "(none)"}`,
            },
            404,
          );
        }
        if (ch.transport instanceof VaultTransport) {
          try {
            const messages = await ch.transport.loadTranscript();
            return json({ messages });
          } catch (err) {
            // The vault read failed (unreachable / bad token / 5xx). Surface a
            // 502 so the chat shows "couldn't load history" rather than a silent
            // empty transcript that looks like "no messages yet".
            return json({ error: String(err) }, 502);
          }
        }
        // http-ui + telegram: no durable transcript to replay here.
        return json({ messages: [] });
      }
    }

    // Send for a VAULT channel — POST /api/channels/<ch>/send (chat-facing; gated
    // on `channel:send`, same scope http-ui's send uses). The daemon owns this for
    // vault transports because the http-ui transport's ingestHttp only matches its
    // OWN channel name; a vault channel needs the daemon to dispatch. For a vault
    // channel the daemon writes a `#channel-message/inbound` note via the channel's
    // stored vault token — which WAKES the session through the existing vault
    // trigger (we do NOT also emit; that would double-wake). http-ui channels fall
    // through to their transport's ingestHttp (unchanged), so this guard handles
    // ONLY vault channels and passes everything else on.
    {
      const sendMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/send$/);
      if (req.method === "POST" && sendMatch) {
        const channelName = decodeURIComponent(sendMatch[1]!);
        const ch = channels.get(channelName);
        // Only intercept VAULT channels; let http-ui keep its ingestHttp send path
        // (and an unknown channel falls through to the final 404, matching prior
        // behavior — http-ui's ingestHttp also only answered for a live channel).
        if (ch && ch.transport instanceof VaultTransport) {
          const denied = await requireScope(req, url, SCOPE_SEND);
          if (denied) return denied;
          let text: string;
          try {
            const body = (await req.json()) as { text?: unknown };
            if (typeof body.text !== "string" || body.text.length === 0) {
              return json({ error: "body must be { text: <non-empty string> }" }, 400);
            }
            text = body.text;
          } catch {
            return json({ error: "invalid JSON body" }, 400);
          }
          try {
            // Writing the inbound note IS the wake (via the vault trigger) — the
            // transport deliberately does not emit. Return { ok, id } so the chat
            // can reconcile its optimistic echo against the real note id on the
            // next poll.
            const { id } = await ch.transport.writeInbound(text, "operator");
            return json({ ok: true, id });
          } catch (err) {
            return errResponse(err);
          }
        }
      }
    }

    // Built-in chat UI — a global channel-picker page across all channels.
    // Served by the daemon (not a transport) because it spans every channel; the
    // per-channel http-ui send + SSE routes live in the http-ui transport, and
    // the vault read/send routes are the daemon-level handlers above.
    if (req.method === "GET" && url.pathname === "/ui") {
      return new Response(CHAT_UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Module-owned config/admin UI (modular-UI P4) — declared as `configUiUrl`
    // in module.json so the hub frames/links it. The PAGE itself loads OPEN (no
    // JWT) — like /ui — so it can bootstrap its hub-minted `channel:admin`
    // token fetch; the page's `/api/channels` calls are what `requireScope`
    // gates. Server-side mount is "" (the daemon serves the bare path); the page
    // detects the public `/channel` prefix at runtime from window.location, so
    // it works at `/admin` direct AND `/channel/admin` proxied.
    if (req.method === "GET" && url.pathname === "/admin") {
      return new Response(renderAdminPage(""), {
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
        `  Add ${join(STATE_DIR, "channels.json")} (or use the admin UI at /channel/admin)\n` +
        `  to define a channel. Telegram channels carry a per-channel bot token in config.`,
    );
    process.exit(1);
  }

  const registry = new ClientRegistry();

  // The terminal WS handler set (pty↔socket relay + backpressure flow control,
  // src/terminal.ts). One handler object serves every terminal connection;
  // per-connection state lives on `ws.data`. The fetch handler routes accepted
  // upgrades into these via `server.upgrade(req, { data })`.
  const terminalWs = createTerminalWsHandlers();

  const fetchHandler = createFetchHandler(channels, registry);
  const server = Bun.serve<TerminalWsData, never>({
    port: PORT,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    // `fetch` receives `server` as its 2nd arg at runtime — needed for
    // `server.upgrade()` on the terminal WS route.
    fetch: (req, srv) => fetchHandler(req, srv),
    websocket: terminalWs,
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
      // The command the hub supervisor spawns to start/restart/adopt us. Without
      // this the supervisor knows our port but not how to launch the process, so
      // `parachute restart channel` 404s and we don't survive reboot (channel#34).
      startCmd: START_CMD,
      stripPrefix: true,
      uiUrl: "/channel/home", // portal "Open UI" link → the Home overview landing (also in module.json; written here in case hub reads it from services.json)
      configUiUrl: "/channel/admin", // module-owned config surface (modular-UI P4); hub frames/links it. Also in module.json.
      // WebSocket support — tells the hub's Bun-native upgrade bridge to forward
      // `Upgrade: websocket` requests on `/channel/*` to this daemon (the
      // in-page terminal, design §5.1). DENY-BY-DEFAULT in the hub: without this
      // the upgrade is refused (426) before it ever reaches us. Declared on
      // module.json too (the install-time contract); the hub honors either
      // source. No hub change needed — the hub already reads this field.
      websocket: true,
      // The terminal mount, declared as a `uis` sub-unit with audience "surface"
      // so the hub's audience gate PASSES IT THROUGH (the channel daemon owns
      // admission end-to-end — operator-grade channel:admin, enforced here). A
      // `surface` audience is the same pass-through the no-uis-match default
      // gives, but declaring it explicitly future-proofs against a later `uis`
      // declaration accidentally gating the terminal at hub-users. Design §5.3.
      uis: {
        // The web spawn/list/kill surface — the DEFAULT way to operate (spawn an
        // agent, scope it, watch it). audience "surface" so the hub passes it
        // through; channel owns admission end-to-end (operator-grade channel:admin,
        // enforced on every /api/agents call). Design §4/§5.
        agents: {
          displayName: "Agents",
          tagline: "Spawn, scope, and watch sandboxed Claude Code sessions.",
          path: "/channel/agents",
          audience: "surface",
        },
        terminal: {
          displayName: "Terminal",
          tagline: "Attach to a session's live tmux pane in the browser.",
          path: "/channel/terminal",
          audience: "surface",
        },
      },
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
