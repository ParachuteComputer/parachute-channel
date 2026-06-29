/**
 * Step-up auth (PIN) HTTP surface + gating — agent#80, on the real daemon fetch
 * handler.
 *
 * Covers:
 *   A. PIN setup + exchange endpoints (`/api/step-up`, `/api/step-up/pin`):
 *      first-time setup, rotation requires the current PIN, wrong PIN → 401 +
 *      rate-limited lockout, the exchange mints a token, the PIN is never returned.
 *   B. Gating — each dangerous endpoint 403s `step_up_required` WITHOUT a valid
 *      step-up token and SUCCEEDS with one:
 *        - POST/DELETE /api/credentials/claude[/:channel]
 *        - POST/DELETE /api/credentials/env
 *        - the terminal WS upgrade (authorizeTerminalUpgrade) via `?step_up=`
 *        - POST /api/agents with `filesystem: "full"` (ordinary spawn is NOT gated)
 *   C. The 403 step_up_required is DISTINCT from a 401 (no/invalid Bearer); a GET
 *      status read is NOT gated.
 *
 * The hub JWT validator is stubbed (sentinel tokens → fixed scopes), mirroring
 * daemon-config-api.test.ts, so the accept paths run without a live hub/JWKS. The
 * step-up PIN store + token store are the REAL `step-up.ts` against a temp dir.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { HubJwtError, looksLikeJwt } from "@openparachute/scope-guard";

const ADMIN_TOKEN = "test-admin-token"; // agent:admin
const READ_TOKEN = "test-read-token"; // agent:read only (insufficient)

mock.module("./hub-jwt.ts", () => ({
  AGENT_AUDIENCE: "agent",
  CHANNEL_AUDIENCE: "channel",
  async validateHubJwt(token: string) {
    const base = { sub: "operator", aud: "agent", jti: undefined, clientId: undefined, vaultScope: undefined };
    if (token === ADMIN_TOKEN) return { ...base, scopes: ["agent:read", "agent:send", "agent:admin"] };
    if (token === READ_TOKEN) return { ...base, scopes: ["agent:read"] };
    throw new HubJwtError("issuer", "invalid token");
  },
  HubJwtError,
  looksLikeJwt,
  getHubOrigin() {
    return "http://127.0.0.1:1939";
  },
  resetJwksCache() {},
  resetRevocationCache() {},
}));

import { createFetchHandler, authorizeTerminalUpgrade } from "./daemon.ts";
import { ClientRegistry } from "./routing.ts";
import type { Channel } from "./registry.ts";
import { _resetStepUpTokensForTest, stepUpLimiter } from "./step-up.ts";

const adminAuth = { authorization: "Bearer " + ADMIN_TOKEN } as const;
const readAuth = { authorization: "Bearer " + READ_TOKEN } as const;

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "agent-stepup-http-"));
  process.env.PARACHUTE_AGENT_STATE_DIR = stateDir;
  _resetStepUpTokensForTest();
  stepUpLimiter.reset();
});

afterEach(() => {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {}
});

function buildServer() {
  const registry = new ClientRegistry();
  const channels = new Map<string, Channel>();
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: createFetchHandler(channels, registry),
  });
  return { srv, base: `http://127.0.0.1:${srv.port}`, channels, registry };
}

/** Set a PIN, then exchange it for a fresh step-up token. Returns the token. */
async function setupAndExchange(base: string, pin = "4242"): Promise<string> {
  const setRes = await fetch(`${base}/api/step-up/pin`, {
    method: "POST",
    headers: { "content-type": "application/json", ...adminAuth },
    body: JSON.stringify({ newPin: pin }),
  });
  expect(setRes.status).toBe(200);
  const exRes = await fetch(`${base}/api/step-up`, {
    method: "POST",
    headers: { "content-type": "application/json", ...adminAuth },
    body: JSON.stringify({ pin }),
  });
  expect(exRes.status).toBe(200);
  const body = (await exRes.json()) as { stepUpToken: string };
  return body.stepUpToken;
}

