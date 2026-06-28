/**
 * PR 2 of the frictionless-channel-setup arc — config-management API + webhook
 * JWT auth + the prescribed trigger template.
 *
 * These cover the THREE new surfaces, all on the real daemon fetch handler:
 *
 *  A. Webhook JWT auth on POST /api/vault/inbound — a hub JWT (aud:agent,
 *     scope agent:send) is accepted and routes the note; the DEPRECATED
 *     ?secret= fallback still works; neither → 401; an insufficient scope → 401.
 *     A legacy aud:channel / channel:send token is ALSO accepted (dual-accept).
 *  B. Config-management API (agent:admin) — POST writes channels.json (600
 *     perms) + hot-adds the channel live (a subsequent inbound routes without a
 *     restart); GET never leaks token/secret; DELETE removes from file + stops
 *     routing; other scopes → 403.
 *  C. AGENT_VAULT_TRIGGER_TEMPLATE is exposed via /.parachute/config.
 *
 * The hub JWT validator is stubbed (sentinel tokens → fixed scope sets) so the
 * accept paths run without a live hub/JWKS. The no-token reject still hits the
 * real short-circuit. This mirrors the http-ui Layer-2 test's approach.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
// Re-export the REAL error class + shape helper from scope-guard in the mock
// below, so this `mock.module` (which Bun applies process-wide) doesn't break
// hub-jwt.test.ts's assertions on the genuine HubJwtError(code, message) shape.
import { HubJwtError, looksLikeJwt } from "@openparachute/scope-guard";

const SEND_TOKEN = "test-send-token"; // agent:send (the trigger token)
const ADMIN_TOKEN = "test-admin-token"; // agent:admin (config-mgmt)
const READ_TOKEN = "test-read-token"; // agent:read only (insufficient)
// A pre-rename token: aud "channel" + the legacy channel:send scope. It must
// STILL authorize the agent:send-gated webhook via requireScope's dual-accept.
const LEGACY_SEND_TOKEN = "test-legacy-send-token";
mock.module("./hub-jwt.ts", () => ({
  // NEW canonical audience + the deprecated alias kept so nothing breaks.
  AGENT_AUDIENCE: "agent",
  CHANNEL_AUDIENCE: "channel",
  async validateHubJwt(token: string) {
    // NEW-style tokens: aud "agent", agent:* scopes.
    const base = { sub: "test", aud: "agent", jti: undefined, clientId: undefined, vaultScope: undefined };
    if (token === SEND_TOKEN) return { ...base, scopes: ["agent:send"] };
    if (token === ADMIN_TOKEN) return { ...base, scopes: ["agent:admin"] };
    if (token === READ_TOKEN) return { ...base, scopes: ["agent:read"] };
    // LEGACY token: aud "channel" + channel:send — the dual-accept path.
    if (token === LEGACY_SEND_TOKEN) {
      return { sub: "test", aud: "channel", jti: undefined, clientId: undefined, vaultScope: undefined, scopes: ["channel:send"] };
    }
    throw new HubJwtError("issuer", "invalid token");
  },
  HubJwtError,
  looksLikeJwt,
  resetJwksCache() {},
  resetRevocationCache() {},
}));

import { createFetchHandler } from "./daemon.ts";
import { ClientRegistry } from "./routing.ts";
import { VaultTransport, AGENT_VAULT_TRIGGER_TEMPLATE } from "./transports/vault.ts";
import { channelsFilePath } from "./registry.ts";
import type { Channel } from "./registry.ts";
import {
  credentialsFilePath,
  resolveClaudeCredential,
  resolveChannelEnv,
  describeChannelEnv,
} from "./credentials.ts";
import type { TransportContext, InboundMessage } from "./transport.ts";
import { setStepUpPin, mintStepUpToken, _resetStepUpTokensForTest } from "./step-up.ts";

const sendAuth = { authorization: "Bearer " + SEND_TOKEN } as const;
const adminAuth = { authorization: "Bearer " + ADMIN_TOKEN } as const;
const readAuth = { authorization: "Bearer " + READ_TOKEN } as const;
const legacySendAuth = { authorization: "Bearer " + LEGACY_SEND_TOKEN } as const;

let stateDir: string;
/**
 * agent:admin Bearer + a valid step-up token (agent#80). The credential-store
 * routes (D + E below) are step-up-gated; this header lets the store-behavior
 * tests reach the handler. The dedicated step-up tests live in
 * daemon-step-up.test.ts. Recomputed per test in `beforeEach`.
 */
