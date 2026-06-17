/**
 * ProgrammaticBackend tests — the single `claude -p` turn runner.
 *
 * Inject a FAKE spawnFn that emits canned stream-json (never spawn real claude),
 * a fake sandbox engine (records the wrapped argv), and a fake mint hub. Covered:
 *
 *  - FIRST turn (no stored sid): argv has NO `--resume`; session_id captured +
 *    PERSISTED to the state store; reply extracted from the `result` event.
 *  - SECOND turn (sid stored): argv includes `--resume <sid>`; reply extracted; sid stable.
 *  - ERROR turn (is_error / non-success subtype): returns `{ ok:false, error }`, no throw.
 *  - argv shape: `-p`, `--output-format stream-json`, `--strict-mcp-config`,
 *    `--mcp-config`, `--dangerously-skip-permissions` present; NO
 *    `--dangerously-load-development-channels`.
 *  - env: `CLAUDE_CODE_OAUTH_TOKEN` injected; `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY`
 *    NOT present (the #68 denylist).
 *  - robustness: stream-json with interleaved hook/rate_limit_event lines + a
 *    trailing partial line still parses the result.
 *  - the vault-only `.mcp.json` (no channel MCP entry — the daemon mediates messaging).
 *  - a missing Claude credential / a refused mint return `{ ok:false }` (no throw).
 *  - stop() clears the resume id; status() is live.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ProgrammaticBackend,
  buildProgrammaticClaudeArgs,
  PROGRAMMATIC_BACKEND_KIND,
  type ProgrammaticBackendDeps,
  type ProgrammaticSpawnFn,
} from "./programmatic.ts";
import { AgentSessionState } from "../agent-session-state.ts";
import type { SandboxEngine } from "../sandbox/index.ts";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { AgentSpec } from "../sandbox/types.ts";
import { vaultEntryKey, channelEntryKey } from "../agent-mcp-config.ts";

let sessionsDir: string;
let stateDir: string;
afterEach(() => {
  if (sessionsDir) rmSync(sessionsDir, { recursive: true, force: true });
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

// ---- fakes -----------------------------------------------------------------

/** Join NDJSON event objects into the blob claude emits on stdout. */
function ndjson(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** A success stream-json turn with the given session id + reply. */
function successTurn(sessionId: string, reply: string): string {
  return ndjson(
    { type: "system", subtype: "init", session_id: sessionId, apiKeySource: "none", mcp_servers: [] },
    { type: "assistant", message: { content: [{ type: "text", text: reply }] }, session_id: sessionId },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: reply,
      session_id: sessionId,
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.001,
    },
  );
}

/**
 * A recording spawnFn that returns a configurable stdout/stderr/exit and records
 * the argv + env + cwd it was called with. Mirrors `Bun.spawn`'s stream shape via
 * `Response(...).body`.
 */
function recordingSpawn(opts: { stdout?: string; stderr?: string; code?: number } = {}): {
  fn: ProgrammaticSpawnFn;
  calls: Array<{ argv: string[]; env: Record<string, string | undefined>; cwd: string }>;
} {
  const calls: Array<{ argv: string[]; env: Record<string, string | undefined>; cwd: string }> = [];
  const fn: ProgrammaticSpawnFn = (argv, o) => {
    calls.push({ argv, env: o.env, cwd: o.cwd });
    return {
      stdout: new Response(opts.stdout ?? "").body,
      stderr: new Response(opts.stderr ?? "").body,
      exited: Promise.resolve(opts.code ?? 0),
    };
  };
  return { fn, calls };
}

/** A spawnFn that returns a DIFFERENT canned stdout per call (turn 1, turn 2, …). */
function sequencedSpawn(stdouts: string[]): {
  fn: ProgrammaticSpawnFn;
  calls: Array<{ argv: string[]; env: Record<string, string | undefined> }>;
} {
  const calls: Array<{ argv: string[]; env: Record<string, string | undefined> }> = [];
  let i = 0;
  const fn: ProgrammaticSpawnFn = (argv, o) => {
    calls.push({ argv, env: o.env });
    const out = stdouts[Math.min(i, stdouts.length - 1)] ?? "";
    i += 1;
    return { stdout: new Response(out).body, stderr: new Response("").body, exited: Promise.resolve(0) };
  };
  return { fn, calls };
}

