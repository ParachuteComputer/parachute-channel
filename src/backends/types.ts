/**
 * The `AgentBackend` seam (design 2026-06-16-pluggable-agent-backend.md).
 *
 * A channel agent is "driven" in one of two ways, and the way is a swappable
 * choice behind ONE interface:
 *
 *   - **Interactive** (today's path): an idle interactive `claude` in a tmux pane,
 *     fed inbound messages by pushing onto a subscribed MCP "development channel."
 *     `start` = the tmux spawn (`spawnAgent`); `deliver` = a push onto the MCP GET
 *     stream. This backend carries the whole deaf-on-restart fragility class
 *     (no-loss high-water-mark + backlog replay #67, per-session restart #68, the
 *     dev-channels consent-gate auto-confirm #70/#71).
 *
 *   - **Programmatic** (this seam's first new implementor — `ProgrammaticBackend`):
 *     run ONE sandboxed `claude -p` turn per inbound message and capture the reply.
 *     There is no idle session, so there is nothing to go deaf, nothing to
 *     reconnect, no backlog to replay, no TUI gate to answer. `deliver` is a direct
 *     turn into a fresh `claude -p` invocation that resumes the channel's prior
 *     conversation (`--resume <session_id>`). The daemon turns the returned reply
 *     into an outbound `#agent/message/outbound` note (the wiring follow-up).
 *
 * Everything ABOVE this seam is backend-agnostic: the vault message transport
 * (`#agent/message/{inbound,outbound}`), the chat UI, the sandbox/isolation
 * envelope, and the per-channel env/credential injection. Only the
 * "drive-the-agent" layer differs.
 *
 * ── The asymmetric delivery guarantee (design's load-bearing caveat) ────────────
 * The interactive `deliver` (push onto the MCP GET stream) can SILENTLY fail if
 * the session is deaf — it is `void` there only because the #67 high-water-mark +
 * backlog replay catches the gap out-of-band. The programmatic `deliver` is a
 * direct turn into a fresh invocation, so failure is observable INLINE. To stop the
 * interactive side's silent-loss footgun leaking into the programmatic contract,
 * `deliver` returns a {@link DeliverResult} discriminated union — the programmatic
 * backend reports `{ ok: false, error }` rather than swallowing a failure, and a
 * future interactive retrofit reports `{ ok: true }` once the push is enqueued
 * (its real durability staying in the #67 machinery, as today).
 *
 * NOTE: this PR defines the contract and ships the PROGRAMMATIC implementor only.
 * The interactive spawn (`spawnAgent`) is NOT refactored to implement this
 * interface here — that retrofit is the wiring follow-up. The shape is deliberately
 * chosen to fit both: `start(spec)` maps to either the tmux spawn or "open a
 * programmatic session," and `deliver(handle, message)` maps to either a push or a
 * `claude -p` turn.
 */

import type { AgentSpec } from "../sandbox/types.ts";
import type { InterimTurnEvent } from "./stream-json.ts";
import type { InboundAttachment } from "../transport.ts";

export type { InboundAttachment } from "../transport.ts";

export type { InterimTurnEvent } from "./stream-json.ts";

/**
 * A sink for interim turn progress (the streaming view, design
 * 2026-06-16-channel-architecture-post-programmatic.md build item #1). The backend
 * calls this as a turn runs — assistant text chunks, which tool the agent is using,
 * the session-establishing init — so the daemon can push live progress to the chat
 * UI WHILE the turn is in flight. It is ADDITIVE: the durable record is still the
 * final {@link DeliverResult} the backend returns. Optional on `deliver` — a backend
 * that can't stream (or a caller that doesn't want live progress) omits it and the
 * turn behaves exactly as before. MUST NOT throw (a throw would abort the drain);
 * the daemon's implementation swallows dead-stream errors.
 */
export type InterimSink = (event: InterimTurnEvent) => void;