let stepAdminAuth: Record<string, string>;

beforeEach(async () => {
  // Sandbox channels.json under a throwaway state dir — the config API resolves
  // STATE_DIR from PARACHUTE_AGENT_STATE_DIR (read once at daemon module load),
  // so set it BEFORE importing... but the module is already imported. Instead the
  // daemon's STATE_DIR is captured at module init; we set the env to a temp dir
  // and the tests that touch the file assert under that path. Re-resolve per test.
  stateDir = mkdtempSync(join(tmpdir(), "agent-cfg-"));
  process.env.PARACHUTE_AGENT_STATE_DIR = stateDir;
  // Step-up: configure a PIN + mint a token so the credential-store routes pass
  // their step-up gate. The store under test is in this same temp dir.
  _resetStepUpTokensForTest();
  await setStepUpPin("4242", stateDir);
  stepAdminAuth = { ...adminAuth, "x-step-up-token": mintStepUpToken().token };
});

afterEach(() => {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// A vault channel + a recording ctx, wired through the real fetch handler.
// ---------------------------------------------------------------------------
// `secret`: a string → that shared secret; `null` → a JWT-only channel with NO
// webhookSecret configured; omitted → defaults to "s3cret".
function buildServer(initial: Array<{ name: string; secret?: string | null }> = [{ name: "eng", secret: "s3cret" }]) {
  const registry = new ClientRegistry();
  const channels = new Map<string, Channel>();
  const emitted: InboundMessage[] = [];
  for (const { name, secret } of initial) {
    const transport = new VaultTransport({
      vault: "default",
      vaultUrl: "http://127.0.0.1:1940",
      token: "x",
      declareSchemaOnStart: false, // fake token — don't 401 the live vault (#32)
      // null → omit (JWT-only channel); undefined → default "s3cret".
      ...(secret === null ? {} : { webhookSecret: secret ?? "s3cret" }),
    });
    const ctx: TransportContext = {
      channel: name,
      emit(msg) {
        emitted.push(msg);
      },
      emitPermissionVerdict() {},
    };
    void transport.start(ctx);
    channels.set(name, { name, transport, entry: { name, transport: "vault", config: { vault: "default" } } });
  }
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: createFetchHandler(channels, registry) });
  return { srv, base: `http://127.0.0.1:${srv.port}`, emitted, channels };
}

function inboundBody(noteId: string, channel = "eng") {
  return JSON.stringify({
    trigger: "channel-inbound",
    event: "created",
    note: {
      id: noteId,
      path: `channel/${channel}/${noteId}`,
      content: "wake up session",
      tags: ["agent/message", "agent/message/inbound"],
      metadata: { channel, direction: "inbound", sender: "aaron" },
    },
  });
}