/** A fake sandbox engine — records config, returns a deterministic wrap (echoes the command). */
function fakeEngine(): SandboxEngine & { initializedWith: SandboxRuntimeConfig | null } {
  const rec = {
    initializedWith: null as SandboxRuntimeConfig | null,
    isSupportedPlatform: () => true,
    isSandboxingEnabled: () => true,
    async initialize(cfg: SandboxRuntimeConfig) {
      rec.initializedWith = cfg;
    },
    async wrapWithSandboxArgv(command: string) {
      // Emulate the real shape: a bash -c wrapper carrying the command + proxy env.
      // The "argv" the runner spawns is therefore `["/bin/bash","-c","SBX <command>"]`;
      // assertions parse `argv[2]` for the claude flags.
      return {
        argv: ["/bin/bash", "-c", `SBX ${command}`],
        env: { SANDBOX_RUNTIME: "1", HTTPS_PROXY: "http://localhost:5555", TMPDIR: "/tmp/claude" },
      };
    },
    async reset() {},
  };
  return rec;
}

/** A fake mint hub: returns a distinct token per scope. */
function fakeMintFetch(): typeof fetch {
  let n = 0;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { scope: string };
    n += 1;
    return new Response(
      JSON.stringify({ jti: `j${n}`, token: `TOK-${n}`, expires_at: "2026-09-01T00:00:00Z", scope: body.scope }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function baseDeps(
  spawnFn: ProgrammaticSpawnFn,
  over: Partial<ProgrammaticBackendDeps> = {},
): ProgrammaticBackendDeps {
  return {
    hubOrigin: "https://hub.example.com",
    managerBearer: "MANAGER",
    vaultUrl: "http://127.0.0.1:1940",
    sessionsDir,
    runtimeReadOnly: ["/cfg/.claude"],
    sessionState: new AgentSessionState({ stateDir }),
    resolveClaudeToken: () => "OAUTH-CRED-PLACEHOLDER",
    sandboxEngine: fakeEngine(),
    fetchFn: fakeMintFetch(),
    spawnFn,
    parentEnv: {
      PATH: "/usr/bin",
      HOME: "/home/op",
      ANTHROPIC_API_KEY: "sk-ant-SHOULD-NOT-LEAK",
      CLAUDE_API_KEY: "also-should-not-leak",
      SECRET_THING: "do-not-pass",
    },
    claudeBin: "claude",
    ...over,
  };
}

function specWithVault(name = "eng"): AgentSpec {
  return {
    name,
    channels: [name],
    vault: { name: "default", access: "read", tags: ["#channel-message"] },
  };
}

function specWithSystemPrompt(
  prompt: string,
  mode: "append" | "replace" | undefined,
  name = "eng",
): AgentSpec {
  return {
    name,
    channels: [name],
    vault: { name: "default", access: "read", tags: ["#channel-message"] },
    systemPrompt: prompt,
    ...(mode ? { systemPromptMode: mode } : {}),
  };
}

function mkDirs(tag: string): void {
  sessionsDir = mkdtempSync(join(tmpdir(), `prog-sessions-${tag}-`));
  stateDir = mkdtempSync(join(tmpdir(), `prog-state-${tag}-`));
}

// ---- pure-helper tests -----------------------------------------------------

describe("buildProgrammaticClaudeArgs", () => {
  test("FIRST turn (no resume): -p + stream-json + strict MCP; NO --resume, NO dev-channels", () => {
    const argv = buildProgrammaticClaudeArgs({ message: "hello", mcpConfigPath: "/ws/.mcp.json" });
    expect(argv).toContain("-p");
    expect(argv).toContain("hello");
    expect(argv.join(" ")).toContain("--output-format stream-json");
    expect(argv).toContain("--verbose");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--mcp-config");
    expect(argv).toContain("/ws/.mcp.json");
    expect(argv).toContain("--dangerously-skip-permissions");
    // The daemon mediates messaging — NO channel dev-channels flag here.
    expect(argv.some((a) => a.includes("dangerously-load-development-channels"))).toBe(false);
    // First turn → no --resume.
    expect(argv).not.toContain("--resume");
  });

  test("SECOND turn (resume): --resume <sid> appended", () => {
    const argv = buildProgrammaticClaudeArgs({
      message: "next",
      mcpConfigPath: "/ws/.mcp.json",
      resumeSessionId: "sess-xyz",
    });
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-xyz");
  });

  test("system prompt (append, default): --append-system-prompt-file <path>", () => {
    const argv = buildProgrammaticClaudeArgs({
      message: "hi",
      mcpConfigPath: "/ws/.mcp.json",
      systemPromptFile: "/ws/system-prompt.txt",
      systemPromptMode: "append",
    });
    expect(argv).toContain("--append-system-prompt-file");
    expect(argv[argv.indexOf("--append-system-prompt-file") + 1]).toBe("/ws/system-prompt.txt");
    expect(argv).not.toContain("--system-prompt-file");
  });

  test("system prompt (replace): --system-prompt-file <path>", () => {
    const argv = buildProgrammaticClaudeArgs({
      message: "hi",
      mcpConfigPath: "/ws/.mcp.json",
      systemPromptFile: "/ws/system-prompt.txt",
      systemPromptMode: "replace",
    });
    expect(argv).toContain("--system-prompt-file");
    expect(argv[argv.indexOf("--system-prompt-file") + 1]).toBe("/ws/system-prompt.txt");
    expect(argv).not.toContain("--append-system-prompt-file");
  });

  test("system prompt with no mode → append (the -file flag defaults to append)", () => {
    const argv = buildProgrammaticClaudeArgs({
      message: "hi",
      mcpConfigPath: "/ws/.mcp.json",
      systemPromptFile: "/ws/system-prompt.txt",
    });
    expect(argv).toContain("--append-system-prompt-file");
  });

  test("no systemPromptFile → neither system-prompt flag", () => {
    const argv = buildProgrammaticClaudeArgs({ message: "hi", mcpConfigPath: "/ws/.mcp.json" });
    expect(argv).not.toContain("--append-system-prompt-file");
    expect(argv).not.toContain("--system-prompt-file");
  });
});

// ---- single-turn runner tests ----------------------------------------------

describe("ProgrammaticBackend.deliver — first turn (no stored sid)", () => {
  test("argv has NO --resume; session_id captured + persisted; reply from the result event", async () => {
    mkDirs("first");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("sess-FIRST", "the reply text") });
    const engine = fakeEngine();
    const state = new AgentSessionState({ stateDir });
    const backend = new ProgrammaticBackend(baseDeps(fn, { sandboxEngine: engine, sessionState: state }));

    const handle = await backend.start(specWithVault("eng"));
    const result = await backend.deliver(handle, "hi agent");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply).toBe("the reply text");
      expect(result.sessionId).toBe("sess-FIRST");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalCostUsd: 0.001 });
    }

    // The wrapped argv (engine echoes the claude command in argv[2]) has NO --resume.
    expect(calls).toHaveLength(1);
    const cmd = calls[0]!.argv[2]!;
    expect(cmd).toContain("SBX claude -p");
    expect(cmd).not.toContain("--resume");

    // session_id PERSISTED to the state store (so the next turn resumes it).
    expect(state.get("eng")).toBe("sess-FIRST");
    // …and it survives a "restart" (a fresh store instance reads the file).
    expect(new AgentSessionState({ stateDir }).get("eng")).toBe("sess-FIRST");
  });
});

