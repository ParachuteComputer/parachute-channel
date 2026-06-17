/**
 * Per-channel delivery high-water-mark — the spine of the no-silent-loss fix.
 *
 * THE PROBLEM. The vault-backed inbound pipeline wakes a session by `ctx.emit`
 * fanning a new `#agent-message/inbound` note to whatever SSE bridges + HTTP
 * MCP sessions are live on the channel. But:
 *  - the daemon acks the vault trigger `{ok:true}` regardless of how many
 *    subscribers actually received it, and the vault stamps `..._rendered_at` on
 *    the note so the trigger never re-fires — so a note delivered to ZERO live
 *    subscribers is lost from the live path (it stays durable in the vault, but
 *    no session is ever woken on it); and
 *  - MCP sessions drop on every daemon restart and only reconnect on the next
 *    interaction, so any inbound that lands during that deaf window reaches no
 *    one.
 *
 * THE FIX. Track, per channel, the timestamp of the last inbound message we
 * actually DELIVERED to at least one live subscriber (the high-water-mark). On
 * (re)connect, a session replays the backlog of inbound notes with `ts` newer
 * than that mark — so messages that arrived while nobody was listening get
 * delivered the moment a session attaches. `emit` advances the mark only on a
 * real delivery (≥1 subscriber); a 0-subscriber emit leaves the mark behind so
 * the message replays later.
 *
 * THE MARK IS MONOTONIC. `advance` only ever moves the mark FORWARD. Out-of-order
 * or duplicate deliveries can never rewind it (which would re-replay already-seen
 * messages). ISO-8601 timestamps compare correctly as strings (lexicographic ==
 * chronological for the `Z`-suffixed UTC form the vault writes), so the compare is
 * a plain string `>`.
 *
 * DEFAULT = BOOT TIME. A channel with no persisted mark defaults to the daemon's
 * boot time — NOT epoch. This is deliberate: on a FIRST connect we must not
 * replay the channel's entire (possibly ancient) vault history as if it were all
 * unread. The only messages a fresh mark replays are ones that arrived AFTER the
 * daemon started (the genuine deaf-window case). Persisted marks survive restarts,
 * so a channel that has been delivering keeps its real high-water-mark across a
 * bounce and replays exactly the restart gap.
 *
 * PERSISTENCE. The marks live in a single small JSON file under the channel state
 * dir (`<PARACHUTE_AGENT_STATE_DIR>/delivery-state.json`, default
 * `~/.parachute/agent/delivery-state.json`). Writes are write-through but
 * resilient: a failed write is logged and swallowed — losing a mark only costs a
 * bounded re-replay, never a crash. Load-on-construct reads the file once.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { defaultStateDir } from "./registry.ts";

/** The on-disk shape: `{ "<channel>": "<iso-ts>", ... }`. */
type DeliveryStateFile = Record<string, string>;

export interface DeliveryStateOptions {
  /** State dir for the persisted file. Defaults to the channel state dir. */
  stateDir?: string;
  /**
   * The default mark for a channel with no persisted entry — an ISO timestamp.
   * The daemon passes its boot time so a first connect never replays ancient
   * history. Defaults to "now" at construction if omitted.
   */
  defaultMark?: string;
}

/**
 * Per-channel last-delivered high-water-mark store. One instance per daemon;
 * constructed at boot with the boot time as the default mark, then read/advanced
 * on every emit + every (re)connect. Each instance owns its own file + in-memory
 * map, so tests construct throwaway instances pointed at a temp dir with no
 * global state to reset.
 */
export class DeliveryState {
  private readonly file: string;
  private readonly defaultMark: string;
  private readonly marks: Map<string, string> = new Map();

  constructor(opts: DeliveryStateOptions = {}) {
    const stateDir = opts.stateDir ?? defaultStateDir();
    this.file = join(stateDir, "delivery-state.json");
    this.defaultMark = opts.defaultMark ?? new Date().toISOString();
    this.load();
  }

  /** Read the persisted marks once at construction. Missing/corrupt file → empty. */
  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      // No file yet (first boot) — start empty; the default mark covers unknowns.
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as DeliveryStateFile)) {
          if (typeof v === "string" && v) this.marks.set(k, v);
        }
      }
    } catch (err) {
      // Corrupt file — log and start empty rather than crash. The marks rebuild
      // from boot-time defaults; the cost is a bounded re-replay, not a loss.
      console.warn(
        `parachute-agent: delivery-state file ${this.file} is unreadable (${(err as Error).message}); ` +
          `starting with empty marks.`,
      );
    }
  }

  /** Write the current marks through to disk. Best-effort: a failure is logged, never thrown. */
  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const obj: DeliveryStateFile = {};
      for (const [k, v] of this.marks) obj[k] = v;
      writeFileSync(this.file, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.warn(
        `parachute-agent: failed to persist delivery-state to ${this.file} ` +
          `(${(err as Error).message}); the mark is held in memory only.`,
      );
    }
  }

  /**
   * The last-delivered mark for a channel: the persisted value, or the daemon's
   * boot-time default when this channel has never delivered. Always an ISO string,
   * so callers can compare note timestamps against it with a plain string `>`.
   */
  getLastDelivered(channel: string): string {
    return this.marks.get(channel) ?? this.defaultMark;
  }

  /**
   * Move a channel's mark forward to `ts` IF it's newer than the current mark
   * (monotonic — never rewinds). Returns true if the mark advanced (and was
   * persisted), false if `ts` was not newer (no write). An empty/missing `ts` is
   * a no-op (we never advance to a blank mark — that would replay everything).
   */
  advance(channel: string, ts: string): boolean {
    if (!ts) return false;
    const current = this.getLastDelivered(channel);
    if (ts > current) {
      this.marks.set(channel, ts);
      this.persist();
      return true;
    }
    return false;
  }
}
