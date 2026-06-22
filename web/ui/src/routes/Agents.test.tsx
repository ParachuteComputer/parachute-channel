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
    getAgentDef: vi.fn(),
    editAgentDef: vi.fn(),
    deleteAgentDef: vi.fn(),
    addAgentVault: vi.fn(),
    removeAgentVault: vi.fn(),
    listJobs: vi.fn(),
    createJob: vi.fn(),
    runJob: vi.fn(),
    deleteJob: vi.fn(),
    listAgentSecrets: vi.fn(),
    setAgentSecret: vi.fn(),
    removeAgentSecret: vi.fn(),
  };
});

const listAgents = vi.mocked(api.listAgents);
const listAgentDefs = vi.mocked(api.listAgentDefs);
const listAgentVaults = vi.mocked(api.listAgentVaults);
const getAgentDef = vi.mocked(api.getAgentDef);
const editAgentDef = vi.mocked(api.editAgentDef);
const deleteAgentDef = vi.mocked(api.deleteAgentDef);
const addAgentVault = vi.mocked(api.addAgentVault);
const removeAgentVault = vi.mocked(api.removeAgentVault);
const listJobs = vi.mocked(api.listJobs);
const createJob = vi.mocked(api.createJob);
const runJob = vi.mocked(api.runJob);
const deleteJob = vi.mocked(api.deleteJob);
const listAgentSecrets = vi.mocked(api.listAgentSecrets);
const setAgentSecret = vi.mocked(api.setAgentSecret);
const removeAgentSecret = vi.mocked(api.removeAgentSecret);

function agentRow(over: Partial<api.AgentRow> = {}): api.AgentRow {
  return {
    name: "alpha",
    session: "alpha-agent",
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
    mode: "single-threaded",
    vault: "default",
    status: "enabled",
    pending: [],
    systemPromptPreview: "You are a helpful agent.",
    wants: [],
    channel: "alpha",
    ...over,
  };
}

function fullDef(over: Partial<api.AgentDefFull> = {}): api.AgentDefFull {
  return {
    noteId: "note-1",
    name: "alpha",
    backend: "programmatic",
    vault: "default",
    mode: "single-threaded",
    wants: [],
    systemPrompt: "The FULL system prompt body, longer than any preview.",
    status: "enabled",
    ...over,
  };
}

