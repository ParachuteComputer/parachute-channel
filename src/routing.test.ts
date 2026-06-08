import { describe, test, expect } from "bun:test";
import { ClientRegistry, sseFrame, type ClientSink } from "./routing.ts";

/** A fake sink that records every payload pushed to it. */
function fakeClient(channel: string): ClientSink & { received: string[] } {
  const received: string[] = [];
  return {
    channel,
    received,
    enqueue(payload: string) {
      received.push(payload);
    },
  };
}

describe("sseFrame", () => {
  test("serializes an event + JSON data block", () => {
    expect(sseFrame("message", { a: 1 })).toBe('event: message\ndata: {"a":1}\n\n');
  });
});

describe("ClientRegistry routing", () => {
  test("delivers to subscribers of the channel and NOT others", () => {
    const reg = new ClientRegistry();
    const a1 = fakeClient("A");
    const a2 = fakeClient("A");
    const b1 = fakeClient("B");
    reg.add("a1", a1);
    reg.add("a2", a2);
    reg.add("b1", b1);

    const delivered = reg.routeToChannel("A", "message", { content: "hi" });

    expect(delivered).toBe(2);
    expect(a1.received).toHaveLength(1);
    expect(a2.received).toHaveLength(1);
    expect(b1.received).toHaveLength(0); // the core property: B never sees A's message
    expect(a1.received[0]).toContain('"content":"hi"');
  });

  test("emitting on B does not reach A", () => {
    const reg = new ClientRegistry();
    const a1 = fakeClient("A");
    const b1 = fakeClient("B");
    reg.add("a1", a1);
    reg.add("b1", b1);

    reg.routeToChannel("B", "message", { content: "for-b" });

    expect(b1.received).toHaveLength(1);
    expect(a1.received).toHaveLength(0);
  });

  test("routing to an unsubscribed channel delivers to nobody", () => {
    const reg = new ClientRegistry();
    reg.add("a1", fakeClient("A"));
    expect(reg.routeToChannel("ghost", "message", {})).toBe(0);
  });

  test("countForChannel + subscribedChannels reflect subscriptions", () => {
    const reg = new ClientRegistry();
    reg.add("a1", fakeClient("A"));
    reg.add("a2", fakeClient("A"));
    reg.add("b1", fakeClient("B"));
    expect(reg.size).toBe(3);
    expect(reg.countForChannel("A")).toBe(2);
    expect(reg.countForChannel("B")).toBe(1);
    expect(reg.countForChannel("C")).toBe(0);
    expect(reg.subscribedChannels().sort()).toEqual(["A", "B"]);
  });

  test("a throwing client is dropped and does not block delivery to others", () => {
    const reg = new ClientRegistry();
    const good = fakeClient("A");
    const bad: ClientSink = {
      channel: "A",
      enqueue() {
        throw new Error("stream closed");
      },
    };
    reg.add("good", good);
    reg.add("bad", bad);

    const delivered = reg.routeToChannel("A", "message", { content: "x" });

    expect(delivered).toBe(1); // only the good client counted
    expect(good.received).toHaveLength(1);
    expect(reg.has("bad")).toBe(false); // bad client evicted
    expect(reg.has("good")).toBe(true);
  });

  test("remove unsubscribes a client", () => {
    const reg = new ClientRegistry();
    const a1 = fakeClient("A");
    reg.add("a1", a1);
    reg.remove("a1");
    reg.routeToChannel("A", "message", {});
    expect(a1.received).toHaveLength(0);
    expect(reg.size).toBe(0);
  });
});

describe("ClientRegistry live SSE integration", () => {
  test("two SSE clients on different channels each get only their channel", async () => {
    const reg = new ClientRegistry();

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/events") {
          const channel = url.searchParams.get("channel") ?? "default";
          const id = crypto.randomUUID();
          const stream = new ReadableStream<string>({
            start(controller) {
              reg.add(id, { channel, enqueue: (p) => controller.enqueue(p) });
              controller.enqueue(": connected\n\n");
            },
            cancel() {
              reg.remove(id);
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const base = `http://127.0.0.1:${server.port}`;

    async function openAndRead(channel: string): Promise<{
      read: () => Promise<string>;
      cancel: () => void;
    }> {
      const res = await fetch(`${base}/events?channel=${channel}`);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      return {
        async read() {
          // Read until we get a non-comment data frame.
          while (true) {
            const { value, done } = await reader.read();
            if (done) return "";
            const chunk = decoder.decode(value, { stream: true });
            if (chunk.includes("event:")) return chunk;
          }
        },
        cancel() {
          reader.cancel().catch(() => {});
        },
      };
    }

    const a = await openAndRead("A");
    const b = await openAndRead("B");

    // Wait until both clients have registered.
    const start = Date.now();
    while (reg.size < 2 && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(reg.size).toBe(2);

    // Emit only on A.
    reg.routeToChannel("A", "message", { content: "only-A" });

    const aFrame = await a.read();
    expect(aFrame).toContain("only-A");

    // B should receive nothing on channel A; emit on B to prove B's stream is live.
    reg.routeToChannel("B", "message", { content: "only-B" });
    const bFrame = await b.read();
    expect(bFrame).toContain("only-B");
    expect(bFrame).not.toContain("only-A");

    a.cancel();
    b.cancel();
    server.stop(true);
  });
});
