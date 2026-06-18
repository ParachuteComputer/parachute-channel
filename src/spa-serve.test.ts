/**
 * Tests for the v2 agent SPA bundle serving (`src/spa-serve.ts`) — the daemon's
 * `/app` mount. Proves: a missing dist 503s with a build hint; the SPA shell is
 * served for the mount root + client-routed paths; real assets serve with the
 * right content-type; path traversal is blocked; the mount-path predicate is
 * exact.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  SPA_MOUNT,
  isSpaPath,
  serveSpa,
  spaContentType,
  spaDistDir,
} from "./spa-serve.ts";

describe("isSpaPath", () => {
  test("matches the mount root + sub-paths only", () => {
    expect(isSpaPath("/app")).toBe(true);
    expect(isSpaPath("/app/")).toBe(true);
    expect(isSpaPath("/app/agents")).toBe(true);
    expect(isSpaPath("/app/assets/index-abc.js")).toBe(true);
    // NOT the daemon-rendered HTML pages or other routes.
    expect(isSpaPath("/agents")).toBe(false);
    expect(isSpaPath("/apple")).toBe(false);
    expect(isSpaPath("/api/agents")).toBe(false);
    expect(isSpaPath("/")).toBe(false);
  });
});

describe("spaContentType", () => {
  test("maps the realistic Vite output extensions", () => {
    expect(spaContentType("/x/index.html")).toContain("text/html");
    expect(spaContentType("/x/index-abc.js")).toContain("javascript");
    expect(spaContentType("/x/index-abc.css")).toContain("css");
    expect(spaContentType("/x/logo.svg")).toBe("image/svg+xml");
    expect(spaContentType("/x/unknown.bin")).toBe("application/octet-stream");
  });
});

describe("spaDistDir", () => {
  test("anchors to <installDir>/web/ui/dist", () => {
    expect(spaDistDir("/opt/agent")).toBe("/opt/agent/web/ui/dist");
  });
});

describe("serveSpa — missing bundle", () => {
  test("503s with a build hint when dist/ is absent", async () => {
    const res = serveSpa("/nonexistent/dist", "/app/");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("run `bun run build`");
  });
});

describe("serveSpa — with a fixture bundle", () => {
  let dist: string;

  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), "agent-spa-test-"));
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
    writeFileSync(join(dist, "assets", "index-abc.js"), "console.log('spa')");
    writeFileSync(join(dist, "assets", "index-abc.css"), ".x{color:red}");
  });

  afterAll(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  test("serves the SPA shell at the mount root", async () => {
    const res = serveSpa(dist, SPA_MOUNT);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("id=root");
  });

  test("serves the SPA shell for a client-routed path (no extension)", async () => {
    const res = serveSpa(dist, "/app/agents");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("id=root");
  });

  test("serves a real JS asset with the right content-type", async () => {
    const res = serveSpa(dist, "/app/assets/index-abc.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("spa");
  });

  test("serves a real CSS asset", async () => {
    const res = serveSpa(dist, "/app/assets/index-abc.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("css");
  });

  test("an asset-shaped path that doesn't exist falls back to the SPA shell", async () => {
    const res = serveSpa(dist, "/app/assets/missing.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("blocks path traversal out of dist/", async () => {
    // A `..`-containing path never enters the asset branch → SPA shell (not the
    // escaped file). The 404 belt-and-braces guards the loosened case.
    const res = serveSpa(dist, "/app/../../etc/passwd");
    // Either the shell (traversal filtered) or a 404 — never the escaped file.
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });
});
