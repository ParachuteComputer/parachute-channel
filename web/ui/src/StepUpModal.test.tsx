/**
 * StepUpModal tests (agent#80, #154).
 *
 * Focus: the modal's `friendly()` error mapping — specifically the 429 (rate-limit
 * lockout) path. The daemon 429s a PIN exchange after 5 wrong attempts in 5 min
 * (`stepUpLimiter`); the modal must surface a friendly lockout message, NOT the raw
 * "PIN exchange failed: 429" string. We drive the real provider → prompt → submit
 * flow with `exchangePin` mocked to throw `HttpError(429)`.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as stepUp from "./lib/step-up.ts";
import { HttpError } from "./lib/api.ts";

// Keep the REAL registration bridge (registerStepUpPrompt / requestStepUpToken) so the
// provider wires up its prompt handler; override only the network calls.
vi.mock("./lib/step-up.ts", async (orig) => {
  const actual = (await orig()) as typeof stepUp;
  return {
    ...actual,
    exchangePin: vi.fn(),
    setPin: vi.fn(),
    getStepUpStatus: vi.fn(async () => ({ configured: true })),
  };
});

import { StepUpProvider } from "./StepUpModal.tsx";
import { requestStepUpToken, registerStepUpPrompt } from "./lib/step-up.ts";

const exchangePin = vi.mocked(stepUp.exchangePin);

beforeEach(() => {
  vi.clearAllMocks();
  stepUp._resetStepUpForTest();
});

afterEach(() => {
  registerStepUpPrompt(null);
});

describe("StepUpModal — friendly() error mapping", () => {
  it("shows the lockout message on a 429 (rate-limit) from the PIN exchange (#154)", async () => {
    exchangePin.mockRejectedValue(new HttpError(429, "rate_limited"));
    render(
      <StepUpProvider>
        <div />
      </StepUpProvider>,
    );

    // The provider registers a prompt handler on mount; driving a "token" reason
    // opens the PIN-prompt modal (the same path api.ts:authedFetch takes on a
    // 403 step_up_required).
    let pending: Promise<string | null>;
    act(() => {
      pending = requestStepUpToken("token");
    });

    // Enter a PIN and submit; the mocked exchange rejects 429.
    const input = await screen.findByLabelText("PIN");
    await userEvent.type(input, "0000");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    // friendly(HttpError(429)) → the lockout message, NOT the raw error.
    expect(
      await screen.findByText("Too many attempts — wait a minute and try again."),
    ).toBeInTheDocument();
    expect(exchangePin).toHaveBeenCalledWith("0000");
    // The modal stays open (the action did not resolve with a token).
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // A 401 maps to the "Incorrect PIN." message (regression guard alongside 429).
    exchangePin.mockRejectedValueOnce(new HttpError(401, "invalid_pin"));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Incorrect PIN.")).toBeInTheDocument();

    // Cancel resolves the pending request with null (no leaked promise).
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(pending).resolves.toBeNull());
  });
});
