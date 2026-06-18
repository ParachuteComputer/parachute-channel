/**
 * Agents route tests — the all-backends merge (unit), and the read-only view's
 * loading / empty / populated / error states + the detail panel.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { Agents, mergeAgents } from "./Agents.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listAgents: vi.fn(),
    listAgentDefs: vi.fn(),
    listAgentVaults: vi.fn(),
  };
});

const listAgents = vi.mocked(api.listAgents);
const listAgentDefs = vi.mocked(api.listAgentDefs);
const listAgentVaults = vi.mocked(api.listAgentVaults);

function agentRow(over: Partial<api.AgentRow> = {}): api.AgentRow {
  return {
    name: "alpha",
    session: "alpha-agent",
    attached: false,
    workspace: "/w/alpha",
    hasWorkspace: true,
    backend: "programmatic",
    ...over,
  };
}

function defRow(over: Partial<api.AgentDefRow> = {}): api.AgentDefRow {
  return {
    noteId: "note-1",
    name: "alpha",
    backend: "programmatic",
    vault: "default",
    status: "enabled",
    pending: [],
    systemPromptPreview: "You are a helpful agent.",
    wants: [],
    channel: "alpha",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listAgents.mockResolvedValue({ agents: [] });
  listAgentDefs.mockResolvedValue({ defs: [] });
  listAgentVaults.mockResolvedValue({ vaults: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderRoute() {
  return render(
    <MemoryRouter>
      <Agents />
    </MemoryRouter>,
  );
}

describe("mergeAgents (all-backends merge)", () => {
  it("merges live agents across backends and dedupes by name", () => {
    const merged = mergeAgents(
      [
        agentRow({ name: "prog", backend: "programmatic", status: "idle" }),
        agentRow({ name: "chan", backend: "channel", channel: "chan", vault: "default", status: "queued:2" }),
        agentRow({ name: "tmux", backend: "interactive", attached: true }),
      ],
      [],
    );
    expect(merged.map((m) => m.name)).toEqual(["chan", "prog", "tmux"]); // sorted
    const chan = merged.find((m) => m.name === "chan")!;
    expect(chan.backend).toBe("channel");
    expect(chan.status).toBe("queued:2");
    expect(chan.live).toBe(true);
  });

  it("attaches the def to a live agent of the same name and fills gaps", () => {
    const merged = mergeAgents(
      [agentRow({ name: "alpha", backend: "channel" })],
      [defRow({ name: "alpha", vault: "default", channel: "alpha", wants: ["vault:other"] })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.def?.wants).toEqual(["vault:other"]);
    // The live row carried no vault; the def filled it.
    expect(merged[0]!.vault).toBe("default");
  });

  it("surfaces a def with no live agent as a def-only (not-running) row", () => {
    const merged = mergeAgents([], [defRow({ name: "ghost" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.live).toBe(false);
    expect(merged[0]!.name).toBe("ghost");
  });
});

describe("Agents view states", () => {
  it("renders the loading state first", () => {
    renderRoute();
    expect(screen.getByText(/loading agents/i)).toBeInTheDocument();
  });

  it("renders the empty state when there are no agents", async () => {
    renderRoute();
    expect(await screen.findByText(/no agents yet/i)).toBeInTheDocument();
    expect(screen.getByTestId("agents-count")).toHaveTextContent("0 agents");
  });

  it("renders a populated table merging all backends", async () => {
    listAgents.mockResolvedValue({
      agents: [
        agentRow({ name: "prog", backend: "programmatic", status: "idle" }),
        agentRow({ name: "chan", backend: "channel", channel: "chan", vault: "default", status: "queued:1" }),
      ],
    });
    listAgentDefs.mockResolvedValue({ defs: [defRow({ name: "prog" })] });
    renderRoute();

    expect(await screen.findByTestId("agent-row-prog")).toBeInTheDocument();
    expect(screen.getByTestId("agent-row-chan")).toBeInTheDocument();
    expect(screen.getByTestId("agents-count")).toHaveTextContent("2 agents");

    const chanRow = screen.getByTestId("agent-row-chan");
    expect(within(chanRow).getByText("channel")).toBeInTheDocument();
    expect(within(chanRow).getByText("queued:1")).toBeInTheDocument();
    expect(within(chanRow).getByText("default")).toBeInTheDocument();
  });

  it("renders the error state with a retry that re-fetches", async () => {
    listAgents.mockRejectedValueOnce(new api.HttpError(500, "kaboom"));
    renderRoute();

    expect(await screen.findByRole("alert")).toHaveTextContent(/kaboom/i);

    // Retry — this time everything resolves.
    listAgents.mockResolvedValue({ agents: [agentRow({ name: "alpha" })] });
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByTestId("agent-row-alpha")).toBeInTheDocument();
  });

  it("shows a friendlier message on a 401", async () => {
    listAgents.mockRejectedValueOnce(new api.HttpError(401, "unauthorized"));
    renderRoute();
    expect(await screen.findByRole("alert")).toHaveTextContent(/not signed in to the hub/i);
  });

  it("opens a detail panel on row click, showing the def's system prompt + wants", async () => {
    listAgents.mockResolvedValue({ agents: [agentRow({ name: "alpha", backend: "channel" })] });
    listAgentDefs.mockResolvedValue({
      defs: [defRow({ name: "alpha", systemPromptPreview: "Persona text", wants: ["vault:x"] })],
    });
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-alpha"));

    const detail = await screen.findByTestId("agent-detail");
    expect(within(detail).getByTestId("detail-prompt")).toHaveTextContent("Persona text");
    expect(within(detail).getByText("vault:x")).toBeInTheDocument();
    // Channel-backend note about the deferred connect affordance.
    expect(within(detail).getByTestId("detail-channel-note")).toBeInTheDocument();
  });

  it("detail panel notes when an agent has no backing def", async () => {
    listAgents.mockResolvedValue({ agents: [agentRow({ name: "tmux", backend: "interactive" })] });
    listAgentDefs.mockResolvedValue({ defs: [] });
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-tmux"));
    const detail = await screen.findByTestId("agent-detail");
    expect(within(detail).getByTestId("detail-no-def")).toBeInTheDocument();
  });

  it("renders the read-only Def-vaults section", async () => {
    listAgentVaults.mockResolvedValue({
      vaults: [
        { vault: "default", url: "http://127.0.0.1:1940", tokenPresent: true },
        { vault: "stale", url: "http://127.0.0.1:1950", tokenPresent: false },
      ],
    });
    renderRoute();

    await waitFor(() => expect(screen.getByTestId("def-vault-default")).toBeInTheDocument());
    const ok = screen.getByTestId("def-vault-default");
    expect(within(ok).getByText("present")).toBeInTheDocument();
    const stale = screen.getByTestId("def-vault-stale");
    expect(within(stale).getByText("missing")).toBeInTheDocument();
  });

  it("shows the def-vaults empty state when none configured", async () => {
    renderRoute();
    expect(await screen.findByTestId("def-vaults-empty")).toBeInTheDocument();
  });
});
