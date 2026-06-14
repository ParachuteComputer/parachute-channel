import { describe, test, expect } from "bun:test";
import { parseArgs, ArgError } from "../scripts/spawn-agent.ts";
import type { AgentChannelSpec } from "./sandbox/types.ts";

// These tests exercise ONLY the pure arg-parser (`parseArgs`) — no fs/tmux/mint
// side effect. The real-dep wiring (operator token, hub mint, sandbox, tmux) is
// covered by spawn-agent.test.ts against stubs; here we assert flags → the right
// AgentSpec, the --help short-circuit, and that bad args reject.

describe("parseArgs — name + channels + vault + egress + mounts → the right AgentSpec", () => {
  test("a full invocation builds the complete spec", () => {
    const { help, spec } = parseArgs([
      "aaron-dev",
      "--channel",
      "aaron-dev",
      "--channel",
      "ops:read",
      "--vault",
      "default:read:#channel-message,#decision",
      "--egress",
      "registry.npmjs.org,github.com",
      "--mount",
      "/host/code:/work/code:ro",
      "--mount",
      "/host/cache:/work/cache:rw:shared-cache",
    ]);
    expect(help).toBe(false);
    expect(spec).toBeDefined();
    expect(spec!.name).toBe("aaron-dev");

    // Channels: first is the wake channel (write by default); second scoped read.
    expect(spec!.channels).toEqual([
      { name: "aaron-dev" },
      { name: "ops", access: "read" },
    ] as AgentChannelSpec[]);

    // Vault: name + access + tag-scope.
    expect(spec!.vault).toEqual({
      name: "default",
      access: "read",
      tags: ["#channel-message", "#decision"],
    });

    // Egress: additive host list, comma-split.
    expect(spec!.egress).toEqual(["registry.npmjs.org", "github.com"]);

    // Mounts: ro + rw-with-shared.
    expect(spec!.mounts).toEqual([
      { hostPath: "/host/code", mountPath: "/work/code", mode: "ro" },
      { hostPath: "/host/cache", mountPath: "/work/cache", mode: "rw", shared: "shared-cache" },
    ]);
  });

  test("a bare --channel defaults to write (back-compat resident session)", () => {
    const { spec } = parseArgs(["a", "--channel", "c"]);
    expect(spec!.channels).toEqual([{ name: "c" }]);
  });

  test("--channel <name>:write is explicit write", () => {
    const { spec } = parseArgs(["a", "--channel", "c:write"]);
    expect(spec!.channels).toEqual([{ name: "c", access: "write" }]);
  });

  test("a minimal invocation (name + one channel) omits optional fields", () => {
    const { spec } = parseArgs(["solo", "--channel", "solo"]);
    expect(spec).toEqual({ name: "solo", channels: [{ name: "solo" }] });
    expect(spec!.vault).toBeUndefined();
    expect(spec!.egress).toBeUndefined();
    expect(spec!.mounts).toBeUndefined();
  });

  test("--vault without a tag list omits tags", () => {
    const { spec } = parseArgs(["a", "--channel", "c", "--vault", "default:write"]);
    expect(spec!.vault).toEqual({ name: "default", access: "write" });
  });

  test("the FIRST channel is the wake channel (order preserved)", () => {
    const { spec } = parseArgs(["a", "--channel", "first", "--channel", "second"]);
    expect(spec!.channels[0]).toEqual({ name: "first" });
    expect(spec!.channels[1]).toEqual({ name: "second" });
  });

  test("--egress-all sets egressUnrestricted and overrides --egress", () => {
    const { spec } = parseArgs(["a", "--channel", "c", "--egress", "x.com", "--egress-all"]);
    expect(spec!.egressUnrestricted).toBe(true);
    expect(spec!.egress).toBeUndefined(); // allow-all is strictly broader
  });
});

describe("parseArgs — --help short-circuits", () => {
  test("--help returns help:true and builds no spec", () => {
    const r = parseArgs(["--help"]);
    expect(r.help).toBe(true);
    expect(r.spec).toBeUndefined();
  });

  test("-h is the short alias", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  test("--help wins even with other args present", () => {
    const r = parseArgs(["name", "--channel", "c", "--help"]);
    expect(r.help).toBe(true);
    expect(r.spec).toBeUndefined();
  });
});

describe("parseArgs — bad args reject", () => {
  test("missing name", () => {
    expect(() => parseArgs(["--channel", "c"])).toThrow(ArgError);
    expect(() => parseArgs(["--channel", "c"])).toThrow(/missing required <name>/);
  });

  test("no channels", () => {
    expect(() => parseArgs(["just-a-name"])).toThrow(/at least one --channel/);
  });

  test("a second positional is rejected", () => {
    expect(() => parseArgs(["a", "b", "--channel", "c"])).toThrow(/only one <name>/);
  });

  test("an unknown flag is rejected", () => {
    expect(() => parseArgs(["a", "--channel", "c", "--bogus"])).toThrow(/unknown flag "--bogus"/);
  });

  test("a flag with a missing value is rejected", () => {
    expect(() => parseArgs(["a", "--channel"])).toThrow(/--channel: expected a value/);
    // A following flag is NOT consumed as the value.
    expect(() => parseArgs(["a", "--channel", "--vault"])).toThrow(/--channel: expected a value/);
  });

  test("a bad channel access verb is rejected", () => {
    expect(() => parseArgs(["a", "--channel", "c:admin"])).toThrow(/access must be "read" or "write"/);
  });

  test("an over-segmented channel is rejected", () => {
    expect(() => parseArgs(["a", "--channel", "c:read:extra"])).toThrow(/extra ":"/);
  });

  test("a bad vault shape is rejected", () => {
    expect(() => parseArgs(["a", "--channel", "c", "--vault", "default"])).toThrow(
      /expected <name>:<read\|write>/,
    );
    expect(() => parseArgs(["a", "--channel", "c", "--vault", "default:admin"])).toThrow(
      /access must be "read" or "write"/,
    );
  });

  test("--vault given twice is rejected", () => {
    expect(() =>
      parseArgs(["a", "--channel", "c", "--vault", "default:read", "--vault", "other:write"]),
    ).toThrow(/--vault may only be given once/);
  });

  test("a bad mount shape is rejected", () => {
    expect(() => parseArgs(["a", "--channel", "c", "--mount", "/h:/m"])).toThrow(
      /expected <hostPath:mountPath:ro\|rw/,
    );
    expect(() => parseArgs(["a", "--channel", "c", "--mount", "/h:/m:rx"])).toThrow(
      /mode must be "ro" or "rw"/,
    );
  });

  test("an empty egress list parses to no egress (not an error)", () => {
    const { spec } = parseArgs(["a", "--channel", "c", "--egress", ""]);
    expect(spec!.egress).toBeUndefined();
  });
});
