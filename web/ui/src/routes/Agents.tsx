/**
 * `/agents` — the unified, READ-ONLY Agents view (Agent UI v2, Phase 2).
 *
 * The one agent-centric surface the v2 design calls for: a single list of
 * EVERY agent across ALL backends (interactive / programmatic / channel) with a
 * detail panel, plus a read-only "Def-vaults" section showing which vaults the
 * module reads `#agent/definition` notes from.
 *
 * This phase is strictly read-only — no create flow (Phase 3) and no def-vault
 * editor (Phase 4). It composes the three Phase-1 list endpoints:
 *
 *   - `GET /agent/api/agents`       → the live agents (all backends merged)
 *   - `GET /agent/api/agent-defs`   → the vault-native defs (system-prompt
 *                                     preview, wants, status) the detail panel
 *                                     enriches a row with
 *   - `GET /agent/api/agent-vaults` → the def-vault list (read-only display)
 *
 * The "all-backends merge" is the load-bearing v2 move (#102): the list shows
 * channel/programmatic/interactive agents in one table instead of separate
 * pages. We dedupe defs that have no corresponding live agent so a def authored
 * but not yet instantiated still appears (as a def-only row), giving the
 * operator the full picture.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  type AgentDefRow,
  type AgentRow,
  type AgentVaultRow,
  HttpError,
  listAgentDefs,
  listAgentVaults,
  listAgents,
} from "../lib/api.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; agents: AgentRow[]; defs: AgentDefRow[]; vaults: AgentVaultRow[] };

/**
 * A merged view-model row. Every live agent is one row; a def with no matching
 * live agent surfaces as a def-only row (it's been authored but isn't running).
 * Keyed by name (an agent's name == its def name == its wake channel in the v2
 * 1:1 model).
 */
export interface MergedAgent {
  name: string;
  backend: string;
  channel?: string;
  vault?: string;
  status?: string;
  /** True when a live agent (interactive/programmatic/channel) exists. */
  live: boolean;
  /** The vault-native def, when one defines this agent. */
  def?: AgentDefRow;
}

