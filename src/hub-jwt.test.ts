/**
 * Tests for the agent-side hub-JWT adapter. These exercise the parts that
 * DON'T need a live hub / JWKS endpoint: hub-origin resolution (env precedence →
 * expose-state self-heal → loopback fallback), the audience constants, and the
 * re-exported pure helpers (`looksLikeJwt`). Real signature/issuer/audience
 * validation is scope-guard's own tested surface — we don't re-test it here and
 * we never need a real JWKS.
 *
 * Audience constants (channel→agent rename, rule 1): the daemon now mints/
 * validates `aud: "agent"` (`AGENT_AUDIENCE`); the pre-rename `aud: "channel"`
 * (`CHANNEL_AUDIENCE`, deprecated) still validates during the dual-accept window
 * via `ACCEPTED_AUDIENCES`. We assert both constants here. The dual-ACCEPT itself
 * (a `channel`-aud token still validating) lives in `validateHubJwt`, which needs
 * a live JWKS to exercise — that's scope-guard's tested surface, not re-tested here.
 *
 * The self-heal reads `<PARACHUTE_HOME>/expose-state.json`. Every case here
 * points `PARACHUTE_HOME` at a fresh temp dir so the operator's real
 * `~/.parachute/expose-state.json` can't leak into the loopback assertions.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getHubOrigin,
  AGENT_AUDIENCE,
  CHANNEL_AUDIENCE,
  ACCEPTED_AUDIENCES,
  looksLikeJwt,
  HubJwtError,
} from "./hub-jwt.ts";

const savedOrigin = process.env.PARACHUTE_HUB_ORIGIN;
const savedHome = process.env.PARACHUTE_HOME;

let home: string;

beforeEach(() => {
  // Isolated, empty ecosystem root — no expose-state.json unless a case writes one.
  home = mkdtempSync(join(tmpdir(), "agent-hubjwt-"));
  process.env.PARACHUTE_HOME = home;
});

afterEach(() => {
  if (savedOrigin === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = savedOrigin;
  if (savedHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = savedHome;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

function writeExposeState(obj: Record<string, unknown>): void {
  writeFileSync(join(home, "expose-state.json"), JSON.stringify(obj));
}

describe("getHubOrigin — env precedence", () => {
  test("uses the env value when set", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "https://hub.example.com";
    expect(getHubOrigin()).toBe("https://hub.example.com");
  });

  test("strips a single trailing slash for a canonical form", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "https://hub.example.com/";
    expect(getHubOrigin()).toBe("https://hub.example.com");
  });

  test("env wins over expose-state (highest precedence)", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "https://env.example.com";
    writeExposeState({ hubOrigin: "https://exposed.example.com" });
    expect(getHubOrigin()).toBe("https://env.example.com");
  });
});

describe("getHubOrigin — expose-state self-heal (agent#34)", () => {
  test("reads expose-state.hubOrigin when env is unset", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    writeExposeState({ hubOrigin: "https://exposed.example.com" });
    expect(getHubOrigin()).toBe("https://exposed.example.com");
  });

  test("reads expose-state.hubOrigin when env is empty", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "";
    writeExposeState({ hubOrigin: "https://exposed.example.com" });
    expect(getHubOrigin()).toBe("https://exposed.example.com");
  });

  test("synthesizes https://<canonicalFqdn> for older state files lacking hubOrigin", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    writeExposeState({ canonicalFqdn: "box.taildf9ce2.ts.net" });
    expect(getHubOrigin()).toBe("https://box.taildf9ce2.ts.net");
  });

  test("strips a trailing slash off the expose-state origin", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    writeExposeState({ hubOrigin: "https://exposed.example.com/" });
    expect(getHubOrigin()).toBe("https://exposed.example.com");
  });

  test("never self-heals to a loopback expose-state origin", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    writeExposeState({ hubOrigin: "http://127.0.0.1:1939" });
    expect(getHubOrigin()).toBe("http://127.0.0.1:1939"); // loopback default, not a self-heal
  });
});

describe("getHubOrigin — loopback fallback", () => {
  test("falls back to loopback when env unset AND no expose-state file", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    expect(getHubOrigin()).toBe("http://127.0.0.1:1939");
  });

  test("falls back to loopback when env empty AND no expose-state file", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "";
    expect(getHubOrigin()).toBe("http://127.0.0.1:1939");
  });

  test("falls back to loopback when expose-state has no usable origin", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    writeExposeState({ layer: "tailnet" }); // neither hubOrigin nor canonicalFqdn
    expect(getHubOrigin()).toBe("http://127.0.0.1:1939");
  });

  test("falls back to loopback when expose-state is malformed JSON", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    writeFileSync(join(home, "expose-state.json"), "{ not json");
    expect(getHubOrigin()).toBe("http://127.0.0.1:1939");
  });
});

describe("audience constants (channel→agent dual-accept, rule 1)", () => {
  test("AGENT_AUDIENCE is the literal 'agent' (what the hub mints aud as now)", () => {
    expect(AGENT_AUDIENCE).toBe("agent");
  });

  test("CHANNEL_AUDIENCE is the deprecated legacy literal 'channel' (pre-rename tokens)", () => {
    expect(CHANNEL_AUDIENCE).toBe("channel");
  });

  test("ACCEPTED_AUDIENCES carries BOTH — new 'agent' + legacy 'channel' (the dual-accept set)", () => {
    // The resource-server backstop: a token whose aud is neither (e.g. minted for
    // a vault) is rejected; both transitional forms validate until live re-mint.
    expect([...ACCEPTED_AUDIENCES]).toEqual(["agent", "channel"]);
    expect(ACCEPTED_AUDIENCES).toContain(AGENT_AUDIENCE);
    expect(ACCEPTED_AUDIENCES).toContain(CHANNEL_AUDIENCE);
  });
});

describe("re-exported helpers", () => {
  test("looksLikeJwt recognizes the eyJ prefix", () => {
    expect(looksLikeJwt("eyJhbGciOiJSUzI1NiJ9.payload.sig")).toBe(true);
    expect(looksLikeJwt("opaque-shared-secret")).toBe(false);
  });

  test("HubJwtError is the scope-guard error class", () => {
    const err = new HubJwtError("issuer", "bad iss");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("issuer");
  });
});