/**
 * The Claude session UUID for ONE turn, RESOLVED BY THE CALLER (the registry) and
 * handed to the backend. The daemon owns the session UUID — it lives on the durable
 * `#agent/thread` note (`metadata.session`), NOT in a backend-private store — so the
 * caller decides, per turn, whether to CONTINUE a prior conversation or CREATE a new
 * one, and the backend just runs the turn it's handed:
 *  - `resume: true`  → `claude --resume <id> -p "…"` — continue a prior conversation
 *    (single-threaded turn 2+: the thread note already carries a session).
 *  - `resume: false` → `claude --session-id <id> -p "…"` — CREATE a session with this
 *    uuid (single-threaded first turn, or every multi-threaded fresh-per-fire turn).
 * `id` MUST be a valid UUID (the caller mints it via `crypto.randomUUID()` when there
 * is no prior session to resume).
 */
export interface TurnSession {
  /** The Claude session UUID for this turn. */
  id: string;
  /** true → --resume <id> (continue a prior conversation); false → --session-id <id> (create a new one). */
  resume: boolean;
}

/**
 * RUN CONTEXT for one turn (agent#162) — the runtime facts a programmatic `claude -p` turn
 * otherwise has NO way to know, so an agent stops FABRICATING them. A headless `-p` turn has
 * no clock and no notion of "which run this is": uni-weaver was openly inventing report
 * timestamps (a fixed `10:05` slot, the date "derived from context") because it couldn't read
 * a real clock mid-run. The daemon KNOWS these facts at dispatch time, so it injects them into
 * the turn (a concise, clearly-labeled preamble the agent reads) rather than letting the agent
 * guess. Cheap, and it removes a whole class of fabricated-time confusion.
 *
 * The backend renders this as a SHORT preamble prepended to the turn message — it never
 * mangles the agent's own system-prompt semantics. ADDITIVE: a caller that omits it leaves the
 * turn message exactly as before.
 */
export interface RunContext {
  /** The REAL wall-clock at dispatch (ISO 8601) — the authoritative clock the turn lacks. */
  now: string;
  /**
   * Whether this turn CONTINUES a prior conversation (`resumed`, single-threaded turn 2+) or
   * STARTS a fresh one (`new`, the first turn / every multi-threaded fire) — the cheap "which
   * run is this" signal the daemon already resolved (`TurnSession.resume`).
   */
  session: "new" | "resumed";
  /**
   * WHY this turn is running (provenance): a SCHEDULED job fire stamps `runner:<jobId>` (the
   * runner's sender provenance) → reported as the job id; anything else is an interactive /
   * delegated message → `interactive`. Lets a scheduled agent know it's a cron fire vs a live
   * reply. Absent when the inbound carried no sender.
   */
  firedBy?: string;
  /**
   * The thread's COMPLETED turn count BEFORE this turn (single-threaded's rolling counter;
   * 0 on the first turn). Best-effort — omitted when the daemon can't cheaply resolve it
   * (no durable thread store). So the agent can stamp "turn N" accurately.
   */
  priorTurnCount?: number;
}

/**
 * One entry in the composed system prompt — a `{ path, content }` pair the composer renders as
 * `# <path>\n\n<content>` (CONTENT only — NEVER metadata). The composed prompt is an ORDERED
 * LIST of these, three layers (DESIGN-2026-06-29-threads-roles-context.md): ① the thread's ROLES
 * (composed FIRST), ② the "self" entry (the def body, labeled by the def note's PATH) then the
 * thread's own CONTENT, ③ the EXTRA-CONTEXT loadout (`metadata.loadout` note paths). Each layer
 * is a list of these entries; the backend concatenates them in order.
 *
 * A thread that loads NOTHING (no roles, no thread content, no loadout — every current agent,
 * incl. the 4am steward weave) composes to EXACTLY its def body, prefixed by a single
 * `# <path>` header — the only change to such a prompt (the no-loadout/no-roles invariant).
 */