describe("ProgrammaticBackend.deliver — second turn (sid stored)", () => {
  test("argv includes --resume <sid>; reply extracted; sid stable across turns", async () => {
    mkDirs("second");
    const state = new AgentSessionState({ stateDir });
    // Turn 1 establishes the session; turn 2 must resume it.
    const { fn, calls } = sequencedSpawn([
      successTurn("sess-RESUME", "first reply"),
      successTurn("sess-RESUME", "second reply"),
    ]);
    const backend = new ProgrammaticBackend(baseDeps(fn, { sessionState: state }));
    const handle = await backend.start(specWithVault("eng"));

    const r1 = await backend.deliver(handle, "turn one");
    expect(r1.ok).toBe(true);
    expect(state.get("eng")).toBe("sess-RESUME");

    const r2 = await backend.deliver(handle, "turn two");
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.reply).toBe("second reply");

    // Turn 1 argv: no --resume. Turn 2 argv: --resume sess-RESUME.
    const cmd1 = calls[0]!.argv[2]!;
    const cmd2 = calls[1]!.argv[2]!;
    expect(cmd1).not.toContain("--resume");
    expect(cmd2).toContain("--resume sess-RESUME");
    // The sid is stable (same conversation continued, not forked).
    expect(state.get("eng")).toBe("sess-RESUME");
  });
});