// ===========================================================================
// A. PIN setup + exchange
// ===========================================================================
describe("A — PIN setup + exchange", () => {
  test("GET /api/step-up reports configured:false, then true after a PIN is set", async () => {
    const { srv, base } = buildServer();
    try {
      let res = await fetch(`${base}/api/step-up`, { headers: adminAuth });
      expect(res.status).toBe(200);
      expect((await res.json()).configured).toBe(false);

      res = await fetch(`${base}/api/step-up/pin`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ newPin: "4242" }),
      });
      expect(res.status).toBe(200);

      res = await fetch(`${base}/api/step-up`, { headers: adminAuth });
      expect((await res.json()).configured).toBe(true);
    } finally {
      srv.stop(true);
    }
  });

  test("the step-up endpoints require agent:admin (read-only → 403, no token → 401)", async () => {
    const { srv, base } = buildServer();
    try {
      const noTok = await fetch(`${base}/api/step-up`, { method: "GET" });
      expect(noTok.status).toBe(401);
      const readTok = await fetch(`${base}/api/step-up`, { method: "GET", headers: readAuth });
      expect(readTok.status).toBe(403);
      const setRead = await fetch(`${base}/api/step-up/pin`, {
        method: "POST",
        headers: { "content-type": "application/json", ...readAuth },
        body: JSON.stringify({ newPin: "4242" }),
      });
      expect(setRead.status).toBe(403);
    } finally {
      srv.stop(true);
    }
  });

  test("exchange before any PIN is configured → 409 step_up_not_configured", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/step-up`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ pin: "4242" }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("step_up_not_configured");
    } finally {
      srv.stop(true);
    }
  });

  test("exchange with the correct PIN mints a token; the PIN is never returned", async () => {
    const { srv, base } = buildServer();
    try {
      const token = await setupAndExchange(base, "4242");
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThanOrEqual(43);
      // Re-run the exchange and inspect the raw body for any leak of the PIN.
      const res = await fetch(`${base}/api/step-up`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ pin: "4242" }),
      });
      const raw = await res.text();
      expect(raw.includes("4242")).toBe(false);
      expect(raw).toContain("stepUpToken");
      expect(raw).toContain("expires_at");
    } finally {
      srv.stop(true);
    }
  });

  test("wrong PIN → 401 invalid_pin (and never echoes the PIN)", async () => {
    const { srv, base } = buildServer();
    try {
      await fetch(`${base}/api/step-up/pin`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ newPin: "4242" }),
      });
      const res = await fetch(`${base}/api/step-up`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ pin: "0000" }),
      });
      expect(res.status).toBe(401);
      const raw = await res.text();
      expect(JSON.parse(raw).error).toBe("invalid_pin");
      expect(raw.includes("0000")).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("rate-limit: 5 wrong PINs then locked out (429 with retry-after)", async () => {
    const { srv, base } = buildServer();
    try {
      await fetch(`${base}/api/step-up/pin`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ newPin: "4242" }),
      });
      // 5 wrong attempts are admitted to the verify (all 401), the 6th is locked out.
      for (let i = 0; i < 5; i++) {
        const r = await fetch(`${base}/api/step-up`, {
          method: "POST",
          headers: { "content-type": "application/json", ...adminAuth },
          body: JSON.stringify({ pin: "0000" }),
        });
        expect(r.status).toBe(401);
      }
      const sixth = await fetch(`${base}/api/step-up`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ pin: "0000" }),
      });
      expect(sixth.status).toBe(429);
      expect(sixth.headers.get("retry-after")).toBeTruthy();
      const body = (await sixth.json()) as { error: string; retry_after_seconds: number };
      expect(body.error).toBe("rate_limited");
      expect(body.retry_after_seconds).toBeGreaterThanOrEqual(1);
    } finally {
      srv.stop(true);
    }
  });

  test("a SUCCESSFUL PIN entry clears the lockout bucket", async () => {
    const { srv, base } = buildServer();
    try {
      await fetch(`${base}/api/step-up/pin`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ newPin: "4242" }),
      });
      // 4 wrong, then a correct one — the bucket resets, so we don't hit 429.
      for (let i = 0; i < 4; i++) {
        await fetch(`${base}/api/step-up`, {
          method: "POST",
          headers: { "content-type": "application/json", ...adminAuth },
          body: JSON.stringify({ pin: "0000" }),
        });
      }
      const good = await fetch(`${base}/api/step-up`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ pin: "4242" }),
      });
      expect(good.status).toBe(200);
      // Now several MORE wrong attempts don't immediately 429 (bucket was cleared).
      const next = await fetch(`${base}/api/step-up`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ pin: "0000" }),
      });
      expect(next.status).toBe(401);
    } finally {
      srv.stop(true);
    }
  });

  test("rotation requires the current PIN (wrong/absent → 401; correct → 200)", async () => {
    const { srv, base } = buildServer();
    try {
      await fetch(`${base}/api/step-up/pin`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ newPin: "4242" }),
      });
      // No currentPin → 401.
      let res = await fetch(`${base}/api/step-up/pin`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ newPin: "9999" }),
      });
      expect(res.status).toBe(401);
      // Wrong currentPin → 401.
      res = await fetch(`${base}/api/step-up/pin`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ newPin: "9999", currentPin: "0000" }),
      });
      expect(res.status).toBe(401);
      // Correct currentPin → 200 + the new PIN exchanges.
      res = await fetch(`${base}/api/step-up/pin`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ newPin: "9999", currentPin: "4242" }),
      });
      expect(res.status).toBe(200);
      const ex = await fetch(`${base}/api/step-up`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ pin: "9999" }),
      });
      expect(ex.status).toBe(200);
    } finally {
      srv.stop(true);
    }
  });

  test("a malformed newPin → 400", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/step-up/pin`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ newPin: "12" }),
      });
      expect(res.status).toBe(400);
    } finally {
      srv.stop(true);
    }
  });
});