// ===========================================================================
// A. Webhook JWT auth on POST /api/vault/inbound
// ===========================================================================
describe("A — webhook hub-JWT auth (agent:send), secret fallback retained", () => {
  test("valid agent:send JWT → 200 + routes the note (emits)", async () => {
    const { srv, base, emitted } = buildServer();
    try {
      const res = await fetch(`${base}/api/vault/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json", ...sendAuth },
        body: inboundBody("jwt-1"),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.channel).toBe("eng");
      expect(emitted[0]!.meta.note_id).toBe("jwt-1");
    } finally {
      srv.stop(true);
    }
  });

  test("DUAL-ACCEPT: a LEGACY channel:send JWT (aud:channel) STILL authorizes the agent:send-gated webhook → 200 + emits", async () => {
    // requireScope dual-accepts a pre-rename `channel:<verb>` scope for the
    // matching `agent:<verb>` gate, and validateHubJwt accepts aud "channel" in
    // addition to "agent". So a token minted before the channel→agent rename
    // (aud "channel", scope "channel:send") must keep routing inbound notes
    // until it's re-minted — no flag-day for live triggers.
    const { srv, base, emitted } = buildServer();
    try {
      const res = await fetch(`${base}/api/vault/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json", ...legacySendAuth },
        body: inboundBody("legacy-1"),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.channel).toBe("eng");
      expect(emitted[0]!.meta.note_id).toBe("legacy-1");
    } finally {
      srv.stop(true);
    }
  });

  test("an agent:read-only JWT → 401 (uniform on the webhook — no scope/channel probing), no emit", async () => {
    // The webhook collapses insufficient-scope to a uniform 401 (unlike the
    // operator-facing config API, which returns 403). This tailnet-reachable
    // endpoint stays opaque to scope/channel enumeration.
    const { srv, base, emitted } = buildServer();
    try {
      const res = await fetch(`${base}/api/vault/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json", ...readAuth },
        body: inboundBody("jwt-ro"),
      });
      expect(res.status).toBe(401);
      expect(emitted).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });

  test("a bad/garbage Bearer → 401, no emit", async () => {
    const { srv, base, emitted } = buildServer();
    try {
      const res = await fetch(`${base}/api/vault/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer nope" },
        body: inboundBody("jwt-bad"),
      });
      expect(res.status).toBe(401);
      expect(emitted).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });

  test("no Bearer AND no secret → 401, no emit", async () => {
    const { srv, base, emitted } = buildServer();
    try {
      const res = await fetch(`${base}/api/vault/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: inboundBody("none"),
      });
      expect(res.status).toBe(401);
      expect(emitted).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });

  test("M1 — whitespace-only `Authorization: Bearer ` + a VALID ?secret= → 401 (no fallthrough to the secret path)", async () => {
    // An Authorization header present-but-empty must take the JWT path and fail
    // hard — it must NOT fall through to the deprecated ?secret= path even though
    // the secret is correct. Branching on header PRESENCE (not token truthiness)
    // is what closes this auth-confusion.
    const { srv, base, emitted } = buildServer([{ name: "eng", secret: "s3cret" }]);
    try {
      const res = await fetch(`${base}/api/vault/inbound?secret=s3cret`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer    " },
        body: inboundBody("ws-1"),
      });
      expect(res.status).toBe(401);
      expect(emitted).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });

  test("M2 — a JWT-only channel (NO webhookSecret) accepts a valid agent:send JWT → 200 + emits", async () => {
    const { srv, base, emitted } = buildServer([{ name: "eng", secret: null }]);
    try {
      const res = await fetch(`${base}/api/vault/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json", ...sendAuth },
        body: inboundBody("jwtonly-1"),
      });
      expect(res.status).toBe(200);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.channel).toBe("eng");
    } finally {
      srv.stop(true);
    }
  });

  test("M2 — a JWT-only channel (NO webhookSecret) 401s a no-auth request (nothing to validate against)", async () => {
    const { srv, base, emitted } = buildServer([{ name: "eng", secret: null }]);
    try {
      // No Authorization header → ?secret= fallback. The channel has no configured
      // secret, so an empty/any `?secret=` can never match → 401 (no "undefined ===
      // undefined" passing). Also assert an explicit empty ?secret= stays 401.
      const noAuth = await fetch(`${base}/api/vault/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: inboundBody("jwtonly-noauth"),
      });
      expect(noAuth.status).toBe(401);
      const emptySecret = await fetch(`${base}/api/vault/inbound?secret=`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: inboundBody("jwtonly-emptysecret"),
      });
      expect(emptySecret.status).toBe(401);
      expect(emitted).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });

  test("DEPRECATED ?secret= fallback still works (200 + emits + logs a warning)", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    const { srv, base, emitted } = buildServer();
    try {
      const res = await fetch(`${base}/api/vault/inbound?secret=s3cret`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: inboundBody("sec-1"),
      });
      expect(res.status).toBe(200);
      expect(emitted).toHaveLength(1);
      expect(warnings.some((w) => w.includes("DEPRECATED") && w.includes("eng"))).toBe(true);
    } finally {
      console.warn = origWarn;
      srv.stop(true);
    }
  });

  test("valid JWT but unknown channel → uniform 401 (no enumeration), no emit", async () => {
    const { srv, base, emitted } = buildServer();
    try {
      const res = await fetch(`${base}/api/vault/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json", ...sendAuth },
        body: inboundBody("ghost", "nope"),
      });
      expect(res.status).toBe(401);
      expect(emitted).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });
});

