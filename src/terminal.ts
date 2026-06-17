/**
 * In-page terminal backend for parachute-agent (design
 * `design/2026-06-14-sandboxed-agent-sessions.md` §5).
 *
 * Bridges a browser xterm.js terminal ↔ the agent daemon's own Bun WebSocket
 * server ↔ a session's tmux pane. The pty is **Bun's native terminal**
 * (`new Bun.Terminal({...})` + `Bun.spawn({ terminal })`), spawned to run
 * `tmux attach -t <name>-agent` — the SAME tmux session `scripts/launch-session.sh`
 * creates (session name `<name>-agent`, `launch-session.sh:38`). Attaching to
 * tmux (not a raw pty) is what makes a dropped WS re-attach to the LIVE session
 * with scrollback intact (§5.4 reconnect): the session keeps running in tmux
 * regardless of who is watching.
 *
 * THE LOAD-BEARING DESIGN ITEM — backpressure (§5.4, R1). The hub's WS bridge
 * (`parachute-hub/src/ws-bridge.ts`) enforces a fixed 8 MiB buffered-bytes cap
 * that closes BOTH sides on overflow and is NOT per-connection tunable. A
 * terminal legitimately floods it (a big build log, `yes`, `cat` of a large
 * file). The bridge is a blind pipe with no flow-control hook, so the flow
 * control MUST live here: the agent daemon holds the upstream end of the
 * terminal socket as a `ServerWebSocket` and so has `ws.getBufferedAmount()`
 * natively. We watch our OWN send-buffer depth and PAUSE reading from the pty
 * (Bun.Terminal supports this implicitly — we stop forwarding its `data` and
 * coalesce into a bounded queue) when buffered bytes climb toward a safe
 * fraction of the cap, resuming when the client drains (the `drain` handler).
 * Net effect: a flood NEVER lets a single terminal's buffered bytes approach
 * 8 MiB, so the hub's blunt cap is a safety net that never fires in normal use.
 *
 * Frame protocol (§5.5):
 *   - BINARY frames are raw pty bytes, both directions (input keystrokes
 *     client→pty, output bytes pty→client) — the terminal's natural stream.
 *   - TEXT frames are JSON CONTROL frames, disambiguated by being valid JSON
 *     with a `type` field. The only one in v1 is
 *     `{ "type": "resize", "cols": <n>, "rows": <n> }` → `terminal.resize`.
 *   Raw input that happens to be a text frame is impossible in practice
 *   (xterm sends keystrokes as binary), but we fail safe: a text frame that
 *   does NOT parse as a control object is forwarded to the pty as input.
 *
 * Auth is NOT in this module — it runs in the daemon's upgrade gate (operator-
 * grade `agent:admin`, token via `?token=`, BEFORE `server.upgrade`). By the
 * time `open()` runs the socket is already authorized. This module owns the
 * pty↔WS relay + flow control only.
 */

import type { ServerWebSocket } from "bun";

/**
 * The hub WS bridge's hard cap (`DEFAULT_MAX_BUFFERED_BYTES`,
 * `parachute-hub/src/ws-bridge.ts:55`). Mirrored here as the ceiling our flow
 * control must stay UNDER — if our buffered bytes ever reach this, the hub
 * closes both sides. Kept as a named constant so the relationship to the hub is
 * explicit and a future hub bump is a one-line change here.
 */
export const HUB_WS_CAP_BYTES = 8 * 1024 * 1024;

/**
 * Pause reading the pty when our socket's buffered bytes climb past this
 * fraction of the hub cap; resume when they fall back under {@link RESUME_FRAC}.
 * 0.5 / 0.25 leaves a wide margin below the 8 MiB ceiling so a burst that
 * arrives between two backpressure checks still can't reach it. The gap between
 * the two fractions is hysteresis — it stops us flapping pause/resume on every
 * frame near the threshold.
 */
export const PAUSE_FRAC = 0.5;
export const RESUME_FRAC = 0.25;

/**
 * Cap on bytes we'll hold in the per-connection coalesce queue while paused.
 * The queue exists so a brief pause doesn't drop pty output; but a client that
 * NEVER drains can't make us buffer unboundedly in the daemon either. If the
 * queue exceeds this while the socket is also full, the client is hopelessly
 * behind — we close it (1013, "try again later") rather than OOM the daemon.
 * Generous (16 MiB) so only a truly stuck client trips it.
 */
export const MAX_QUEUE_BYTES = 16 * 1024 * 1024;

