/**
 * `/create` — the unified create-agent flow (Agent UI v2, Phase 3).
 *
 * One form that collapses the old create-agent page + the standalone
 * Config/manage-channels page into a single flow: a `#agent/definition` note IS
 * the agent (body = system prompt, metadata = config), and writing it
 * auto-instantiates the agent AND its channel inbound routing — so creating is
 * JUST `POST /api/agent-defs`; there is NO separate channel-provisioning step
 * (`agent-defs.ts` uses `addChannelLive` under the hood).
 *
 * The two primary axes the v2 design surfaces:
 *   - MODE (top-level branch) — single-threaded (default) vs multi-threaded.
 *     Rides in `metadata.mode`, NOT a top-level body field.
 *   - BACKEND — programmatic (default; daemon runs it headless) vs channel (you
 *     run a Claude Code session on your own machine and connect it). The retired
 *     `interactive` backend is NOT offered.
 *
 * For a channel-backend agent the success state shows the "connect your Claude
 * Code session" affordance: the `claude mcp add` one-liner (computed from
 * `window.location.origin`, mirroring `src/daemon.ts:1194-1196`) with a copy
 * button. The def-vault add/remove editor + edit/delete of a def are Phase 4.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  type AgentMode,
  type AgentVaultRow,
  type CreatableBackend,
  type CreateAgentDefResponse,
  connectSessionCommand,
  createAgentDef,
  HttpError,
  listAgentVaults,
} from "../lib/api.ts";

/** The name field must be a slug (the daemon enforces the same `NAME_SLUG_RE`). */
const NAME_SLUG_RE = /^[a-zA-Z0-9_-]+$/;

interface CreateAgentProps {
  /** The configured def-vaults (from `listAgentVaults`). Empty = none configured. */
  vaults: AgentVaultRow[];
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "ok"; result: CreateAgentDefResponse };

