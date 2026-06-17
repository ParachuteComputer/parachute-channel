/**
 * Unit tests for the dual-accept scope helpers (channel→agent rename, back-compat
 * rule 1). `grantsScope` is the single chokepoint every scope gate routes through;
 * an isolated test locks the legacy-alias logic so a future edit can't silently
 * drop pre-rename `channel:*` acceptance (the class of bug the mcp-http write-gate
 * fix caught). Pure functions — no mocks, no JWKS.
 */
import { describe, test, expect } from "bun:test";
import { grantsScope, legacyScopeAlias } from "./auth.ts";

describe("legacyScopeAlias", () => {
  test("maps an agent:<verb> scope to its pre-rename channel:<verb> form", () => {
    expect(legacyScopeAlias("agent:read")).toBe("channel:read");
    expect(legacyScopeAlias("agent:write")).toBe("channel:write");
    expect(legacyScopeAlias("agent:send")).toBe("channel:send");
    expect(legacyScopeAlias("agent:admin")).toBe("channel:admin");
  });

  test("returns undefined for a scope with no agent: prefix (no legacy alias)", () => {
    expect(legacyScopeAlias("vault:read")).toBeUndefined();
    expect(legacyScopeAlias("channel:read")).toBeUndefined();
    expect(legacyScopeAlias("agentfoo")).toBeUndefined();
  });
});

describe("grantsScope — dual-accept (new agent:* OR legacy channel:*)", () => {
  test("grants when the new agent:<verb> scope is present", () => {
    expect(grantsScope(["agent:write"], "agent:write")).toBe(true);
  });

  test("grants when only the legacy channel:<verb> scope is present (pre-rename token)", () => {
    expect(grantsScope(["channel:write"], "agent:write")).toBe(true);
    expect(grantsScope(["channel:read", "channel:send"], "agent:send")).toBe(true);
  });

  test("denies when neither the new nor the legacy scope is present", () => {
    expect(grantsScope(["agent:read"], "agent:write")).toBe(false);
    expect(grantsScope(["vault:write"], "agent:write")).toBe(false);
    expect(grantsScope([], "agent:read")).toBe(false);
  });

  test("does NOT cross-grant a different verb via the alias", () => {
    // channel:read must not satisfy agent:write — the alias is per-verb only.
    expect(grantsScope(["channel:read"], "agent:write")).toBe(false);
  });
});
