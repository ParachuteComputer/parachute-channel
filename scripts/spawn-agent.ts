#!/usr/bin/env bun
/**
 * `spawn-agent` — the operator CLI for launching a sandboxed Claude Code agent
 * session, wired to one or more channels (and optionally a vault). This is the
 * "graduate `scripts/launch-session.sh` into a real command" step (design §4,
 * PLAN.md "Session lifecycle/supervision"): launch-session.sh hand-rolled the
 * token mint + .mcp.json + tmux launch in bash with NO sandbox; this thin CLI
 * parses args into an {@link AgentSpec} and calls {@link spawnAgent} with the
 * REAL deps — the real hub mint client, the real sandbox engine, the real tmux
 * launcher, and the real per-channel Claude-credential resolver.
 *
 * It does NOT re-implement scoping or sandboxing — every least-privilege decision
 * lives in `spawnAgent`/`sandbox/*`. The CLI's only jobs are: parse flags → build
 * the spec → resolve the real deps → call `spawnAgent` → print the result (or a
 * clean, actionable error).
 *
 * Usage:
 *   bun scripts/spawn-agent.ts <name> [flags]
 *
 * Flags (mirroring launch-session.sh's ergonomics, generalized to the spec):
 *   --channel <name>[:read|write]   repeatable; default write. First = wake channel.
 *   --vault <name>:<read|write>[:tag1,tag2]   optional vault MCP scope (+ tag-scope).
 *   --egress <host,host,...>        optional additive egress allowlist.
 *   --mount <hostPath:mountPath:ro|rw[:sharedName]>   repeatable; optional.
 *   --help                          usage.
 *
 * Environment:
 *   PARACHUTE_HOME              base for operator.token (default ~/.parachute).
 *   PARACHUTE_HUB_ORIGIN       hub public origin (else expose-state self-heal → loopback).
 *   PARACHUTE_CHANNEL_URL      daemon base URL (default http://127.0.0.1:<port>).
 *   PARACHUTE_CHANNEL_PORT     daemon port for the default channel URL (default 1941).
 *   PARACHUTE_CHANNEL_STATE_DIR  state dir (sessions, credentials.json) — default ~/.parachute/channel.
 *   PARACHUTE_VAULT_URL        vault base URL when a --vault is bound (default http://127.0.0.1:1940).
 *   CLAUDE_CONFIG_DIR          claude config dir bound read-only into the sandbox (default ~/.claude).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
  spawnAgent,
  realTmuxLauncher,
  type SpawnAgentDeps,
} from "../src/spawn-agent.ts";
import { CredentialNotConfiguredError, resolveClaudeCredential } from "../src/credentials.ts";
import { defaultStateDir } from "../src/registry.ts";
import { getHubOrigin } from "../src/hub-jwt.ts";
import { channelEntryKey, vaultEntryKey } from "../src/agent-mcp-config.ts";
import { MintError } from "../src/mint-token.ts";
import type {
  AgentSpec,
  AgentChannelSpec,
  AgentVaultSpec,
  AgentMount,
} from "../src/sandbox/types.ts";

const DEFAULT_CHANNEL_PORT = 1941;
const DEFAULT_VAULT_URL = "http://127.0.0.1:1940";

const USAGE = `spawn-agent — launch a sandboxed Claude Code agent session

Usage:
  bun scripts/spawn-agent.ts <name> [flags]

Arguments:
  <name>                          agent/session slug (alphanumeric, dash, underscore).

Flags:
  --channel <name>[:read|write]   channel to scope to (repeatable; default write).
                                  The FIRST channel is the wake channel.
  --vault <name>:<read|write>[:tag1,tag2]
                                  optional vault MCP scope (+ optional tag-scope).
  --egress <host,host,...>        optional additive egress allowlist (beyond the base).
  --mount <hostPath:mountPath:ro|rw[:shared]>
                                  filesystem mount (repeatable; optional).
  --help                          show this help.

Example:
  bun scripts/spawn-agent.ts aaron --channel aaron --vault default:read:#channel-message
`;

/** Parsed CLI request: the spec plus the `--help` short-circuit flag. */
export interface ParsedArgs {
  /** True when --help/-h was passed — print usage and exit 0, build no spec. */
  help: boolean;
  /** The agent spec assembled from the flags (undefined when help). */
  spec?: AgentSpec;
}

