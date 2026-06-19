/**
 * Chat route tests (Agent UI v2, Phase 4d).
 *
 * Covers: the channel picker renders from `listChannels`; selecting a channel
 * loads + renders the transcript via `listMessages`; sending calls `sendMessage`
 * and clears the input; a delivered message SSE `reply` event appends to the
 * transcript; a turn-event `init`/`text`/`tool` drives the live "watch it work"
 * bubble and `done` finalizes it (drops the bubble + reloads the transcript).
 *
 * The api + auth modules are mocked per the existing pattern (`Agents.test.tsx`,
 * `api.test.ts`). EventSource isn't implemented in jsdom, so a small fake stub is
 * installed that records instances by URL and lets a test fire named events.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import * as auth from "../lib/auth.ts";
import { Chat } from "./Chat.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listChannels: vi.fn(),
    listMessages: vi.fn(),
    sendMessage: vi.fn(),
  };
});

vi.mock("../lib/auth.ts", () => ({
  getAgentToken: vi.fn(),
  clearCachedToken: vi.fn(),
}));

const listChannels = vi.mocked(api.listChannels);
const listMessages = vi.mocked(api.listMessages);
const sendMessage = vi.mocked(api.sendMessage);
const getAgentToken = vi.mocked(auth.getAgentToken);
const clearCachedToken = vi.mocked(auth.clearCachedToken);

// ---- a minimal fake EventSource so the SSE paths are drivable in jsdom -------
type Listener = (e: { data: string }) => void;
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Listener[]>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  close() {
    this.closed = true;
  }
  /** Test helper: deliver a named event with a JSON-stringified payload. */
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
  static find(substr: string): FakeEventSource | undefined {
    return FakeEventSource.instances.find((es) => es.url.includes(substr) && !es.closed);
  }
  static reset() {
    FakeEventSource.instances = [];
  }
}

function chanRow(over: Partial<api.ChannelRow> = {}): api.ChannelRow {
  return { name: "eng", transport: "vault", vault: "default", ...over };
}

function msg(over: Partial<api.ChatMessage> = {}): api.ChatMessage {
  return {
    id: "n1",
    text: "hello",
    direction: "inbound",
    sender: "operator",
    ts: "2026-06-18T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  getAgentToken.mockResolvedValue("jwt-tok");
  listChannels.mockResolvedValue({ channels: [chanRow()] });
  listMessages.mockResolvedValue({ messages: [] });
  sendMessage.mockResolvedValue({ ok: true, id: "sent-1" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderChat() {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <Chat />
    </MemoryRouter>,
  );
}

describe("Chat", () => {
  it("renders the channel picker from listChannels", async () => {
    listChannels.mockResolvedValue({
      channels: [chanRow({ name: "eng" }), chanRow({ name: "ops", transport: "http-ui" })],
    });
    renderChat();
    const select = (await screen.findByTestId("chat-channel-select")) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["eng", "ops"]);
  });

  it("loads + renders the transcript on channel select", async () => {
    listMessages.mockResolvedValue({
      messages: [
        msg({ id: "n1", text: "from me", direction: "inbound" }),
        msg({ id: "n2", text: "from agent", direction: "outbound" }),
      ],
    });
    renderChat();
    await waitFor(() => expect(listMessages).toHaveBeenCalledWith("eng"));
    expect(await screen.findByText("from me")).toBeInTheDocument();
    expect(await screen.findByText("from agent")).toBeInTheDocument();
  });

  it("sending calls sendMessage and clears the input", async () => {
    renderChat();
    const input = (await screen.findByTestId("chat-input")) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "ping" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith("eng", "ping"));
    await waitFor(() => expect(input.value).toBe(""));
    // The optimistic echo is rendered as a "you" bubble.
    expect(await screen.findByText("ping")).toBeInTheDocument();
  });

  it("appends a delivered message-stream `reply` event to the transcript", async () => {
    renderChat();
    // Wait for the message stream to open on /ui/events.
    await waitFor(() => expect(FakeEventSource.find("/ui/events")).toBeTruthy());
    const es = FakeEventSource.find("/ui/events")!;
    es.emit("reply", { id: "out-1", text: "streamed reply" });
    expect(await screen.findByText("streamed reply")).toBeInTheDocument();
  });

  it("re-mints + reconnects once on a message-stream error; the guard blocks a second re-mint", async () => {
    renderChat();
    // Wait for the message stream to open on /ui/events.
    await waitFor(() => expect(FakeEventSource.find("/ui/events")).toBeTruthy());
    const first = FakeEventSource.find("/ui/events")!;
    const countBefore = FakeEventSource.instances.filter((es) =>
      es.url.includes("/ui/events"),
    ).length;

    // First error → re-mint (clearCachedToken) + reconnect (new EventSource).
    first.onerror?.();
    await waitFor(() => expect(clearCachedToken).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        FakeEventSource.instances.filter((es) => es.url.includes("/ui/events")).length,
      ).toBe(countBefore + 1),
    );
    expect(first.closed).toBe(true);
    const second = FakeEventSource.find("/ui/events")!;
    expect(second).not.toBe(first);

    // A SECOND consecutive error (no intervening onopen to reset the guard) must NOT
    // re-mint again — the `sseRetried` guard is still set from the first reconnect.
    second.onerror?.();
    // Give any (erroneous) async re-mint a chance to run, then assert it didn't.
    await Promise.resolve();
    expect(clearCachedToken).toHaveBeenCalledTimes(1);
    expect(
      FakeEventSource.instances.filter((es) => es.url.includes("/ui/events")).length,
    ).toBe(countBefore + 1);
  });

  it("turn events drive the live bubble; init+text+tool show, done finalizes it", async () => {
    renderChat();
    await waitFor(() => expect(FakeEventSource.find("/turn-events")).toBeTruthy());
    const turn = FakeEventSource.find("/turn-events")!;

    turn.emit("turn", { kind: "init", sessionId: "s1" });
    turn.emit("turn", { kind: "text", text: "thinking..." });
    turn.emit("turn", { kind: "tool", tool: "Read" });

    // The live bubble renders the interim text + a tool chip + the working status.
    expect(await screen.findByTestId("chat-live-turn")).toBeInTheDocument();
    expect(screen.getByText("thinking...")).toBeInTheDocument();
    expect(screen.getByTestId("chat-tool-Read")).toBeInTheDocument();
    expect(screen.getByTestId("chat-live-status")).toHaveTextContent("working...");

    // The durable note arrives on the reload after `done`.
    listMessages.mockResolvedValue({
      messages: [msg({ id: "done-1", text: "final answer", direction: "outbound" })],
    });
    turn.emit("turn", { kind: "done", reply: "final answer" });

    // The live bubble drops + the durable reply renders.
    await waitFor(() => expect(screen.queryByTestId("chat-live-turn")).not.toBeInTheDocument());
    expect(await screen.findByText("final answer")).toBeInTheDocument();
  });

  it("a turn `error` resolves the live bubble to an errored state (no stuck spinner)", async () => {
    renderChat();
    await waitFor(() => expect(FakeEventSource.find("/turn-events")).toBeTruthy());
    const turn = FakeEventSource.find("/turn-events")!;
    turn.emit("turn", { kind: "init", sessionId: "s1" });
    turn.emit("turn", { kind: "error", error: "boom" });
    expect(await screen.findByTestId("chat-live-status")).toHaveTextContent("turn failed: boom");
  });

  it("shows the no-channels empty state when there are none", async () => {
    listChannels.mockResolvedValue({ channels: [] });
    renderChat();
    expect(await screen.findByTestId("chat-no-channels")).toBeInTheDocument();
  });
});
