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
  renderRunContext,
  PROGRAMMATIC_BACKEND_KIND,
  isTransientTurnError,
  isSessionNotFoundError,
  safeAttachmentBasename,
  ATTACHMENT_STAGING_DIR,
  ATTACHMENT_MAX_COUNT,
  TURN_MAX_ATTEMPTS,
  TURN_RETRY_BACKOFF_MS,
  type ProgrammaticBackendDeps,
  type ProgrammaticSpawnFn,
} from "./programmatic.ts";
import type { RunContext, TurnSession } from "./types.ts";
import type { InboundAttachment } from "../transport.ts";
import type { SandboxEngine } from "../sandbox/index.ts";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { AgentSpec } from "../sandbox/types.ts";
import { vaultEntryKey, channelEntryKey } from "../agent-mcp-config.ts";
import {
  GrantsClient,
  grantVaultEntryKey,
  grantServiceEntryKey,
  serviceMcpUrl,
  type ConnectionSpec,
  type GrantMaterial,
} from "../grants.ts";

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
      // Emulate the REAL `wrapWithSandboxArgv` contract: a bash -c wrapper carrying
      // the command, and `env` = the daemon's FULL `process.env` (on macOS/Linux the
      // real engine returns `process.env` verbatim; the proxy vars are baked into the
      // command string and ALSO present in process.env on Windows). The hand-made
      // SMALL env the old fake returned could never catch the passthrough leak — the
      // whole-`process.env`-spread that defeats buildAgentChildEnv's scrub. So the fake
      // must include the daemon's ambient secrets it would carry in real life PLUS the
      // proxy/sandbox vars, so a test can prove the leak is closed AND egress survives.
      //
      // The "argv" the runner spawns is therefore `["/bin/bash","-c","SBX <command>"]`;
      // assertions parse `argv[2]` for the claude flags.
      return {
        argv: ["/bin/bash", "-c", `SBX ${command}`],
        env: {
          // The daemon's ambient env (process.env) the real engine passes through —
          // these MUST be scrubbed from the launch env (the isolation/billing leak).
          ANTHROPIC_API_KEY: "sk-ant-DAEMON-AMBIENT-SHOULD-NOT-LEAK",
          CLAUDE_API_KEY: "daemon-ambient-also-should-not-leak",
          CLAUDE_CODE_OAUTH_TOKEN: "DAEMON-AMBIENT-WRONG-TOKEN-SHOULD-NOT-WIN",
          SECRET_THING: "daemon-ambient-secret-should-not-leak",
          PATH: "/daemon/bin",
          // The load-bearing sandbox/proxy vars the egress floor depends on — these
          // MUST survive into the launch env (allowlisted).
          SANDBOX_RUNTIME: "1",
          HTTP_PROXY: "http://localhost:5555",
          HTTPS_PROXY: "http://localhost:5555",
          NO_PROXY: "localhost,127.0.0.1",
          TMPDIR: "/tmp/claude",
          NODE_EXTRA_CA_CERTS: "/tmp/claude/ca.pem",
        },
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
    vault: { name: "default", access: "read", tags: ["agent/message"] },
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
    vault: { name: "default", access: "read", tags: ["agent/message"] },
    systemPrompt: prompt,
    ...(mode ? { systemPromptMode: mode } : {}),
  };
}

/** A multi-threaded spec — fresh-per-fire today (no resume, no persist). */
function specMultiThreaded(name = "eng"): AgentSpec {
  return {
    name,
    channels: [name],
    mode: "multi-threaded",
    vault: { name: "default", access: "read", tags: ["agent/message"] },
  };
}

function mkDirs(tag: string): void {
  sessionsDir = mkdtempSync(join(tmpdir(), `prog-sessions-${tag}-`));
  stateDir = mkdtempSync(join(tmpdir(), `prog-state-${tag}-`));
}

// ---- TurnSession helpers ---------------------------------------------------
// The daemon (registry) now OWNS the session uuid + the resume-vs-create decision and
// hands it to `deliver` as a {@link TurnSession}. These build the two shapes:
//  - createSession(id) → `--session-id <id>` (CREATE: first turn / every multi-threaded fire)
//  - resumeSession(id) → `--resume <id>` (CONTINUE: single-threaded turn 2+)
function createSession(id: string): TurnSession {
  return { id, resume: false };
}
function resumeSession(id: string): TurnSession {
  return { id, resume: true };
}
/** A fresh-create session with a generated uuid (the default when a test doesn't care). */
function freshSession(): TurnSession {
  return { id: crypto.randomUUID(), resume: false };
}

// ---- pure-helper tests -----------------------------------------------------

