/**
 * Mount-aware react-router basename detection, extracted from `main.tsx` so it's
 * importable in tests without triggering `main.tsx`'s `createRoot().render()`
 * side effect.
 *
 * The v2 agent SPA serves at the agent module's `/app` sub-path, reachable three
 * ways:
 *
 *   - `<hub>/agent/app/…`  (the real, hub-proxied operator path)
 *   - `<daemon>/app/…`     (daemon-direct, no hub — e.g. local 1941)
 *   - `/…`                 (stand-alone dev, VITE_BASE_PATH=/)
 *
 * react-router needs the *runtime* basename so `<Link to="/agents">` resolves to
 * the right absolute path; without it the SPA would navigate to `/agents` at the
 * origin root and 404. We detect the longest matching prefix.
 */
export function detectBasename(pathname: string): string {
  if (pathname === "/agent/app" || pathname.startsWith("/agent/app/")) return "/agent/app";
  if (pathname === "/app" || pathname.startsWith("/app/")) return "/app";
  // Stand-alone dev served at origin root (VITE_BASE_PATH=/).
  return "";
}
