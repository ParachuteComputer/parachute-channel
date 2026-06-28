/**
 * `/chat` — the per-channel Chat view (Agent UI v2, Phase 4d).
 *
 * Ports the server-rendered inline chat (the daemon's `/ui` HTML page, src/daemon.ts
 * ~1023-1644) into the React SPA. ADDITIVE: the `/ui` HTML stays mounted (it retires
 * in the next sub-phase); this is the SPA-native equivalent.
 *
 * Behavioral parity with the inline page, re-implemented idiomatically in React:
 *   - a channel picker fed by `GET /api/channels`;
 *   - the durable transcript loaded on select via `GET /api/channels/<ch>/messages`
 *     (sorted ascending by ts, deduped by note id) — direction drives bubble side:
 *     `inbound` = "you" (right), `outbound` = "them" (left);
 *   - live updates over TWO EventSource streams, both authenticated by a one-time
 *     SSE TICKET in the URL (agent#25 — EventSource can't set a header, and a JWT
 *     in the URL would leak into access logs; each stream mints its own single-use
 *     ticket via `lib/auth.ts:getSseTicket` right before connecting):
 *       1. `/ui/events?channel=<ch>&ticket=` — message deltas (`reply` / `edit` /
 *          `permission` events);
 *       2. `/api/channels/<ch>/turn-events?ticket=` — the PROGRAMMATIC "watch it
 *          work" stream (interim assistant `text` + `tool` chips, finalized on
 *          `done` / shown errored on `error`);
 *   - a send box (`POST /api/channels/<ch>/send`) with an optimistic echo,
 *     reconciled against the returned note id so the round-tripped note isn't
 *     double-rendered;
 *   - auto-scroll, sender/direction styling, single re-mint-and-reconnect on an SSE
 *     error/401, and EventSource teardown on channel change + unmount.
 *
 * SSE URLs are built ORIGIN-RELATIVE under the agent module mount (`lib/api.ts`
 * `messageStreamUrl` / `turnEventsUrl` derive MOUNT = `apiBase()` minus the trailing
 * `/api` → `/agent`), so they resolve correctly daemon-direct AND hub-proxied —
 * mirroring how the inline chat derives MOUNT from the page path.
 *
 * NOTE on the durable record: the inline HTML page polls the transcript on a timer.
 * Here the message SSE (`/ui/events` `reply`) carries the outbound delta, and a turn
 * `done` triggers a one-shot transcript reload to pick up the durable note — so the
 * SPA stays current without a steady poll. (Vault `reply()` pushes to `/ui/events`
 * subscribers AND writes the note; the reload after `done` reconciles either way.)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  type ChannelRow,
  type ChatMessage,
  type TurnEvent,
  HttpError,
  listChannels,
  listMessages,
  messageStreamUrl,
  sendMessage,
  turnEventsUrl,
} from "../lib/api.ts";
import { clearCachedToken, getSseTicket } from "../lib/auth.ts";

/** A rendered transcript line — either a real message or a local "system" notice. */
interface Line {
  /** Stable React key. For a message it's the note id; for a system line a uuid. */
  key: string;
  kind: "you" | "them" | "sys";
  text: string;
}

/** The in-progress "watch it work" bubble state while a programmatic turn runs. */
interface LiveTurn {
  /** The streamed-so-far assistant text. */
  text: string;
  /** Distinct tool names this turn has used (deduped, in first-seen order). */
  tools: string[];
  /** Set when the turn failed — renders the bubble in an errored, non-pulsing state. */
  error?: string;
}

/** Map a transcript message to a rendered line. `inbound` = "you"; `outbound` = "them". */
function lineForMessage(m: ChatMessage): Line {
  return { key: m.id, kind: m.direction === "outbound" ? "them" : "you", text: m.text };
}

