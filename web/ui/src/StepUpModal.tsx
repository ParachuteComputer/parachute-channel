/**
 * Step-up PIN modal + provider (agent#80).
 *
 * The dangerous `agent:admin` actions (set credentials, open a terminal, spawn a
 * `filesystem: full` agent) require a step-up token, obtained by entering the
 * operator's PIN. The daemon ENFORCES this server-side; this is the UI affordance.
 *
 * Two flows, driven by the daemon's `403 step_up_required` `reason`:
 *   - `"setup"` — no PIN configured yet → FIRST-TIME setup (set + confirm a new PIN),
 *     which then immediately exchanges it for a token so the gated action proceeds.
 *   - `"token"` — a PIN exists → PROMPT for it, exchange for a token.
 *
 * The provider registers a prompt handler with `lib/step-up.ts`, so the data layer
 * (`lib/api.ts:authedFetch`) can trigger it on any gated request with no
 * per-call-site plumbing. The promise resolves to the minted token (action
 * proceeds) or null (operator cancelled → the 403 surfaces normally).
 *
 * It also renders a standalone "Set / change step-up PIN" control consumers can
 * mount in settings via {@link useStepUp}().openSettings().
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  registerStepUpPrompt,
  exchangePin,
  setPin,
  getStepUpStatus,
  type StepUpReason,
} from "./lib/step-up.ts";
import { HttpError } from "./lib/api.ts";

type Mode = "prompt" | "setup" | "settings";

interface OpenState {
  mode: Mode;
  /** Resolver for the data-layer prompt (null for the settings flow). */
  resolve: ((token: string | null) => void) | null;
}

interface StepUpContextValue {
  /** Open the "set / change PIN" settings flow (not tied to a gated request). */
  openSettings: () => void;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

/** Access the step-up controls (the settings opener). */
export function useStepUp(): StepUpContextValue {
  const ctx = useContext(StepUpContext);
  if (!ctx) throw new Error("useStepUp must be used inside <StepUpProvider>");
  return ctx;
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<OpenState | null>(null);

  // Register the data-layer prompt handler. On a 403 step_up_required, api.ts
  // calls this; we open the modal and resolve when the operator submits/cancels.
  useEffect(() => {
    registerStepUpPrompt((reason: StepUpReason) => {
      return new Promise<string | null>((resolve) => {
        setOpen({ mode: reason === "setup" ? "setup" : "prompt", resolve });
      });
    });
    return () => registerStepUpPrompt(null);
  }, []);

  const close = useCallback(
    (token: string | null) => {
      setOpen((cur) => {
        cur?.resolve?.(token);
        return null;
      });
    },
    [],
  );

  const ctx = useMemo<StepUpContextValue>(
    () => ({
      openSettings: () => setOpen({ mode: "settings", resolve: null }),
    }),
    [],
  );

  return (
    <StepUpContext.Provider value={ctx}>
      {children}
      {open && <StepUpDialog state={open} onClose={close} />}
    </StepUpContext.Provider>
  );
}

function StepUpDialog({ state, onClose }: { state: OpenState; onClose: (token: string | null) => void }) {
  const { mode } = state;
  const [pin, setPinValue] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Settings flow needs to know whether a PIN already exists (rotation vs first-set).
  const [hasPin, setHasPin] = useState<boolean | null>(mode === "settings" ? null : mode !== "setup");
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  // For the settings flow, resolve whether a PIN already exists.
  useEffect(() => {
    if (mode !== "settings") return;
    let alive = true;
    getStepUpStatus()
      .then((s) => alive && setHasPin(s.configured))
      .catch(() => alive && setHasPin(false));
    return () => {
      alive = false;
    };
  }, [mode]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onClose(null);
    },
    [onClose],
  );

  function friendly(err: unknown): string {
    if (err instanceof HttpError) {
      if (err.status === 401) return "Incorrect PIN.";
      if (err.status === 429) return "Too many attempts — wait a minute and try again.";
      if (err.status === 400) return "PIN must be 4–12 digits.";
      return err.message || "Something went wrong.";
    }
    return err instanceof Error ? err.message : "Something went wrong.";
  }