export interface LoadoutEntry {
  /** The note PATH — rendered as the entry's `# <path>` header AND the dedupe key. */
  path: string;
  /** The note CONTENT (body only — NEVER metadata). Blank/whitespace entries are skipped. */
  content: string;
}

/**
 * The total composed-system-prompt BUDGET (bytes, UTF-8). When the composed prompt exceeds
 * this, the composer truncates the LOADOUT TAIL FIRST — NEVER the PROTECTED leading entries
 * (the def body, entry 0, and — when present — the thread content, entry 1; see
 * `protectedCount` on {@link composeSystemPrompt}) — with a loud warn (threads-only Phase A,
 * §9.5 / R5; thread-content protection — DESIGN-2026-06-29-thread-content-and-skills.md).
 *
 * Chosen sane cap: 600_000 bytes (~150k tokens at ~4 bytes/token). Claude's context window is
 * ~200k tokens; this leaves headroom for the turn message, attachments, and tool I/O while
 * bounding an accreting loadout so it can't silently blow the context (or degrade the steward
 * mid-tend). The cap is on the composed PROMPT FILE (bytes), not a token count — a sane,
 * cheap-to-enforce ceiling, documented here as the single source of truth.
 */
export const LOADOUT_BUDGET_BYTES = 600_000;

/**
 * Compose a thread's system prompt from an ORDERED LIST of loaded notes (threads-only Phase A).
 * The MECHANICAL shape (DESIGN §1):
 *
 *   composed = entries
 *     .filter(dedupe by path)          // first occurrence wins
 *     .filter(content.trim().length>0) // skip blank/whitespace entries
 *     .map(`# ${path}\n\n${content}`)  // CONTENT only, path as header
 *     .join("\n\n---\n\n")
 *
 * Then enforce {@link LOADOUT_BUDGET_BYTES}: if the composed byte length exceeds the cap,
 * drop trailing LOADOUT entries until it fits — the PROTECTED leading entries are NEVER
 * truncated. `protectedCount` (default 1) is how many leading entries are load-bearing — the
 * caller counts its protected PREFIX: the ROLES (layer ①, composed first), the self entry (the
 * def body), and the thread-content entry (layer ②) when present
 * (DESIGN-2026-06-29-threads-roles-context.md). With no roles + no thread content it is 1 (the
 * self entry alone — the no-loadout default); each role adds one, and thread content adds one.
 * Only entries beyond the protected prefix (the layer-③ extra-context loadout) shed (tail-first).
 * A loud warn fires on truncation (via `onWarn`, defaulting to console.warn).
 *
 * The NO-LOADOUT INVARIANT: with exactly one (self) entry whose content is the def body, the
 * result is `# <path>\n\n<body>` where `<body>` is byte-identical to the def body — the single
 * header line is the ONLY change to a no-loadout (e.g. the steward weave) prompt.
 *
 * PURE (apart from the injectable `onWarn`). The caller resolves the entries (self [+ thread
 * content] + loadout notes) and supplies them in order, and tells us how many leading entries
 * are protected; this function only dedupes, skips, renders, and budgets. The caller MUST keep
 * `protectedCount` consistent with the entries it passed — only include a non-blank protected
 * entry and count it (a blank protected entry would be skipped below, shifting the prefix).
 */
