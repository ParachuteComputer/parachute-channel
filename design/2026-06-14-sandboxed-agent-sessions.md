---
title: "Sandboxed agent sessions + in-page terminal + full-tier deploy (channel)"
description: "Channel's deferred hardening (PLAN.md:153) made real: an isolation envelope around resident Claude sessions, a spawn/scope command graduating launch-session.sh, an in-page xterm.js terminal over the hub WS bridge, and a VPS cloud-init path so the full tier runs on a real host."
---
# Sandboxed agent sessions + in-page terminal + full-tier deploy

**Date:** 2026-06-14
**Status:** Proposed. Scopes channel's PLAN.md Stage-1 "Future: VM/Docker session isolation" line (`PLAN.md:153`) into a concrete build, plus two adjacent deliverables Aaron prioritized on 2026-06-14: an in-page terminal and a real-host deploy path. Not greenlit to build; this settles the shape.

**Companions:**
- [`../PLAN.md`](../PLAN.md) — the channel fabric plan; line 153 is the deferred step this doc fills in
- [`../CLAUDE.md`](../CLAUDE.md) — Sessions section (the resident-session model + the "full machine access" caveat this doc closes)
- [`../../parachute-runner/src/spawn.ts`](../../parachute-runner/src/spawn.ts) + [`mcp-config.ts`](../../parachute-runner/src/mcp-config.ts) — the spawn/scope reference (env scrub, inline strict MCP config)
- [`../../parachute-hub/src/ws-bridge.ts`](../../parachute-hub/src/ws-bridge.ts), [`ws-connection-caps.ts`](../../parachute-hub/src/ws-connection-caps.ts), [`audience-gate.ts`](../../parachute-hub/src/audience-gate.ts) — the terminal transport + its backpressure ceiling + the audience tier
- [`../../parachute-patterns/patterns/trust-gradient-isolation.md`](../../parachute-patterns/patterns/trust-gradient-isolation.md) — the governing pattern
- [`../../parachute-agent/DEPRECATED.md`](../../parachute-agent/DEPRECATED.md) — the machinery to NOT rebuild
- Anthropic, *How we contain Claude* — <https://www.anthropic.com/engineering/how-we-contain-claude> — and the open-sourced runtime <https://github.com/anthropic-experimental/sandbox-runtime> (Seatbelt / bubblewrap)
- Vault research note `Work/agents-surface-research` (parachute-parachute, id `2026-06-14-03-07-02-080372`) — the full synthesis behind this doc

---

## 1. Context + thesis

Channel **already runs this use case**. `scripts/launch-session.sh` spins up an interactive `claude` process inside a tmux session (`tmux new-session -d -s <name>-agent … exec claude …`), wires it to a named channel over HTTP MCP, and `tmux attach -t <name>-agent` is the documented way to zoom into the live terminal (`scripts/launch-session.sh:130-131`, `:168`). The channel-message transport is bolted on separately as the `/mcp/<channel>` endpoint that pushes the idle-wake `notifications/claude/channel` onto the session (`src/mcp-http.ts:133-155`). So the session is **both** a real terminal (tmux) and a message in/out pipe (MCP), cleanly separable.

What it does **not** have is an isolation boundary. The launcher runs `claude --dangerously-skip-permissions` (`launch-session.sh:131`), and `CLAUDE.md` says so plainly: *"the session has full machine access. Acceptable for an owner-operated, trusted-network box today; … VM/Docker session isolation (for the session itself) are the planned hardening steps."* `PLAN.md:153` records the same as the one unbuilt Stage-1 item. **This work is that step.**

Three framing points that bound the whole design:

- **Not a new module, not a revival of parachute-agent.** This is channel's own deferred hardening. parachute-agent (`DEPRECATED.md`) is the cautionary tale, not the template — we harvest its *envelope* (per-session isolation, RO mounts, injected scoped token, resource + network limits) and explicitly drop its *machinery* (per-agent image builds, `INSTALL_SLUG`-keyed names that became the reaper scar, a second supervisor). Octopus is superseded the same way: harvest its pod registry, roster↔live reconciliation, send-keys + key-allowlist, and cross-team failure-mode catalog; do not lift its spawn path (it wraps Claude Code's fragile native team/tentacle apparatus) or its capture-pane scraping. Octopus gets a `DEPRECATED.md`. **Note the name collision:** retiring octopus-*the-module* (its fragile native-team spawn path) is precisely what *enables* octopus-*the-pattern* — one arm spawning its own scoped sub-arms — delivered cleanly through Phase 2's attenuated MCP spawn-face (§8) rather than the native apparatus. The idea lives on; only the brittle implementation retires.