describe("ProgrammaticBackend.deliver — error turn", () => {
  test("is_error:true → returns { ok:false, error }, no throw; sid still captured", async () => {
    mkDirs("err");
    const state = new AgentSessionState({ stateDir });
    const errBlob = ndjson(
      { type: "system", subtype: "init", session_id: "sess-ERR", apiKeySource: "none" },
      { type: "result", subtype: "error_during_execution", is_error: true, result: "boom in the agent", session_id: "sess-ERR" },
    );
    const { fn } = recordingSpawn({ stdout: errBlob });
    const backend = new ProgrammaticBackend(baseDeps(fn, { sessionState: state }));
    const handle = await backend.start(specWithVault("eng"));

    const result = await backend.deliver(handle, "do a thing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("boom in the agent");
      expect(result.sessionId).toBe("sess-ERR");
    }
    // The id is still persisted (a turn can fail AFTER establishing a session).
    expect(state.get("eng")).toBe("sess-ERR");
  });

  test("a non-success subtype → { ok:false } (no throw)", async () => {
    mkDirs("err2");
    const blob = ndjson(
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result", subtype: "error_max_turns", is_error: false, result: "ran out", session_id: "s" },
    );
    const { fn } = recordingSpawn({ stdout: blob });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault());
    const result = await backend.deliver(handle, "x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("error_max_turns");
  });

  test("a turn that fails BEFORE any session is established has no sessionId on the result", async () => {
    mkDirs("err-presession");
    const state = new AgentSessionState({ stateDir });
    // No init event, no session_id anywhere — an immediate non-success result.
    const blob = ndjson({ type: "result", subtype: "error_during_execution", is_error: true, result: "died early" });
    const { fn } = recordingSpawn({ stdout: blob });
    const backend = new ProgrammaticBackend(baseDeps(fn, { sessionState: state }));
    const handle = await backend.start(specWithVault("eng"));
    const result = await backend.deliver(handle, "x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("died early");
      expect(result.sessionId).toBeUndefined();
    }
    // Nothing persisted (no id to resume).
    expect(state.get("eng")).toBeUndefined();
  });

  test("no result event (truncated/crashed turn) + non-zero exit → { ok:false }", async () => {
    mkDirs("err3");
    const blob = ndjson({ type: "system", subtype: "init", session_id: "s", apiKeySource: "none" });
    const { fn } = recordingSpawn({ stdout: blob, stderr: "claude crashed", code: 1 });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault());
    const result = await backend.deliver(handle, "x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no success result|exited 1|crashed/);
  });
});

describe("ProgrammaticBackend.deliver — argv + env shape", () => {
  test("argv shape: -p, stream-json, strict-mcp-config, mcp-config, skip-permissions; NO dev-channels", async () => {
    mkDirs("argv");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault());
    await backend.deliver(handle, "hello");

    const cmd = calls[0]!.argv[2]!; // the engine echoes the claude command here
    expect(cmd).toContain(" -p ");
    expect(cmd).toContain("--output-format stream-json");
    expect(cmd).toContain("--strict-mcp-config");
    expect(cmd).toContain("--mcp-config");
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("dangerously-load-development-channels");
  });

  test("env: CLAUDE_CODE_OAUTH_TOKEN injected; ANTHROPIC_API_KEY / CLAUDE_API_KEY NOT present (#68 denylist)", async () => {
    mkDirs("env");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault());
    await backend.deliver(handle, "hello");

    const env = calls[0]!.env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("OAUTH-CRED-PLACEHOLDER");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_API_KEY).toBeUndefined();
    // the sandbox proxy env is layered on top
    expect(env.SANDBOX_RUNTIME).toBe("1");
  });

  test("the per-channel env injection (GH_TOKEN) reaches the child; a planted API key is dropped", async () => {
    mkDirs("env-inject");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(
      baseDeps(fn, {
        resolveChannelEnv: () => ({ GH_TOKEN: "ghp_INJECTED", ANTHROPIC_API_KEY: "sk-ant-SMUGGLED" }),
      }),
    );
    const handle = await backend.start(specWithVault());
    await backend.deliver(handle, "hello");

    const env = calls[0]!.env;
    expect(env.GH_TOKEN).toBe("ghp_INJECTED");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // denylist drops it defensively
  });
});

