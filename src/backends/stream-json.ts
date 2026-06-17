/**
 * Parse `claude -p --output-format stream-json --verbose` output.
 *
 * VERIFIED against claude 2.1.179 (spike). The output is NDJSON — one JSON object
 * per line — but the stream also carries lines we must tolerate without breaking:
 * hook output, `rate_limit_event`s, blank lines, and (at the tail of a still-open
 * pipe) a partial final line. The parser is therefore DEFENSIVE: it parses what it
 * can, ignores any line that isn't a JSON object, and never throws.
 *
 * The event types we key on (others are passed over):
 *
 *   { "type": "system", "subtype": "init", "session_id": "...",
 *     "apiKeySource": "none", "mcp_servers": [...], ... }
 *
 *   { "type": "assistant", "message": { "content": [{ "type": "text",
 *     "text": "..." }], ... }, "session_id": "..." }
 *
 *   { "type": "result", "subtype": "success", "is_error": false,
 *     "result": "<final reply text>", "session_id": "...",
 *     "usage": {...}, "total_cost_usd": ... }
 *
 * The `result` event is authoritative: its `result` field is the final reply and
 * its `is_error` / `subtype` decide success. We also capture `session_id` from the
 * FIRST event that carries one (the `init` event arrives before `result`), so a
 * turn that fails AFTER establishing a session still yields the id for a resume.
 *
 * `apiKeySource: "none"` on the init event is the SUBSCRIPTION-auth signal — the
 * turn ran on the operator's subscription, not a metered API key (design §1 / the
 * Billing caveat). We surface it so a caller / test can assert it.
 *
 * ── Two reading modes ───────────────────────────────────────────────────────────
 * {@link parseStreamJson} folds a COMPLETE blob into the final {@link ParsedTurn}
 * (used wherever the whole stdout is already in hand). {@link parseStreamJsonStream}
 * reads a byte stream INCREMENTALLY, emitting {@link InterimTurnEvent}s — interim
 * assistant text + which tool the agent is using — as each line arrives, and
 * returns the same final {@link ParsedTurn} at the end. The streaming view (design
 * 2026-06-16-channel-architecture-post-programmatic.md, build item #1) drives the
 * "watch it work" chat UI off those interim events while the durable final-reply
 * path is unchanged. Both modes share one per-line fold ({@link foldLine}), so the
 * final-result semantics are identical whichever mode produced them.
 */

/** A parsed `claude -p` stream-json turn. */
export interface ParsedTurn {
  /** The session id (from the first event carrying one — init, else result). */
  sessionId?: string;
  /** The final reply text (the `result` event's `result` field). */
  reply?: string;
  /**
   * The `result` event's success verdict. `true` only when a `result` event with
   * `subtype: "success"` and `is_error: false` was seen. Absent (undefined) when no
   * `result` event arrived at all (a crashed / truncated turn).
   */
  success?: boolean;
  /** The `result` event's `subtype` (e.g. "success", "error_max_turns"). */
  subtype?: string;
  /** The `result` event's `is_error` flag, verbatim. */
  isError?: boolean;
  /** `apiKeySource` from the init event ("none" = subscription auth — design §1). */
  apiKeySource?: string;
  /** Usage from the result event (token counts), passed through verbatim. */
  usage?: { input_tokens?: number; output_tokens?: number; [k: string]: unknown };
  /** `total_cost_usd` from the result event (equivalent-cost, NOT a charge — §1). */
  totalCostUsd?: number;
  /**
   * Any error message the result event carried (some failures put the message in
   * the `result` field even with `is_error: true`). Best-effort.
   */
  errorMessage?: string;
}

/**
 * An interim progress event surfaced WHILE a turn runs (the streaming view). The
 * three kinds:
 *  - `text`   — a chunk of the agent's assistant message (each assistant event's
 *               text block; chunk-level, NOT token-level — design §1's "chunk-level
 *               is fine"). The chat UI appends these into the live in-progress bubble.
 *  - `tool`   — the agent invoked a tool; `tool` is its name (e.g. "Read", "Bash",
 *               an MCP tool). The chat UI shows a "using <tool>" indicator.
 *  - `init`   — the turn established a session; carries the `sessionId`. Lets the UI
 *               start a fresh live bubble (and a consumer correlate by session id).
 *
 * Deliberately small + serializable so it maps 1:1 onto an SSE frame the chat (and,
 * later, my-vault-ui) subscribes to.
 */
export type InterimTurnEvent =
  | { kind: "init"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string };

interface SystemInitEvent {
  type: "system";
  subtype?: string;
  session_id?: string;
  apiKeySource?: string;
}
interface ResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  usage?: { input_tokens?: number; output_tokens?: number; [k: string]: unknown };
  total_cost_usd?: number;
}
/** One content block of an assistant message — text or a tool invocation. */
interface AssistantContentBlock {
  type?: string;
  /** Present on a `{ type: "text" }` block — a chunk of the assistant's prose. */
  text?: string;
  /** Present on a `{ type: "tool_use" }` block — the invoked tool's name. */
  name?: string;
}
interface AssistantEvent {
  type: "assistant";
  message?: { content?: AssistantContentBlock[] };
  session_id?: string;
}
interface AnyEvent {
  type?: string;
  session_id?: string;
  [k: string]: unknown;
}

