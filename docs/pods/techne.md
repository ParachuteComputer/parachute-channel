# Techne pod — runbook

Long-lived Docker container hosting a Claude agent for the Techne / Regen Hub cooperative. Ships Bun, Claude Code CLI, `@openparachute/vault`, and `parachute-channel` (from git, pinned).

Image source: [`docker/pods/techne/`](../../docker/pods/techne). This runbook is the operational companion — the Dockerfile and entrypoint carry the how-it-boots; this page carries the day-two operations.

> **Status:** v1. First pod of its kind; expected to become the template for `unforced`, and others. When you find gaps in the runbook, fix them here.

## Design at a glance

| Concern | Choice |
|---|---|
| Base | `ubuntu:24.04` |
| Container user | `parachute` (uid 1000), non-root |
| PID 1 | `tini` → `entrypoint.sh` (supervises vault + channel) |
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

## Starting a Techne agent session — use `techne-claude`, not `claude`

Everyday Techne sessions must go through the wrapper:

```bash
docker exec -it techne techne-claude
```

The wrapper does four things `claude` alone won't:

1. `cd ~/techne` so `CLAUDE.md` is auto-loaded from the working directory.
2. Pass `--strict-mcp-config --mcp-config=~/techne/mcp.json` so the session sees **only** `parachute-vault` and `parachute-channel`. Without this, Claude Code inherits account-level MCP servers from Aaron's `claude.ai` account — including his personal Parachute vault, Gmail, Drive, etc. — which the Techne agent must not have access to.
3. Pass `--dangerously-load-development-channels=server:parachute-channel` (note the `=`). This flag opts the session into the experimental `claude/channel` MCP capability. Without it, the channel MCP registers its tools (`reply`, `react`, etc.) but Claude silently drops the bridge's `notifications/claude/channel` events — meaning inbound Telegram messages never reach the session. The flag is hidden from `claude --help`; its existence is documented in `parachute-channel/CLAUDE.md`. The `dangerously-` prefix is there because the flag bypasses Anthropic's curated channel-server allowlist — our self-named `parachute-channel` server is not on that list and so requires this opt-in. The `=` binding matters: space-separating the value (`--dangerously-load-development-channels server:parachute-channel`) works in `--print` mode because the trailing `--print <prompt>` terminates the parser's search for a value, but in interactive mode it lets `server:parachute-channel` be swallowed as the initial-prompt positional — leaving the flag with an empty channels list, which surfaces at runtime as `"no MCP server configured with that name"`.
4. Fail loudly if `~/techne/mcp.json` is missing (the pod's entrypoint writes it on first boot by minting a vault token; see "MCP provisioning" below).

`claude` without the wrapper is still useful for `claude mcp add`, `claude doctor`, interactive authentication, and similar admin work — but don't use it for Techne agent sessions.

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

## Everyday operations

| Task | Command |
|---|---|
| Tail logs | `docker logs -f techne` |
| Open a shell | `docker exec -it techne bash` |
| Start a Claude session inside | `docker exec -it techne bash -lc 'cd ~/techne && claude'` |
| Restart the container | `docker restart techne` |
| Stop the container | `docker stop techne` |
| Start after stop | `docker start techne` |
| Rotate the bot token | overwrite `~/.parachute/channel/.env` inside the container, then `docker restart techne` |
| Inspect vault data | `docker exec -it techne sqlite3 ~/.parachute/vaults/default/vault.db` |

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

## Future work: always-on Techne

Today, a Techne Claude session is a foreground process started by `docker exec -it techne techne-claude` from Aaron's laptop. Close the terminal and the agent is gone — Telegram messages that arrive with no session attached are broadcast to zero SSE clients and drop on the floor (the daemon has no persistent inbox for text). That's fine for smoke tests and supervised use; it won't do for an agent the cooperative can ping at any hour.

The image ships Bun + Claude Code + the wrapper, but nothing that keeps a session alive across disconnects. Paths to consider when we want always-on:

- **`tmux` inside the container.** Add `tmux` to the Dockerfile, have entrypoint launch `tmux new-session -d -s techne techne-claude`, and `docker exec -it techne tmux attach -t techne` to observe. Cheapest change; the session survives attach/detach and container restarts (via a small "resurrect on boot" hook). Downside: a crashed session silently stays crashed until someone attaches.
- **Supervisor-managed session.** Extend `entrypoint.sh` to run `techne-claude` as a third supervised process alongside vault + channel, restarting on exit. Clean in Docker terms; harder to attach to for interactive work, and Claude Code's TTY assumptions may fight headless execution.
- **Daemon-managed session via the Claude Agent SDK.** Skip the CLI entirely for the always-on role and drive a session programmatically (the SDK exposes the same MCP + channels surface). Most invasive, but lines up with how other pods are likely to run.

Parking this here so the next person picking it up has the shape. Don't build any of it until we've run Techne through a real cooperative task or two and learned what "always-on" actually needs to mean.

## Future pods

This runbook is the template. To spin up a second pod (`unforced`, etc.):

1. Copy `docker/pods/techne/` to `docker/pods/<name>/`.
2. Edit the in-container `CLAUDE.md` to describe that pod's identity and scope.
3. Rename the volumes (`<name>-data`, `<name>-claude`) and container name everywhere.
4. Duplicate this runbook at `docs/pods/<name>.md`, adjusting the differences.

Don't try to parameterize it yet — one copy is fine, the shape will settle after the second pod.
