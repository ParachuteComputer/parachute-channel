# Techne pod — runbook

Long-lived Docker container hosting a Claude agent for the Techne / Regen Hub cooperative. Ships Bun, Claude Code CLI, `@openparachute/vault`, and `parachute-channel` (from git, pinned).

Image source: [`docker/pods/techne/`](../../docker/pods/techne). This runbook is the operational companion — the Dockerfile and entrypoint carry the how-it-boots; this page carries the day-two operations.

> **Status:** v1. First pod of its kind; expected to become the template for `unforced`, and others. When you find gaps in the runbook, fix them here.

## Design at a glance

| Concern | Choice |
|---|---|
| Base | `ubuntu:24.04` |
| Container user | `parachute` (uid 1000), non-root |
| PID 1 | `tini` → `entrypoint.sh` (supervises vault + channel + always-on tmux session) |
| Vault auto-init | First run of `parachute vault serve` creates a default vault — no `vault init` needed |
| Channel install | Cloned from GitHub at a pinned commit (build-arg `CHANNEL_COMMIT`) |
| Ports exposed | None. Vault (1940) and channel (1941) bind inside the container; Telegram is outbound-only |
| Persistence | Two named volumes — `techne-data` for vault + channel state, `techne-claude` for Claude auth |
| Isolation | Namespace-isolated Docker container. No virtiofs. `/Users`, `/Applications`, `/Volumes` are not reachable |

## Build

```bash
cd parachute-channel
docker build -t techne:latest docker/pods/techne
```

Update the pinned channel commit by passing `--build-arg CHANNEL_COMMIT=<sha>`.

## First run

```bash
docker volume create techne-data
docker volume create techne-claude

docker run -d \
  --name techne \
  --restart unless-stopped \
  -v techne-data:/home/parachute/.parachute \
  -v techne-claude:/home/parachute/.claude \
  techne:latest

docker logs -f techne
```

Container is up. Vault auto-creates its default DB on first boot; channel sits idle logging `no TELEGRAM_BOT_TOKEN yet` until a token lands.

## Authenticate Claude (one-time, interactive)

```bash
docker exec -it techne bash -lc claude
```

Claude Code prints a URL; paste it into a browser, complete the sign-in, paste the code back into the container. Auth lands in the `techne-claude` volume and survives container restarts and rebuilds.

## How Techne runs — always-on via tmux

The pod's entrypoint starts a detached `tmux` session named `techne` running `/usr/local/bin/techne-claude-loop`. The loop runs `techne-claude` in a forever-restart loop with backoff, so a crash, rate-limit, network blip, or `/exit` doesn't take the agent offline — it spins back up within seconds. This is what keeps inbound Telegram messages reaching Claude when nobody is at the keyboard.

| Action | Command |
|---|---|
| Attach to the agent session | `docker exec -it techne tmux attach -t techne` |
| Detach **without killing it** | `Ctrl+B` then `d` |
| Kick the loop | `docker exec techne tmux kill-session -t techne` (entrypoint recreates within ~5s) |
| Tail the agent's pane log | `docker exec techne tail -f /home/parachute/.techne-logs/loop.log` |
| Daemon health | `docker exec techne curl -s http://127.0.0.1:1941/health` |

**Don't start a second `techne-claude` outside the tmux session.** Each Claude session spawns its own `bridge.ts`, both bridges subscribe to the daemon's SSE stream, and every inbound message gets handled twice — including double replies. If you need to run something interactively, attach to the existing session.

When you attach, you see the live conversation. Type to talk to the agent — the same as a regular `claude` session. Detach with `Ctrl+B` then `d` when done; the session keeps running. Don't `Ctrl+D` (that exits Claude, the loop will restart it but you've also blown away the conversation context).

Conversation context lives only inside one Claude run. When the loop restarts the session — whether by your `/exit` or a crash — the new run starts with no in-memory history. **The vault is the persistent memory layer.** Anything Techne should remember across restarts has to be written there.

