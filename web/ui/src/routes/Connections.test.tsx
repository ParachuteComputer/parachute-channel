/**
 * Connections / MCP-servers panel tests (this PR). Exercises the exported
 * `ConnectionsSection` + `AddMcpForm` + `mcpConnectionRows` directly (no full-page
 * wiring), mocking `../lib/api.ts` (the def PATCH) and `../lib/hub.ts` (the cookie→hub
 * approve + the daemon-direct detector). Asserts:
 *   - the row list + status pills (Connected / Pending / Needs reconnect);
 *   - Add MCP → PATCH wants APPENDS `mcp:<url>` (preserving existing wants);
 *   - Connect → `approveAgentGrant(grantId)` → full-page redirect to authorizeUrl;
 *   - Paste-token → `approveAgentGrant(grantId, token)` (no redirect);
 *   - daemon-direct degradation hides Connect + shows the inline hint.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import * as hub from "../lib/hub.ts";
import { AddMcpForm, ConnectionsSection, mcpConnectionRows } from "./Agents.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return { ...actual, editAgentDef: vi.fn() };
});
vi.mock("../lib/hub.ts", async (orig) => {
  const actual = (await orig()) as typeof hub;
  return { ...actual, approveAgentGrant: vi.fn(), isDaemonDirectOrigin: vi.fn(() => false) };
});

const editAgentDef = vi.mocked(api.editAgentDef);
const approveAgentGrant = vi.mocked(hub.approveAgentGrant);
const isDaemonDirectOrigin = vi.mocked(hub.isDaemonDirectOrigin);

function defRow(over: Partial<api.AgentDefRow> = {}): api.AgentDefRow {
  return {
    noteId: "Agents/alpha",
    name: "alpha",
    backend: "programmatic",
    mode: "single-threaded",
    vault: "default",
    status: "pending",
    pending: [],
    systemPromptPreview: "You are a helpful agent.",
    wants: [],
    channel: "alpha",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isDaemonDirectOrigin.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mcpConnectionRows", () => {
  it("prefers def.connections (filtered to kind:mcp, carrying grant id + status)", () => {
    const def = defRow({
      connections: [
        { key: "mcp:https://a/mcp", kind: "mcp", target: "https://a/mcp", status: "pending", grantId: "g1" },
        { key: "vault:research:read", kind: "vault", target: "research", status: "approved", grantId: "g2" },
      ],
      wants: ["mcp:https://a/mcp", "vault:research:read"],
    });
    const rows = mcpConnectionRows(def);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: "https://a/mcp", grantId: "g1", status: "pending" });
  });

  it("falls back to wants (older daemon, no connections field) — display-only, no grant id", () => {
    const def = defRow({
      // connections omitted (older daemon)
      wants: ["mcp:https://a/mcp", "vault:research:read"],
      pending: ["mcp:https://a/mcp"],
    });
    const rows = mcpConnectionRows(def);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      key: "mcp:https://a/mcp",
      kind: "mcp",
      target: "https://a/mcp",
      status: "pending",
    });
    expect(rows[0]!.grantId).toBeUndefined();
  });
});

describe("ConnectionsSection — render + status pills", () => {
  it("lists mcp connections with the right pills and the empty state", () => {
    const def = defRow({
      connections: [
        { key: "mcp:https://a/mcp", kind: "mcp", target: "https://a/mcp", status: "approved", grantId: "g1" },
        { key: "mcp:https://b/mcp", kind: "mcp", target: "https://b/mcp", status: "needs_consent", grantId: "g2" },
        { key: "mcp:https://c/mcp", kind: "mcp", target: "https://c/mcp", status: "pending", grantId: "g3" },
      ],
    });
    render(<ConnectionsSection noteId="Agents/alpha" def={def} onChanged={() => {}} />);
    expect(screen.getByTestId("conn-status-approved")).toHaveTextContent("Connected");
    expect(screen.getByTestId("conn-status-needs_consent")).toHaveTextContent("Needs reconnect");
    expect(screen.getByTestId("conn-status-pending")).toHaveTextContent("Pending");
    // The needs_consent row's button reads "Reconnect"; the pending one "Connect".
    expect(screen.getByTestId("connect-https://b/mcp")).toHaveTextContent("Reconnect");
    expect(screen.getByTestId("connect-https://c/mcp")).toHaveTextContent("Connect");
  });

  it("shows the empty state when there are no mcp connections", () => {
    render(<ConnectionsSection noteId="Agents/alpha" def={defRow()} onChanged={() => {}} />);
    expect(screen.getByTestId("connections-empty")).toBeInTheDocument();
  });
});

describe("ConnectionsSection — Connect (cookie→hub approve)", () => {
  it("Connect → approveAgentGrant(grantId) → full-page redirect to authorizeUrl", async () => {
    // jsdom's window.location.assign isn't configurable to spy on directly; swap the
    // whole location object (restored after the test) and stub assign on it.
    const assign = vi.fn();
    const realLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...realLocation, assign },
    });
    approveAgentGrant.mockResolvedValue({
      id: "g3",
      agent: "alpha",
      connection: { kind: "mcp", target: "https://c/mcp" },
      status: "pending",
      authorizeUrl: "https://c/oauth/authorize?x=1",
    });
    const def = defRow({
      connections: [
        { key: "mcp:https://c/mcp", kind: "mcp", target: "https://c/mcp", status: "pending", grantId: "g3" },
      ],
    });
    render(<ConnectionsSection noteId="Agents/alpha" def={def} onChanged={() => {}} />);
    fireEvent.click(screen.getByTestId("connect-https://c/mcp"));
    await waitFor(() => expect(approveAgentGrant).toHaveBeenCalledWith("g3"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://c/oauth/authorize?x=1"));
    Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  });

  it("Paste token → approveAgentGrant(grantId, token) (no redirect) → onChanged", async () => {
    approveAgentGrant.mockResolvedValue({
      id: "g3",
      agent: "alpha",
      connection: { kind: "mcp", target: "https://c/mcp" },
      status: "approved",
    });
    const onChanged = vi.fn();
    const def = defRow({
      connections: [
        { key: "mcp:https://c/mcp", kind: "mcp", target: "https://c/mcp", status: "pending", grantId: "g3" },
      ],
    });
    render(<ConnectionsSection noteId="Agents/alpha" def={def} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("paste-token-https://c/mcp"));
    fireEvent.change(screen.getByTestId("paste-token-input-https://c/mcp"), {
      target: { value: "static-bearer" },
    });
    fireEvent.click(screen.getByTestId("paste-token-save-https://c/mcp"));
    await waitFor(() => expect(approveAgentGrant).toHaveBeenCalledWith("g3", "static-bearer"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});

describe("ConnectionsSection — daemon-direct degradation", () => {
  it("hides Connect + shows the hub-origin hint when served daemon-direct", () => {
    isDaemonDirectOrigin.mockReturnValue(true);
    const def = defRow({
      connections: [
        { key: "mcp:https://c/mcp", kind: "mcp", target: "https://c/mcp", status: "pending", grantId: "g3" },
      ],
    });
    render(<ConnectionsSection noteId="Agents/alpha" def={def} onChanged={() => {}} />);
    expect(screen.getByTestId("connections-daemon-direct")).toBeInTheDocument();
    // The Connect button is present but disabled (can't approve cross-origin).
    expect(screen.getByTestId("connect-https://c/mcp")).toBeDisabled();
    // No paste-token affordance daemon-direct (it also needs the hub origin).
    expect(screen.queryByTestId("paste-token-https://c/mcp")).toBeNull();
  });
});

describe("AddMcpForm", () => {
  it("APPENDs mcp:<url> to the existing wants and PATCHes the def", async () => {
    editAgentDef.mockResolvedValue({ ok: true, def: defRow() });
    const onAdded = vi.fn();
    const def = defRow({ wants: ["vault:research:read"] });
    render(<AddMcpForm noteId="Agents/alpha" def={def} onCancel={() => {}} onAdded={onAdded} />);
    fireEvent.change(screen.getByLabelText("MCP server URL"), {
      target: { value: "https://new/mcp" },
    });
    fireEvent.click(screen.getByTestId("add-mcp-submit"));
    await waitFor(() =>
      expect(editAgentDef).toHaveBeenCalledWith("Agents/alpha", {
        wants: "vault:research:read, mcp:https://new/mcp",
      }),
    );
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
  });

  it("rejects a non-http(s) URL and a duplicate", () => {
    const def = defRow({ wants: ["mcp:https://dup/mcp"] });
    render(<AddMcpForm noteId="Agents/alpha" def={def} onCancel={() => {}} onAdded={() => {}} />);
    const input = screen.getByLabelText("MCP server URL");

    fireEvent.change(input, { target: { value: "notaurl" } });
    expect(screen.getByTestId("mcp-url-invalid")).toBeInTheDocument();
    expect(screen.getByTestId("add-mcp-submit")).toBeDisabled();

    fireEvent.change(input, { target: { value: "https://dup/mcp" } });
    expect(screen.getByTestId("mcp-url-duplicate")).toBeInTheDocument();
    expect(screen.getByTestId("add-mcp-submit")).toBeDisabled();
  });
});