describe("buildProgrammaticClaudeArgs", () => {
  test("no session: -p + stream-json + strict MCP; NEITHER session flag, NO dev-channels", () => {
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
    // No sessionId → neither session flag.
    expect(argv).not.toContain("--resume");
    expect(argv).not.toContain("--session-id");
  });

  test("CREATE (resumeSession=false): --session-id <id> appended (NOT --resume)", () => {
    const argv = buildProgrammaticClaudeArgs({
      message: "first",
      mcpConfigPath: "/ws/.mcp.json",
      sessionId: "sess-new",
      resumeSession: false,
    });
    expect(argv).toContain("--session-id");
    expect(argv[argv.indexOf("--session-id") + 1]).toBe("sess-new");
    expect(argv).not.toContain("--resume");
  });

  test("CREATE (resumeSession omitted defaults to create): --session-id <id>", () => {
    const argv = buildProgrammaticClaudeArgs({
      message: "first",
      mcpConfigPath: "/ws/.mcp.json",
      sessionId: "sess-new",
    });
    expect(argv).toContain("--session-id");
    expect(argv[argv.indexOf("--session-id") + 1]).toBe("sess-new");
    expect(argv).not.toContain("--resume");
  });

  test("CONTINUE (resumeSession=true): --resume <id> appended (NOT --session-id)", () => {
    const argv = buildProgrammaticClaudeArgs({
      message: "next",
      mcpConfigPath: "/ws/.mcp.json",
      sessionId: "sess-xyz",
      resumeSession: true,
    });
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-xyz");
    expect(argv).not.toContain("--session-id");
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

  test("model set → --model <value> as a discrete argv pair", () => {
    const argv = buildProgrammaticClaudeArgs({
      message: "hi",
      mcpConfigPath: "/ws/.mcp.json",
      model: "opus",
    });
    const i = argv.indexOf("--model");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("opus");
  });

  test("model unset/empty/whitespace → NO --model flag (inherit CC default)", () => {
    expect(
      buildProgrammaticClaudeArgs({ message: "hi", mcpConfigPath: "/ws/.mcp.json" }),
    ).not.toContain("--model");
    expect(
      buildProgrammaticClaudeArgs({ message: "hi", mcpConfigPath: "/ws/.mcp.json", model: "" }),
    ).not.toContain("--model");
    expect(
      buildProgrammaticClaudeArgs({ message: "hi", mcpConfigPath: "/ws/.mcp.json", model: "   " }),
    ).not.toContain("--model");
  });

  test("model is trimmed before becoming the flag value", () => {
    const argv = buildProgrammaticClaudeArgs({
      message: "hi",
      mcpConfigPath: "/ws/.mcp.json",
      model: "  claude-opus-4-8  ",
    });
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-4-8");
  });
});

// ---- single-turn runner tests ----------------------------------------------

describe("renderRunContext — daemon-injected runtime preamble (agent#162)", () => {
  const NOW = "2026-06-28T17:05:42.000Z";

  test("absent runContext → the message is UNCHANGED (additive)", () => {
    expect(renderRunContext("the real message", undefined)).toBe("the real message");
  });

  test("prepends a labeled preamble carrying the REAL wall-clock + session, then the message", () => {
    const out = renderRunContext("write the digest", { now: NOW, session: "resumed" });
    // The preamble is clearly labeled as daemon-injected runtime context (not the system prompt).
    expect(out).toContain("Run context");
    expect(out).toContain("injected by the agent daemon");
    // It carries the REAL clock (the whole point — the agent stops fabricating timestamps).
    expect(out).toContain(`now=${NOW}`);
    expect(out).toContain("session=resumed");
    // The real message survives, AFTER the preamble (a blank line between).
    expect(out.endsWith("write the digest")).toBe(true);
    expect(out.indexOf("now=")).toBeLessThan(out.indexOf("write the digest"));
  });

  test("includes fired-by + the 1-based turn number when known", () => {
    const out = renderRunContext("go", {
      now: NOW,
      session: "resumed",
      firedBy: "scheduled-job:morning-weave",
      priorTurnCount: 24, // 24 completed → this is turn 25.
    });
    expect(out).toContain("fired-by=scheduled-job:morning-weave");
    expect(out).toContain("turn=25");
  });

  test("omits the optional fields when not provided (only now + session)", () => {
    const out = renderRunContext("go", { now: NOW, session: "new" });
    expect(out).toContain("now=" + NOW);
    expect(out).toContain("session=new");
    expect(out).not.toContain("fired-by=");
    expect(out).not.toContain("turn=");
  });
});

describe("ProgrammaticBackend.deliver — CREATE turn (--session-id)", () => {
  test("the assembled turn message carries the injected run-context timestamp (agent#162)", async () => {
    mkDirs("runctx");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("sess-RC", "ok") });
    const engine = fakeEngine();
    const backend = new ProgrammaticBackend(baseDeps(fn, { sandboxEngine: engine }));

    const handle = await backend.start(specWithVault("eng"));
    const now = "2026-06-28T17:05:42.000Z";
    const runContext: RunContext = { now, session: "resumed", firedBy: "scheduled-job:weave" };
    const result = await backend.deliver(handle, "report your status", createSession("sess-RC"), undefined, undefined, runContext);

    expect(result.ok).toBe(true);
    // The actual `claude -p` invocation (the wrapped command in argv[2]) carries the
    // daemon-injected run context — the real clock the headless turn otherwise lacks — AND
    // the original message. This is the issue's core assertion: the turn input carries the
    // injected timestamp instead of the agent fabricating one.
    const cmd = calls[0]!.argv[2]!;
    expect(cmd).toContain(now);
    expect(cmd).toContain("Run context");
    expect(cmd).toContain("session=resumed");
    expect(cmd).toContain("fired-by=scheduled-job:weave");
    expect(cmd).toContain("report your status");
  });

  test("a create session → argv has --session-id <id> (NOT --resume); reply + sessionId returned", async () => {
    mkDirs("first");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("sess-FIRST", "the reply text") });
    const engine = fakeEngine();
    const backend = new ProgrammaticBackend(baseDeps(fn, { sandboxEngine: engine }));

    const handle = await backend.start(specWithVault("eng"));
    const result = await backend.deliver(handle, "hi agent", createSession("sess-FIRST"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply).toBe("the reply text");
      // Claude echoes the session id (matches the uuid we passed) — RETURNED so the
      // registry persists it onto the thread note (the backend keeps no store).
      expect(result.sessionId).toBe("sess-FIRST");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalCostUsd: 0.001 });
    }

    // The wrapped argv (engine echoes the claude command in argv[2]) CREATES the session.
    expect(calls).toHaveLength(1);
    const cmd = calls[0]!.argv[2]!;
    expect(cmd).toContain("SBX claude -p");
    expect(cmd).toContain("--session-id sess-FIRST");
    expect(cmd).not.toContain("--resume");
  });
});

describe("ProgrammaticBackend.deliver — CONTINUE turn (--resume)", () => {
  test("a resume session → argv has --resume <id> (NOT --session-id); reply extracted", async () => {
    mkDirs("second");
    const { fn, calls } = sequencedSpawn([
      successTurn("sess-RESUME", "first reply"),
      successTurn("sess-RESUME", "second reply"),
    ]);
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));

    // Turn 1 CREATES the session (the registry would mint a fresh uuid); turn 2 RESUMES it
    // (the registry read it back off the thread note).
    const r1 = await backend.deliver(handle, "turn one", createSession("sess-RESUME"));
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.sessionId).toBe("sess-RESUME");

    const r2 = await backend.deliver(handle, "turn two", resumeSession("sess-RESUME"));
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.reply).toBe("second reply");

    // Turn 1 argv: --session-id (create). Turn 2 argv: --resume (continue) — same id.
    const cmd1 = calls[0]!.argv[2]!;
    const cmd2 = calls[1]!.argv[2]!;
    expect(cmd1).toContain("--session-id sess-RESUME");
    expect(cmd1).not.toContain("--resume");
    expect(cmd2).toContain("--resume sess-RESUME");
    expect(cmd2).not.toContain("--session-id");
  });
});

describe("ProgrammaticBackend.deliver — the backend is a pure function of the TurnSession", () => {
  test("the backend reads no store: it just runs the turn it's handed (create) and returns the id", async () => {
    // A multi-threaded fire is just a CREATE turn at this layer — the registry decides the
    // mode + the fresh uuid; the backend behaves identically to any create turn.
    mkDirs("multithreaded");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("sess-NEW", "ephemeral reply") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specMultiThreaded("eng"));

    const result = await backend.deliver(handle, "fire the turn", createSession("sess-NEW"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply).toBe("ephemeral reply");
      expect(result.sessionId).toBe("sess-NEW");
    }

    const cmd = calls[0]!.argv[2]!;
    expect(cmd).toContain("SBX claude -p");
    expect(cmd).toContain("--session-id sess-NEW");
    expect(cmd).not.toContain("--resume");
  });

  test("a create turn with a fresh uuid → --session-id <uuid>, NO --resume", async () => {
    mkDirs("multithreaded-fresh");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("sess-X", "reply") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specMultiThreaded("eng"));

    const session = freshSession();
    await backend.deliver(handle, "go", session);
    const cmd = calls[0]!.argv[2]!;
    expect(cmd).toContain(`--session-id ${session.id}`);
    expect(cmd).not.toContain("--resume");
  });

  test("a resume turn → --resume <id>, NO --session-id (single-threaded turn 2+ path)", async () => {
    mkDirs("single-threaded-regress");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("sess-PRIOR", "continued") });
    // specWithVault has NO mode → single-threaded (the default); the registry resumes it.
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));

    const result = await backend.deliver(handle, "continue the thread", resumeSession("sess-PRIOR"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sessionId).toBe("sess-PRIOR");
    const cmd = calls[0]!.argv[2]!;
    expect(cmd).toContain("--resume sess-PRIOR");
    expect(cmd).not.toContain("--session-id");
  });
});

