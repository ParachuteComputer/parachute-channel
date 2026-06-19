import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The v2 agent SPA mounts at the agent module's proxied `/app` sub-path —
// reachable at `<hub>/agent/app/`. The hub reverse-proxies `<expose>/agent/*`
// to the loopback daemon with `stripPrefix:true`, so the daemon sees `/app/*`;
// asset URLs are origin-absolute and resolve under `/agent/app/assets/...` over
// the expose. We pick a NEW sub-path (`/app`) deliberately so this SPA coexists
// with the existing daemon-rendered HTML pages (`/agents`, `/home`, `/admin`,
// …) — the design's incremental migration: operators compare the two until the
// HTML pages retire in Phase 4.
//
// Override with `VITE_BASE_PATH=/` for stand-alone dev served at the origin root.
const basePath = normalizeBase(process.env.VITE_BASE_PATH ?? "/agent/app/");

function normalizeBase(input: string): string {
  let b = input.startsWith("/") ? input : `/${input}`;
  if (!b.endsWith("/")) b += "/";
  return b;
}

export default defineConfig({
  base: basePath,
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      // Dev server runs under `/agent/app/` to mirror the production mount. The
      // agent daemon serves the token mint at `<origin>/admin/agent-token` and
      // the JSON API at `/agent/api/*` (proxied) — but in a stand-alone daemon
      // (no hub) those live at `/admin/agent-token` + `/api/*`. Proxy both
      // shapes to the running daemon so the dev SPA hits real auth + data.
      "/admin/agent-token": {
        target: process.env.AGENT_ORIGIN ?? "http://127.0.0.1:1941",
        changeOrigin: true,
      },
      "/agent/api": {
        target: process.env.AGENT_ORIGIN ?? "http://127.0.0.1:1941",
        changeOrigin: true,
      },
      // The message SSE stream lives at `/agent/ui/events` (the human↔UI traffic
      // surface). Without this the live chat is deaf in stand-alone dev — proxy
      // `/agent/ui` to the same daemon as `/agent/api`. Dev-only.
      "/agent/ui": {
        target: process.env.AGENT_ORIGIN ?? "http://127.0.0.1:1941",
        changeOrigin: true,
      },
    },
  },
});
