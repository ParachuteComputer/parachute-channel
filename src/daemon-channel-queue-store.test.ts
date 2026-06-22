/**
 * `channelQueueStoreFor` — the PRODUCTION adapter that wires a live `VaultTransport`
 * into the `ChannelQueueStore` the pull-queue worker uses.
 *
 * Regression for the agent#101 CAS single-claim guard (PR #116): the adapter MUST
 * forward the 4th `ifUpdatedAt` arg to `vt.setInboundStatus`, or the compare-and-set
 * silently collapses to `force:true` (last-write-wins) and the double-claim race the
 * CAS was built to close re-opens. The unit tests inject a FAKE store that honors all
 * four args, so ONLY the live daemon adapter was lossy (a 3-param arrow is assignable
 * to the wider interface slot, so the type checker can't catch it). This exercises the
 * REAL adapter end-to-end against a `VaultTransport`.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { channelQueueStoreFor } from "./daemon.ts";
import { VaultTransport } from "./transports/vault.ts";
import type { Channel } from "./registry.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function vaultChannels(): Map<string, Channel> {
  const vault = new VaultTransport({ vault: "default", vaultUrl: "http://127.0.0.1:1940", token: "write-token" });
  const channels = new Map<string, Channel>();
  channels.set("eng", {
    name: "eng",
    transport: vault,
    entry: { name: "eng", transport: "vault", config: { vault: "default", token: "write-token" } },
  });
  return channels;
}

/** Capture the PATCH bodies the vault transport sends. */
function recordPatch(): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "PATCH") bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { bodies };
}

describe("channelQueueStoreFor — CAS arg forwarding (agent#101 regression)", () => {
  test("setInboundStatus FORWARDS ifUpdatedAt → the vault does a CAS (if_updated_at), not force", async () => {
    const store = channelQueueStoreFor(vaultChannels(), "eng");
    expect(store).not.toBeNull();
    const { bodies } = recordPatch();
    await store!.setInboundStatus("note-1", "in-flight", "2026-06-22T00:00:00.000Z", "2026-06-22T00:00:00.000Z");
    expect(bodies).toHaveLength(1);
    // The CAS precondition is forwarded (the whole point of the single-claim guard) …
    expect(bodies[0]!.if_updated_at).toBe("2026-06-22T00:00:00.000Z");
    // … and it is NOT the force/last-write-wins path the dropped-arg bug fell back to.
    expect(bodies[0]!.force).toBeUndefined();
  });

  test("setInboundStatus WITHOUT ifUpdatedAt → force:true (release/handled/sweep path, unchanged)", async () => {
    const store = channelQueueStoreFor(vaultChannels(), "eng");
    const { bodies } = recordPatch();
    await store!.setInboundStatus("note-1", "pending", null);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.force).toBe(true);
    expect(bodies[0]!.if_updated_at).toBeUndefined();
  });
});