describe("ProgrammaticBackend.deliver — system prompt (file-backed, per-turn)", () => {
  test("append mode → --append-system-prompt-file <path> + the file is written 0600 with the prompt", async () => {
    mkDirs("sysprompt-append");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithSystemPrompt("You are the eng release bot.", "append", "eng"));
    await backend.deliver(handle, "hello");

    const promptPath = join(sessionsDir, "eng", "system-prompt.txt");
    // The file exists, is 0600, and carries the EXACT prompt text.
    expect(statSync(promptPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(promptPath, "utf8")).toBe("You are the eng release bot.");
    // The wrapped claude command (engine echoes it in argv[2]) carries the -file flag.
    const cmd = calls[0]!.argv[2]!;
    expect(cmd).toContain("--append-system-prompt-file");
    expect(cmd).toContain(promptPath);
    // `--system-prompt-file` is a substring of `--append-system-prompt-file`, so a
    // bare `not.toContain("--system-prompt-file")` would always fail. Assert the
    // replace-mode flag was NOT the one applied to the prompt path instead.
    expect(cmd).not.toContain("--system-prompt-file " + promptPath);
  });

  test("replace mode → --system-prompt-file <path>", async () => {
    mkDirs("sysprompt-replace");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithSystemPrompt("Full custom persona.", "replace", "eng"));
    await backend.deliver(handle, "hello");

    const promptPath = join(sessionsDir, "eng", "system-prompt.txt");
    expect(readFileSync(promptPath, "utf8")).toBe("Full custom persona.");
    const cmd = calls[0]!.argv[2]!;
    expect(cmd).toContain("--system-prompt-file");
    expect(cmd).not.toContain("--append-system-prompt-file");
  });

  test("no systemPrompt → no file, no system-prompt flag (today's behavior)", async () => {
    mkDirs("sysprompt-none");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));
    await backend.deliver(handle, "hello");

    expect(existsSync(join(sessionsDir, "eng", "system-prompt.txt"))).toBe(false);
    const cmd = calls[0]!.argv[2]!;
    expect(cmd).not.toContain("system-prompt-file");
  });

  test("the prompt file is (re)written + the flag re-passed on EVERY turn — incl. a resume turn", async () => {
    mkDirs("sysprompt-perturn");
    const state = new AgentSessionState({ stateDir });
    const { fn, calls } = sequencedSpawn([
      successTurn("sess-SP", "turn one reply"),
      successTurn("sess-SP", "turn two reply"),
    ]);
    const backend = new ProgrammaticBackend(baseDeps(fn, { sessionState: state }));
    const handle = await backend.start(specWithSystemPrompt("Per-turn role.", "append", "eng"));

    await backend.deliver(handle, "turn one");
    await backend.deliver(handle, "turn two");

    const promptPath = join(sessionsDir, "eng", "system-prompt.txt");
    // The file is present after the resume turn too (re-written each deliver).
    expect(readFileSync(promptPath, "utf8")).toBe("Per-turn role.");
    // Turn 1: -file flag, NO --resume. Turn 2 (resume): -file flag AND --resume.
    const cmd1 = calls[0]!.argv[2]!;
    const cmd2 = calls[1]!.argv[2]!;
    expect(cmd1).toContain("--append-system-prompt-file");
    expect(cmd1).not.toContain("--resume");
    expect(cmd2).toContain("--append-system-prompt-file"); // re-passed on the resume turn
    expect(cmd2).toContain("--resume sess-SP");
  });
});

// ---- the workspace seam (working-directory axis) ---------------------------
// design 2026-06-16-agent-filesystem-and-sharing.md — `workspace` is the agent's
// cwd + an rw working-root; .mcp.json (scoped vault token = secret) /
// system-prompt.txt / seeded home STAY in the per-agent private sessions/<name> dir.

function specWithWorkspace(workspace: string, name = "eng"): AgentSpec {
  return {
    name,
    channels: [name],
    vault: { name: "default", access: "read", tags: ["#channel-message"] },
    workspace,
  };
}