/** A user-facing argument error — the CLI prints `.message` and exits non-zero. */
export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

/**
 * Parse one channel token `name[:read|write]` into an {@link AgentChannelSpec}.
 * A bare name defaults to `write` (mirrors the spec's back-compat: a resident
 * session reads + replies). `:read` scopes a watcher channel read-only.
 */
function parseChannel(value: string): AgentChannelSpec {
  const [name, access, extra] = value.split(":");
  if (!name) throw new ArgError(`--channel: empty channel name in "${value}"`);
  if (extra !== undefined) {
    throw new ArgError(`--channel "${value}": expected <name>[:read|write], got extra ":"`);
  }
  if (access !== undefined && access !== "read" && access !== "write") {
    throw new ArgError(`--channel "${value}": access must be "read" or "write", got "${access}"`);
  }
  return access === undefined ? { name } : { name, access };
}

/**
 * Parse `--vault <name>:<read|write>[:tag1,tag2]` into an {@link AgentVaultSpec}.
 * (The spec also supports `admin`, but the CLI surface mirrors launch's
 * read/write ergonomics; admin is an explicit, rare grant left to the API path.)
 */
function parseVault(value: string): AgentVaultSpec {
  const parts = value.split(":");
  const name = parts[0];
  const access = parts[1];
  const tagPart = parts[2];
  if (parts.length < 2 || parts.length > 3) {
    throw new ArgError(`--vault "${value}": expected <name>:<read|write>[:tag1,tag2]`);
  }
  if (!name) throw new ArgError(`--vault "${value}": empty vault name`);
  if (access !== "read" && access !== "write") {
    throw new ArgError(`--vault "${value}": access must be "read" or "write", got "${access}"`);
  }
  const spec: AgentVaultSpec = { name, access };
  if (tagPart !== undefined) {
    const tags = tagPart.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
    if (tags.length === 0) {
      throw new ArgError(`--vault "${value}": tag list after the access is empty`);
    }
    spec.tags = tags;
  }
  return spec;
}

/**
 * Parse `--mount <hostPath:mountPath:ro|rw[:shared]>` into an {@link AgentMount}.
 * hostPath/mountPath are absolute paths; the mode is `ro`|`rw`; an optional 4th
 * segment names a cross-session share.
 */
function parseMount(value: string): AgentMount {
  const parts = value.split(":");
  if (parts.length < 3 || parts.length > 4) {
    throw new ArgError(`--mount "${value}": expected <hostPath:mountPath:ro|rw[:shared]>`);
  }
  const [hostPath, mountPath, mode, shared] = parts;
  if (!hostPath || !mountPath) {
    throw new ArgError(`--mount "${value}": hostPath and mountPath are required`);
  }
  if (mode !== "ro" && mode !== "rw") {
    throw new ArgError(`--mount "${value}": mode must be "ro" or "rw", got "${mode}"`);
  }
  const mount: AgentMount = { hostPath, mountPath, mode };
  if (shared !== undefined) {
    if (shared.length === 0) throw new ArgError(`--mount "${value}": empty shared name`);
    mount.shared = shared;
  }
  return mount;
}

/** Read the value that must follow a flag, or throw a clean ArgError. */
function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    throw new ArgError(`${flag}: expected a value`);
  }
  return v;
}

