/**
 * Tests for the channel-side hub-JWT adapter. These exercise the parts that
 * DON'T need a live hub / JWKS endpoint: hub-origin resolution (env precedence +
 * loopback fallback), the audience constant, and the re-exported pure helpers
 * (`looksLikeJwt`). Real signature/issuer/audience validation is scope-guard's
 * own tested surface — we don't re-test it here and we never need a real JWKS.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  getHubOrigin,
  CHANNEL_AUDIENCE,
  looksLikeJwt,
  HubJwtError,
} from "./hub-jwt.ts";

const savedOrigin = process.env.PARACHUTE_HUB_ORIGIN;

afterEach(() => {
  if (savedOrigin === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = savedOrigin;
});

describe("getHubOrigin", () => {
  test("falls back to loopback when PARACHUTE_HUB_ORIGIN is unset", () => {
    delete process.env.PARACHUTE_HUB_ORIGIN;
    expect(getHubOrigin()).toBe("http://127.0.0.1:1939");
  });

  test("falls back to loopback when PARACHUTE_HUB_ORIGIN is empty", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "";
    expect(getHubOrigin()).toBe("http://127.0.0.1:1939");
  });

  test("uses the env value when set", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "https://hub.example.com";
    expect(getHubOrigin()).toBe("https://hub.example.com");
  });

  test("strips a single trailing slash for a canonical form", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "https://hub.example.com/";
    expect(getHubOrigin()).toBe("https://hub.example.com");
  });
});

describe("CHANNEL_AUDIENCE", () => {
  test("is the literal 'channel' (what the hub mints aud as)", () => {
    expect(CHANNEL_AUDIENCE).toBe("channel");
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