describe("ProgrammaticBackend.deliver — error turn", () => {
  test("is_error:true → returns { ok:false, error }, no throw; sid still captured", async () => {
    mkDirs("err");
    const errBlob = ndjson(
      { type: "system", subtype: "init", session_id: "sess-ERR", apiKeySource: "none" },
      { type: "result", subtype: "error_during_execution", is_error: true, result: "boom in the agent", session_id: "sess-ERR" },
    );
    const { fn } = recordingSpawn({ stdout: errBlob });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));

    const result = await backend.deliver(handle, "do a thing", createSession("sess-ERR"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("boom in the agent");
      // The id is still RETURNED (a turn can fail AFTER establishing a session) — the
      // registry persists it so the next turn resumes the conversation.
      expect(result.sessionId).toBe("sess-ERR");
    }
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
    const result = await backend.deliver(handle, "x", freshSession());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("error_max_turns");
  });

  test("a turn that fails BEFORE any session is established has no sessionId on the result", async () => {
    mkDirs("err-presession");
    // No init event, no session_id anywhere — an immediate non-success result. Claude
    // echoed no id, so the backend reports none (the registry then falls back to the
    // turn uuid it passed when persisting).
    const blob = ndjson({ type: "result", subtype: "error_during_execution", is_error: true, result: "died early" });
    const { fn } = recordingSpawn({ stdout: blob });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));
    const result = await backend.deliver(handle, "x", createSession("sess-IGNORED-NO-ECHO"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("died early");
      // No echoed id from claude → none on the result (the registry uses turnSession.id).
      expect(result.sessionId).toBeUndefined();
    }
  });

  test("no result event (truncated/crashed turn) + non-zero exit → { ok:false }", async () => {
    mkDirs("err3");
    const blob = ndjson({ type: "system", subtype: "init", session_id: "s", apiKeySource: "none" });
    const { fn } = recordingSpawn({ stdout: blob, stderr: "claude crashed", code: 1 });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault());
    const result = await backend.deliver(handle, "x", freshSession());
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
    await backend.deliver(handle, "hello", freshSession());

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
    await backend.deliver(handle, "hello", freshSession());

    const env = calls[0]!.env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("OAUTH-CRED-PLACEHOLDER");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_API_KEY).toBeUndefined();
    // the sandbox proxy env is layered on top
    expect(env.SANDBOX_RUNTIME).toBe("1");
  });

  test("REGRESSION (isolation/billing leak): the engine's returned env (= daemon process.env) is NOT spread onto the launch env — only allowlisted sandbox/proxy keys survive; the scrub wins", async () => {
    // The real `wrapWithSandboxArgv` returns `env: process.env` (the FULL daemon env)
    // on macOS/Linux. The fakeEngine now mirrors that — its returned env carries the
    // daemon's ambient ANTHROPIC_API_KEY / CLAUDE_API_KEY / SECRET_THING / a WRONG
    // CLAUDE_CODE_OAUTH_TOKEN. The old `{ ...childEnv, ...wrapped.env, ...homeEnv }`
    // spread let those OVERRIDE the scrubbed childEnv → reaching the sandboxed turn
    // (subscription-billing + secret-leak breach). mergeSandboxLaunchEnv allowlists
    // wrapped.env, so the scrub stays authoritative.
    mkDirs("env-leak-regression");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault());
    await backend.deliver(handle, "hello", freshSession());

    const env = calls[0]!.env;

    // 1. LEAK CLOSED: the daemon's ambient secrets the engine returned never reach
    //    the launch env (neither the scrubbed childEnv nor the allowlist admits them).
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_API_KEY).toBeUndefined();
    expect(env.SECRET_THING).toBeUndefined();

    // 2. MANAGED AUTH WINS: CLAUDE_CODE_OAUTH_TOKEN is the session's resolved token,
    //    NOT the wrong daemon-ambient one the engine env carried (it's denylisted +
    //    not allowlisted, so step 2 can never overwrite the scrub's value).
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("OAUTH-CRED-PLACEHOLDER");

    // 3. EGRESS PRESERVED: the load-bearing sandbox/proxy vars DO survive (allowlist),
    //    so the egress proxy keeps working — the fix doesn't strangle the network.
    expect(env.SANDBOX_RUNTIME).toBe("1");
    expect(env.HTTP_PROXY).toBe("http://localhost:5555");
    expect(env.HTTPS_PROXY).toBe("http://localhost:5555");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/claude/ca.pem");

    // 4. The daemon's ambient PATH from the engine env does NOT clobber the scrubbed
    //    PATH (PATH isn't in the sandbox allowlist; childEnv's passthrough owns it).
    expect(env.PATH).not.toBe("/daemon/bin");
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
    await backend.deliver(handle, "hello", freshSession());

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
    await backend.deliver(handle, "hello", freshSession());

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
    await backend.deliver(handle, "hello", freshSession());

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
    await backend.deliver(handle, "hello", freshSession());

    expect(existsSync(join(sessionsDir, "eng", "system-prompt.txt"))).toBe(false);
    const cmd = calls[0]!.argv[2]!;
    expect(cmd).not.toContain("system-prompt-file");
  });

  test("the prompt file is (re)written + the flag re-passed on EVERY turn — incl. a resume turn", async () => {
    mkDirs("sysprompt-perturn");
    const { fn, calls } = sequencedSpawn([
      successTurn("sess-SP", "turn one reply"),
      successTurn("sess-SP", "turn two reply"),
    ]);
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithSystemPrompt("Per-turn role.", "append", "eng"));

    // Turn 1 CREATES the session; turn 2 RESUMES it (the registry's mode decision).
    await backend.deliver(handle, "turn one", createSession("sess-SP"));
    await backend.deliver(handle, "turn two", resumeSession("sess-SP"));

    const promptPath = join(sessionsDir, "eng", "system-prompt.txt");
    // The file is present after the resume turn too (re-written each deliver).
    expect(readFileSync(promptPath, "utf8")).toBe("Per-turn role.");
    // Turn 1: -file flag + --session-id. Turn 2 (resume): -file flag AND --resume.
    const cmd1 = calls[0]!.argv[2]!;
    const cmd2 = calls[1]!.argv[2]!;
    expect(cmd1).toContain("--append-system-prompt-file");
    expect(cmd1).toContain("--session-id sess-SP");
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
    vault: { name: "default", access: "read", tags: ["agent/message"] },
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
      await backend.deliver(handle, "hello", freshSession());

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
        vault: { name: "default", access: "read", tags: ["agent/message"] },
        workspace: workspaceDir,
        systemPrompt: "Work in the repo.",
      };
      const handle = await backend.start(spec);
      await backend.deliver(handle, "hello", freshSession());

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
    await backend.deliver(handle, "hello", freshSession());

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
    await backend.deliver(handle, "hello", freshSession());

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
    const result = await backend.deliver(handle, "hello", freshSession());
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
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));
    const result = await backend.deliver(handle, "hello", createSession("sess-R"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply).toBe("robust reply");
      // The captured id is RETURNED for the registry to persist (the backend keeps no store).
      expect(result.sessionId).toBe("sess-R");
    }
  });
});

