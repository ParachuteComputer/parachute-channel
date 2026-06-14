import { describe, test, expect } from "bun:test";
import {
  ANTHROPIC_EGRESS_HOSTS,
  baseEgressAllowlist,
  composeEgressAllowlist,
  hostFromOrigin,
  type EgressBaseInput,
} from "./egress.ts";

const BASE: EgressBaseInput = { hubOrigin: "https://hub.example.com" };

describe("hostFromOrigin", () => {
  test("reduces an origin to its hostname (strips scheme + port + path)", () => {
    expect(hostFromOrigin("https://hub.example.com:1939/admin")).toBe("hub.example.com");
  });
  test("passes a bare host through", () => {
    expect(hostFromOrigin("registry.npmjs.org")).toBe("registry.npmjs.org");
  });
  test("strips a :port from a bare host:port", () => {
    expect(hostFromOrigin("127.0.0.1:1939")).toBe("127.0.0.1");
  });
  test("preserves loopback (a co-located dev hub is loopback)", () => {
    expect(hostFromOrigin("http://127.0.0.1:1939")).toBe("127.0.0.1");
  });
  test("returns null for empty / nullish input", () => {
    expect(hostFromOrigin("")).toBeNull();
    expect(hostFromOrigin(undefined)).toBeNull();
    expect(hostFromOrigin("   ")).toBeNull();
  });
});

describe("baseEgressAllowlist — the non-removable base", () => {
  test("always includes the Anthropic hosts + the hub host", () => {
    const base = baseEgressAllowlist(BASE);
    for (const h of ANTHROPIC_EGRESS_HOSTS) expect(base).toContain(h);
    expect(base).toContain("hub.example.com");
  });

  test("includes a distinct vault host when given", () => {
    const base = baseEgressAllowlist({ ...BASE, vaultOrigin: "https://vault.example.com" });
    expect(base).toContain("vault.example.com");
  });

  test("dedupes a vault origin equal to the hub origin", () => {
    const base = baseEgressAllowlist({
      hubOrigin: "https://h.example.com",
      vaultOrigin: "https://h.example.com",
    });
    expect(base.filter((h) => h === "h.example.com")).toHaveLength(1);
  });
});

describe("composeEgressAllowlist — base floor is non-removable, spec is additive", () => {
  test("an empty spec egress still gets the full base (weaver-style arm)", () => {
    const allow = composeEgressAllowlist(BASE, []);
    for (const h of ANTHROPIC_EGRESS_HOSTS) expect(allow).toContain(h);
    expect(allow).toContain("hub.example.com");
  });

  test("an undefined spec egress still gets the full base", () => {
    const allow = composeEgressAllowlist(BASE, undefined);
    expect(allow).toContain("api.anthropic.com");
    expect(allow).toContain("hub.example.com");
  });

  test("spec hosts are ADDED on top of the base", () => {
    const allow = composeEgressAllowlist(BASE, ["registry.npmjs.org", "pypi.org"]);
    // base present...
    expect(allow).toContain("api.anthropic.com");
    expect(allow).toContain("hub.example.com");
    // ...plus the additions
    expect(allow).toContain("registry.npmjs.org");
    expect(allow).toContain("pypi.org");
  });

  test("SECURITY: a spec that lists ONLY a foreign host CANNOT drop the base — the base is still present", () => {
    // A spec authored to omit the base entirely (the malicious-omit case).
    const allow = composeEgressAllowlist(BASE, ["evil.example.com"]);
    // The base floor survives regardless of what the spec listed.
    expect(allow).toContain("api.anthropic.com");
    expect(allow).toContain("hub.example.com");
    // The spec's own host is added (additive), not a replacement.
    expect(allow).toContain("evil.example.com");
  });

  test("SECURITY: a spec cannot REPLACE the Anthropic host with a look-alike — both end up present, base is not dropped", () => {
    // A spec that tries to "override" the Anthropic host by re-declaring a near-miss.
    const allow = composeEgressAllowlist(BASE, ["api.anthropic.com.evil.example.com"]);
    // The real Anthropic apex is still on the list (the base recomputed from code).
    expect(allow).toContain("api.anthropic.com");
    // The look-alike is just an additional (separate) host, not a substitution.
    expect(allow).toContain("api.anthropic.com.evil.example.com");
    // And the look-alike did not evict the real host.
    expect(allow.indexOf("api.anthropic.com")).toBeGreaterThanOrEqual(0);
  });

  test("the base always sorts FIRST (recomputed from code, prepended)", () => {
    const allow = composeEgressAllowlist(BASE, ["z-late.example.com"]);
    expect(allow[0]).toBe("api.anthropic.com");
    expect(allow[allow.length - 1]).toBe("z-late.example.com");
  });

  test("spec origins are normalized to hosts (full URL and bare host land the same)", () => {
    const a = composeEgressAllowlist(BASE, ["https://registry.npmjs.org"]);
    const b = composeEgressAllowlist(BASE, ["registry.npmjs.org"]);
    expect(a).toEqual(b);
  });

  test("dedupes a spec host that duplicates a base host", () => {
    const allow = composeEgressAllowlist(BASE, ["hub.example.com"]);
    expect(allow.filter((h) => h === "hub.example.com")).toHaveLength(1);
  });
});
