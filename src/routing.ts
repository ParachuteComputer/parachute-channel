/**
 * SSE client registry + channel routing.
 *
 * Each connected bridge subscribes to exactly one named channel. An event
 * emitted on channel X must reach ONLY the clients subscribed to X. This module
 * factors that filtering into a pure, importable class so routing can be
 * asserted without a live socket (see routing.test.ts).
 *
 * The class is transport-agnostic: it knows nothing about Telegram. It just
 * holds (clientId → {channel, enqueue}) and fans an event out to the matching
 * subset.
 */

/** What the registry needs from a client: which channel it watches + how to push. */
export interface ClientSink {
  channel: string;
  /** Push a pre-serialized SSE payload string to this client. */
  enqueue(payload: string): void;
}

/** Serialize an SSE event frame. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class ClientRegistry {
  private clients = new Map<string, ClientSink>();

  add(id: string, sink: ClientSink): void {
    this.clients.set(id, sink);
  }

  remove(id: string): void {
    this.clients.delete(id);
  }

  has(id: string): boolean {
    return this.clients.has(id);
  }

  get size(): number {
    return this.clients.size;
  }

  /** Count of clients subscribed to a given channel. */
  countForChannel(channel: string): number {
    let n = 0;
    for (const c of this.clients.values()) if (c.channel === channel) n++;
    return n;
  }

  /** All distinct channel names with at least one subscriber. */
  subscribedChannels(): string[] {
    return [...new Set([...this.clients.values()].map((c) => c.channel))];
  }

  /**
   * Route an event to every client subscribed to `channel`, and to no one else.
   * Returns the number of clients the event was delivered to. Clients whose
   * enqueue throws (closed stream) are dropped.
   */
  routeToChannel(channel: string, event: string, data: unknown): number {
    const payload = sseFrame(event, data);
    let delivered = 0;
    for (const [id, client] of this.clients) {
      if (client.channel !== channel) continue;
      try {
        client.enqueue(payload);
        delivered++;
      } catch {
        this.clients.delete(id);
      }
    }
    return delivered;
  }
}