export function CreateAgent({ vaults }: CreateAgentProps) {
  const hasVaults = vaults.length > 0;

  const [name, setName] = useState("");
  const [vault, setVault] = useState(vaults[0]?.vault ?? "");
  const [mode, setMode] = useState<AgentMode>("single-threaded");
  const [backend, setBackend] = useState<CreatableBackend>("programmatic");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [wants, setWants] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  const nameValid = NAME_SLUG_RE.test(name);
  const canSubmit =
    hasVaults && nameValid && vault.length > 0 && submit.kind !== "submitting";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmit({ kind: "submitting" });
    try {
      const result = await createAgentDef({
        vault,
        name,
        backend,
        systemPrompt,
        // `mode` is NOT a top-level field — it rides in metadata.
        metadata: { mode },
        // Only send `wants` when the operator entered something.
        ...(wants.trim().length > 0 ? { wants: wants.trim() } : {}),
      });
      setSubmit({ kind: "ok", result });
    } catch (err) {
      const message =
        err instanceof HttpError
          ? err.status === 401
            ? "Not signed in to the hub — sign in to the portal, then reload."
            : err.message
          : (err as Error).message;
      setSubmit({ kind: "error", message });
    }
  }

  if (submit.kind === "ok") {
    return <CreateSuccess result={submit.result} />;
  }

  return (
    <div>
      <h1>New agent</h1>
      <p className="lede">
        A <code>#agent/definition</code> note IS the agent — writing it instantiates the
        agent and its channel routing in one step. The def-vault editor, schedules, and
        editing land in a later phase.
      </p>

      {!hasVaults ? (
        <div className="error-banner" role="alert" data-testid="no-def-vaults">
          No def-vault is configured, and one is required to create an agent. The add /
          remove def-vault editor arrives in a later phase; until then, configure a
          def-vault out-of-band. Submitting anyway will return the daemon's{" "}
          <code>no def-vaults configured</code> error.
        </div>
      ) : null}

      {submit.kind === "error" ? (
        <div className="error-banner" role="alert" data-testid="create-error">
          {submit.message}
        </div>
      ) : null}

      <form className="card" onSubmit={onSubmit} aria-label="Create agent">
        {/* Name — the slug; the agent name == its channel. */}
        <div className="field">
          <label htmlFor="agent-name">Name</label>
          <input
            id="agent-name"
            type="text"
            value={name}
            placeholder="my-agent"
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
          <p className="field-hint">
            A slug (letters, numbers, dash, underscore). This is also the agent's channel.
          </p>
          {name.length > 0 && !nameValid ? (
            <p className="field-error" data-testid="name-invalid">
              Must be a slug — letters, numbers, dash, underscore only.
            </p>
          ) : null}
        </div>

        {/* Def-vault — the vault the def note is written to. */}
        <div className="field">
          <label htmlFor="agent-vault">Def-vault</label>
          <select
            id="agent-vault"
            value={vault}
            disabled={!hasVaults}
            onChange={(e) => setVault(e.target.value)}
          >
            {hasVaults ? (
              vaults.map((v) => (
                <option key={v.vault} value={v.vault}>
                  {v.vault}
                  {v.tokenPresent ? "" : " (token missing)"}
                </option>
              ))
            ) : (
              <option value="">No def-vaults configured</option>
            )}
          </select>
          <p className="field-hint">The vault this agent's definition note is written to.</p>
        </div>

        {/* Mode — the top-level execution-lifecycle branch. → metadata.mode */}
        <fieldset className="field">
          <legend>Mode</legend>
          <RadioRow
            name="mode"
            value="single-threaded"
            checked={mode === "single-threaded"}
            onChange={() => setMode("single-threaded")}
            label="Single-threaded"
            help="One continuous conversation — remembers everything on this channel."
            testid="mode-single-threaded"
          />
          <RadioRow
            name="mode"
            value="multi-threaded"
            checked={mode === "multi-threaded"}
            onChange={() => setMode("multi-threaded")}
            label="Multi-threaded"
            help="Each run is its own thread; today every run starts fresh (per-conversation continuation is coming) — good for scheduled or stateless tasks."
            testid="mode-multi-threaded"
          />
        </fieldset>

        {/* Backend — programmatic (default) vs channel. interactive is RETIRED. */}
        <fieldset className="field">
          <legend>Backend</legend>
          <RadioRow
            name="backend"
            value="programmatic"
            checked={backend === "programmatic"}
            onChange={() => setBackend("programmatic")}
            label="Programmatic"
            help="Parachute runs it headless — always on, sandboxed."
            testid="backend-programmatic"
          />
          <RadioRow
            name="backend"
            value="channel"
            checked={backend === "channel"}
            onChange={() => setBackend("channel")}
            label="Channel"
            help="You run a Claude Code session on your own machine and connect it — your env, unsandboxed."
            testid="backend-channel"
          />
        </fieldset>

        {/* System prompt → body.systemPrompt */}
        <div className="field">
          <label htmlFor="agent-prompt">System prompt</label>
          <textarea
            id="agent-prompt"
            rows={6}
            value={systemPrompt}
            placeholder="You are…"
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
          <p className="field-hint">
            The agent's persona + instructions (the note body). Leave blank for Claude
            Code's default.
          </p>
        </div>

        {/* Advanced (collapsed) — wants. */}
        <details
          className="advanced"
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>Advanced</summary>
          <div className="field">
            <label htmlFor="agent-wants">Wants (connections)</label>
            <input
              id="agent-wants"
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
        </details>

        <div className="form-actions">
          <button type="submit" disabled={!canSubmit}>
            {submit.kind === "submitting" ? "Creating…" : "Create agent"}
          </button>
          <Link to="/" className="cancel-link">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

/**
 * The `/create` route container: loads the def-vault list, then renders the
 * prop-driven {@link CreateAgent} form. Splitting the fetch from the form keeps
 * the form unit-testable without mocking the network. `CreateAgent` is remounted
 * (via `key`) once the vaults resolve so its default vault picks up the first.
 */
export function CreateAgentRoute() {
  type LoadState =
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ok"; vaults: AgentVaultRow[] };
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await listAgentVaults();
      setState({ kind: "ok", vaults: res.vaults });
    } catch (err) {
      const message =
        err instanceof HttpError
          ? err.status === 401
            ? "Not signed in to the hub — sign in to the portal, then reload."
            : `Failed to load def-vaults: ${err.message}`
          : `Failed to load def-vaults: ${(err as Error).message}`;
      setState({ kind: "error", message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "loading") {
    return <div className="loading">Loading…</div>;
  }
  if (state.kind === "error") {
    return (
      <div className="error-banner" role="alert">
        {state.message}{" "}
        <button type="button" className="secondary" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  // Remount on the resolved vault set so the form's default vault is the first.
  return <CreateAgent key={state.vaults.map((v) => v.vault).join(",")} vaults={state.vaults} />;
}

/** A labelled radio with a help line — the mode / backend rows. */
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

/**
 * Success state: confirms the created agent (name · mode · backend), links back
 * to the Agents list, and — for a channel backend — surfaces the connect-your-
 * session one-liner + a copy button.
 */
export function CreateSuccess({ result }: { result: CreateAgentDefResponse }) {
  const def = result.def;
  // The mode isn't echoed in the def detail shape, so re-derive it from the form
  // is unnecessary; the def's name/backend carry the confirmation. We surface the
  // backend (the def carries it) + the connect affordance keyed off it.
  return (
    <div data-testid="create-success">
      <h1>Agent created</h1>
      <div className="success-banner" role="status">
        <strong>{def.name}</strong> · {def.backend}
      </div>

      <p className="lede">
        The definition was written to <code>{def.vault}</code> and instantiated. It now
        appears in the <Link to="/">Agents list</Link>.
      </p>

      {def.backend === "channel" ? <ConnectSession name={def.name} /> : null}

      <p>
        <Link to="/">← Back to agents</Link>
      </p>
    </div>
  );
}

/** The channel-backend "connect your Claude Code session" affordance. */
export function ConnectSession({ name }: { name: string }) {
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const command = useMemo(() => connectSessionCommand(name, origin), [name, origin]);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (insecure context / denied) — the text is still
      // selectable; leave the button label unchanged.
    }
  }

  return (
    <section className="card" aria-label="Connect a session" data-testid="connect-session">
      <h2>Connect your Claude Code session</h2>
      <p className="muted">
        Run this on your own machine to make a Claude Code session a responder for this
        channel:
      </p>
      <div className="snippet-row">
        <code className="snippet" data-testid="connect-command">
          {command}
        </code>
        <button type="button" className="secondary" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="field-hint">
        Your Claude Code session pulls messages from this channel; until you connect,
        inbound messages queue durably in the vault.
      </p>
    </section>
  );
}
