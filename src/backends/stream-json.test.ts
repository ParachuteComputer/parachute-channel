/**
 * parseStreamJson tests — the `claude -p --output-format stream-json --verbose`
 * NDJSON parser. Built to the VERIFIED event shapes (claude 2.1.179).
 *
 * Covered:
 *  - a success turn: session_id from init, reply from result, success/subtype, usage, cost;
 *  - apiKeySource "none" surfaced (the subscription-auth signal);
 *  - an error turn (is_error / non-success subtype) → success=false, error message;
 *  - session_id captured from the FIRST event (init precedes result);
 *  - robustness: interleaved hook / rate_limit_event lines + a trailing PARTIAL line;
 *  - no result event at all → success undefined (a truncated/crashed turn);
 *  - blank/garbage input → an empty parse, never a throw.
 */
import { describe, test, expect } from "bun:test";
import { parseStreamJson } from "./stream-json.ts";

/** Join NDJSON event objects into the line-delimited blob claude emits. */
function ndjson(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("parseStreamJson — success turn", () => {
  test("captures session_id (from init), reply (from result), subtype, usage, cost", () => {
    const blob = ndjson(
      { type: "system", subtype: "init", session_id: "sess-123", apiKeySource: "none", mcp_servers: [] },
      { type: "assistant", message: { content: [{ type: "text", text: "hi there" }] }, session_id: "sess-123" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Here is the final reply.",
        session_id: "sess-123",
        usage: { input_tokens: 42, output_tokens: 7 },
        total_cost_usd: 0.0012,
      },
    );
    const t = parseStreamJson(blob);
    expect(t.sessionId).toBe("sess-123");
    expect(t.reply).toBe("Here is the final reply.");
    expect(t.success).toBe(true);
    expect(t.subtype).toBe("success");
    expect(t.isError).toBe(false);
    expect(t.usage).toEqual({ input_tokens: 42, output_tokens: 7 });
    expect(t.totalCostUsd).toBe(0.0012);
  });

  test("surfaces apiKeySource 'none' — the subscription-auth signal (design §1)", () => {
    const blob = ndjson(
      { type: "system", subtype: "init", session_id: "s", apiKeySource: "none" },
      { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s" },
    );
    expect(parseStreamJson(blob).apiKeySource).toBe("none");
  });
});

describe("parseStreamJson — error turn", () => {
  test("is_error true → success=false, error message captured from result", () => {
    const blob = ndjson(
      { type: "system", subtype: "init", session_id: "sess-err", apiKeySource: "none" },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "something went wrong",
        session_id: "sess-err",
      },
    );
    const t = parseStreamJson(blob);
    expect(t.success).toBe(false);
    expect(t.isError).toBe(true);
    expect(t.subtype).toBe("error_during_execution");
    expect(t.errorMessage).toBe("something went wrong");
    // The session id is still captured (a turn can fail AFTER establishing a session).
    expect(t.sessionId).toBe("sess-err");
  });

  test("a non-success subtype with is_error false is STILL not success", () => {
    const blob = ndjson(
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result", subtype: "error_max_turns", is_error: false, result: "partial", session_id: "s" },
    );
    const t = parseStreamJson(blob);
    expect(t.success).toBe(false);
    expect(t.subtype).toBe("error_max_turns");
  });
});

describe("parseStreamJson — session_id capture", () => {
  test("captured from the FIRST event that carries one (init precedes result)", () => {
    const blob = ndjson(
      { type: "system", subtype: "init", session_id: "first-id" },
      { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "first-id" },
    );
    expect(parseStreamJson(blob).sessionId).toBe("first-id");
  });

  test("falls through to the result event's session_id when there's no init", () => {
    const blob = ndjson({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "from-result" });
    expect(parseStreamJson(blob).sessionId).toBe("from-result");
  });
});

describe("parseStreamJson — robustness", () => {
  test("interleaved hook / rate_limit_event lines + a trailing PARTIAL line still parse the result", () => {
    const blob =
      // a non-JSON hook line (plain text from a user hook)
      "running PreToolUse hook...\n" +
      ndjson({ type: "system", subtype: "init", session_id: "sess-robust", apiKeySource: "none" }).trimEnd() +
      "\n" +
      // a rate_limit_event interleaved (the subscription five_hour pool signal)
      ndjson({ type: "system", subtype: "rate_limit_event", rate_limit: { five_hour: { overageStatus: "rejected" } } }).trimEnd() +
      "\n" +
      ndjson({ type: "assistant", message: { content: [{ type: "text", text: "thinking" }] }, session_id: "sess-robust" }).trimEnd() +
      "\n" +
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "robust reply",
        session_id: "sess-robust",
        usage: { input_tokens: 1, output_tokens: 2 },
      }) +
      "\n" +
      // a TRAILING PARTIAL line — a JSON object cut off mid-stream (no closing brace)
      '{"type":"system","subtype":"in';
    const t = parseStreamJson(blob);
    expect(t.sessionId).toBe("sess-robust");
    expect(t.reply).toBe("robust reply");
    expect(t.success).toBe(true);
    expect(t.apiKeySource).toBe("none");
  });

  test("blank lines + a leading non-{ line are skipped", () => {
    const blob =
      "\n\nsome banner text\n" +
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s" }) +
      "\n\n";
    const t = parseStreamJson(blob);
    expect(t.reply).toBe("ok");
    expect(t.success).toBe(true);
  });

  test("no result event at all → success is undefined (a truncated/crashed turn)", () => {
    const blob = ndjson(
      { type: "system", subtype: "init", session_id: "sess-trunc", apiKeySource: "none" },
      { type: "assistant", message: { content: [{ type: "text", text: "started…" }] }, session_id: "sess-trunc" },
    );
    const t = parseStreamJson(blob);
    expect(t.success).toBeUndefined();
    expect(t.reply).toBeUndefined();
    expect(t.sessionId).toBe("sess-trunc"); // id still available for a resume
  });

  test("fully blank / garbage input → an empty parse, never a throw", () => {
    expect(parseStreamJson("")).toEqual({});
    expect(parseStreamJson("   \n  \n")).toEqual({});
    expect(parseStreamJson("not json at all\nmore noise")).toEqual({});
  });
});
