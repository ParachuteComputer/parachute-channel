/**
 * Serve the vendored xterm.js assets SAME-ORIGIN (design §5; fixes the "xterm.js
 * failed to load — CDN blocked?" failure).
 *
 * The terminal page originally loaded xterm + the fit addon from a public CDN
 * (jsdelivr). That breaks whenever the operator's network or the hub's CSP blocks
 * the CDN — and an operator-only terminal that silently won't load is a
 * showstopper. So we vendor `@xterm/xterm` + `@xterm/addon-fit` as dependencies
 * and serve their dist files from the daemon at `/terminal/assets/<file>`: no
 * third-party origin, no CSP `script-src` widening (the bundle is `'self'`), works
 * offline / behind strict networks.
 *
 * The files are resolved from the installed packages (works under both the
 * bun-linked checkout and an npm install — they're real deps) and read+cached on
 * first request. Version-pinned in package.json, so the responses are immutable.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The asset routes the terminal page loads, mapped to package-relative files. */
interface AssetSpec {
  /** Package specifier whose dir anchors the file. */
  pkg: string;
  /** File path relative to the package root. */
  rel: string;
  /** Content-Type to serve. */
  type: string;
}

const ASSETS: Record<string, AssetSpec> = {
  "xterm.js": { pkg: "@xterm/xterm/package.json", rel: "lib/xterm.js", type: "text/javascript; charset=utf-8" },
  "xterm.css": { pkg: "@xterm/xterm/package.json", rel: "css/xterm.css", type: "text/css; charset=utf-8" },
  "addon-fit.js": { pkg: "@xterm/addon-fit/package.json", rel: "lib/addon-fit.js", type: "text/javascript; charset=utf-8" },
};

/** Cache of read file bodies (text — xterm js/css are all text), by asset name. */
const bodyCache = new Map<string, string>();

/** Resolve an asset's absolute path from its package root (works linked + installed). */
function assetPath(spec: AssetSpec): string {
  // Bun.resolveSync resolves the package's own package.json (always exported), and
  // we join the known dist-relative path — robust to packages whose `exports` map
  // doesn't expose deep subpaths directly.
  const pkgRoot = dirname(Bun.resolveSync(spec.pkg, import.meta.dir));
  return join(pkgRoot, spec.rel);
}

/**
 * Serve a terminal asset by name (the segment after `/terminal/assets/`), or
 * null if the name isn't a known asset (caller 404s). Read-once + cached;
 * immutable cache headers since the version is pinned.
 */
export function serveTerminalAsset(name: string): Response | null {
  const spec = ASSETS[name];
  if (!spec) return null;
  let body = bodyCache.get(name);
  if (body === undefined) {
    try {
      body = readFileSync(assetPath(spec), "utf8");
    } catch (err) {
      return new Response(
        `/* terminal asset "${name}" unavailable: ${(err as Error).message} */`,
        { status: 500, headers: { "content-type": spec.type } },
      );
    }
    bodyCache.set(name, body);
  }
  return new Response(body, {
    headers: {
      "content-type": spec.type,
      // Version-pinned in package.json → safe to cache hard.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

/** The known asset names (for routing/tests). */
export const TERMINAL_ASSET_NAMES = Object.keys(ASSETS);
