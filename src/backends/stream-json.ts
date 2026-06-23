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
 * Hard caps on the live-view payload fields. SSE frames must stay SMALL — a tool's
 * `input` (a Bash command, a long Write body) or a `tool_result` (a file read, a
 * grep dump) can be arbitrarily large, so both are bounded here. Truncation appends
 * the {@link TRUNCATION_MARKER} so the consumer can show "…".
 *
 * Operator-visibility note: the turn-events SSE this feeds is `agent:read`-gated —
 * operator-only, owner-operated. Tool inputs/results are INTENTIONALLY visible to the
 * operator (it's their own agent doing their own work), so there is no redaction here
 * beyond size-bounding; the only concern is keeping each frame small.
 */
export const MAX_TOOL_INPUT_CHARS = 2000;
export const MAX_TOOL_RESULT_CHARS = 2000;
const TRUNCATION_MARKER = "…";

/** Truncate `s` to at most `max` chars, appending the marker when it was cut. */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + TRUNCATION_MARKER : s;
}

/**
 * An interim progress event surfaced WHILE a turn runs (the streaming view). The
 * kinds:
 *  - `text`        — a chunk of the agent's assistant message (each assistant event's
 *                    text block; chunk-level, NOT token-level — design §1's "chunk-level
 *                    is fine"). The chat UI appends these into the live in-progress bubble.
 *  - `tool`        — the agent invoked a tool; `tool` is its name (e.g. "Read", "Bash",
 *                    an MCP tool). `input` (optional) is the tool_use block's `input`
 *                    object JSON-stringified + bounded to {@link MAX_TOOL_INPUT_CHARS},
 *                    so the UI can render an EXPANDABLE "Read {file}" / "Bash <cmd>" view.
 *  - `tool_result` — a tool finished; `preview` (optional) is a bounded snippet of its
 *                    output ({@link MAX_TOOL_RESULT_CHARS}), `ok` the success flag
 *                    (`is_error: false` → `ok: true`), and `tool` (optional) the name
 *                    of the tool it came from (correlated via the tool_use_id map).
 *  - `init`        — the turn established a session; carries the `sessionId`. Lets the UI
 *                    start a fresh live bubble (and a consumer correlate by session id).
 *
 * Deliberately small + serializable so it maps 1:1 onto an SSE frame the chat (and,
 * later, my-vault-ui) subscribes to. The `input` / `preview` fields are ADDITIVE +
 * optional: an existing consumer that only reads `kind`/`tool`/`text` keeps working,
 * and one that doesn't know `tool_result` simply ignores the new kind.
 */
export type InterimTurnEvent =
  | { kind: "init"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; input?: string }
  | { kind: "tool_result"; tool?: string; ok?: boolean; preview?: string };

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
  /** Present on a `{ type: "tool_use" }` block — the tool's input arguments. */
  input?: unknown;
  /** Present on a `{ type: "tool_use" }` block — correlates with a later tool_result. */
  id?: string;
}
interface AssistantEvent {
  type: "assistant";
  message?: { content?: AssistantContentBlock[] };
  session_id?: string;
}
/**
 * One content block of a USER-role message — claude emits `tool_result` blocks here,
 * one per completed `tool_use`. `content` is the result payload (a string, or an array
 * of `{ type: "text", text }` parts), `tool_use_id` links it back to its tool_use, and
 * `is_error` is the success flag.
 */
interface UserContentBlock {
  type?: string;
  tool_use_id?: string;
  is_error?: boolean;
  /** The result payload — a plain string, or content parts (`{ type, text }`). */
  content?: unknown;
}
interface UserEvent {
  type: "user";
  message?: { content?: UserContentBlock[] };
  session_id?: string;
}

/**
 * Flatten a `tool_result` block's `content` into a plain preview string. claude
 * emits it either as a bare string or as an array of content parts
 * (`[{ type: "text", text: "…" }, …]`); join the text parts. Returns undefined when
 * there's nothing renderable.
 */
function previewToolResultContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        parts.push((part as { text: string }).text);
      }
    }
    return parts.length > 0 ? parts.join("") : undefined;
  }
  return undefined;
}
interface AnyEvent {
  type?: string;
  session_id?: string;
  [k: string]: unknown;
}

/**
 * Fold ONE already-trimmed, non-empty NDJSON line into the running {@link ParsedTurn}
 * and, when an `onInterim` sink is given, emit the interim events the line carries
 * (assistant text chunks, tool_use names + inputs, tool_result previews, the
 * session-establishing init). Shared by the blob parser and the streaming parser so
 * both have identical final-result semantics. Never throws: a non-`{` line or a
 * JSON-parse failure (a truncated partial line, hook plain text, any noise) is
 * silently ignored.
 *
 * `toolNames` (when given) is a per-PARSE `tool_use_id → name` map: a `tool_use`
 * block records its id→name so a later `tool_result` (which carries only the
 * `tool_use_id`) can be labeled with the tool it came from. The caller owns it (one
 * per parse) so it persists across lines.
 */
function foldLine(
  line: string,
  turn: ParsedTurn,
  onInterim?: (e: InterimTurnEvent) => void,
  toolNames?: Map<string, string>,
): void {
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
          // Record id→name so a later tool_result (which only carries the id) can be
          // labeled with this tool. Best-effort: a result without a recorded id just
          // omits the `tool` label.
          if (toolNames && typeof block.id === "string" && block.id) toolNames.set(block.id, block.name);
          // Stringify + HARD-bound the input so the UI can render an expandable view
          // (e.g. the Read path, the Bash command). Omit when there's no input or it
          // can't be stringified (a circular/exotic value — never throw the parse).
          let input: string | undefined;
          if (block.input !== undefined) {
            try {
              const json = JSON.stringify(block.input);
              if (typeof json === "string") input = truncate(json, MAX_TOOL_INPUT_CHARS);
            } catch {
              // unstringifiable input — drop the field, keep the tool event
            }
          }
          onInterim(input !== undefined ? { kind: "tool", tool: block.name, input } : { kind: "tool", tool: block.name });
        }
      }
    }
    return;
  }

  // USER events carry the tool_result blocks (claude reports each completed tool's
  // output as a tool_result on a user-role message). Emit a bounded `tool_result`
  // interim event per block, labeled with the originating tool via the id→name map.
  // Sink-gated like the assistant path (a no-op for the blob parser).
  if (obj.type === "user" && onInterim) {
    const blocks = (obj as UserEvent).message?.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const event: { kind: "tool_result"; tool?: string; ok?: boolean; preview?: string } = { kind: "tool_result" };
        const name = toolNames && typeof block.tool_use_id === "string" ? toolNames.get(block.tool_use_id) : undefined;
        if (name !== undefined) event.tool = name;
        if (typeof block.is_error === "boolean") event.ok = block.is_error === false;
        const preview = previewToolResultContent(block.content);
        if (preview !== undefined) event.preview = truncate(preview, MAX_TOOL_RESULT_CHARS);
        onInterim(event);
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
  const toolNames = new Map<string, string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    foldLine(line, turn, undefined, toolNames);
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
  // Per-parse tool_use_id → name map, so a tool_result can be labeled with its tool.
  const toolNames = new Map<string, string>();
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
        if (line) foldLine(line, turn, onInterim, toolNames);
      }
    }
    // Flush any multi-byte tail the decoder is holding, then fold the final
    // unterminated line (a result line the pipe closed without a trailing \n).
    buf += decoder.decode();
    const tail = buf.trim();
    if (tail) foldLine(tail, turn, onInterim, toolNames);
  } finally {
    reader.releaseLock();
  }
  return turn;
}