export function composeSystemPrompt(
  entries: LoadoutEntry[],
  opts?: { budgetBytes?: number; onWarn?: (msg: string) => void; protectedCount?: number },
): string {
  const budget = opts?.budgetBytes ?? LOADOUT_BUDGET_BYTES;
  const warn = opts?.onWarn ?? ((m: string) => console.warn(m));
  const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

  // Dedupe by path (first occurrence wins) + skip blank/whitespace content. The protected
  // leading entries (the self entry at index 0, and the thread content at index 1 when the
  // caller inserted it) are processed exactly like the rest — but they lead, so the budget
  // step below never drops them (the def body + thread content survive any over-budget loadout).
  const seen = new Set<string>();
  const kept: LoadoutEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    if (e.content.trim().length === 0) continue;
    kept.push(e);
  }

  const render = (es: LoadoutEntry[]): string =>
    es.map((e) => `# ${e.path}\n\n${e.content}`).join("\n\n---\n\n");

  let composed = render(kept);
  if (byteLen(composed) <= budget) return composed;

  // OVER BUDGET — keep the PROTECTED leading entries (the def body, and the thread content
  // when present) ALWAYS, then keep loadout entries from the front while they fit and STOP at
  // the first that doesn't (tail-drop: the loadout's order IS its priority — earlier notes win,
  // the tail is shed first). The protected prefix survives even if it alone exceeds the budget.
  const protect = Math.min(Math.max(opts?.protectedCount ?? 1, 0), kept.length);
  const fit: LoadoutEntry[] = kept.slice(0, protect);
  for (let i = protect; i < kept.length; i++) {
    if (byteLen(render([...fit, kept[i]!])) <= budget) fit.push(kept[i]!);
    else break;
  }
  const dropped = kept.slice(fit.length).map((e) => e.path);
  composed = render(fit);
  warn(
    `parachute-agent: LOADOUT over budget (${byteLen(render(kept))} > ${budget} bytes) — ` +
      `truncated ${dropped.length} loadout note(s), NEVER the def or thread content. ` +
      `Dropped: ${dropped.join(", ")}`,
  );
  return composed;
}

/**
 * An opaque handle to a started agent, returned by {@link AgentBackend.start} and
 * passed back to `deliver`/`stop`/`status`. The only field the seam itself depends
 * on is `channel` (the wake channel a turn/push targets) + the backend's own
 * `backend` tag; a backend may carry additional private fields it needs.
 */
export interface AgentHandle {
  /** Which backend produced this handle (so a multiplexer can route correctly). */
  backend: string;
  /** The wake channel this agent serves (the first channel of its spec). */
  channel: string;
  /** The agent's slug name (the spec name). */
  name: string;
  /**
   * The spec the agent was started from. The programmatic backend reproduces each
   * turn (its mint scope + sandbox policy) from this; a backend that keeps a
   * resident process (interactive) need not read it. Optional so the seam doesn't
   * force every backend to round-trip the whole spec on its handle.
   */
  spec?: AgentSpec;
}

/**
 * Token usage for one turn, surfaced for observability (cost/quota awareness — the
 * programmatic backend draws on the operator's subscription quota, a real capacity
 * limit per the design). Shape mirrors what `claude -p`'s `result` event reports;
 * fields are optional because a backend may not have them.
 */
export interface DeliverUsage {
  inputTokens?: number;
  outputTokens?: number;
  /**
   * The `result` event's `total_cost_usd` — an EQUIVALENT-cost figure on the
   * subscription path (NOT a charge; the turn draws on the subscription, design §1
   * of the pluggable-backend doc). Surfaced for observability only.
   */
  totalCostUsd?: number;
}

/**
 * The result of delivering one message — a discriminated union so a failure is
 * always observable inline (never a silent drop). On success the daemon turns
 * `reply` into an outbound `#agent/message/outbound` note (the wiring follow-up).
 */
export type DeliverResult =
  | {
      ok: true;
      /** The agent's reply text (the `result` event's `result` field). */
      reply: string;
      /**
       * The session id this turn ran under — captured + persisted so the NEXT turn
       * resumes the same conversation (`--resume <sessionId>`). Absent if the turn
       * produced no id (degenerate output).
       */
      sessionId?: string;
      /** Optional token/cost usage for observability. */
      usage?: DeliverUsage;
    }
  | {
      ok: false;
      /** A human-readable failure reason (does NOT throw — failure is a value). */
      error: string;
      /**
       * The session id, if one was captured before the failure — so a follow-up
       * turn can still resume (a turn can fail AFTER establishing a session).
       */
      sessionId?: string;
    };

