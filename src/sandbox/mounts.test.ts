import { describe, test, expect } from "bun:test";
import {
  composeFilesystemView,
  homeTreeDenyRoot,
  sharedMounts,
} from "./mounts.ts";
import type { AgentMount, BaseBinds } from "./types.ts";

const BASE: BaseBinds = {
  workspace: "/state/sessions/arm",
  runtimeReadOnly: ["/home/op/.claude"],
};

describe("homeTreeDenyRoot — platform nuance", () => {
  test("macOS denies /Users", () => {
    expect(homeTreeDenyRoot("darwin")).toBe("/Users");
  });
  test("Linux denies /home", () => {
    expect(homeTreeDenyRoot("linux")).toBe("/home");
  });
});

describe("composeFilesystemView — scoped reads + write confinement", () => {
  test("with no mounts: reads = workspace + runtime, writes = workspace only", () => {
    const fs = composeFilesystemView(BASE, undefined, "darwin");
    expect(fs.allowRead).toContain("/state/sessions/arm");
    expect(fs.allowRead).toContain("/home/op/.claude");
    expect(fs.allowWrite).toEqual(["/state/sessions/arm"]);
  });

  test("the home tree is denied for reads (scoped-read policy, §4.5)", () => {
    const fs = composeFilesystemView(BASE, undefined, "darwin");
    expect(fs.denyRead).toContain("/Users");
  });

  test("the home tree denied is platform-correct on Linux", () => {
    const fs = composeFilesystemView(BASE, undefined, "linux");
    expect(fs.denyRead).toContain("/home");
  });

  test("an ro mount is readable but NOT writable", () => {
    const mounts: AgentMount[] = [{ hostPath: "/refs/tree", mountPath: "/ref", mode: "ro" }];
    const fs = composeFilesystemView(BASE, mounts, "darwin");
    expect(fs.allowRead).toContain("/refs/tree");
    expect(fs.allowWrite).not.toContain("/refs/tree");
  });

  test("an rw mount is BOTH readable and writable", () => {
    const mounts: AgentMount[] = [{ hostPath: "/proj/foo", mountPath: "/work/foo", mode: "rw" }];
    const fs = composeFilesystemView(BASE, mounts, "darwin");
    expect(fs.allowRead).toContain("/proj/foo");
    expect(fs.allowWrite).toContain("/proj/foo");
  });

  test("SECURITY: a path OUTSIDE all binds is not in the read surface (scoped, not broad)", () => {
    const mounts: AgentMount[] = [{ hostPath: "/proj/foo", mountPath: "/work/foo", mode: "rw" }];
    const fs = composeFilesystemView(BASE, mounts, "darwin");
    // The operator's SSH dir / other vaults are NOT re-allowed within the denied home tree.
    expect(fs.allowRead).not.toContain("/Users/op/.ssh");
    expect(fs.allowRead).not.toContain("/Users/op/other-vault");
    // And nothing widened the deny away.
    expect(fs.denyRead).toEqual(["/Users"]);
  });

  test("SECURITY: writes are confined — only workspace + rw mounts, never an ro mount or arbitrary path", () => {
    const mounts: AgentMount[] = [
      { hostPath: "/refs/tree", mountPath: "/ref", mode: "ro" },
      { hostPath: "/proj/foo", mountPath: "/work/foo", mode: "rw" },
    ];
    const fs = composeFilesystemView(BASE, mounts, "darwin");
    expect(new Set(fs.allowWrite)).toEqual(new Set(["/state/sessions/arm", "/proj/foo"]));
  });

  test("the base binds are always present even if the spec declares none", () => {
    const fs = composeFilesystemView(BASE, [], "linux");
    expect(fs.allowRead).toContain("/state/sessions/arm");
    expect(fs.allowRead).toContain("/home/op/.claude");
    expect(fs.allowWrite).toContain("/state/sessions/arm");
  });

  test("dedupes a mount equal to the workspace", () => {
    const mounts: AgentMount[] = [
      { hostPath: "/state/sessions/arm", mountPath: "/work", mode: "rw" },
    ];
    const fs = composeFilesystemView(BASE, mounts, "darwin");
    expect(fs.allowWrite.filter((p) => p === "/state/sessions/arm")).toHaveLength(1);
  });
});

describe("sharedMounts — the named cross-session relaxation", () => {
  test("surfaces only mounts carrying a non-empty `shared` tag", () => {
    const mounts: AgentMount[] = [
      { hostPath: "/a", mountPath: "/a", mode: "ro" },
      { hostPath: "/cache", mountPath: "/cache", mode: "ro", shared: "build-cache" },
      { hostPath: "/b", mountPath: "/b", mode: "rw", shared: "" },
    ];
    const shared = sharedMounts(mounts);
    expect(shared).toHaveLength(1);
    expect(shared[0]!.shared).toBe("build-cache");
  });

  test("a shared mount is still bound like any other (honored in the fs view)", () => {
    const mounts: AgentMount[] = [
      { hostPath: "/cache", mountPath: "/cache", mode: "ro", shared: "build-cache" },
    ];
    const fs = composeFilesystemView(BASE, mounts, "darwin");
    expect(fs.allowRead).toContain("/cache");
  });

  test("empty input → no shared mounts", () => {
    expect(sharedMounts(undefined)).toEqual([]);
  });
});
