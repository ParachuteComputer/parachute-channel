# Deploying Parachute — tiers + the full-tier cloud-init

Parachute deploys in **two tiers**. Pick by whether you need **resident agent
sessions** (sandboxed Claude Code sessions you chat with through a channel).

| | **Lite** | **Full** |
|---|---|---|
| What runs | hub + vault + static surfaces | hub + vault + **agent + sandboxed agent sessions** |
| Where | Render / Fly (a single container) | your **desktop** today, or a **Linux VPS** via `cloud-init-full.yaml` |
| Isolation engine | n/a (no sessions) | `@anthropic-ai/sandbox-runtime` — **Seatbelt** on macOS, **bubblewrap** on Linux |
| Resources | 512MB is fine | ~8GB RAM (sessions are real `claude` processes) |
| How you set it up | one-click Blueprint / `flyctl` | paste this user-data → boot → SSH → `expose` |

**Lite** is the existing hosted self-deploy: the `render.yaml` Blueprint and the
Fly script in `parachute-hub`. It's a single container with one persistent disk —
great for the vault + hub + surfaces, but it deliberately doesn't run agent
sessions (no per-session sandbox; a PaaS container is the wrong substrate for
spawning `claude` under bubblewrap).

**Full** is this directory. The primary artifact is a **provider-agnostic
cloud-init** script that boots a fresh Ubuntu/Debian VPS into a working full-tier
box: hub + agent + the sandbox toolchain (`bun`, the `claude` CLI,
`@anthropic-ai/sandbox-runtime`, `tmux`, `bubblewrap`, `ripgrep`, `socat`). The
desktop path is just "install the hub + agent locally" — `cloud-init-full.yaml`
is the same install, scripted for a headless box.

> Design context: `design/2026-06-14-sandboxed-agent-sessions.md` §7. The
> isolation contract is held constant; only the *mechanism* differs by platform
> (Seatbelt / bubblewrap) behind `@anthropic-ai/sandbox-runtime`.

---

## The full-tier cloud-init (`cloud-init-full.yaml`)

It's a standard `#cloud-config` user-data file. Every major cloud accepts
cloud-init user-data, so the **same file** works on DigitalOcean, Hetzner, GCP,
AWS EC2, or any generic cloud-init datasource. On first boot it:

1. Patches the box, installs the apt deps (`tmux bubblewrap ripgrep socat git …`).
2. Relaxes Ubuntu 24.04's `apparmor_restrict_unprivileged_userns` so bubblewrap
   can create capability-bearing user namespaces (no-op on older kernels).
3. Installs `bun`, then `@openparachute/hub`, `@openparachute/agent`, the
   `claude` CLI, and `@anthropic-ai/sandbox-runtime` — all as a **non-root
   `parachute` user**.
4. Runs `parachute init --expose none --no-expose-prompt --cli-wizard` (starts
   the hub as a systemd unit that survives reboots; loopback-only; no browser).
5. Prints the one-time **admin bootstrap token** + the `/admin/setup` URL to the
   **serial/console log**, and tells you to run `parachute expose` for a URL.

The hub and the agent sessions run unprivileged as `parachute`; only the apt
package install needs root (cloud-init runs as root for that).

### Provider paste-instructions (the actual click path)

The shape is identical everywhere: **create a VPS → paste the user-data → boot →
read the console for the token → SSH in → `expose` → open `/admin/setup`.**

#### DigitalOcean (simplest default — no KYC)

1. Create Droplet → **Ubuntu 24.04** → an **8 GB** plan (sessions are real
   processes; 8 GB is the comfortable floor).
2. Under **Advanced options → Add Initialization scripts (free)**, paste the
   contents of `cloud-init-full.yaml`.
3. Add your SSH key → Create.
4. When it's up, open the Droplet's **Console** (or **Recovery → Console**) and
   read the `PARACHUTE FULL-TIER BOOTSTRAP COMPLETE` banner for the token.
5. `ssh parachute@<droplet-ip>` → `parachute expose cloudflare --domain <host>`
   (public HTTPS; needs a Cloudflare-managed domain) **or**
   `parachute expose tailnet` if you run Tailscale.
6. Open the printed URL's `/admin/setup`, paste the token, create your admin
   account. Then install/connect the Agent module and launch sessions.

#### Hetzner Cloud (cheapest in the EU)