/**
 * Parse argv (everything AFTER `bun scripts/spawn-agent.ts`) into a spec. Pure +
 * exported so the unit test exercises it without any fs/tmux/mint side effect.
 * Throws {@link ArgError} on any malformed input.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let name: string | undefined;
  const channels: AgentChannelSpec[] = [];
  let vault: AgentVaultSpec | undefined;
  const egress: string[] = [];
  const mounts: AgentMount[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help":
      case "-h":
        return { help: true };
      case "--channel": {
        channels.push(parseChannel(takeValue(argv, i, "--channel")));
        i++;
        break;
      }
      case "--vault": {
        if (vault) throw new ArgError("--vault may only be given once");
        vault = parseVault(takeValue(argv, i, "--vault"));
        i++;
        break;
      }
      case "--egress": {
        const raw = takeValue(argv, i, "--egress");
        for (const h of raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
          egress.push(h);
        }
        i++;
        break;
      }
      case "--mount": {
        mounts.push(parseMount(takeValue(argv, i, "--mount")));
        i++;
        break;
      }
      default: {
        if (arg.startsWith("-")) throw new ArgError(`unknown flag "${arg}" (try --help)`);
        if (name !== undefined) {
          throw new ArgError(`unexpected positional "${arg}" — only one <name> is accepted`);
        }
        name = arg;
      }
    }
  }

  if (name === undefined) throw new ArgError("missing required <name> (try --help)");
  if (channels.length === 0) {
    throw new ArgError("at least one --channel is required (the first is the wake channel)");
  }

  const spec: AgentSpec = { name, channels };
  if (vault) spec.vault = vault;
  if (egress.length > 0) spec.egress = egress;
  if (mounts.length > 0) spec.mounts = mounts;
  return { help: false, spec };
}

// ---------------------------------------------------------------------------
// Real-dep resolution (only reached on the actual run, not in unit tests).
// ---------------------------------------------------------------------------

/** Base for `operator.token` — `$PARACHUTE_HOME` else `~/.parachute`. */
function parachuteHome(): string {
  return process.env.PARACHUTE_HOME ?? resolve(homedir(), ".parachute");
}

/**
 * The spawn-manager's OWN bearer — `~/.parachute/operator.token`, the local
 * operator credential the hub attenuates child mints against (same file vault's
 * `readOperatorToken` reads). Mirrors launch-session.sh leaning on the operator's
 * logged-in `parachute auth mint-token`; here we present the operator bearer to
 * the hub directly so the mint runs in-process with no shell-out.
 */