describe("ProgrammaticBackend.deliver — workspace seam: cwd = workspace, secrets stay private", () => {
  test("workspace SET → the turn's cwd is the workspace; the workspace is the sandbox rw working-root", async () => {
    mkDirs("ws-set");
    const workspaceDir = mkdtempSync(join(tmpdir(), "prog-shared-workdir-"));
    try {
      const { fn, calls } = recordingSpawn({ stdout: successTurn("s", "ok") });
      const engine = fakeEngine();
      const backend = new ProgrammaticBackend(baseDeps(fn, { sandboxEngine: engine }));
      const handle = await backend.start(specWithWorkspace(workspaceDir, "eng"));
      await backend.deliver(handle, "hello");

      const privateDir = join(sessionsDir, "eng");
      // The spawned turn's cwd is the SHARED workspace, NOT the private dir.
      expect(calls[0]!.cwd).toBe(workspaceDir);
      // The workspace is an rw working-root in the sandbox (read + write); the
      // private dir stays writable too (it holds .mcp.json/home/tmp).
      expect(engine.initializedWith!.filesystem.allowWrite).toContain(workspaceDir);
      expect(engine.initializedWith!.filesystem.allowWrite).toContain(privateDir);
      expect(engine.initializedWith!.filesystem.allowRead).toContain(workspaceDir);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("SECRETS-STAY-PRIVATE: .mcp.json / system-prompt.txt live in the PRIVATE dir, NEVER the shared workspace", async () => {
    mkDirs("ws-private");
    const workspaceDir = mkdtempSync(join(tmpdir(), "prog-shared-secrets-"));
    try {
      const { fn } = recordingSpawn({ stdout: successTurn("s", "ok") });
      const backend = new ProgrammaticBackend(baseDeps(fn));
      const spec: AgentSpec = {
        name: "eng",
        channels: ["eng"],
        vault: { name: "default", access: "read", tags: ["#channel-message"] },
        workspace: workspaceDir,
        systemPrompt: "Work in the repo.",
      };
      const handle = await backend.start(spec);
      await backend.deliver(handle, "hello");

      const privateDir = join(sessionsDir, "eng");
      // Private artifacts are under the per-agent dir…
      expect(statSync(join(privateDir, ".mcp.json")).mode & 0o777).toBe(0o600);
      expect(existsSync(join(privateDir, "system-prompt.txt"))).toBe(true);
      // …and the shared workspace has NONE of them (no secrets crossing the boundary).
      expect(existsSync(join(workspaceDir, ".mcp.json"))).toBe(false);
      expect(existsSync(join(workspaceDir, "system-prompt.txt"))).toBe(false);
      expect(existsSync(join(workspaceDir, "home"))).toBe(false);
      // The private .mcp.json DOES carry the minted vault token; the shared dir does not.
      const privateMcp = readFileSync(join(privateDir, ".mcp.json"), "utf8");
      expect(privateMcp).toContain("Bearer TOK-");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("workspace UNSET → the turn's cwd is the private dir (unchanged); only the private dir is writable", async () => {
    mkDirs("ws-unset");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const engine = fakeEngine();
    const backend = new ProgrammaticBackend(baseDeps(fn, { sandboxEngine: engine }));
    const handle = await backend.start(specWithVault("eng"));
    await backend.deliver(handle, "hello");

    const privateDir = join(sessionsDir, "eng");
    expect(calls[0]!.cwd).toBe(privateDir);
    expect(engine.initializedWith!.filesystem.allowWrite).toEqual([privateDir]);
  });
});

describe("ProgrammaticBackend.deliver — MCP config (vault only, no channel)", () => {
  test("writes a vault-only .mcp.json 0600 — NO channel MCP entry (daemon mediates messaging)", async () => {
    mkDirs("mcp");
    const { fn } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));
    await backend.deliver(handle, "hello");

    const mcpPath = join(sessionsDir, "eng", ".mcp.json");
    expect(statSync(mcpPath).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers: Record<string, unknown> };
    // The vault entry is present…
    expect(parsed.mcpServers[vaultEntryKey("default")]).toBeDefined();
    // …and NO channel entry (the daemon, not the agent, handles inbound/outbound).
    expect(parsed.mcpServers[channelEntryKey("eng")]).toBeUndefined();
    expect(Object.keys(parsed.mcpServers)).toEqual([vaultEntryKey("default")]);
  });

  test("a spec with no vault → an EMPTY mcpServers config (agent still runs)", async () => {
    mkDirs("novault");
    const { fn } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start({ name: "bare", channels: ["bare"] });
    const result = await backend.deliver(handle, "hello");
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(join(sessionsDir, "bare", ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(parsed.mcpServers)).toEqual([]);
  });
});

describe("ProgrammaticBackend.deliver — robustness", () => {
  test("interleaved hook/rate_limit lines + a trailing partial line still parse the result", async () => {
    mkDirs("robust");
    const messyStdout =
      "running a user hook...\n" +
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-R", apiKeySource: "none" }) + "\n" +
      JSON.stringify({ type: "system", subtype: "rate_limit_event", rate_limit: { five_hour: { overageStatus: "rejected" } } }) + "\n" +
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "..." }] }, session_id: "sess-R" }) + "\n" +
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "robust reply", session_id: "sess-R" }) + "\n" +
      '{"type":"system","subtype":"in'; // a cut-off trailing partial line
    const { fn } = recordingSpawn({ stdout: messyStdout });
    const state = new AgentSessionState({ stateDir });
    const backend = new ProgrammaticBackend(baseDeps(fn, { sessionState: state }));
    const handle = await backend.start(specWithVault("eng"));
    const result = await backend.deliver(handle, "hello");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply).toBe("robust reply");
      expect(result.sessionId).toBe("sess-R");
    }
    expect(state.get("eng")).toBe("sess-R");
  });
});

