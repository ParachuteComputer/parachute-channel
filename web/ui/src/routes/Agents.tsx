/**
 * `/agents` — the unified Agents view (Agent UI v2, Phases 2–4a).
 *
 * The one agent-centric surface the v2 design calls for: a single list of
 * EVERY agent across ALL backends (interactive / programmatic / channel) with a
 * detail panel, plus the "Def-vaults" section showing which vaults the module
 * reads `#agent/definition` notes from. It composes the three Phase-1 list
 * endpoints:
 *
 *   - `GET /agent/api/agents`       → the live agents (all backends merged)
 *   - `GET /agent/api/agent-defs`   → the vault-native defs (system-prompt
 *                                     preview, mode, wants, status) the detail
 *                                     panel enriches a row with
 *   - `GET /agent/api/agent-vaults` → the def-vault list
 *
 * The "all-backends merge" is the load-bearing v2 move (#102): the list shows
 * channel/programmatic/interactive agents in one table instead of separate
 * pages. We dedupe defs that have no corresponding live agent so a def authored
 * but not yet instantiated still appears (as a def-only row), giving the
 * operator the full picture.
 *
 * Phase 4a adds the WRITE paths: a vault-native def (a row with a `noteId`) can be
 * EDITED (pre-filled from the FULL def via `getAgentDef`) or DELETED (with an
 * explicit type-to-confirm), and the Def-vaults section can ADD / REMOVE a vault.
 * Editing a def reactively re-instantiates it (Connector 1); the list refresh after
 * the PATCH shows the new state (a slow reactive path may take ≤60s to fully
 * converge, but the immediate per-note reload makes the change live at once).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  type AgentDefRow,
  type AgentMode,
  type AgentRow,
  type AgentVaultRow,
  type ConnectionInfoRow,
  type JobRow,
  addAgentVault,
  createJob,
  deleteAgentDef,
  deleteJob,
  editAgentDef,
  getAgentDef,
  HttpError,
  listAgentDefs,
  listAgentVaults,
  listAgents,
  listJobs,
  removeAgentVault,
  runJob,
  type AgentSecretsResponse,
  type AgentEnvResponse,
  type EffectiveEnvEntry,
  DENYLISTED_ENV_NAMES,
  ENV_NAME_RE,
  listAgentSecrets,
  listAgentEnv,
  setAgentSecret,
  removeAgentSecret,
  type ClaudeCredentialStatus,
  getClaudeCredentialStatus,
  setClaudeCredential,
  removeClaudeChannelCredential,
} from "../lib/api.ts";
import {
  type ConnectionRow,
  approveAgentGrant,
  defReloadStatus,
  ensureDefReloadConnections,
  HubError,
  isDaemonDirectOrigin,
  listConnections,
  teardownDefReloadConnections,
} from "../lib/hub.ts";
import { MODEL_OPTIONS, modelLabel } from "../lib/models.ts";

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
  /** The execution-lifecycle mode, when the agent is backed by a vault-native def. */
  mode?: AgentMode;
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
      existing.mode = d.mode;
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
        mode: d.mode,
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
  const [justConnected, setJustConnected] = useState(false);

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

  // After an MCP OAuth round-trip the hub 302s back here with `?mcp_connected=1`.
  // Surface a brief confirmation + strip the param (the mount load() already
  // refreshes the grant rows, so the now-connected MCP shows its new status).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mcp_connected") !== "1") return;
    setJustConnected(true);
    params.delete("mcp_connected");
    const q = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (q ? `?${q}` : "") + window.location.hash,
    );
  }, []);

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

      {justConnected ? (
        <div className="success-banner" role="status">
          ✓ MCP server connected — it'll be available to the agent on its next run.{" "}
          <button type="button" className="link" onClick={() => setJustConnected(false)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {state.kind === "loading" ? <div className="loading">Loading agents…</div> : null}

      {state.kind === "ok" ? (
        <>
          {selectedAgent ? (
            <AgentDetail
              agent={selectedAgent}
              onClose={() => setSelected(null)}
              onChanged={() => void load()}
              onDeleted={() => {
                setSelected(null);
                void load();
              }}
            />
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

          <ClaudeAuthSection />

          <DefVaultsSection vaults={state.vaults} onChanged={() => void load()} />
        </>
      ) : null}
    </div>
  );
}

/**
 * The per-agent detail panel. Surfaces the def's system-prompt preview, mode,
 * wants, vault, and status. For a vault-native def (a row carrying a `noteId`) it
 * offers Edit + Delete; interactive / non-def agents have no def to edit, so those
 * actions are absent. `onChanged` refreshes the list after an edit; `onDeleted`
 * closes the panel + refreshes after a delete.
 */
export function AgentDetail({
  agent,
  onClose,
  onChanged,
  onDeleted,
}: {
  agent: MergedAgent;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const def = agent.def;
  // Edit/delete are only meaningful for a vault-native def (it has a note to mutate).
  const noteId = def?.noteId;
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");

  // Drop back to the read view whenever the selected agent changes.
  useEffect(() => {
    setMode("view");
  }, [agent.name]);

  if (mode === "edit" && noteId) {
    return (
      <EditAgentForm
        noteId={noteId}
        name={agent.name}
        onCancel={() => setMode("view")}
        onSaved={() => {
          setMode("view");
          onChanged();
        }}
      />
    );
  }

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
        <dt>Mode</dt>
        <dd data-testid="detail-mode">{agent.mode ? modeLabel(agent.mode) : "—"}</dd>
        <dt>Channel</dt>
        <dd>{agent.channel ?? "—"}</dd>
        <dt>Vault</dt>
        <dd>{agent.vault ?? "—"}</dd>
        <dt>Running</dt>
        <dd>{agent.live ? "yes" : "no (defined, not instantiated)"}</dd>
        {def ? (
          <>
            <dt>Model</dt>
            <dd data-testid="detail-model">{modelLabel(def.model)}</dd>
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

          {noteId ? (
            <ConnectionsSection noteId={noteId} def={def} onChanged={onChanged} />
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

      {/* Schedules — only for a vault-native (channel-backed) agent: a scheduled
          job is "an automated human" that injects an inbound note on a cron, and
          the inject path only exists for a vault transport. Interactive /
          channel-less agents can't be scheduled, so the section is absent. */}
      {agent.channel ? <SchedulesSection channel={agent.channel} /> : null}

      {/* Secrets / env vars — local 0600 env injected into this agent's sandboxed
          (programmatic) turns. Scoped to the agent's channel. NEVER in the vault. */}
      {agent.channel ? (
        <SecretsSection channel={agent.channel} backend={agent.backend} />
      ) : null}

      {/* Effective env — the env-var NAMES (never values) this agent's `claude -p`
          turn will actually run with, resolved across the operator default, the
          per-agent override, and approved-grant service env. The top operability
          read: "what env does a turn run with?" Keyed by the agent name; guarded on
          a channel (symmetric with Secrets — a channel-less agent has no per-agent env). */}
      {agent.channel ? <EffectiveEnvSection name={agent.name} /> : null}

      {/* Edit / delete — only for a vault-native def (a note we can mutate). */}
      {noteId ? (
        mode === "delete" ? (
          <DeleteAgentConfirm
            noteId={noteId}
            name={agent.name}
            onCancel={() => setMode("view")}
            onDeleted={onDeleted}
          />
        ) : (
          <div className="detail-actions" data-testid="detail-actions">
            <button type="button" className="secondary" data-testid="edit-agent" onClick={() => setMode("edit")}>
              Edit
            </button>
            <button
              type="button"
              className="button-danger"
              data-testid="delete-agent"
              onClick={() => setMode("delete")}
            >
              Delete
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}

/** Friendly label for the execution-lifecycle mode. */
function modeLabel(mode: AgentMode): string {
  return mode === "single-threaded" ? "Single-threaded" : "Multi-threaded";
}

/**
 * The edit form for a vault-native def. Pre-fills from the FULL def
 * (`getAgentDef` — the whole system-prompt body, not the list's ~200-char
 * preview), then PATCHes the changed fields. The MODE rides in `metadata.mode`
 * (mirroring the create flow). Reuses the create form's field / RadioRow styling.
 */
export function EditAgentForm({
  noteId,
  name,
  onCancel,
  onSaved,
}: {
  noteId: string;
  name: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  type LoadState =
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; systemPrompt: string; mode: AgentMode; wants: string };
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [systemPrompt, setSystemPrompt] = useState("");
  const [mode, setMode] = useState<AgentMode>("single-threaded");
  const [model, setModel] = useState("");
  const [wants, setWants] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fetchFull = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      const res = await getAgentDef(noteId);
      const d = res.def;
      setSystemPrompt(d.systemPrompt);
      setMode(d.mode);
      setModel(d.model ?? "");
      setWants(d.wants.join(", "));
      setLoad({ kind: "ready", systemPrompt: d.systemPrompt, mode: d.mode, wants: d.wants.join(", ") });
    } catch (err) {
      const message =
        err instanceof HttpError
          ? err.status === 401
            ? "Not signed in to the hub — sign in to the portal, then reload."
            : `Failed to load the def: ${err.message}`
          : `Failed to load the def: ${(err as Error).message}`;
      setLoad({ kind: "error", message });
    }
  }, [noteId]);

  useEffect(() => {
    void fetchFull();
  }, [fetchFull]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await editAgentDef(noteId, {
        systemPrompt,
        // `mode` + `model` ride in metadata (same as create). ALWAYS send `model`
        // (even "") so switching back to Default overwrites a prior value — the
        // daemon merges metadata, and an empty model parses as "no --model flag".
        // `wants` is the comma-string; send "" to clear when emptied.
        metadata: { mode, model },
        wants: wants.trim(),
      });
      onSaved();
    } catch (err) {
      const message =
        err instanceof HttpError
          ? err.status === 401
            ? "Not signed in to the hub — sign in to the portal, then reload."
            : err.message
          : (err as Error).message;
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="detail" data-testid="edit-agent-form">
      <div className="detail-head">
        <h2>Edit {name}</h2>
        <button type="button" className="detail-close" onClick={onCancel}>
          Close
        </button>
      </div>

      {load.kind === "loading" ? <div className="loading">Loading def…</div> : null}
      {load.kind === "error" ? (
        <div className="error-banner" role="alert" data-testid="edit-load-error">
          {load.message}{" "}
          <button type="button" className="secondary" onClick={() => void fetchFull()}>
            Retry
          </button>
        </div>
      ) : null}

      {load.kind === "ready" ? (
        <form className="card" onSubmit={onSubmit} aria-label="Edit agent">
          {saveError ? (
            <div className="error-banner" role="alert" data-testid="edit-error">
              {saveError}
            </div>
          ) : null}

          {/* Mode — the execution-lifecycle branch. → metadata.mode */}
          <fieldset className="field">
            <legend>Mode</legend>
            <RadioRow
              name="edit-mode"
              value="single-threaded"
              checked={mode === "single-threaded"}
              onChange={() => setMode("single-threaded")}
              label="Single-threaded"
              help="One continuous conversation — remembers everything on this channel."
              testid="edit-mode-single-threaded"
            />
            <RadioRow
              name="edit-mode"
              value="multi-threaded"
              checked={mode === "multi-threaded"}
              onChange={() => setMode("multi-threaded")}
              label="Multi-threaded"
              help="Each run is its own thread — good for scheduled or stateless tasks."
              testid="edit-mode-multi-threaded"
            />
          </fieldset>

          {/* Model → metadata.model (programmatic `claude -p --model`). */}
          <div className="field">
            <label htmlFor="edit-model">Model</label>
            <select
              id="edit-model"
              value={model}
              data-testid="edit-model"
              onChange={(e) => setModel(e.target.value)}
            >
              {MODEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="field-hint">
              Which model Parachute runs this agent on (programmatic backend). A channel-backend
              agent uses whatever model your own session runs.
            </p>
          </div>

          {/* System prompt → body (the FULL note body). */}
          <div className="field">
            <label htmlFor="edit-prompt">System prompt</label>
            <textarea
              id="edit-prompt"
              rows={8}
              value={systemPrompt}
              placeholder="You are…"
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
            <p className="field-hint">
              The agent's persona + instructions (the note body). Leave blank for Claude
              Code's default.
            </p>
          </div>

          {/* Wants → metadata.wants (comma-separated). */}
          <div className="field">
            <label htmlFor="edit-wants">Wants (connections)</label>
            <input
              id="edit-wants"
              type="text"
              value={wants}
              placeholder="vault:other, service:github"
              autoComplete="off"
              onChange={(e) => setWants(e.target.value)}
            />
            <p className="field-hint">
              Comma-separated connection keys the agent requests beyond its own vault. Each
              needs approval before it's granted.
            </p>
          </div>

          <div className="form-actions">
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button type="button" className="cancel-link" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/**
 * Delete confirmation for a vault-native def — an explicit TYPE-TO-CONFIRM (the
 * operator types the agent name) so a destructive delete can't fire on a stray
 * click. Removing the def deletes the note + deregisters the agent.
 */
export function DeleteAgentConfirm({
  noteId,
  name,
  onCancel,
  onDeleted,
}: {
  noteId: string;
  name: string;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canDelete = confirmText === name && !deleting;

  async function onConfirm() {
    if (!canDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteAgentDef(noteId);
      onDeleted();
    } catch (err) {
      const message =
        err instanceof HttpError
          ? err.status === 401
            ? "Not signed in to the hub — sign in to the portal, then reload."
            : err.message
          : (err as Error).message;
      setError(message);
      setDeleting(false);
    }
  }

  return (
    <div className="confirm-box" data-testid="delete-confirm">
      <p className="confirm-prompt">
        Delete <strong>{name}</strong>? This removes the definition note and deregisters
        the agent. Type the agent name to confirm.
      </p>
      {error ? (
        <div className="error-banner" role="alert" data-testid="delete-error">
          {error}
        </div>
      ) : null}
      <div className="field">
        <input
          type="text"
          value={confirmText}
          placeholder={name}
          autoComplete="off"
          aria-label="Type the agent name to confirm deletion"
          data-testid="delete-confirm-input"
          onChange={(e) => setConfirmText(e.target.value)}
        />
      </div>
      <div className="form-actions">
        <button
          type="button"
          className="button-danger"
          data-testid="delete-confirm-button"
          disabled={!canDelete}
          onClick={() => void onConfirm()}
        >
          {deleting ? "Deleting…" : "Delete agent"}
        </button>
        <button type="button" className="cancel-link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connections / MCP servers (this PR). Add a remote MCP server to THIS agent +
// authenticate it via OAuth (or a pasted static bearer) — in one place, without
// bouncing to the hub admin grants page.
//
//   - LIST the agent's `mcp:` connections (from `def.connections`, falling back to
//     deriving display-only rows from `wants`/`pending` for an older daemon) with a
//     live status pill (Connected / Pending / Needs reconnect).
//   - ADD: a URL + an auth choice (OAuth default | paste a static bearer). On submit
//     we PATCH the def's `wants:` to APPEND `mcp:<url>` (preserving the existing
//     wants), so the DAEMON re-parses + registers the pending grant (its reconcile-GC
//     prunes any grant not in the live `wants:`, so we must go through the def, NOT
//     PUT a grant directly).
//   - CONNECT / RECONNECT: the cookie→hub approve (`approveAgentGrant`) — OAuth
//     redirect (no token) or static-bearer store (with token). This needs the hub
//     grant `id` (`connection.grantId`, from the daemon — never derived here).
//
// Degradation: the cookie→hub Connect only works at the hub origin. Served
// daemon-direct (`http://127.0.0.1:1941/agent/app/`) the cookie won't flow + the
// CSRF belt rejects it, so we detect that (`isDaemonDirectOrigin`) and show a clear
// inline note instead of a confusing error. Adding the MCP (the def PATCH) still
// works daemon-direct; only the Connect step needs the hub origin.
// ---------------------------------------------------------------------------

/** A status pill for a grant lifecycle, mapped to the shared pill classes + a label. */
function GrantStatusPill({ status }: { status: string }) {
  if (status === "approved") {
    return <span className="pill status-enabled" data-testid="conn-status-approved">Connected</span>;
  }
  if (status === "needs_consent") {
    return (
      <span className="pill status-error" data-testid="conn-status-needs_consent">
        Needs reconnect
      </span>
    );
  }
  if (status === "revoked") {
    return <span className="pill status-error" data-testid="conn-status-revoked">Revoked</span>;
  }
  // pending (or any unknown) → awaiting approval.
  return <span className="pill status-pending" data-testid="conn-status-pending">Pending</span>;
}

/**
 * Derive the MCP connection rows to render. Prefer the daemon's `def.connections`
 * (carries the hub grant id + live status — drives Connect); for an OLDER daemon that
 * omits the field, fall back to display-only rows derived from `wants` (those whose key
 * starts `mcp:`), with status inferred from `pending` (in `pending` → pending, else
 * approved) and NO grant id (so Connect is unavailable — a hint shows instead).
 */
export function mcpConnectionRows(def: AgentDefRow): ConnectionInfoRow[] {
  if (def.connections && def.connections.length > 0) {
    return def.connections.filter((c) => c.kind === "mcp");
  }
  // Fallback: an older daemon. `wants` keys for an mcp connection are `mcp:<url>`.
  const pending = new Set(def.pending);
  return def.wants
    .filter((w) => w.startsWith("mcp:") && /^mcp:https?:\/\//i.test(w))
    .map((w) => ({
      key: w,
      kind: "mcp" as const,
      target: w.slice("mcp:".length),
      status: pending.has(w) ? "pending" : "approved",
    }));
}

/**
 * The per-agent Connections / MCP-servers section. `def` carries the current `wants`
 * + per-connection grant info; `onChanged` refreshes the list after an add (so the new
 * connection + its grant id appear). A Connect drives a full-page OAuth redirect, so
 * there's no post-redirect refresh to wire — the hub callback returns the operator to
 * its own page.
 */
export function ConnectionsSection({
  noteId,
  def,
  onChanged,
}: {
  noteId: string;
  def: AgentDefRow;
  onChanged: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  // The grant id currently mid-connect (so its button shows a spinner) / mid-paste.
  const [connecting, setConnecting] = useState<string | null>(null);
  const [pasteFor, setPasteFor] = useState<string | null>(null);
  const [pasteToken, setPasteToken] = useState("");
  const [rowError, setRowError] = useState<string | null>(null);

  const rows = mcpConnectionRows(def);
  // The cookie→hub Connect only works at the hub origin (the cookie + CSRF belt).
  const daemonDirect = isDaemonDirectOrigin();

  /** Start the OAuth dance (no token) → full-page redirect to the remote consent. */
  async function onConnect(grantId: string) {
    setConnecting(grantId);
    setRowError(null);
    try {
      // Where to land after the OAuth round-trip — a ROOT-RELATIVE path so the
      // hub's same-origin guard accepts it and 302s back here (with
      // `?mcp_connected=1`) instead of the dead-end "close this tab" page.
      const returnTo =
        window.location.pathname + window.location.search + window.location.hash;
      const listing = await approveAgentGrant(grantId, undefined, returnTo);
      if (listing.authorizeUrl) {
        // Cross-origin remote consent — full-page nav, NOT react-router.
        window.location.assign(listing.authorizeUrl);
        return; // navigating away; keep the spinner.
      }
      // No authorizeUrl (e.g. the hub approved without a redirect) → refresh in place.
      onChanged();
    } catch (err) {
      setRowError(connectErrMessage(err));
    } finally {
      setConnecting(null);
    }
  }

  /** Store a pasted static bearer (no redirect) → approve immediately, then refresh. */
  async function onPasteToken(grantId: string) {
    const token = pasteToken.trim();
    if (token.length === 0) return;
    setConnecting(grantId);
    setRowError(null);
    try {
      await approveAgentGrant(grantId, token);
      setPasteFor(null);
      setPasteToken("");
      onChanged();
    } catch (err) {
      setRowError(connectErrMessage(err));
    } finally {
      setConnecting(null);
    }
  }

  return (
    <section className="detail-section" aria-label="Connections" data-testid="connections-section">
      <div className="section-head">
        <h3>Connections / MCP servers</h3>
        <button
          type="button"
          className="secondary"
          data-testid="add-mcp-toggle"
          onClick={() => {
            setAddOpen((o) => !o);
            setRowError(null);
          }}
        >
          {addOpen ? "Cancel" : "Add MCP server"}
        </button>
      </div>
      <p className="muted">
        Remote MCP servers this agent can reach. Add one, then connect it via OAuth (or
        paste a static bearer). Each connection is operator-approved before it's granted.
      </p>

      {daemonDirect ? (
        <div className="info-banner" role="status" data-testid="connections-daemon-direct">
          Open this surface via your hub to connect MCP servers — the OAuth/approve step
          needs the hub origin (you're on the loopback daemon).
        </div>
      ) : null}

      {addOpen ? (
        <AddMcpForm
          noteId={noteId}
          def={def}
          onCancel={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            onChanged();
          }}
        />
      ) : null}

      {rowError ? (
        <div className="error-banner" role="alert" data-testid="connections-row-error">
          {rowError}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="empty" data-testid="connections-empty">
          No MCP servers connected to this agent yet.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>MCP server</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const actionable = c.status !== "approved";
              const canConnect = actionable && !!c.grantId && !daemonDirect;
              return (
                <tr key={c.key} data-testid={`connection-row-${c.target}`}>
                  <td className="cell-name">
                    <code>{c.target}</code>
                  </td>
                  <td>
                    <GrantStatusPill status={c.status} />
                  </td>
                  <td>
                    {!actionable ? (
                      <span className="cell-dim">—</span>
                    ) : pasteFor === c.grantId ? (
                      <span className="confirm-inline">
                        <input
                          type="password"
                          value={pasteToken}
                          placeholder="bearer token"
                          autoComplete="off"
                          spellCheck={false}
                          aria-label="Static bearer token"
                          data-testid={`paste-token-input-${c.target}`}
                          onChange={(e) => setPasteToken(e.target.value)}
                        />
                        <button
                          type="button"
                          disabled={connecting === c.grantId || pasteToken.trim().length === 0}
                          data-testid={`paste-token-save-${c.target}`}
                          onClick={() => void onPasteToken(c.grantId!)}
                        >
                          {connecting === c.grantId ? "Saving…" : "Save"}
                        </button>
                        <button
                          type="button"
                          className="cancel-link"
                          onClick={() => {
                            setPasteFor(null);
                            setPasteToken("");
                          }}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <span className="schedule-row-actions">
                        <button
                          type="button"
                          disabled={!canConnect || connecting === c.grantId}
                          data-testid={`connect-${c.target}`}
                          title={
                            daemonDirect
                              ? "Open the agent app via your hub origin to connect."
                              : !c.grantId
                                ? "No grant registered yet — reload after the daemon registers it."
                                : undefined
                          }
                          onClick={() => void onConnect(c.grantId!)}
                        >
                          {connecting === c.grantId
                            ? "Connecting…"
                            : c.status === "needs_consent"
                              ? "Reconnect"
                              : "Connect"}
                        </button>
                        {c.grantId && !daemonDirect ? (
                          <button
                            type="button"
                            className="cancel-link"
                            data-testid={`paste-token-${c.target}`}
                            onClick={() => {
                              setRowError(null);
                              setPasteToken("");
                              setPasteFor(c.grantId!);
                            }}
                          >
                            Paste token
                          </button>
                        ) : null}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** A friendly message off a Connect failure (HubError carries the hub's hint). */
function connectErrMessage(err: unknown): string {
  if (err instanceof HubError) return err.message;
  return (err as Error).message;
}

/**
 * The inline "Add MCP server" form: a URL + an auth choice (OAuth default | paste a
 * static bearer). On submit we APPEND `mcp:<url>` to the def's existing `wants:` (so we
 * don't drop the agent's other connections) and PATCH the def — the daemon re-parses
 * `wants` and registers the pending grant. The auth choice is informational at THIS
 * step (adding registers the grant either way); the actual OAuth-vs-token decision is
 * made at the Connect step on the row. We carry it so the operator's intent is clear +
 * the OAuth path is the default the row's primary button takes.
 */
export function AddMcpForm({
  noteId,
  def,
  onCancel,
  onAdded,
}: {
  noteId: string;
  def: AgentDefRow;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<"oauth" | "token">("oauth");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A valid http(s) URL (the daemon's parseWants requires http(s) for a remote MCP).
  const trimmed = url.trim();
  const urlValid = /^https?:\/\/.+/i.test(trimmed) && isParseableUrl(trimmed);
  // Already declared? (avoid a duplicate `mcp:` entry — the daemon would dedupe by key
  // but a friendlier pre-submit guard.)
  const alreadyAdded = def.wants.includes(`mcp:${trimmed}`);
  const canAdd = urlValid && !alreadyAdded && !saving;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canAdd) return;
    setSaving(true);
    setError(null);
    try {
      // APPEND to the existing wants (preserve the agent's other connections). The
      // wants keys round-trip through the daemon's parseWants as a comma string.
      const next = [...def.wants, `mcp:${trimmed}`].join(", ");
      await editAgentDef(noteId, { wants: next });
      onAdded();
    } catch (err) {
      const message =
        err instanceof HttpError
          ? err.status === 401
            ? "Not signed in to the hub — sign in to the portal, then reload."
            : err.message
          : (err as Error).message;
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={onSubmit} aria-label="Add MCP server" data-testid="add-mcp-form">
      {error ? (
        <div className="error-banner" role="alert" data-testid="add-mcp-error">
          {error}
        </div>
      ) : null}

      <div className="field">
        <label htmlFor="mcp-url">MCP server URL</label>
        <input
          id="mcp-url"
          type="text"
          value={url}
          placeholder="https://mcp.example.com/mcp"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
        />
        {trimmed.length > 0 && !urlValid ? (
          <p className="field-error" data-testid="mcp-url-invalid">
            Must be a full http(s) URL.
          </p>
        ) : null}
        {alreadyAdded ? (
          <p className="field-error" data-testid="mcp-url-duplicate">
            This MCP server is already connected to the agent.
          </p>
        ) : null}
      </div>

      <fieldset className="field">
        <legend>Authentication</legend>
        <p className="muted">You'll enter credentials in the next step &mdash; on the connection's row after it's added.</p>
        <RadioRow
          name="mcp-auth"
          value="oauth"
          checked={auth === "oauth"}
          onChange={() => setAuth("oauth")}
          label="OAuth"
          help="Sign in to the MCP server in your browser (recommended). Connect on the row after adding."
          testid="mcp-auth-oauth"
        />
        <RadioRow
          name="mcp-auth"
          value="token"
          checked={auth === "token"}
          onChange={() => setAuth("token")}
          label="Paste a token"
          help="For an MCP server with a static bearer token. Paste it on the row's “Paste token” after adding."
          testid="mcp-auth-token"
        />
      </fieldset>

      <div className="form-actions">
        <button type="submit" disabled={!canAdd} data-testid="add-mcp-submit">
          {saving ? "Adding…" : "Add MCP server"}
        </button>
        <button type="button" className="cancel-link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** True if `s` parses as a URL (defensive — the regex already gates the scheme). */
function isParseableUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * The per-agent Schedules section (Agent UI v2 — Phase 4b). Folds the runner's
 * schedule management — formerly the separate server-rendered `/jobs` page — into
 * the agent detail panel for a vault-backed agent. It lists THIS agent's jobs
 * (the daemon's `GET /api/jobs` returns every job across all vault channels; we
 * client-filter by `channel` — the same index-free filter the daemon's store does,
 * since there's no per-channel jobs endpoint), and offers create / run-now / delete
 * with the same inline-form + confirm idioms as Phase 4a. Mirrors the operator
 * affordances of `src/jobs-ui.ts` (cron + tz inputs, presets, run-now, last-status).
 */
export function SchedulesSection({ channel }: { channel: string }) {
  type LoadState =
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ok"; jobs: JobRow[] };
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [addOpen, setAddOpen] = useState(false);
  // The job currently being run / in delete-confirm — keyed by id so a row's
  // spinner/confirm is scoped to that row.
  const [running, setRunning] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await listJobs();
      // Client-filter by channel — `GET /api/jobs` returns ALL vault channels'
      // jobs (no per-channel endpoint), so we keep only this agent's.
      const jobs = res.jobs.filter((j) => j.channel === channel);
      setState({ kind: "ok", jobs });
    } catch (err) {
      setState({ kind: "error", message: errMessage(err) });
    }
  }, [channel]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRun(id: string) {
    setRunning(id);
    setRowError(null);
    setRowStatus(null);
    try {
      const res = await runJob(id);
      setRowStatus(`Ran ${id} (${res.status}).`);
      await load();
    } catch (err) {
      setRowError(`Run failed: ${errMessage(err)}`);
    } finally {
      setRunning(null);
    }
  }

  async function onDelete(id: string) {
    setDeleting(id);
    setRowError(null);
    try {
      await deleteJob(id);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      setRowError(errMessage(err));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="schedules" aria-label="Schedules" data-testid="schedules-section">
      <div className="section-head">
        <h3>Schedules</h3>
        <span className="section-head-actions">
          <button
            type="button"
            className="secondary"
            data-testid="add-schedule-toggle"
            onClick={() => setAddOpen((o) => !o)}
          >
            {addOpen ? "Cancel" : "New schedule"}
          </button>
        </span>
      </div>
      <p className="muted">
        Send this agent a message on a cron schedule. The runner writes the message as
        an inbound note; the agent runs its turn as if you typed it.
      </p>

      {addOpen ? (
        <ScheduleForm
          channel={channel}
          onCancel={() => setAddOpen(false)}
          onCreated={() => {
            setAddOpen(false);
            void load();
          }}
        />
      ) : null}

      {rowStatus ? (
        <p className="schedule-status" data-testid="schedule-row-status">
          {rowStatus}
        </p>
      ) : null}
      {rowError ? (
        <div className="error-banner" role="alert" data-testid="schedule-row-error">
          {rowError}
        </div>
      ) : null}

      {state.kind === "loading" ? <div className="loading">Loading schedules…</div> : null}
      {state.kind === "error" ? (
        <div className="error-banner" role="alert" data-testid="schedules-error">
          {state.message}{" "}
          <button type="button" className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {state.kind === "ok" ? (
        state.jobs.length === 0 ? (
          <div className="empty" data-testid="schedules-empty">
            No schedules yet for this agent.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Id</th>
                <th>Cron</th>
                <th>Next run</th>
                <th>Last status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {state.jobs.map((j) => (
                <tr key={j.id} data-testid={`schedule-row-${j.id}`}>
                  <td className="cell-name">
                    <code>{j.id}</code>
                    {!j.enabled ? <span className="cell-dim"> (disabled)</span> : null}
                  </td>
                  <td>
                    <code>{j.schedule.cron}</code>
                    {j.schedule.tz ? <span className="cell-dim"> {j.schedule.tz}</span> : null}
                  </td>
                  <td className={j.nextRunAt ? "" : "cell-dim"}>{fmtTime(j.nextRunAt)}</td>
                  <td>
                    {j.lastStatus ? (
                      <span
                        className={
                          j.lastStatus.startsWith("error") ? "pill status-error" : "pill status-enabled"
                        }
                      >
                        {j.lastStatus}
                      </span>
                    ) : (
                      <span className="cell-dim">—</span>
                    )}
                    {j.lastRunAt ? (
                      <span className="cell-dim"> {fmtTime(j.lastRunAt)}</span>
                    ) : null}
                  </td>
                  <td>
                    {confirmDelete === j.id ? (
                      <span className="confirm-inline">
                        <button
                          type="button"
                          className="button-danger"
                          data-testid={`schedule-delete-confirm-${j.id}`}
                          disabled={deleting === j.id}
                          onClick={() => void onDelete(j.id)}
                        >
                          {deleting === j.id ? "Deleting…" : "Confirm delete"}
                        </button>
                        <button
                          type="button"
                          className="cancel-link"
                          onClick={() => setConfirmDelete(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <span className="schedule-row-actions">
                        <button
                          type="button"
                          className="secondary"
                          data-testid={`schedule-run-${j.id}`}
                          disabled={running === j.id}
                          onClick={() => void onRun(j.id)}
                        >
                          {running === j.id ? "Running…" : "Run now"}
                        </button>
                        <button
                          type="button"
                          className="button-danger"
                          data-testid={`schedule-delete-${j.id}`}
                          onClick={() => {
                            setRowError(null);
                            setConfirmDelete(j.id);
                          }}
                        >
                          Delete
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
    </section>
  );
}

/** Cron presets mirroring `src/jobs-ui.ts` — quick-fills for the cron input. */
const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "daily 8am", cron: "0 8 * * *" },
  { label: "hourly", cron: "0 * * * *" },
  { label: "every 15m", cron: "*/15 * * * *" },
  { label: "weekdays 9am", cron: "0 9 * * 1-5" },
  { label: "weekly Mon 8am", cron: "0 8 * * 1" },
];

/**
 * The inline create-schedule form. The operator names a slug id, the message to
 * inject, a cron (with presets), and an optional IANA tz. `createJob` upserts a
 * `#agent/job` note; the daemon validates the cron + tz and 400s a bad one, which
 * surfaces inline. Mirrors the `inline-form` idiom of the Phase-4a add-def-vault form.
 */
export function ScheduleForm({
  channel,
  onCancel,
  onCreated,
}: {
  channel: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [id, setId] = useState("");
  const [message, setMessage] = useState("");
  const [cron, setCron] = useState("");
  const [tz, setTz] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idValid = /^[a-zA-Z0-9_-]+$/.test(id);
  const canCreate = idValid && message.trim().length > 0 && cron.trim().length > 0 && !saving;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate) return;
    setSaving(true);
    setError(null);
    try {
      await createJob({
        id,
        channel,
        message: message.trim(),
        schedule: { cron: cron.trim(), ...(tz.trim() ? { tz: tz.trim() } : {}) },
        enabled: true,
      });
      onCreated();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={onSubmit} aria-label="New schedule" data-testid="schedule-form">
      {error ? (
        <div className="error-banner" role="alert" data-testid="schedule-form-error">
          {error}
        </div>
      ) : null}

      <div className="field">
        <label htmlFor="schedule-id">Job id (slug)</label>
        <input
          id="schedule-id"
          type="text"
          value={id}
          placeholder="morning-standup"
          autoComplete="off"
          onChange={(e) => setId(e.target.value)}
        />
        {id.length > 0 && !idValid ? (
          <p className="field-error" data-testid="schedule-id-invalid">
            Must be a slug — letters, numbers, dash, underscore only.
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="schedule-message">Message to send</label>
        <textarea
          id="schedule-message"
          rows={3}
          value={message}
          placeholder="Run the morning weave…"
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="schedule-cron">Cron (min hour dom mon dow)</label>
        <input
          id="schedule-cron"
          type="text"
          value={cron}
          placeholder="0 8 * * *"
          autoComplete="off"
          onChange={(e) => setCron(e.target.value)}
        />
        <div className="schedule-presets">
          {CRON_PRESETS.map((p) => (
            <button
              key={p.cron}
              type="button"
              className="secondary"
              onClick={() => setCron(p.cron)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label htmlFor="schedule-tz">Timezone (IANA, optional)</label>
        <input
          id="schedule-tz"
          type="text"
          value={tz}
          placeholder="America/Los_Angeles"
          autoComplete="off"
          onChange={(e) => setTz(e.target.value)}
        />
        <p className="field-hint">Leave blank to use the daemon's local timezone.</p>
      </div>

      <div className="form-actions">
        <button type="submit" disabled={!canCreate}>
          {saving ? "Scheduling…" : "Create schedule"}
        </button>
        <button type="button" className="cancel-link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Format an ISO timestamp for display (locale), falling back to em-dash / the raw value. */
function fmtTime(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** A labelled radio with a help line — the edit form's mode rows (mirrors CreateAgent). */
function RadioRow(props: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  help: string;
  testid: string;
}) {
  return (
    <label className={`radio-row${props.checked ? " selected" : ""}`} data-testid={props.testid}>
      <input
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.checked}
        onChange={props.onChange}
      />
      <span className="radio-body">
        <span className="radio-label">{props.label}</span>
        <span className="radio-help">{props.help}</span>
      </span>
    </label>
  );
}

/** The CSS pill class for an env source badge — grant gets the accent style, channel
 *  the warn style (matching the backend pills), default a plain pill. */
function envSourceBadgeClass(source: string): string {
  if (source === "channel") return "pill backend-channel";
  if (source.startsWith("grant:")) return "pill backend-programmatic";
  return "pill";
}

/**
 * The per-agent EFFECTIVE-ENV section (operability: "see what env a turn runs with").
 * A read-only view over the daemon's `GET /api/agents/<name>/env` — the env-var NAMES
 * (NEVER values) this agent's `claude -p` turn will actually run with, each with a
 * source badge: `default` (operator-level), `channel` (this agent's override), or
 * `grant:<svc>` (a service env an APPROVED hub grant injects). A name shadowed by a
 * higher-precedence layer is shown with a subtle "overridden" marker, so a
 * "default sets X but the channel overrides it" is visible at a glance — exactly the
 * read that makes a `_TOKEN`-vs-`_KEY` mix-up obvious. NO values are ever fetched or
 * rendered. Names-only mirrors the Secrets section's redaction posture.
 */
export function EffectiveEnvSection({ name }: { name: string }) {
  type LoadState =
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ok"; env: EffectiveEnvEntry[]; note?: string };
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res: AgentEnvResponse = await listAgentEnv(name);
      setState({ kind: "ok", env: res.env, ...(res.note ? { note: res.note } : {}) });
    } catch (err) {
      setState({ kind: "error", message: errMessage(err) });
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="detail-section" aria-label="Effective env" data-testid="effective-env-section">
      <div className="section-head">
        <h3>Effective env</h3>
        <button type="button" className="secondary" data-testid="effective-env-refresh" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <p className="muted">
        The env-var <strong>names</strong> this agent's sandboxed turn runs with, resolved across the
        operator default, this agent's override, and approved-grant service env.{" "}
        <strong>Names only</strong> — values are never shown. Precedence: channel &gt; default &gt; grant.
      </p>

      {state.kind === "loading" ? <div className="loading">Loading effective env…</div> : null}
      {state.kind === "error" ? (
        <div className="error-banner" role="alert" data-testid="effective-env-error">
          {state.message}{" "}
          <button type="button" className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {state.kind === "ok" ? (
        <>
          {state.note ? (
            <p className="muted" data-testid="effective-env-note">
              {state.note}
            </p>
          ) : null}
          {state.env.length === 0 ? (
            <div className="empty" data-testid="effective-env-empty">
              No env vars resolved for this agent.
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Source</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {state.env.map((e, i) => (
                  <tr
                    key={`${e.name}-${e.source}-${i}`}
                    className={e.overridden ? "cell-dim" : ""}
                    data-testid={`effective-env-${e.name}-${e.source}`}
                  >
                    <td className="cell-name">{e.name}</td>
                    <td>
                      <span className={envSourceBadgeClass(e.source)}>{e.source}</span>
                    </td>
                    <td>
                      {e.overridden ? (
                        <span className="cell-dim" data-testid={`effective-env-overridden-${e.name}-${e.source}`}>
                          overridden
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </section>
  );
}

/**
 * The per-agent Secrets / env-vars section (#36). A thin UI over the daemon's
 * `/api/credentials/env` endpoints: list (names only — values are NEVER returned),
 * set, and remove an env var scoped to THIS agent's channel. The vars are stored
 * locally (`~/.parachute/agent/credentials.json`, 0600) and injected into the
 * agent's sandboxed `claude -p` turns — so e.g. a `GH_TOKEN` lets the agent's
 * `git`/`gh` push & pull. They are NEVER written to a vault note. The Claude-auth
 * trio is denylisted (the daemon 400s it; we guard client-side too). Only the
 * PROGRAMMATIC backend consumes these (a channel-backend agent runs in the
 * operator's own session, with the operator's own env) — surfaced with a note.
 */
export function SecretsSection({
  channel,
  backend,
}: {
  channel: string;
  /** The agent's backend — only `"channel"` is special-cased (a note); kept as a
   *  plain string so this section is decoupled from the merged-agent type. */
  backend: string;
}) {
  type LoadState =
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ok"; names: string[] };
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res: AgentSecretsResponse = await listAgentSecrets();
      // Only THIS agent's channel-scoped vars (the default layer is operator-wide,
      // managed elsewhere — this section is per-agent).
      setState({ kind: "ok", names: (res.channels[channel] ?? []).slice().sort() });
    } catch (err) {
      setState({ kind: "error", message: errMessage(err) });
    }
  }, [channel]);

  useEffect(() => {
    void load();
  }, [load]);

  // Client-side guard mirroring the daemon (a friendlier pre-submit error than a 400).
  // EXACT match (no case-fold): the daemon's denylist is case-sensitive + SCREAMING_CASE,
  // and env vars are case-sensitive on Unix — a lowercase `anthropic_api_key` is a
  // different, harmless var the daemon accepts, so we must not block it here.
  const trimmedName = name.trim();
  const nameDenylisted = DENYLISTED_ENV_NAMES.has(trimmedName);
  const nameShapeOk = trimmedName.length === 0 || ENV_NAME_RE.test(trimmedName);
  const canSave =
    trimmedName.length > 0 && nameShapeOk && !nameDenylisted && value.length > 0 && !saving;

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setAddError(null);
    try {
      await setAgentSecret({ channel, name: trimmedName, value });
      setName("");
      setValue("");
      setAddOpen(false);
      await load();
    } catch (err) {
      setAddError(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function onRemove(varName: string) {
    setRemoving(varName);
    setRowError(null);
    try {
      await removeAgentSecret({ channel, name: varName });
      setConfirmRemove(null);
      await load();
    } catch (err) {
      setRowError(errMessage(err));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <section className="detail-section" aria-label="Secrets" data-testid="secrets-section">
      <div className="section-head">
        <h3>Secrets (env vars)</h3>
        <button
          type="button"
          className="secondary"
          data-testid="add-secret-toggle"
          onClick={() => {
            setAddOpen((o) => !o);
            setAddError(null);
          }}
        >
          {addOpen ? "Cancel" : "Add secret"}
        </button>
      </div>
      <p className="muted">
        Local env vars (e.g. <code>GH_TOKEN</code>) injected into this agent's sandboxed turns —
        stored 0600 on this machine, <strong>never in the vault</strong>. Values are write-only:
        they're never shown again.
        {backend === "channel" ? (
          <>
            {" "}
            This agent uses the <strong>channel</strong> backend, so it runs in your own Claude
            Code session with your own environment — these vars apply only to programmatic turns.
          </>
        ) : null}
      </p>

      {addOpen ? (
        <form className="inline-form" onSubmit={onAdd} aria-label="Add secret" aria-busy={saving} data-testid="add-secret-form">
          {addError ? (
            <div className="error-banner" role="alert" data-testid="add-secret-error">
              {addError}
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="secret-name">Name</label>
            <input
              id="secret-name"
              type="text"
              value={name}
              placeholder="GH_TOKEN"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
            />
            {trimmedName.length > 0 && !nameShapeOk ? (
              <p className="field-error" data-testid="secret-name-invalid">
                A valid env var name — letters, numbers, underscore; not starting with a digit.
              </p>
            ) : null}
            {nameDenylisted ? (
              <p className="field-error" data-testid="secret-name-denylisted">
                Reserved — {trimmedName} would hijack the agent's managed billing/auth.
              </p>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="secret-value">Value</label>
            <input
              id="secret-value"
              type="password"
              value={value}
              placeholder="ghp_…"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
            />
            <p className="field-hint">Stored 0600 on disk (access-controlled, not encrypted). Write-only — never re-displayed.</p>
          </div>
          <div className="form-actions">
            <button type="submit" disabled={!canSave}>
              {saving ? "Saving…" : "Save secret"}
            </button>
          </div>
        </form>
      ) : null}

      {rowError ? (
        <div className="error-banner" role="alert" data-testid="secret-row-error">
          {rowError}
        </div>
      ) : null}

      {state.kind === "loading" ? <div className="loading">Loading secrets…</div> : null}
      {state.kind === "error" ? (
        <div className="error-banner" role="alert" data-testid="secrets-load-error">
          {state.message}{" "}
          <button type="button" className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}
      {state.kind === "ok" ? (
        state.names.length === 0 ? (
          <div className="empty" data-testid="secrets-empty">
            No secrets set for this agent.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Value</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {state.names.map((n) => (
                <tr key={n} data-testid={`secret-${n}`}>
                  <td className="cell-name">{n}</td>
                  <td className="cell-dim">••••••••</td>
                  <td>
                    {confirmRemove === n ? (
                      <span className="confirm-inline">
                        <button
                          type="button"
                          className="button-danger"
                          data-testid={`secret-remove-confirm-${n}`}
                          disabled={removing === n}
                          onClick={() => void onRemove(n)}
                        >
                          {removing === n ? "Removing…" : "Confirm remove"}
                        </button>
                        <button type="button" className="cancel-link" onClick={() => setConfirmRemove(null)}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="button-danger"
                        data-testid={`secret-remove-${n}`}
                        onClick={() => {
                          setRowError(null);
                          setConfirmRemove(n);
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
    </section>
  );
}

/**
 * "Claude auth" section: the operator-level Claude OAuth token (from
 * `claude setup-token`) that the daemon runs each programmatic (`claude -p`) turn
 * on. This is the gap operators hit — the SPA showed def-vaults but had nowhere to
 * set the Claude token, so a vault-native programmatic agent failed at spawn with
 * `no Claude credential …`.
 *
 * Operator-level + per-channel, mirroring the daemon's credential store: a single
 * DEFAULT token used by every agent, plus optional per-channel OVERRIDES (the
 * multi-principal seam). The status is read STATUS-ONLY (`getClaudeCredentialStatus`
 * → `{ defaultSet, channels }`) — the token value is NEVER returned, shown, or
 * re-displayed. Setting writes through `setClaudeCredential` (the dedicated
 * `/api/credentials/claude` endpoint, NOT the generic env store, which rejects the
 * Claude-auth trio). Per-channel overrides can be removed; replacing the default is
 * a re-set (there's no default-remove route).
 */
export function ClaudeAuthSection() {
  type LoadState =
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ok"; status: ClaudeCredentialStatus };
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // The set form: a token + an optional channel (blank = the operator default).
  const [setOpen, setSetOpen] = useState(false);
  const [token, setToken] = useState("");
  const [channel, setChannel] = useState("");
  const [saving, setSaving] = useState(false);
  const [setError, setSetError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  // Per-channel override removal.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const status = await getClaudeCredentialStatus();
      setState({ kind: "ok", status });
    } catch (err) {
      setState({ kind: "error", message: errMessage(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const trimmedChannel = channel.trim();
  const canSave = token.length > 0 && !saving;

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setSetError(null);
    setSavedNotice(null);
    try {
      await setClaudeCredential({
        token,
        ...(trimmedChannel.length > 0 ? { channel: trimmedChannel } : {}),
      });
      setToken("");
      setChannel("");
      setSetOpen(false);
      setSavedNotice(
        trimmedChannel.length > 0
          ? `Saved a Claude token override for "${trimmedChannel}".`
          : "Saved the default Claude token.",
      );
      await load();
    } catch (err) {
      setSetError(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function onRemove(ch: string) {
    setRemoving(ch);
    setRowError(null);
    try {
      await removeClaudeChannelCredential(ch);
      setConfirmRemove(null);
      await load();
    } catch (err) {
      setRowError(errMessage(err));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <section className="card" aria-label="Claude auth" data-testid="claude-auth-section">
      <div className="section-head">
        <h2>Claude auth</h2>
        <span className="section-head-actions">
          {state.kind === "ok" ? (
            state.status.defaultSet ? (
              <span className="pill status-enabled" data-testid="claude-default-configured">
                configured
              </span>
            ) : (
              <span className="pill status-error" data-testid="claude-default-missing">
                not configured
              </span>
            )
          ) : null}
          <button
            type="button"
            className="secondary"
            data-testid="set-claude-token-toggle"
            onClick={() => {
              setSetOpen((o) => !o);
              setSetError(null);
              setSavedNotice(null);
            }}
          >
            {setOpen ? "Cancel" : "Set token"}
          </button>
        </span>
      </div>
      <p className="muted">
        The token from <code>claude setup-token</code> that the daemon runs each agent turn
        on. It's stored locally (<code>credentials.json</code>, 0600) and used to run turns on
        your <strong>Claude subscription</strong> — <strong>not</strong> API billing. It's
        write-only: the value is never shown again. Set a <strong>default</strong> token (used by
        every agent) or a per-<strong>channel</strong> override.
      </p>

      {savedNotice ? (
        <div className="info-banner" role="status" data-testid="claude-saved-notice">
          {savedNotice}
        </div>
      ) : null}

      {setOpen ? (
        <form
          className="inline-form"
          onSubmit={onSave}
          aria-label="Set Claude token"
          aria-busy={saving}
          data-testid="set-claude-token-form"
        >
          {setError ? (
            <div className="error-banner" role="alert" data-testid="set-claude-token-error">
              {setError}
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="claude-token">Token</label>
            <input
              id="claude-token"
              type="password"
              value={token}
              placeholder="paste the output of `claude setup-token`"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setToken(e.target.value)}
            />
            <p className="field-hint">
              Run <code>claude setup-token</code> on a machine where you're signed in, then paste
              it here. Stored 0600 on disk (access-controlled, not encrypted). Write-only — never
              re-displayed.
            </p>
          </div>
          <div className="field">
            <label htmlFor="claude-channel">Channel (optional)</label>
            <input
              id="claude-channel"
              type="text"
              value={channel}
              placeholder="leave blank for the default (operator) token"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setChannel(e.target.value)}
            />
            <p className="field-hint">
              A channel name to override just that agent; blank sets the default token every agent
              falls back to.
            </p>
          </div>
          <div className="form-actions">
            <button type="submit" disabled={!canSave}>
              {saving ? "Saving…" : "Save token"}
            </button>
          </div>
        </form>
      ) : null}

      {rowError ? (
        <div className="error-banner" role="alert" data-testid="claude-row-error">
          {rowError}
        </div>
      ) : null}

      {state.kind === "loading" ? <div className="loading">Loading Claude auth…</div> : null}
      {state.kind === "error" ? (
        <div className="error-banner" role="alert" data-testid="claude-auth-load-error">
          {state.message}{" "}
          <button type="button" className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}
      {state.kind === "ok" ? (
        <>
          {!state.status.defaultSet ? (
            <div className="empty" data-testid="claude-default-empty">
              No default Claude token set — programmatic agents can't run turns until one is set
              (or a per-channel override covers them).
            </div>
          ) : null}
          {state.status.channels.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Channel override</th>
                  <th>Token</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {state.status.channels.map((ch) => (
                  <tr key={ch} data-testid={`claude-override-${ch}`}>
                    <td className="cell-name">{ch}</td>
                    <td className="cell-dim">••••••••</td>
                    <td>
                      {confirmRemove === ch ? (
                        <span className="confirm-inline">
                          <button
                            type="button"
                            className="button-danger"
                            data-testid={`claude-override-remove-confirm-${ch}`}
                            disabled={removing === ch}
                            onClick={() => void onRemove(ch)}
                          >
                            {removing === ch ? "Removing…" : "Confirm remove"}
                          </button>
                          <button
                            type="button"
                            className="cancel-link"
                            onClick={() => setConfirmRemove(null)}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="button-danger"
                          data-testid={`claude-override-remove-${ch}`}
                          onClick={() => {
                            setRowError(null);
                            setConfirmRemove(ch);
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * "Def-vaults" section: which vaults the module reads agent definitions from
 * (`agent-vaults.json`). `tokenPresent` shows binding health without ever
 * surfacing the token value. Phase 4a adds ADD (vault name + optional url →
 * `addAgentVault`) and REMOVE (per vault → `removeAgentVault`, with confirm —
 * removing a def-vault deregisters its agents). `onChanged` refreshes the page
 * after either mutation.
 */
export function DefVaultsSection({
  vaults,
  onChanged,
}: {
  vaults: AgentVaultRow[];
  onChanged: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [vaultName, setVaultName] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // A non-blocking notice after add — reactive reload may or may not have wired.
  const [addNotice, setAddNotice] = useState<string | null>(null);
  // The vault currently in the remove-confirm state (its name), or null.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Reactive-reload (def-reload connectors) state. `connections` is the hub's
  // connection list; `connLoaded` distinguishes "loaded, none match" from "the
  // hub list is unavailable" (loopback-direct / no session) so the column can
  // degrade to "—" instead of falsely reading "off". `toggling` names the vault
  // mid-enable/disable.
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [connLoaded, setConnLoaded] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [reactiveError, setReactiveError] = useState<string | null>(null);

  const refreshConnections = useCallback(async () => {
    try {
      const list = await listConnections();
      setConnections(list);
      setConnLoaded(true);
    } catch {
      // Hub unavailable from here (loopback-direct, no session) — the 60s poll
      // still covers reactivity; we just can't SHOW or TOGGLE its status.
      setConnLoaded(false);
    }
  }, []);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  const nameValid = /^[a-zA-Z0-9_-]+$/.test(vaultName);
  const canAdd = nameValid && !adding;

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!canAdd) return;
    setAdding(true);
    setAddError(null);
    setAddNotice(null);
    const added = vaultName;
    try {
      await addAgentVault({
        vault: added,
        ...(url.trim().length > 0 ? { url: url.trim() } : {}),
      });
      setVaultName("");
      setUrl("");
      setAddOpen(false);
      onChanged();
      // Auto-wire reactive reload (the operator's authenticated session IS the
      // approval). Best-effort: a failure leaves the vault added with the 60s
      // poll as the fallback, so it never blocks the add.
      try {
        const { ok } = await ensureDefReloadConnections(added);
        setAddNotice(
          ok
            ? `Added "${added}" — reactive reload is on (def changes apply instantly).`
            : `Added "${added}" — reactive reload partially wired; defs still converge within 60s.`,
        );
      } catch (err) {
        setAddNotice(
          `Added "${added}". Reactive reload couldn't be enabled (${errMessage(err)}) — def changes converge within 60s; you can enable it below.`,
        );
      }
      await refreshConnections();
    } catch (err) {
      setAddError(errMessage(err));
    } finally {
      setAdding(false);
    }
  }

  async function onRemove(name: string) {
    setRemoving(name);
    setRemoveError(null);
    try {
      await removeAgentVault(name);
      // Best-effort teardown of this vault's def-reload connectors — the vault
      // is no longer a def-vault, so its triggers are stale. A failure is
      // non-fatal (the connector just reloads a vault nothing reads). Fetch the
      // connection list FRESH (fall back to the snapshot) so a builder-made
      // connector with a hub-derived id is caught even if our state is stale.
      try {
        const fresh = await listConnections().catch(() => connections);
        await teardownDefReloadConnections(name, fresh);
      } catch {
        // ignore — leaves a harmless stale connector, removable in the hub UI.
      }
      setConfirmRemove(null);
      onChanged();
      await refreshConnections();
    } catch (err) {
      setRemoveError(errMessage(err));
    } finally {
      setRemoving(null);
    }
  }

  async function onToggleReactive(name: string, currentlyActive: boolean) {
    setToggling(name);
    setReactiveError(null);
    try {
      if (currentlyActive) {
        await teardownDefReloadConnections(name, connections);
      } else {
        await ensureDefReloadConnections(name);
      }
      await refreshConnections();
    } catch (err) {
      setReactiveError(errMessage(err));
    } finally {
      setToggling(null);
    }
  }

  return (
    <section className="card" aria-label="Def-vaults">
      <div className="section-head">
        <h2>Def-vaults</h2>
        <span className="section-head-actions">
          <span className="count">{vaults.length}</span>
          <button
            type="button"
            className="secondary"
            data-testid="add-def-vault-toggle"
            onClick={() => setAddOpen((o) => !o)}
          >
            {addOpen ? "Cancel" : "Add def-vault"}
          </button>
        </span>
      </div>
      <p className="muted">
        Vaults this module reads <code>#agent/definition</code> notes from. Removing one
        deregisters every agent defined in it. <strong>Reactive reload</strong> wires a vault
        trigger so def changes apply instantly instead of waiting up to 60s.
      </p>

      {addNotice ? (
        <div className="info-banner" role="status" data-testid="add-def-vault-notice">
          {addNotice}
        </div>
      ) : null}
      {reactiveError ? (
        <div className="error-banner" role="alert" data-testid="reactive-reload-error">
          {reactiveError}
        </div>
      ) : null}

      {addOpen ? (
        <form className="inline-form" onSubmit={onAdd} aria-label="Add def-vault" data-testid="add-def-vault-form">
          {addError ? (
            <div className="error-banner" role="alert" data-testid="add-def-vault-error">
              {addError}
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="new-vault-name">Vault name</label>
            <input
              id="new-vault-name"
              type="text"
              value={vaultName}
              placeholder="research"
              autoComplete="off"
              onChange={(e) => setVaultName(e.target.value)}
            />
            {vaultName.length > 0 && !nameValid ? (
              <p className="field-error" data-testid="new-vault-invalid">
                Must be a slug — letters, numbers, dash, underscore only.
              </p>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="new-vault-url">Vault URL (optional)</label>
            <input
              id="new-vault-url"
              type="text"
              value={url}
              placeholder="http://127.0.0.1:1940"
              autoComplete="off"
              onChange={(e) => setUrl(e.target.value)}
            />
            <p className="field-hint">The vault REST origin. Defaults to the loopback vault.</p>
          </div>
          <div className="form-actions">
            <button type="submit" disabled={!canAdd}>
              {adding ? "Adding…" : "Add def-vault"}
            </button>
          </div>
        </form>
      ) : null}

      {removeError ? (
        <div className="error-banner" role="alert" data-testid="remove-def-vault-error">
          {removeError}
        </div>
      ) : null}

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
              <th>Reactive reload</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {vaults.map((v) => {
              const reactive = defReloadStatus(v.vault, connections);
              return (
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
                <td data-testid={`reactive-reload-cell-${v.vault}`}>
                  {!connLoaded ? (
                    <span className="cell-dim" title="Open the agent app via your hub origin to manage reactive reload.">
                      —
                    </span>
                  ) : (
                    <span className="confirm-inline">
                      {reactive.active ? (
                        <span className="pill status-enabled" data-testid={`reactive-on-${v.vault}`}>
                          on
                        </span>
                      ) : (
                        <span className="pill" data-testid={`reactive-off-${v.vault}`}>
                          off
                        </span>
                      )}
                      <button
                        type="button"
                        className="cancel-link"
                        data-testid={`reactive-toggle-${v.vault}`}
                        disabled={toggling === v.vault}
                        onClick={() => void onToggleReactive(v.vault, reactive.active)}
                      >
                        {toggling === v.vault
                          ? "Working…"
                          : reactive.active
                            ? "Disable"
                            : "Enable"}
                      </button>
                    </span>
                  )}
                </td>
                <td>
                  {confirmRemove === v.vault ? (
                    <span className="confirm-inline">
                      <button
                        type="button"
                        className="button-danger"
                        data-testid={`remove-def-vault-confirm-${v.vault}`}
                        disabled={removing === v.vault}
                        onClick={() => void onRemove(v.vault)}
                      >
                        {removing === v.vault ? "Removing…" : "Confirm remove"}
                      </button>
                      <button
                        type="button"
                        className="cancel-link"
                        onClick={() => setConfirmRemove(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="button-danger"
                      data-testid={`remove-def-vault-${v.vault}`}
                      onClick={() => {
                        setRemoveError(null);
                        setConfirmRemove(v.vault);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Pull a user-facing message off an unknown error (HttpError carries the daemon's). */
function errMessage(err: unknown): string {
  if (err instanceof HttpError) {
    return err.status === 401
      ? "Not signed in to the hub — sign in to the portal, then reload."
      : err.message;
  }
  return (err as Error).message;
}