/**
 * Fold ONE already-trimmed, non-empty NDJSON line into the running {@link ParsedTurn}
 * and, when an `onInterim` sink is given, emit the interim events the line carries
 * (assistant text chunks, tool_use names, the session-establishing init). Shared by
 * the blob parser and the streaming parser so both have identical final-result
 * semantics. Never throws: a non-`{` line or a JSON-parse failure (a truncated
 * partial line, hook plain text, any noise) is silently ignored.
 */
function foldLine(line: string, turn: ParsedTurn, onInterim?: (e: InterimTurnEvent) => void): void {
  // Fast reject: NDJSON events are objects. A non-`{` line (hook plain text, a
  // partial line that got cut mid-token) can't be one — skip without a try/catch.
  if (line[0] !== "{") return;

  let obj: AnyEvent;
  try {
    obj = JSON.parse(line) as AnyEvent;
  } catch {
    // A partial/truncated line, or any non-JSON noise — tolerate it.
    return;
  }
  if (!obj || typeof obj !== "object") return;

  // Capture session_id from the FIRST event that has one (init precedes result),
  // so a turn that errors after init still yields the id for a resume. The first
  // sighting also drives the interim `init` event (a single per-turn signal the UI
  // uses to open a fresh live bubble).
  if (turn.sessionId === undefined && typeof obj.session_id === "string" && obj.session_id) {
    turn.sessionId = obj.session_id;
    onInterim?.({ kind: "init", sessionId: obj.session_id });
  }

  if (obj.type === "system" && (obj as SystemInitEvent).subtype === "init") {
    const init = obj as SystemInitEvent;
    if (typeof init.apiKeySource === "string") turn.apiKeySource = init.apiKeySource;
    return;
  }

  // ASSISTANT events carry the interim progress: text chunks + tool_use blocks.
  // These don't affect the final ParsedTurn (the authoritative reply is the result
  // event's `result`), but they're what the live view renders. Only emitted when a
  // sink is wired (the blob parser passes none, so this is a no-op there).
  if (obj.type === "assistant" && onInterim) {
    const blocks = (obj as AssistantEvent).message?.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          onInterim({ kind: "text", text: block.text });
        } else if (block.type === "tool_use" && typeof block.name === "string" && block.name.length > 0) {
          onInterim({ kind: "tool", tool: block.name });
        }
      }
    }
    return;
  }

  if (obj.type === "result") {
    const r = obj as ResultEvent;
    turn.subtype = typeof r.subtype === "string" ? r.subtype : undefined;
    turn.isError = r.is_error === true;
    turn.success = r.subtype === "success" && r.is_error !== true;
    if (typeof r.result === "string") {
      // `result` carries the reply on success; on some failures it carries the
      // error message. Record it as both; the caller picks per success/isError.
      turn.reply = r.result;
      if (turn.isError) turn.errorMessage = r.result;
    }
    if (r.usage && typeof r.usage === "object") turn.usage = r.usage;
    if (typeof r.total_cost_usd === "number") turn.totalCostUsd = r.total_cost_usd;
    // Don't return early after a result so session_id capture stays robust if
    // ordering ever surprises us — there's only one result event in practice.
    return;
  }
}

/**
 * Parse a complete stream-json blob (the full stdout of one `claude -p` turn).
 * Splits on newlines, JSON-parses each non-blank line, and folds the recognized
 * events into a {@link ParsedTurn}. Lines that aren't a JSON object (hook text, a
 * trailing partial line, blanks) are silently skipped — robustness is the point.
 */
export function parseStreamJson(stdout: string): ParsedTurn {
  const turn: ParsedTurn = {};
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    foldLine(line, turn);
  }
  return turn;
}

/**
 * Parse a stream-json byte stream INCREMENTALLY, emitting {@link InterimTurnEvent}s
 * via `onInterim` as each complete line arrives, and resolving to the final
 * {@link ParsedTurn} when the stream ends. This is the streaming-view path (design
 * build item #1): the same final result `parseStreamJson` would compute from the
 * whole blob, PLUS live progress.
 *
 * Mechanics: decode incrementally (a `TextDecoder` with `{ stream: true }` so a
 * multi-byte char split across chunks doesn't corrupt), buffer until a newline,
 * fold each complete line. The trailing partial line (no terminating newline — a
 * chunk boundary mid-line, or a truncated final line) is folded ONCE at the end:
 * `foldLine` tolerates a partial that isn't valid JSON, and a complete-but-
 * unterminated final result line (the pipe closing without a trailing `\n`) is
 * still parsed. A null stream (no stdout) yields an empty turn with no events.
 *
 * The `onInterim` callback must not throw (the daemon's sink swallows dead-stream
 * errors); a throw here would abort the drain. Best-effort by contract: this is
 * ADDITIVE live progress — the durable record is the final ParsedTurn the caller
 * turns into the outbound note.
 */
export async function parseStreamJsonStream(
  stream: ReadableStream<Uint8Array> | null,
  onInterim: (e: InterimTurnEvent) => void,
): Promise<ParsedTurn> {
  const turn: ParsedTurn = {};
  if (!stream) return turn;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Drain every COMPLETE line (terminated by \n). Keep the trailing remainder
      // (a still-incomplete line) in `buf` for the next chunk.
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) foldLine(line, turn, onInterim);
      }
    }
    // Flush any multi-byte tail the decoder is holding, then fold the final
    // unterminated line (a result line the pipe closed without a trailing \n).
    buf += decoder.decode();
    const tail = buf.trim();
    if (tail) foldLine(tail, turn, onInterim);
  } finally {
    reader.releaseLock();
  }
  return turn;
}