/** Merge the live agent list with the vault-native defs into one keyed set. */
export function mergeAgents(agents: AgentRow[], defs: AgentDefRow[]): MergedAgent[] {
  const byName = new Map<string, MergedAgent>();
  for (const a of agents) {
    byName.set(a.name, {
      name: a.name,
      backend: a.backend,
      ...(a.channel ? { channel: a.channel } : {}),
      ...(a.vault ? { vault: a.vault } : {}),
      ...(a.status ? { status: a.status } : {}),
      live: true,
    });
  }
  for (const d of defs) {
    const existing = byName.get(d.name);
    if (existing) {
      existing.def = d;
      // Fill gaps the live row didn't carry from the durable def.
      if (!existing.channel && d.channel) existing.channel = d.channel;
      if (!existing.vault && d.vault) existing.vault = d.vault;
    } else {
      byName.set(d.name, {
        name: d.name,
        backend: d.backend,
        channel: d.channel,
        vault: d.vault,
        status: d.status,
        live: false,
        def: d,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function backendPillClass(backend: string): string {
  if (backend === "programmatic") return "pill backend-programmatic";
  if (backend === "channel") return "pill backend-channel";
  return "pill backend-interactive";
}

function statusPillClass(status: string): string {
  if (status === "enabled" || status === "idle") return "pill status-enabled";
  if (status === "working") return "pill status-working";
  if (status === "pending" || status.startsWith("queued")) return "pill status-queued";
  if (status === "error") return "pill status-error";
  return "pill";
}

export function Agents() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      // Fetch all three in parallel — the merge needs agents + defs; vaults is
      // an independent read-only section. A failure in any surfaces as one error.
      const [agentsRes, defsRes, vaultsRes] = await Promise.all([
        listAgents(),
        listAgentDefs(),
        listAgentVaults(),
      ]);
      setState({
        kind: "ok",
        agents: agentsRes.agents,
        defs: defsRes.defs,
        vaults: vaultsRes.vaults,
      });
    } catch (err) {
      const message =
        err instanceof HttpError
          ? err.status === 401
            ? "Not signed in to the hub — sign in to the portal, then reload."
            : `Failed to load agents: ${err.message}`
          : `Failed to load agents: ${(err as Error).message}`;
      setState({ kind: "error", message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const merged = useMemo(
    () => (state.kind === "ok" ? mergeAgents(state.agents, state.defs) : []),
    [state],
  );

  const selectedAgent = useMemo(
    () => merged.find((m) => m.name === selected) ?? null,
    [merged, selected],
  );

  return (
    <div>
      <h1>Agents</h1>
      <p className="lede">
        Every agent across all backends, in one place — programmatic, channel, and
        interactive. Read-only for now; the create flow and def-vault editor land in
        later phases.
      </p>

      {state.kind === "error" ? (
        <div className="error-banner" role="alert">
          {state.message}{" "}
          <button type="button" className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {state.kind === "loading" ? <div className="loading">Loading agents…</div> : null}

      {state.kind === "ok" ? (
        <>
          {selectedAgent ? (
            <AgentDetail agent={selectedAgent} onClose={() => setSelected(null)} />
          ) : null}

          <section className="card" aria-label="Agents">
            <div className="section-head">
              <h2>All agents</h2>
              <span className="section-head-actions">
                <span className="count" data-testid="agents-count">
                  {merged.length} {merged.length === 1 ? "agent" : "agents"}
                </span>
                <Link to="/create" className="button-link" data-testid="new-agent-link">
                  New agent
                </Link>
              </span>
            </div>
            {merged.length === 0 ? (
              <div className="empty">
                No agents yet. Define one in a vault as an{" "}
                <code>#agent/definition</code> note, or spawn one from the create flow
                (coming in a later phase).
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Backend</th>
                    <th>Channel</th>
                    <th>Status</th>
                    <th>Vault</th>
                  </tr>
                </thead>
                <tbody>
                  {merged.map((m) => (
                    <tr
                      key={m.name}
                      className={`agent-row${selected === m.name ? " selected" : ""}`}
                      data-testid={`agent-row-${m.name}`}
                      onClick={() => setSelected(selected === m.name ? null : m.name)}
                    >
                      <td className="cell-name">{m.name}</td>
                      <td>
                        <span className={backendPillClass(m.backend)}>{m.backend}</span>
                      </td>
                      <td className={m.channel ? "" : "cell-dim"}>{m.channel ?? "—"}</td>
                      <td>
                        {m.status ? (
                          <span className={statusPillClass(m.status)}>{m.status}</span>
                        ) : m.live ? (
                          <span className="cell-dim">live</span>
                        ) : (
                          <span className="cell-dim">not running</span>
                        )}
                      </td>
                      <td className={m.vault ? "" : "cell-dim"}>{m.vault ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <DefVaultsSection vaults={state.vaults} />
        </>
      ) : null}
    </div>
  );
}

/**
 * The per-agent detail panel. Surfaces the def's system-prompt preview, wants,
 * vault, and status. For a channel-backend agent it notes that the queue / MCP
 * connect affordance arrives in a later phase (this view is read-only).
 */
export function AgentDetail({ agent, onClose }: { agent: MergedAgent; onClose: () => void }) {
  const def = agent.def;
  return (
    <div className="detail" data-testid="agent-detail">
      <div className="detail-head">
        <h2>{agent.name}</h2>
        <span className={backendPillClass(agent.backend)}>{agent.backend}</span>
        {agent.status ? (
          <span className={statusPillClass(agent.status)}>{agent.status}</span>
        ) : null}
        <button type="button" className="detail-close" onClick={onClose}>
          Close
        </button>
      </div>

      <dl className="detail-grid">
        <dt>Backend</dt>
        <dd>{agent.backend}</dd>
        <dt>Channel</dt>
        <dd>{agent.channel ?? "—"}</dd>
        <dt>Vault</dt>
        <dd>{agent.vault ?? "—"}</dd>
        <dt>Running</dt>
        <dd>{agent.live ? "yes" : "no (defined, not instantiated)"}</dd>
        {def ? (
          <>
            <dt>Def status</dt>
            <dd>{def.status}</dd>
          </>
        ) : null}
      </dl>

      {def ? (
        <>
          <h3>System prompt</h3>
          {def.systemPromptPreview ? (
            <p className="detail-prompt" data-testid="detail-prompt">
              {def.systemPromptPreview}
            </p>
          ) : (
            <p className="dim">No system prompt set (Claude Code's default).</p>
          )}

          <h3>Wants</h3>
          {def.wants.length > 0 ? (
            <div className="tag-list">
              {def.wants.map((w) => (
                <span key={w} className="tag">
                  {w}
                </span>
              ))}
            </div>
          ) : (
            <p className="dim">Own-vault only — no extra connections requested.</p>
          )}

          {def.pending.length > 0 ? (
            <>
              <h3>Pending approval</h3>
              <div className="tag-list">
                {def.pending.map((p) => (
                  <span key={p} className="tag">
                    {p}
                  </span>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : (
        <p className="dim" data-testid="detail-no-def">
          This agent isn't backed by a vault-native <code>#agent/definition</code> note,
          so there's no system prompt or wants to show.
        </p>
      )}

      {agent.backend === "channel" ? (
        <p className="detail-note" data-testid="detail-channel-note">
          Channel backend — the queue depth and the "connect your Claude Code session"
          affordance arrive in a later phase.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Read-only "Def-vaults" section: which vaults the module reads agent
 * definitions from (`agent-vaults.json`). `tokenPresent` shows binding health
 * without ever surfacing the token value. The add/remove editor is Phase 4.
 */
export function DefVaultsSection({ vaults }: { vaults: AgentVaultRow[] }) {
  return (
    <section className="card" aria-label="Def-vaults">
      <div className="section-head">
        <h2>Def-vaults</h2>
        <span className="count">{vaults.length}</span>
      </div>
      <p className="muted">
        Vaults this module reads <code>#agent/definition</code> notes from. Editing the
        list (add / remove) comes in a later phase.
      </p>
      {vaults.length === 0 ? (
        <div className="empty" data-testid="def-vaults-empty">
          No def-vaults configured yet.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Vault</th>
              <th>URL</th>
              <th>Token</th>
            </tr>
          </thead>
          <tbody>
            {vaults.map((v) => (
              <tr key={v.vault} data-testid={`def-vault-${v.vault}`}>
                <td className="cell-name">{v.vault}</td>
                <td className="cell-dim">{v.url}</td>
                <td>
                  {v.tokenPresent ? (
                    <span className="pill status-enabled">present</span>
                  ) : (
                    <span className="pill status-error">missing</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
