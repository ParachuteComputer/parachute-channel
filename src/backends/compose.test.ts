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
      { path: "Refs/GitHub", content: "ref body" },
    ];
    expect(composeSystemPrompt(entries)).toBe(
      "# Agents/steward\n\nself body" +
        "\n\n---\n\n# Projects/Surface\n\nproject body" +
        "\n\n---\n\n# Refs/GitHub\n\nref body",
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

describe("composeSystemPrompt — protectedCount (the roles + def + thread-content protected prefix)", () => {
  test("protectedCount=3 protects the WHOLE roles+def+thread prefix; only the layer-③ tail sheds", () => {
    // The shape the backend builds with one role loaded: [role, self(def), thread-content, ...loadout].
    const role = { path: "Roles/PM", content: "ROLE-" + "r".repeat(200) };
    const self = { path: "Agents/uni", content: "DEF-" + "d".repeat(200) };
    const threadContent = { path: "Threads/eng/uni", content: "THREAD-" + "t".repeat(200) };
    const big = (p: string) => ({ path: p, content: p + "-" + "x".repeat(400) });
    const warnings: string[] = [];
    // Budget fits the three protected entries but not the extra-context loadout notes.
    const budget = 900;
    const out = composeSystemPrompt([role, self, threadContent, big("n1"), big("n2")], {
      budgetBytes: budget,
      protectedCount: 3,
      onWarn: (m) => warnings.push(m),
    });
    // The role leads, then the def, then the thread content — all three survive whole, in order.
    expect(out).toBe(
      `# ${role.path}\n\n${role.content}` +
        `\n\n---\n\n# ${self.path}\n\n${self.content}` +
        `\n\n---\n\n# ${threadContent.path}\n\n${threadContent.content}`,
    );
    // Only the layer-③ tail was shed; the warn names neither the role, the def, nor the thread.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("n1");
    expect(warnings[0]).toContain("n2");
    expect(warnings[0]).not.toContain("Roles/PM");
    expect(warnings[0]).not.toContain("Agents/uni");
    expect(warnings[0]).not.toContain("Threads/eng/uni");
  });

  test("protectedCount=2 protects BOTH leading entries (def + thread content), tail-drops only the loadout (index ≥2)", () => {
    // The shape the backend builds: [self(def), thread-content, ...loadout].
    const self = { path: "Agents/uni", content: "DEF-" + "d".repeat(200) };
    const threadContent = { path: "Threads/eng/uni", content: "THREAD-" + "t".repeat(200) };
    const big = (p: string) => ({ path: p, content: p + "-" + "x".repeat(400) });
    const warnings: string[] = [];
    // Budget fits the two protected entries but not the loadout notes.
    const budget = 600;
    const out = composeSystemPrompt([self, threadContent, big("n1"), big("n2")], {
      budgetBytes: budget,
      protectedCount: 2,
      onWarn: (m) => warnings.push(m),
    });
    // BOTH protected entries survive in full, in order (def first, thread content second).
    expect(out).toBe(`# ${self.path}\n\n${self.content}\n\n---\n\n# ${threadContent.path}\n\n${threadContent.content}`);
    // The loadout tail was shed (over budget), with a loud warn naming the dropped notes.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("over budget");
    expect(warnings[0]).toContain("n1");
    expect(warnings[0]).toContain("n2");
    // The warn names neither the def nor the thread content.
    expect(warnings[0]).not.toContain("Agents/uni");
    expect(warnings[0]).not.toContain("Threads/eng/uni");
  });

  test("protectedCount=2 keeps BOTH protected entries even when their COMBINED size alone exceeds the budget", () => {
    const self = { path: "self", content: "S".repeat(1000) };
    const threadContent = { path: "thread", content: "T".repeat(1000) };
    const warnings: string[] = [];
    const out = composeSystemPrompt([self, threadContent, { path: "n1", content: "x".repeat(50) }], {
      budgetBytes: 100, // smaller than even the protected prefix
      protectedCount: 2,
      onWarn: (m) => warnings.push(m),
    });
    // Both protected entries are preserved whole — the no-truncate-prefix guarantee outweighs the cap.
    expect(out).toBe(`# ${self.path}\n\n${self.content}\n\n---\n\n# ${threadContent.path}\n\n${threadContent.content}`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("n1");
  });

  test("the thread-content entry renders BETWEEN the def and the loadout (ordered prefix)", () => {
    const out = composeSystemPrompt(
      [
        { path: "Agents/uni", content: "def body" },
        { path: "Threads/eng/uni", content: "thread mandate" },
        { path: "Skills/Weave", content: "skill body" },
      ],
      { protectedCount: 2 },
    );
    expect(out).toBe(
      "# Agents/uni\n\ndef body" +
        "\n\n---\n\n# Threads/eng/uni\n\nthread mandate" +
        "\n\n---\n\n# Skills/Weave\n\nskill body",
    );
  });

  test("def ABSENT (Phase 2): protectedCount=2 over [role, thread-content, ...loadout] → roles+thread protected, only the loadout tail sheds", () => {
    // The shape the backend builds with an EMPTY def body + one role + thread content: NO self
    // entry, so protectedCount = roles(1) + def(0) + thread(1) = 2. The role (①) and the thread
    // content (②) lead; only the layer-③ loadout sheds. This is the def-absent alignment the
    // backend's `roleEntries.length + selfEntries.length + (hasThreadContent ? 1 : 0)` produces.
    const role = { path: "Roles/PM", content: "ROLE-" + "r".repeat(200) };
    const threadContent = { path: "Threads/eng/uni", content: "THREAD-" + "t".repeat(200) };
    const big = (p: string) => ({ path: p, content: p + "-" + "x".repeat(400) });
    const warnings: string[] = [];
    // Budget fits the two protected entries (role + thread) but not the loadout notes.
    const budget = 600;
    const out = composeSystemPrompt([role, threadContent, big("n1"), big("n2")], {
      budgetBytes: budget,
      protectedCount: 2,
      onWarn: (m) => warnings.push(m),
    });
    // Role first, then thread content — both survive whole, in order, with NO def entry between.
    expect(out).toBe(
      `# ${role.path}\n\n${role.content}\n\n---\n\n# ${threadContent.path}\n\n${threadContent.content}`,
    );
    // Only the layer-③ loadout tail was shed; the warn names neither the role nor the thread.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("n1");
    expect(warnings[0]).toContain("n2");
    expect(warnings[0]).not.toContain("Roles/PM");
    expect(warnings[0]).not.toContain("Threads/eng/uni");
  });

  test("protectedCount defaults to 1 — only the self entry is protected (the no-thread-content path)", () => {
    const self = { path: "self", content: "S".repeat(500) };
    const big = (p: string) => ({ path: p, content: p + "-" + "x".repeat(400) });
    const warnings: string[] = [];
    // No protectedCount → default 1. Over budget → only self survives; the loadout sheds.
    const out = composeSystemPrompt([self, big("n1"), big("n2")], {
      budgetBytes: 600,
      onWarn: (m) => warnings.push(m),
    });
    expect(out).toBe(`# ${self.path}\n\n${self.content}`);
    expect(warnings[0]).toContain("n1");
    expect(warnings[0]).toContain("n2");
  });
});