// ===========================================================================
// B. Gating — dangerous endpoints require a step-up token
// ===========================================================================
describe("B — set-credentials gating (Claude token + env store)", () => {
  test("POST /api/credentials/claude: no step-up → 403 step_up_required; with token → 200", async () => {
    const { srv, base } = buildServer();
    try {
      // Before any PIN: 403 with reason "setup" (UI runs first-time setup).
      let res = await fetch(`${base}/api/credentials/claude`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ token: "sk-x" }),
      });
      expect(res.status).toBe(403);
      let body = (await res.json()) as { error: string; reason: string };
      expect(body.error).toBe("step_up_required");
      expect(body.reason).toBe("setup");

      // After setup but WITHOUT a token: 403 with reason "token".
      const stepToken = await setupAndExchange(base);
      res = await fetch(`${base}/api/credentials/claude`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ token: "sk-x" }),
      });
      expect(res.status).toBe(403);
      body = (await res.json()) as { error: string; reason: string };
      expect(body.error).toBe("step_up_required");
      expect(body.reason).toBe("token");

      // WITH a valid step-up token: 200.
      res = await fetch(`${base}/api/credentials/claude`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-step-up-token": stepToken, ...adminAuth },
        body: JSON.stringify({ token: "sk-x" }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    } finally {
      srv.stop(true);
    }
  });

  test("GET /api/credentials/claude (status read) is NOT step-up-gated", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/credentials/claude`, { headers: adminAuth });
      expect(res.status).toBe(200);
      expect((await res.json()).defaultSet).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("POST + DELETE /api/credentials/claude/:channel are gated", async () => {
    const { srv, base } = buildServer();
    try {
      const stepToken = await setupAndExchange(base);
      // POST without token → 403.
      let res = await fetch(`${base}/api/credentials/claude/eng`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ token: "sk-x" }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("step_up_required");
      // POST with token → 200.
      res = await fetch(`${base}/api/credentials/claude/eng`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-step-up-token": stepToken, ...adminAuth },
        body: JSON.stringify({ token: "sk-x" }),
      });
      expect(res.status).toBe(200);
      // DELETE without token → 403.
      res = await fetch(`${base}/api/credentials/claude/eng`, { method: "DELETE", headers: adminAuth });
      expect(res.status).toBe(403);
      // DELETE with token → 200.
      res = await fetch(`${base}/api/credentials/claude/eng`, {
        method: "DELETE",
        headers: { "x-step-up-token": stepToken, ...adminAuth },
      });
      expect(res.status).toBe(200);
    } finally {
      srv.stop(true);
    }
  });

  test("POST + DELETE /api/credentials/env are gated; GET is not", async () => {
    const { srv, base } = buildServer();
    try {
      const stepToken = await setupAndExchange(base);
      // GET (status) → 200 without a step-up token.
      let res = await fetch(`${base}/api/credentials/env`, { headers: adminAuth });
      expect(res.status).toBe(200);
      // POST without token → 403.
      res = await fetch(`${base}/api/credentials/env`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ name: "GH_TOKEN", value: "ghp_x" }),
      });
      expect(res.status).toBe(403);
      // POST with token → 200.
      res = await fetch(`${base}/api/credentials/env`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-step-up-token": stepToken, ...adminAuth },
        body: JSON.stringify({ name: "GH_TOKEN", value: "ghp_x" }),
      });
      expect(res.status).toBe(200);
      // DELETE without token → 403.
      res = await fetch(`${base}/api/credentials/env`, {
        method: "DELETE",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ name: "GH_TOKEN" }),
      });
      expect(res.status).toBe(403);
    } finally {
      srv.stop(true);
    }
  });
});

describe("B — terminal WS gating (?step_up=)", () => {
  function termReq(base: string, qs = "") {
    return new Request(`${base}/terminal/myagent${qs}`, {
      headers: { ...adminAuth, upgrade: "websocket" },
    });
  }

  test("no step-up (PIN set, no token) → 403 step_up_required", async () => {
    const { srv, base } = buildServer();
    try {
      await setupAndExchange(base); // sets a PIN
      const req = termReq(base);
      const decision = await authorizeTerminalUpgrade(req, new URL(req.url), new Map(), "myagent");
      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.response.status).toBe(403);
        expect((await decision.response.json()).error).toBe("step_up_required");
      }
    } finally {
      srv.stop(true);
    }
  });

  test("with a valid ?step_up= token → authorized", async () => {
    const { srv, base } = buildServer();
    try {
      const stepToken = await setupAndExchange(base);
      const req = termReq(base, `?step_up=${encodeURIComponent(stepToken)}`);
      const decision = await authorizeTerminalUpgrade(req, new URL(req.url), new Map(), "myagent");
      expect(decision.ok).toBe(true);
    } finally {
      srv.stop(true);
    }
  });

  test("a bad Bearer still 401s BEFORE step-up is consulted (distinct from 403)", async () => {
    const { srv, base } = buildServer();
    try {
      await setupAndExchange(base);
      const req = new Request(`${base}/terminal/myagent`, {
        headers: { authorization: "Bearer bogus", upgrade: "websocket" },
      });
      const decision = await authorizeTerminalUpgrade(req, new URL(req.url), new Map(), "myagent");
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.response.status).toBe(401);
    } finally {
      srv.stop(true);
    }
  });
});

describe("B — filesystem:full spawn gating (sandboxed spawn NOT gated)", () => {
  test("POST /api/agents { filesystem: 'full' } without step-up → 403", async () => {
    const { srv, base } = buildServer();
    try {
      await setupAndExchange(base);
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ name: "danger", channels: ["c"], filesystem: "full" }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("step_up_required");
    } finally {
      srv.stop(true);
    }
  });

  test("an ORDINARY (workspace / default) spawn is NOT step-up-gated", async () => {
    const { srv, base } = buildServer();
    try {
      await setupAndExchange(base);
      // No step-up token. A default-filesystem spawn should pass the step-up gate
      // (it may still 400 on a missing Claude credential, but NOT 403 step_up_required).
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ name: "safe", channels: ["c"], filesystem: "workspace" }),
      });
      expect(res.status).not.toBe(403);
      if (res.status === 403) {
        // Make the failure legible if this ever regresses.
        expect((await res.json()).error).not.toBe("step_up_required");
      }
    } finally {
      srv.stop(true);
    }
  });
});

// ===========================================================================
// C. Deliberate NON-gates (#154) — these admin POSTs are intentionally NOT
// step-up-gated. Pin the exclusions so a future reader doesn't "fix" a non-gap:
//   - POST /api/agent-vaults — mints a VAULT-scoped token (lower blast radius).
//   - POST /api/agent-defs   — authoring a #agent/definition note already requires
//     a scope-gated vault:write; the filesystem:full SPAWN path is gated, not this.
// A PIN is configured (so a gate, if wrongly present, would 403 reason:"token"
// rather than "setup"); no step-up token is sent. The handlers may fail downstream
// for other reasons (e.g. no def-vaults), but MUST NOT 403 step_up_required.
// ===========================================================================
describe("C — deliberate non-gates (#154)", () => {
  test("POST /api/agent-vaults is NOT step-up-gated (vault-scoped token, lower blast radius)", async () => {
    const { srv, base } = buildServer();
    try {
      await setupAndExchange(base); // a PIN exists, but we deliberately send no step-up token
      const res = await fetch(`${base}/api/agent-vaults`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ vault: "default" }),
      });
      expect(res.status).not.toBe(403);
      if (res.status === 403) {
        expect((await res.json()).error).not.toBe("step_up_required");
      }
    } finally {
      srv.stop(true);
    }
  });

  test("POST /api/agent-defs is NOT step-up-gated (authoring already requires vault:write)", async () => {
    const { srv, base } = buildServer();
    try {
      await setupAndExchange(base); // a PIN exists, but we deliberately send no step-up token
      const res = await fetch(`${base}/api/agent-defs`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ vault: "default", name: "x", backend: "programmatic", systemPrompt: "" }),
      });
      // With no def-vaults configured the handler 400s — what matters is it never
      // 403s step_up_required (the authoring path is intentionally not gated).
      expect(res.status).not.toBe(403);
      if (res.status === 403) {
        expect((await res.json()).error).not.toBe("step_up_required");
      }
    } finally {
      srv.stop(true);
    }
  });
});
