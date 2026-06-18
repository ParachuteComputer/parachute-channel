// Regression check mirroring the hub's verify-base: the canonical-mount default
// build must produce asset URLs prefixed with `/agent/app/`. If
// `vite.config.ts`'s `base` ever drifts back to `/` or to a different mount, the
// bundle HTML loses the right prefix and assets 404 under the SPA mount — the
// same silent failure the hub/paraclaw mount-path convention codifies.
//
// Skipped when VITE_BASE_PATH is set explicitly (legitimate override).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const override = process.env.VITE_BASE_PATH;
if (override && override !== "/agent/app/") {
  console.log(`verify-base: VITE_BASE_PATH=${override} (override) — skipping default-mount check.`);
  process.exit(0);
}

const html = readFileSync(resolve("dist/index.html"), "utf8");
const wantPrefix = "/agent/app/assets/";
const hasMounted = html.includes(`src="${wantPrefix}`) || html.includes(`href="${wantPrefix}`);
if (!hasMounted) {
  console.error(
    "x verify-base: dist/index.html is missing /agent/app/-prefixed asset URLs.\n" +
      "  This means vite's `base` resolved to something other than `/agent/app/`.\n" +
      "  Check web/ui/vite.config.ts (default should be `/agent/app/`) and any\n" +
      "  VITE_BASE_PATH env var leaking into the build environment.",
  );
  process.exit(1);
}
console.log("verify-base: ok — dist/index.html references /agent/app/-prefixed assets.");