// ===========================================================================
// B. Config-management API (agent:admin)
// ===========================================================================
describe("B — config-management API (agent:admin)", () => {
  test("POST without agent:admin → 403 (other scope) / 401 (none)", async () => {
    const { srv, base } = buildServer([]);
    try {
      const none = await fetch(`${base}/api/channels`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x", transport: "http-ui" }),
      });
      expect(none.status).toBe(401);

      const wrong = await fetch(`${base}/api/channels`, {
        method: "POST",
        headers: { "content-type": "application/json", ...sendAuth },
        body: JSON.stringify({ name: "x", transport: "http-ui" }),
      });
      expect(wrong.status).toBe(403);
    } finally {
      srv.stop(true);
    }
  });

  test("POST writes channels.json (600 perms) + hot-adds the channel LIVE (inbound routes, no restart)", async () => {
    const { srv, base } = buildServer([]); // start with NO channels
    try {
      const create = await fetch(`${base}/api/channels`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({
          name: "eng",
          transport: "vault",
          config: { vault: "default", vaultUrl: "http://127.0.0.1:1940", token: "vault-jwt", webhookSecret: "sek", declareSchemaOnStart: false },
        }),
      });
      expect(create.status).toBe(200);
      expect(await create.json()).toMatchObject({ ok: true, name: "eng", transport: "vault", live: true });

      // channels.json written, with the token, at 0600.
      const file = channelsFilePath(stateDir);
      expect(existsSync(file)).toBe(true);
      const onDisk = JSON.parse(readFileSync(file, "utf8")) as { channels: Array<{ name: string; config?: Record<string, unknown> }> };
      expect(onDisk.channels.map((c) => c.name)).toContain("eng");
      const engEntry = onDisk.channels.find((c) => c.name === "eng")!;
      expect(engEntry.config!.token).toBe("vault-jwt"); // the file DOES hold the token
      const mode = statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);

      // HOT-ADD proof #1: the new channel is in the LIVE registry — /health lists it.
      const health = (await (await fetch(`${base}/health`)).json()) as { channels: Array<{ name: string; kind: string }> };
      expect(health.channels.map((c) => c.name)).toContain("eng");
      expect(health.channels.find((c) => c.name === "eng")!.kind).toBe("vault");

      // HOT-ADD proof #2: a subsequent inbound for the new channel ROUTES (200 →
      // the channel is live + the secret authorizes) WITHOUT a restart. An unknown
      // channel would 401; routing to its transport's ingestInbound is what makes
      // this 200. (The hot-added transport emits into the real ClientRegistry, not
      // this test's recorder, so we assert on the routed 200 + health, not `emitted`.)
      const inbound = await fetch(`${base}/api/vault/inbound?secret=sek`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: inboundBody("hot-1", "eng"),
      });
      expect(inbound.status).toBe(200);

      // HOT-ADD proof #3 (nit): a JWT-authenticated inbound (agent:send) also
      // routes on the freshly hot-added channel — the JWT path is live too, not
      // just the secret fallback.
      const jwtInbound = await fetch(`${base}/api/vault/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json", ...sendAuth },
        body: inboundBody("hot-jwt-1", "eng"),
      });
      expect(jwtInbound.status).toBe(200);
    } finally {
      srv.stop(true);
    }
  });

  test("POST replaces an existing channel (stops the old transport, new config wins)", async () => {
    const { srv, base } = buildServer([{ name: "eng", secret: "old" }]);
    try {
      const res = await fetch(`${base}/api/channels`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({
          name: "eng",
          transport: "vault",
          config: { vault: "default", token: "x", webhookSecret: "new", declareSchemaOnStart: false },
        }),
      });
      expect(res.status).toBe(200);
      // New secret takes effect; old one no longer authorizes.
      const oldSecret = await fetch(`${base}/api/vault/inbound?secret=old`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: inboundBody("r-old", "eng"),
      });
      expect(oldSecret.status).toBe(401);
      const newSecret = await fetch(`${base}/api/vault/inbound?secret=new`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: inboundBody("r-new", "eng"),
      });
      expect(newSecret.status).toBe(200);
    } finally {
      srv.stop(true);
    }
  });

  test("POST with an invalid config (vault channel, no token) → 400, nothing persisted", async () => {
    const { srv, base } = buildServer([]);
    try {
      const res = await fetch(`${base}/api/channels`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ name: "bad", transport: "vault", config: { vault: "default" } }),
      });
      expect(res.status).toBe(400);
      // channels.json must not have been created with the broken entry.
      const file = channelsFilePath(stateDir);
      if (existsSync(file)) {
        const onDisk = JSON.parse(readFileSync(file, "utf8")) as { channels: Array<{ name: string }> };
        expect(onDisk.channels.map((c) => c.name)).not.toContain("bad");
      }
    } finally {
      srv.stop(true);
    }
  });

  test("GET lists channels (name + transport + vault) — NEVER token/secret", async () => {
    const { srv, base } = buildServer([{ name: "eng", secret: "s3cret" }]);
    try {
      const res = await fetch(`${base}/api/channels`, { headers: { ...adminAuth } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { channels: Array<Record<string, unknown>> };
      expect(body.channels).toHaveLength(1);
      const eng = body.channels[0]!;
      expect(eng.name).toBe("eng");
      expect(eng.transport).toBe("vault");
      expect(eng.vault).toBe("default");
      // No credential fields leak.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("s3cret");
      expect(serialized).not.toContain("token");
      expect(serialized).not.toContain("webhookSecret");
    } finally {
      srv.stop(true);
    }
  });

  test("telegram channel: POST persists a per-channel bot token in config.token; GET never leaks it", async () => {
    const { srv, base } = buildServer([]);
    try {
      const create = await fetch(`${base}/api/channels`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({
          name: "tg",
          transport: "telegram",
          config: { token: "777:SUPER-SECRET-BOT-TOKEN", stateDir },
        }),
      });
      expect(create.status).toBe(200);
      expect(await create.json()).toMatchObject({ ok: true, name: "tg", transport: "telegram", live: true });

      // The bot token IS persisted to channels.json (chmod 600, holds secrets).
      const file = channelsFilePath(stateDir);
      const onDisk = JSON.parse(readFileSync(file, "utf8")) as {
        channels: Array<{ name: string; transport: string; config?: Record<string, unknown> }>;
      };
      const tg = onDisk.channels.find((c) => c.name === "tg")!;
      expect(tg.transport).toBe("telegram");
      expect(tg.config!.token).toBe("777:SUPER-SECRET-BOT-TOKEN");
      const mode = statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);

      // GET /api/channels must NOT echo the bot token (same redaction posture as
      // the vault transport's token/webhookSecret).
      const list = await fetch(`${base}/api/channels`, { headers: { ...adminAuth } });
      expect(list.status).toBe(200);
      const body = (await list.json()) as { channels: Array<Record<string, unknown>> };
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("SUPER-SECRET-BOT-TOKEN");
      expect(serialized).not.toContain("token");
      // The row still surfaces name + transport.
      const row = body.channels.find((c) => c.name === "tg")!;
      expect(row.transport).toBe("telegram");

      // /health likewise doesn't leak the token.
      const health = await (await fetch(`${base}/health`)).text();
      expect(health).not.toContain("SUPER-SECRET-BOT-TOKEN");
    } finally {
      // Stop the telegram poll loop before tearing the server down.
      await fetch(`${base}/api/channels/tg`, { method: "DELETE", headers: { ...adminAuth } }).catch(() => {});
      srv.stop(true);
    }
  });

  test("GET without agent:admin → 401 (none) / 403 (wrong scope)", async () => {
    const { srv, base } = buildServer([]);
    try {
      expect((await fetch(`${base}/api/channels`)).status).toBe(401);
      expect((await fetch(`${base}/api/channels`, { headers: { ...readAuth } })).status).toBe(403);
    } finally {
      srv.stop(true);
    }
  });

  test("DELETE removes the channel from channels.json + stops routing", async () => {
    const { srv, base, emitted } = buildServer([]);
    try {
      // Add it via the API so it's both on disk and live.
      await fetch(`${base}/api/channels`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ name: "eng", transport: "vault", config: { vault: "default", token: "x", webhookSecret: "sek", declareSchemaOnStart: false } }),
      });
      const file = channelsFilePath(stateDir);
      expect((JSON.parse(readFileSync(file, "utf8")) as { channels: unknown[] }).channels).toHaveLength(1);

      const del = await fetch(`${base}/api/channels/eng`, { method: "DELETE", headers: { ...adminAuth } });
      expect(del.status).toBe(200);
      expect(await del.json()).toMatchObject({ ok: true, name: "eng", removed: true });

      // Gone from disk.
      expect((JSON.parse(readFileSync(file, "utf8")) as { channels: unknown[] }).channels).toHaveLength(0);
      // Routing stopped — an inbound for the deleted channel is now an unknown
      // channel → uniform 401, no emit.
      const inbound = await fetch(`${base}/api/vault/inbound?secret=sek`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: inboundBody("after-del", "eng"),
      });
      expect(inbound.status).toBe(401);
      expect(emitted).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });

  test("DELETE without agent:admin → 401/403", async () => {
    const { srv, base } = buildServer([{ name: "eng" }]);
    try {
      expect((await fetch(`${base}/api/channels/eng`, { method: "DELETE" })).status).toBe(401);
      expect((await fetch(`${base}/api/channels/eng`, { method: "DELETE", headers: { ...readAuth } })).status).toBe(403);
    } finally {
      srv.stop(true);
    }
  });
});

// ===========================================================================
// C. Prescribed trigger template exposed via /.parachute/config
// ===========================================================================
describe("C — AGENT_VAULT_TRIGGER_TEMPLATE exposed via /.parachute/config", () => {
  test("GET /.parachute/config carries triggerTemplate (the module-owned trigger shape)", async () => {
    const { srv, base } = buildServer([{ name: "eng" }]);
    try {
      const res = await fetch(`${base}/.parachute/config`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { channels: unknown[]; triggerTemplate: typeof AGENT_VAULT_TRIGGER_TEMPLATE };
      expect(body.triggerTemplate).toEqual(AGENT_VAULT_TRIGGER_TEMPLATE);
      // Sanity on the shape the hub depends on (placeholders + webhook path).
      // The trigger NAME stays `channel_inbound_<channel>` — kept STABLE so
      // re-registration updates the existing trigger in place. The TAG is
      // #agent/message and the webhook is on the /agent mount.
      expect(body.triggerTemplate.name).toBe("channel_inbound_<channel>");
      expect(body.triggerTemplate.when.tags).toEqual(["agent/message/inbound"]);
      // CONTRACT: the predicate keys on the `agent` routing key (was `channel`).
      expect(body.triggerTemplate.when.has_metadata).toEqual(["agent"]);
      // The rendered-at marker NAME is unchanged (cosmetic/internal).
      expect(body.triggerTemplate.when.missing_metadata).toEqual(["channel_inbound_rendered_at"]);
      expect(body.triggerTemplate.action.webhook).toBe("<hub-origin>/agent/api/vault/inbound");
    } finally {
      srv.stop(true);
    }
  });
});

// ===========================================================================
// D. Claude OAuth credential store API (agent:admin) — design §6
// ===========================================================================
describe("D — Claude credential store API (agent:admin)", () => {
  test("POST /api/credentials/claude sets the default; persisted 0600; resolve returns it", async () => {
    const { srv, base } = buildServer([]);
    try {
      const res = await fetch(`${base}/api/credentials/claude`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ token: "oat_DEFAULT-OPERATOR" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, scope: "default" });

      const file = credentialsFilePath(stateDir);
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      // The token resolves for any channel (no override → default).
      expect(resolveClaudeCredential("any-channel", stateDir)).toBe("oat_DEFAULT-OPERATOR");
    } finally {
      srv.stop(true);
    }
  });

  test("POST /api/credentials/claude/:channel sets an override that WINS over the default", async () => {
    const { srv, base } = buildServer([]);
    try {
      await fetch(`${base}/api/credentials/claude`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ token: "oat_DEFAULT" }),
      });
      const res = await fetch(`${base}/api/credentials/claude/aaron-dev`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ token: "oat_AARON-OVERRIDE" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, scope: "channel", channel: "aaron-dev" });

      expect(resolveClaudeCredential("aaron-dev", stateDir)).toBe("oat_AARON-OVERRIDE"); // override wins
      expect(resolveClaudeCredential("other", stateDir)).toBe("oat_DEFAULT"); // other → default
    } finally {
      srv.stop(true);
    }
  });

  test("GET /api/credentials/claude reports presence + channel names — NEVER the token", async () => {
    const { srv, base } = buildServer([]);
    try {
      await fetch(`${base}/api/credentials/claude`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ token: "oat_SECRET-DEFAULT" }),
      });
      await fetch(`${base}/api/credentials/claude/aaron-dev`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ token: "oat_SECRET-OVERRIDE" }),
      });

      const res = await fetch(`${base}/api/credentials/claude`, { headers: { ...adminAuth } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { defaultSet: boolean; channels: string[] };
      expect(body.defaultSet).toBe(true);
      expect(body.channels).toEqual(["aaron-dev"]);
      // No secret leaks.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("oat_SECRET-DEFAULT");
      expect(serialized).not.toContain("oat_SECRET-OVERRIDE");
    } finally {
      srv.stop(true);
    }
  });

  test("DELETE /api/credentials/claude/:channel removes the override (falls back to default)", async () => {
    const { srv, base } = buildServer([]);
    try {
      await fetch(`${base}/api/credentials/claude`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ token: "oat_DEFAULT" }),
      });
      await fetch(`${base}/api/credentials/claude/aaron-dev`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ token: "oat_OVERRIDE" }),
      });
      const del = await fetch(`${base}/api/credentials/claude/aaron-dev`, {
        method: "DELETE",
        headers: { ...stepAdminAuth },
      });
      expect(del.status).toBe(200);
      expect(await del.json()).toMatchObject({ ok: true, channel: "aaron-dev", removed: true });
      expect(resolveClaudeCredential("aaron-dev", stateDir)).toBe("oat_DEFAULT"); // back to default
    } finally {
      srv.stop(true);
    }
  });

  test("POST with an empty/missing token → 400, nothing persisted", async () => {
    const { srv, base } = buildServer([]);
    try {
      const empty = await fetch(`${base}/api/credentials/claude`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ token: "" }),
      });
      expect(empty.status).toBe(400);
      const missing = await fetch(`${base}/api/credentials/claude`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({}),
      });
      expect(missing.status).toBe(400);
      expect(existsSync(credentialsFilePath(stateDir))).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("credential API without agent:admin → 401 (none) / 403 (wrong scope), on every verb", async () => {
    const { srv, base } = buildServer([]);
    try {
      // GET default
      expect((await fetch(`${base}/api/credentials/claude`)).status).toBe(401);
      expect((await fetch(`${base}/api/credentials/claude`, { headers: { ...readAuth } })).status).toBe(403);
      // POST default
      expect(
        (await fetch(`${base}/api/credentials/claude`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "x" }),
        })).status,
      ).toBe(401);
      expect(
        (await fetch(`${base}/api/credentials/claude`, {
          method: "POST",
          headers: { "content-type": "application/json", ...sendAuth },
          body: JSON.stringify({ token: "x" }),
        })).status,
      ).toBe(403);
      // POST per-channel
      expect(
        (await fetch(`${base}/api/credentials/claude/c`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "x" }),
        })).status,
      ).toBe(401);
      expect(
        (await fetch(`${base}/api/credentials/claude/c`, {
          method: "POST",
          headers: { "content-type": "application/json", ...readAuth },
          body: JSON.stringify({ token: "x" }),
        })).status,
      ).toBe(403);
      // DELETE per-channel
      expect((await fetch(`${base}/api/credentials/claude/c`, { method: "DELETE" })).status).toBe(401);
      expect(
        (await fetch(`${base}/api/credentials/claude/c`, { method: "DELETE", headers: { ...readAuth } })).status,
      ).toBe(403);
      // Nothing was persisted by any unauthorized call.
      expect(existsSync(credentialsFilePath(stateDir))).toBe(false);
    } finally {
      srv.stop(true);
    }
  });
});

// ===========================================================================
// E. Generic per-channel ENV-VAR store API (agent:admin)
// ===========================================================================
describe("E — per-channel env-var store API (agent:admin)", () => {
  test("POST /api/credentials/env sets a default var; 0600; resolves for any channel", async () => {
    const { srv, base } = buildServer([]);
    try {
      const res = await fetch(`${base}/api/credentials/env`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ name: "GH_TOKEN", value: "ghp_DEFAULT-SECRET" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, scope: "default", name: "GH_TOKEN" });

      const file = credentialsFilePath(stateDir);
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(resolveChannelEnv("any-channel", stateDir)).toEqual({ GH_TOKEN: "ghp_DEFAULT-SECRET" });
    } finally {
      srv.stop(true);
    }
  });

  test("POST with a channel sets an override that WINS over the default", async () => {
    const { srv, base } = buildServer([]);
    try {
      await fetch(`${base}/api/credentials/env`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ name: "GH_TOKEN", value: "ghp_DEFAULT" }),
      });
      const res = await fetch(`${base}/api/credentials/env`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ channel: "aaron-dev", name: "GH_TOKEN", value: "ghp_AARON" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, scope: "channel", channel: "aaron-dev", name: "GH_TOKEN" });

      expect(resolveChannelEnv("aaron-dev", stateDir)).toEqual({ GH_TOKEN: "ghp_AARON" }); // override wins
      expect(resolveChannelEnv("other", stateDir)).toEqual({ GH_TOKEN: "ghp_DEFAULT" }); // other → default
    } finally {
      srv.stop(true);
    }
  });

  test("POST a DENYLISTED name → 400, nothing persisted (subscription-billing guarantee)", async () => {
    const { srv, base } = buildServer([]);
    try {
      for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
        const res = await fetch(`${base}/api/credentials/env`, {
          method: "POST",
          headers: { "content-type": "application/json", ...stepAdminAuth },
          body: JSON.stringify({ name, value: "x" }),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toMatch(/Claude auth|reserved|not settable/);
      }
      expect(existsSync(credentialsFilePath(stateDir))).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("GET reports names per layer — NEVER the values", async () => {
    const { srv, base } = buildServer([]);
    try {
      await fetch(`${base}/api/credentials/env`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ name: "GH_TOKEN", value: "ghp_SECRET-DEFAULT" }),
      });
      await fetch(`${base}/api/credentials/env`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ channel: "aaron-dev", name: "CLOUDFLARE_API_TOKEN", value: "cf_SECRET" }),
      });
      const res = await fetch(`${base}/api/credentials/env`, { headers: { ...adminAuth } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { default: string[]; channels: Record<string, string[]> };
      expect(body.default).toEqual(["GH_TOKEN"]);
      expect(body.channels["aaron-dev"]).toEqual(["CLOUDFLARE_API_TOKEN"]);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("ghp_SECRET-DEFAULT");
      expect(serialized).not.toContain("cf_SECRET");
    } finally {
      srv.stop(true);
    }
  });

  test("DELETE removes a var (default + channel); the default re-emerges after a channel delete", async () => {
    const { srv, base } = buildServer([]);
    try {
      await fetch(`${base}/api/credentials/env`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ name: "GH_TOKEN", value: "ghp_DEFAULT" }),
      });
      await fetch(`${base}/api/credentials/env`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ channel: "aaron-dev", name: "GH_TOKEN", value: "ghp_AARON" }),
      });
      // Delete the channel override (via body).
      const del = await fetch(`${base}/api/credentials/env`, {
        method: "DELETE",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ channel: "aaron-dev", name: "GH_TOKEN" }),
      });
      expect(del.status).toBe(200);
      expect(await del.json()).toMatchObject({ ok: true, scope: "channel", channel: "aaron-dev", name: "GH_TOKEN", removed: true });
      expect(resolveChannelEnv("aaron-dev", stateDir)).toEqual({ GH_TOKEN: "ghp_DEFAULT" }); // back to default

      // Delete the default too.
      const delDef = await fetch(`${base}/api/credentials/env`, {
        method: "DELETE",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ name: "GH_TOKEN" }),
      });
      expect(delDef.status).toBe(200);
      expect(await delDef.json()).toMatchObject({ ok: true, scope: "default", name: "GH_TOKEN", removed: true });
      expect(describeChannelEnv(stateDir)).toEqual({ default: [], channels: {} });
    } finally {
      srv.stop(true);
    }
  });

  test("POST with an empty/missing name or value → 400, nothing persisted", async () => {
    const { srv, base } = buildServer([]);
    try {
      const noName = await fetch(`${base}/api/credentials/env`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ value: "x" }),
      });
      expect(noName.status).toBe(400);
      const noVal = await fetch(`${base}/api/credentials/env`, {
        method: "POST",
        headers: { "content-type": "application/json", ...stepAdminAuth },
        body: JSON.stringify({ name: "GH_TOKEN" }),
      });
      expect(noVal.status).toBe(400);
      expect(existsSync(credentialsFilePath(stateDir))).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("env API without agent:admin → 401 (none) / 403 (wrong scope), on every verb", async () => {
    const { srv, base } = buildServer([]);
    try {
      expect((await fetch(`${base}/api/credentials/env`)).status).toBe(401);
      expect((await fetch(`${base}/api/credentials/env`, { headers: { ...readAuth } })).status).toBe(403);
      expect(
        (await fetch(`${base}/api/credentials/env`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "GH_TOKEN", value: "x" }),
        })).status,
      ).toBe(401);
      expect(
        (await fetch(`${base}/api/credentials/env`, {
          method: "POST",
          headers: { "content-type": "application/json", ...sendAuth },
          body: JSON.stringify({ name: "GH_TOKEN", value: "x" }),
        })).status,
      ).toBe(403);
      expect(
        (await fetch(`${base}/api/credentials/env`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "GH_TOKEN" }),
        })).status,
      ).toBe(401);
      expect(existsSync(credentialsFilePath(stateDir))).toBe(false);
    } finally {
      srv.stop(true);
    }
  });
});
