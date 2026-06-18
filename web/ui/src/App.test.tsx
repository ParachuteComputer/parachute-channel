/**
 * App shell smoke test — nav renders, Home routes to the Agents view, and the
 * basename detection picks the right mount prefix.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "./lib/api.ts";
import { App } from "./App.tsx";
import { detectBasename } from "./lib/basename.ts";

vi.mock("./lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listAgents: vi.fn(async () => ({ agents: [] })),
    listAgentDefs: vi.fn(async () => ({ defs: [] })),
    listAgentVaults: vi.fn(async () => ({ vaults: [] })),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App shell", () => {
  it("renders the brand wordmark + the Agents nav link", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText("Parachute Agent")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agents" })).toBeInTheDocument();
  });

  it("routes Home to the Agents view", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Agents", level: 1 })).toBeInTheDocument();
  });

  it("renders a 404 for an unknown route", () => {
    render(
      <MemoryRouter initialEntries={["/nope"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText(/404/)).toBeInTheDocument();
  });
});

describe("detectBasename", () => {
  it("maps the hub-proxied /agent/app mount", () => {
    expect(detectBasename("/agent/app/")).toBe("/agent/app");
    expect(detectBasename("/agent/app/agents")).toBe("/agent/app");
  });

  it("maps the daemon-direct /app mount", () => {
    expect(detectBasename("/app")).toBe("/app");
    expect(detectBasename("/app/agents")).toBe("/app");
  });

  it("returns empty for the dev origin root", () => {
    expect(detectBasename("/")).toBe("");
  });
});