/** Per-connection state attached to `ws.data` for a terminal socket. */
export interface TerminalWsData {
  /** The tmux session this socket attaches to (`<name>-agent`). */
  readonly session: string;
  /** The channel name (for logging / future per-channel policy). */
  readonly channel: string;
  /** Initial terminal geometry from the upgrade query (xterm's first fit). */
  readonly cols: number;
  readonly rows: number;
  /** Internal relay state — attached by `open()`, owned by this module. */
  _term?: TerminalState;
}

/** A control frame the client sends over a TEXT frame. */
type ControlFrame = { type: "resize"; cols: number; rows: number };

interface TerminalState {
  /** The Bun pty running `tmux attach`. */
  terminal: BunTerminal;
  proc: { readonly exited: Promise<number>; kill(signal?: number | string): void };
  /** Coalesced pty output waiting while the socket is over the pause mark. */
  queue: Uint8Array[];
  queuedBytes: number;
  /** True while we're holding pty output because the socket buffer is high. */
  paused: boolean;
  /** Set once teardown started — makes close idempotent across the pty/WS races. */
  closed: boolean;
}

/**
 * The slice of `Bun.Terminal` this module uses. Declared structurally so tests
 * can inject a fake without spawning a real pty (and so the module doesn't hard-
 * depend on the global `Bun` shape at type-check time across Bun versions).
 */
export interface BunTerminal {
  // Accept the broad input shape Bun's `Terminal.write` takes, plus a plain
  // `Uint8Array` — the WS `message` callback hands us a `Buffer` (a Uint8Array
  // subclass whose backing buffer types as `ArrayBufferLike`), so the param is
  // widened to `string | ArrayBufferView | ArrayBufferLike` to take it without
  // a cast at every call site.
  write(data: string | ArrayBufferView | ArrayBufferLike): number;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** What `spawnTerminal` returns — the pty plus the child's exit promise. */
export interface SpawnedTerminal {
  terminal: BunTerminal;
  proc: { readonly exited: Promise<number>; kill(signal?: number | string): void };
}

/**
 * Spawn a Bun pty attached to a tmux session. Injectable so the relay can be
 * unit-tested against a fake pty (no tmux, no real subprocess). The default
 * implementation runs `tmux attach -t <session>` inside a fresh `Bun.Terminal`,
 * wiring its `data` callback to `onData` (pty output) and `exit` to `onExit`.
 *
 * `tmux attach` (not a raw shell) is deliberate: the session is owned by tmux,
 * so this pty is just a *viewer*. Dropping it leaves the session alive; a
 * reconnect re-attaches with scrollback. `-t <session>` targets the exact
 * session `launch-session.sh` made (`<name>-agent`).
 */
export type SpawnTerminalFn = (
  session: string,
  opts: {
    cols: number;
    rows: number;
    onData: (bytes: Uint8Array) => void;
    onExit: () => void;
  },
) => SpawnedTerminal;

/**
 * The env for the `tmux attach` viewer process: the inherited env with TERM
 * forced to a real terminfo entry matching the pty (`xterm-256color`). The daemon
 * runs under launchd/systemd with NO TERM, so without this `tmux attach` can't
 * find terminfo and aborts "open terminal failed: terminal does not support
 * clear" — the WS attaches but the pane shows only that error. Pure + exported so
 * the wiring is unit-testable without fighting Bun's readonly globals.
 */
export function tmuxAttachEnv(
  parentEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return { ...parentEnv, TERM: "xterm-256color" };
}

/** Default pty spawn — the real `Bun.Terminal` + `tmux attach`. */
export const defaultSpawnTerminal: SpawnTerminalFn = (session, opts) => {
  // `Bun.Terminal` is the native pty (verified present with write/resize/
  // setRawMode/data/exit on channel's pinned Bun 1.3.13 — see the design's R2
  // version-floor note; the floor is met). The `data` callback IS the pty
  // output stream; `exit` fires when the pty closes (tmux detach / session
  // gone). We do NOT setRawMode here — tmux owns the inner pty's mode; this
  // outer viewer pty passes bytes through untouched.
  const TerminalCtor = (globalThis as { Bun?: { Terminal?: new (o: unknown) => BunTerminal } })
    .Bun?.Terminal;
  if (!TerminalCtor) {
    throw new Error(
      "Bun.Terminal is unavailable — the in-page terminal needs Bun ≥ 1.3.13 " +
        "(with the native pty API). Upgrade Bun, or use `tmux attach -t <name>-agent` on the host.",
    );
  }
  const terminal = new TerminalCtor({
    cols: opts.cols,
    rows: opts.rows,
    name: "xterm-256color",
    data: (_t: unknown, bytes: Uint8Array) => opts.onData(bytes),
    exit: () => opts.onExit(),
  });
  // `tmux attach -t <session>` — attach this viewer pty to the live session.
  const proc = (
    globalThis as {
      Bun: { spawn: (cmd: string[], o: unknown) => SpawnedTerminal["proc"] };
    }
  ).Bun.spawn(["tmux", "attach", "-t", session], {
    terminal,
    // TERM forced to a real terminfo entry (see tmuxAttachEnv) so `tmux attach`
    // doesn't abort "does not support clear". No further scrub: this pty only
    // TALKS to the already-running tmux server; it never starts the Claude session
    // (that's the sandboxed spawn path, §4).
    env: tmuxAttachEnv(),
    stdout: "ignore",
    stderr: "ignore",
  });
  return { terminal, proc };
};

/**
 * Parse a TEXT frame as a control frame. Returns the control object, or null
 * if it isn't one (so the caller forwards the bytes to the pty as input — fail
 * safe). Only `resize` exists in v1; an unknown `type` is treated as not-a-
 * control-frame and forwarded (forward-compat: a future client control frame
 * an old daemon doesn't know just reaches the pty harmlessly as input bytes,
 * which tmux/the shell ignores or echoes — never a crash).
 */
export function parseControlFrame(text: string): ControlFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.type === "resize" && Number.isFinite(o.cols) && Number.isFinite(o.rows)) {
    // Clamp to sane bounds — a malicious/buggy client can't ask for a 0×0 or a
    // 100000-column pty (ioctl winsize is u16; out-of-range is rejected/garbage).
    const cols = clampDim(o.cols as number);
    const rows = clampDim(o.rows as number);
    return { type: "resize", cols, rows };
  }
  return null;
}

