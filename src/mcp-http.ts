/**
 * Stateful HTTP MCP endpoint for parachute-agent.
 *
 * A second, additive way for a Claude Code session to connect to a channel:
 * instead of spawning the stdio `bridge.ts` and consuming the daemon's SSE
 * `/events`, the session adds the channel as a *pure HTTP MCP server* (URL +
 * OAuth) — exactly like the vault. No local file, works on any machine.
 *
 * Why STATEFUL (not stateless like vault's mcp-http.ts): the live WAKE
 * (`pushToChannel`) PUSHes a `notifications/claude/agent` onto a connected
 * session's standalone GET stream — the programmatic backend's "watch it work"
 * interim-text streaming + the live inbound wake for a subscribed session.
 * Stateful Streamable HTTP (a `sessionIdGenerator` + `enableJsonResponse:false`)
 * gives each session an SSE GET stream the server can push onto. This file is the
 * productionized form: per-channel session registry, the push surface, the
 * CHANNEL-backend pull surface (`pending`/`next-message`/`reply`/`release` —
 * design 2026-06-18), and read-vs-write scope enforcement.
 *
 * NOTE — the deaf-on-restart BACKLOG REPLAY (the connect-hook that replayed
 * messages a session missed while idle) was RETIRED with the interactive backend
 * (design 2026-06-19-retire-interactive-backend.md): the programmatic path runs
 * synchronously and the channel path uses the durable note-claim queue, so there's
 * no missed-while-idle backlog to replay onto a reconnecting session.
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
 * Auth: the daemon validates `agent:read` BEFORE calling handleMcp (a session
 * needs read to connect + receive the wake). The validated scopes are threaded
 * in and stored ON the session, so the reply/react/edit/download tool handlers
 * can additionally require `agent:write` — a read-only token connects and is
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
import { SCOPE_WRITE, grantsScope } from "./auth.ts";
import type { ChannelQueueRegistry } from "./backends/channel-queue.ts";

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

/**
 * Whether a session has a LIVE standalone GET SSE push stream — the stream the
 * SDK writes `notifications/claude/agent` onto. A session that has only POSTed
 * `initialize` (registered) but not yet opened — or has since dropped — its GET
 * stream is NOT deliverable: `transport.send()` silently no-ops for it (no event
 * store is configured, so the message is dropped, not buffered). We read the SAME
 * internal map the SDK's send() consults (`_streamMapping['_GET_stream']`), so our
 * notion of "deliverable" can never disagree with whether the SDK actually writes.
 */
