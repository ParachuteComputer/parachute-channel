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
interface AnyEvent {
  type?: string;
  session_id?: string;
  [k: string]: unknown;
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
    // Fast reject: NDJSON events are objects. A non-`{` line (hook plain text, a
    // partial line that got cut mid-token) can't be one — skip without a try/catch.
    if (line[0] !== "{") continue;

    let obj: AnyEvent;
    try {
      obj = JSON.parse(line) as AnyEvent;
    } catch {
      // A partial/truncated final line, or any non-JSON noise — tolerate it.
      continue;
    }
    if (!obj || typeof obj !== "object") continue;

    // Capture session_id from the FIRST event that has one (init precedes result),
    // so a turn that errors after init still yields the id for a resume.
    if (turn.sessionId === undefined && typeof obj.session_id === "string" && obj.session_id) {
      turn.sessionId = obj.session_id;
    }

    if (obj.type === "system" && (obj as SystemInitEvent).subtype === "init") {
      const init = obj as SystemInitEvent;
      if (typeof init.apiKeySource === "string") turn.apiKeySource = init.apiKeySource;
      continue;
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
      // Don't `break` — there's only one result event, but draining the rest is
      // cheap and keeps session_id capture robust if ordering ever surprises us.
      continue;
    }
  }

  return turn;
}
