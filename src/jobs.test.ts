import { describe, test, expect, afterEach } from "bun:test";
import { validateJob, VaultJobStore, vaultTransportFor, type Job } from "./jobs.ts";
import { VaultTransport } from "./transports/vault.ts";
import type { Channel } from "./registry.ts";
import { TelegramTransport } from "./transports/telegram.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: "morning",
    channel: "uni-dev",
    message: "Run the morning weave",
    schedule: { cron: "53 7 * * *", tz: "America/Los_Angeles" },
    enabled: true,
    createdAt: "2026-06-17T00:00:00.000Z",
    ...over,
  };
}

describe("validateJob (pure)", () => {
  const isVault = (name: string): boolean | null => {
    if (name === "uni-dev") return true;
    if (name === "tele") return false;
    return null;
  };

  test("a well-formed vault job validates", () => {
    expect(validateJob(makeJob(), isVault)).toEqual({ ok: true });
  });
  test("bad id (not a slug) rejected", () => {
    const r = validateJob(makeJob({ id: "has spaces" }), isVault);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/slug/);
  });
  test("empty message rejected", () => {
    const r = validateJob(makeJob({ message: "   " }), isVault);
    expect((r as { error: string }).error).toMatch(/message/);
  });
  test("bad cron rejected with a field-naming message", () => {
    const r = validateJob(makeJob({ schedule: { cron: "99 7 * * *" } }), isVault);
    expect((r as { error: string }).error).toMatch(/invalid schedule.cron/);
  });
  test("missing schedule.cron rejected", () => {
    const r = validateJob({ id: "x", channel: "uni-dev", message: "m" }, isVault);
    expect((r as { error: string }).error).toMatch(/schedule.cron/);
  });
  test("bad tz rejected", () => {
    const r = validateJob(makeJob({ schedule: { cron: "0 0 * * *", tz: "Mars/Olympus" } }), isVault);
    expect((r as { error: string }).error).toMatch(/timezone/);
  });
  test("unknown channel rejected", () => {
    const r = validateJob(makeJob({ channel: "ghost" }), isVault);
    expect((r as { error: string }).error).toMatch(/unknown channel/);
  });
  test("non-vault channel rejected (the inject path needs a vault transport)", () => {
    const r = validateJob(makeJob({ channel: "tele" }), isVault);
    expect((r as { error: string }).error).toMatch(/not a vault channel/);
  });
});

/** Build a live channels map with one vault channel + (optionally) a telegram one. */
function channelsWithVault(): { channels: Map<string, Channel>; vault: VaultTransport } {
  const vault = new VaultTransport({
    vault: "default",
    vaultUrl: "http://127.0.0.1:1940",
    token: "write-token",
  });
  const channels = new Map<string, Channel>();
  channels.set("uni-dev", {
    name: "uni-dev",
    transport: vault,
    entry: { name: "uni-dev", transport: "vault", config: { vault: "default", token: "write-token" } },
  });
  const tele = new TelegramTransport({ token: "tg", name: "tele" });
  channels.set("tele", {
    name: "tele",
    transport: tele,
    entry: { name: "tele", transport: "telegram", config: { token: "tg" } },
  });
  return { channels, vault };
}

describe("vaultTransportFor", () => {
  test("resolves a vault channel to its transport; null for non-vault / unknown", () => {
    const { channels, vault } = channelsWithVault();
    expect(vaultTransportFor(channels, "uni-dev")).toBe(vault);
    expect(vaultTransportFor(channels, "tele")).toBeNull();
    expect(vaultTransportFor(channels, "ghost")).toBeNull();
  });
});

describe("VaultJobStore — vault-native CRUD", () => {
  test("listAll queries each unique vault once + maps job notes to Jobs", async () => {
    const { channels } = channelsWithVault();
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify([
          {
            id: "note-1",
            content: "Run the weave",
            metadata: {
              channel: "uni-dev",
              cron: "53 7 * * *",
              tz: "America/Los_Angeles",
              enabled: "true",
              createdAt: "2026-06-17T00:00:00Z",
            },
          },
          {
            id: "note-2",
            content: "Hourly ping",
            metadata: { channel: "uni-dev", cron: "0 * * * *", enabled: "false" },
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const store = new VaultJobStore(channels);
    const jobs = await store.listAll();
    // Only ONE vault transport in the map → queried exactly once (telegram is skipped).
    expect(urls.filter((u) => u.includes("/api/notes")).length).toBe(1);
    expect(urls[0]).toContain("tag=%23agent-job");
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      id: "note-1",
      channel: "uni-dev",
      message: "Run the weave",
      schedule: { cron: "53 7 * * *", tz: "America/Los_Angeles" },
      enabled: true,
    });
    expect(jobs[1]!.enabled).toBe(false); // "false" string → disabled
  });

  test("upsert writes a #agent-job note via the target channel's vault", async () => {
    const { channels } = channelsWithVault();
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "Channels/uni-dev/jobs/morning" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const store = new VaultJobStore(channels);
    const saved = await store.upsert(makeJob());
    // `id` stays the operator slug; `noteId` is the vault note id for addressing.
    expect(saved.id).toBe("morning");
    expect(saved.noteId).toBe("Channels/uni-dev/jobs/morning");
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.tags).toEqual(["#agent-job"]);
    expect(body.path).toBe("Channels/uni-dev/jobs/morning");
    expect(body.metadata.jobId).toBe("morning"); // slug persisted for stable display
    expect(body.content).toBe("Run the morning weave");
    expect(body.metadata).toMatchObject({
      channel: "uni-dev",
      cron: "53 7 * * *",
      tz: "America/Los_Angeles",
      enabled: "true",
      createdAt: "2026-06-17T00:00:00.000Z",
    });
    // nextRunAt is NEVER persisted.
    expect(body.metadata.nextRunAt).toBeUndefined();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer write-token");
  });

  test("upsert to a non-vault channel throws", async () => {
    const { channels } = channelsWithVault();
    const store = new VaultJobStore(channels);
    await expect(store.upsert(makeJob({ channel: "tele" }))).rejects.toThrow(/not a live vault channel/);
  });

  test("remove DELETEs the note by id via the channel's vault", async () => {
    const { channels } = channelsWithVault();
    const calls: { url: string; method?: string }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const store = new VaultJobStore(channels);
    await store.remove("Channels/uni-dev/jobs/morning", "uni-dev");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/api/notes/");
  });

  test("patch PATCHes bookkeeping metadata onto the note", async () => {
    const { channels } = channelsWithVault();
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const store = new VaultJobStore(channels);
    await store.patch("note-1", "uni-dev", { lastRunAt: "2026-06-17T11:00:00Z", lastStatus: "ok" });
    expect(calls[0]!.init.method).toBe("PATCH");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.metadata).toEqual({ lastRunAt: "2026-06-17T11:00:00Z", lastStatus: "ok" });
  });
});
