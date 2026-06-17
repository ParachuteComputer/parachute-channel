/**
 * Build the multi-entry inline `--mcp-config` JSON for a sandboxed agent session
 * (design §4.2 step 2).
 *
 * This generalizes runner's single-entry `buildMcpConfigJson`
 * (`parachute-runner/src/mcp-config.ts`) into one `mcpServers` object carrying
 * EVERY channel's `/mcp/<channel>` entry plus the optional vault's
 * `/vault/<name>/mcp` entry plus any `otherMcps` — each with its OWN Bearer
 * (one token per `aud`; the manager mints them, §4.2 step 1).
 *
 * The session launches with `--strict-mcp-config`, so it sees exactly these
 * servers and nothing else — the MCP surface is closed to the spec.
 *
 * Each entry is the HTTP-MCP shape both channel (`src/mcp-http.ts`) and vault
 * (its `/vault/<name>/mcp`) serve:
 *   { "type": "http", "url": "<url>", "headers": { "Authorization": "Bearer <tok>" } }
 *
 * Treat the output as secret — it inlines bearer tokens.
 */

export interface ChannelMcpEntry {
  /** Channel name (the `/mcp/<channel>` segment + entry-key suffix). */
  channel: string;
  /** Per-channel hub-issued token (aud: agent; agent:read[+write]). */
  token: string;
}

export interface VaultMcpEntry {
  /** Vault instance name. */
  name: string;
  /** Per-vault hub-issued token (aud: vault; vault:<name>:<verb>). */
  token: string;
}

export interface OtherMcpEntry {
  /** Entry key in mcpServers. */
  name: string;
  /** MCP URL. */
  url: string;
  /** Optional token; omitted = no Authorization header. */
  token?: string;
}

export interface BuildAgentMcpConfigInput {
  /** Daemon base URL the channel `/mcp/<channel>` endpoints live under. */
  channelUrl: string;
  /** Channels to attach (one entry each). */
  channels: ChannelMcpEntry[];
  /** Optional vault binding. */
  vault?: { url: string; entry: VaultMcpEntry };
  /** Additional MCP servers. */
  otherMcps?: OtherMcpEntry[];
}

interface McpHttpServer {
  type: "http";
  url: string;
  headers?: { Authorization: string };
}

/** Build the channel entry key — matches launch-session.sh's `agent-<name>` and
 *  the HTTP-MCP per-channel server name in `mcp-http.ts` (`agent-${channel}`). */
export function channelEntryKey(channel: string): string {
  return `agent-${channel}`;
}

/** Build the vault entry key — matches runner's `parachute-vault-<name>`. */
export function vaultEntryKey(name: string): string {
  return `parachute-vault-${name}`;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

function httpServer(url: string, token?: string): McpHttpServer {
  const server: McpHttpServer = { type: "http", url };
  if (token) server.headers = { Authorization: `Bearer ${token}` };
  return server;
}

/**
 * Build the multi-entry `mcpServers` object (not yet JSON-stringified). Exposed
 * for assertions that inspect the structure directly.
 */
export function buildAgentMcpServers(
  input: BuildAgentMcpConfigInput,
): Record<string, McpHttpServer> {
  const servers: Record<string, McpHttpServer> = {};
  const base = stripTrailingSlash(input.channelUrl);

  for (const ch of input.channels) {
    servers[channelEntryKey(ch.channel)] = httpServer(`${base}/mcp/${ch.channel}`, ch.token);
  }

  if (input.vault) {
    const vbase = stripTrailingSlash(input.vault.url);
    const v = input.vault.entry;
    servers[vaultEntryKey(v.name)] = httpServer(`${vbase}/vault/${v.name}/mcp`, v.token);
  }

  for (const o of input.otherMcps ?? []) {
    servers[o.name] = httpServer(o.url, o.token);
  }

  return servers;
}

/**
 * Build the inline `--mcp-config` JSON. Two-space indent, matching runner's +
 * vault's emission convention so cross-repo diffs stay clean.
 */
export function buildAgentMcpConfigJson(input: BuildAgentMcpConfigInput): string {
  return JSON.stringify({ mcpServers: buildAgentMcpServers(input) }, null, 2);
}
