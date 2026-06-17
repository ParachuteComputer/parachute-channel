import { describe, test, expect } from "bun:test";
import {
  buildAgentMcpServers,
  buildAgentMcpConfigJson,
  channelEntryKey,
  vaultEntryKey,
} from "./agent-mcp-config.ts";

describe("channelEntryKey — the per-channel MCP server name (channel→agent rename)", () => {
  test("is `agent-<name>` (matches mcp-http.ts buildServer + launch-session.sh)", () => {
    // The entry-key + per-channel HTTP-MCP server name moved channel-<name> →
    // agent-<name> with the module identity. The channel NAME slug (the domain)
    // is preserved; only the `agent-` prefix is the renamed wire surface.
    expect(channelEntryKey("eng")).toBe("agent-eng");
    expect(channelEntryKey("aaron-dev")).toBe("agent-aaron-dev");
  });

  test(".mcp.json mcpServers is keyed by `agent-<name>`", () => {
    const parsed = JSON.parse(
      buildAgentMcpConfigJson({
        channelUrl: "http://127.0.0.1:1941",
        channels: [{ channel: "eng", token: "T" }],
      }),
    ) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers)).toEqual(["agent-eng"]);
    expect(parsed.mcpServers["agent-eng"]).toBeDefined();
  });
});

describe("buildAgentMcpServers — N-entry strict config", () => {
  test("one entry per channel with its own URL + Bearer", () => {
    const servers = buildAgentMcpServers({
      channelUrl: "http://127.0.0.1:1941",
      channels: [
        { channel: "aaron-dev", token: "TOK-A" },
        { channel: "ops", token: "TOK-B" },
      ],
    });
    expect(servers[channelEntryKey("aaron-dev")]).toEqual({
      type: "http",
      url: "http://127.0.0.1:1941/mcp/aaron-dev",
      headers: { Authorization: "Bearer TOK-A" },
    });
    expect(servers[channelEntryKey("ops")]).toEqual({
      type: "http",
      url: "http://127.0.0.1:1941/mcp/ops",
      headers: { Authorization: "Bearer TOK-B" },
    });
    expect(Object.keys(servers)).toHaveLength(2);
  });

  test("adds a vault entry with its OWN token (one token per aud)", () => {
    const servers = buildAgentMcpServers({
      channelUrl: "http://127.0.0.1:1941",
      channels: [{ channel: "ch", token: "CH-TOK" }],
      vault: { url: "http://127.0.0.1:1940", entry: { name: "default", token: "VAULT-TOK" } },
    });
    expect(servers[vaultEntryKey("default")]).toEqual({
      type: "http",
      url: "http://127.0.0.1:1940/vault/default/mcp",
      headers: { Authorization: "Bearer VAULT-TOK" },
    });
    // The channel token and the vault token are DIFFERENT (separate auds).
    expect(servers[channelEntryKey("ch")]!.headers!.Authorization).toBe("Bearer CH-TOK");
    expect(servers[vaultEntryKey("default")]!.headers!.Authorization).toBe("Bearer VAULT-TOK");
  });

  test("adds otherMcps; an entry without a token gets no Authorization header", () => {
    const servers = buildAgentMcpServers({
      channelUrl: "http://127.0.0.1:1941",
      channels: [{ channel: "ch", token: "T" }],
      otherMcps: [
        { name: "extra", url: "https://mcp.example.com/mcp", token: "X" },
        { name: "open", url: "https://open.example.com/mcp" },
      ],
    });
    expect(servers.extra!.headers).toEqual({ Authorization: "Bearer X" });
    expect(servers.open!.headers).toBeUndefined();
  });

  test("strips a trailing slash on the base URL", () => {
    const servers = buildAgentMcpServers({
      channelUrl: "http://127.0.0.1:1941/",
      channels: [{ channel: "ch", token: "T" }],
    });
    expect(servers[channelEntryKey("ch")]!.url).toBe("http://127.0.0.1:1941/mcp/ch");
  });
});

describe("buildAgentMcpConfigJson", () => {
  test("emits two-space-indented JSON with the mcpServers wrapper", () => {
    const json = buildAgentMcpConfigJson({
      channelUrl: "http://127.0.0.1:1941",
      channels: [{ channel: "ch", token: "T" }],
    });
    const parsed = JSON.parse(json);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers[channelEntryKey("ch")].type).toBe("http");
    // Two-space indent (matches runner/vault emission convention).
    expect(json).toContain('\n  "mcpServers"');
  });

  test("round-trips: parse(emit(x)) carries every entry's token", () => {
    const input = {
      channelUrl: "http://127.0.0.1:1941",
      channels: [{ channel: "a", token: "TA" }],
      vault: { url: "http://127.0.0.1:1940", entry: { name: "default", token: "TV" } },
    };
    const parsed = JSON.parse(buildAgentMcpConfigJson(input)) as {
      mcpServers: Record<string, { headers?: { Authorization: string } }>;
    };
    expect(parsed.mcpServers[channelEntryKey("a")]!.headers!.Authorization).toBe("Bearer TA");
    expect(parsed.mcpServers[vaultEntryKey("default")]!.headers!.Authorization).toBe("Bearer TV");
  });
});