  // --- the "prompt" flow: enter the existing PIN → exchange → resolve ---------
  async function submitPrompt() {
    setError(null);
    setBusy(true);
    try {
      const token = await exchangePin(pin);
      onClose(token);
    } catch (err) {
      setError(friendly(err));
      setBusy(false);
    }
  }

  // --- the "setup" flow (first-time, triggered by a gated action): set a new
  //     PIN, then immediately exchange it so the action proceeds ----------------
  async function submitSetup() {
    setError(null);
    if (newPin !== confirmPin) {
      setError("The PINs don't match.");
      return;
    }
    setBusy(true);
    try {
      await setPin(newPin);
      const token = await exchangePin(newPin);
      onClose(token);
    } catch (err) {
      setError(friendly(err));
      setBusy(false);
    }
  }

  // --- the "settings" flow: set or rotate the PIN (NOT tied to an action) -----
  async function submitSettings() {
    setError(null);
    if (newPin !== confirmPin) {
      setError("The PINs don't match.");
      return;
    }
    setBusy(true);
    try {
      await setPin(newPin, hasPin ? currentPin : undefined);
      onClose(null); // settings flow doesn't return a token
    } catch (err) {
      setError(friendly(err));
      setBusy(false);
    }
  }

  return (
    <div className="step-up-backdrop" role="presentation" onClick={() => onClose(null)}>
      <div
        className="step-up-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Step-up PIN"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {mode === "prompt" && (
          <>
            <h2>Confirm with your PIN</h2>
            <p className="step-up-sub">
              This is a high-privilege action. Enter your step-up PIN to continue.
            </p>
            <PinField label="PIN" value={pin} onChange={setPinValue} inputRef={firstInputRef} />
          </>
        )}

        {mode === "setup" && (
          <>
            <h2>Set a step-up PIN</h2>
            <p className="step-up-sub">
              High-privilege actions (set credentials, open a terminal, spawn a full-filesystem
              agent) require a PIN. Set one now to continue.
            </p>
            <PinField label="New PIN (4–12 digits)" value={newPin} onChange={setNewPin} inputRef={firstInputRef} />
            <PinField label="Confirm PIN" value={confirmPin} onChange={setConfirmPin} />
          </>
        )}

        {mode === "settings" && (
          <>
            <h2>{hasPin ? "Change step-up PIN" : "Set step-up PIN"}</h2>
            <p className="step-up-sub">
              The step-up PIN gates high-privilege admin actions (set credentials, open a terminal,
              spawn a full-filesystem agent) as a second factor on top of your login.
            </p>
            {hasPin && (
              <PinField label="Current PIN" value={currentPin} onChange={setCurrentPin} inputRef={firstInputRef} />
            )}
            <PinField
              label={hasPin ? "New PIN (4–12 digits)" : "New PIN (4–12 digits)"}
              value={newPin}
              onChange={setNewPin}
              inputRef={hasPin ? undefined : firstInputRef}
            />
            <PinField label="Confirm PIN" value={confirmPin} onChange={setConfirmPin} />
          </>
        )}

        {error && (
          <p className="step-up-error" role="alert">
            {error}
          </p>
        )}

        <div className="step-up-actions">
          <button type="button" className="secondary" onClick={() => onClose(null)} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={
              mode === "prompt" ? submitPrompt : mode === "setup" ? submitSetup : submitSettings
            }
            disabled={busy || (mode === "settings" && hasPin === null)}
          >
            {busy ? "Working…" : mode === "prompt" ? "Confirm" : "Save PIN"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PinField({
  label,
  value,
  onChange,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <label className="step-up-field">
      <span>{label}</span>
      <input
        ref={inputRef}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        value={value}
        // Digits only, ≤12 — mirrors the daemon's PIN format.
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, "").slice(0, 12))}
      />
    </label>
  );
}
