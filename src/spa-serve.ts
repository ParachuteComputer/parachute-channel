/**
 * Serve the built v2 agent SPA bundle (`web/ui/dist/`) at the daemon's `/app`
 * mount — reachable at `<hub>/agent/app/` over the hub proxy (the hub strips the
 * `/agent` prefix, so the daemon sees `/app/*`).
 *
 * This is ADDITIVE: it sits alongside the existing daemon-rendered HTML pages
 * (`/agents`, `/home`, `/admin`, `/jobs`, `/terminal`, `/ui`), which stay mounted
 * untouched. The design's incremental migration — operators compare the SPA with
 * the HTML until the HTML retires in a later phase.
 *
 * Mirrors the hub's `serveSpa` (parachute-hub/src/hub-server.ts): asset URLs are
 * origin-absolute (`/agent/app/assets/...`) per the Vite `base`, so the HTML
 * loads correctly under the proxied mount; any non-asset path falls back to the
 * SPA shell (react-router takes it from there). A missing `dist/` → 503 with a
 * "run build" hint (the dev-checkout case).
 */
import { existsSync } from "fs";
import { join, resolve } from "path";

/** The SPA mount the daemon serves the bundle under (post-stripPrefix). */
export const SPA_MOUNT = "/app";

/**
 * Resolve the SPA bundle dir from the install root. Anchored to the package so a
 * `bun src/daemon.ts` from any cwd finds `<repo>/web/ui/dist/`.
 */
export function spaDistDir(installDir: string): string {
  return join(installDir, "web", "ui", "dist");
}

/**
 * True when `pathname` falls under the SPA mount (`/app`, `/app/`, `/app/...`).
 * Asset requests (`/app/assets/...`) match too — they're served from `dist/`.
 */
export function isSpaPath(pathname: string): boolean {
  return pathname === SPA_MOUNT || pathname.startsWith(`${SPA_MOUNT}/`);
}

/**
 * Pick a content type for the static assets Vite produces. Mismatches show up
 * loud (a `.js` served as `text/html` is unmistakable); the list is trivially
 * extensible.
 */
export function spaContentType(pathname: string): string {
  const ext = pathname.slice(pathname.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "html":
      return "text/html; charset=utf-8";
    case "js":
    case "mjs":
      return "application/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "ico":
      return "image/x-icon";
    case "woff2":
      return "font/woff2";
    case "woff":
      return "font/woff";
    case "json":
    case "map":
      return "application/json";
    case "txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/**
 * Serve a single file under the SPA mount, falling back to `index.html` for
 * client-side-routed paths (anything that doesn't resolve to a real file under
 * `dist/`). Path traversal is blocked twice: the asset-shape filter rejects
 * sub-paths containing "..", and the resolved absolute path is checked to start
 * with `dist/` before any read.
 */
export function serveSpa(distDir: string, pathname: string): Response {
  if (!existsSync(distDir)) {
    return new Response(
      "agent SPA bundle not found — run `bun run build` in web/ui/ to produce dist/",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  // Strip the mount prefix: "/app" → "", "/app/" → "/", "/app/x" → "/x".
  const sub = pathname === SPA_MOUNT ? "" : pathname.slice(SPA_MOUNT.length);
  const indexPath = join(distDir, "index.html");

  // Empty / mount-root / any non-asset request → the SPA shell. First defense
  // against traversal: bare paths and anything containing ".." never enter the
  // asset branch.
  const looksLikeAsset = sub.length > 0 && /\.[a-z0-9]+$/i.test(sub) && !sub.includes("..");
  if (!looksLikeAsset) {
    return new Response(Bun.file(indexPath), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const filePath = resolve(distDir, `.${sub}`);
  // Second defense: refuse any resolved path that escapes dist/.
  if (!filePath.startsWith(`${distDir}/`)) {
    return new Response("not found", { status: 404 });
  }
  if (!existsSync(filePath)) {
    // Asset request that doesn't resolve to a real file → the SPA shell.
    return new Response(Bun.file(indexPath), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response(Bun.file(filePath), {
    headers: { "content-type": spaContentType(filePath) },
  });
}