describe("ProgrammaticBackend.deliver — streaming interim events (the watch-it-work view)", () => {
  /** A spawnFn whose stdout emits the given byte CHUNKS in order (multi-chunk stream). */
  function chunkedSpawn(chunks: string[]): ProgrammaticSpawnFn {
    const enc = new TextEncoder();
    return () => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(enc.encode(c));
          controller.close();
        },
      }),
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    });
  }

  test("onInterim receives init + text + tool_use; the durable result is unchanged", async () => {
    mkDirs("stream");
    const blob =
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-STREAM", apiKeySource: "none" }) + "\n" +
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "looking…" }] }, session_id: "sess-STREAM" }) + "\n" +
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Grep" }] }, session_id: "sess-STREAM" }) + "\n" +
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "looking… found it", session_id: "sess-STREAM" }) + "\n";
    // Split into two chunks at a mid-line boundary to exercise incremental decoding.
    const cut = Math.floor(blob.length / 2);
    const backend = new ProgrammaticBackend(
      baseDeps(chunkedSpawn([blob.slice(0, cut), blob.slice(cut)])),
    );
    const handle = await backend.start(specWithVault("eng"));

    const events: unknown[] = [];
    const result = await backend.deliver(handle, "where is X", createSession("sess-STREAM"), (e) =>
      events.push(e),
    );

    expect(events).toEqual([
      { kind: "init", sessionId: "sess-STREAM" },
      { kind: "text", text: "looking…" },
      { kind: "tool", tool: "Grep" },
    ]);
    // The DURABLE final result is exactly as the non-streaming path would produce it.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply).toBe("looking… found it");
      expect(result.sessionId).toBe("sess-STREAM");
    }
  });

  test("a turn with NO onInterim runs identically (durable reply intact, no throw)", async () => {
    mkDirs("nostream");
    const { fn } = recordingSpawn({ stdout: successTurn("sess-NS", "plain reply") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));
    const result = await backend.deliver(handle, "hi", freshSession()); // no sink
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply).toBe("plain reply");
  });

  test("a THROWING onInterim sink cannot break the turn (durable result still returned)", async () => {
    mkDirs("sinkthrow");
    const { fn } = recordingSpawn({ stdout: successTurn("sess-THROW", "survives") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));
    const result = await backend.deliver(handle, "hi", freshSession(), () => {
      throw new Error("dead SSE stream");
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply).toBe("survives");
  });

  test("an ERROR turn still streams its init then returns { ok:false } (live view can resolve)", async () => {
    mkDirs("streamerr");
    const blob =
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-ERR" }) + "\n" +
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", session_id: "sess-ERR" }) + "\n";
    const backend = new ProgrammaticBackend(baseDeps(chunkedSpawn([blob])));
    const handle = await backend.start(specWithVault("eng"));
    const events: unknown[] = [];
    const result = await backend.deliver(handle, "go", createSession("sess-ERR"), (e) =>
      events.push(e),
    );
    expect(events).toEqual([{ kind: "init", sessionId: "sess-ERR" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("boom");
      expect(result.sessionId).toBe("sess-ERR");
    }
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
    const result = await backend.deliver(handle, "hello", freshSession());
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
    const result = await backend.deliver(handle, "hello", freshSession());
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

  test("stop() is a NO-OP (no store to clear; the session lives on the thread note)", async () => {
    mkDirs("stop");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("sess-STOP", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));
    // A turn establishes a session; the id is RETURNED (the registry persists it on the note).
    const r = await backend.deliver(handle, "hello", createSession("sess-STOP"));
    expect(r.ok).toBe(true);
    // stop() does not throw and runs no side effect — the backend keeps no session store, so
    // there is nothing to clear (continuity now lives on the durable #agent/thread note).
    await backend.stop(handle);
    // It does not spawn anything or otherwise touch the turn machinery.
    expect(calls).toHaveLength(1);
    // A subsequent RESUME turn still works (the registry would supply the same id off the note).
    const r2 = await backend.deliver(handle, "again", resumeSession("sess-STOP"));
    expect(r2.ok).toBe(true);
    expect(calls[1]!.argv[2]!).toContain("--resume sess-STOP");
  });

  test("status() is live (no resident process to keep alive)", async () => {
    mkDirs("status");
    const { fn } = recordingSpawn();
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault());
    expect(await backend.status(handle)).toEqual({ live: true });
  });
});

// ---------------------------------------------------------------------------
// 4b — cross-resource grant injection (design 2026-06-17-agent-connectors-4b)
// ---------------------------------------------------------------------------

/**
 * A fake hub grants API for the spawn-injection path. `listGrants` returns the given
 * approved grants; `getMaterial` returns the keyed material (or 404). Records each
 * material fetch so a test can prove FRESH-each-spawn (no caching).
 */
function grantsClientFor(opts: {
  grants: Array<{ id: string; connection: ConnectionSpec; status: string }>;
  material?: Record<string, GrantMaterial>;
  onMaterialCall?: (id: string) => void;
}): GrantsClient {
  const fetchFn = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/admin/grants/")) {
      const id = u.split("/admin/grants/")[1]!.replace("/material", "");
      opts.onMaterialCall?.(id);
      const m = opts.material?.[id];
      if (!m) return new Response("no", { status: 404 });
      return new Response(JSON.stringify(m), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        grants: opts.grants.map((g) => ({ id: g.id, agent: "eng", connection: g.connection, status: g.status })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return new GrantsClient({ hubOrigin: "https://hub.example.com", managerBearer: "MGR", fetchFn });
}

/** Read the written per-spawn .mcp.json's mcpServers for a session. */
function readMcpServers(name: string): Record<string, { type: string; url: string; headers?: { Authorization: string } }> {
  const parsed = JSON.parse(readFileSync(join(sessionsDir, name, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { type: string; url: string; headers?: { Authorization: string } }>;
  };
  return parsed.mcpServers;
}

describe("ProgrammaticBackend.deliver — grant injection (4b)", () => {
  test("approved VAULT grant → an extra MCP server in --mcp-config (alongside own-vault)", async () => {
    mkDirs("grant-vault");
    const conn: ConnectionSpec = { kind: "vault", target: "research", access: "read" };
    const grants = grantsClientFor({
      grants: [{ id: "g1", connection: conn, status: "approved" }],
      material: { g1: { kind: "vault", token: "RTOK", mcpUrl: "https://hub/vault/research/mcp" } },
    });
    const { fn } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn, { grants }));
    const handle = await backend.start(specWithVault("eng"));
    await backend.deliver(handle, "hi", freshSession());

    const servers = readMcpServers("eng");
    // Own def-vault entry still present…
    expect(servers[vaultEntryKey("default")]).toBeDefined();
    // …PLUS the granted research vault, namespaced + with its Bearer.
    const granted = servers[grantVaultEntryKey("research")]!;
    expect(granted.type).toBe("http");
    expect(granted.url).toBe("https://hub/vault/research/mcp");
    expect(granted.headers!.Authorization).toBe("Bearer RTOK");
  });

  test("approved SERVICE grant (env) → an env var for the agent's shell tools", async () => {
    mkDirs("grant-env");
    const conn: ConnectionSpec = { kind: "service", target: "github", inject: ["env"] };
    const grants = grantsClientFor({
      grants: [{ id: "g1", connection: conn, status: "approved" }],
      material: { g1: { kind: "service", token: "ghp_GRANTED", inject: ["env"] } },
    });
    const { fn, calls } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn, { grants }));
    const handle = await backend.start(specWithVault("eng"));
    await backend.deliver(handle, "hi", freshSession());

    expect(calls[0]!.env.GITHUB_TOKEN).toBe("ghp_GRANTED");
    // The granted env var never clobbers the managed Claude auth.
    expect(calls[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("OAUTH-CRED-PLACEHOLDER");
    // No service MCP entry for an env-only grant.
    expect(readMcpServers("eng")[grantServiceEntryKey("github")]).toBeUndefined();
  });

  test("approved SERVICE grant (mcp) → the service's MCP server in --mcp-config", async () => {
    mkDirs("grant-svc-mcp");
    const conn: ConnectionSpec = { kind: "service", target: "github", inject: ["mcp"] };
    const grants = grantsClientFor({
      grants: [{ id: "g1", connection: conn, status: "approved" }],
      material: { g1: { kind: "service", token: "ghp_MCP", inject: ["mcp"] } },
    });
    const { fn, calls } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn, { grants }));
    const handle = await backend.start(specWithVault("eng"));
    await backend.deliver(handle, "hi", freshSession());

    const svc = readMcpServers("eng")[grantServiceEntryKey("github")]!;
    expect(svc.type).toBe("http");
    expect(svc.url).toBe(serviceMcpUrl("github")!);
    expect(svc.headers!.Authorization).toBe("Bearer ghp_MCP");
    // mcp-only inject → no GITHUB_TOKEN env var.
    expect(calls[0]!.env.GITHUB_TOKEN).toBeUndefined();
  });

  test("MCP-KIND grant is NEVER injected in 4b-1 (no material → 404 → absent)", async () => {
    mkDirs("grant-mcp-kind");
    const conn: ConnectionSpec = { kind: "mcp", target: "https://remote/mcp" };
    // Even modeled as "approved", the hub returns no material in 4b-1 (no OAuth).
    const grants = grantsClientFor({ grants: [{ id: "g1", connection: conn, status: "approved" }] });
    const { fn } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn, { grants }));
    const handle = await backend.start(specWithVault("eng"));
    await backend.deliver(handle, "hi", freshSession());

    const servers = readMcpServers("eng");
    // Only the own def-vault entry — the mcp-kind grant added nothing.
    expect(Object.keys(servers)).toEqual([vaultEntryKey("default")]);
  });

  test("material is fetched FRESH each spawn (revocation takes effect next turn — no cache)", async () => {
    mkDirs("grant-fresh");
    const called: string[] = [];
    const conn: ConnectionSpec = { kind: "vault", target: "research", access: "read" };
    const grants = grantsClientFor({
      grants: [{ id: "g1", connection: conn, status: "approved" }],
      material: { g1: { kind: "vault", token: "RTOK", mcpUrl: "https://hub/vault/research/mcp" } },
      onMaterialCall: (id) => called.push(id),
    });
    const { fn } = sequencedSpawn([successTurn("s", "one"), successTurn("s", "two")]);
    const backend = new ProgrammaticBackend(baseDeps(fn, { grants }));
    const handle = await backend.start(specWithVault("eng"));
    await backend.deliver(handle, "turn one", createSession("s"));
    await backend.deliver(handle, "turn two", resumeSession("s"));
    // Two turns → two material fetches (no caching).
    expect(called).toEqual(["g1", "g1"]);
  });

  test("a grants-LIST failure is non-fatal — the turn runs with own-vault only", async () => {
    mkDirs("grant-list-fail");
    const fetchFn = (async (url: string | URL | Request) => {
      // mint succeeds (vault token), grants list 500s.
      if (String(url).includes("/admin/grants")) return new Response("boom", { status: 500 });
      return fakeMintFetch()(url);
    }) as typeof fetch;
    const grants = new GrantsClient({ hubOrigin: "https://hub.example.com", managerBearer: "MGR", fetchFn });
    const { fn } = recordingSpawn({ stdout: successTurn("s", "ok") });
    // Use the same fetch for the mint path so the vault token still mints.
    const backend = new ProgrammaticBackend(baseDeps(fn, { grants, fetchFn }));
    const handle = await backend.start(specWithVault("eng"));
    const result = await backend.deliver(handle, "hi", freshSession());
    expect(result.ok).toBe(true); // own-vault turn unaffected by the grant blip
    const servers = readMcpServers("eng");
    expect(servers[vaultEntryKey("default")]).toBeDefined();
    expect(Object.keys(servers)).toEqual([vaultEntryKey("default")]); // no grants injected
  });

  test("NO grants client → today's behavior exactly (own-vault only)", async () => {
    mkDirs("grant-none");
    const { fn } = recordingSpawn({ stdout: successTurn("s", "ok") });
    const backend = new ProgrammaticBackend(baseDeps(fn)); // no grants in deps
    const handle = await backend.start(specWithVault("eng"));
    await backend.deliver(handle, "hi", freshSession());
    expect(Object.keys(readMcpServers("eng"))).toEqual([vaultEntryKey("default")]);
  });
});

