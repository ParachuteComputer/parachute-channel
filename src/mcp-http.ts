/**
 * Stateful HTTP MCP endpoint for parachute-channel.
 *
 * A second, additive way for a Claude Code session to connect to a channel:
 * instead of spawning the stdio `bridge.ts` and consuming the daemon's SSE
 * `/events`, the session adds the channel as a *pure HTTP MCP server* (URL +
 * OAuth) — exactly like the vault. No local file, works on any machine.
 *
 * Why STATEFUL (not stateless like vault's mcp-http.ts): the channel's headline
 * feature is the IDLE WAKE — Claude Code's `notifications/claude/channel` must
 * fire on an idle session when an inbound message arrives. That requires the
 * server to PUSH a notification to a *persistent* connection. Stateful
 * Streamable HTTP (a `sessionIdGenerator` + `enableJsonResponse:false`) gives
 * each session an SSE GET stream the server can push onto. The probe at
 * /tmp/http-mcp-probe/probe-server.ts proved CC opens that GET stream and acts
 * on server-pushed `notifications/claude/channel` while idle. This file is that
 * probe's structure, productionized: per-channel session registry, the real
 * tool surface ported from bridge.ts, and read-vs-write scope enforcement.
 *
 * Lifecycle:
 *   - POST /mcp/<channel> with no mcp-session-id → a NEW session: build a
 *     Server + stateful transport, connect, register under <channel> on
 *     onsessioninitialized.
 *   - POST/GET /mcp/<channel> with a known mcp-session-id → route to that
 *     session's transport (GET opens the SSE push stream).
 *   - DELETE /mcp/<channel> (or transport.onclose) → tear the session down and
 *     drop it from the channel's set.
 *
 * Auth: the daemon validates `channel:read` BEFORE calling handleMcp (a session
 * needs read to connect + receive the wake). The validated scopes are threaded
 * in and stored ON the session, so the reply/react/edit/download tool handlers
 * can additionally require `channel:write` — a read-only token connects and is
 * woken but cannot send.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  ReplyArgs,
  ReactArgs,
  EditArgs,
  DownloadArgs,
} from "./transport.ts";
import { SCOPE_WRITE } from "./auth.ts";

// ---------------------------------------------------------------------------
// Per-channel session registry
// ---------------------------------------------------------------------------

/** A live HTTP MCP session = a Server + its stateful transport + caller scopes. */
interface McpSession {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  /** The scopes the connecting token carried — write-tools check these. */
  scopes: string[];
}

/**
 * channel name → its set of live MCP sessions. A push on channel A reaches only
 * the sessions registered under A. Distinct from the SSE ClientRegistry (which
 * serves stdio bridges over `/events`); the two run side by side.
 */
const sessionsByChannel = new Map<string, Set<McpSession>>();

/** mcp-session-id → session, so a follow-up POST/GET/DELETE finds its transport. */
const sessionsById = new Map<string, McpSession>();

function registerSession(channel: string, id: string, session: McpSession): void {
  let set = sessionsByChannel.get(channel);
  if (!set) {
    set = new Set();
    sessionsByChannel.set(channel, set);
  }
  set.add(session);
  sessionsById.set(id, session);
}

function unregisterSession(channel: string, id: string): void {
  const session = sessionsById.get(id);
  sessionsById.delete(id);
  const set = sessionsByChannel.get(channel);
  if (set && session) {
    set.delete(session);
    if (set.size === 0) sessionsByChannel.delete(channel);
  }
}

/** Count of live MCP sessions on a channel (for /health). */
export function mcpSessionCount(channel: string): number {
  return sessionsByChannel.get(channel)?.size ?? 0;
}

/** Test/teardown helper — drop every registered session without touching transports. */
export function _resetSessionsForTest(): void {
  sessionsByChannel.clear();
  sessionsById.clear();
}

/**
 * Test-only: register a fake session under a channel without booting a real
 * transport. The `server` only needs a `.notification` method for the push
 * tests; pass scopes to model a connection's grant.
 */
