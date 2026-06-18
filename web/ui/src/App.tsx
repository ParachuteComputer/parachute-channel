/**
 * Parachute Agent SPA (v2).
 *
 * The one agent-centric surface the Agent UI v2 design calls for
 * (`design/2026-06-18-agent-ui-v2-and-reactivity.md`, Part 2). This is Phase 2:
 * the SPA shell + a unified, READ-ONLY Agents view. It mounts at the agent
 * module's NEW `/app` sub-path (reachable at `<hub>/agent/app/`) so it coexists
 * with the existing daemon-rendered HTML pages — operators compare the two
 * during the incremental migration; the HTML retires in Phase 4.
 *
 * Home IS the Agents list (the design's "Home becomes the Agents list"). Later
 * phases add the unified create flow (Phase 3) and the def-vault editor +
 * schedules fold-in (Phase 4); this shell leaves room for those nav entries.
 *
 * Auth: the SPA loads OPEN, then mints a hub `agent:admin` Bearer from
 * `<origin>/admin/agent-token` (the operator's hub session cookie) — see
 * `lib/auth.ts`. All `/agent/api/*` calls carry that Bearer.
 */
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { Agents } from "./routes/Agents.tsx";

const WORDMARK = "Parachute Agent";

// Single view today (the Agents list). When create/config views land (Phase 3-4),
// derive the subtitle from the route then.
const SUBTITLE = "agents";

export function App() {
  const subtitle = SUBTITLE;

  return (
    <div className="page">
      <nav className="nav">
        <Link to="/" className="brand">
          <span className="brand-wordmark">{WORDMARK}</span>
          <span className="sub">{subtitle}</span>
        </Link>
        <NavSection to="/" label="Agents" exact />
        {/* Boundary: everything past here is the older daemon-rendered HTML,
            kept mounted during the migration so the operator can compare. */}
        <span className="nav-divider" aria-hidden="true" />
        <a href="/agent/agents" title="The legacy create/list HTML page">
          Classic UI
        </a>
      </nav>

      <Routes>
        {/* Home is the Agents list (design: "Home becomes the Agents list"). */}
        <Route path="/" element={<Agents />} />
        <Route path="/agents" element={<Agents />} />
        <Route
          path="*"
          element={
            <div className="empty">
              404 — back to <Link to="/">Agents</Link>.
            </div>
          }
        />
      </Routes>
    </div>
  );
}

function NavSection({ to, label, exact }: { to: string; label: string; exact?: boolean }) {
  const { pathname } = useLocation();
  const active = exact
    ? pathname === to || pathname === "/agents"
    : pathname === to || pathname.startsWith(`${to}/`);
  return (
    <Link
      to={to}
      className={active ? "nav-link nav-link-active" : "nav-link"}
      aria-current={active ? "page" : undefined}
    >
      {label}
    </Link>
  );
}