function readManagerBearer(): string | null {
  try {
    const path = resolve(parachuteHome(), "operator.token");
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Default channel daemon base URL: PARACHUTE_CHANNEL_URL, else loopback:<port>. */
function resolveChannelUrl(): string {
  const explicit = process.env.PARACHUTE_CHANNEL_URL?.replace(/\/$/, "");
  if (explicit) return explicit;
  const port = parseInt(process.env.PARACHUTE_CHANNEL_PORT ?? "", 10) || DEFAULT_CHANNEL_PORT;
  return `http://127.0.0.1:${port}`;
}

/** Claude config dir bound read-only so the sandboxed session can read its config. */
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude");
}

/** Build the real SpawnAgentDeps from the environment. */
function realDeps(): SpawnAgentDeps {
  const managerBearer = readManagerBearer();
  if (!managerBearer) {
    throw new ArgError(
      `no operator token at ${resolve(parachuteHome(), "operator.token")} — the manager bearer the\n` +
        `hub attenuates child mints against. Log in / provision the hub so the operator token exists\n` +
        `(it's what \`parachute auth mint-token\` uses), then re-run.`,
    );
  }

  const stateDir = defaultStateDir();
  const sessionsDir = join(stateDir, "sessions");
  const vaultUrl = process.env.PARACHUTE_VAULT_URL?.replace(/\/$/, "") || DEFAULT_VAULT_URL;

  return {
    hubOrigin: getHubOrigin(),
    managerBearer,
    channelUrl: resolveChannelUrl(),
    vaultUrl,
    sessionsDir,
    // The claude config dir is the one runtime path the sandboxed `claude` must
    // read (system paths /usr,/lib stay readable; the home tree is denied). The
    // per-session workspace (rw) is added by spawnAgent under sessionsDir.
    runtimeReadOnly: [claudeConfigDir()],
    // The real per-channel Claude OAuth resolver (channel override ?? default ?? throw).
    resolveClaudeToken: (channel: string) => resolveClaudeCredential(channel, stateDir),
    // The real tmux launcher (writes the per-session launch script, runs tmux).
    tmux: realTmuxLauncher(),
    // sandboxEngine omitted → spawnAgent's `new Sandbox()` uses the real, pinned,
    // library-linked engine.
  };
}

/** Format a per-aud scope summary line for each minted token. */
function scopeLines(result: Awaited<ReturnType<typeof spawnAgent>>): string[] {
  const lines: string[] = [];
  for (const [resource, minted] of Object.entries(result.tokens)) {
    lines.push(`    ${resource.padEnd(20)} ${minted.scope}`);
  }
  return lines;
}

async function main(): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArgError) {
      process.stderr.write(`error: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    throw err;
  }

  if (parsed.help || !parsed.spec) {
    process.stdout.write(USAGE);
    return 0;
  }
  const spec = parsed.spec;

  let deps: SpawnAgentDeps;
  try {
    deps = realDeps();
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const wakeChannel =
    typeof spec.channels[0] === "string" ? spec.channels[0] : spec.channels[0]!.name;

  let result: Awaited<ReturnType<typeof spawnAgent>>;
  try {
    result = await spawnAgent(spec, deps);
  } catch (err) {
    // A missing Claude credential is the most common operator error — surface the
    // exact creds-API curl to set it, and exit non-zero (no session launched).
    if (err instanceof CredentialNotConfiguredError) {
      process.stderr.write(
        `error: ${err.message}\n\n` +
          `Set the operator Claude credential (get a token with \`claude setup-token\`), then re-run:\n` +
          `  curl -X POST ${deps.channelUrl}/api/credentials/claude \\\n` +
          `    -H 'authorization: Bearer <channel:admin JWT>' \\\n` +
          `    -H 'content-type: application/json' \\\n` +
          `    -d '{"token":"<oat_… from claude setup-token>"}'\n\n` +
          `Or scope it to just the wake channel "${wakeChannel}":\n` +
          `  curl -X POST ${deps.channelUrl}/api/credentials/claude/${encodeURIComponent(wakeChannel)} \\\n` +
          `    -H 'authorization: Bearer <channel:admin JWT>' \\\n` +
          `    -H 'content-type: application/json' \\\n` +
          `    -d '{"token":"<oat_…>"}'\n`,
      );
      return 1;
    }
    // A bad slug name (spawnAgent's guard) or a refused/over-broad mint — surface
    // the message cleanly; no session was created in either case.
    if (err instanceof MintError) {
      process.stderr.write(`error: token mint failed — ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (result.alreadyRunning) {
    process.stdout.write(
      `session "${result.session}" is already running (no-op).\n` +
        `  attach:   tmux attach -t ${result.session}\n` +
        `  terminal: ${deps.channelUrl.replace(/\/$/, "")}/terminal?session=${encodeURIComponent(result.session)}\n`,
    );
    return 0;
  }

  // Success — print the session, the resolved scopes (per aud), and how to watch it.
  const out: string[] = [];
  out.push(`launched session "${result.session}" on channel "${wakeChannel}".`);
  out.push(`  workspace: ${result.workspace}`);
  out.push(`  scopes (one token per aud):`);
  out.push(...scopeLines(result));
  out.push(`  MCP servers: ${Object.keys(JSON.parse(result.mcpConfigJson).mcpServers).join(", ")}`);
  out.push("");
  out.push(`  watch (tmux):   tmux attach -t ${result.session}   (detach: Ctrl-b then d)`);
  out.push(
    `  watch (web):    ${deps.channelUrl.replace(/\/$/, "")}/terminal?session=${encodeURIComponent(result.session)}`,
  );
  out.push(`  chat:           open the channel UI and pick channel "${wakeChannel}"`);
  // Note the entry keys so the operator can map scopes → MCP entries at a glance.
  const entryHints = [
    ...spec.channels.map((c) => channelEntryKey(typeof c === "string" ? c : c.name)),
    ...(spec.vault ? [vaultEntryKey(spec.vault.name)] : []),
  ];
  out.push(`  mcp entries:    ${entryHints.join(", ")}`);
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    });
}