export function _registerSessionForTest(
  channel: string,
  id: string,
  server: Server,
  scopes: string[],
): void {
  registerSession(channel, id, { server, transport: undefined as never, scopes });
}

/** Test-only: remove a registered session — exercises the empty-set cleanup path. */
export function _unregisterSessionForTest(channel: string, id: string): void {
  unregisterSession(channel, id);
}

// ---------------------------------------------------------------------------
// The wake — push to a channel's MCP sessions
// ---------------------------------------------------------------------------

/**
 * Push an inbound message to every MCP session on `channel` as a
 * `notifications/claude/channel` — the wake that pulls an idle session in to
 * answer. The daemon calls this alongside the existing SSE `routeToChannel`, so
 * both stdio bridges and HTTP MCP sessions receive the same inbound traffic.
 */
export function pushToChannel(
  channel: string,
  content: string,
  meta: Record<string, string>,
): number {
  const set = sessionsByChannel.get(channel);
  if (!set) return 0;
  let delivered = 0;
  for (const session of set) {
    try {
      void session.server.notification({
        method: "notifications/claude/channel",
        params: { content, meta: { source: "parachute-channel", ...meta } },
      });
      delivered++;
    } catch {
      // A dead session throws SYNCHRONOUSLY on a closed transport (SDK `send`), so
      // this catch runs and the count stays honest; the transport's onclose handler
      // removes the session from the set.
    }
  }
  return delivered;
}

/**
 * Push a permission verdict to a channel's MCP sessions (mirrors the SSE
 * `permission_verdict` route → bridge's `notifications/claude/channel/permission`).
 */
export function pushPermissionVerdict(
  channel: string,
  verdict: { request_id: string; behavior: string },
): number {
  const set = sessionsByChannel.get(channel);
  if (!set) return 0;
  let delivered = 0;
  for (const session of set) {
    try {
      void session.server.notification({
        method: "notifications/claude/channel/permission",
        params: { request_id: verdict.request_id, behavior: verdict.behavior },
      });
      delivered++;
    } catch {}
  }
  return delivered;
}

// ---------------------------------------------------------------------------
// Tool surface — ported from bridge.ts, dispatched to the channel's transport
// ---------------------------------------------------------------------------

const INSTRUCTIONS = [
  "You are connected to a live chat channel over HTTP MCP. A human is messaging you through it.",
  "",
  "CRITICAL — HOW THE HUMAN SEES YOU: they read ONLY what you send via the `reply` tool. Your normal assistant/transcript text is INVISIBLE to them. So for EVERY message that arrives on this channel you MUST call the `reply` tool to answer — even a one-word reply. Never answer only in your transcript: if you don't call `reply`, the human sees nothing at all.",
  "",
  'Inbound messages arrive as <channel source="parachute-channel" ...> with metadata attributes describing the sender. Treat each as a chat message from the human and respond by calling the reply tool — the daemon routes it back out the same channel. Pass back any addressing fields the inbound tag carried (e.g. chat_id) if present; omit them otherwise. Use reply_to (message_id) to thread a specific message; omit it for normal responses.',
  "",
  "If the tag has an image_path attribute, Read that file — it is an attachment the sender sent.",
  "If the tag has attachment_file_id, call download_attachment with that file_id to fetch the file, then Read the returned path.",
  "",
  "Use react to add emoji reactions. Use edit_message for interim progress updates (edits do not push notifications — send a new reply when a long task completes so the user's device pings).",
  "",
  'reply accepts file paths (files: ["/abs/path.png"]) for attachments.',
].join("\n");