1. Create Server → **Ubuntu 24.04** → a **CPX41 / CX42-class (8 GB)** instance.
2. Expand **Cloud config** and paste `cloud-init-full.yaml`.
3. Add your SSH key → Create.
4. Read the token from the server's **Console** in the Hetzner panel.
5. Same as DO step 5–6 (`ssh parachute@<ip>` → `parachute expose …` → `/admin/setup`).

#### GCP

```sh
gcloud compute instances create parachute-full \
  --image-family=ubuntu-2404-lts --image-project=ubuntu-os-cloud \
  --machine-type=e2-standard-2 \
  --metadata-from-file=user-data=cloud-init-full.yaml
```
Read the token: `gcloud compute instances get-serial-port-output parachute-full | grep parachute-bootstrap-`.
Then SSH in and `parachute expose …`.

#### AWS EC2

Launch an **Ubuntu 24.04 AMI** (t3.large / 8 GB), paste `cloud-init-full.yaml`
into **Advanced details → User data**. Read the token from **Actions → Monitor
and troubleshoot → Get system log**, then SSH in and `expose`.

#### Any other cloud / self-hosted

It's plain cloud-init user-data — drop it into whatever your platform calls the
"user data" / "cloud config" field (Vultr, Linode, Proxmox NoCloud seed, libvirt
`--user-data`, etc.). Nothing in the file is provider-specific.

### Can't (or don't want to) expose?

Tunnel the loopback hub over SSH from your laptop and do setup locally:

```sh
ssh -L 1939:127.0.0.1:1939 parachute@<box-ip>
# then open http://127.0.0.1:1939/admin/setup and paste the token
```

### Retrieve the token later

If you missed it in the console:

```sh
ssh parachute@<box-ip>
journalctl --user | grep parachute-bootstrap-          # primary on Linux (hub runs under systemd → journald)
# or: grep parachute-bootstrap- ~/.parachute/hub/logs/hub.log
```

---

## Provider cost snapshot (secondary — the point is "it boots a working box")

| Provider | ~8 GB instance | Notes |
|---|---|---|
| **DigitalOcean** | ~$48/mo | **Default.** Simplest console + no-KYC; the smooth first-run path. |
| **Hetzner** | ~$7/mo (EU) · ~$17/mo (US) | Cheapest, but **KYC** (ID verification) can delay/limit new accounts, and capacity is region-gated. Great once you're in. |
| GCP / AWS | varies | Use if you're already there; `e2-standard-2` / `t3.large`-class. |

Sessions are real `claude` processes — **8 GB RAM is the comfortable floor** for a
couple of resident sessions. A 4 GB box can run the hub + vault + one light
session, but don't size below 8 GB if you expect to actually work in sessions.

---

## Validation

- `cloud-init-full.yaml` parses as YAML and passes `cloud-init schema
  --config-file` (validated in an Ubuntu 24.04 container — see the PR description).
- The install steps (apt deps + bun + `claude` CLI) and a **bubblewrap
  egress-deny smoke** were exercised in an Ubuntu 24.04 container: with
  `bwrap --unshare-net` (the Linux deny-all-egress mechanism the sandbox-runtime
  uses) a sandboxed `curl` to `api.anthropic.com` is **blocked**, while the host
  reaches it — the positive control. This is the one isolation path macOS
  Seatbelt can't cover, so it's the load-bearing Linux test.

### The single live smoke for the operator (one-time)

A container can't fully exercise the **systemd-user-unit boot + reboot survival**
path (no init/journald in a plain container). Run this once on a real VPS:

```sh
# 1. Create an 8GB Ubuntu 24.04 VPS with cloud-init-full.yaml as user-data.
# 2. Watch the console for "PARACHUTE FULL-TIER BOOTSTRAP COMPLETE" + a token.
# 3. SSH in and confirm the stack:
ssh parachute@<box-ip>
parachute status            # hub active; vault active
command -v claude bwrap rg tmux parachute-agent   # all present
# 4. Expose + finish setup:
parachute expose cloudflare --domain <host>   # or: parachute expose tailnet
#    open <url>/admin/setup, paste the token, create the admin account.
# 5. Reboot survival:
sudo reboot
ssh parachute@<box-ip> 'parachute status'     # hub still active after boot
```

---

## Follow-ons (NOT built here)

- **A DigitalOcean 1-Click image** (Marketplace): bake this cloud-init into a
  snapshot so operators get a literal one-click "Parachute Full" droplet.
- **`parachute provision <provider>`**: a hub CLI verb that calls the provider's
  API to create the VPS with this user-data and stream back the token — turning
  the whole flow above into one local command.