function jobRow(over: Partial<api.JobRow> = {}): api.JobRow {
  return {
    id: "morning-standup",
    noteId: "Channels/alpha/jobs/morning-standup",
    channel: "alpha",
    message: "Run the morning weave.",
    schedule: { cron: "0 8 * * *" },
    enabled: true,
    createdAt: "2026-06-17T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listAgents.mockResolvedValue({ agents: [] });
  listAgentDefs.mockResolvedValue({ defs: [] });
  listAgentVaults.mockResolvedValue({ vaults: [] });
  listJobs.mockResolvedValue({ jobs: [] });
  listAgentSecrets.mockResolvedValue({ default: [], channels: {} });
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
        agentRow({ name: "tmux", backend: "interactive" }),
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

  it("shows the def's mode in the detail panel", async () => {
    listAgents.mockResolvedValue({ agents: [agentRow({ name: "alpha" })] });
    listAgentDefs.mockResolvedValue({ defs: [defRow({ name: "alpha", mode: "multi-threaded" })] });
    renderRoute();
    fireEvent.click(await screen.findByTestId("agent-row-alpha"));
    const detail = await screen.findByTestId("agent-detail");
    expect(within(detail).getByTestId("detail-mode")).toHaveTextContent("Multi-threaded");
  });

  it("does NOT show edit/delete for an agent with no backing def", async () => {
    listAgents.mockResolvedValue({ agents: [agentRow({ name: "tmux", backend: "interactive" })] });
    listAgentDefs.mockResolvedValue({ defs: [] });
    renderRoute();
    fireEvent.click(await screen.findByTestId("agent-row-tmux"));
    await screen.findByTestId("agent-detail");
    expect(screen.queryByTestId("detail-actions")).not.toBeInTheDocument();
    expect(screen.queryByTestId("edit-agent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("delete-agent")).not.toBeInTheDocument();
  });
});

describe("Agents — edit a def (Phase 4a)", () => {
  function openEdit() {
    listAgents.mockResolvedValue({ agents: [agentRow({ name: "alpha", backend: "channel" })] });
    listAgentDefs.mockResolvedValue({ defs: [defRow({ name: "alpha", mode: "single-threaded" })] });
  }

  it("edit pre-fills from getAgentDef (the FULL prompt) and PATCHes mode in metadata.mode", async () => {
    openEdit();
    getAgentDef.mockResolvedValue({
      def: fullDef({ name: "alpha", mode: "single-threaded", systemPrompt: "Original full body", wants: ["vault:x:read"] }),
    });
    editAgentDef.mockResolvedValue({ ok: true, def: defRow({ name: "alpha", mode: "multi-threaded" }) });
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-alpha"));
    fireEvent.click(await screen.findByTestId("edit-agent"));

    // Loaded the FULL def for the pre-fill.
    await waitFor(() => expect(getAgentDef).toHaveBeenCalledWith("note-1"));
    const form = await screen.findByTestId("edit-agent-form");
    const textarea = within(form).getByLabelText(/system prompt/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Original full body");

    // Flip the mode + edit the prompt, then save.
    fireEvent.click(within(form).getByTestId("edit-mode-multi-threaded"));
    fireEvent.change(textarea, { target: { value: "New body" } });
    fireEvent.click(within(form).getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(editAgentDef).toHaveBeenCalledTimes(1));
    expect(editAgentDef).toHaveBeenCalledWith("note-1", {
      systemPrompt: "New body",
      // `model` is ALWAYS sent (here "" — the def had none) so switching back to
      // Default overwrites a prior value.
      metadata: { mode: "multi-threaded", model: "" },
      wants: "vault:x:read",
    });
  });

  it("pre-fills the model from the full def and sends the changed model in metadata", async () => {
    openEdit();
    getAgentDef.mockResolvedValue({
      def: fullDef({ name: "alpha", mode: "single-threaded", systemPrompt: "Body", model: "opus" }),
    });
    editAgentDef.mockResolvedValue({ ok: true, def: defRow({ name: "alpha" }) });
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-alpha"));
    fireEvent.click(await screen.findByTestId("edit-agent"));
    const form = await screen.findByTestId("edit-agent-form");
    const select = within(form).getByTestId("edit-model") as HTMLSelectElement;
    // Pre-filled from the def.
    expect(select.value).toBe("opus");

    // Switch to sonnet + save.
    fireEvent.change(select, { target: { value: "sonnet" } });
    fireEvent.click(within(form).getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(editAgentDef).toHaveBeenCalledTimes(1));
    expect(editAgentDef.mock.calls[0]?.[1]?.metadata).toMatchObject({ model: "sonnet" });
  });

  it("surfaces a load error with a retry", async () => {
    openEdit();
    getAgentDef.mockRejectedValueOnce(new api.HttpError(500, "boom"));
    renderRoute();
    fireEvent.click(await screen.findByTestId("agent-row-alpha"));
    fireEvent.click(await screen.findByTestId("edit-agent"));
    expect(await screen.findByTestId("edit-load-error")).toHaveTextContent(/boom/i);
  });
});

describe("Agents — delete a def (Phase 4a)", () => {
  it("delete requires typing the name to confirm, then calls deleteAgentDef", async () => {
    listAgents.mockResolvedValue({ agents: [agentRow({ name: "alpha" })] });
    listAgentDefs.mockResolvedValue({ defs: [defRow({ name: "alpha" })] });
    deleteAgentDef.mockResolvedValue({ ok: true, vault: "default", name: "alpha", removed: true });
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-alpha"));
    fireEvent.click(await screen.findByTestId("delete-agent"));

    const confirmBtn = (await screen.findByTestId("delete-confirm-button")) as HTMLButtonElement;
    // Disabled until the typed name matches.
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("delete-confirm-input"), { target: { value: "wrong" } });
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("delete-confirm-input"), { target: { value: "alpha" } });
    expect(confirmBtn.disabled).toBe(false);

    fireEvent.click(confirmBtn);
    await waitFor(() => expect(deleteAgentDef).toHaveBeenCalledWith("note-1"));
  });
});

describe("Def-vaults — add / remove (Phase 4a)", () => {
  it("add calls addAgentVault with the vault name + url", async () => {
    listAgentVaults.mockResolvedValue({ vaults: [{ vault: "default", url: "http://127.0.0.1:1940", tokenPresent: true }] });
    addAgentVault.mockResolvedValue({ ok: true, vault: { vault: "research", url: "http://x", tokenPresent: true } });
    renderRoute();

    fireEvent.click(await screen.findByTestId("add-def-vault-toggle"));
    const form = await screen.findByTestId("add-def-vault-form");
    fireEvent.change(within(form).getByLabelText(/vault name/i), { target: { value: "research" } });
    fireEvent.change(within(form).getByLabelText(/vault url/i), { target: { value: "http://x" } });
    fireEvent.click(within(form).getByRole("button", { name: /add def-vault/i }));

    await waitFor(() => expect(addAgentVault).toHaveBeenCalledWith({ vault: "research", url: "http://x" }));
  });

  it("remove requires a confirm, then calls removeAgentVault", async () => {
    listAgentVaults.mockResolvedValue({
      vaults: [
        { vault: "default", url: "http://127.0.0.1:1940", tokenPresent: true },
        { vault: "research", url: "http://x", tokenPresent: true },
      ],
    });
    removeAgentVault.mockResolvedValue({ ok: true, vault: "research", removed: true });
    renderRoute();

    await screen.findByTestId("def-vault-research");
    // First click arms the confirm; the actual remove only fires on the confirm button.
    fireEvent.click(screen.getByTestId("remove-def-vault-research"));
    expect(removeAgentVault).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("remove-def-vault-confirm-research"));
    await waitFor(() => expect(removeAgentVault).toHaveBeenCalledWith("research"));
  });
});

