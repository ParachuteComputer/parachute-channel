# Tier 2 — LLM-run end-to-end test

The headline test of the channel fabric. It exercises the **real** wake → act →
reply loop against a **real** interactive Claude Code session — the thing a
scripted unit test can't reach — and verifies the result two ways: deterministic
assertions **and** an LLM judge.

This realizes the "Tier 2" the [hub e2e harness](../../../parachute-hub/e2e/README.md)
deferred ("an LLM-driven runbook … separate, later"). Where hub's Tier 1 is the
deterministic regression net, this is the loop-closing integration test for a
module whose entire job is "a message goes in, a live session acts and replies."

## What it does

1. Boots the daemon with one `http-ui` channel (`e2e`), on a temp state dir + port.
2. Subscribes a browser-style UI SSE listener to that channel.
3. Launches a real interactive `claude` session in **tmux**, its bridge subscribed
   to the same channel (the exact setup PR 1.3's launcher scripts automate).
4. POSTs a message into the channel — as the built-in chat UI would.
5. Asserts the session woke and replied **through the channel**:
   - **positive control** — the bridge must actually connect (else the test is
     vacuous and fails loudly rather than passing on silence);
   - **deterministic** — the reply echoes a sentinel token (proves it's a genuine
     round-trip response to our message) and contains the expected answer;
   - **LLM judge** — a `claude -p` call scores the reply for semantic correctness.

Both the deterministic and the LLM checks must pass. Exit `0` on PASS, non-zero on FAIL.

## Running

```bash
bun run test:e2e          # from the repo root
# or
bun e2e/llm/run.ts
```

Requires `tmux` and the `claude` CLI on PATH.

**Auth.** The session-under-test is **interactive**, so it's covered by your Claude
subscription (this is the whole point — interactive sessions are unmetered, unlike
`claude -p`). The LLM **judge** uses `claude -p`: if `ANTHROPIC_API_KEY` is set it
runs in `--bare` mode (keyed — keeps judge spend off the subscription credit pool);
otherwise it uses your logged-in subscription. In CI (no interactive login), set
`ANTHROPIC_API_KEY`.

This is a **local / pre-merge gate**, not a blocking CI step — it spawns an
interactive TUI session, which CI environments generally can't. `bun test` (Tier 1)
is the CI gate; this is run before merging changes that touch the wake/transport path.

## Env knobs

| Var | Default | Meaning |
|---|---|---|
| `E2E_PORT` | `19471` | Daemon port for the run. |
| `E2E_KEEP` | — | `1` = skip teardown (keep tmux session + state dir for debugging). |
| `E2E_JUDGE_MODEL` | `claude-haiku-4-5-20251001` | Model for the LLM judge (fast/cheap). |
| `E2E_REPLY_TIMEOUT_MS` | `90000` | How long to wait for the session's reply. |

## Debugging a failure

Run with `E2E_KEEP=1`, then inspect:
- `tmux attach -t parachute-agent-e2e` — watch the live session.
- `/tmp/parachute-agent-e2e-<port>/daemon.log` — daemon output.
