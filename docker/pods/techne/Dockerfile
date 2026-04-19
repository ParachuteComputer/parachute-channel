# syntax=docker/dockerfile:1.6
#
# Techne pod — long-lived Docker container hosting a Claude agent for the
# Techne / Regen Hub cooperative. Ships: Bun, Claude Code CLI, @openparachute/vault,
# and parachute-channel (from git, pinned). True namespace isolation; no virtiofs
# host mounts, no exposed ports, state persists via named volumes.
#
# Build:   docker build -t techne:latest docker/pods/techne
# Run:     see docs/pods/techne.md
FROM ubuntu:24.04

# Pin parachute-channel to a known commit. Bump + rebuild to adopt channel changes.
ARG CHANNEL_COMMIT=6697c3569f370ad0596745cfcc76d99dd6f96896

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# System packages + Node.js 22 (Claude Code CLI is a Node app; Bun runs vault/channel).
# tini: PID 1 signal-forwarding so docker stop is clean.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        tini \
        unzip \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Non-root user at uid 1000. ubuntu:24.04 ships a default `ubuntu` user there;
# remove it first so our `parachute` user can take the conventional slot.
RUN userdel -r ubuntu 2>/dev/null || true \
 && useradd --create-home --shell /bin/bash --uid 1000 parachute \
 && mkdir -p /opt/parachute-channel \
 && chown parachute:parachute /opt/parachute-channel

# Claude Code CLI — install via npm while still root so /usr/local is writable.
RUN npm install -g @anthropic-ai/claude-code

USER parachute
WORKDIR /home/parachute

ENV HOME=/home/parachute \
    BUN_INSTALL=/home/parachute/.bun \
    PATH=/home/parachute/.bun/bin:/usr/local/bin:/usr/bin:/bin \
    PARACHUTE_HOME=/home/parachute/.parachute

# Pre-create the volume mount points owned by parachute. Docker named volumes
# inherit the ownership of the image's directory contents on first mount, so
# seeding these as parachute:parachute avoids the root-owned-volume EACCES trap.
RUN mkdir -p /home/parachute/.parachute/channel /home/parachute/.claude

# Bun (user-local).
RUN curl -fsSL https://bun.sh/install | bash

# Parachute Vault via bun (bun-native package).
RUN bun add -g @openparachute/vault

# parachute-channel at a pinned commit.
RUN git clone https://github.com/ParachuteComputer/parachute-channel /opt/parachute-channel \
 && cd /opt/parachute-channel \
 && git checkout ${CHANNEL_COMMIT} \
 && bun install --frozen-lockfile

# Agent identity doc (Techne CLAUDE.md) + supervisor entrypoint + the
# `techne-claude` wrapper that enforces strict MCP scoping. Without the
# wrapper, the Claude Code inside this container would inherit account-
# level MCP servers from Aaron's claude.ai account (personal Parachute,
# Gmail, Drive, etc.); the wrapper passes --strict-mcp-config + a local
# mcp.json so the Techne session sees only vault + channel.
COPY --chown=parachute:parachute techne-CLAUDE.md /home/parachute/techne/CLAUDE.md
COPY --chown=parachute:parachute entrypoint.sh /home/parachute/entrypoint.sh
RUN chmod +x /home/parachute/entrypoint.sh \
 && ln -sf techne/CLAUDE.md /home/parachute/CLAUDE.md

USER root
COPY techne-claude /usr/local/bin/techne-claude
RUN chmod +x /usr/local/bin/techne-claude
USER parachute

# Persistence (see docs/pods/techne.md):
#   /home/parachute/.parachute  ← techne-data volume   (vault DBs + channel state)
#   /home/parachute/.claude     ← techne-claude volume (Claude Code auth tokens)
#
# No EXPOSE: vault (1940) and channel (1941) bind inside the container only.
# Telegram is reached via outbound HTTPS.

ENTRYPOINT ["/usr/bin/tini", "--", "/home/parachute/entrypoint.sh"]
CMD []