describe("ProgrammaticBackend.deliver — transient-error retry with incremental backoff", () => {
  const transientResult = (sid: string, msg: string) =>
    ndjson(
      { type: "system", subtype: "init", session_id: sid, apiKeySource: "none" },
      { type: "result", subtype: "error_during_execution", is_error: true, result: msg, session_id: sid },
    );

  test("retries a TRANSIENT turn error (backoff), then succeeds", async () => {
    mkDirs("retry-ok");
    const sleeps: number[] = [];
    const { fn, calls } = sequencedSpawn([
      transientResult("s1", "API Error: 529 Overloaded. Try again."),
      successTurn("s2", "recovered"),
    ]);
    const backend = new ProgrammaticBackend(
      baseDeps(fn, {
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      }),
    );
    const handle = await backend.start(specWithVault("eng"));
    const result = await backend.deliver(handle, "go", createSession("s1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply).toBe("recovered");
      // The SUCCESSFUL attempt's sid is RETURNED (not the failed attempt's "s1").
      expect(result.sessionId).toBe("s2");
    }
    expect(calls.length).toBe(2); // one retry
    expect(sleeps).toHaveLength(1); // one backoff
    expect(sleeps[0]).toBe(TURN_RETRY_BACKOFF_MS[0]); // the first (incremental) interval
  });

  test("does NOT retry a non-transient turn error (fails fast, no sleep)", async () => {
    mkDirs("retry-no");
    const sleeps: number[] = [];
    const { fn, calls } = recordingSpawn({
      stdout: transientResult("s", "401 unauthorized: invalid token"),
    });
    const backend = new ProgrammaticBackend(
      baseDeps(fn, {
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      }),
    );
    const handle = await backend.start(specWithVault());
    const result = await backend.deliver(handle, "go", freshSession());
    expect(result.ok).toBe(false);
    expect(calls.length).toBe(1); // no retry
    expect(sleeps.length).toBe(0);
  });

  test("a persistently TRANSIENT error exhausts the retries → { ok:false }", async () => {
    mkDirs("retry-exhaust");
    const sleeps: number[] = [];
    const { fn, calls } = recordingSpawn({
      stdout: transientResult("s", "API Error: 503 Service Unavailable"),
    });
    const backend = new ProgrammaticBackend(
      baseDeps(fn, {
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      }),
    );
    const handle = await backend.start(specWithVault("eng"));
    const result = await backend.deliver(handle, "go", createSession("s"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("503");
      // The session id is still RETURNED even on a FINAL failure (continuation handle).
      expect(result.sessionId).toBe("s");
    }
    expect(calls.length).toBe(TURN_MAX_ATTEMPTS); // all attempts used
    expect(sleeps.length).toBe(TURN_MAX_ATTEMPTS - 1); // one backoff before each retry
  });
});

describe("isTransientTurnError", () => {
  test("transient upstream/network signals → true", () => {
    for (const s of [
      "API Error: 529 Overloaded",
      "503 Service Unavailable",
      "429 rate limit exceeded",
      "Internal Server Error",
      "Bad Gateway",
      "ETIMEDOUT",
      "socket hang up (ECONNRESET)",
    ]) {
      expect(isTransientTurnError(s)).toBe(true);
    }
  });

  test("permanent/deterministic signals → false (no pointless retry)", () => {
    for (const s of [
      "401 unauthorized",
      "400 bad request",
      'no Claude credential for channel "x"',
      "claude -p turn failed (subtype: error_max_turns)",
      "tag_scope_violation",
    ]) {
      expect(isTransientTurnError(s)).toBe(false);
    }
  });
});

describe("isSessionNotFoundError", () => {
  test("resume-of-a-missing-session phrasings → true", () => {
    for (const s of [
      "No conversation found with session ID: 3f8c-...",
      "no conversation found",
      "Session not found",
      "claude -p exited 1: Error: No session found for id abc",
      "Could not find a session with that id",
      "the conversation with that id was not found",
    ]) {
      expect(isSessionNotFoundError(s)).toBe(true);
    }
  });

  test("generic / unrelated failures → false (conservative — never a bare 'not found')", () => {
    for (const s of [
      "claude -p exited 1: some other error",
      "rate limit",
      "",
      "401 unauthorized",
      "file not found", // a bare "not found" without conversation/session
      "tag_scope_violation",
    ]) {
      expect(isSessionNotFoundError(s)).toBe(false);
    }
  });
});

// ---- session-expiry → fresh-create fallback (#132) -------------------------

/**
 * A spawnFn that branches on whether the wrapped argv carries `--resume`:
 *  - a `--resume` turn returns `onResume` (default: a session-not-found failure),
 *  - a `--session-id` (create) turn returns `onCreate` (default: success).
 * Records each call so a test can assert the flag transition resume → fresh create.
 */
function flagBranchingSpawn(opts: {
  onResume?: string;
  onCreate?: string;
  resumeCode?: number;
  createCode?: number;
}): {
  fn: ProgrammaticSpawnFn;
  calls: Array<{ argv: string[]; cmd: string }>;
} {
  const calls: Array<{ argv: string[]; cmd: string }> = [];
  const fn: ProgrammaticSpawnFn = (argv) => {
    const cmd = argv[2] ?? ""; // the fake engine echoes the claude command in argv[2]
    calls.push({ argv, cmd });
    const isResume = cmd.includes("--resume");
    const out = isResume ? (opts.onResume ?? "") : (opts.onCreate ?? "");
    const code = isResume ? (opts.resumeCode ?? 0) : (opts.createCode ?? 0);
    return { stdout: new Response(out).body, stderr: new Response("").body, exited: Promise.resolve(code) };
  };
  return { fn, calls };
}

/** A non-success stream-json result with a session id + an arbitrary error message. */
function failTurn(sessionId: string, message: string): string {
  return ndjson(
    { type: "system", subtype: "init", session_id: sessionId, apiKeySource: "none" },
    { type: "result", subtype: "error_during_execution", is_error: true, result: message, session_id: sessionId },
  );
}

describe("ProgrammaticBackend.deliver — session-expiry → fresh-create fallback (#132)", () => {
  test("resume → session-not-found → fresh --session-id create succeeds; NEW id returned; two spawns", async () => {
    mkDirs("fallback-ok");
    const { fn, calls } = flagBranchingSpawn({
      // The --resume turn fails with claude's session-not-found error…
      onResume: failTurn("old-uuid", "No conversation found with session ID: old-uuid"),
      // …and a fresh --session-id create turn SUCCEEDS (claude echoes the create id).
      onCreate: successTurn("fresh-created-uuid", "recovered after fresh create"),
    });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));

    const result = await backend.deliver(handle, "continue please", resumeSession("old-uuid"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply).toBe("recovered after fresh create");
      // The sessionId is the NEW (create) id echoed by claude — NOT the dead "old-uuid".
      expect(result.sessionId).toBe("fresh-created-uuid");
      expect(result.sessionId).not.toBe("old-uuid");
    }

    // TWO spawns: first --resume old-uuid, then --session-id <fresh> (a DIFFERENT uuid).
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cmd).toContain("--resume old-uuid");
    expect(calls[0]!.cmd).not.toContain("--session-id");
    expect(calls[1]!.cmd).toContain("--session-id");
    expect(calls[1]!.cmd).not.toContain("--resume");
    // The fresh create id is a generated uuid — present, and NOT the dead old one.
    const createIdx = calls[1]!.argv[2]!.indexOf("--session-id ");
    const freshId = calls[1]!.argv[2]!.slice(createIdx + "--session-id ".length).split(/\s/)[0]!;
    expect(freshId).not.toBe("old-uuid");
    expect(freshId.length).toBeGreaterThan(0);
  });

  test("a resume turn that fails with a NON-not-found (non-transient) error does NOT fall back", async () => {
    mkDirs("fallback-no");
    const { fn, calls } = flagBranchingSpawn({
      // A generic, non-not-found, non-transient failure on the resume turn.
      onResume: failTurn("old-uuid", "401 unauthorized: invalid token"),
      onCreate: successTurn("would-not-be-used", "should never run"),
    });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));

    const result = await backend.deliver(handle, "continue", resumeSession("old-uuid"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("401 unauthorized");
    // ONE spawn only — no fresh-create fallback for a non-not-found failure.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toContain("--resume old-uuid");
  });

  test("session-not-found on a CREATE turn does NOT loop (the session.resume guard prevents the fallback)", async () => {
    mkDirs("fallback-create");
    // A CREATE turn (resume:false) that itself returns a not-found error. The fallback
    // is guarded on session.resume, so a create's not-found can never re-trigger it.
    const { fn, calls } = recordingSpawn({
      stdout: failTurn("sess-CREATE", "No conversation found with session ID: sess-CREATE"),
    });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));

    const result = await backend.deliver(handle, "first turn", createSession("sess-CREATE"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No conversation found");
    // EXACTLY one spawn — the guard prevented any fallback create.
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// INBOUND FILE ATTACHMENTS (Phase 1) — the programmatic backend stages each
// attached file into the agent's PRIVATE session workspace (under a SAFE
// basename, no traversal) and appends a pointer line to the turn prompt so the
// `claude -p` turn can Read it. Best-effort + isolated per-file.
// ---------------------------------------------------------------------------

/**
 * A fetch fake that serves BOTH the mint hub (POST → a token) AND vault storage
 * blobs (GET .../api/storage/<path> → bytes). `blobs` maps a storage path → the
 * byte body to return; a path not in the map 404s.
 */
function mintAndBlobFetch(blobs: Record<string, string> = {}): {
  fetchFn: typeof fetch;
  blobCalls: Array<{ url: string; auth: string | undefined }>;
} {
  let n = 0;
  const blobCalls: Array<{ url: string; auth: string | undefined }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.includes("/api/storage/")) {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      blobCalls.push({ url: u, auth });
      const enc = u.split("/api/storage/")[1] ?? "";
      const path = decodeURIComponent(enc);
      const body = blobs[path];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { scope: string };
      n += 1;
      return new Response(
        JSON.stringify({ jti: `j${n}`, token: `TOK-${n}`, expires_at: "2026-09-01T00:00:00Z", scope: body.scope }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  return { fetchFn, blobCalls };
}

function att(path: string, mimeType: string, filename?: string): InboundAttachment {
  return { path, mimeType, filename: filename ?? path.split("/").pop()! };
}

describe("safeAttachmentBasename — path-traversal sanitization (security)", () => {
  test("strips directory components + traversal markers to a plain basename", () => {
    expect(safeAttachmentBasename("../../etc/passwd")).toBe("passwd");
    expect(safeAttachmentBasename("/abs/path/report.png")).toBe("report.png");
    expect(safeAttachmentBasename("a/b/c/note.md")).toBe("note.md");
    expect(safeAttachmentBasename("..\\..\\windows\\system32\\cmd.exe")).toBe("cmd.exe");
  });
  test("collapses disallowed chars to underscore + strips leading dots", () => {
    expect(safeAttachmentBasename(".hidden")).toBe("hidden");
    expect(safeAttachmentBasename("a b.png")).toBe("a_b.png");
  });
  test("degenerate input → a stable non-empty default", () => {
    expect(safeAttachmentBasename("")).toBe("file");
    expect(safeAttachmentBasename("..")).toBe("file");
    expect(safeAttachmentBasename("/")).toBe("file");
    expect(safeAttachmentBasename("./")).toBe("file");
  });
});

describe("ProgrammaticBackend.deliver — inbound attachment staging", () => {
  test("stages each blob into the PRIVATE workspace under a safe basename + appends the prompt line", async () => {
    mkDirs("att-stage");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("sess-A", "looked at the files") });
    const { fetchFn, blobCalls } = mintAndBlobFetch({
      "2026-06-24/abc.png": "PNGBYTES",
      "2026-06-24/def.txt": "hello world",
    });
    const backend = new ProgrammaticBackend(baseDeps(fn, { fetchFn }));
    const handle = await backend.start(specWithVault("eng"));

    const result = await backend.deliver(
      handle,
      "what is in these",
      createSession("sess-A"),
      undefined,
      [att("2026-06-24/abc.png", "image/png"), att("2026-06-24/def.txt", "text/plain")],
    );
    expect(result.ok).toBe(true);

    // Both blobs fetched from the storage endpoint, Bearer the per-turn minted vault token.
    expect(blobCalls).toHaveLength(2);
    for (const c of blobCalls) {
      expect(c.url).toContain("/vault/default/api/storage/");
      expect(c.auth).toMatch(/^Bearer TOK-/);
    }

    // Both files staged into the PRIVATE session workspace's attachments/ subdir.
    const stagingDir = join(sessionsDir, "eng", ATTACHMENT_STAGING_DIR);
    expect(existsSync(join(stagingDir, "abc.png"))).toBe(true);
    expect(existsSync(join(stagingDir, "def.txt"))).toBe(true);
    expect(readFileSync(join(stagingDir, "abc.png"), "utf-8")).toBe("PNGBYTES");
    expect(readFileSync(join(stagingDir, "def.txt"), "utf-8")).toBe("hello world");

    // The staged paths are WITHIN the private workspace.
    expect(join(stagingDir, "abc.png").startsWith(join(sessionsDir, "eng"))).toBe(true);

    // The turn prompt (argv) carries the attachment pointer line with the staged
    // absolute paths + mime types, appended after the original message.
    const cmd = calls[0]!.argv[2]!;
    expect(cmd).toContain("Attached files");
    expect(cmd).toContain(join(stagingDir, "abc.png"));
    expect(cmd).toContain("image/png");
    expect(cmd).toContain(join(stagingDir, "def.txt"));
    expect(cmd).toContain("text/plain");
    expect(cmd).toContain("what is in these");
  });

  test("a malicious filename is staged as a SAFE basename inside the staging dir, never outside (security)", async () => {
    mkDirs("att-traversal");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("sess-T", "ok") });
    // The blob's STORAGE PATH (what we fetch) is benign; the FILENAME is the attack vector.
    const { fetchFn } = mintAndBlobFetch({ "2026-06-24/legit.bin": "EVILBYTES" });
    const backend = new ProgrammaticBackend(baseDeps(fn, { fetchFn }));
    const handle = await backend.start(specWithVault("eng"));

    const result = await backend.deliver(
      handle,
      "stage this",
      createSession("sess-T"),
      undefined,
      [att("2026-06-24/legit.bin", "application/octet-stream", "../../../../tmp/pwned.sh")],
    );
    expect(result.ok).toBe(true);

    const stagingDir = join(sessionsDir, "eng", ATTACHMENT_STAGING_DIR);
    // Landed INSIDE the staging dir under a sanitized basename, NOT at /tmp/pwned.sh.
    expect(existsSync(join(stagingDir, "pwned.sh"))).toBe(true);
    expect(existsSync("/tmp/pwned.sh")).toBe(false);
    const cmd = calls[0]!.argv[2]!;
    expect(cmd).toContain(join(stagingDir, "pwned.sh"));
    expect(cmd).not.toContain("/tmp/pwned.sh");
  });

  test("a malicious storage PATH (no separate filename) also sanitizes to a basename in the staging dir", async () => {
    mkDirs("att-pathtraversal");
    const { fn } = recordingSpawn({ stdout: successTurn("sess-P", "ok") });
    // The path the daemon hands us IS the attack; we fetch it verbatim but stage by basename.
    const traversal = "../../../../tmp/evil.sh";
    const { fetchFn } = mintAndBlobFetch({ [traversal]: "X" });
    const backend = new ProgrammaticBackend(baseDeps(fn, { fetchFn }));
    const handle = await backend.start(specWithVault("eng"));

    const result = await backend.deliver(handle, "x", createSession("sess-P"), undefined, [
      { path: traversal, mimeType: "text/plain", filename: traversal },
    ]);
    expect(result.ok).toBe(true);
    const stagingDir = join(sessionsDir, "eng", ATTACHMENT_STAGING_DIR);
    expect(existsSync(join(stagingDir, "evil.sh"))).toBe(true);
    expect(existsSync("/tmp/evil.sh")).toBe(false);
  });

  test("a single blob fetch failure is isolated — the other file stages + the turn runs", async () => {
    mkDirs("att-isolated");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("sess-I", "partial") });
    const { fetchFn } = mintAndBlobFetch({ "2026-06-24/good.png": "GOODBYTES" });
    const backend = new ProgrammaticBackend(baseDeps(fn, { fetchFn }));
    const handle = await backend.start(specWithVault("eng"));

    const result = await backend.deliver(
      handle,
      "two files",
      createSession("sess-I"),
      undefined,
      [att("2026-06-24/missing.png", "image/png"), att("2026-06-24/good.png", "image/png")],
    );
    expect(result.ok).toBe(true);

    const stagingDir = join(sessionsDir, "eng", ATTACHMENT_STAGING_DIR);
    expect(existsSync(join(stagingDir, "good.png"))).toBe(true);
    expect(existsSync(join(stagingDir, "missing.png"))).toBe(false);
    const cmd = calls[0]!.argv[2]!;
    expect(cmd).toContain(join(stagingDir, "good.png"));
    expect(cmd).not.toContain("missing.png");
  });

  test("NO attachments → identical behavior to today (no staging dir, no prompt change)", async () => {
    mkDirs("att-none");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("sess-N", "plain reply") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));

    const result = await backend.deliver(handle, "no files here", createSession("sess-N"));
    expect(result.ok).toBe(true);
    expect(existsSync(join(sessionsDir, "eng", ATTACHMENT_STAGING_DIR))).toBe(false);
    const cmd = calls[0]!.argv[2]!;
    expect(cmd).not.toContain("Attached files");
    expect(cmd).toContain("no files here");
  });

  test("an empty attachments array → no staging, no prompt change", async () => {
    mkDirs("att-empty");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("sess-E", "x") });
    const backend = new ProgrammaticBackend(baseDeps(fn));
    const handle = await backend.start(specWithVault("eng"));

    const result = await backend.deliver(handle, "hello", createSession("sess-E"), undefined, []);
    expect(result.ok).toBe(true);
    expect(existsSync(join(sessionsDir, "eng", ATTACHMENT_STAGING_DIR))).toBe(false);
    expect(calls[0]!.argv[2]!).not.toContain("Attached files");
  });

  test("caps the number of staged attachments at ATTACHMENT_MAX_COUNT", async () => {
    mkDirs("att-cap");
    const { fn } = recordingSpawn({ stdout: successTurn("sess-C", "ok") });
    // Build MAX_COUNT + 5 fetchable blobs + matching attachment refs.
    const blobs: Record<string, string> = {};
    const refs: InboundAttachment[] = [];
    const total = ATTACHMENT_MAX_COUNT + 5;
    for (let i = 0; i < total; i++) {
      const p = `2026-06-24/f${i}.bin`;
      blobs[p] = `B${i}`;
      refs.push(att(p, "application/octet-stream"));
    }
    const { fetchFn, blobCalls } = mintAndBlobFetch(blobs);
    const backend = new ProgrammaticBackend(baseDeps(fn, { fetchFn }));
    const handle = await backend.start(specWithVault("eng"));

    const result = await backend.deliver(handle, "many", createSession("sess-C"), undefined, refs);
    expect(result.ok).toBe(true);

    // Only the first MAX_COUNT were fetched + staged; the overflow was dropped.
    expect(blobCalls).toHaveLength(ATTACHMENT_MAX_COUNT);
    const stagingDir = join(sessionsDir, "eng", ATTACHMENT_STAGING_DIR);
    expect(existsSync(join(stagingDir, `f0.bin`))).toBe(true);
    expect(existsSync(join(stagingDir, `f${ATTACHMENT_MAX_COUNT - 1}.bin`))).toBe(true);
    expect(existsSync(join(stagingDir, `f${ATTACHMENT_MAX_COUNT}.bin`))).toBe(false);
  });

  test("an agent that binds NO vault → attachments skipped (no token to fetch), turn still runs", async () => {
    mkDirs("att-novault");
    const { fn, calls } = recordingSpawn({ stdout: successTurn("sess-V", "no vault reply") });
    // A fetch that 500s on any blob — proving we NEVER reach it (no vault → no fetch).
    const { fetchFn, blobCalls } = mintAndBlobFetch({});
    const backend = new ProgrammaticBackend(baseDeps(fn, { fetchFn }));
    // Spec with channels but NO vault binding.
    const handle = await backend.start({ name: "eng", channels: ["eng"] } as AgentSpec);

    const result = await backend.deliver(handle, "file but no vault", createSession("sess-V"), undefined, [
      att("2026-06-24/x.png", "image/png"),
    ]);
    expect(result.ok).toBe(true);
    // No blob fetched, no staging dir, no prompt pointer — the turn ran with text only.
    expect(blobCalls).toHaveLength(0);
    expect(existsSync(join(sessionsDir, "eng", ATTACHMENT_STAGING_DIR))).toBe(false);
    expect(calls[0]!.argv[2]!).not.toContain("Attached files");
  });

  test("all attachments failing → NO empty staging dir left behind", async () => {
    mkDirs("att-allfail");
    const { fn } = recordingSpawn({ stdout: successTurn("sess-F", "ok") });
    const { fetchFn } = mintAndBlobFetch({}); // every blob 404s
    const backend = new ProgrammaticBackend(baseDeps(fn, { fetchFn }));
    const handle = await backend.start(specWithVault("eng"));

    const result = await backend.deliver(handle, "all bad", createSession("sess-F"), undefined, [
      att("2026-06-24/a.png", "image/png"),
      att("2026-06-24/b.png", "image/png"),
    ]);
    expect(result.ok).toBe(true);
    // No file staged → the lazy mkdir never fired → no empty attachments/ dir.
    expect(existsSync(join(sessionsDir, "eng", ATTACHMENT_STAGING_DIR))).toBe(false);
  });
});