- **The billing/ToS model is "interactive Claude + a channel attached."** A launched session is a *full interactive* `claude` (it's `claude`, not `claude -p`), which runs on the operator's normal subscription limits — exactly the shape channel was built around (`PLAN.md:16-24`). It is **not** the metered headless `claude -p` / Agent-SDK credit path that runner uses. The credential story therefore draws on the normal interactive subscription; the real remaining constraint is **capacity** (agents share the operator's interactive quota), not ToS or a capped budget. See §6.

- **The trust gradient now warrants isolation — by the same pattern that retired agent.** `trust-gradient-isolation.md` retired parachute-agent for over-isolating a *flat* gradient (owner at keyboard, owner-written prompts). This use case moves the levers toward the steep end: web-exposed, channel-fed *foreign-authored* input ("when you don't trust the prompts" is the pattern's literal trigger), and `--dangerously-skip-permissions` means a prompt-injected session can do anything the host user can. That's the end the pattern reserves isolation for. The pattern's nuance — *match the mechanism to the gradient* — is what §3 applies: an OS sandbox for the owner-operated desktop tier, escalating to VM/gVisor only for the genuinely-untrusted multi-tenant tier.

---

## 2. The three layers

The system decomposes into three layers, two of which already largely exist in channel/runner/hub. Keeping them named and separate is the architecture.

| Layer | What it bounds | Status today | This doc adds |
|---|---|---|---|
| **Transport / control** | how an operator drives + watches a session | channel UI (`src/admin-ui.ts`, `transports/http-ui.ts`) + hub WS bridge (`ws-bridge.ts`) exist; SSE chat exists, no terminal | the in-page xterm.js terminal over the WS bridge (§5) |
| **Scope** | which vault / channel / MCP a session may touch | the token + strict-MCP machinery exists (channel `src/auth.ts`, runner `spawn.ts` + `mcp-config.ts`) | a ~115-line composer that graduates `launch-session.sh` into a command/API (§4) |
| **Isolation** | which filesystem / shell / host a session may touch | **nothing** — `--dangerously-skip-permissions`, full host access | the new envelope (§3) |

**Scope and isolation are orthogonal and both required.** Scope bounds what the session can reach *over the network as an authenticated principal* (vault read/write, which channels). Isolation bounds what the session can reach *as a local process* (the filesystem, other processes, arbitrary network egress, the host control plane). A perfectly-scoped token does nothing to stop `rm -rf ~` or an outbound exfiltration request; a perfect sandbox does nothing to stop a write to a vault the token shouldn't touch. The current launcher has scope (the minted `channel:read channel:write` token, `launch-session.sh:67`) but no isolation. This doc completes the pair.

---

## 3. The isolation envelope (the heart)

### 3.1 A `Sandbox` abstraction: contract constant, mechanism per-platform

Define a `Sandbox` interface whose **contract is held constant** and whose **mechanism varies by platform/tier**. The contract a launched session must satisfy, regardless of mechanism:

1. **Scoped token injected** at launch (the per-channel credential, §6) — never the operator's broad env, never the hub master key. This mirrors runner's `buildChildEnv` discipline (`spawn.ts:103-149`): pass only what `claude` needs, scrub everything else.
2. **Filesystem: reads and writes both scoped to declared binds.** Writes are confined to the private per-session workspace (today `~/.parachute/channel/sessions/<name>`, `launch-session.sh:37`) plus any `rw` mount the spec declares; *reads* are confined to the runtime/config, the workspace, and declared `ro`/`rw` mounts — **not** the broad host filesystem. This deliberately tightens Anthropic's "reads allowed" default; the reasoning + the `mounts` field are in §4.5.
3. **Network egress: deny by default + an allowlist.** The deny-by-default is constant; the allowlist is a minimal base of `{ the Anthropic API, the hub/vault origin }` plus a per-arm `egress` declaration (§4.4). This is **the load-bearing control** (§3.3).
4. **Resource limits** — memory/CPU caps so one session can't starve the host (each interactive Claude session can spike 1–2 GB under build load; see §7 sizing).
5. **No host escape** — the session cannot reach the host control plane (the hub's operator token, other sessions' workspaces, the Docker socket if one exists).

The mechanism is a per-platform backend behind this contract. v1 ships one backend (§3.2); the escalation rung (§3.4) is a second backend added later without touching callers.

### 3.2 v1 mechanism: Anthropic's sandbox-runtime (Seatbelt / bubblewrap)

**Adopt `github.com/anthropic-experimental/sandbox-runtime`** — OS-level sandboxing via **Seatbelt on macOS** and **bubblewrap on Linux** — rather than hand-rolling container orchestration. This is a direct application of three findings from Anthropic's *How we contain Claude*:

- **It's what Anthropic runs for Claude Code itself.** Their developer-tier threat model (a technical user who reads the bash before it runs) is satisfied by an OS sandbox, not a full VM — lower latency, sufficient isolation. Our owner-operated desktop tier is that same threat model.
- **"Match isolation to oversight capacity."** Their explicit principle: Claude Code (technical operator) → OS sandbox; Claude for non-technical users → full VM. Maps exactly onto our tiers — owner-operated desktop → OS sandbox; web/API-triggered/multi-tenant → escalate (§3.4).
- **"Be wary of custom components."** Use battle-tested primitives. Seatbelt and bubblewrap are OS-shipped and audited; the runtime is open-source and adoptable. This is the clean answer to what parachute-agent got wrong (bespoke Docker-image-per-project lifecycle, slug-keyed names, a second supervisor — all `DEPRECATED.md`).

A bonus consequence for the deploy story (§7): bubblewrap is **user-namespace** based — it needs no root Docker daemon. The full tier becomes "a plain Linux box with the runtime," not "a box with a privileged Docker socket." This collapses the cross-platform-Docker problem the earlier synthesis worried about: Seatbelt/bubblewrap *is* the cross-platform answer across both our targets (Aaron's Mac + a Linux VPS).

### 3.3 Network egress is the load-bearing control

Per the article: *"every function reachable through any allowlisted domain is an attack surface."* Filesystem confinement matters, but for a session fed foreign-authored channel input the dominant risk is **egress** — exfiltration to an attacker endpoint, SSRF against the host's own control plane, or fetching attacker-supplied credentials. So:

- **Deny all egress by default.** The allowlist is a minimal base of `{ Anthropic API host(s), the hub/vault origin }` — what every arm needs — plus a per-arm `egress` declaration treated as part of scope (§4.4). A weaver arm runs on the base alone; a code-building arm opens exactly the package/source hosts it needs. There is no single global allowlist to get wrong.
- **Ideally validate via a token-checking egress proxy** (the article's MITM-proxy pattern): the proxy admits only allowlisted domains and can verify the session token on the hub/vault leg, blocking both SSRF and attacker-supplied creds. v1 may start with a static domain allowlist enforced by the sandbox profile and graduate to the validating proxy; the proxy is the stronger posture for the multi-tenant tier (§3.4).
- **The hub already has the IP-level admission half** for the terminal WS — `ws-connection-caps.ts` (per-IP 32 / total 512, env-overridable). That bounds *inbound* terminal connections; the egress allowlist bounds *outbound* session traffic. Different directions, both needed.

### 3.4 The escalation rung (explicitly NOT v1)

For the genuinely-untrusted / multi-tenant tier, escalate the mechanism behind the same `Sandbox` contract: **gVisor or a full VM (or Docker-per-session)**. This is where parachute-agent's container ideas are load-bearing rather than ceremonial — and where `trust-gradient-isolation.md` says the cost is justified. Reserved for §8 Phase 3. v1 does not build it; the abstraction just leaves room for it.

### 3.5 Article principles we already practice

The article validates instincts already shipped in the ecosystem — worth naming so the design carries them deliberately:

- **Resolve symlinks before validating paths** — already the shape of the vault's `lstatSync` path-safety fold. The sandbox workspace confinement must do the same so a symlink can't escape the write-confined workspace.
- **Session-scoped, short-lived, revocable credentials** — already the shape of the scoped-token composer (§4). The injected token should be ephemeral by default and revoked on session death.
- **Defer parsing untrusted config until after the trust boundary** — already the shape of channel's parse-after-auth patterns. Inbound channel content reaches the session only after the scope/auth gates have run.

---

## 4. Spawn / scope

Graduate `launch-session.sh` into a proper command/API. The script is already ~80% of the composer — it mints a token, builds an MCP config, and launches `claude` in tmux. The graduation adds multi-resource scope and the sandbox launch.

### 4.1 The agent spec

A launch is described by an **agent spec**. The spec is the single declaration of *everything an arm may reach* — its MCP surface (channels/vault/otherMcps), its **network egress**, and its **filesystem view** — so scope and isolation are read off one object:

```jsonc
{
  "channels": ["aaron-dev"],                 // channels to attach (one MCP entry each)
  "vault":    { "name": "default", "access": "read", "tags": ["#channel-message"] },
  "otherMcps": [ /* additional MCP servers, by URL */ ],
  "credential": "operator",                  // which stored Claude token to inject (§6); default = operator

  // Network: ADDITIVE to a minimal base of { Anthropic API, the hub/vault origin }.
  // A weaver-style arm declares [] (base only); a code-building arm opens what it needs.
  "egress": ["registry.npmjs.org", "pypi.org", "github.com"],

  // Filesystem: ADDITIVE to the default private per-session workspace (rw) + the
  // implicit runtime/claude-config (ro). Reads are scoped to declared binds — NOT broad.
  "mounts": [
    { "hostPath": "/home/op/projects/foo", "mountPath": "/work/foo", "mode": "rw" },
    { "hostPath": "/home/op/ref",           "mountPath": "/ref",      "mode": "ro" },
    { "hostPath": "/srv/shared-artifacts",  "mountPath": "/shared",   "mode": "ro", "shared": "build-cache" }
  ]
}
```

`egress` and `mounts` are the two fields that make this spec a complete least-privilege envelope (detailed in §4.4 and §4.5). The base egress + the implicit runtime/config mount are non-removable; the spec only *adds*.

### 4.2 From spec to a running sandboxed session

1. **Mint one scoped token per resource.** A hub-issued JWT's `aud` is single-valued, so each channel and the vault get their *own* token: `channel:read channel:write` for each channel (the launcher already mints this, `launch-session.sh:67`), and `vault:<name>:<access>` (optionally tag-scoped) for the vault. Tokens are **ephemeral by default** (short TTL) for one-shot helpers, or a **registered connection** for standing agents that must survive restarts. **Revoke on session death.**
2. **Build the multi-entry strict MCP config.** Extend the single-entry shape (`launch-session.sh:88-112`, runner's `buildMcpConfigJson` at `mcp-config.ts:30-44`) into one `mcpServers` object carrying every channel's `/mcp/<channel>` entry plus the vault's `/vault/<name>/mcp` entry, each with its own Bearer. Launch with `--strict-mcp-config` so the session sees *only* these servers (runner's `buildClaudeArgs`, `spawn.ts:66-82`) — the MCP surface is closed to exactly the spec.
3. **Launch the sandboxed `claude` in tmux.** Same tmux launch as today, but the `claude` process runs *inside* the `Sandbox` (§3) with the scrubbed env + injected token + write-confined workspace + egress allowlist.

### 4.3 Capability attenuation bounds the spawn-manager

The composer **can't grant more than it holds.** It mints child tokens by attenuating its own grant — a spawn-manager holding `vault:default:read` cannot mint a child `vault:default:write`. This is the same least-privilege instinct `audience-gate.ts:129-155` encodes for scope matching, applied at mint time. It's what makes the future API/MCP spawn face (§8 Phase 2) safe: a remote caller can only spawn agents weaker than the principal it authenticated as.

### 4.4 Network egress is part of scope, declared per-arm

The Sandbox **contract** stays constant — egress is *deny-by-default* for every arm (§3.1, §3.3). What becomes per-arm is the **allowlist**, declared as the spec's `egress` field and unioned with a minimal non-removable base of `{ the Anthropic API, the hub/vault origin }`. This reframes egress from a single global policy into a dimension of **scope**: just as the MCP/token fields say *which vault and channels* an arm may reach, `egress` says *which other hosts* it may reach.

- The **base** is what every arm needs to function: the Anthropic API to think, the hub/vault to do its scoped work. Nothing else.
- The **declared allowlist** is least-egress-that-lets-this-arm-do-its-job. A weaver-style arm that only reads/writes the vault declares `[]` — its tiny network surface is a *feature*, not a limitation. A code-building arm declares `["registry.npmjs.org","pypi.org","github.com", …]` — exactly the package/source hosts it pulls from, and no more.

**Egress breadth must be paired with input trust.** Every allowlisted host is an *exfiltration* path, not just a fetch path — so broad egress is only safe when the arm's input is trusted. A **foreign-input arm** (one fed channel messages or other attacker-influenceable content) should declare **minimal egress regardless of what its job "wants"**, because a prompt-injected session turns each allowlisted host into a place to ship stolen data. The dangerous combination to watch for is explicit: **foreign-input + needs-to-pull-packages.** When an arm genuinely needs both (e.g. building code from a foreign-authored request), don't just widen its egress — prefer to split the work (a trusted arm with broad egress prepares/fetches; the foreign-input arm runs with minimal egress against the prepared inputs), or route fetches through the validating egress proxy (§3.4) so the breadth is mediated rather than blanket.

This resolves the §3.3 tension that the earlier draft flagged-but-left-open (and folds R5): there is no single "right" allowlist to argue about, because the allowlist is **per-spec**. The design decision is the *principle* — least egress per arm, additive to the base — not a fixed host list. (The validating egress proxy of §3.4 is the stronger *enforcement* of this same per-arm allowlist for the multi-tenant tier.)

### 4.5 Filesystem reads are scoped to declared binds (a principled divergence from Anthropic)

The Sandbox contract holds writes to a private per-session workspace (§3.1 item 2). This doc **tightens reads too**: an arm's filesystem view is built from explicit binds only —

> **Policy:** bind `{ runtime + claude-config (ro, implicit), the private session workspace (rw), each declared mount }`; **deny everything else** — including broad read of the operator's home.

This is a **deliberate divergence from Anthropic's default** ("reads allowed, writes allowed in workspace"). Anthropic's broad-read is calibrated for a developer reading *their own* code on *their own* box — a flat-ish gradient where the reader already owns everything readable. Our arms sit at a steeper gradient: a foreign-input channel arm with broad read of the operator's home can read every credential, SSH key, `.env`, and *other vault* on the box — precisely the blast radius §2 says isolation exists to bound. bubblewrap already constructs the filesystem view from explicit binds; broad-read was Anthropic's *policy layer on top of that mechanism*. We keep the mechanism and choose the tighter policy, making reads **symmetric with egress** — both per-spec, both least-privilege, both additive to a minimal base.

`mounts` is the per-arm read/write surface beyond the workspace: each entry binds a `hostPath` to a `mountPath` at `ro` or `rw`. A dev arm binds its project `rw` and a reference tree `ro`; a weaver binds nothing (workspace + config suffice).

**`shared` mounts — a deliberate relaxation, named as such.** A mount may carry a `shared: "<name>"` tag, binding the *same* host directory into more than one arm. This is a **deliberate hole in the session-to-session isolation** that §2/§3 establish as a core property — a `shared: "x"` rw mount is a cross-session channel, and a classic **confused-deputy** vector: a foreign-input arm plants files that a trusted arm later reads and acts on. So shared mounts are governed, not casual:

- **Named, opt-in, deliberate** — never implicit; a shared mount exists only because a spec asked for it by name.
- **Trust-equivalence expectation** — share freely *among arms at the same trust level* (e.g. several of the operator's own dev arms sharing a build cache). Between a foreign-input arm and a trusted arm, **strongly prefer shared-`ro` sourced from the producer, and never shared-`rw`** across the trust boundary — the trusted arm must not read attacker-writable files as if they were its own.
- **Shared-`ro` is not a clean boundary either** — it stops the consumer from *overwriting* the shared dir, but a foreign-input *producer* writing into a shared-`ro` mount still PLANTS data the consumer reads as input. So across a trust boundary, treat producer-supplied files with the **same skepticism as raw channel input** — `ro` removes the write-back vector, not the inject-and-be-read vector.

The tradeoff is real (convenience vs. a cross-session path); the doc names it so a future `shared:` use is a considered decision, not a reflex.

### 4.6 The agent spec is the machine-executable form of a higher-level mandate (seam, forward-looking)

The agent spec (§4.1) is deliberately a *machine-executable* object: tokens, MCP entries, an egress list, mount binds. But it is the executable projection of something more human-readable — a charter or mandate that says, in prose, *what this arm is for and what it's allowed to touch*. To avoid two drifting sources of truth, a higher-level declarative source should be able to **generate or reference** its agent spec, rather than the spec being hand-maintained in parallel with the prose.

State this generally: the principle is *one source of truth for an arm's authority, with the executable spec derived from (or pinned to) the human-readable mandate* — not a hard coupling to any particular store's notion of "an arm." (A vault that models arms as notes is one natural source; a YAML charter checked into a repo is another. The seam is "declarative mandate → derived agent spec," whatever the upstream form.) This is a forward-looking note, not a Phase-1 deliverable; Phase 1 hand-authors specs. It is recorded here so the spec format leaves room to be *generated* later, and so nobody builds a second authority store that competes with the mandate.

---

## 5. In-page terminal (IN v1)

xterm.js embedded in **channel's own UI** ↔ the hub WS bridge ↔ the session's tmux pane. (Aaron's call: in v1, and in channel's existing UI — not a separate surface package. `tmux attach` on the host remains the zero-code zoom-in; the in-page terminal is the over-the-web nicety for when the operator isn't shelled into the box.)

### 5.1 Transport: the hub WS bridge

The hub's Bun-native WS bridge (`ws-bridge.ts`) forwards arbitrary binary/text frames between a browser socket and the upstream daemon, gating *before* the upgrade (`audience-gate.ts` runs in `maybeUpgradeWebSocket`). A terminal is just a frame stream, so the bridge carries it. Channel declares `websocket: true` on its services.json row (deny-by-default, `ws-bridge.ts:9-14`) so the hub will forward upgrades to it.

### 5.2 pty: Bun's native terminal, attached to tmux

Use **Bun's native pty** (`Bun.spawn({ terminal })` + `Bun.Terminal` with write/resize/setRawMode) rather than node-pty-under-Bun. **Attach to the existing TMUX session, not a raw pty** — so a dropped WS reconnects with scrollback intact (the session keeps running in tmux regardless of who's watching). Do **not** adopt ttyd / wetty / gotty: they each bring their own server + auth and fight the model (channel is the daemon, the hub is the transport, the audience gate is the auth).

> **Verify item (version floor):** `Bun.Terminal` (with `resize` / `setRawMode`) is confirmed present in Bun 1.3.14 — the floor is met for current Bun. Keep a ship-time check that the hub + channel Bun pins are ≥ that floor; if a pin ever regresses below it, the fallback is `tmux attach` over a pty the daemon already controls. (Tracked as low-risk R2 in §9.)

### 5.3 Auth: `audience: "surface"`, operator-gated inside channel

The terminal WS mount declares **`audience: "surface"`**, not `operator`. Per `audience-gate.ts:207` (`if (audience === "surface") return null;`), a `surface`-audience mount passes the hub gate unconditionally **because the backend owns admission end-to-end** — the hub would otherwise add a second auth layer that blocks the backend's own auth plane. The `operator` tier (`audience-gate.ts:220-232`) is **session-cookie-only** and *"a Bearer never satisfies this tier"* — which would foreclose the Bearer/API/MCP reachability we want to keep open for the Phase-2 spawn face.

So: the terminal WS uses `surface`, and **channel's backend enforces operator-only inside its own `requireScope`** (`src/auth.ts:70-95`) — yielding operator-grade restriction *today* without nailing the door shut on the API path *tomorrow*. This is the same pattern the docs-editor collab WS uses.

**Token delivery.** A browser can't set an `Authorization` header on `new WebSocket(...)`, so the terminal WS delivers the hub token as a `?token=` query param — the same fallback the chat UI's SSE `EventSource` already uses. The mechanism exists end-to-end: `ws-bridge.ts` preserves `url.search` when it dials the upstream (`WsBridgeData.upstreamUrl` is "same path + query"), and channel's `extractToken` already accepts a query-param token under `allowQueryParam` (`src/auth.ts:43-54`). The terminal endpoint opts into `allowQueryParam: true`, exactly as `transports/http-ui.ts`'s `/ui/events` does for the SSE case.

### 5.4 Backpressure (the load-bearing design item)

`ws-bridge.ts:55, 197-199, 225-234` enforces a hard **8 MiB buffered-bytes cap** (`DEFAULT_MAX_BUFFERED_BYTES`) that, when either side overflows, **closes BOTH sides with 1011**. The docstring is explicit: *"Backpressure is a blunt cap, not flow control … A slow consumer should reconnect rather than let the hub buffer unboundedly,"* and the cap is **not per-connection tunable** — it's a fixed ceiling.

A terminal can legitimately flood it: a big build log, `yes`, a `cat` of a large file. The hub bridge (`ws-bridge.ts`) is just a blind client↔upstream pipe — it does not expose any flow-control hook for the daemon to read; its only response to overflow is to close both sides. So the flow control must live in **channel's own daemon**, which is itself a Bun WebSocket server and therefore holds the upstream end of the terminal socket as a `ServerWebSocket`. That gives it `ws.getBufferedAmount()` natively — the daemon watches *its own* send-buffer depth and throttles before bytes ever reach the bridge's ceiling:

- **Throttle pty reads** — pause reading from `Bun.Terminal` / tmux when `ws.getBufferedAmount()` on the daemon's terminal socket climbs, resume when it drains.
- **xterm.js flow control** — xterm supports a high-watermark/ACK flow-control handshake; wire it so the browser signals when it's behind and the backend stops shoveling.
- **Coalesce** rapid small frames into fewer larger ones to cut per-frame overhead, while staying well under the ceiling.

The goal: the channel backend never lets a single terminal's buffered bytes approach 8 MiB, so the hub's blunt cap is a safety net that never fires in normal use.

### 5.5 Resize + reconnection

- **Resize / SIGWINCH:** xterm's `onResize` → a control frame over the WS → `Bun.Terminal.resize(cols, rows)` (which forwards SIGWINCH to the child). Without this, full-screen TUIs inside the session render at the wrong size.
- **Reconnection:** because we attach to tmux (§5.2), a dropped socket just re-attaches — the session never died, and tmux replays scrollback. The reconnect path re-runs the audience gate + channel's operator check.
- **Connection caps:** a power user with many terminal tabs counts against `ws-connection-caps.ts`'s per-IP 32 (env-overridable via `PARACHUTE_WS_MAX_PER_IP`). 32 is generous for one operator; note it, don't engineer around it.

---

## 6. Credential model

**Store the Claude `CLAUDE_CODE_OAUTH_TOKEN` as a secret in channel's credential store, per-channel-configurable** — exactly the pattern channel already uses for per-channel credentials. `registry.ts` already keeps per-channel config (e.g. each telegram channel carries its own bot token in `config.token`), and `upsertChannelEntry` is the read-modify-write that persists a channel's config secrets, writing the file 0600 and `chmod`-ing it 0600 unconditionally (`registry.ts:152-164`). The Claude OAuth token follows that pattern: a per-channel `credential` field, defaulting to a single operator token, overridable per channel.

- **The token:** `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (1-year, the documented headless/CI auth path). Injected into the sandbox at launch as the session's auth.
- **Default one operator token; per-channel override.** The per-channel field **is the multi-principal seam** — multi-user isn't a rewrite, just populating per-channel (eventually per-principal) credentials.
- **Do NOT also set `ANTHROPIC_API_KEY`** in the sandbox: it wins in claude-cli's precedence order and would silently route the session onto API billing instead of the interactive subscription. (runner's `buildChildEnv` passes `ANTHROPIC_API_KEY` through *by design* because runner is the API-key path, `spawn.ts:124`; the channel sandbox must *not*.)
- **Verify item:** confirm an interactive `claude` launched inside the sandbox with only `CLAUDE_CODE_OAUTH_TOKEN` injected authenticates and runs **without prompting for `/login`**. (§9.)
- **Capacity caveat (not a ToS issue):** agents draw on the operator's *interactive subscription quota*, shared with the operator's own Claude use. That's a real capacity limit, not a billing/ToS problem (the model is normal interactive use, §1). Per-principal credentials (each user's own setup token) are the multi-tenant answer and the reason the credential is a per-channel field from day one.

---

## 7. Deploy: full Parachute on a VPS (a v1 deliverable)

The full tier — the one that runs channels + sandboxed sessions — needs a **real host** (a desktop or a Linux VPS), because Render's single-container model can't host resident interactive sessions with their own isolation. (With the bubblewrap route, §3.2, the host needs **no root Docker daemon** — which loosens the constraint, but a plain VPS stays the recommendation.) So Parachute forks into two deploy tiers:

| Tier | Runs | Where |
|---|---|---|
| **lite** | vault, hub, surfaces | Render / Fly (single container, no Docker/DinD) |
| **full** | + channels + sandboxed sessions | the operator's own Mac/Linux desktop (now), or a Linux VPS via cloud-init (this deliverable) |

### 7.1 Primary artifact: a provider-agnostic cloud-init script

The highest-leverage build is a provider-agnostic **`parachute` cloud-init `user_data` script** that boots a *fresh* Linux VPS to a working full-tier Parachute:

1. install the runtime (Bun + the sandbox-runtime / bubblewrap deps),
2. install + start the hub (`parachute serve` under systemd — hub's standard Linux unit, hub `CLAUDE.md` "One runtime: `parachute serve` under a process manager"),
3. install channel + its deps,
4. print the **bootstrap token + setup URL** on first boot.

It **pairs with the existing `parachute expose` Cloudflare-tunnel machinery unchanged** (hub `src/commands/expose.ts`) — the box comes up, exposes itself over the tunnel, and the operator finishes setup in the browser. The script must run on **DO / Hetzner / GCP / generic Linux** (paste into any provider's "user data" box).

### 7.2 Provider comparison (secondary — appendix)

The script is provider-agnostic; the provider choice is a recommendation, not a dependency. Summary (full reasoning in the research note):

- **DigitalOcean = simplest default.** No-KYC signup, cleanest console, a Marketplace 1-Click Docker image, `doctl` + `user_data` automation, public IP by default. ~$48/mo at 8 GB / 4 vCPU. Optimizes the #1 target: a non-expert's first setup.
- **Hetzner = cost pick.** ~€7 EU / ~$17 US at 8 GB (3–6× cheaper) — but two real frictions for non-experts: identity verification may be required at signup, and an EU/US price-and-traffic split. Frame as "if you're willing to clear any signup verification, it's far cheaper."
- **Vultr / Linode** = DO-equivalents (~$40–48); no reason to lead with them.
- **EC2 / GCP** = complexity tax + most expensive (2 vCPU not 4 at 8 GB, metered egress); only for existing AWS/GCP shops.
- **Render / Fly stay lite-tier-only.** (NB: bubblewrap-only isolation *could* let a Fly full-VM work via user namespaces, but keep the recommendation simple: plain VPS for the full tier.)

**Sizing:** 8 GB / 4 vCPU default (each interactive Claude session can spike 1–2 GB under build load); 4 GB / 2 vCPU budget floor for 1–2 sessions.

### 7.3 Follow-on artifacts (not v1)

- A **DO Marketplace 1-Click "Parachute (Full)" image** — the biggest non-expert UX win after the script.
- **`parachute provision <provider>`** wrapping `doctl` / `hcloud` — later polish.

---

## 8. Phased build plan

### Phase 1 — the demo (owner-operated, real host)

Everything needed to spawn a sandboxed agent, watch it in the browser, and run it on a real box:

- **The `Sandbox` envelope** (§3): sandbox-runtime (bubblewrap/Seatbelt) + network-deny-default + the `{ Anthropic API, hub/vault }` allowlist + the injected per-channel token + write-confined workspace + resource limits.
- **The spawn/scope command** (§4): agent spec → per-resource token mint → multi-entry strict MCP config → sandboxed `claude` in tmux. Graduates `launch-session.sh`.
- **The in-page xterm.js terminal** (§5) in channel's UI: WS bridge + `Bun.Terminal` attached to tmux + `surface` audience with operator-gated channel auth + backend flow control + resize/reconnect.
- **The VPS cloud-init path** (§7.1) so it runs on a real host.

**Demo:** spawn a sandboxed agent scoped to channel-X + vault-read, watch its terminal live in the Parachute web page, kill it — **running on a DO/Hetzner box**, not just localhost.

### Phase 2 — the API/MCP spawn face

Spawn/scope as **hand-built MCP mutation tools** (spawn/kill/scope are mutations, not vault read-projections) + **agents modeled as `tag:agent-session` vault notes** for free list/discovery (a read-projection can list them; an MCP `list` falls out). Makes the system callable by other agents + external triggers — the capability-attenuation bound (§4.3) is what keeps it safe.

### Phase 3 — multi-tenant escalation

The escalation isolation rung (§3.4 — gVisor / full VM, or the validating egress proxy) + **per-principal credentials** (§6). Turns the owner's tool into a product capability with a genuinely-untrusted tier.

---

## 9. Open questions, risks, decisions already made

### Decisions already made (Aaron, 2026-06-14)

- **In-page terminal is IN v1** (not a later option), and lives in **channel's existing UI**, not a separate surface package.
- **Credential = `CLAUDE_CODE_OAUTH_TOKEN` stored as a per-channel secret in channel's credential store**, default one operator token, per-channel override.
- **VPS full-tier deploy is prioritized** as a v1 deliverable (the cloud-init script is the primary artifact).
- **Sandbox-runtime (Seatbelt/bubblewrap) over Docker** for v1; Docker/gVisor/VM is the multi-tenant escalation, not v1.
- **The sandbox-runtime is reached by library-link or a pinned absolute-path binary — NEVER `PATH` resolution.** A poisoned `PATH` entry would execute *before* the sandbox is established (the launcher resolving `sandbox-runtime` off `PATH` runs the attacker's binary outside any sandbox), re-opening the exact hole the sandbox closes. So the trust boundary is anchored to a known artifact: link the library, or invoke an absolute, operator-controlled path. (This was the former PATH-resolution open question; now decided.)
- **Filesystem reads are scoped to declared binds, and egress is per-arm — both additive to a minimal base** (§4.4, §4.5). Reads tighten Anthropic's broad-read default deliberately, given our steeper trust gradient.
- **Channel is the home** for this work (session lifecycle + the new isolation); the terminal is a channel-UI concern over the WS bridge.
- **In-page terminal is the Phase-1 release valve** — stays in v1, but is the deferrable piece if Phase 1 slips (§9 R1).
- **Octopus retires** (gets a `DEPRECATED.md`); harvest the named parts only. Retiring octopus-*the-module* is what *enables* octopus-*the-pattern* — see §1.

### Risks

- **R1 — terminal backpressure vs the 8 MiB WS ceiling.** The hub cap closes both sides on overflow and is not tunable (`ws-bridge.ts:55, 197-234`). Mitigation is backend-side flow control (§5.4). This is the single most load-bearing engineering item in the terminal work — a `yes` in a terminal must not kill the connection. **Schedule note — the in-page terminal is Phase 1's release valve.** It carries the hardest engineering risk (this backpressure work) for the *least* security/capability payoff: `tmux attach` on the host already provides the zoom-in, so the terminal is a convenience, not a load-bearing win. It stays in v1 (Aaron's call), but if Phase 1 must slip, **the terminal is the deferrable piece** — the sandbox envelope (§3), the spawn/scope command (§4), and the VPS path (§7) are the wins that must ship.
- **R2 — `Bun.Terminal` version floor (low risk).** `Bun.Terminal` (with `resize` / `setRawMode`) is confirmed present in Bun 1.3.14, so the floor is already met for current Bun. Keep a "verify against the pinned Bun at ship time" check (the hub + channel pin must be ≥ that floor), but this is lower-risk than originally stated. Fallback if a pin ever regresses: pty-over-tmux the daemon controls.
- **R3 — interactive-token auth in the sandbox.** Verify `claude` authenticates from the injected `CLAUDE_CODE_OAUTH_TOKEN` alone, no `/login`, and that `ANTHROPIC_API_KEY` is absent so billing stays interactive (§6).
- **R4 — capacity / quota (a Phase-1 operational reality, not a Phase-3 concern).** Every looping arm — `uni-dev`, `uni-weaver`, `uni-evolve`, plus any per-project sub-arms — draws on the operator's *one* interactive subscription, competing with each other **and** with the operator's own Claude Code use. This is a week-one throttle: it caps how many looping arms can run concurrently before the operator feels their own sessions slow. It doesn't change the design, but it shapes capacity expectations *now* — plan the initial fleet around one subscription's headroom. Per-principal credentials (§6, Phase 3) is the structural fix; until then, concurrency is the knob.
- **R5 — egress allowlist completeness → RESOLVED by per-arm `egress` (§4.4).** The earlier worry ("one global allowlist is either too narrow or too broad") dissolves once the allowlist is per-spec: each arm declares least-egress for its own job, additive to the base. Residual: the *enforcement* hardening (static sandbox-profile allowlist now → the validating egress proxy for the multi-tenant tier, §3.4). Not a design open-question anymore.

### Open questions

- **Q1 — workspace mount granularity → RESOLVED by §4.5.** Reads are scoped to declared mounts, *not* broad RO: a dev arm declares its project (`rw`) and any reference tree (`ro`) explicitly via the spec's `mounts`, on top of the private per-session workspace. No broad-RO overlay.
- **Q2 — token lifecycle default.** Ephemeral-TTL for everything (revoke-on-death) vs a registered connection for standing agents that must survive a daemon restart. Likely both, selected by the spec (§4.2).
- **Q3 — does the in-page terminal warrant its own view** in channel's UI, or fold into the existing chat/admin pages? (Decided home is channel's UI; the sub-placement is open.)
- **Q4 — multi-browser attach semantics.** Two browsers attaching to the same tmux pane share one input stream — their keystrokes interleave (standard tmux behavior). Fine for owner-operated (one person, two tabs), but it must be a deliberate Phase-1 expectation: do we present the terminal as **single-writer** (additional viewers are read-only) or **shared-view** (everyone can type, interleaving accepted)? Default to shared-view for v1 (matches `tmux attach`), but say so explicitly so it isn't a surprise.

---

## 10. Propagation

When Phase 1 firms up, this is an architectural shift (channel moves from "exploration, may retire" to a hardened agent-session gateway with a new deploy tier). Per the workspace architectural-shift discipline, ship a `parachute-patterns/migrations/YYYY-MM-DD-*.md` propagation checklist in the originating PR, and update:

- the workspace `CLAUDE.md` committed-core table row for channel,
- `parachute-patterns/patterns/trust-gradient-isolation.md` (the OS-sandbox-for-desktop / VM-for-multi-tenant gradient nuance this doc introduces is a pattern refinement worth recording),
- channel's own `PLAN.md:153` (mark the isolation step built) + the `CLAUDE.md` Sessions caveat (the "full machine access" line is closed).