export function Chat() {
  const params = useParams<{ channel?: string }>();
  const navigate = useNavigate();

  // The channel list + which channel is selected. `null` selected = none yet.
  const [channels, setChannels] = useState<ChannelRow[] | null>(null);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(params.channel ?? null);

  // Transcript lines + the dedup set of note ids already rendered. The live turn
  // bubble is separate ephemeral state.
  const [lines, setLines] = useState<Line[]>([]);
  const [liveTurn, setLiveTurn] = useState<LiveTurn | null>(null);
  const [status, setStatus] = useState<{ text: string; kind: "live" | "err" | "" }>({
    text: "",
    kind: "",
  });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  // Note-id dedup set (a ref so the SSE/poll callbacks see the latest without
  // re-subscribing). Keyed by note id → true.
  const seenIds = useRef<Set<string>>(new Set());
  // Live EventSource handles for cleanup (channel switch / unmount).
  const msgEs = useRef<EventSource | null>(null);
  const turnEs = useRef<EventSource | null>(null);
  // Single re-auth-and-reconnect guard per connect cycle (the token is short-lived).
  const sseRetried = useRef(false);
  // Monotonic connect generation — bumped on every channel switch / unmount cleanup.
  // `openStreams` captures the generation it started under and bails if it's stale
  // by the time the (async) token mint resolves, so a stream from a superseded cycle
  // can't escape the cleanup that already ran.
  const connectGen = useRef(0);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const transportFor = useCallback(
    (name: string | null): string =>
      (channels?.find((c) => c.name === name)?.transport ?? ""),
    [channels],
  );
  const isVault = useCallback(
    (name: string | null) => transportFor(name) === "vault",
    [transportFor],
  );

  // ----- transcript helpers -------------------------------------------------

  /** Append a system notice (a local-only "sys" line, never persisted). */
  const addSys = useCallback((text: string) => {
    setLines((prev) => [...prev, { key: crypto.randomUUID(), kind: "sys", text }]);
  }, []);

  /** Append a transcript message iff its note id is new (dedup the SSE + reload). */
  const addMessage = useCallback((m: ChatMessage) => {
    if (!m.id || seenIds.current.has(m.id)) return;
    seenIds.current.add(m.id);
    setLines((prev) => [...prev, lineForMessage(m)]);
  }, []);

  // Auto-scroll to the newest line whenever the transcript or live turn changes.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, liveTurn]);

  // ----- the two SSE streams ------------------------------------------------

  /**
   * Open both live streams for `ch`: the message stream (`/ui/events`) and — for a
   * vault channel — the programmatic turn-event stream. Both authenticate via a
   * one-time SSE TICKET in the URL (agent#25) — NOT the hub JWT, which would leak
   * in an access log. Each EventSource needs its OWN single-use ticket, so we mint
   * one per stream right before opening it. On a stream error we re-mint once +
   * reconnect (mirrors the inline chat's single-retry); the turn stream is
   * best-effort progress (browser auto-reconnect, no manual re-auth dance).
   */
  const openStreams = useCallback(
    async (ch: string) => {
      const gen = connectGen.current;
      // Tear down any prior streams first.
      msgEs.current?.close();
      msgEs.current = null;
      turnEs.current?.close();
      turnEs.current = null;

      const transport = transportFor(ch);

      // Shared stream lifecycle: `onopen` marks the chat live + clears the retry latch;
      // `onerror` re-mints a fresh ticket ONCE (a single-use ticket is spent on connect,
      // and a stale auth would 401 it) then reconnects, else falls back to the browser's
      // auto-reconnect. The re-run mints brand-new tickets for whichever streams reopen.
      const onStreamOpen = () => {
        sseRetried.current = false;
        setStatus({ text: `live - ${ch}`, kind: "live" });
      };
      const onStreamError = () => {
        if (!sseRetried.current) {
          sseRetried.current = true;
          setStatus({ text: "re-authenticating...", kind: "" });
          msgEs.current?.close();
          msgEs.current = null;
          turnEs.current?.close();
          turnEs.current = null;
          // Drop the cached JWT so the ticket re-mint forces a fresh token if the
          // old one had gone stale, then reconnect (which mints new tickets).
          clearCachedToken();
          void openStreams(ch);
          return;
        }
        setStatus({ text: "reconnecting...", kind: "" });
      };

      // 1. Message stream — the http-ui transport's inbound/outbound deltas
      //    (reply / edit / permission). It is served ONLY for an `http-ui` channel; a
      //    `vault` channel 404s it (its live updates come from the turn-event stream +
      //    reload-on-done below). So open it ONLY for http-ui — opening it for a vault
      //    channel would just spin a doomed EventSource (404 → error → wasted re-mint)
      //    on every chat load. Interactive/http-ui is retired, so in practice this is
      //    rarely taken; it's kept for any lingering http-ui channel.
      if (transport === "http-ui") {
      // Mint this stream's own one-time ticket. Bail if the connect cycle went stale
      // during the (async) mint, so a ticket-backed stream can't escape the cleanup.
      const msgTicket = await getSseTicket();
      if (gen !== connectGen.current) return;
      const ms = new EventSource(messageStreamUrl(ch, msgTicket));
      ms.onopen = onStreamOpen;
      ms.addEventListener("reply", (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data) as { id?: string; text?: string };
          // An outbound reply delta. Key it by id when present so a later transcript
          // reload doesn't double-render it; without an id, render uncondtionally.
          if (d.id) addMessage({ id: d.id, text: d.text ?? "", direction: "outbound", sender: "session", ts: "" });
          else setLines((prev) => [...prev, { key: crypto.randomUUID(), kind: "them", text: d.text ?? "" }]);
        } catch {
          /* malformed frame — ignore */
        }
      });
      ms.addEventListener("edit", (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data) as { text?: string };
          addSys(`(edited) ${d.text ?? ""}`);
        } catch {
          /* ignore */
        }
      });
      ms.addEventListener("permission", (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data) as { tool_name?: string; description?: string };
          // No verdict affordance in the SPA yet (the daemon has no verdict sink the
          // browser can call — same gap the inline chat flags). Surface it visibly.
          addSys(`permission: ${d.tool_name ?? ""}${d.description ? ` - ${d.description}` : ""} (respond in the session terminal)`);
        } catch {
          /* ignore */
        }
      });
      ms.onerror = onStreamError;
      msgEs.current = ms;
      }

      // 2. Turn-event stream — the "watch it work" view + the live record for a
      //    vault/programmatic channel (this is the PRIMARY stream for a vault channel;
      //    the durable outbound arrives via reload-on-done). Carries the same onopen
      //    (marks live) + onerror (re-mint-once) as the message stream, so a vault
      //    channel — which has no message stream — still shows "live" and recovers from
      //    a stale ticket.
      if (isVault(ch)) {
        // This stream's own one-time ticket (single-use — distinct from the message
        // stream's). Bail if the connect cycle went stale during the async mint.
        const turnTicket = await getSseTicket();
        if (gen !== connectGen.current) return;
        const ts = new EventSource(turnEventsUrl(ch, turnTicket));
        ts.onopen = onStreamOpen;
        ts.addEventListener("turn", (e) => {
          try {
            onTurnEvent(JSON.parse((e as MessageEvent).data) as TurnEvent, ch);
          } catch {
            /* ignore */
          }
        });
        ts.onerror = onStreamError;
        turnEs.current = ts;
      }
    },
    // `onTurnEvent` is intentionally omitted from the deps. It's declared after
    // this callback, and adding it would force `openStreams` to be re-created (and
    // the connect effect to re-subscribe) every render. The stale closure is safe:
    // `onTurnEvent` only ever calls stable setters (setLiveTurn) + a stable
    // callback (reloadTranscript) + refs — it reads no changing render state — so
    // an older captured instance behaves identically to the latest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [addMessage, addSys, isVault, transportFor],
  );

  /** Reload the durable transcript once (after a turn `done`) to pick up the note. */
  const reloadTranscript = useCallback(
    async (ch: string) => {
      try {
        const res = await listMessages(ch);
        res.messages.forEach(addMessage);
      } catch {
        /* a transient reload failure is harmless — the SSE delta already showed it */
      }
    },
    [addMessage],
  );

  /** Handle one programmatic turn event — drives the live "watch it work" bubble. */
  const onTurnEvent = useCallback(
    (d: TurnEvent, ch: string) => {
      switch (d.kind) {
        case "init":
          setLiveTurn({ text: "", tools: [] });
          return;
        case "text":
          setLiveTurn((prev) => ({
            text: (prev?.text ?? "") + d.text,
            tools: prev?.tools ?? [],
            ...(prev?.error ? { error: prev.error } : {}),
          }));
          return;
        case "tool":
          setLiveTurn((prev) => {
            const tools = prev?.tools ?? [];
            return {
              text: prev?.text ?? "",
              tools: tools.includes(d.tool) ? tools : [...tools, d.tool],
            };
          });
          return;
        case "done":
          // The turn finished — drop the live bubble; the durable note carries the
          // real reply. Reload the transcript now so it appears immediately.
          setLiveTurn(null);
          void reloadTranscript(ch);
          return;
        case "error":
          // Resolve the live view to an error state (no stuck spinner). Leave it in
          // place but stop treating it as live.
          setLiveTurn((prev) => ({
            text: prev?.text ?? "",
            tools: prev?.tools ?? [],
            error: d.error,
          }));
          return;
      }
    },
    [reloadTranscript],
  );

  // ----- channel selection + lifecycle -------------------------------------

  // Load the channel list once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await listChannels();
        if (cancelled) return;
        setChannels(res.channels);
        // Preselect: the route param if it's a real channel, else the first channel.
        setSelected((cur) => {
          if (cur && res.channels.some((c) => c.name === cur)) return cur;
          return res.channels[0]?.name ?? null;
        });
      } catch (err) {
        if (!cancelled) setChannelsError(errMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // On the selected channel changing: reset transcript + dedup, load history, open
  // streams. Cleans up the prior channel's streams on switch / unmount.
  useEffect(() => {
    const ch = selected;
    if (!ch) {
      setStatus({ text: "no channel", kind: "" });
      return;
    }
    let cancelled = false;
    connectGen.current += 1;
    seenIds.current = new Set();
    sseRetried.current = false;
    setLines([]);
    setLiveTurn(null);
    setStatus({ text: "loading history...", kind: "" });

    void (async () => {
      try {
        const res = await listMessages(ch);
        if (cancelled) return;
        res.messages.forEach(addMessage);
        setStatus({ text: `live - ${ch}`, kind: "live" });
      } catch (err) {
        if (cancelled) return;
        // A read failure shouldn't block sending or the live stream — surface it.
        setStatus({ text: `history error: ${errMessage(err)}`, kind: "err" });
      }
      if (!cancelled) await openStreams(ch);
    })();

    return () => {
      cancelled = true;
      connectGen.current += 1;
      msgEs.current?.close();
      msgEs.current = null;
      turnEs.current?.close();
      turnEs.current = null;
    };
    // openStreams/addMessage are stable enough; selected drives the re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  function onPick(name: string) {
    setSelected(name);
    // Reflect the channel in the URL (deep-linkable) without a full nav.
    navigate(`/chat/${encodeURIComponent(name)}`, { replace: true });
  }

  // ----- send ---------------------------------------------------------------

  async function onSend() {
    const text = draft.trim();
    const ch = selected;
    if (!text || !ch || sending) return;
    setSending(true);
    // Optimistic echo (operator = inbound = "you"). It's a local line; the real
    // note's id is recorded in seenIds on the response so the reload doesn't dupe it.
    setLines((prev) => [...prev, { key: crypto.randomUUID(), kind: "you", text }]);
    setDraft("");
    try {
      const res = await sendMessage(ch, text);
      if (res.id) seenIds.current.add(res.id);
    } catch (err) {
      addSys(`send failed: ${errMessage(err)}`);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  }

  const hasChannels = (channels?.length ?? 0) > 0;
  const canSend = !!selected && draft.trim().length > 0 && !sending;
  const statusClass = useMemo(
    () =>
      status.kind === "live"
        ? "chat-status status-live"
        : status.kind === "err"
          ? "chat-status status-err"
          : "chat-status",
    [status.kind],
  );

  return (
    <div className="chat" data-testid="chat-view">
      <div className="chat-head">
        <h1>Chat</h1>
        {channels ? (
          hasChannels ? (
            <label className="chat-picker">
              <span className="chat-picker-label">Channel</span>
              <select
                data-testid="chat-channel-select"
                value={selected ?? ""}
                onChange={(e) => onPick(e.target.value)}
              >
                {channels.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.transport})
                  </option>
                ))}
              </select>
            </label>
          ) : null
        ) : null}
        {status.text ? (
          <span className={statusClass} data-testid="chat-status">
            {status.text}
          </span>
        ) : null}
      </div>

      {channelsError ? (
        <div className="error-banner" role="alert" data-testid="chat-channels-error">
          {channelsError}
        </div>
      ) : null}

      {channels && !hasChannels && !channelsError ? (
        <div className="empty" data-testid="chat-no-channels">
          No channels yet. Create a channel-backed agent in the create flow, then chat
          with it here.
        </div>
      ) : null}

      {hasChannels ? (
        <>
          <div className="transcript" ref={transcriptRef} data-testid="chat-transcript">
            {lines.map((l) => (
              <div key={l.key} className={`msg ${l.kind}`} data-testid={`chat-msg-${l.kind}`}>
                {l.text}
              </div>
            ))}
            {liveTurn ? <LiveTurnBubble turn={liveTurn} /> : null}
          </div>

          <form
            className="composer"
            data-testid="chat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void onSend();
            }}
          >
            <textarea
              className="chat-input"
              data-testid="chat-input"
              rows={1}
              value={draft}
              placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
              autoComplete="off"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <button type="submit" data-testid="chat-send" disabled={!canSend}>
              {sending ? "Sending..." : "Send"}
            </button>
          </form>
        </>
      ) : null}
    </div>
  );
}