describe("Schedules — per-agent jobs in the detail panel (Phase 4b)", () => {
  /** Open the detail panel of a vault-backed (channel) agent named "alpha". */
  function openVaultAgent() {
    listAgents.mockResolvedValue({
      agents: [agentRow({ name: "alpha", backend: "channel", channel: "alpha", vault: "default" })],
    });
    listAgentDefs.mockResolvedValue({ defs: [defRow({ name: "alpha", channel: "alpha" })] });
  }

  it("lists this agent's jobs, filtered by channel", async () => {
    openVaultAgent();
    listJobs.mockResolvedValue({
      jobs: [
        jobRow({ id: "mine", channel: "alpha", lastStatus: "ok", nextRunAt: "2026-06-20T08:00:00.000Z" }),
        jobRow({ id: "theirs", channel: "other" }), // a different agent's job — filtered out
      ],
    });
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-alpha"));
    const section = await screen.findByTestId("schedules-section");
    expect(within(section).getByTestId("schedule-row-mine")).toBeInTheDocument();
    expect(within(section).queryByTestId("schedule-row-theirs")).not.toBeInTheDocument();
    expect(within(section).getByText("ok")).toBeInTheDocument();
  });

  it("is ABSENT for a channel-less (interactive) agent", async () => {
    listAgents.mockResolvedValue({ agents: [agentRow({ name: "tmux", backend: "interactive" })] });
    listAgentDefs.mockResolvedValue({ defs: [] });
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-tmux"));
    await screen.findByTestId("agent-detail");
    expect(screen.queryByTestId("schedules-section")).not.toBeInTheDocument();
  });

  it("shows the empty state when this agent has no jobs", async () => {
    openVaultAgent();
    listJobs.mockResolvedValue({ jobs: [jobRow({ id: "theirs", channel: "other" })] });
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-alpha"));
    expect(await screen.findByTestId("schedules-empty")).toBeInTheDocument();
  });

  it("create calls createJob with the right body, scoped to the agent's channel", async () => {
    openVaultAgent();
    createJob.mockResolvedValue({ ok: true, job: jobRow({ id: "weave" }) });
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-alpha"));
    fireEvent.click(await screen.findByTestId("add-schedule-toggle"));
    const form = await screen.findByTestId("schedule-form");
    fireEvent.change(within(form).getByLabelText(/job id/i), { target: { value: "weave" } });
    fireEvent.change(within(form).getByLabelText(/message to send/i), { target: { value: "  do the weave  " } });
    fireEvent.change(within(form).getByLabelText(/cron/i), { target: { value: "0 8 * * *" } });
    fireEvent.change(within(form).getByLabelText(/timezone/i), { target: { value: "UTC" } });
    fireEvent.click(within(form).getByRole("button", { name: /create schedule/i }));

    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
    expect(createJob).toHaveBeenCalledWith({
      id: "weave",
      channel: "alpha",
      message: "do the weave", // trimmed
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      enabled: true,
    });
  });

  it("run-now calls runJob with the job id", async () => {
    openVaultAgent();
    listJobs.mockResolvedValue({ jobs: [jobRow({ id: "mine", channel: "alpha" })] });
    runJob.mockResolvedValue({ ok: true, id: "mine", status: "ok" });
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-alpha"));
    fireEvent.click(await screen.findByTestId("schedule-run-mine"));
    await waitFor(() => expect(runJob).toHaveBeenCalledWith("mine"));
  });

  it("delete requires a confirm, then calls deleteJob", async () => {
    openVaultAgent();
    listJobs.mockResolvedValue({ jobs: [jobRow({ id: "mine", channel: "alpha" })] });
    deleteJob.mockResolvedValue({ ok: true, id: "mine", removed: true });
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-alpha"));
    // First click arms the confirm; the actual delete fires only on the confirm button.
    fireEvent.click(await screen.findByTestId("schedule-delete-mine"));
    expect(deleteJob).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("schedule-delete-confirm-mine"));
    await waitFor(() => expect(deleteJob).toHaveBeenCalledWith("mine"));
  });
});

