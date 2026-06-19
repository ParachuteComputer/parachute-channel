/**
 * CreateAgent route tests (Agent UI v2, Phase 3) — the unified create flow.
 *
 * Covers: the form renders; submit calls `createAgentDef` with the correct body
 * INCLUDING `metadata.mode`; mode defaults to single-threaded; backend defaults
 * to programmatic; `interactive` is NEVER offered as a backend; the
 * backend:channel success state shows the `claude mcp add` one-liner; and the
 * no-def-vaults case surfaces the requirement. The api module is mocked per the
 * existing pattern (`Agents.test.tsx`).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { CreateAgent } from "./CreateAgent.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    createAgentDef: vi.fn(),
    listAgentVaults: vi.fn(),
  };
});

const createAgentDef = vi.mocked(api.createAgentDef);

function vaultRow(over: Partial<api.AgentVaultRow> = {}): api.AgentVaultRow {
  return { vault: "default", url: "http://127.0.0.1:1940", tokenPresent: true, ...over };
}

function defResponse(over: Partial<api.AgentDefRow> = {}): api.CreateAgentDefResponse {
  return {
    ok: true,
    def: {
      noteId: "note-1",
      name: "my-agent",
      backend: "programmatic",
      vault: "default",
      status: "enabled",
      pending: [],
      systemPromptPreview: "",
      wants: [],
      channel: "my-agent",
      ...over,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createAgentDef.mockResolvedValue(defResponse());
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderForm(vaults: api.AgentVaultRow[] = [vaultRow()]) {
  return render(
    <MemoryRouter>
      <CreateAgent vaults={vaults} />
    </MemoryRouter>,
  );
}

describe("CreateAgent form", () => {
  it("renders the name field, mode, backend, and a submit button", () => {
    renderForm();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByTestId("mode-single-threaded")).toBeInTheDocument();
    expect(screen.getByTestId("mode-multi-threaded")).toBeInTheDocument();
    expect(screen.getByTestId("backend-programmatic")).toBeInTheDocument();
    expect(screen.getByTestId("backend-channel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create agent/i })).toBeInTheDocument();
  });

  it("defaults mode to single-threaded and backend to programmatic", () => {
    renderForm();
    const single = within(screen.getByTestId("mode-single-threaded")).getByRole("radio");
    const prog = within(screen.getByTestId("backend-programmatic")).getByRole("radio");
    expect(single).toBeChecked();
    expect(prog).toBeChecked();
  });

  it("NEVER offers `interactive` as a backend", () => {
    renderForm();
    expect(screen.queryByTestId("backend-interactive")).not.toBeInTheDocument();
    expect(screen.queryByText(/interactive/i)).not.toBeInTheDocument();
    // Only the two documented radios exist.
    const radios = screen.getAllByRole("radio");
    const backendValues = radios
      .map((r) => (r as HTMLInputElement).value)
      .filter((v) => v === "programmatic" || v === "channel" || v === "interactive");
    expect(backendValues).toEqual(["programmatic", "channel"]);
  });

  it("submits createAgentDef with the correct body including metadata.mode", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "my-agent" } });
    fireEvent.change(screen.getByLabelText("System prompt"), {
      target: { value: "You are a helpful agent." },
    });
    fireEvent.click(screen.getByRole("button", { name: /create agent/i }));

    await waitFor(() => expect(createAgentDef).toHaveBeenCalledTimes(1));
    expect(createAgentDef).toHaveBeenCalledWith({
      vault: "default",
      name: "my-agent",
      backend: "programmatic",
      systemPrompt: "You are a helpful agent.",
      metadata: { mode: "single-threaded" },
    });
  });

  it("carries the chosen mode into metadata.mode (multi-threaded)", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "batch" } });
    fireEvent.click(within(screen.getByTestId("mode-multi-threaded")).getByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: /create agent/i }));

    await waitFor(() => expect(createAgentDef).toHaveBeenCalledTimes(1));
    expect(createAgentDef.mock.calls[0]![0].metadata).toEqual({ mode: "multi-threaded" });
  });

  it("includes `wants` only when entered", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "wanty" } });
    fireEvent.change(screen.getByLabelText(/wants/i), {
      target: { value: "vault:other, service:github" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create agent/i }));

    await waitFor(() => expect(createAgentDef).toHaveBeenCalledTimes(1));
    expect(createAgentDef.mock.calls[0]![0].wants).toBe("vault:other, service:github");
  });

  it("blocks submit until the name is a valid slug", async () => {
    renderForm();
    const submit = screen.getByRole("button", { name: /create agent/i });
    expect(submit).toBeDisabled(); // empty name
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "bad name!" } });
    expect(screen.getByTestId("name-invalid")).toBeInTheDocument();
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "good-name" } });
    expect(submit).toBeEnabled();
  });

  it("shows a success state with name + backend and a link back to agents", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "my-agent" } });
    fireEvent.click(screen.getByRole("button", { name: /create agent/i }));

    const success = await screen.findByTestId("create-success");
    expect(within(success).getByText("my-agent")).toBeInTheDocument();
    expect(within(success).getByText(/programmatic/)).toBeInTheDocument();
    expect(within(success).getByRole("link", { name: /back to agents/i })).toBeInTheDocument();
  });

  it("does NOT show the connect one-liner for a programmatic agent", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "prog" } });
    fireEvent.click(screen.getByRole("button", { name: /create agent/i }));
    await screen.findByTestId("create-success");
    expect(screen.queryByTestId("connect-session")).not.toBeInTheDocument();
  });

  it("shows the `claude mcp add` one-liner on a backend:channel success", async () => {
    createAgentDef.mockResolvedValue(defResponse({ name: "eng", backend: "channel", channel: "eng" }));
    renderForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "eng" } });
    fireEvent.click(within(screen.getByTestId("backend-channel")).getByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: /create agent/i }));

    const connect = await screen.findByTestId("connect-session");
    const command = within(connect).getByTestId("connect-command").textContent ?? "";
    expect(command).toMatch(/^claude mcp add --transport http --scope user agent-eng /);
    expect(command).toContain("/mcp/eng");
    // The body was sent with backend:channel.
    expect(createAgentDef.mock.calls[0]![0].backend).toBe("channel");
  });

  it("surfaces a daemon 400 error inline", async () => {
    createAgentDef.mockRejectedValue(new api.HttpError(400, "no def-vaults configured"));
    renderForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /create agent/i }));
    expect(await screen.findByTestId("create-error")).toHaveTextContent(/no def-vaults configured/i);
  });

  it("surfaces the def-vault requirement when none are configured and disables submit", () => {
    renderForm([]);
    expect(screen.getByTestId("no-def-vaults")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create agent/i })).toBeDisabled();
  });
});