describe("ProgrammaticBackend.deliver — credential / mint failures (value, not throw)", () => {
  test("a missing Claude credential returns { ok:false } and never spawns", async () => {
    mkDirs("nocred");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(
      baseDeps(fn, {
        resolveClaudeToken: () => {
          throw new Error("no Claude credential for channel \"eng\"");
        },
      }),
    );
    const handle = await backend.start(specWithVault("eng"));
    const result = await backend.deliver(handle, "hello");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no Claude credential");
    expect(calls).toHaveLength(0); // never spawned
  });

  test("a refused vault mint (hub 400) returns { ok:false } and never spawns", async () => {
    mkDirs("badmint");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const refusingFetch = (async () =>
      new Response(
        JSON.stringify({ error: "invalid_scope", error_description: "not grantable by this bearer" }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const backend = new ProgrammaticBackend(baseDeps(fn, { fetchFn: refusingFetch }));
    const handle = await backend.start(specWithVault("eng"));
    const result = await backend.deliver(handle, "hello");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/mint refused/);
    expect(calls).toHaveLength(0); // mint failed before any spawn
  });
});

describe("ProgrammaticBackend — start / stop / status", () => {
  test("start validates the name + channels and carries the spec on the handle", async () => {
    mkDirs("start");
    const { fn } = recordingSpawn();
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const spec = specWithVault("eng");
    const handle = await backend.start(spec);
    expect(handle.backend).toBe(PROGRAMMATIC_BACKEND_KIND);
    expect(handle.channel).toBe("eng");
    expect(handle.name).toBe("eng");
    expect(handle.spec).toEqual(spec);

    await expect(backend.start({ name: "bad name", channels: ["c"] })).rejects.toThrow(/slug/);
    await expect(backend.start({ name: "ok", channels: [] })).rejects.toThrow(/no channels/);
  });

  test("stop() clears the persisted resume id (next turn starts fresh)", async () => {
    mkDirs("stop");
    const state = new AgentSessionState({ stateDir });
    const { fn } = recordingSpawn({ stdout: successTurn("sess-STOP", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn, { sessionState: state }));
    const handle = await backend.start(specWithVault("eng"));
    await backend.deliver(handle, "hello");
    expect(state.get("eng")).toBe("sess-STOP");
    await backend.stop(handle);
    expect(state.get("eng")).toBeUndefined();
  });

  test("status() is live (no resident process to keep alive)", async () => {
    mkDirs("status");
    const { fn } = recordingSpawn();
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault());
    expect(await backend.status(handle)).toEqual({ live: true });
  });
});