describe("Agents — per-agent secrets (#36)", () => {
  function openAgentWithChannel() {
    listAgents.mockResolvedValue({
      agents: [agentRow({ name: "alpha", backend: "programmatic", channel: "alpha", vault: "default" })],
    });
    listAgentDefs.mockResolvedValue({ defs: [defRow({ name: "alpha", channel: "alpha" })] });
  }

  it("lists this agent's env-var names (channel-scoped, values masked)", async () => {
    openAgentWithChannel();
    listAgentSecrets.mockResolvedValue({ default: ["OPERATOR_WIDE"], channels: { alpha: ["GH_TOKEN"] } });
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-alpha"));
    // The agent's channel-scoped var shows; the operator-default var does NOT.
    expect(await screen.findByTestId("secret-GH_TOKEN")).toBeInTheDocument();
    expect(screen.queryByTestId("secret-OPERATOR_WIDE")).not.toBeInTheDocument();
    // No raw value rendered.
    expect(screen.queryByText("ghp_")).not.toBeInTheDocument();
  });

  it("adds a secret scoped to the agent's channel", async () => {
    openAgentWithChannel();
    setAgentSecret.mockResolvedValue({ ok: true, scope: "channel", channel: "alpha", name: "GH_TOKEN" });
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-alpha"));
    fireEvent.click(await screen.findByTestId("add-secret-toggle"));
    const form = await screen.findByTestId("add-secret-form");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "GH_TOKEN" } });
    fireEvent.change(within(form).getByLabelText("Value"), { target: { value: "ghp_secret" } });
    fireEvent.click(within(form).getByRole("button", { name: /save secret/i }));

    await waitFor(() =>
      expect(setAgentSecret).toHaveBeenCalledWith({ channel: "alpha", name: "GH_TOKEN", value: "ghp_secret" }),
    );
  });

  it("blocks a denylisted name client-side (no API call)", async () => {
    openAgentWithChannel();
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-alpha"));
    fireEvent.click(await screen.findByTestId("add-secret-toggle"));
    const form = await screen.findByTestId("add-secret-form");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "ANTHROPIC_API_KEY" } });
    fireEvent.change(within(form).getByLabelText("Value"), { target: { value: "x" } });

    expect(await screen.findByTestId("secret-name-denylisted")).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: /save secret/i })).toBeDisabled();
    expect(setAgentSecret).not.toHaveBeenCalled();
  });

  it("removes a secret after a confirm", async () => {
    openAgentWithChannel();
    listAgentSecrets.mockResolvedValue({ default: [], channels: { alpha: ["GH_TOKEN"] } });
    removeAgentSecret.mockResolvedValue({ ok: true, scope: "channel", channel: "alpha", name: "GH_TOKEN", removed: true });
    renderRoute();

    fireEvent.click(await screen.findByTestId("agent-row-alpha"));
    fireEvent.click(await screen.findByTestId("secret-remove-GH_TOKEN"));
    expect(removeAgentSecret).not.toHaveBeenCalled(); // confirm gate
    fireEvent.click(await screen.findByTestId("secret-remove-confirm-GH_TOKEN"));
    await waitFor(() =>
      expect(removeAgentSecret).toHaveBeenCalledWith({ channel: "alpha", name: "GH_TOKEN" }),
    );
  });
});
