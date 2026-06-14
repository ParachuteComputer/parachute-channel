/**
 * Tests for same-origin terminal asset serving (`src/terminal-assets.ts`) — the
 * fix for "xterm.js failed to load (CDN blocked?)". Proves the vendored xterm JS +
 * CSS resolve from the installed packages and serve with the right content-type,
 * and that an unknown asset name is a clean miss (the daemon 404s it).
 */

import { describe, test, expect } from "bun:test";
import { serveTerminalAsset, TERMINAL_ASSET_NAMES } from "./terminal-assets.ts";

describe("serveTerminalAsset", () => {
  test("serves xterm.js as JavaScript with a real body", async () => {
    const res = serveTerminalAsset("xterm.js");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("javascript");
    const body = await res!.text();
    // The UMD bundle defines the Terminal global — a non-trivial body proves the
    // file resolved from the package (not an empty/placeholder response).
    expect(body.length).toBeGreaterThan(1000);
    expect(body).toContain("Terminal");
  });

  test("serves xterm.css as CSS", async () => {
    const res = serveTerminalAsset("xterm.css");
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("css");
    expect((await res!.text()).length).toBeGreaterThan(100);
  });

  test("serves addon-fit.js", async () => {
    const res = serveTerminalAsset("addon-fit.js");
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("javascript");
  });

  test("sets an immutable cache header (version-pinned)", () => {
    const res = serveTerminalAsset("xterm.js");
    expect(res!.headers.get("cache-control")).toContain("immutable");
  });

  test("an unknown asset name → null (caller 404s)", () => {
    expect(serveTerminalAsset("evil.js")).toBeNull();
    expect(serveTerminalAsset("../../etc/passwd")).toBeNull();
  });

  test("the known names are the three xterm assets", () => {
    expect(TERMINAL_ASSET_NAMES.sort()).toEqual(["addon-fit.js", "xterm.css", "xterm.js"]);
  });
});