/** The live/health status of a started agent (for `/health`). */
export interface AgentStatus {
  live: boolean;
}

/**
 * The pluggable agent-driving seam. A channel chooses a backend; the daemon calls
 * this interface and stays strategy-agnostic.
 */
export interface AgentBackend {
  /** A stable identifier for the backend kind (e.g. "programmatic", "interactive"). */
  readonly kind: string;

  /**
   * Bring an agent up for a channel from its spec. For the programmatic backend
   * this is lightweight (there is no resident process to launch — and no session to
   * pre-establish: the session uuid is resolved per turn by the caller and lives on
   * the durable `#agent/thread` note); for the interactive backend it is the tmux
   * spawn. Returns an opaque handle the other methods take.
   */
  start(spec: AgentSpec): Promise<AgentHandle>;

  /**
   * Hand the agent one inbound message and get its reply. Returns a
   * {@link DeliverResult} — a failure is a value (`{ ok: false, error }`), NEVER a
   * throw, so the caller always learns the outcome inline (the asymmetric-guarantee
   * fix). The daemon serializes deliveries per channel (one turn at a time).
   *
   * `session` is the {@link TurnSession} the CALLER resolved for this turn — the
   * daemon owns the session UUID (it lives on the durable `#agent/thread` note, not a
   * backend store), so the caller decides resume-existing (`resume: true` →
   * `--resume <id>`) vs create-new (`resume: false` → `--session-id <id>`). The
   * backend just runs the turn with that uuid; it no longer reads or writes any
   * session store. The captured/echoed id still comes back on the
   * {@link DeliverResult} (`sessionId`) so the caller can persist it onto the note.
   *
   * `onInterim` (optional) is the streaming-view sink: the backend calls it with
   * interim progress (assistant text chunks + tool_use) AS the turn runs, so the
   * daemon can render "watch it work" live in the chat UI. ADDITIVE — when omitted,
   * the turn behaves exactly as before; the final {@link DeliverResult} is the
   * durable record either way. (Only the programmatic backend streams today; an
   * interactive retrofit may ignore it.)
   *
   * `attachments` (optional, Phase 1) are files attached to the inbound message. The
   * programmatic backend stages each into the agent's PRIVATE session workspace (under
   * a safe basename) before the turn and appends a workspace-relative pointer to the
   * prompt, so the `claude -p` turn can `Read` them. ADDITIVE — absent/empty → no
   * staging, the turn behaves exactly as before.
   *
   * `runContext` (optional, agent#162) is the runtime context the daemon knows but a headless
   * `-p` turn can't (the real wall-clock, whether this run is new vs resumed, why it fired).
   * The programmatic backend prepends it as a concise, clearly-labeled preamble to the turn
   * message so the agent stamps ACCURATE times instead of fabricating them. ADDITIVE — omitted
   * → the turn message is exactly as before.
   *
   * `loadout` (optional, the layer-③ EXTRA CONTEXT — DESIGN-2026-06-29-threads-roles-context.md)
   * is the thread's ORDERED LIST of extra-context notes (skills, references), composed AFTER the
   * thread content. The programmatic backend folds them into the SYSTEM prompt via
   * {@link composeSystemPrompt}: `[...roles, self, thread-content, ...loadout]` deduped by path,
   * blank-skipped, each rendered `# <path>\n\n<content>`, joined by `\n\n---\n\n`, then budgeted
   * ({@link LOADOUT_BUDGET_BYTES}, truncating loadout-notes-first, NEVER the protected prefix —
   * roles + self + thread content). ADDITIVE — omitted/empty + no roles + no thread content → the
   * system prompt is `# <path>\n\n<def body>`, byte-identical to HEAD APART FROM the single
   * `# <path>` header (the no-loadout invariant). The run-context preamble is unaffected (it stays
   * on the MESSAGE). Distinct from `roles`: loadout is CONTENT-only (never grants); roles carry
   * capability and compose FIRST.
   *
   * `subject` (optional, roles×threads NEXT slice #120) is the thread SUBJECT — the programmatic
   * backend keys the agent's PER-THREAD private session workspace off it
   * (`sessions/<name>--<slug(subject)>/`), so concurrent subjects of one multi-threaded agent get
   * ISOLATED per-turn files (`.mcp.json`, `system-prompt.txt`, HOME, attachment staging) and never
   * clobber each other. ADDITIVE — omitted/empty → `sessions/<name>/` (byte-identical to HEAD;
   * the null-subject invariant). Distinct from `loadout` (which is prompt CONTENT); this is
   * the workspace IDENTITY.
   *
   * `roleKeys` (optional, roles as the capability layer — DESIGN-2026-06-29-threads-roles-context.md)
   * is the list of hub grant-holder KEYS for the thread's ROLES — the slugged PATH (`rolePathKey`)
   * of every note in `metadata.roles` that is an `#agent/role` declaring `wants:`. The programmatic
   * backend UNIONS each role's APPROVED grants with the def's own (`spec.name`), so a thread that
   * loads a role gains that role's capabilities. The SECURITY GATE — a non-role note's `wants:` is
   * IGNORED — is enforced where `roleKeys` is built (the transport reads the role notes' METADATA).
   * ADDITIVE — omitted/empty (every current agent; no thread loads a role with `wants:` today) →
   * the grant source set is exactly `[spec.name]`, BYTE-IDENTICAL to the legacy single-source
   * injection (legacy continuity).
   *
   * `threadContent` (optional, the layer-② THREAD content — DESIGN-2026-06-29-threads-roles-context.md)
   * is THIS thread's own standing context — the thread note's authored BODY (`{ path, content }`,
   * CONTENT only, the thread-note path as the header). The programmatic backend composes it
   * BETWEEN the def (self) and the loadout: `[...roles, self, thread-content, ...loadout]`. It is
   * load-bearing like the def — composed inside the protected prefix so an over-budget loadout
   * sheds its tail but NEVER the roles, the def, or the thread content. ADDITIVE — omitted, or
   * blank/whitespace content → the thread-content entry is skipped (the no-thread-content
   * invariant). The daemon NEVER writes this content; a human/agent authors it on the thread note
   * and the backend reads it CONTENT-only each turn.
   *
   * `roles` (optional, the layer-① ROLES — DESIGN-2026-06-29-threads-roles-context.md) is the
   * thread's ORDERED LIST of role-note CONTENT entries (`{ path, content }`), composed FIRST —
   * before the def (self) — as the reusable "hat(s)" the thread wears. The programmatic backend
   * prepends them: `[...roles, self, thread-content, ...loadout]`, and they sit inside the
   * PROTECTED prefix (never truncated). Each role's CAPABILITIES ride SEPARATELY on `roleKeys`
   * (content here, grants there — one role note, read once). ADDITIVE — omitted/empty → the
   * prompt is `[self, thread-content, ...loadout]` exactly as before this layer (the no-roles
   * invariant). Blank/whitespace role entries are skipped (the composer skips blank content).
   */
  deliver(
    handle: AgentHandle,
    message: string,
    session: TurnSession,
    onInterim?: InterimSink,
    attachments?: InboundAttachment[],
    runContext?: RunContext,
    loadout?: LoadoutEntry[],
    subject?: string,
    roleKeys?: string[],
    threadContent?: LoadoutEntry,
    roles?: LoadoutEntry[],
  ): Promise<DeliverResult>;

  /**
   * Tear the agent down. For the programmatic backend this is a NO-OP — there is no
   * resident process to kill and no session store to clear (the session lives on the
   * durable `#agent/thread` note), so stop does NOT reset conversation continuity; the
   * interactive backend kills the tmux session.
   */
  stop(handle: AgentHandle): Promise<void>;

  /** Report whether the agent is live (for `/health`). */
  status(handle: AgentHandle): Promise<AgentStatus>;
}