/**
 * The in-progress "watch it work" bubble: streamed interim assistant text + a row of
 * "using <tool>" chips, with a pulsing dashed border while live (a solid errored
 * border once a turn fails). Finalized (removed) on the turn's `done`, when the
 * durable outbound note has rendered into the transcript.
 */
function LiveTurnBubble({ turn }: { turn: LiveTurn }) {
  return (
    <div
      className={`msg them live${turn.error ? " errored" : ""}`}
      data-testid="chat-live-turn"
    >
      {turn.text ? <div className="live-text">{turn.text}</div> : null}
      {turn.tools.length > 0 ? (
        <div className="live-tools">
          {turn.tools.map((t) => (
            <span key={t} className="tool-chip" data-testid={`chat-tool-${t}`}>
              {t}
            </span>
          ))}
        </div>
      ) : null}
      <div className="live-working" data-testid="chat-live-status">
        {turn.error ? `turn failed: ${turn.error}` : "working..."}
      </div>
    </div>
  );
}

/** Pull a user-facing message off an unknown error (HttpError carries the daemon's). */
function errMessage(err: unknown): string {
  if (err instanceof HttpError) {
    return err.status === 401
      ? "Not signed in to the hub - sign in to the portal, then reload."
      : err.message;
  }
  return (err as Error).message;
}