/** Clamp a terminal dimension to [1, 9999] (winsize is a u16). */
function clampDim(n: number): number {
  const v = Math.floor(n);
  if (!Number.isFinite(v) || v < 1) return 1;
  if (v > 9999) return 9999;
  return v;
}

/**
 * Build the Bun.serve `websocket` handler set for terminal sockets. One handler
 * object serves every terminal connection; per-connection state lives on
 * `ws.data._term`. Pure over its deps so tests drive it with a fake pty + a
 * fake `ServerWebSocket`.
 *
 * Backpressure contract (the load-bearing part): every pty→client write checks
 * `ws.getBufferedAmount()`. Past {@link PAUSE_FRAC} of the hub cap we stop
 * forwarding pty output (it accumulates in a bounded coalesce queue); Bun's
 * `drain` callback fires when the socket buffer empties, where we flush the
 * queue and, once under {@link RESUME_FRAC}, resume live forwarding. A flood
 * therefore parks in our queue (bounded, daemon-side) instead of the hub's
 * buffer — the hub cap never trips.
 */
export function createTerminalWsHandlers(
  deps: {
    spawnTerminal?: SpawnTerminalFn;
    /** Override the hub cap (tests use a tiny value). */
    capBytes?: number;
    logger?: Pick<Console, "warn">;
  } = {},
) {
  const spawn = deps.spawnTerminal ?? defaultSpawnTerminal;
  const cap = deps.capBytes ?? HUB_WS_CAP_BYTES;
  const pauseAt = cap * PAUSE_FRAC;
  const resumeAt = cap * RESUME_FRAC;
  const logger = deps.logger ?? console;

  /** Tear both pty + socket down exactly once. */
  function teardown(
    ws: ServerWebSocket<TerminalWsData>,
    state: TerminalState,
    code: number,
    reason: string,
  ): void {
    if (state.closed) return;
    state.closed = true;
    try {
      state.terminal.close();
    } catch {
      // pty already closed — best-effort.
    }
    try {
      // Kill the `tmux attach` viewer process (detaches; the session lives on).
      state.proc.kill();
    } catch {
      // already exited.
    }
    try {
      ws.close(code, reason);
    } catch {
      // already closing.
    }
  }

  /**
   * Forward one pty output chunk to the client, applying flow control. If the
   * socket is already over the pause mark we queue instead of sending; a queue
   * that overflows {@link MAX_QUEUE_BYTES} means the client is hopelessly
   * behind → close it (rather than buffer unboundedly in the daemon).
   */
  function forwardOrQueue(
    ws: ServerWebSocket<TerminalWsData>,
    state: TerminalState,
    bytes: Uint8Array,
  ): void {
    if (state.closed) return;
    if (state.paused) {
      enqueue(ws, state, bytes);
      return;
    }
    // `send` returns the byte count, -1 on backpressure, 0 if dropped. We don't
    // branch on it directly — we read the authoritative buffered depth right
    // after and decide pause from THAT (one source of truth).
    ws.send(bytes);
    if (ws.getBufferedAmount() >= pauseAt) {
      state.paused = true;
    }
  }

  function enqueue(
    ws: ServerWebSocket<TerminalWsData>,
    state: TerminalState,
    bytes: Uint8Array,
  ): void {
    state.queue.push(bytes);
    state.queuedBytes += bytes.byteLength;
    if (state.queuedBytes > MAX_QUEUE_BYTES) {
      logger.warn(
        `[terminal] client for tmux "${ws.data.session}" is too far behind ` +
          `(queued ${state.queuedBytes} bytes) — closing to protect the daemon`,
      );
      teardown(ws, state, 1013, "terminal consumer too slow");
    }
  }

  /** Drain the coalesce queue into the socket until it fills again or empties. */
  function flushQueue(ws: ServerWebSocket<TerminalWsData>, state: TerminalState): void {
    while (state.queue.length > 0 && !state.closed) {
      // Stop early if sending would push us back over the pause mark — leave the
      // rest queued for the next drain.
      if (ws.getBufferedAmount() >= pauseAt) return;
      const chunk = state.queue.shift()!;
      state.queuedBytes -= chunk.byteLength;
      ws.send(chunk);
    }
  }

  return {
    /**
     * A connection was accepted (auth already passed in the daemon's upgrade
     * gate). Spawn the pty attached to the tmux session and start relaying.
     */
    open(ws: ServerWebSocket<TerminalWsData>) {
      const data = ws.data;
      const state: TerminalState = {
        terminal: undefined as unknown as BunTerminal,
        proc: undefined as unknown as TerminalState["proc"],
        queue: [],
        queuedBytes: 0,
        paused: false,
        closed: false,
      };
      data._term = state;

      let spawned: SpawnedTerminal;
      try {
        spawned = spawn(data.session, {
          cols: data.cols,
          rows: data.rows,
          onData: (bytes) => forwardOrQueue(ws, state, bytes),
          // The pty closed (tmux detached / session gone). Tear the socket down
          // with a clean code so the browser shows "session ended", not an error.
          onExit: () => teardown(ws, state, 1000, "terminal session ended"),
        });
      } catch (err) {
        logger.warn(
          `[terminal] failed to attach to tmux session "${data.session}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        try {
          ws.close(1011, "failed to attach terminal session");
        } catch {
          /* already closing */
        }
        return;
      }
      state.terminal = spawned.terminal;
      state.proc = spawned.proc;
    },

    /**
     * A frame from the client. BINARY = raw pty input (keystrokes). TEXT =
     * a JSON control frame (resize) — or, fail-safe, raw input if it doesn't
     * parse as one.
     */
    message(ws: ServerWebSocket<TerminalWsData>, message: string | Buffer) {
      const state = ws.data._term;
      if (!state || state.closed || !state.terminal) return;
      if (typeof message === "string") {
        const ctrl = parseControlFrame(message);
        if (ctrl) {
          try {
            state.terminal.resize(ctrl.cols, ctrl.rows);
          } catch {
            // pty gone mid-resize — the close/exit path handles teardown.
          }
          return;
        }
        // Not a control frame — forward as input (fail safe; see parseControlFrame).
        try {
          state.terminal.write(message);
        } catch {
          /* pty gone */
        }
        return;
      }
      // Binary input → straight to the pty.
      try {
        state.terminal.write(message);
      } catch {
        /* pty gone */
      }
    },

    /**
     * The socket's send buffer emptied (Bun fires this after backpressure
     * clears). Flush our coalesce queue, then — once under the resume mark —
     * resume live pty forwarding.
     */
    drain(ws: ServerWebSocket<TerminalWsData>) {
      const state = ws.data._term;
      if (!state || state.closed) return;
      flushQueue(ws, state);
      if (state.paused && ws.getBufferedAmount() <= resumeAt && state.queue.length === 0) {
        state.paused = false;
      }
    },

    /** The client (or the relay) closed — tear down the pty + viewer process. */
    close(ws: ServerWebSocket<TerminalWsData>) {
      const state = ws.data._term;
      if (!state) return;
      // Don't recurse into ws.close (we're already in the close callback); just
      // release the pty + viewer process.
      if (state.closed) return;
      state.closed = true;
      try {
        state.terminal?.close();
      } catch {
        /* already closed */
      }
      try {
        state.proc?.kill();
      } catch {
        /* already exited */
      }
    },
  };
}