/** The tool list — identical schema to bridge.ts (transport-neutral: no chat_id required on reply). */
const TOOL_DEFS = [
  {
    name: "reply",
    description:
      "Send a message back through the channel to the sender. Supports text, file attachments, and quote-reply threading. The daemon routes it out whichever transport the channel uses.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Message text (optional if files provided)" },
        reply_to: { type: "string", description: "Message ID to quote-reply (optional)" },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Absolute file paths to attach (optional)",
        },
        chat_id: {
          type: "string",
          description:
            "Addressing field some transports need (e.g. a Telegram chat ID). Include it ONLY if the inbound message tag carried one; omit it otherwise (e.g. for a web/UI channel).",
        },
      },
      required: [] as string[],
    },
  },
  {
    name: "react",
    description:
      "Add an emoji reaction to a message, on transports that support reactions (e.g. Telegram's fixed emoji whitelist 👍 👎 ❤ 🔥 👀). Not all channels support this.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: { type: "string", description: "Message ID to react to" },
        emoji: { type: "string", description: "Emoji reaction" },
        chat_id: {
          type: "string",
          description: "Addressing field for transports that need it (e.g. Telegram chat ID); omit otherwise.",
        },
      },
      required: ["message_id", "emoji"],
    },
  },
  {
    name: "edit_message",
    description:
      "Edit a message you previously sent. Useful for progress updates. On most transports edits don't push a notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: { type: "string", description: "Message ID to edit" },
        text: { type: "string", description: "New text" },
        chat_id: {
          type: "string",
          description: "Addressing field for transports that need it (e.g. Telegram chat ID); omit otherwise.",
        },
      },
      required: ["message_id", "text"],
    },
  },
  {
    name: "download_attachment",
    description: "Download a Telegram file attachment by file_id. Returns the local path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_id: { type: "string", description: "Telegram file_id from the attachment_file_id attribute" },
      },
      required: ["file_id"],
    },
  },
];

// Tools that send/mutate on the channel require channel:write. download_attachment
// is deliberately NOT here: fetching an attachment that was sent *to* this session is
// read-access — a channel:read session can receive and read its own messages,
// attachments included. (The legacy stdio-bridge /api/download gates it as write; the
// MCP path is the principled read. If they ever need to match, relax the bridge, not this.)
const WRITE_TOOLS = new Set(["reply", "react", "edit_message"]);

/** Fold a top-level chat_id into meta, mirroring the daemon's mergeMeta. */
function mergeMeta(args: Record<string, unknown>): Record<string, string> {
  const meta: Record<string, string> = {};
  if (typeof args.chat_id === "string") meta.chat_id = args.chat_id;
  return meta;
}

/**
 * Build the per-session MCP Server. Tool handlers dispatch to `transport` — the
 * SAME transport methods the daemon's `/api/*` handlers call — and check write
 * scope against `session.scopes` (mutated by the caller after construction so
 * the closure reads the live value). `channel` is threaded so outbound args
 * carry the right channel context.
 */
function buildServer(channel: string, transport: Transport, session: McpSession): Server {
  const server = new Server(
    { name: "parachute-channel", version: "0.1.0" },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

  // Dispatch reads `session.scopes` live (the daemon refreshes it per request),
  // so a re-auth with a narrower token takes effect on the next tool call.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await dispatchTool(
      channel,
      transport,
      session.scopes,
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, unknown>,
    );
    // Our ToolResult is the content/isError subset of the SDK's CallToolResult
    // (which also has a task-variant we never emit); return it as that shape.
    return result as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
  });

  return server;
}

/** A tool-call result in the MCP content shape. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Dispatch one tool call to the channel's transport, enforcing write scope on
 * the mutating tools (reply/react/edit) from the connection's `scopes`. Pure
 * over its inputs — the daemon's per-session handler and the unit tests both
 * call it, so tool behavior is asserted without standing up an MCP transport.
 */