If the loop hits `MAX_FAST_FAILS` consecutive sub-30-second exits in a row (i.e. Claude can't get off the ground), it posts a Telegram message to the pod owner via the channel daemon's `/api/reply`, then sleeps at the cap to avoid spamming. Owner is `TECHNE_OWNER_CHAT_ID` in the loop (defaults to Aaron's UID `1190596288`).

### Wrapper details

`techne-claude` (what the loop runs) does four things `claude` alone won't:

1. `cd ~/techne` so `CLAUDE.md` is auto-loaded from the working directory.
2. Pass `--strict-mcp-config --mcp-config=~/techne/mcp.json` so the session sees **only** `parachute-vault` and `parachute-channel`. Without this, Claude Code inherits account-level MCP servers from Aaron's `claude.ai` account — including his personal Parachute vault, Gmail, Drive, etc. — which the Techne agent must not have access to.
3. Pass `--dangerously-load-development-channels=server:parachute-channel` (note the `=`). This flag opts the session into the experimental `claude/channel` MCP capability. Without it, the channel MCP registers its tools (`reply`, `react`, etc.) but Claude silently drops the bridge's `notifications/claude/channel` events — meaning inbound Telegram messages never reach the session. The flag is hidden from `claude --help`; its existence is documented in `parachute-channel/CLAUDE.md`. The `dangerously-` prefix is there because the flag bypasses Anthropic's curated channel-server allowlist — our self-named `parachute-channel` server is not on that list and so requires this opt-in. The `=` binding matters: space-separating the value (`--dangerously-load-development-channels server:parachute-channel`) works in `--print` mode because the trailing `--print <prompt>` terminates the parser's search for a value, but in interactive mode it lets `server:parachute-channel` be swallowed as the initial-prompt positional — leaving the flag with an empty channels list, which surfaces at runtime as `"no MCP server configured with that name"`.
4. Fail loudly if `~/techne/mcp.json` is missing (the pod's entrypoint writes it on first boot by minting a vault token; see "MCP provisioning" below).

`claude` without the wrapper is still useful for `claude mcp add`, `claude doctor`, interactive authentication, and similar admin work — but don't use it for Techne agent sessions.

### First-run order matters

The tmux loop expects Claude to already be authenticated; if `~/.claude` is empty, Claude prints an OAuth URL and waits for you to paste a code. Inside the tmux pane with no client attached, that wait is invisible — the loop appears stuck. Always do the one-time `docker exec -it techne bash -lc claude` *before* relying on the always-on session. Once auth lands in the `techne-claude` volume, the loop's restarts pick it up automatically.

## MCP provisioning

On every container boot, `entrypoint.sh` checks for `~/techne/mcp.json`. If it's missing (first boot, or post-rebuild), the entrypoint:

1. Waits for the vault server to come up healthy.
2. Mints a fresh bearer token with `parachute vault tokens create`.
3. Writes a 0600 JSON file listing `parachute-vault` (HTTP to `127.0.0.1:1940`) and `parachute-channel` (stdio-spawning the bridge) — with the minted token baked in.

The file lives in the image layer (not the volume), so rebuilds trigger re-provisioning. Old tokens pile up in `vault.db` until pruned with `parachute vault tokens revoke <id>`.

## Provide the Telegram bot token

Aaron creates the bot via [@BotFather](https://t.me/BotFather) — get a token like `123456789:AAH...`.

Two ways to hand it over:

**A — persist to the volume (recommended once you have a token):**

```bash
docker exec -it techne bash -lc \
  'printf "TELEGRAM_BOT_TOKEN=%s\n" "PASTE_TOKEN_HERE" > ~/.parachute/channel/.env && chmod 600 ~/.parachute/channel/.env'
docker restart techne
```

**B — inject via env var at run time** (useful for the very first `docker run`):

```bash
docker run -d --name techne --restart unless-stopped \
  -v techne-data:/home/parachute/.parachute \
  -v techne-claude:/home/parachute/.claude \
  -e TELEGRAM_BOT_TOKEN=PASTE_TOKEN_HERE \
  techne:latest
```

The entrypoint writes injected tokens to `~/.parachute/channel/.env` on first boot, so the `-e` flag becomes optional after.

## Adding the bot to a Telegram group

1. In Telegram, create a group (or use an existing one).
2. Add your bot by username, then promote it to admin if you want it to see all messages (Telegram's privacy mode otherwise limits bots to commands + @-mentions).
3. Send a test message in the group. `docker logs -f techne` should show the daemon receiving it.

## End-to-end smoke test

After a fresh build + run + Claude auth + bot-token + group setup:

1. `docker exec -it techne tmux attach -t techne` — drops you into the live always-on Claude session. You should see the agent's prompt, possibly mid-conversation if anything has come in. Detach immediately with `Ctrl+B` then `d`.
2. From Telegram, DM the bot (or @-mention it in the group). A `<channel …>` tag should land in the agent's pane within a couple of seconds — *without* you having launched `techne-claude` manually first. The agent's reply should round-trip back into Telegram.
3. `docker exec techne tail -n 5 /home/parachute/.techne-logs/loop.log` — should show `[techne-loop ...] starting techne-claude (fast-fails: 0)` and nothing alarming.

If step 2 fails: see "How Techne runs" → first-run order. The most common cause is forgetting the one-time `claude` auth step, which leaves the loop blocked at the OAuth prompt.

## Everyday operations

| Task | Command |
|---|---|
| Attach to the live agent | `docker exec -it techne tmux attach -t techne` |
| Detach from agent | `Ctrl+B` then `d` |
| Tail container logs | `docker logs -f techne` |
| Tail agent pane log | `docker exec techne tail -f /home/parachute/.techne-logs/loop.log` |
| Open a shell | `docker exec -it techne bash` |
| Run an admin Claude session | `docker exec -it techne bash -lc 'cd ~/techne && claude'` (see warning above — don't do this while the always-on session is running) |
| Restart the container | `docker restart techne` |
| Stop the container | `docker stop techne` |
| Start after stop | `docker start techne` |
| Force the agent loop to restart | `docker exec techne tmux kill-session -t techne` (entrypoint recreates within ~5s) |
| Rotate the bot token | overwrite `~/.parachute/channel/.env` inside the container, then `docker restart techne` |
| Inspect vault data | `docker exec -it techne sqlite3 ~/.parachute/vaults/default/vault.db` |
| Daemon health | `docker exec techne curl -s http://127.0.0.1:1941/health` |

## Known historical log events

- **2026-04-18 — bot-token rotation during standup.** Around this timestamp you'll see a run of `getUpdates 401: Unauthorized` from `parachute-channel`, followed by `[techne] signal received; shutting down` and a clean restart. Expected: the Telegram token was rotated and the container bounced. Not an incident.

## Back up the vault

The whole `techne-data` volume is one tar away from a backup:

```bash
docker run --rm -v techne-data:/data -v "$PWD":/backup ubuntu:24.04 \
  tar -czf /backup/techne-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /data .
```

Restore is the reverse, into a fresh empty volume.

## Rebuild from scratch

```bash
docker stop techne && docker rm techne
docker rmi techne:latest
# techne-data and techne-claude are left intact; the rebuilt container picks them up.
docker build -t techne:latest docker/pods/techne
# Re-run — same `docker run` as above.
```

### Known rebuild papercuts (monthly-restart checklist)

The `techne-claude` volume preserves the auth directory, but in practice each rebuild so far has required manual hand-holding. Known items, tracked here so the next rebuild is a better experience than the last:

- **Theme picker fires on every rebuild.** `~/.claude/settings.json` in the volume is `{}` (3 bytes), so the theme preference doesn't persist across Claude Code auto-updates. Workaround today: `docker exec techne tmux send-keys -t techne Enter` to accept the default. **Fix direction:** bake a default `settings.json` (with `"theme": "dark"` and maybe a pinned version preference) into the image at `/home/parachute/.claude/settings.json`, owned by `parachute:parachute`. Would need to merge-not-overwrite on container start so Aaron's customisations survive if he sets them.
- **Claude OAuth did not survive 2026-04-22 rebuild.** The volume kept `.credentials.json` (471 bytes, same mtime) but the post-rebuild Claude Code asked for login method anyway. Cause not yet pinned down — candidates: Claude Code version bump invalidating the token format, token TTL expiring between OAuth and rebuild, or a missing env var in the new container. **Fix direction:** reproduce on a second rebuild, capture Claude Code's stderr the moment it rejects the existing credentials, and either (a) bake the right env vars into the image or (b) document "re-OAuth is expected after rebuild" clearly so it stops being a surprise.
- **Unknown-group auto-leave hook.** When someone adds the bot to a chat not listed in `allowInChats`, the daemon drops messages but the bot remains a silent member. Nice-to-have: on `new_chat_members` where the added member is the bot, check the chat_id against `allowInChats` and call `leaveChat` if it's not listed. Not shipped yet — filed here so we revisit post-launch stability.

These aren't blockers, just rough edges. Tackle as a batch when someone has time.

Full reset (destroys vault + Claude auth — Aaron will need to re-auth and the community loses notes):

```bash
docker stop techne && docker rm techne
docker volume rm techne-data techne-claude
```

## Verifying host isolation

Proof that no host filesystem is reachable from inside the container:

```bash
docker exec techne ls /Users
# → ls: cannot access '/Users': No such file or directory
```

Run this after any image change and paste the output in the relevant PR.

## Future work

Always-on now ships (see "How Techne runs" above). Things still parked:

- **Periodic restart for context drift.** A long-running Claude session accumulates context window and can drift in personality or recall over days. The loop today restarts only on exit; consider a soft restart every N hours (or every N inbound messages) once we have data on what "too long" looks like in practice.
- **Drift / health observability beyond pane log.** Today the only liveness signals are `/health` (channel daemon perspective) and tail of the pane log. A periodic synthetic ping ("agent, reply with `pong`") via the channel would prove end-to-end that Claude is processing, not just that the process is alive.
- **Bounded loop log.** `~/.techne-logs/loop.log` grows unbounded. Rotate or cap it.
- **Multi-pane tmux** (e.g. one pane for the agent, one for daemon logs) so an attached operator sees both at once. Marginal value, no urgency.
- **Daemon-managed session via the Claude Agent SDK.** A more invasive alternative to the tmux+CLI stack; probably the right shape if/when we move beyond one pod and want richer programmatic control. Not on the critical path.

## Future pods

This runbook is the template. To spin up a second pod (`unforced`, etc.):

1. Copy `docker/pods/techne/` to `docker/pods/<name>/`.
2. Edit the in-container `CLAUDE.md` to describe that pod's identity and scope.
3. Rename the volumes (`<name>-data`, `<name>-claude`) and container name everywhere.
4. Duplicate this runbook at `docs/pods/<name>.md`, adjusting the differences.

Don't try to parameterize it yet — one copy is fine, the shape will settle after the second pod.