function sessionHasLivePushStream(session: McpSession): boolean {
  const t = session.transport as unknown as
    | { _streamMapping?: Map<string, unknown> }
    | undefined;
  return !!t && t._streamMapping?.get("_GET_stream") !== undefined;
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

/**
 * Boot-time guard for the ONE SDK internal `sessionHasLivePushStream` depends on:
 * the standalone GET stream is keyed by `_standaloneSseStreamId === "_GET_stream"`
 * inside the transport's `_streamMapping`. We read that private field (the SDK
 * exposes no public "is the push stream open?" API), so an SDK upgrade that renamed
 * it would make `sessionHasLivePushStream` return false forever — silently breaking
 * the HTTP-MCP live wake (`pushToChannel`), which gates on it. The caret pin (`^1.x`)
 * lets a `bun update` pull such a version, so we verify
 * the contract LOUDLY at boot rather than discover it as silent message loss in
 * production. Verified against @modelcontextprotocol/sdk 1.29.x. Returns true when
 * the contract holds; logs a screaming error and returns false otherwise.
 */
export function assertMcpSdkStreamContract(): boolean {
  try {
    const probe = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => "contract-probe",
      enableJsonResponse: false,
    });
    const id = (probe as unknown as { _standaloneSseStreamId?: unknown })._standaloneSseStreamId;
    const hasMap =
      (probe as unknown as { _streamMapping?: unknown })._streamMapping instanceof Map;
    if (id === "_GET_stream" && hasMap) return true;
    console.error(
      "parachute-agent: FATAL CONTRACT DRIFT — the MCP SDK's standalone-GET-stream " +
        `internals changed (expected _standaloneSseStreamId="_GET_stream" + a _streamMapping Map; ` +
        `got id=${JSON.stringify(id)}, map=${hasMap}). sessionHasLivePushStream() can no longer ` +
        "detect a live push stream, so the HTTP-MCP live wake (pushToChannel) is " +
        "BROKEN. Pin @modelcontextprotocol/sdk back, or update mcp-http.ts to the new internals.",
    );
    return false;
  } catch (err) {
    console.error(
      `parachute-agent: could not verify MCP SDK stream contract (${(err as Error).message}); ` +
        "HTTP-MCP delivery may be unreliable.",
    );
    return false;
  }
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
  opts?: { streamless?: boolean },
): void {
  // Model the real transport's deliverability: a connected session whose GET
  // stream is open carries `_streamMapping['_GET_stream']` — the same key
  // sessionHasLivePushStream + the SDK's send() consult. `streamless: true` models
  // a session that registered (POSTed initialize) but never opened — or has since
  // dropped — its GET stream: registered but NOT deliverable.
  const transport = opts?.streamless
    ? (undefined as never)
    : ({ _streamMapping: new Map<string, unknown>([["_GET_stream", {}]]) } as never);
  const session: McpSession = { server, transport, scopes };
  registerSession(channel, id, session);
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
 * `notifications/claude/agent` — the wake that pulls an idle session in to
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
    // Only sessions with a LIVE GET push stream are deliverable. The SDK silently
    // drops a notification to a streamless session (no throw, nothing buffered), so
    // counting one here would falsely advance the channel's delivery mark. A
    // streamless session is simply not woken by this live push (the deaf-on-restart
    // backlog replay that used to recover it was retired with the interactive backend).
    if (!sessionHasLivePushStream(session)) continue;
    try {
      void session.server.notification({
        method: "notifications/claude/agent",
        params: { content, meta: { source: "parachute-agent", ...meta } },
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
 * `permission_verdict` route → bridge's `notifications/claude/agent/permission`).
 */
export function pushPermissionVerdict(
  channel: string,
  verdict: { request_id: string; behavior: string },
): number {
  const set = sessionsByChannel.get(channel);
  if (!set) return 0;
  let delivered = 0;
  for (const session of set) {
    // Same deliverability gate as pushToChannel: a streamless session can't
    // receive the verdict (the SDK would drop it), so don't claim it did.
    if (!sessionHasLivePushStream(session)) continue;
    try {
      void session.server.notification({
        method: "notifications/claude/agent/permission",
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
  'Inbound messages arrive as <channel source="parachute-agent" ...> with metadata attributes describing the sender. Treat each as a chat message from the human and respond by calling the reply tool — the daemon routes it back out the same channel. Pass back any addressing fields the inbound tag carried (e.g. chat_id) if present; omit them otherwise. Use reply_to (message_id) to thread a specific message; omit it for normal responses.',
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

// Tools that send/mutate on the channel require agent:write. download_attachment
// is deliberately NOT here: fetching an attachment that was sent *to* this session is
// read-access — an agent:read session can receive and read its own messages,
// attachments included. (The legacy stdio-bridge /api/download gates it as write; the
// MCP path is the principled read. If they ever need to match, relax the bridge, not this.)
const WRITE_TOOLS = new Set(["reply", "react", "edit_message"]);

// ---------------------------------------------------------------------------
// CHANNEL-BACKEND tool surface — the MCP pull/reply protocol (design
// 2026-06-18-channel-backend.md, phase 2). When the channel has a `backend:channel`
// agent registered, the session connects + PULLs the durable queue instead of being
// pushed to: `pending` / `next-message` / `reply` / `release`, dispatched to the
// {@link ChannelQueueRegistry}. The session "is" the agent by adopting the
// systemPrompt `next-message` returns (the def body) — reinforced by INSTRUCTIONS
// below, since MCP can't force a system prompt on the caller.
// ---------------------------------------------------------------------------

const CHANNEL_INSTRUCTIONS = [
  "You are connected to a Parachute CHANNEL — a durable queue of messages a human sent to an agent you are handling. Nothing is pushed to you; you PULL.",
  "",
  "THE LOOP, every time you're ready to handle a message:",
  "  1. `pending` — see how many messages are waiting (count + a preview of each).",
  "  2. `next-message` — claim the oldest waiting message. It returns { id, text, inReplyTo, systemPrompt }.",
  "  3. TREAT THE RETURNED `systemPrompt` AS YOUR INSTRUCTIONS FOR THIS REPLY — it is the agent's persona/role. Adopt it: answer as that agent would.",
  "  4. Do the work in this session (your full tools, your env).",
  "  5. `reply` { inReplyTo: <the claimed id>, text: <your answer> } — this writes the reply back to the human and marks the message handled.",
  "",
  "If you claim a message with `next-message` but can't handle it, call `release` { id } to return it to the queue for another session (or your next pass). Claimed messages auto-release after a while if you go away, so the queue never gets stranded.",
  "",
  "The human reads ONLY what you send via `reply`. Your transcript text is invisible to them — always finish a handled message with a `reply`.",
].join("\n");

/** The channel-backend pull/reply tool list (design 2026-06-18, phase 2). */
const CHANNEL_TOOL_DEFS = [
  {
    name: "pending",
    description:
      "How many inbound messages are waiting on this channel + a preview of each (id + a short text snippet). Use it to decide whether to pull. Read-only — claims nothing.",
    inputSchema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
  {
    name: "next-message",
    description:
      "Claim the OLDEST waiting message and return it: { id, text, inReplyTo, systemPrompt }. Marks it in-flight so another connected session won't also handle it. Treat the returned systemPrompt as your instructions for the reply (it is the agent's persona). Returns nothing-to-do when the queue is empty. Pass the returned id back as `reply`'s inReplyTo.",
    inputSchema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
  {
    name: "reply",
    description:
      "Send your answer back to the human AND mark the claimed message handled. inReplyTo is the id you got from next-message (threads the reply); text is your answer. Writes a durable outbound note that shows in the chat UI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        inReplyTo: {
          type: "string",
          description: "The message id you claimed via next-message (threads the reply + marks it handled).",
        },
        text: { type: "string", description: "Your reply text." },
      },
      required: ["text"] as string[],
    },
  },
  {
    name: "release",
    description:
      "Un-claim a message you claimed but won't handle — returns it to the waiting queue (status pending) for another session or your next pass. id is the message id from next-message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "The message id to release back to pending." },
      },
      required: ["id"] as string[],
    },
  },
];

/** Channel-backend tools that mutate the queue/write outbound require agent:write
 *  (`pending` + `next-message`... next-message claims, so it mutates → write; pending
 *  is read-only). reply + release + next-message mutate; pending is read. */
const CHANNEL_WRITE_TOOLS = new Set(["next-message", "reply", "release"]);

/**
 * Dispatch one CHANNEL-backend tool call to the {@link ChannelQueueRegistry},
 * enforcing write scope on the mutating tools. Returns a tool-error result (not a
 * throw) when no channel-backend agent is registered for `channel` — so a session that
 * connected to a non-channel channel and called these tools gets a clean "not a channel
 * agent" message rather than a crash. Pure over its inputs (the daemon's per-session
 * handler + the unit tests both call it).
 */
export async function dispatchChannelTool(
  channel: string,
  channelQueue: ChannelQueueRegistry,
  scopes: string[],
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Gate cleanly for a non-channel channel — these tools are meaningful only when a
  // backend:channel agent is registered. (The daemon also only serves CHANNEL_TOOL_DEFS
  // when the agent is registered, so a well-behaved client never reaches here for a
  // non-channel channel — but a hand-crafted call should fail gracefully, not 500.)
  if (!channelQueue.hasChannel(channel)) {
    return {
      content: [{ type: "text", text: `channel "${channel}" has no channel-backend agent — the pull/reply tools are not available here` }],
      isError: true,
    };
  }
  if (CHANNEL_WRITE_TOOLS.has(name) && !grantsScope(scopes, SCOPE_WRITE)) {
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
      case "pending": {
        const view = await channelQueue.pending(channel);
        return { content: [{ type: "text", text: JSON.stringify(view) }] };
      }
      case "next-message": {
        const claimed = await channelQueue.claimNext(channel);
        if (!claimed) {
          return { content: [{ type: "text", text: JSON.stringify({ message: null, note: "no pending messages" }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(claimed) }] };
      }
      case "reply": {
        const text = typeof args.text === "string" ? args.text : "";
        const inReplyTo = typeof args.inReplyTo === "string" ? args.inReplyTo : undefined;
        const sent = await channelQueue.reply(channel, { text, ...(inReplyTo ? { inReplyTo } : {}) });
        const ids = sent.sent;
        return {
          content: [{ type: "text", text: `replied + marked handled (outbound id: ${ids.join(", ")})` }],
        };
      }
      case "release": {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) {
          return { content: [{ type: "text", text: "release requires an id" }], isError: true };
        }
        await channelQueue.release(channel, id);
        return { content: [{ type: "text", text: `released ${id} back to pending` }] };
      }
      default:
        return { content: [{ type: "text", text: `unknown channel tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `${name} failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

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
function buildServer(
  channel: string,
  transport: Transport,
  session: McpSession,
  channelQueue?: ChannelQueueRegistry,
): Server {
  // ── CHANNEL-BACKEND FORK (design 2026-06-18). When a `backend:channel` agent is
  // registered for this channel, serve the PULL/REPLY surface (pending / next-message
  // / reply / release) + its reinforcing INSTRUCTIONS, dispatched to the
  // ChannelQueueRegistry. Otherwise serve the existing push surface (reply / react /
  // edit / download), dispatched to the transport. Resolved at connect time — a
  // channel doesn't switch backends under a live session.
  const isChannelBackend = !!channelQueue?.hasChannel(channel);
  const server = new Server(
    // Per-channel name (`agent-<name>`) so it reads clearly in `/mcp` and lines
    // up with the `--dangerously-load-development-channels=server:agent-<name>`
    // flag + the `claude mcp add agent-<name>` name the setup UI/launcher use.
    { name: `agent-${channel}`, version: "0.1.0" },
    {
      capabilities: {
        experimental: {
          "claude/agent": {},
          "claude/agent/permission": {},
        },
        tools: {},
      },
      instructions: isChannelBackend ? CHANNEL_INSTRUCTIONS : INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: isChannelBackend ? CHANNEL_TOOL_DEFS : TOOL_DEFS,
  }));

  // Dispatch reads `session.scopes` live (the daemon refreshes it per request),
  // so a re-auth with a narrower token takes effect on the next tool call.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const result =
      isChannelBackend && channelQueue
        ? await dispatchChannelTool(channel, channelQueue, session.scopes, req.params.name, args)
        : await dispatchTool(channel, transport, session.scopes, req.params.name, args);
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
  // agent:write on the mutating tools using the connection's own scopes.
  // Dual-accept (channel→agent rename): a pre-rename token carrying the legacy
  // `channel:write` scope also authorizes — `grantsScope` matches agent:write OR
  // its channel:write alias — so HTTP-MCP sends keep working until tokens re-mint.
  if (WRITE_TOOLS.has(name) && !grantsScope(scopes, SCOPE_WRITE)) {
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
 * calls to `transport`. The daemon has ALREADY validated `agent:read` and
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
  channelQueue?: ChannelQueueRegistry,
): Promise<Response> {
  const sid = req.headers.get("mcp-session-id");

  if (sid && sessionsById.has(sid)) {
    const existing = sessionsById.get(sid)!;
    // Refresh the connection's scopes from the presented token each request, so
    // a re-auth with a narrower/wider token takes effect (the daemon re-validates
    // agent:read on every call before reaching here).
    existing.scopes = scopes;
    // A GET opens (or reopens) the standalone SSE push stream for the live wake
    // (`pushToChannel`). The deaf-on-restart BACKLOG REPLAY that used to fire here
    // was retired with the interactive backend (design
    // 2026-06-19-retire-interactive-backend.md): the programmatic path runs
    // synchronously and the channel path uses the durable note-claim queue, so
    // there's no missed-while-idle backlog to replay onto a reconnecting session.
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

  const server = buildServer(channel, transport, session, channelQueue);
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