export async function dispatchTool(
  channel: string,
  transport: Transport,
  scopes: string[],
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Read-only tokens connect + receive the wake, but cannot send. Enforce
  // channel:write on the mutating tools using the connection's own scopes.
  if (WRITE_TOOLS.has(name) && !scopes.includes(SCOPE_WRITE)) {
    return {
      content: [
        {
          type: "text",
          text: `tool "${name}" requires the ${SCOPE_WRITE} scope, which this connection's token lacks`,
        },
      ],
      isError: true,
    };
  }

  try {
    switch (name) {
      case "reply": {
        const replyArgs: ReplyArgs = {
          channel,
          text: typeof args.text === "string" ? args.text : undefined,
          files: Array.isArray(args.files) ? (args.files as string[]) : undefined,
          reply_to: typeof args.reply_to === "string" ? args.reply_to : undefined,
          meta: mergeMeta(args),
        };
        const result = await transport.reply(replyArgs);
        const ids = result.sent;
        const parts = ids.length === 1 ? `(id: ${ids[0]})` : `(ids: ${ids.join(", ")})`;
        return {
          content: [{ type: "text", text: `sent ${ids.length} part${ids.length === 1 ? "" : "s"} ${parts}` }],
        };
      }

      case "react": {
        if (!transport.react) return methodMissing(channel, transport, "react");
        const reactArgs: ReactArgs = {
          channel,
          message_id: String(args.message_id ?? ""),
          emoji: String(args.emoji ?? ""),
          meta: mergeMeta(args),
        };
        await transport.react(reactArgs);
        return { content: [{ type: "text", text: "reacted" }] };
      }

      case "edit_message": {
        if (!transport.edit) return methodMissing(channel, transport, "edit");
        const editArgs: EditArgs = {
          channel,
          message_id: String(args.message_id ?? ""),
          text: String(args.text ?? ""),
          meta: mergeMeta(args),
        };
        await transport.edit(editArgs);
        return { content: [{ type: "text", text: "edited" }] };
      }

      case "download_attachment": {
        if (!transport.download) return methodMissing(channel, transport, "download");
        const dlArgs: DownloadArgs = { channel, file_id: String(args.file_id ?? "") };
        const result = await transport.download(dlArgs);
        return { content: [{ type: "text", text: result.path }] };
      }

      default:
        return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `${name} failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

/** Thin alias the reply-dispatch tests read against. */
export function callReplyTool(
  channel: string,
  transport: Transport,
  scopes: string[],
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return dispatchTool(channel, transport, scopes, "reply", args);
}

function methodMissing(channel: string, transport: Transport, method: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: `transport "${transport.kind}" for channel "${channel}" does not support ${method}`,
      },
    ],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// HTTP entry — the daemon routes POST/GET/DELETE /mcp/<channel> here
// ---------------------------------------------------------------------------

/**
 * Handle a stateful Streamable HTTP MCP request for `channel`, dispatching tool
 * calls to `transport`. The daemon has ALREADY validated `channel:read` and
 * passes the caller's scopes in (threaded onto the session for write-tool
 * checks). Returns the transport's Response (JSON or an SSE stream).
 *
 * Session resolution mirrors the probe:
 *   - existing mcp-session-id → reuse its transport.
 *   - POST with no session id → a NEW session (initialize handshake).
 *   - anything else with no/unknown session id → 400 (no session to attach to).
 */
export async function handleMcp(
  req: Request,
  channel: string,
  transport: Transport,
  scopes: string[],
): Promise<Response> {
  const sid = req.headers.get("mcp-session-id");

  if (sid && sessionsById.has(sid)) {
    const existing = sessionsById.get(sid)!;
    // Refresh the connection's scopes from the presented token each request, so
    // a re-auth with a narrower/wider token takes effect (the daemon re-validates
    // channel:read on every call before reaching here).
    existing.scopes = scopes;
    return existing.transport.handleRequest(req);
  }

  if (req.method === "DELETE") {
    // No session to delete — treat as a no-op success.
    return new Response(null, { status: 204 });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: null }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  // New session — build the transport + server, register on init.
  const session: McpSession = {
    // Placeholders replaced immediately below; the object identity is what the
    // registry + tool closures capture.
    server: undefined as unknown as Server,
    transport: undefined as unknown as WebStandardStreamableHTTPServerTransport,
    scopes,
  };

  const httpTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: false,
    onsessioninitialized: (id: string) => {
      registerSession(channel, id, session);
    },
  });

  const server = buildServer(channel, transport, session);
  session.server = server;
  session.transport = httpTransport;

  // Clean up on transport close (client disconnect / DELETE / stream end).
  httpTransport.onclose = () => {
    const id = httpTransport.sessionId;
    if (id) unregisterSession(channel, id);
  };

  await server.connect(httpTransport);
  return httpTransport.handleRequest(req);
}
