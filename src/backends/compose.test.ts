/**
 * composeSystemPrompt tests (threads-only Phase A — DESIGN-2026-06-29-threads-only.md §1/§9).
 *
 * The compose seam generalizes from "one role body" to an ORDERED LIST of loaded notes (a
 * LOADOUT). Covered here at the PURE-function level (the backend integration — the
 * `system-prompt.txt` write — is exercised in programmatic.test.ts):
 *
 *  - the NO-LOADOUT invariant: one (self) entry → `# <path>\n\n<body>`, body byte-identical;
 *  - arity-N: [self, ...notes] in order, each path-headered, joined by `\n\n---\n\n`;
 *  - dedupe by path (first wins); skip blank/whitespace content;
 *  - the BYTE BUDGET: over-budget truncates loadout-notes-first, NEVER the self entry; warns.
 */
import { describe, test, expect } from "bun:test";
import { composeSystemPrompt, LOADOUT_BUDGET_BYTES, type LoadoutEntry } from "./types.ts";

describe("composeSystemPrompt — the no-loadout invariant (the steward weave path)", () => {
  test("ONE self entry → `# <path>\\n\\n<body>`, body BYTE-IDENTICAL after the header", () => {
    const body = "You are the steward.\nTend the vault.\n\n  trailing spaces preserved  ";
    const out = composeSystemPrompt([{ path: "Agents/steward", content: body }]);
    expect(out).toBe(`# Agents/steward\n\n${body}`);
    // From the other direction: strip the header → the body is byte-identical.
    expect(out.slice("# Agents/steward\n\n".length)).toBe(body);
  });

  test("the header is the ONLY addition — no separator, no trailing newline", () => {
    const out = composeSystemPrompt([{ path: "x", content: "just this" }]);
    expect(out).toBe("# x\n\njust this");
    expect(out.endsWith("just this")).toBe(true);
  });
});

describe("composeSystemPrompt — arity-N loadout", () => {
  test("[self, ...notes] in ORDER, each path-headered, joined by `---`", () => {
    const entries: LoadoutEntry[] = [
      { path: "Agents/steward", content: "self body" },
      { path: "Projects/Surface", content: "project body" },
      { path: "Packs/GitHub", content: "pack body" },
    ];
    expect(composeSystemPrompt(entries)).toBe(
      "# Agents/steward\n\nself body" +
        "\n\n---\n\n# Projects/Surface\n\nproject body" +
        "\n\n---\n\n# Packs/GitHub\n\npack body",
    );
  });

  test("DEDUPE by path — first occurrence wins, later duplicates dropped", () => {
    const entries: LoadoutEntry[] = [
      { path: "a", content: "A1" },
      { path: "b", content: "B" },
      { path: "a", content: "A2-DROPPED" },
    ];
    expect(composeSystemPrompt(entries)).toBe("# a\n\nA1\n\n---\n\n# b\n\nB");
  });

  test("SKIP blank/whitespace-only content entries", () => {
    const entries: LoadoutEntry[] = [
      { path: "self", content: "S" },
      { path: "blank", content: "   \n\t  " },
      { path: "empty", content: "" },
      { path: "keep", content: "K" },
    ];
    expect(composeSystemPrompt(entries)).toBe("# self\n\nS\n\n---\n\n# keep\n\nK");
  });

  test("empty entries → empty string", () => {
    expect(composeSystemPrompt([])).toBe("");
  });
});

describe("composeSystemPrompt — byte budget", () => {
  test("under budget → no truncation, no warn", () => {
    let warned = 0;
    const out = composeSystemPrompt(
      [
        { path: "self", content: "self" },
        { path: "n1", content: "small" },
      ],
      { budgetBytes: 10_000, onWarn: () => (warned += 1) },
    );
    expect(out).toContain("# n1");
    expect(warned).toBe(0);
  });

  test("OVER budget → truncates LOADOUT notes (tail-first), NEVER the self entry; warns", () => {
    const self = { path: "Agents/steward", content: "SELF-" + "s".repeat(500) };
    const big = (p: string) => ({ path: p, content: p + "-" + "x".repeat(400) });
    const warnings: string[] = [];
    // Budget fits the self entry + one loadout note, but not all three.
    const budget = 700;
    const out = composeSystemPrompt([self, big("n1"), big("n2"), big("n3")], {
      budgetBytes: budget,
      onWarn: (m) => warnings.push(m),
    });
    // The SELF entry is ALWAYS present, byte-for-byte.
    expect(out.startsWith(`# ${self.path}\n\n${self.content}`)).toBe(true);
    // The composed output fits the budget.
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(budget);
    // A loud warn fired, naming dropped notes.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("over budget");
    expect(warnings[0]).toContain("n3");
  });

  test("self entry ALONE exceeds budget → still kept whole (never truncated), loadout all dropped", () => {
    const self = { path: "self", content: "S".repeat(2000) };
    const warnings: string[] = [];
    const out = composeSystemPrompt([self, { path: "n1", content: "x".repeat(50) }], {
      budgetBytes: 100, // smaller than even the self entry
      onWarn: (m) => warnings.push(m),
    });
    // The self entry is preserved in full — the no-truncate-self guarantee outweighs the budget.
    expect(out).toBe(`# ${self.path}\n\n${self.content}`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("n1");
  });

  test("the default budget is the documented LOADOUT_BUDGET_BYTES", () => {
    expect(LOADOUT_BUDGET_BYTES).toBe(600_000);
  });
});
