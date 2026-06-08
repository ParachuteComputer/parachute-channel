#!/usr/bin/env bun
/**
 * Tier 2 — LLM-run end-to-end test for parachute-channel.
 *
 * This is the headline test of the channel fabric: it exercises the REAL
 * wake → act → reply loop against a REAL interactive Claude Code session, the
 * thing a scripted unit test can't reach. It realizes the "Tier 2" the hub e2e
 * README deferred ("an LLM-driven runbook … separate, later").
 *
 *   1. Boot the daemon with one http-ui channel ("e2e"), temp state dir + port.
 *   2. Subscribe a browser-style UI SSE listener to that channel.
 *   3. Launch a real interactive `claude` session in tmux, its bridge subscribed
 *      to the same channel (the same setup the launcher scripts will automate).
 *   4. POST a message into the channel (as the built-in UI would).
 *   5. Assert the session woke and replied THROUGH the channel — two ways:
 *        • deterministic (positive control + sentinel + expected content)
 *        • an LLM judge scoring semantic correctness
 *
 * Both must pass. Exit 0 on PASS, non-zero on FAIL.
 *
 * Auth: the session-under-test is interactive (subscription-covered). The LLM
 * judge uses `claude -p`; if ANTHROPIC_API_KEY is set it runs in --bare mode
 * (keyed, keeps judge spend off the subscription credit pool). Run from the repo
 * root: `bun e2e/llm/run.ts`. Env knobs: E2E_PORT, E2E_KEEP=1 (skip teardown),
 * E2E_JUDGE_MODEL (default haiku), E2E_REPLY_TIMEOUT_MS.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = parseInt(process.env.E2E_PORT ?? "19471", 10);
const BASE = `http://127.0.0.1:${PORT}`;
const CHANNEL = "e2e";
const SESSION = "parachute-channel-e2e";
const STATE_DIR = `/tmp/parachute-channel-e2e-${PORT}`;
const WORKDIR = join(STATE_DIR, "workdir");
const KEEP = process.env.E2E_KEEP === "1";
const JUDGE_MODEL = process.env.E2E_JUDGE_MODEL ?? "claude-haiku-4-5-20251001";
const REPLY_TIMEOUT_MS = parseInt(process.env.E2E_REPLY_TIMEOUT_MS ?? "90000", 10);

// A static sentinel the session must echo back — proves the reply is a genuine
// response to OUR message routed through the channel, not anything incidental.
const SENTINEL = "ACK-E2E-7Q3F";
const PROMPT =
  `You are connected to a test channel. Reply THROUGH the channel using the reply tool ` +
  `(your transcript text never reaches the sender). In your reply, put the exact token ${SENTINEL} ` +
  `first, then the capital city of France. Keep it to one short line. Reply only via the reply tool.`;

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[e2e] ${m}`);
const fail = (m: string): never => {
  console.error(`\n❌ FAIL: ${m}\n`);
  throw new Error(m);
};

function sh(cmd: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}
const tmux = (...args: string[]) => sh(["tmux", ...args]);
const pane = () => tmux("capture-pane", "-p", "-t", SESSION).stdout;

async function waitFor(desc: string, timeoutMs: number, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch {}
    await sleep(500);
  }
  fail(`timed out waiting for: ${desc}`);
}

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------
let daemon: ReturnType<typeof Bun.spawn> | undefined;
function teardown(): void {
  try { tmux("kill-session", "-t", SESSION); } catch {}
  try { daemon?.kill(); } catch {}
  if (!KEEP) { try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch {} }
  else log(`E2E_KEEP=1 — left state dir at ${STATE_DIR}`);
}

// ---------------------------------------------------------------------------
// UI SSE listener — collects `reply` frames the session sends back
// ---------------------------------------------------------------------------
const replies: { id: string; text: string }[] = [];
async function listenUi(signal: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}/ui/events?channel=${CHANNEL}`, { signal });
  if (!res.body) fail("UI SSE stream had no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
      else if (line === "") {
        if (event === "reply" && data) {
          try {
            const p = JSON.parse(data) as { id: string; text: string };
            replies.push({ id: p.id, text: p.text });
            log(`◀ reply received: ${JSON.stringify(p.text).slice(0, 120)}`);
          } catch (e) {
            log(`SSE reply frame parse error (ignored): ${String(e)} — raw: ${data.slice(0, 120)}`);
          }
        }
        event = ""; data = "";
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LLM judge
// ---------------------------------------------------------------------------
async function judge(question: string, reply: string): Promise<{ pass: boolean; reason: string }> {
  const keyed = !!process.env.ANTHROPIC_API_KEY;
  const judgePrompt =
    `A test harness sent this message to an AI session over a chat channel:\n---\n${question}\n---\n` +
    `The session replied through the channel with:\n---\n${reply}\n---\n` +
    `Did the session correctly receive that message and reply sensibly and on-topic ` +
    `(a reply that includes the requested token and correctly names Paris)? ` +
    `Respond with a single JSON object and nothing else: {"verdict":"PASS"|"FAIL","reason":"<short>"}.`;
  const cmd = ["claude", "-p", judgePrompt, "--model", JUDGE_MODEL, "--output-format", "json"];
  if (keyed) cmd.splice(2, 0, "--bare");
  log(`judging with ${JUDGE_MODEL}${keyed ? " (--bare, keyed)" : " (subscription)"} …`);
  const r = sh(cmd);
  if (r.code !== 0) fail(`judge invocation failed (code ${r.code}): ${r.stderr.slice(0, 400)}`);
  let resultText = r.stdout;
  try { resultText = (JSON.parse(r.stdout) as { result: string }).result; } catch {}
  const m = resultText.match(/\{[\s\S]*\}/);
  if (!m) fail(`judge produced no JSON verdict. raw: ${resultText.slice(0, 300)}`);
  const v = JSON.parse(m[0]) as { verdict: string; reason: string };
  return { pass: v.verdict.toUpperCase() === "PASS", reason: v.reason };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  log(`repo root: ${REPO_ROOT}`);
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(WORKDIR, { recursive: true });

  // 1. channel config + bridge mcp config
  writeFileSync(
    join(STATE_DIR, "channels.json"),
    JSON.stringify({ channels: [{ name: CHANNEL, transport: "http-ui" }] }, null, 2),
  );
  writeFileSync(
    join(WORKDIR, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          "parachute-channel": {
            command: "bun",
            args: [join(REPO_ROOT, "src", "bridge.ts")],
            env: { PARACHUTE_CHANNEL_URL: BASE, PARACHUTE_CHANNEL_NAME: CHANNEL },
          },
        },
      },
      null,
      2,
    ),
  );

  // 2. boot the daemon
  log(`booting daemon on ${BASE} (state ${STATE_DIR})`);
  daemon = Bun.spawn(["bun", join(REPO_ROOT, "src", "daemon.ts")], {
    env: { ...process.env, PARACHUTE_CHANNEL_STATE_DIR: STATE_DIR, PARACHUTE_CHANNEL_PORT: String(PORT) },
    stdout: Bun.file(join(STATE_DIR, "daemon.log")),
    stderr: Bun.file(join(STATE_DIR, "daemon.log")),
  });
  await waitFor("daemon /health ok", 15000, async () => (await fetch(`${BASE}/health`)).ok);
  log("daemon up");

  // 3. UI SSE listener
  const sseAbort = new AbortController();
  listenUi(sseAbort.signal).catch(() => {});

  // 4. launch the interactive session in tmux
  log("launching interactive claude session in tmux …");
  tmux("kill-session", "-t", SESSION);
  tmux(
    "new-session", "-d", "-s", SESSION, "-x", "220", "-y", "50",
    `cd ${WORKDIR} && exec claude --dangerously-load-development-channels=server:parachute-channel --dangerously-skip-permissions`,
  );

  // handle the one-time channels-dev-mode confirmation prompt. It renders a beat
  // AFTER launch, so poll for it rather than sleep-then-check-once (a fixed wait
  // races the prompt and leaves the session stuck, with no bridge ever spawning).
  let ackedDev = false;
  await waitFor("session ready (channel attached)", 30000, async () => {
    const p = pane();
    if (!ackedDev && /local development/i.test(p) && /Enter to confirm/i.test(p)) {
      log("accepting channels dev-mode prompt");
      tmux("send-keys", "-t", SESSION, "Enter");
      ackedDev = true;
      return false;
    }
    return /inject directly in this session/i.test(p);
  });

  // 5. positive control — the bridge must actually connect (else the test is vacuous)
  await waitFor("bridge to connect to the e2e channel", 45000, async () => {
    const h = (await (await fetch(`${BASE}/health`)).json()) as { channels: { name: string; clients: number }[] };
    return (h.channels.find((c) => c.name === CHANNEL)?.clients ?? 0) >= 1;
  });
  log("✓ positive control: bridge connected to the channel");

  // 6. send the message into the channel (as the built-in UI would)
  log(`▶ sending test message into channel "${CHANNEL}"`);
  const send = await fetch(`${BASE}/api/channels/${CHANNEL}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: PROMPT }),
  });
  if (!send.ok) fail(`send failed: ${send.status} ${await send.text()}`);

  // 7. wait for the session to wake and reply through the channel
  await waitFor("a reply from the session", REPLY_TIMEOUT_MS, async () => replies.length > 0);
  const reply = replies.map((r) => r.text).join("\n");
  sseAbort.abort();
  log(`session pane after reply:\n${pane().split("\n").filter(Boolean).slice(-6).join("\n")}`);

  // 8. deterministic assertions (Tier 1 within the e2e)
  if (!reply.includes(SENTINEL)) fail(`reply missing sentinel ${SENTINEL} — round-trip not proven. got: ${reply}`);
  if (!/paris/i.test(reply)) fail(`reply missing expected content "Paris". got: ${reply}`);
  log("✓ deterministic checks: sentinel echoed + correct content");

  // 9. LLM judge (Tier 2)
  const verdict = await judge(PROMPT, reply);
  if (!verdict.pass) fail(`LLM judge returned FAIL: ${verdict.reason}`);
  log(`✓ LLM judge: PASS — ${verdict.reason}`);

  console.log(`\n✅ PASS — full wake→act→reply loop verified end to end (deterministic + LLM-judged).\n`);
}

// Ctrl-C / kill during a long poll must still clean up the tmux session + daemon.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { log(`${sig} — tearing down`); teardown(); process.exit(130); });
}

main()
  .then(() => { teardown(); process.exit(0); })
  .catch((err) => { console.error(String(err?.message ?? err)); teardown(); process.exit(1); });
