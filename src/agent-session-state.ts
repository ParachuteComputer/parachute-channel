/**
 * Per-channel `claude -p` session-id store — the spine of programmatic-backend
 * conversation continuity (design 2026-06-16-pluggable-agent-backend.md, the
 * `resume=session_id` row of the tradeoff table).
 *
 * THE MECHANIC (verified against claude 2.1.179). `claude -p "<msg>"
 * --output-format stream-json --verbose` runs ONE turn and emits a `session_id`
 * in its `system/init` + `result` events. To carry the conversation forward, the
 * NEXT turn passes `--resume <session_id>` — which restores full conversation
 * continuity. So:
 *
 *   - FIRST turn for a channel: no stored id → omit `--resume`; capture the
 *     `session_id` from the turn's output; persist it here.
 *   - SUBSEQUENT turns: read the stored id → pass `--resume <id>`; the reply
 *     continues the same conversation. The id is stable across turns.
 *
 * This store is the per-channel `<channel> → <session_id>` map that makes that
 * work across daemon restarts. It is modeled directly on `delivery-state.ts`: a
 * single small JSON file under the channel state dir, an injectable path for
 * tests, write-through-but-resilient persistence (a failed write is logged and
 * swallowed — losing the id only costs starting a fresh conversation, never a
 * crash), load-on-construct.
 *
 * NOT a high-water-mark — unlike delivery-state's monotonic ISO-timestamp mark,
 * a session-id is an opaque string with no ordering. `set` is a plain
 * last-write-wins overwrite (a newer turn for a channel may legitimately produce
 * a fresh session id — e.g. the prior conversation expired — and we want to track
 * the latest). `clear` drops a channel's id so the next turn starts fresh.
 *
 * SERIALIZATION is the daemon's job, not this store's. The programmatic backend
 * runs ONE turn at a time per channel (never two concurrent `claude -p` for the
 * same channel — that would fork the conversation); the daemon owns that serial
 * processing (the wiring follow-up). This store just records the latest id; it
 * does not itself guard against concurrent turns.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { defaultStateDir } from "./registry.ts";

/** The on-disk shape: `{ "<channel>": "<session_id>", ... }`. */
type AgentSessionStateFile = Record<string, string>;

export interface AgentSessionStateOptions {
  /** State dir for the persisted file. Defaults to the channel state dir. */
  stateDir?: string;
}

/**
 * Per-channel `claude -p` session-id store. One instance per daemon (or one per
 * backend); each owns its own file + in-memory map, so tests construct throwaway
 * instances pointed at a temp dir with no global state to reset.
 */
export class AgentSessionState {
  private readonly file: string;
  private readonly ids: Map<string, string> = new Map();

  constructor(opts: AgentSessionStateOptions = {}) {
    const stateDir = opts.stateDir ?? defaultStateDir();
    this.file = join(stateDir, "agent-session-state.json");
    this.load();
  }

  /** Read the persisted ids once at construction. Missing/corrupt file → empty. */
  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      // No file yet (first boot) — start empty; an unknown channel has no session.
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as AgentSessionStateFile)) {
          if (typeof v === "string" && v) this.ids.set(k, v);
        }
      }
    } catch (err) {
      // Corrupt file — log and start empty rather than crash. The cost is that
      // every channel starts a fresh conversation on the next turn, not a loss.
      console.warn(
        `parachute-agent: agent-session-state file ${this.file} is unreadable ` +
          `(${(err as Error).message}); starting with no resume ids.`,
      );
    }
  }

  /** Write the current ids through to disk. Best-effort: a failure is logged, never thrown. */
  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const obj: AgentSessionStateFile = {};
      for (const [k, v] of this.ids) obj[k] = v;
      // 0600 — a session id is a continuation handle to a conversation; treat it
      // as sensitive (same posture as the other channel state files).
      writeFileSync(this.file, JSON.stringify(obj, null, 2), { mode: 0o600 });
    } catch (err) {
      console.warn(
        `parachute-agent: failed to persist agent-session-state to ${this.file} ` +
          `(${(err as Error).message}); the session id is held in memory only.`,
      );
    }
  }

  /**
   * The stored `session_id` for a channel, or undefined when this channel has
   * never run a turn (→ the first turn omits `--resume`).
   */
  get(channel: string): string | undefined {
    return this.ids.get(channel);
  }

  /**
   * Record a channel's latest `session_id` (last-write-wins; write-through).
   * Called after a turn captures the id from `claude -p`'s output, so the NEXT
   * turn for the channel resumes it. A blank/empty id is a no-op (we never store a
   * blank — that would make the next turn pass `--resume ""`). Returns true if the
   * stored id changed (and was persisted).
   */
  set(channel: string, sessionId: string): boolean {
    if (!sessionId) return false;
    if (this.ids.get(channel) === sessionId) return false;
    this.ids.set(channel, sessionId);
    this.persist();
    return true;
  }

  /**
   * Drop a channel's stored id so its next turn starts a fresh conversation.
   * Returns true if an id existed (and the drop was persisted), false otherwise.
   */
  clear(channel: string): boolean {
    if (!this.ids.has(channel)) return false;
    this.ids.delete(channel);
    this.persist();
    return true;
  }
}
