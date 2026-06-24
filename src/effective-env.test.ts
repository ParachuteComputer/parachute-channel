/**
 * Unit tests for the PURE effective-env composition (effective-env.ts) — the
 * precedence/overridden logic + the no-material grant-name derivation, isolated from
 * the daemon route + any I/O. (The route integration lives in daemon-agent-env-api.test.ts.)
 */
import { describe, test, expect } from "bun:test";
import {
  approvedGrantEnvNames,
  composeEffectiveEnv,
  resolveEffectiveEnv,
} from "./effective-env.ts";

describe("approvedGrantEnvNames — names only, approved-service grants only, NO material", () => {
  test("maps an approved service grant to its env-var name via serviceEnvVar", () => {
    const out = approvedGrantEnvNames([{ kind: "service", target: "github", status: "approved" }]);
    expect(out).toEqual([{ name: "GITHUB_TOKEN", source: "grant:github" }]);
  });

  test("a non-default service maps to <TARGET>_TOKEN", () => {
    const out = approvedGrantEnvNames([{ kind: "service", target: "fireflies", status: "approved" }]);
    expect(out).toEqual([{ name: "FIREFLIES_TOKEN", source: "grant:fireflies" }]);
  });

  test("ignores pending grants, vault grants, and mcp grants (none inject an env var)", () => {
    const out = approvedGrantEnvNames([
      { kind: "service", target: "github", status: "pending" }, // not approved
      { kind: "vault", target: "research", status: "approved" }, // vault → MCP, not env
      { kind: "mcp", target: "https://x/mcp", status: "approved" }, // remote MCP, not env
      { kind: "service", target: "cloudflare", status: "approved" }, // the only env one
    ]);
    expect(out).toEqual([{ name: "CLOUDFLARE_API_TOKEN", source: "grant:cloudflare" }]);
  });

  test("undefined connections → empty", () => {
    expect(approvedGrantEnvNames(undefined)).toEqual([]);
  });
});

describe("composeEffectiveEnv — precedence channel > default > grant + overridden marking", () => {
  const channelEnv = {
    default: ["DEFAULT_VAR", "GITHUB_TOKEN"],
    channels: { "uni-dev": ["CHANNEL_VAR", "GITHUB_TOKEN"] },
  };
  const connections = [{ kind: "service", target: "github", status: "approved" }];

  test("a name set in all three layers → channel wins, default + grant marked overridden", () => {
    const out = composeEffectiveEnv("uni-dev", channelEnv, connections);
    const gh = out.filter((e) => e.name === "GITHUB_TOKEN");
    expect(gh).toHaveLength(3);
    const winner = gh.find((e) => !e.overridden)!;
    expect(winner.source).toBe("channel");
    expect(gh.filter((e) => e.overridden).map((e) => e.source).sort()).toEqual(["default", "grant:github"]);
  });

  test("single-layer names carry no overridden flag", () => {
    const out = composeEffectiveEnv("uni-dev", channelEnv, connections);
    expect(out.find((e) => e.name === "DEFAULT_VAR")).toEqual({ name: "DEFAULT_VAR", source: "default" });
    expect(out.find((e) => e.name === "CHANNEL_VAR")).toEqual({ name: "CHANNEL_VAR", source: "channel" });
  });

  test("default beats grant when no channel override exists", () => {
    const out = composeEffectiveEnv(
      "uni-dev",
      { default: ["GITHUB_TOKEN"], channels: {} },
      connections,
    );
    const gh = out.filter((e) => e.name === "GITHUB_TOKEN");
    expect(gh.find((e) => !e.overridden)!.source).toBe("default");
    expect(gh.find((e) => e.overridden)!.source).toBe("grant:github");
  });

  test("an agent with no env-store entries + no connections → empty", () => {
    expect(composeEffectiveEnv("nobody", { default: [], channels: {} }, undefined)).toEqual([]);
  });

  test("only the matching agent's channel layer is used (another agent's overrides are ignored)", () => {
    const out = composeEffectiveEnv(
      "uni-dev",
      { default: [], channels: { other: ["OTHER_VAR"], "uni-dev": ["MINE"] } },
      undefined,
    );
    expect(out.map((e) => e.name)).toEqual(["MINE"]);
  });
});

describe("resolveEffectiveEnv — degraded note when no def, never returns values", () => {
  test("hasDef:false → attaches a note + still returns env layers", () => {
    const res = resolveEffectiveEnv("uni-dev", {
      describeEnv: () => ({ default: ["DEFAULT_VAR"], channels: { "uni-dev": ["CHANNEL_VAR"] } }),
      hasDef: false,
    });
    expect(res.note).toBeDefined();
    expect(res.env.map((e) => e.name).sort()).toEqual(["CHANNEL_VAR", "DEFAULT_VAR"]);
  });

  test("hasDef:true → no note", () => {
    const res = resolveEffectiveEnv("uni-dev", {
      describeEnv: () => ({ default: [], channels: {} }),
      connections: [{ kind: "service", target: "github", status: "approved" }],
      hasDef: true,
    });
    expect(res.note).toBeUndefined();
    expect(res.env).toEqual([{ name: "GITHUB_TOKEN", source: "grant:github" }]);
  });

  test("the shape carries NO `value` field on any entry", () => {
    const res = resolveEffectiveEnv("uni-dev", {
      describeEnv: () => ({ default: ["A"], channels: { "uni-dev": ["B"] } }),
      connections: [{ kind: "service", target: "github", status: "approved" }],
      hasDef: true,
    });
    for (const e of res.env) expect(Object.keys(e).sort()).not.toContain("value");
  });
});
