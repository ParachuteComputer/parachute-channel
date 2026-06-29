#!/usr/bin/env bun
/**
 * parachute-agent daemon — the transport-agnostic orchestrator.
 *
 * Runs as a long-lived HTTP server (launchd, systemd, or manual). It loads a
 * channel registry (name → transport), starts each transport, and routes
 * inbound traffic to the bridges subscribed to that channel. Bridges connect
 * via SSE (`/events?channel=<name>`) for inbound and POST outbound to the HTTP
 * API with a `channel` field.
 *
 * Telegram is one transport behind the registry; the daemon core touches no
 * platform API directly.
 *
 * Port resolution (see `resolvePort`): the hub supervisor's injected `PORT`
 * wins, then the `PARACHUTE_AGENT_PORT` override (legacy `PARACHUTE_CHANNEL_PORT`
 * still honored), then the compiled-in canonical default 1941. The daemon binds
 * AND self-registers the resolved port, so the supervisor's probe/proxy and the
 * bound port never disagree (agent#41).
 */

import { mkdirSync, readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { timingSafeEqual } from "node:crypto";
import { upsertService, listVaultNames } from "./services-manifest.ts";

/** Constant-time webhook-secret compare. Length check first (a length mismatch
 *  is never equal); timingSafeEqual on equal-length buffers avoids the
 *  short-circuit timing leak of `===`. Empty configured/presented → never match. */
function webhookSecretMatches(presented: string, configured: string): boolean {
  if (!presented || !configured || presented.length !== configured.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(configured));
}
import type {
  Transport,
  TransportContext,
  InboundMessage,
  ReplyArgs,
  ReactArgs,
  EditArgs,
  PermissionArgs,
  DownloadArgs,
} from "./transport.ts";
import { ChannelConfigError } from "./transport.ts";
import {
  loadRegistry,
  instantiateTransport,
  upsertChannelEntry,
  removeChannelEntry,
  defaultStateDir,
  type Channel,
  type ChannelEntry,
} from "./registry.ts";
import { VaultTransport, AGENT_VAULT_TRIGGER_TEMPLATE, noteAgentKey } from "./transports/vault.ts";
import {
  AgentDefRegistry,
  AgentDefWriteError,
  type DefVaultBinding,
  type InstantiateDeps,
} from "./agent-defs.ts";
import {
  resolveDefVaults,
  readDefVaultsFile,
  writeDefVaultsFile,
  DEFAULT_DEF_VAULT_URL,
  DEFAULT_HUB_ORIGIN,
} from "./def-vaults.ts";
import { mintScopedToken, vaultScope } from "./mint-token.ts";
import { registerAllDefVaultTriggers } from "./def-vault-triggers.ts";
import { GrantsClient } from "./grants.ts";
import { resolveEffectiveEnv } from "./effective-env.ts";
import { VaultJobStore, validateJob, vaultTransportFor, type Job } from "./jobs.ts";
import { Runner, realTickDriver } from "./runner.ts";
import { nextRunAfter } from "./cron.ts";
import {
  setDefaultClaudeCredential,
  setChannelClaudeCredential,
  removeChannelClaudeCredential,
  describeClaudeCredentials,
  setChannelEnvVar,
  removeChannelEnvVar,
  describeChannelEnv,
  DenylistedEnvError,
} from "./credentials.ts";
import { ClientRegistry, sseFrame } from "./routing.ts";
import { DeliveryState } from "./delivery-state.ts";
import {
  requireScope,
  mintSseTicket,
  requireSseTicket,
  requireStepUp,
  grantsScope,
  extractToken,
  json as authJson,
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_SEND,
  SCOPE_ADMIN,
  SCOPE_TERMINAL,
} from "./auth.ts";
import {
  isStepUpConfigured,
  isValidPinFormat,
  setStepUpPin,
  verifyStepUpPin,
  mintStepUpToken,
  stepUpLimiter,
  StepUpPinFormatError,
} from "./step-up.ts";
import { mintTicket } from "./ui-ticket.ts";
import {
  createTerminalWsHandlers,
  type TerminalWsData,
} from "./terminal.ts";
import { TERMINAL_UI_HTML } from "./terminal-ui.ts";
import { serveTerminalAsset } from "./terminal-assets.ts";
import { isSpaPath, serveSpa, spaDistDir } from "./spa-serve.ts";
import { runBootPreflight, type PreflightResult } from "./preflight.ts";
import {
  buildSpecFromBody,
  setupProgrammaticSpawn,
  SpawnRequestError,
  AGENT_NAME_SLUG,
  type AgentInfo,
} from "./agents.ts";
import { SpawnDepsError, sessionsDir as defaultSessionsDir, resolveSpawnDeps } from "./spawn-deps.ts";
import {
  ProgrammaticBackend,
  realProgrammaticSpawn,
  type ProgrammaticBackendDeps,
} from "./backends/programmatic.ts";
import {
  ProgrammaticAgentRegistry,
  type WriteOutbound,
  type WriteThread,
  type WriteCallback,
  type QueuedMessage,
  type TurnEventSink,
} from "./backends/registry.ts";
import {
  AttachedQueueRegistry,
  type AttachedQueueStore,
} from "./backends/attached-queue.ts";
import { readPersistedSpec, sessionWorkspace } from "./spawn-agent.ts";
import { normalizeChannel } from "./sandbox/types.ts";
import { CredentialNotConfiguredError } from "./credentials.ts";
import { MintError } from "./mint-token.ts";
import { validateHubJwt, getHubOrigin } from "./hub-jwt.ts";
import {
  handleProtectedResource,
  handleAuthorizationServer,
  mcpWwwAuthenticate,
} from "./oauth-discovery.ts";
import {
  handleMcp,
  pushToChannel as mcpPushToChannel,
  pushPermissionVerdict as mcpPushPermissionVerdict,
  mcpSessionCount,
  assertMcpSdkStreamContract,
} from "./mcp-http.ts";

// Re-export the shared auth surface so existing importers of the daemon module
// keep working; the canonical home is now `auth.ts` (shared with http-ui.ts).
export { requireScope, SCOPE_READ, SCOPE_WRITE, SCOPE_SEND } from "./auth.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATE_DIR = defaultStateDir();
const INBOX_DIR = join(STATE_DIR, "inbox");

/**
 * Resolve the HTTP port the daemon binds (and self-registers in services.json),
 * honoring sources in priority order:
 *
 *   1. `PORT` — the hub supervisor injects this from the module's services.json
 *      `entry.port` (the canonical pattern vault/scribe follow). It is the port
 *      the supervisor ALSO probes for readiness and proxies `/agent/*` to, so
 *      the daemon MUST bind it or the supervisor reports `started_but_unbound`
 *      and the proxy routes to a dead port (agent#41).
 *   2. `PARACHUTE_AGENT_PORT` — manual override for a daemon run outside the
 *      supervisor. Falls back to the legacy `PARACHUTE_CHANNEL_PORT` (the
 *      pre-rename env var; still honored during the channel→agent transition).
 *   3. `1941` — the compiled-in canonical default.
 *
 * Pre-#41 the daemon read only `PARACHUTE_CHANNEL_PORT`, so it ignored the
 * supervisor's `PORT` and bound 1941 regardless — the supervisor's injected
 * port and the bound port could disagree, stranding the proxy. Honoring `PORT`
 * first closes that gap.
 *
 * Read at call time (not at import) so tests can drive each tier deterministically.
 *
 * Uses `||` (not `??`) for the fall-through so an EMPTY-string env value falls
 * through rather than being treated as "set": `PORT=""` with `??` would yield
 * `parseInt("")` = NaN and bind port 0 / garbage. `||` skips the empty string
 * to the next tier — matches vault's defensive `parseInt(...) || ... || DEFAULT`.
 * The final `1941` literal also guards a non-numeric value (`PORT="abc"` →
 * `parseInt` NaN → falsy → falls through to the default).
 */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  return (
    parseInt(env.PORT ?? "", 10) ||
    parseInt(env.PARACHUTE_AGENT_PORT ?? "", 10) ||
    parseInt(env.PARACHUTE_CHANNEL_PORT ?? "", 10) ||
    1941
  );
}

const PORT = resolvePort();

/** Channel a bridge subscribes to when `?channel=` is omitted (back-compat). */
const DEFAULT_CHANNEL = "telegram";

/** Package version + install dir, for services.json self-registration. */
const PKG_VERSION = ((): string => {
  try {
    return JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const INSTALL_DIR = join(import.meta.dir, "..");

/**
 * The argv the hub supervisor should spawn to (re)start this module — written
 * into our services.json row so `parachute restart agent` / reboot-survival /
 * adopt all have a command to run. Without it the supervisor knows the port but
 * not how to start the process, so a manually-run `bun src/daemon.ts` daemon
 * can't be supervised (agent#34).
 *
 * Sourced from our own `.parachute/module.json` `startCmd` (the canonical
 * declaration the hub already prefers when it can read the install dir),
 * falling back to the package.json `bin` name when the manifest is unreadable.
 * The bin (`parachute-agent` → `src/daemon.ts`) runs the daemon directly and
 * ignores extra argv, so the literal command is stable regardless of any
 * subcommand the hub's first-party fallback might carry.
 */
export function resolveStartCmd(installDir: string): string[] {
  try {
    const manifest = JSON.parse(
      readFileSync(join(installDir, ".parachute", "module.json"), "utf8"),
    ) as { startCmd?: unknown };
    if (
      Array.isArray(manifest.startCmd) &&
      manifest.startCmd.length > 0 &&
      manifest.startCmd.every((a) => typeof a === "string")
    ) {
      return manifest.startCmd as string[];
    }
  } catch {
    // fall through to the bin-name default
  }
  return ["parachute-agent"];
}

const START_CMD: string[] = resolveStartCmd(INSTALL_DIR);

// ---------------------------------------------------------------------------
// Registry + routing
// ---------------------------------------------------------------------------

/**
 * Extract the agent-to-agent CALLBACK fields ("reply_to") from a flattened inbound `meta`
 * (the vault transport's ingestInbound copies the note's metadata into `meta`, all string-
 * valued). A SENDING agent stamps these on the inbound note it writes to the recipient:
 *   - `reply_to`         — the sender's channel name; where to deliver the completion
 *                          callback. Absent → no callback (an ordinary turn).
 *   - `correlation_id`   — an opaque id the sender matches replies to requests with.
 *   - `delegation_depth` — how many hops deep this message is (the loop guard's counter).
 *                          The vault stores it as a STRING, so coerce to a finite integer
 *                          here; a missing/garbage value reads as 0 (a top-level turn).
 *
 * Returns ONLY the keys that are present, so spreading it into a {@link QueuedMessage} is a
 * clean no-op when this isn't a delegated request. NOTE we read `reply_to` from metadata —
 * NOT to be confused with the Telegram quote-reply `reply_to` on ReplyArgs (a message-id,
 * a different axis that lives on the outbound side).
 */
export function callbackFieldsFromMeta(
  meta: Record<string, string> | undefined,
): Pick<QueuedMessage, "replyTo" | "correlationId" | "delegationDepth"> {
  if (!meta) return {};
  const out: Pick<QueuedMessage, "replyTo" | "correlationId" | "delegationDepth"> = {};
  if (typeof meta.reply_to === "string" && meta.reply_to) out.replyTo = meta.reply_to;
  if (typeof meta.correlation_id === "string" && meta.correlation_id) {
    out.correlationId = meta.correlation_id;
  }
  // Coerce the string-typed depth to a finite positive integer. Anything else — absent, "",
  // "abc", a negative, OR a literal "0" — is OMITTED here; the drain's `?? 0` fallback
  // (maybeDeliverCallback) treats an absent `delegationDepth` as 0, so a depth-0 message
  // still gets to call back (the ceiling, not the floor, is what stops a runaway chain).
  // We only bother storing a value when it's a meaningful positive depth.
  const depth = Number(meta.delegation_depth);
  if (Number.isFinite(depth) && depth > 0) out.delegationDepth = Math.floor(depth);
  return out;
}

/** Build the per-channel context a transport routes through. Exported for tests
 *  (the inbound-routing fork lives here). */
export function contextFor(
  registry: ClientRegistry,
  channel: string,
  deliveryState: DeliveryState,
  programmatic?: ProgrammaticAgentRegistry,
  attachedQueue?: AttachedQueueRegistry,
): TransportContext {
  return {
    channel,
    emit(msg: InboundMessage): void {
      // ── DAEMON ROUTING FORK (design 2026-06-18-channel-backend.md, the load-bearing
      // change). Route inbound by the agent's BACKEND:
      //
      //   backend: attached → the AttachedQueueRegistry path. The inbound
      //     `#agent/message/inbound` note IS the queue item (durable in the vault,
      //     status:pending by default). There is NO `claude -p`, NO serial worker, and
      //     NO live push — a connected Claude Code session PULLS it via the channel MCP
      //     surface. So an attached inbound is a NO-OP here beyond its own durability:
      //     we MUST NOT enqueue to the programmatic worker (that would run a turn the
      //     attached model deliberately doesn't), and we don't advance the delivery
      //     high-water-mark (there's no live subscriber to deliver to; the durable note
      //     queue + claim status is the durability, not replay). Checked FIRST so an
      //     attached agent NEVER falls through to the programmatic enqueue below.
      if (attachedQueue?.hasChannel(channel)) {
        return;
      }
      // PROGRAMMATIC ROUTING (design 2026-06-16 step 3). If a programmatic agent is
      // registered for this channel, the inbound becomes one on-demand `claude -p`
      // turn — ENQUEUE it (the per-channel serial worker drains it) and do NOT also
      // push to SSE/MCP: a programmatic agent has no live subscriber, so a fan-out
      // would reach no one AND the delivery high-water-mark must NOT advance (there's
      // nothing to deliver to; the queue is the durability). The note's id rides in
      // `meta.note_id` so the reply threads to it.
      if (programmatic?.hasChannel(channel)) {
        programmatic.enqueue(channel, {
          content: msg.content,
          ...(msg.meta?.note_id ? { inReplyTo: msg.meta.note_id } : {}),
          // AGENT-TO-AGENT CALLBACK ROUTING ("reply_to") — pull the callback fields a
          // SENDING agent stamped on this inbound note's metadata (flattened into `meta` by
          // the vault transport's ingestInbound). When `reply_to` is present, the drain
          // delivers a callback to that channel on turn completion. See callbackFieldsFromMeta.
          ...callbackFieldsFromMeta(msg.meta),
          // Phase 1: carry inbound file attachments through to the turn (the programmatic
          // backend stages them into the agent's private workspace so the turn can Read them).
          ...(msg.attachments && msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
          // agent#162: carry the inbound sender so the drain can derive the run-context
          // `fired-by` (a scheduled `runner:<jobId>` fire vs an interactive/delegated message).
          ...(msg.meta?.sender ? { sender: msg.meta.sender } : {}),
        });
        return;
      }
      // PENDING-INBOUND BUFFER (agent#121). No LIVE programmatic agent for this channel —
      // but if the channel is EXPECTED to gain one (a def maps here; instantiation may be
      // in flight, or a brief channel/agent desync), we must OWN the message, not drop it:
      // the vault trigger acks success on our 200 and NEVER retries, so a silent drop is a
      // PERMANENT loss (0 turns, 0 threads, no reply — the bug). Buffer it; `register()`
      // replays the buffer in order once the agent is live. A genuinely UNKNOWN channel
      // (nothing maps to it) returns "unknown": nothing to deliver to, so we log + fall
      // through to the push path (which reaches no one) and still 200. We do NOT advance the
      // delivery high-water-mark here (no real delivery happened; the durable note + the
      // pending buffer / replay is the durability).
      if (programmatic) {
        const outcome = programmatic.queuePending(channel, {
          content: msg.content,
          ...(msg.meta?.note_id ? { inReplyTo: msg.meta.note_id } : {}),
          // Carry the callback fields through the PENDING buffer too — a delegated request
          // that arrives before its recipient agent is live must still trigger a callback
          // once the buffered turn runs on register() (the agent#121 replay path).
          ...callbackFieldsFromMeta(msg.meta),
          // Phase 1: carry inbound attachments through the pending buffer too, so a turn
          // that runs on register() still stages them.
          ...(msg.attachments && msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
          // agent#162: carry the sender through the pending buffer too, so a turn that runs on
          // register() still derives the right run-context `fired-by`.
          ...(msg.meta?.sender ? { sender: msg.meta.sender } : {}),
        });
        if (outcome === "queued") return;
        // outcome === "unknown" — not an expected programmatic channel. It may still be a
        // genuine push/bridge channel (telegram, a connected session), so fall through to
        // the normal SSE/MCP push below rather than dropping outright. If THAT also reaches
        // no one (0 subscribers), the message is logged-as-undelivered by leaving the
        // high-water-mark behind (the existing no-silent-loss behavior), and for a truly
        // orphaned channel there is, by definition, nothing more we can do.
      }
      // Route on the bound `channel`, NOT msg.channel — the transport's own
      // channel is authoritative. This makes it impossible for a transport to
      // emit onto another channel (closing a silent cross-channel-leak footgun)
      // even if a future transport sets msg.channel incorrectly.
      const sseDelivered = registry.routeToChannel(channel, "message", {
        content: msg.content,
        meta: msg.meta,
        source: msg.source,
      });
      // ALSO wake any HTTP MCP sessions on this channel — a session connected
      // over /mcp/<channel> (vs. the stdio bridge over /events) receives the
      // same inbound as a server-pushed notifications/claude/agent. Additive:
      // the SSE path above is untouched.
      const mcpDelivered = mcpPushToChannel(channel, msg.content, msg.meta);

      // Advance the per-channel delivery high-water-mark ONLY on a real delivery
      // (≥1 live subscriber across SSE bridges + MCP sessions). If nobody was
      // listening (delivered === 0) we deliberately leave the mark BEHIND so this
      // message replays the next time a session (re)connects — the spine of the
      // no-silent-loss fix. The note's ts rides in `meta.ts` (ingestInbound
      // flattens the note metadata, which carries the vault-written `ts`).
      const delivered = sseDelivered + mcpDelivered;
      const ts = msg.meta?.ts;
      if (delivered > 0 && typeof ts === "string" && ts) {
        deliveryState.advance(channel, ts);
      }
    },
    emitPermissionVerdict(v): void {
      registry.routeToChannel(channel, "permission_verdict", v);
      mcpPushPermissionVerdict(channel, v);
    },
  };
}

/**
 * Instantiate one channel entry, start its transport, and register it in the
 * LIVE channels map — the single per-channel "bring a channel up" path. Boot
 * (`main`) and the config-management hot-add both go through here so they can't
 * drift. If a channel with the same name is already live, its old transport is
 * stopped first (config-API replace semantics).
 *
 * `start()` is awaited so a hot-add only reports success once the transport is
 * actually receiving (e.g. the vault transport has fired its schema upsert). At
 * boot a throw is logged per-channel and doesn't abort the others; the config
 * API surfaces the throw to the caller as a 500.
 */
async function addChannelLive(
  channels: Map<string, Channel>,
  registry: ClientRegistry,
  entry: ChannelEntry,
  deliveryState: DeliveryState,
  programmatic?: ProgrammaticAgentRegistry,
  attachedQueue?: AttachedQueueRegistry,
): Promise<Channel> {
  const existing = channels.get(entry.name);
  if (existing) {
    // Replace: stop the old transport before swapping it out so it releases any
    // resources (pollers, SSE clients) before the new one starts.
    try {
      await existing.transport.stop();
    } catch (err) {
      console.error(`parachute-agent: stopping old transport for "${entry.name}" failed (continuing):`, err);
    }
    channels.delete(entry.name);
  }
  const transport = instantiateTransport(entry);
  const channel: Channel = { name: entry.name, transport, entry };
  channels.set(entry.name, channel);
  await transport.start(contextFor(registry, entry.name, deliveryState, programmatic, attachedQueue));
  return channel;
}

/**
 * Stop a live channel's transport and remove it from the map. Idempotent — a
 * missing name is a no-op returning false. The transport's `stop()` is awaited
 * so it releases resources before we drop the reference.
 */
async function removeChannelLive(
  channels: Map<string, Channel>,
  name: string,
): Promise<boolean> {
  const channel = channels.get(name);
  if (!channel) return false;
  try {
    await channel.transport.stop();
  } catch (err) {
    console.error(`parachute-agent: stopping transport for "${name}" failed (continuing):`, err);
  }
  channels.delete(name);
  return true;
}

// ---------------------------------------------------------------------------
// Vault-native agent definitions (design 2026-06-17-vault-native-agents, Phase 4a)
// ---------------------------------------------------------------------------

/**
 * Build the vault `ChannelEntry` for a vault-native agent's wake channel, from its
 * def-vault binding. The agent's conversation lives in its def-vault, so the channel
 * is a `vault` transport pointed at the SAME vault + token the def registry reads
 * from (own-vault scoping — 4a). This is the exact `ChannelEntry` shape the existing
 * create-agent flow + boot persist; we just synthesize it from the binding instead
 * of from channels.json (the note IS the definition).
 */
export function defVaultChannelEntry(name: string, binding: DefVaultBinding): ChannelEntry {
  return {
    name,
    transport: "vault",
    config: {
      vault: binding.vault,
      ...(binding.vaultUrl ? { vaultUrl: binding.vaultUrl } : {}),
      token: binding.token,
    },
  };
}

/**
 * Build the {@link InstantiateDeps} the {@link AgentDefRegistry} drives, wired to the
 * SAME machinery the create-agent flow + boot use — so a vault-defined agent comes up
 * byte-for-byte like a UI-created one, only its SOURCE differs (a note, not a form):
 *   - ensureChannel    → `addChannelLive` with a vault `ChannelEntry` from the binding;
 *   - setupAndRegister → `setupProgrammaticSpawn` (persist spec.json) + `programmatic.register`;
 *   - deregister       → `programmatic.deregister`;
 *   - removeChannel    → `removeChannelLive`.
 *
 * `setupProgrammaticSpawn` resolves the Claude credential early — a missing one
 * throws `CredentialNotConfiguredError`, which the registry catches + stamps the
 * note `status: error` (the agent can't run turns without auth; the note surfaces
 * the gap rather than registering a dead agent). Secrets stay local throughout.
 */
export function buildInstantiateDeps(
  channels: Map<string, Channel>,
  registry: ClientRegistry,
  deliveryState: DeliveryState,
  programmatic: ProgrammaticAgentRegistry,
  attachedQueue: AttachedQueueRegistry,
): InstantiateDeps {
  return {
    ensureChannel: async (name, binding) => {
      // EXPECT-BEFORE-LIVE (agent#121). Mark this channel EXPECTED to gain a programmatic
      // agent BEFORE we bring the channel transport live — closing the desync window: once
      // the channel is live the vault trigger can fire an inbound, but the agent isn't
      // `register()`ed until `setupAndRegister` runs (a later step). An inbound landing in
      // that window now QUEUES PENDING (owned, replayed on register) instead of dropping.
      // Harmless for a `channel`-backend agent — its inbound is handled by the attachedQueue
      // routing fork first, so the expected mark is never consulted for it. The mark is
      // cleared on register (the live index takes over) or on teardown (unexpectChannel).
      programmatic.expectChannel(normalizeChannel(name).name);
      await addChannelLive(
        channels,
        registry,
        defVaultChannelEntry(name, binding),
        deliveryState,
        programmatic,
        attachedQueue,
      );
    },
    setupAndRegister: async (spec) => {
      // ── BACKEND FORK (design 2026-06-18-channel-backend.md). An `attached` agent
      // does NOT register with the programmatic registry (no `claude -p`, no serial
      // worker) — it registers with the AttachedQueueRegistry, whose store is the
      // agent's live VaultTransport (the durable inbound-note queue). A `programmatic`
      // agent takes the existing path (persist spec.json + register the serial worker).
      //
      // DUAL-READ: a spec carrying the legacy backend value `"channel"` (un-normalized,
      // e.g. read straight from an old spec.json) is treated as `"attached"` here too —
      // belt-and-suspenders on top of the parse-path normalization in agent-defs.ts.
      if (spec.backend === "attached" || (spec.backend as string) === "channel") {
        const store = attachedQueueStoreFor(channels, spec.channels[0]);
        if (!store) {
          throw new Error(
            `cannot register attached-backend agent "${spec.name}": its wake channel is not a ` +
              `live vault transport (the queue needs the vault as its durable store)`,
          );
        }
        attachedQueue.register(spec, store);
        return;
      }
      // Persist spec.json (so boot re-register + per-turn deliver find the workspace)
      // then register — the same two steps the web programmatic spawn runs.
      setupProgrammaticSpawn(spec);
      await programmatic.register({ ...spec, backend: "programmatic" });
    },
    // Deregister covers BOTH registries — an agent lives in exactly one, and
    // deregister is a no-op (returns false) where it isn't registered. OR the two so
    // a reload/delete tears the agent down regardless of its backend.
    deregister: async (name) => {
      // Capture the wake channel BEFORE deregister drops the indexes, so we can clear the
      // EXPECTED mark + any stranded pending buffer for a genuinely-removed agent (agent#121
      // teardown — a deleted def must not leave its channel marked expected forever).
      const wakeChannel = programmatic.getByName(name)?.channel;
      const fromProgrammatic = await programmatic.deregister(name);
      const fromChannel = attachedQueue.deregister(name);
      if (wakeChannel) programmatic.unexpectChannel(wakeChannel);
      return fromProgrammatic || fromChannel;
    },
    removeChannel: async (name) => removeChannelLive(channels, name),
  };
}

/**
 * The real "add a def-vault" implementation behind `POST /api/agent-vaults`: mint the
 * vault's `vault:<name>:write` token (attenuated to the operator bearer, the SAME path
 * `resolveDefVaults` mints the default with), persist it into `agent-vaults.json`
 * (0600 — it carries a token), then `addVault` + `loadAll` for THAT vault so its defs
 * come up LIVE immediately (no restart). Re-resolves the manager bearer + hub origin at
 * request time (dynamic-read discipline — a credential set after boot is picked up).
 * Returns the non-secret view; throws on a missing operator token, a mint refusal, or
 * a duplicate vault. No-ops cleanly when no registry is wired.
 */
function defaultAddDefVault(
  agentDefs: AgentDefRegistry | undefined,
): (args: { vault: string; url?: string }) => Promise<{ vault: string; url: string; tokenPresent: boolean }> {
  return async ({ vault, url }) => {
    if (!agentDefs) {
      throw new Error("no def-vault registry configured (the vault-native agent path is idle)");
    }
    if (agentDefs.hasVault(vault)) {
      throw new Error(`def-vault "${vault}" is already configured`);
    }
    const vaultUrl = url && url.length > 0 ? url : DEFAULT_DEF_VAULT_URL;
    // Resolve the operator bearer + hub origin at request time (a credential set after
    // boot is picked up). A missing operator token → can't mint a child token.
    let managerBearer: string;
    try {
      managerBearer = resolveSpawnDeps().managerBearer;
    } catch {
      throw new Error(
        "cannot mint the def-vault token — no operator token (the hub isn't provisioned yet)",
      );
    }
    if (!managerBearer) {
      throw new Error(
        "cannot mint the def-vault token — no operator token (the hub isn't provisioned yet)",
      );
    }
    const minted = await mintScopedToken(
      { scope: vaultScope(vault, "write") },
      { hubOrigin: getHubOrigin() || DEFAULT_HUB_ORIGIN, managerBearer },
    );
    const binding: DefVaultBinding = { vault, vaultUrl, token: minted.token };
    // Persist into agent-vaults.json (merge: keep existing entries, append this one).
    // Source the existing set from the LIVE registry bindings (which carry the real
    // boot-minted tokens) — NOT a tokenless reconstruction from vaultNames(), which
    // would clobber a boot-minted default's token to empty on disk and 401 next boot.
    // Prefer the on-disk file when present (it's the durable record); fall back to the
    // live bindings when no file has been written yet.
    const stateDir = defaultStateDir();
    const existing = readDefVaultsFile(stateDir)?.vaults ?? agentDefs.liveBindings();
    const merged = [...existing.filter((v) => v.vault !== vault), binding];
    writeDefVaultsFile({ vaults: merged }, stateDir);
    // Bring the vault up LIVE: register it + load its defs now (the immediate path).
    // NOTE: loadAll() reloads ALL configured def-vaults, not just the one just added —
    // a slight over-read, acceptable at the current handful-of-vaults scale.
    agentDefs.addVault(binding);
    await agentDefs.loadAll();
    return { vault, url: vaultUrl, tokenPresent: true };
  };
}

/**
 * Build a {@link AttachedQueueStore} for a channel name from its live VaultTransport —
 * the durable inbound-note queue an ATTACHED-backend agent's connected session pulls
 * from (design 2026-06-18). Returns null when the channel isn't a live vault transport
 * (an attached agent's queue REQUIRES the vault as its source of truth). The store is a
 * thin adapter over the transport's `listInboundQueue` / `setInboundStatus` / `reply`
 * — the same `reply()` the programmatic worker uses, so the outbound is durable +
 * loop-safe (tagged `#agent/message/outbound`, which the inbound trigger never fires on).
 */
export function attachedQueueStoreFor(
  channels: Map<string, Channel>,
  channelName: string | { name: string } | undefined,
): AttachedQueueStore | null {
  const name = typeof channelName === "string" ? channelName : channelName?.name;
  if (!name) return null;
  const vt = channels.get(name)?.transport;
  if (!(vt instanceof VaultTransport)) return null;
  return {
    listInboundQueue: (opts) => vt.listInboundQueue(opts),
    // Forward ALL FOUR args — the 4th `ifUpdatedAt` is the CAS precondition the
    // single-claim guard (agent#101) depends on. A 3-arg arrow silently dropped it,
    // collapsing every claim to `force:true` (last-write-wins) and DISABLING the CAS in
    // production (the double-claim race PR #116 closed was re-opened for attached agents).
    setInboundStatus: (id, status, claimedAt, ifUpdatedAt) =>
      vt.setInboundStatus(id, status, claimedAt, ifUpdatedAt),
    reply: async (args) => {
      return vt.reply({
        channel: name,
        text: args.text,
        ...(args.inReplyTo ? { meta: { in_reply_to: args.inReplyTo } } : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Programmatic-agent backend wiring (design 2026-06-16)
// ---------------------------------------------------------------------------

/**
 * Build the {@link WriteOutbound} the programmatic registry posts a turn's reply
 * through: resolve the channel's transport from the live `channels` map and call its
 * `reply()` — the SAME outbound path the interactive `reply` tool uses, so a
 * programmatic reply is durable + renders in the chat UI exactly like an
 * interactive one. For a VaultTransport this writes a `#agent/message/outbound`
 * note; the vault inbound trigger keys on `#agent/message/inbound`, so writing the
 * reply CANNOT re-trigger the inbound webhook (verified: no loop). `inReplyTo`
 * threads the reply to the inbound note id.
 *
 * A missing transport (channel deregistered between the turn + its reply) throws —
 * the registry's drain logs it and moves on; it never re-runs the turn (which would
 * fork the conversation).
 */
export function buildWriteOutbound(channels: Map<string, Channel>): WriteOutbound {
  return async (channel, reply, inReplyTo, threadId) => {
    const ch = channels.get(channel);
    if (!ch) {
      throw new Error(`no live transport for channel "${channel}" — cannot post the reply`);
    }
    // Carry the in-reply-to + the per-turn thread id through the transport's `meta` escape
    // hatch. The vault transport stamps `meta.thread` into the outbound note's
    // `metadata.thread` — the explicit definition→thread→message link the outbound note
    // gets (multi-threaded: the per-fire note leaf; single-threaded: a per-turn id).
    const meta: Record<string, string> = {};
    if (inReplyTo) meta.in_reply_to = inReplyTo;
    if (threadId) meta.thread = threadId;
    const sent = await ch.transport.reply({
      channel,
      text: reply,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    });
    // Surface the written outbound note id so the agent-to-agent callback can point its
    // `source_message` at it (the orchestrator pulls the full reply from there). `reply()`
    // returns `{ sent: [noteId] }`; the first id is the note. Absent/empty → undefined,
    // and the callback simply omits source_message.
    return { ...(sent?.sent?.[0] ? { id: sent.sent[0] } : {}) };
  };
}

/**
 * Build the {@link WriteThread} the programmatic registry posts each turn's thread note
 * through — the UNIFIED model, called for BOTH modes (the structural unification: every
 * turn materializes a thread note). Resolve the channel's transport from the live
 * `channels` map and call its `writeThread()` (a VaultTransport writes a `#agent/thread`
 * note; single-threaded upserts one note per channel, multi-threaded writes one per fire).
 * A transport without a durable store (telegram) has no `writeThread`; we no-op there (the
 * turn still runs — it just leaves no thread note). A missing transport (channel
 * deregistered between the turn + its thread record) throws; the registry logs it and moves
 * on (it never re-runs the turn).
 */
export function buildWriteThread(channels: Map<string, Channel>): WriteThread {
  return async (thread) => {
    const ch = channels.get(thread.channel);
    if (!ch) {
      throw new Error(
        `no live transport for channel "${thread.channel}" — cannot write the thread note`,
      );
    }
    // Only a transport with a durable store implements writeThread (the VaultTransport).
    if (!ch.transport.writeThread) return;
    const written = await ch.transport.writeThread({
      channel: thread.channel,
      ...(thread.name ? { name: thread.name } : {}),
      ...(thread.definition ? { definition: thread.definition } : {}),
      mode: thread.mode,
      status: thread.status,
      input: thread.input,
      output: thread.output,
      started_at: thread.started_at,
      ended_at: thread.ended_at,
      ...(thread.usage ? { usage: thread.usage } : {}),
      // The Claude session UUID — persisted to the note's `metadata.session` (thread≡session
      // record) so the next turn `--resume`s it (read back via `readThreadSession`).
      ...(thread.session ? { session: thread.session } : {}),
      // Forward the per-turn thread id + same-turn flag + lifecycle phase to the transport.
      // These are LOAD-BEARING (not optional decoration):
      //  - threadId — multi-threaded targets the SAME per-fire note across the start-ensure,
      //    the end-record, AND the outbound-failure re-record (else each mints a duplicate).
      //  - sameTurn — the outbound-failure re-record keeps turn_count (no double-count).
      //  - phase    — `start` (working-ensure: turn_count UNCHANGED) vs `end` (turn counted).
      ...(thread.threadId ? { threadId: thread.threadId } : {}),
      ...(thread.sameTurn ? { sameTurn: true } : {}),
      ...(thread.phase ? { phase: thread.phase } : {}),
    });
    // Surface the WRITTEN note id so the drain can set a RESOLVABLE callback `source_thread`
    // (agent#124). `writeThread` returns `{ sent: [id] }` — the id is the actual note an
    // orchestrator can pull with `query-notes { id }` for BOTH modes (single-threaded: the
    // deterministic `Threads/<safeChannel>/<safeName>` note; multi-threaded: the per-fire
    // `Threads/<safeChannel>/<uuid>` note). Empty/absent → undefined (the drain falls back).
    const id = written?.sent?.[0];
    return id ? { id } : undefined;
  };
}

/**
 * Build the {@link WriteCallback} the programmatic registry delivers an agent-to-agent
 * completion callback through (the "reply_to" substrate). Resolve the SENDER's (`reply_to`)
 * channel transport from the live `channels` map and write a CALLBACK inbound note there
 * (`writeCallback` → a `#agent/message/inbound` note + the {@link CallbackMetadata}
 * contract). The vault trigger on that note wakes the sender's agent through the normal
 * inbound path — so an orchestrator is resumed by its own channel exactly as if a human
 * had messaged it, and the per-channel serial drain handles N returning callbacks FIFO.
 *
 * UNKNOWN / not-live reply_to channel (reuses the #122 own-it-don't-strand posture): if the
 * channel has no live VaultTransport, we LOG and return WITHOUT throwing — a callback that
 * can't be delivered must not crash the recipient's drain or strand its queue. (We don't
 * throw — unlike buildWriteOutbound/buildWriteThread, where a missing transport IS an error
 * worth surfacing — because a callback is best-effort orchestration sugar: the recipient's
 * turn already ran + recorded; only the onward notification is lost, and the sender can still
 * poll the recipient's thread/transcript out-of-band.)
 *
 * LOOP SAFETY: `writeCallback` writes the inbound WITHOUT a `reply_to` (terminal callback),
 * so the woken sender's turn cannot auto-emit another callback. Verified end-to-end:
 * callback note → vault trigger → /api/vault/inbound → contextFor.emit → the sender's drain;
 * `callbackFieldsFromMeta` finds no `reply_to`, so `maybeDeliverCallback` no-ops there.
 */
export function buildWriteCallback(channels: Map<string, Channel>): WriteCallback {
  return async (channel, content, meta) => {
    const ch = channels.get(channel);
    const vt = ch?.transport instanceof VaultTransport ? ch.transport : undefined;
    if (!vt || !vt.writeCallback) {
      // Own-it-don't-strand: no live vault transport for the reply_to channel. The sender
      // may have been torn down, or never been a vault-backed channel. Log + drop — the
      // recipient turn already completed + recorded; we never throw (which would surface as
      // an error in the recipient's drain).
      console.warn(
        `parachute-agent: callback for source "${meta.source_channel}" could not be delivered ` +
          `— reply_to channel "${channel}" has no live vault transport (dropping the callback; ` +
          `the turn itself completed + recorded normally).`,
      );
      return;
    }
    // `meta` is the registry's CallbackMeta; the transport's CallbackMetadata is the
    // structurally-identical local mirror (the transport layer doesn't import the backend
    // layer), so it passes without a cast.
    await vt.writeCallback(content, meta);
  };
}

/**
 * Build the {@link ProgrammaticAgentRegistry}'s pre-turn session read — the thread≡session
 * record. Resolve the channel's transport from the live `channels` map and read the
 * persisted Claude session UUID off its deterministic `#agent/thread` note (only the
 * VaultTransport implements `readThreadSession`; telegram/http-ui omit it → undefined →
 * the turn creates a fresh session). The registry calls this BEFORE a single-threaded turn
 * so the turn `--resume`s its prior conversation. Mirrors {@link buildWriteThread}.
 */
export function buildReadSession(
  channels: Map<string, Channel>,
): (channel: string, name: string) => Promise<string | undefined> {
  return async (channel, name) => {
    const ch = channels.get(channel);
    if (!ch?.transport.readThreadSession) return undefined;
    return ch.transport.readThreadSession(channel, name);
  };
}

/**
 * Build the {@link ProgrammaticAgentRegistry}'s session CLEAR — the per-agent restart /
 * reset. Resolve the channel's transport and wipe the persisted session on its
 * deterministic `#agent/thread` note (only the VaultTransport implements
 * `clearThreadSession`; telegram/http-ui omit it → a clean no-op). `resetSession` calls
 * this so the agent's NEXT turn finds no session and starts a fresh claude conversation.
 * Mirrors {@link buildReadSession}.
 */
export function buildClearSession(
  channels: Map<string, Channel>,
): (channel: string, name: string) => Promise<void> {
  return async (channel, name) => {
    const ch = channels.get(channel);
    if (!ch?.transport.clearThreadSession) return;
    await ch.transport.clearThreadSession(channel, name);
  };
}

/**
 * Build the REAL programmatic-agent registry — the {@link ProgrammaticBackend}
 * wired to the env-resolved spawn deps, plus the outbound-write + thread-note +
 * session-read seams over the live `channels`. The session UUID lives on the durable
 * `#agent/thread` note (`metadata.session`) — read pre-turn via `readSession`
 * ({@link buildReadSession}) and persisted post-turn via `writeThread` — there is no
 * separate session store. Lazily defaulted by `createFetchHandler` and constructed
 * explicitly by `main` (so the same instance the routes use is the one the transports'
 * `contextFor` enqueues onto).
 *
 * Best-effort on the backend deps: if the operator token / hub origin can't be
 * resolved yet, the backend still constructs (its mint happens per-turn and will
 * surface the error there as a `{ ok: false }` — not at boot), so a daemon with no
 * hub provisioned yet still starts and can register programmatic agents.
 */
export function createDefaultProgrammaticRegistry(
  channels: Map<string, Channel>,
  onTurnEvent?: TurnEventSink,
): ProgrammaticAgentRegistry {
  // Resolve the spawn deps lazily/defensively — a missing operator token must not
  // crash boot (the interactive path resolves per-spawn too). We read what we can
  // and let the per-turn mint surface any gap as a failure-value.
  let backendDeps: ProgrammaticBackendDeps;
  try {
    const deps = resolveSpawnDeps();
    backendDeps = {
      hubOrigin: deps.hubOrigin,
      managerBearer: deps.managerBearer,
      ...(deps.vaultUrl ? { vaultUrl: deps.vaultUrl } : {}),
      sessionsDir: deps.sessionsDir,
      runtimeReadOnly: deps.runtimeReadOnly,
      spawnFn: realProgrammaticSpawn(),
      ...(deps.claudeBin ? { claudeBin: deps.claudeBin } : {}),
      // 4b: the hub grants client — reuses the manager bearer (same operator token
      // the vault-token mint uses). Lets each `claude -p` turn inject the agent's
      // APPROVED cross-resource grants (other-vault MCP, service env/MCP). design
      // 2026-06-17-agent-connectors-4b.md.
      grants: new GrantsClient({ hubOrigin: deps.hubOrigin, managerBearer: deps.managerBearer }),
    };
  } catch {
    // No operator token yet — construct with placeholders; a per-turn mint will
    // fail cleanly (as a value) until the hub is provisioned. The registry + queue
    // still work; only the actual `claude -p` turn needs the credential.
    backendDeps = {
      hubOrigin: "",
      managerBearer: "",
      sessionsDir: defaultSessionsDir(),
      runtimeReadOnly: [],
      spawnFn: realProgrammaticSpawn(),
    };
  }
  const backend = new ProgrammaticBackend(backendDeps);
  return new ProgrammaticAgentRegistry({
    backend,
    writeOutbound: buildWriteOutbound(channels),
    writeThread: buildWriteThread(channels),
    writeCallback: buildWriteCallback(channels),
    readSession: buildReadSession(channels),
    clearSession: buildClearSession(channels),
    ...(onTurnEvent ? { onTurnEvent } : {}),
  });
}

/**
 * Build the {@link TurnEventSink} that pushes a programmatic turn's live progress
 * (interim assistant text + tool_use, plus the registry's done/error lifecycle
 * events) to the channel's turn-event SSE subscribers — the chat UI's "watch it
 * work" view (design 2026-06-16 build item #1).
 *
 * Transport choice (documented in the PR): a DEDICATED per-channel SSE stream
 * (`/api/channels/<ch>/turn-events`) over the existing {@link ClientRegistry},
 * NOT the durable-message poll. Rationale — the chat already POLLs vault channels
 * for their DURABLE transcript (the `#agent/message` notes, the record of truth);
 * turn progress is EPHEMERAL and chunk-frequent, so polling would be coarse + would
 * surface partial state as if durable. An SSE stream is the clean real-time fit and
 * reuses the registry/`sseFrame` infra already in the daemon. The durable path is
 * untouched: the final `result` still becomes the `#agent/message/outbound` note,
 * and the live stream is purely additive progress that the UI finalizes against it.
 *
 * Keyed by channel; fans out to every subscriber on that channel. A 0-subscriber
 * turn is a clean no-op (the events drop; the durable note still lands) — there is
 * no high-water-mark / replay for live progress (it's ephemeral by design).
 */
export function buildTurnEventSink(turnEvents: ClientRegistry): TurnEventSink {
  return (channel, event) => {
    // routeToChannel swallows dead-stream enqueues (drops the client); a 0-subscriber
    // channel returns 0 delivered — both are fine, progress is best-effort.
    turnEvents.routeToChannel(channel, "turn", event);
  };
}

/**
 * Map the registered programmatic agents to the {@link AgentInfo} shape the
 * `/api/agents` list returns — `backend: "programmatic"` + a live `status`
 * (`idle` | `working` | `queued:N`) in place of the interactive `attached`/
 * `mcp_sessions` liveness (design 2026-06-16 step 6). No tmux session, so `session`
 * is the conventional `<name>-agent` label for display continuity and `attached` is
 * always false.
 */
export function listProgrammaticAgents(programmatic: ProgrammaticAgentRegistry): AgentInfo[] {
  const dir = defaultSessionsDir();
  return programmatic
    .list()
    .map((h) => {
      const s = programmatic.statusOf(h.channel);
      const status = s.state === "queued" ? `queued:${s.queued}` : s.state;
      const workspace = sessionWorkspace(dir, h.name);
      const hasPrompt = typeof h.spec.systemPrompt === "string" && h.spec.systemPrompt.length > 0;
      // Surface the working dir only when set AND still present on disk (a deleted
      // dir post-spawn shouldn't show a dead-path badge — mirrors `hasWorkspace`).
      const hasWorkingDir =
        typeof h.spec.workspace === "string" && h.spec.workspace.length > 0 && existsSync(h.spec.workspace);
      return {
        name: h.name,
        session: `${h.name}-agent`,
        workspace,
        hasWorkspace: existsSync(join(workspace, "spec.json")),
        backend: "programmatic" as const,
        status,
        ...(hasPrompt ? { systemPromptMode: h.spec.systemPromptMode ?? "append" } : {}),
        ...(hasWorkingDir ? { workingDir: h.spec.workspace } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Map the registered CHANNEL-backend agents to the {@link AgentInfo} shape the
 * `/api/agents` list returns (#102 — the v2 API layer stops rejecting `channel`).
 * A channel agent has no tmux session + no daemon-run turn: its turns are handled by
 * a Claude Code session the operator connects to the channel's MCP endpoint, and the
 * inbound notes accumulate as a durable queue. So `attached` is always false, the
 * `session` label is the conventional `<name>-agent` for display continuity, and the
 * live `status` is `queued:N` (N = pending inbound waiting for the connected session)
 * or `idle`. The pending counts are read from the queue in parallel (one vault read
 * each) — best-effort: a queue read failure degrades that agent's status to `idle`,
 * never failing the whole list. NEVER surfaces a token/secret.
 */
export async function listAttachedAgents(attachedQueue: AttachedQueueRegistry): Promise<AgentInfo[]> {
  const dir = defaultSessionsDir();
  const records = attachedQueue.list();
  return Promise.all(
    records.map(async (rec) => {
      let status = "idle";
      try {
        const view = await attachedQueue.pending(rec.channel);
        status = view.count > 0 ? `queued:${view.count}` : "idle";
      } catch {
        // A queue read failure shouldn't sink the list — show idle, not an error.
      }
      const workspace = sessionWorkspace(dir, rec.name);
      const info: AgentInfo = {
        name: rec.name,
        session: `${rec.name}-agent`,
        workspace,
        hasWorkspace: existsSync(join(workspace, "spec.json")),
        backend: "attached",
        status,
        channel: rec.channel,
        ...(rec.systemPrompt ? { systemPromptMode: "append" as const } : {}),
        ...(rec.vault ? { vault: rec.vault } : {}),
      };
      return info;
    }),
  ).then((infos) => infos.sort((a, b) => a.name.localeCompare(b.name)));
}

/**
 * BOOT RE-REGISTER (design 2026-06-16 step 2). Scan the per-session workspaces under
 * the sessions dir, read each `spec.json`, and re-register every spec whose
 * `backend === "programmatic"` into the live registry — so a programmatic agent,
 * which has no resident process to survive a restart, resumes routing inbound to an
 * on-demand turn after a daemon restart. The session UUID lives on the `#agent/thread`
 * note (`metadata.session`), so that next turn reads it back + `--resume`s the prior
 * conversation, so no message is lost in the restart window beyond the normal
 * inbound-trigger durability.
 *
 * INTERACTIVE specs are SKIPPED — their tmux sessions survive a daemon restart on
 * their own (or are restarted via the supervisor), and re-registering them here
 * would be wrong (they aren't programmatic). Best-effort: an unreadable spec / a
 * register failure is logged per-agent and never aborts boot. Returns the count
 * re-registered. `sessionsDirPath` is injectable for tests.
 *
 * ORPHAN GUARD (agent#75 — defense-in-depth). A spec dir is durable cruft: it can
 * outlive the channel it was spawned for (a deleted agent whose workspace wasn't
 * swept, a crash mid-spawn, a leaked test fixture, a hand-copied dir). Re-registering
 * a programmatic agent whose wake channel ISN'T in the live channels config would
 * resurrect a PHANTOM agent — one with nothing to receive for (no live channel feeds
 * it inbound), confusing the operator and the agent list. So we re-register ONLY a
 * spec whose wake channel STILL EXISTS in `channels` (the live channels.json-derived
 * map); a spec for a missing channel is SKIPPED with a one-line notice, making any
 * orphaned/leaked spec dir inert. The wake channel is keyed exactly as the registry
 * keys it (`normalizeChannel(spec.channels[0]).name` — see `ProgrammaticAgentRegistry`).
 * A spec with an EMPTY channels array is also skipped (it has no wake channel to key /
 * route on — re-registering it would throw at the registry's channelOf).
 */
export async function reregisterProgrammaticAgents(
  programmatic: ProgrammaticAgentRegistry,
  channels: Map<string, Channel>,
  sessionsDirPath: string = defaultSessionsDir(),
): Promise<number> {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDirPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // No sessions dir yet (first boot) — nothing to re-register.
    return 0;
  }
  let count = 0;
  for (const name of entries) {
    const workspace = sessionWorkspace(sessionsDirPath, name);
    const spec = readPersistedSpec(workspace);
    // Re-register ONLY specs that explicitly persisted `backend: "programmatic"`.
    // A spec with no `backend` field (pre-field, was interactive) or the retired
    // `backend: "interactive"` value is SKIPPED — the interactive backend was retired
    // 2026-06-19 (design 2026-06-19-retire-interactive-backend.md), so a stale
    // interactive spec on disk is inert: never migrated to programmatic, never launched.
    if (!spec || spec.backend !== "programmatic") continue;
    // ORPHAN GUARD: a spec with no wake channel, or whose wake channel isn't a live
    // channel, has nothing to receive for — skip it so a leaked/stale spec dir can't
    // resurrect a phantom agent. Keyed exactly as the registry keys the channel.
    const wakeChannel = spec.channels[0]
      ? normalizeChannel(spec.channels[0]).name
      : undefined;
    if (!wakeChannel) {
      console.log(
        `parachute-agent: skipping re-register of "${spec.name}" — spec declares no channel.`,
      );
      continue;
    }
    if (!channels.has(wakeChannel)) {
      console.log(
        `parachute-agent: skipping re-register of "${spec.name}" — channel "${wakeChannel}" not configured.`,
      );
      continue;
    }
    try {
      await programmatic.register(spec);
      count++;
      console.log(`parachute-agent: re-registered programmatic agent "${spec.name}" (channel ${wakeChannel}).`);
    } catch (err) {
      console.error(
        `parachute-agent: failed to re-register programmatic agent "${name}" from spec.json: ${(err as Error).message}`,
      );
    }
  }
  if (count > 0) {
    console.log(`parachute-agent: re-registered ${count} programmatic agent(s) from persisted specs.`);
  }
  return count;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 302-redirect a retired server-rendered page to the v2 SPA (Phase 4c). The
 * Location is RELATIVE so the browser resolves it against the request URL,
 * working both daemon-direct (`/ui` → `/app/...`) and hub-proxied (`/agent/ui`
 * → `/agent/app/...`) without the daemon needing to know its public mount
 * (the hub strips the `/agent` prefix before the daemon ever sees the path).
 *
 * From a single-segment page like `/ui` or `/agents`, a relative `app/` target
 * resolves to `/app/` (and `app/chat` → `/app/chat`); the SPA's BrowserRouter
 * (basename `/app` or `/agent/app`) then renders the matching route.
 */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

// ---------------------------------------------------------------------------
// Auth gates
//
// Both layers share `requireScope` from `auth.ts` (validate a hub-issued JWT
// against the hub's JWKS via scope-guard, assert a scope). It accepts the token
// from an `Authorization: Bearer` header OR a `?token=` query param.
//
// Layer 1 — bridge / session↔channel. The session↔channel connection is
// authenticated with hub-issued JWTs, exactly like a vault MCP client. A
// launched session has full machine access, so we do NOT rely on loopback trust
// — any session on any machine presents a hub token (`aud: "agent"`, scopes
// `agent:read`/`agent:write`) as a Bearer header and the daemon validates
// it against the hub's JWKS. Scope split: subscribing to inbound events is
// `agent:read`; sending anything out (reply/react/edit/permission/download)
// is `agent:write`.
//
// Layer 2 — human / chat UI — gates the http-ui transport's `send` (POST,
// `agent:send`, Bearer) with `requireScope`. The browser SSE streams
// (`/ui/events`, `/api/channels/<ch>/turn-events`, `agent:read`) gate on a
// ONE-TIME ticket (`requireSseTicket`) instead of a `?token=<JWT>` query —
// `EventSource` can't set a header, and a JWT in a URL leaks into access logs
// (agent#25). The page mints the ticket at `POST /api/ui/sse-ticket` (Bearer,
// agent:read) and opens `…?ticket=<nonce>`; the ticket is single-use + ≤60s and
// carries only the minting token's scopes.
//
// Discovery + the page itself (/health, /.parachute/config[/schema], /ui) stay
// OPEN — non-sensitive, and /ui must load to bootstrap its token fetch.
// ---------------------------------------------------------------------------

/**
 * Decide whether a terminal WebSocket upgrade is authorized + which tmux session
 * it targets. Pure over its inputs (no `server.upgrade`, no pty) so the auth +
 * routing layer is unit-testable without a live hub or a real socket — the same
 * shape the HTTP gate tests rely on.
 *
 * Auth: OPERATOR-GATED on `agent:admin` (`SCOPE_TERMINAL`). The token rides in
 * as a `?token=` query param (browsers can't set Authorization on
 * `new WebSocket()`), so `allowQueryParam: true`. The no-token path
 * short-circuits to 401 before any JWKS fetch (testable offline).
 *
 * The path segment is an AGENT name — the tmux session is `<name>-agent`. An agent
 * has its OWN name (chosen at spawn), which is NOT necessarily a configured
 * channel (the 1:1 channel↔session assumption from the launch-session.sh era no
 * longer holds — an operator can name an agent anything). So we DON'T require the
 * name to be a known channel; we slug-guard it (it lands UNESCAPED in a tmux `-t`
 * target) and let the attach handle a non-existent session — `tmux attach` to a
 * missing session fails cleanly and the relay closes 1000 ("session ended"), no
 * reconnect loop. Operator-only behind agent:admin, so there's no enumeration
 * concern. (`channels` is no longer consulted; kept in the signature for the
 * stable call shape.)
 *
 * Returns either `{ ok: true, ... }` with the tmux session name (`<name>-agent`)
 * + the client's requested geometry, or `{ ok: false, response }` carrying the
 * deny Response the caller returns as-is.
 */
export async function authorizeTerminalUpgrade(
  req: Request,
  url: URL,
  _channels: Map<string, Channel>,
  agentName: string,
): Promise<
  | { ok: true; channel: string; session: string; cols: number; rows: number }
  | { ok: false; response: Response }
> {
  // Slug-guard: the name lands unescaped in a tmux `-t <session>` target and the
  // session string `<name>-agent`. Reject anything that isn't a strict slug.
  if (!AGENT_NAME_SLUG.test(agentName)) {
    return {
      ok: false,
      response: authJson(
        { error: `invalid agent name "${agentName}" (alphanumeric, dash, underscore only)` },
        400,
      ),
    };
  }
  // Operator-grade gate. allowQueryParam: true — the only way a browser
  // WebSocket can present the token (no Authorization header on `new WebSocket`).
  const denied = await requireScope(req, url, SCOPE_TERMINAL, true);
  if (denied) return { ok: false, response: denied };

  // STEP-UP required (agent#80): a terminal is a raw host shell — the single most
  // dangerous capability. allowQueryParam: true so the WS presents the step-up
  // token as `?step_up=` (it can't set the `X-Step-Up-Token` header).
  const step = requireStepUp(req, url, true);
  if (!step.ok) return { ok: false, response: step.response };

  // tmux session name convention: `<name>-agent`. Attach a viewer pty to THIS
  // session; the session itself is created by the spawn path.
  const session = `${agentName}-agent`;
  const cols = clampQueryDim(url.searchParams.get("cols"), 80);
  const rows = clampQueryDim(url.searchParams.get("rows"), 24);
  return { ok: true, channel: agentName, session, cols, rows };
}

/** Is this request a WebSocket upgrade? (case-insensitive `Upgrade: websocket`). */
export function isWebSocketUpgrade(req: Request): boolean {
  return (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

/**
 * Coerce an untrusted JSON object into a `Record<string,string>` for a def note's
 * extra metadata bag — every value stringified (the vault stores metadata as strings).
 * Non-object input yields an empty map. Used by the agent-def write routes so a caller
 * passing `{ workspace: "/x", filesystem: "workspace" }` lands as string metadata.
 */
function coerceStringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined || val === null) continue;
    out[k] = typeof val === "string" ? val : String(val);
  }
  return out;
}

/** Parse + clamp a `?cols=`/`?rows=` query dim to [1, 9999], with a fallback. */
function clampQueryDim(raw: string | null, fallback: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n > 9999 ? 9999 : n;
}

/**
 * Build the daemon's HTTP fetch handler over a channel registry + client
 * registry. Extracted as a factory so tests can exercise routing + the auth
 * gate on an ephemeral `Bun.serve` without booting the real daemon (and without
 * a live hub — the no-token 401 path short-circuits before JWKS).
 *
 * `server` is the `Bun.serve` instance (passed as `fetch`'s 2nd arg at runtime),
 * needed for `server.upgrade()` on the terminal WS route. It's optional so the
 * existing tests (which call the handler with one arg) keep working — a terminal
 * upgrade request with no server falls through to the normal 426-style refusal.
 */
export function createFetchHandler(
  channels: Map<string, Channel>,
  registry: ClientRegistry,
  opts?: {
    deliveryState?: DeliveryState;
    programmatic?: ProgrammaticAgentRegistry;
    /**
     * The ATTACHED-backend queue registry (design 2026-06-18-channel-backend.md) — the
     * durable inbound-note queue + claim tracker a connected Claude Code session pulls
     * from via the channel MCP surface (`next-message` / `pending` / `reply` /
     * `release`). `main` passes the boot instance (the SAME one the transports'
     * `contextFor` routing fork checks); tests inject a fake-store-backed instance.
     * Optional — when absent, the channel MCP tools no-op (no attached agents).
     */
    attachedQueue?: AttachedQueueRegistry;
    /**
     * The per-channel turn-event SSE registry (the streaming view, design build
     * item #1). The `/api/channels/<ch>/turn-events` SSE route registers subscribers
     * here; the programmatic registry's turn-event sink fans out to them. `main`
     * passes the boot instance (the SAME one the lazily-defaulted programmatic
     * registry pushes to); tests inject one to assert the live-progress fan-out.
     */
    turnEvents?: ClientRegistry;
    /**
     * The vault-native scheduled-job store (runner, design 2026-06-17). The
     * `/api/jobs*` routes read/write through it. `main` passes the boot instance
     * (shared with the runner); tests inject one (or let it default lazily) to
     * exercise the routes against a fake-vault transport.
     */
    jobStore?: VaultJobStore;
    /**
     * The runner — used by `POST /api/jobs/:id/run` (fire now). `main` passes the
     * boot instance; tests inject a fake. Optional: if absent, the run-now route
     * fires inline via the job store + the channel's `injectInbound` (so the route
     * still works in a plain createFetchHandler).
     */
    runner?: Runner;
    /**
     * The vault-native agent-def registry (design 2026-06-17-vault-native-agents,
     * Phase 4a). The `POST /api/vault/agent-def` reload webhook drives it. `main`
     * passes the boot instance; tests inject one. Optional — when absent, the reload
     * route is a clean no-op ack (a daemon with no def-vaults configured).
     */
    agentDefs?: AgentDefRegistry;
    /**
     * Add a def-vault to the live registry — the `POST /api/agent-vaults` body of work
     * (mint the vault's write token, persist `agent-vaults.json`, `addVault` + `loadAll`
     * for it). Injected so tests exercise the route WITHOUT a live hub mint or a real
     * vault; `main` leaves it unset and the route uses the real mint
     * (`mintScopedToken`) + the persisted-file path. Returns the resulting binding's
     * non-secret view (name + url + token-present).
     */
    addDefVault?: (args: { vault: string; url?: string }) => Promise<{
      vault: string;
      url: string;
      tokenPresent: boolean;
    }>;
    /**
     * The boot dependency-PREFLIGHT result (agent#156) — surfaced on `/health` so the
     * admin UI can show that programmatic turns will fail until the missing deps
     * (`bwrap`/`rg`/`socat`/`claude`) are installed. `main` passes the boot check;
     * absent (a plain createFetchHandler / tests) → omitted from `/health`.
     */
    preflight?: PreflightResult;
  },
): (req: Request, server?: { upgrade: (req: Request, opts: { data: TerminalWsData }) => boolean }) => Promise<Response> {
  // The per-channel turn-event SSE registry — subscribers of the live "watch it
  // work" stream. Defaulted to a fresh instance so a plain createFetchHandler still
  // serves the route; `main` shares its boot instance so the lazily-defaulted
  // programmatic registry below pushes to the SAME subscribers the route registers.
  const turnEvents: ClientRegistry = opts?.turnEvents ?? new ClientRegistry();

  // The programmatic-agent registry (design 2026-06-16) — inbound for a registered
  // channel routes to an on-demand `claude -p` turn instead of a push. `main`
  // constructs the real one (with the real backend + the outbound-write wiring);
  // tests inject a fake-backed instance. Defaulted lazily to the real registry so a
  // plain `createFetchHandler(channels, registry)` still wires programmatic agents —
  // and threads the turn-event sink so its turns stream to this handler's `turnEvents`.
  const programmatic: ProgrammaticAgentRegistry =
    opts?.programmatic ?? createDefaultProgrammaticRegistry(channels, buildTurnEventSink(turnEvents));

  // The CHANNEL-backend queue registry (design 2026-06-18). `main` shares its boot
  // instance (the SAME one the transports' `contextFor` routing fork checks + the
  // channel MCP surface dispatches to). Defaulted to a fresh instance so a plain
  // createFetchHandler still serves the channel MCP tools (it just has no channel
  // agents registered until one is instantiated). Tests inject a fake-store-backed one.
  const attachedQueue: AttachedQueueRegistry = opts?.attachedQueue ?? new AttachedQueueRegistry();

  // Per-channel delivery high-water-mark store (durable infra). `contextFor.emit`
  // advances it on a real delivery; the daemon's `main` passes the boot-time
  // instance, tests get a throwaway whose default mark is "now". (The deaf-on-restart
  // backlog replay that used to READ this mark was retired with the interactive
  // backend — design 2026-06-19-retire-interactive-backend.md.)
  const deliveryState: DeliveryState = opts?.deliveryState ?? new DeliveryState();

  // The vault-native scheduled-job store (runner, design 2026-06-17). Defaulted to
  // a fresh store over the live channels so a plain createFetchHandler serves the
  // /api/jobs routes; `main` shares its boot instance with the runner so the routes
  // and the scheduler operate on the same vault.
  const jobStore: VaultJobStore = opts?.jobStore ?? new VaultJobStore(channels);

  // The vault-native agent-def registry (Phase 4a). Optional — when absent the
  // reload webhook is a no-op ack (a daemon with no def-vaults). `main` passes the
  // boot instance so the route reloads the same set the boot instantiated.
  const agentDefs: AgentDefRegistry | undefined = opts?.agentDefs;

  // Add-a-def-vault (the `POST /api/agent-vaults` body of work). Defaulted to the real
  // mint + persist path so a plain createFetchHandler serves the route; tests inject a
  // stub so the route is exercised WITHOUT a live hub mint or a real vault. Returns the
  // resulting binding's non-secret view (name + url + token-present).
  const addDefVault = opts?.addDefVault ?? defaultAddDefVault(agentDefs);

  /** Resolve the transport for a channel name, or null on miss. */
  function transportFor(channel: string | undefined): Transport | null {
    if (!channel) return null;
    return channels.get(channel)?.transport ?? null;
  }

  function channelError(channel: string | undefined): Response {
    if (!channel) {
      return json({ error: "missing 'channel' field in request body" }, 400);
    }
    return json(
      {
        error: `unknown channel "${channel}" — known channels: ${[...channels.keys()].join(", ") || "(none)"}`,
      },
      400,
    );
  }

  function methodMissing(channel: string, method: string): Response {
    const kind = channels.get(channel)?.transport.kind ?? "unknown";
    return json(
      { error: `transport "${kind}" for channel "${channel}" does not support ${method}` },
      400,
    );
  }

  // Idempotency for the vault inbound webhook: a small bounded set of recently-
  // seen note ids so a duplicate trigger delivery doesn't double-wake the
  // session. Bounded by eviction (oldest-out) so it can't grow unbounded.
  const seenInboundNoteIds = new Set<string>();
  const SEEN_INBOUND_CAP = 2048;
  function markSeen(noteId: string): boolean {
    if (seenInboundNoteIds.has(noteId)) return false; // already processed
    seenInboundNoteIds.add(noteId);
    if (seenInboundNoteIds.size > SEEN_INBOUND_CAP) {
      // Evict the oldest insertion (Set preserves insertion order).
      const oldest = seenInboundNoteIds.values().next().value;
      if (oldest !== undefined) seenInboundNoteIds.delete(oldest);
    }
    return true;
  }

  return async function fetch(req, server) {
    const url = new URL(req.url);

    // -------------------------------------------------------------------
    // Terminal WebSocket upgrade — `/terminal/<agent>` (design §5).
    //
    // The in-page xterm.js terminal attaches to the channel's tmux session
    // (`<channel>-agent`) via Bun's native pty. Externally this is
    // `<hub>/agent/terminal/<channel>`; the hub strips `/agent` (stripPrefix)
    // and forwards the `Upgrade: websocket` over its Bun-native WS bridge (which
    // honors agent's `websocket: true` declaration), so the daemon sees the
    // bare `/terminal/<channel>` upgrade here. OPERATOR-GATED on agent:admin
    // (the most dangerous capability), token via `?token=`. Must run BEFORE the
    // generic routing so the upgrade isn't 404'd.
    const termMatch = url.pathname.match(/^\/terminal\/([^/]+)$/);
    if (termMatch && isWebSocketUpgrade(req)) {
      const channelName = decodeURIComponent(termMatch[1]!);
      const decision = await authorizeTerminalUpgrade(req, url, channels, channelName);
      if (!decision.ok) return decision.response;
      if (!server?.upgrade) {
        // No server handle (e.g. a unit test calling the handler directly, or a
        // build where Bun.serve didn't pass it) — the upgrade can't happen here.
        return authJson(
          { error: "websocket upgrade unavailable on this server" },
          503,
        );
      }
      const data: TerminalWsData = {
        session: decision.session,
        channel: decision.channel,
        cols: decision.cols,
        rows: decision.rows,
      };
      const upgraded = server.upgrade(req, { data });
      if (upgraded) {
        // Bun's contract: return undefined from fetch after a successful upgrade
        // — the socket now belongs to the websocket handlers.
        return undefined as unknown as Response;
      }
      return authJson({ error: "websocket upgrade failed" }, 400);
    }

    // Terminal renderer assets (xterm.js + addon-fit + css) served SAME-ORIGIN
    // (design §5; replaces the CDN load that broke behind strict networks/CSP).
    // Public like the page itself — these are vendored static JS/CSS, no secrets.
    // Must run BEFORE the `/terminal/<channel>` page match (this is a 2-segment
    // path the single-segment termMatch wouldn't catch, but keep it explicit).
    const assetMatch = url.pathname.match(/^\/terminal\/assets\/([^/]+)$/);
    if (req.method === "GET" && assetMatch) {
      const served = serveTerminalAsset(decodeURIComponent(assetMatch[1]!));
      return served ?? json({ error: "not found" }, 404);
    }

    // Terminal view (the xterm.js page) — `/terminal` or `/terminal/<channel>`
    // as a plain GET (no upgrade) serves the page; the page then opens the WS to
    // `/terminal/<channel>`. Loads OPEN (like /ui and /admin) so it can bootstrap
    // its hub-minted agent:admin token fetch; the WS upgrade above is what's
    // gated. Served by the daemon (spans every channel via a picker).
    if (req.method === "GET" && (url.pathname === "/terminal" || termMatch)) {
      return new Response(TERMINAL_UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Retired server-rendered pages (Phase 4c) — the v2 SPA now covers Home /
    // Agents / Config (the Agents view) and Schedules (the agent detail). Each
    // page route 302s to the SPA app root so operator bookmarks keep working.
    // The relative `app/` Location resolves daemon-direct AND hub-proxied (see
    // `redirect`). The SPA itself is served by `serveSpa` at `/app` below; ALL
    // the data-plane routes (`/api/*`, `/ui/events`, …) are untouched.
    if (
      req.method === "GET" &&
      (url.pathname === "/agents" || url.pathname === "/jobs" || url.pathname === "/home")
    ) {
      return redirect("app/");
    }

    // Bare root — historically a 404 (no page lived here). Send it to the SPA
    // app root too, so a bookmark on the module root lands somewhere useful.
    // Relative `app/` → `/app/` direct, `/agent/app/` proxied.
    if (req.method === "GET" && url.pathname === "/") {
      return redirect("app/");
    }

    // Agent UI v2 SPA (the agent-centric React surface) — served at the NEW
    // `/app` mount, reachable at `<hub>/agent/app/` over the hub proxy. Coexists
    // with the daemon-rendered HTML pages above (the design's incremental
    // migration; the HTML retires in a later phase). Serves `index.html` for the
    // SPA route(s) + `dist/assets/*` for assets; a missing `dist/` → 503 with a
    // "run build" hint (dev-checkout case). Loads OPEN (like /ui, /admin, /agents)
    // so it can bootstrap its hub-minted `agent:admin` token; the `/api/*` calls
    // it makes are what `requireScope` gates. Bundle path is anchored to the
    // install dir so a `bun src/daemon.ts` from any cwd finds web/ui/dist/.
    if (req.method === "GET" && isSpaPath(url.pathname)) {
      return serveSpa(spaDistDir(INSTALL_DIR), url.pathname);
    }

    // Health check — per-channel client counts. Programmatic agents (design
    // 2026-06-16 step 6) are listed separately with their backend + live status
    // (`programmatic · idle|working|queued:N`) instead of `mcp_sessions` — a
    // programmatic agent has no live subscriber, so SSE/MCP counts don't describe it.
    if (url.pathname === "/health") {
      // Surface the boot dependency-preflight (agent#156) so the admin UI can show
      // that programmatic turns will fail until the missing deps are installed. Only
      // present when `main` passed the boot check (absent in a plain handler/tests).
      const preflight = opts?.preflight;
      return json({
        status: "ok",
        channels: [...channels.values()].map((c) => ({
          name: c.name,
          kind: c.transport.kind,
          clients: registry.countForChannel(c.name),
          mcp_sessions: mcpSessionCount(c.name),
        })),
        total_clients: registry.size,
        programmatic_agents: programmatic.list().map((h) => {
          const s = programmatic.statusOf(h.channel);
          return {
            name: h.name,
            channel: h.channel,
            backend: "programmatic",
            status: s.state === "queued" ? `queued:${s.queued}` : s.state,
          };
        }),
        ...(preflight
          ? {
              dependencies: {
                ok: preflight.ok,
                // The binary names missing on PATH — what programmatic turns need installed.
                missing: preflight.missing.map((d) => d.bin),
              },
            }
          : {}),
      });
    }

    // Self-describing config (runner pattern) — read-only, no secrets.
    //
    // `triggerTemplate` is MODULE-OWNED DATA: the prescribed vault trigger this
    // channel needs the hub to register on its behalf (PR 3). The hub GETs this,
    // substitutes the channel name into the `<channel>` placeholders, fills the
    // `<hub-origin>` in `action.webhook`, and injects `action.auth.bearer` (a
    // minted agent:send JWT) — so the channel owns its own trigger shape rather
    // than the hub hardcoding it.
    if (req.method === "GET" && url.pathname === "/.parachute/config") {
      return json({
        channels: [...channels.values()].map((c) => ({
          name: c.name,
          transport: c.transport.kind,
        })),
        triggerTemplate: AGENT_VAULT_TRIGGER_TEMPLATE,
      });
    }

    if (req.method === "GET" && url.pathname === "/.parachute/config/schema") {
      return json({
        title: "parachute-agent config",
        description: "Named channels, each bound to a transport.",
        type: "object",
        properties: {
          channels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Unique channel name bridges subscribe to." },
                transport: {
                  type: "string",
                  enum: ["telegram", "http-ui", "vault"],
                  description: "Transport kind backing this channel.",
                },
                config: {
                  type: "object",
                  description: "Transport-specific config (secrets live here, not returned by /config).",
                },
              },
              required: ["name", "transport"],
            },
          },
        },
        required: ["channels"],
      });
    }

    // ---------------------------------------------------------------------
    // Channel config-management API — the hub writes channels.json + hot-adds
    // the channel to the LIVE daemon, so a frictionless setup never hand-edits a
    // file or restarts the daemon. Gated on a hub JWT with `agent:admin`.
    //
    //   POST   /api/channels        { name, transport, config } → write + hot-add
    //   GET    /api/channels        → list (name + transport + vault; NO secrets)
    //   DELETE /api/channels/:name  → stop + unregister + remove from channels.json
    //
    // Externally hub strips `/agent`, so these are `<hub>/agent/api/channels`.
    // ---------------------------------------------------------------------
    if (url.pathname === "/api/channels" && (req.method === "GET" || req.method === "POST")) {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;

      if (req.method === "GET") {
        // List configured channels — surface ONLY name + transport + vault (for a
        // vault transport). NEVER the token/secret: this is an admin read, but the
        // file holds credentials we don't echo back.
        return json({
          channels: [...channels.values()].map((c) => {
            const out: { name: string; transport: string; vault?: string } = {
              name: c.name,
              transport: c.transport.kind,
            };
            const v = (c.entry.config as { vault?: unknown } | undefined)?.vault;
            if (typeof v === "string") out.vault = v;
            return out;
          }),
        });
      }

      // POST — create/replace a channel.
      let cfgBody: { name?: unknown; transport?: unknown; config?: unknown };
      try {
        cfgBody = (await req.json()) as typeof cfgBody;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (typeof cfgBody.name !== "string" || cfgBody.name.length === 0) {
        return json({ error: "body.name (string) is required" }, 400);
      }
      if (typeof cfgBody.transport !== "string" || cfgBody.transport.length === 0) {
        return json({ error: "body.transport (string) is required" }, 400);
      }
      const entry: ChannelEntry = {
        name: cfgBody.name,
        transport: cfgBody.transport,
        config:
          cfgBody.config && typeof cfgBody.config === "object"
            ? (cfgBody.config as Record<string, unknown>)
            : undefined,
      };
      // Validate the entry by instantiating it FIRST (constructor throws on a
      // missing required field — e.g. a vault channel with no token). We do this
      // before writing channels.json so a bad request never persists a broken
      // entry. `addChannelLive` re-instantiates; the throwaway here is the gate.
      try {
        instantiateTransport(entry);
      } catch (err) {
        return json({ error: `invalid channel config: ${(err as Error).message}` }, 400);
      }
      // Persist FIRST (chmod 600 — holds a token), then hot-add to the live
      // daemon. If the hot-add throws, the file is already written, so a daemon
      // restart would still pick it up; we surface the error AND a restart hint.
      try {
        // Resolve the state dir at request time (defaultStateDir reads the env)
        // so the persisted file always lands where the daemon would next read it,
        // even if the env was set after module load (and so it's testable).
        upsertChannelEntry(entry, defaultStateDir());
      } catch (err) {
        return json({ error: `failed to write channels.json: ${(err as Error).message}` }, 500);
      }
      try {
        await addChannelLive(channels, registry, entry, deliveryState, programmatic, attachedQueue);
      } catch (err) {
        return json(
          {
            ok: true,
            name: entry.name,
            transport: entry.transport,
            live: false,
            restart_needed: true,
            error: `channel persisted but hot-add failed: ${(err as Error).message}`,
          },
          200,
        );
      }
      return json({ ok: true, name: entry.name, transport: entry.transport, live: true });
    }

    const delMatch = url.pathname.match(/^\/api\/channels\/([^/]+)$/);
    if (delMatch && req.method === "DELETE") {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;
      const name = decodeURIComponent(delMatch[1]!);
      const wasLive = await removeChannelLive(channels, name);
      // Always rewrite channels.json (idempotent) so the file matches the live
      // state even if the channel was only on disk (added before a restart).
      try {
        removeChannelEntry(name, defaultStateDir());
      } catch (err) {
        return json({ error: `failed to update channels.json: ${(err as Error).message}` }, 500);
      }
      if (!wasLive) {
        // Not in the live map. Either never live, or removed from disk only.
        return json({ ok: true, name, removed: false }, 200);
      }
      return json({ ok: true, name, removed: true });
    }

    // ---------------------------------------------------------------------
    // Scheduled-jobs API — the runner (design 2026-06-17). A job is "an
    // automated human": send message M to a vault agent A on cron S. Storage is
    // VAULT-NATIVE (`#agent/job` notes in the target channel's vault); these
    // routes read/write through the shared `jobStore`. ALL gated on
    // `agent:admin` (operator-only, like /api/channels). The runner does the
    // injecting; these routes just CRUD the durable job notes (+ fire-now).
    //
    //   GET    /api/jobs          → list (across the live vault channels)
    //   POST   /api/jobs          { id, channel, message, schedule, enabled? } → create
    //   DELETE /api/jobs/:id      → delete the job note
    //   POST   /api/jobs/:id/run  → fire now (inject the inbound message immediately)
    //
    // Externally hub strips `/agent`, so these are `<hub>/agent/api/jobs`.
    // ---------------------------------------------------------------------
    if (url.pathname === "/api/jobs" && (req.method === "GET" || req.method === "POST")) {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;

      if (req.method === "GET") {
        // List across every live vault channel. A vault read failure surfaces as a
        // 502 (not a silently-empty list that looks like "no jobs").
        try {
          const jobs = await jobStore.listAll();
          // `nextRunAt` is computed-in-memory (the stored note never carries it —
          // see the Job docblock), so the persisted list lacks it and the UI's
          // "Next run" column would always be "—". Derive it here for ENABLED jobs
          // (a disabled job isn't scheduled → no next run). Per-job guard: a bad tz
          // (a RangeError out of nextRunAfter) must not 502 the whole list.
          const now = new Date();
          const withNext = jobs.map((j) => {
            if (!j.enabled) return j;
            try {
              const next = nextRunAfter(j.schedule.cron, j.schedule.tz, now);
              return next ? { ...j, nextRunAt: next.toISOString() } : j;
            } catch {
              return j;
            }
          });
          return json({ jobs: withNext });
        } catch (err) {
          return json({ error: `failed to list jobs: ${(err as Error).message}` }, 502);
        }
      }

      // POST — create/replace a job.
      let body: { id?: unknown; channel?: unknown; message?: unknown; schedule?: unknown; enabled?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      // Validate against the LIVE channels: known + vault-backed + parseable cron.
      const validation = validateJob(body, (name) => {
        if (!channels.has(name)) return null;
        return channels.get(name)!.transport instanceof VaultTransport;
      });
      if (!validation.ok) return json({ error: validation.error }, 400);

      const job: Job = {
        id: body.id as string,
        channel: body.channel as string,
        message: (body.message as string).trim(),
        schedule: body.schedule as Job["schedule"],
        enabled: body.enabled === undefined ? true : Boolean(body.enabled),
        createdAt: new Date().toISOString(),
      };
      try {
        const saved = await jobStore.upsert(job);
        return json({ ok: true, job: saved });
      } catch (err) {
        return json({ error: `failed to write job: ${(err as Error).message}` }, 502);
      }
    }

    // POST /api/jobs/:id/run — fire now (inject the message immediately).
    {
      const runMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/run$/);
      if (runMatch && req.method === "POST") {
        const denied = await requireScope(req, url, SCOPE_ADMIN);
        if (denied) return denied;
        const id = decodeURIComponent(runMatch[1]!);
        try {
          // Prefer the shared runner (records bookkeeping consistently with a
          // scheduled fire). Fall back to an inline fire via the job store + the
          // channel's injectInbound when no runner is wired (plain handler/tests).
          if (opts?.runner) {
            const status = await opts.runner.runNow(id);
            return json({ ok: true, id, status });
          }
          const jobs = await jobStore.listAll();
          const job = jobs.find((j) => j.id === id);
          if (!job) return json({ error: `unknown job "${id}"` }, 404);
          const transport = vaultTransportFor(channels, job.channel);
          if (!transport) {
            return json({ error: `job "${id}" targets a non-vault channel "${job.channel}"` }, 400);
          }
          await transport.injectInbound({ content: job.message, sender: `runner:${job.id}` });
          return json({ ok: true, id, status: "ok" });
        } catch (err) {
          return json({ error: `failed to run job: ${(err as Error).message}` }, 502);
        }
      }
    }

    // DELETE /api/jobs/:id — remove the job note. We must resolve which channel's
    // vault holds it; list once to find the job's channel, then delete there.
    {
      const jobDelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobDelMatch && req.method === "DELETE") {
        const denied = await requireScope(req, url, SCOPE_ADMIN);
        if (denied) return denied;
        const id = decodeURIComponent(jobDelMatch[1]!);
        try {
          const jobs = await jobStore.listAll();
          const job = jobs.find((j) => j.id === id);
          if (!job || !job.noteId) return json({ ok: true, id, removed: false }, 200);
          await jobStore.remove(job.noteId, job.channel);
          return json({ ok: true, id, removed: true });
        } catch (err) {
          return json({ error: `failed to delete job: ${(err as Error).message}` }, 502);
        }
      }
    }

    // ---------------------------------------------------------------------
    // STEP-UP AUTH (PIN) — second factor for high-privilege actions (agent#80).
    //
    // The dangerous `agent:admin` actions (set credentials, open a terminal,
    // spawn a `filesystem: full` agent) require a step-up token IN ADDITION to
    // the `agent:admin` Bearer. This block is the PIN setup + exchange surface;
    // the gating lives at each dangerous endpoint (via `requireStepUp`).
    //
    //   GET  /api/step-up          → { configured } — is a PIN set? (UI: setup vs prompt)
    //   POST /api/step-up { pin }  → validate PIN (rate-limited) → { stepUpToken, expires_at }
    //   POST /api/step-up/pin { newPin, currentPin? } → set/rotate the PIN
    //
    // All `agent:admin`-gated (the operator's cookie-minted Bearer). The PIN is
    // hashed+salted server-side (step-up.ts); it is NEVER returned or logged.
    // Externally hub strips `/agent`, so these are `<hub>/agent/api/step-up`.
    // ---------------------------------------------------------------------
    if (url.pathname === "/api/step-up" && req.method === "GET") {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;
      // Whether a PIN is configured — the UI branches setup-flow vs PIN-prompt.
      return json({ configured: isStepUpConfigured() });
    }

    if (url.pathname === "/api/step-up" && req.method === "POST") {
      // Exchange: validate the PIN, then mint a short-lived step-up token. The
      // session must already hold `agent:admin` (this is a SECOND factor on top,
      // never a substitute — the token carries no scope of its own).
      let claims;
      try {
        const token = extractToken(req, url);
        if (!token) return json({ error: "unauthorized", message: "Bearer token required" }, 401);
        claims = await validateHubJwt(token);
      } catch (err) {
        return json(
          { error: "unauthorized", message: err instanceof Error ? err.message : "invalid token" },
          401,
        );
      }
      if (!grantsScope(claims.scopes, SCOPE_ADMIN)) {
        return json(
          { error: "insufficient_scope", message: `requires ${SCOPE_ADMIN}`, granted: claims.scopes },
          403,
        );
      }
      // No PIN configured yet — there's nothing to exchange. Tell the UI to run
      // its first-time setup (distinct from a wrong-PIN 401).
      if (!isStepUpConfigured()) {
        return json(
          { error: "step_up_not_configured", message: "set a step-up PIN first (POST /api/step-up/pin)" },
          409,
        );
      }
      let body: { pin?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (typeof body.pin !== "string" || body.pin.length === 0) {
        return json({ error: "body.pin (non-empty string) is required" }, 400);
      }
      // Rate-limit BEFORE the (expensive, brute-forceable) argon2 verify, keyed by
      // the operator subject — a stolen-cookie attacker can't grind the PIN. A
      // DENIED attempt returns 429 (the limiter does not count it again).
      const limited = stepUpLimiter.checkAndRecord(`step-up:${claims.sub}`);
      if (!limited.allowed) {
        return new Response(
          JSON.stringify({
            error: "rate_limited",
            message: "too many PIN attempts — wait before retrying",
            retry_after_seconds: limited.retryAfterSeconds,
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": String(limited.retryAfterSeconds ?? 60),
            },
          },
        );
      }
      const ok = await verifyStepUpPin(body.pin);
      if (!ok) {
        // Wrong PIN — 401. The attempt already counted toward the lockout above.
        // Never echo the PIN back.
        return json({ error: "invalid_pin", message: "incorrect PIN" }, 401);
      }
      // Correct PIN — clear the attempt bucket (a fresh window for the next time)
      // and mint a reusable, short-TTL step-up token.
      stepUpLimiter.clear(`step-up:${claims.sub}`);
      const { token: stepUpToken, expiresAt } = mintStepUpToken();
      return json({ stepUpToken, expires_at: new Date(expiresAt).toISOString() });
    }

    if (url.pathname === "/api/step-up/pin" && req.method === "POST") {
      // Set (first time) or rotate the step-up PIN. agent:admin-gated; if a PIN
      // already exists, the CURRENT PIN must be supplied + verified (rotation
      // needs the old PIN, so a hijacked session can't silently replace it).
      let claims;
      try {
        const token = extractToken(req, url);
        if (!token) return json({ error: "unauthorized", message: "Bearer token required" }, 401);
        claims = await validateHubJwt(token);
      } catch (err) {
        return json(
          { error: "unauthorized", message: err instanceof Error ? err.message : "invalid token" },
          401,
        );
      }
      if (!grantsScope(claims.scopes, SCOPE_ADMIN)) {
        return json(
          { error: "insufficient_scope", message: `requires ${SCOPE_ADMIN}`, granted: claims.scopes },
          403,
        );
      }
      let body: { newPin?: unknown; currentPin?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (!isValidPinFormat(body.newPin)) {
        return json({ error: "body.newPin must be 4–12 digits" }, 400);
      }
      // Rotation: a PIN already exists → require + verify the current one (rate-limited).
      // SHARES the exchange bucket (same `step-up:<sub>` key) on purpose: both verify
      // the PIN, so an attacker can't get a fresh grind window by alternating endpoints.
      if (isStepUpConfigured()) {
        const limited = stepUpLimiter.checkAndRecord(`step-up:${claims.sub}`);
        if (!limited.allowed) {
          return new Response(
            JSON.stringify({
              error: "rate_limited",
              message: "too many PIN attempts — wait before retrying",
              retry_after_seconds: limited.retryAfterSeconds,
            }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": String(limited.retryAfterSeconds ?? 60),
              },
            },
          );
        }
        if (typeof body.currentPin !== "string" || !(await verifyStepUpPin(body.currentPin))) {
          return json(
            { error: "invalid_pin", message: "the current PIN is required to change it" },
            401,
          );
        }
        stepUpLimiter.clear(`step-up:${claims.sub}`);
      }
      try {
        await setStepUpPin(body.newPin);
      } catch (err) {
        if (err instanceof StepUpPinFormatError) return json({ error: err.message }, 400);
        return json({ error: `failed to set PIN: ${(err as Error).message}` }, 500);
      }
      // Echo back only the fact of the write — never the PIN.
      return json({ ok: true, configured: true });
    }

    // ---------------------------------------------------------------------
    // Claude OAuth credential store (design §6) — the per-channel secret a
    // launched agent session runs on (`CLAUDE_CODE_OAUTH_TOKEN`). Same
    // `agent:admin` gate + 0600 file-store + redaction-on-read posture as the
    // channel config API above. The token comes from `claude setup-token`.
    //
    //   GET    /api/credentials/claude          → { defaultSet, channels:[names] } (NO secret)
    //   POST   /api/credentials/claude          { token } → set the default/operator token
    //   POST   /api/credentials/claude/:channel { token } → set a per-channel override
    //   DELETE /api/credentials/claude/:channel → remove an override (falls back to default)
    //
    // Externally hub strips `/agent`, so these are `<hub>/agent/api/credentials/claude`.
    // ---------------------------------------------------------------------
    if (url.pathname === "/api/credentials/claude" && (req.method === "GET" || req.method === "POST")) {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;

      if (req.method === "GET") {
        // Inspect WITHOUT leaking the secret: whether a default is set + which
        // channels carry an override (names only). A status read — no step-up.
        return json(describeClaudeCredentials(defaultStateDir()));
      }

      // POST — set the default / operator-level token. STEP-UP required (agent#80):
      // setting a credential can exfiltrate the operator's Claude token.
      const step = requireStepUp(req, url);
      if (!step.ok) return step.response;

      let credBody: { token?: unknown };
      try {
        credBody = (await req.json()) as typeof credBody;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (typeof credBody.token !== "string" || credBody.token.length === 0) {
        return json({ error: "body.token (non-empty string) is required" }, 400);
      }
      try {
        setDefaultClaudeCredential(credBody.token, defaultStateDir());
      } catch (err) {
        return json({ error: `failed to write credentials.json: ${(err as Error).message}` }, 500);
      }
      // Echo back only the fact of the write — never the token.
      return json({ ok: true, scope: "default" });
    }

    const credMatch = url.pathname.match(/^\/api\/credentials\/claude\/([^/]+)$/);
    if (credMatch && (req.method === "POST" || req.method === "DELETE")) {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;
      // STEP-UP required (agent#80): both set + remove of a per-channel Claude
      // credential are high-privilege credential-store mutations.
      const step = requireStepUp(req, url);
      if (!step.ok) return step.response;
      const channel = decodeURIComponent(credMatch[1]!);

      if (req.method === "DELETE") {
        let removed: boolean;
        try {
          removed = removeChannelClaudeCredential(channel, defaultStateDir());
        } catch (err) {
          return json({ error: `failed to update credentials.json: ${(err as Error).message}` }, 500);
        }
        return json({ ok: true, channel, removed });
      }

      // POST — set a per-channel override.
      let credBody: { token?: unknown };
      try {
        credBody = (await req.json()) as typeof credBody;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (typeof credBody.token !== "string" || credBody.token.length === 0) {
        return json({ error: "body.token (non-empty string) is required" }, 400);
      }
      try {
        setChannelClaudeCredential(channel, credBody.token, defaultStateDir());
      } catch (err) {
        return json({ error: `failed to write credentials.json: ${(err as Error).message}` }, 500);
      }
      return json({ ok: true, scope: "channel", channel });
    }

    // ---------------------------------------------------------------------
    // Generic per-channel ENV-VAR store (GH_TOKEN / CLOUDFLARE_API_TOKEN / …) —
    // the secrets a launched agent's `gh`/`git`/build tooling needs. Same
    // `agent:admin` gate + 0600 file-store + redaction-on-read posture as the
    // Claude credential API above. A blank/omitted `channel` targets the
    // operator-level DEFAULT layer; a channel name targets that channel's override.
    // Denylisted names (the Claude-auth trio) are REJECTED with a 400 — they'd break
    // the managed subscription-billing guarantee.
    //
    //   GET    /api/credentials/env          → { default:[names], channels:{ch:[names]} } (NO values)
    //   POST   /api/credentials/env  { channel?, name, value } → set
    //   DELETE /api/credentials/env  { channel?, name } (or ?channel=&name=) → remove
    //
    // Externally hub strips `/agent`, so these are `<hub>/agent/api/credentials/env`.
    // ---------------------------------------------------------------------
    if (
      url.pathname === "/api/credentials/env" &&
      (req.method === "GET" || req.method === "POST" || req.method === "DELETE")
    ) {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;

      if (req.method === "GET") {
        // Inspect WITHOUT leaking values: names per channel + the default layer.
        // A status read — no step-up.
        return json(describeChannelEnv(defaultStateDir()));
      }

      // STEP-UP required (agent#80): set/remove of an env secret (GH_TOKEN,
      // CLOUDFLARE_API_TOKEN, …) is a credential-store mutation.
      const step = requireStepUp(req, url);
      if (!step.ok) return step.response;

      let envBody: { channel?: unknown; name?: unknown; value?: unknown };
      try {
        envBody = (await req.json()) as typeof envBody;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      // `channel` is optional — blank/absent/empty means the operator-level default.
      const channelRaw = typeof envBody.channel === "string" ? envBody.channel : "";
      const channel = channelRaw.length > 0 ? channelRaw : null;
      if (typeof envBody.name !== "string" || envBody.name.length === 0) {
        return json({ error: "body.name (non-empty string) is required" }, 400);
      }
      const name = envBody.name;

      if (req.method === "DELETE") {
        let removed: boolean;
        try {
          removed = removeChannelEnvVar(channel, name, defaultStateDir());
        } catch (err) {
          return json({ error: `failed to update credentials.json: ${(err as Error).message}` }, 500);
        }
        return json({ ok: true, scope: channel ? "channel" : "default", ...(channel ? { channel } : {}), name, removed });
      }

      // POST — set the var.
      if (typeof envBody.value !== "string" || envBody.value.length === 0) {
        return json({ error: "body.value (non-empty string) is required" }, 400);
      }
      try {
        setChannelEnvVar(channel, name, envBody.value, defaultStateDir());
      } catch (err) {
        // A denylisted name (ANTHROPIC_API_KEY/CLAUDE_API_KEY/CLAUDE_CODE_OAUTH_TOKEN)
        // or a malformed name is the operator's mistake → 400 with the clear reason.
        if (err instanceof DenylistedEnvError) return json({ error: err.message }, 400);
        if ((err as Error).message?.startsWith("credentials:")) {
          return json({ error: (err as Error).message }, 400);
        }
        return json({ error: `failed to write credentials.json: ${(err as Error).message}` }, 500);
      }
      // Echo back only the fact of the write — never the value.
      return json({ ok: true, scope: channel ? "channel" : "default", ...(channel ? { channel } : {}), name });
    }

    // ---------------------------------------------------------------------
    // Agent management API (the web spawn/list/kill surface, design §4/§5).
    // Operator-gated on `agent:admin`. The interactive (tmux) backend was retired
    // 2026-06-19 (design 2026-06-19-retire-interactive-backend.md): there is no
    // tmux session to list/spawn/kill anymore. The two live backends are
    // PROGRAMMATIC (daemon-run `claude -p` turns) + CHANNEL (a Claude Code session
    // the operator connects handles the turn; vault-native — defined as an
    // #agent/definition note, not via this POST).
    //
    //   GET    /api/agents          → list registered programmatic + channel agents
    //   POST   /api/agents          { name, channels, vault?, ... } → register a programmatic agent
    //   DELETE /api/agents/:name    → deregister the agent
    //
    // Externally hub strips `/agent`, so these are `<hub>/agent/api/agents`.
    // ---------------------------------------------------------------------
    if (url.pathname === "/api/agents" && (req.method === "GET" || req.method === "POST")) {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;

      if (req.method === "GET") {
        try {
          // The list merges registered PROGRAMMATIC agents (design 2026-06-16 step 6)
          // + registered CHANNEL-backend agents (#102). Neither has a tmux session, so
          // each carries its `backend` + a live `status` (idle|working|queued:N); a
          // channel agent also surfaces its wake `channel` + backing `vault`.
          const programmaticInfos = listProgrammaticAgents(programmatic);
          const channelInfos = await listAttachedAgents(attachedQueue);
          return json({ agents: [...programmaticInfos, ...channelInfos] });
        } catch (err) {
          return json({ error: `failed to list agents: ${(err as Error).message}` }, 500);
        }
      }

      // POST — register a programmatic agent from a spec. `buildSpecFromBody` accepts
      // only `backend: "programmatic"` (the default); a `channel` agent is vault-native
      // and an `interactive` backend is retired — both rejected with a clear 400.
      let spawnBody: unknown;
      try {
        spawnBody = await req.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      let spec;
      try {
        spec = buildSpecFromBody(spawnBody);
      } catch (err) {
        if (err instanceof SpawnRequestError) return json({ error: err.message }, 400);
        throw err;
      }

      // STEP-UP required (agent#80) ONLY for the dangerous filesystem case: a
      // `filesystem: "full"` agent runs UNSANDBOXED with read access to the whole
      // disk. Ordinary sandboxed (workspace-confined) spawns stay frictionless —
      // gate just the high-blast-radius case.
      if (spec.filesystem === "full") {
        const step = requireStepUp(req, url);
        if (!step.ok) return step.response;
      }

      // CHANNEL EXCLUSION: a channel routes inbound to at most one agent. Refuse a
      // spawn for a DIFFERENT programmatic agent onto an already-occupied wake channel
      // (re-spawning the SAME name onto its OWN channel is the idempotent-replace path).
      const wakeChannel = normalizeChannel(spec.channels[0]!).name;
      if (programmatic.hasChannel(wakeChannel) && programmatic.getByChannel(wakeChannel)?.name !== spec.name) {
        return json(
          {
            error: `programmatic agent "${programmatic.getByChannel(wakeChannel)?.name}" already ` +
              `serves channel "${wakeChannel}". Kill it first, or pick a different channel.`,
          },
          409,
        );
      }

      // PROGRAMMATIC spawn — no tmux. Validate + persist spec.json (the no-tmux
      // setup), then register in the live registry (so inbound for the channel
      // enqueues). Boot re-registers from the persisted spec on the next restart.
      try {
        const setup = setupProgrammaticSpawn(spec);
        await programmatic.register({ ...spec, backend: "programmatic" });
        return json(setup);
      } catch (err) {
        if (err instanceof SpawnRequestError) return json({ error: err.message }, 400);
        if (err instanceof CredentialNotConfiguredError) return json({ error: err.message }, 400);
        return json({ error: (err as Error).message }, 400);
      }
    }

    // PER-SESSION restart — POST /api/agents/:name/restart (agent:admin). For a
    // programmatic agent this RESETS the conversation (clears the persisted session id
    // so the next message starts fresh; the agent stays registered) — there is no
    // resident process to restart. Must match BEFORE the single-segment DELETE below.
    const restartMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/restart$/);
    if (restartMatch && req.method === "POST") {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;
      const name = decodeURIComponent(restartMatch[1]!);
      if (programmatic.hasName(name)) {
        await programmatic.resetSession(name);
        return json({
          ok: true,
          name,
          backend: "programmatic",
          session_reset: true,
          note: "programmatic agent — conversation reset (next message starts a fresh session); no process to restart.",
        });
      }
      // No programmatic agent by that name — nothing to restart (a channel agent has
      // no daemon-run turn to reset; the interactive backend is retired).
      return json(
        { error: `no programmatic agent named "${name}" to restart` },
        404,
      );
    }

    const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (agentMatch && req.method === "DELETE") {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;
      const name = decodeURIComponent(agentMatch[1]!);
      // PROGRAMMATIC delete — deregister (drop the channel/name indexes + queue,
      // clear the backend session). No tmux to kill (the interactive backend retired).
      if (programmatic.hasName(name)) {
        const deregistered = await programmatic.deregister(name);
        return json({ ok: true, name, backend: "programmatic", killed: deregistered });
      }
      // No live agent by that name (interactive tmux sessions are no longer managed
      // here) — a no-op success so a delete of an already-gone agent is idempotent.
      return json({ ok: true, name, killed: false });
    }

    // Installed vault instances (for the agents page's vault picker) — derived
    // from the vault module's registered `/vault/<name>` paths in services.json.
    // No secrets; agent:admin-gated to match the rest of the agents surface.
    if (url.pathname === "/api/vaults" && req.method === "GET") {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;
      return json({ vaults: listVaultNames() });
    }

    // ---------------------------------------------------------------------
    // EFFECTIVE ENV — the env-var NAMES an agent's `claude -p` turn runs with
    // (operability: see-what-env-a-turn-runs-with). NAMES ONLY, never values —
    // the same redaction posture as GET /api/credentials/env (describeChannelEnv).
    // Composed from three tagged sources, in precedence order channel > default >
    // grant (mirrors resolveChannelEnv + buildAgentChildEnv's spawn-time merge):
    //   - "default"         — the operator-level env.default layer
    //   - "channel"         — the per-agent override layer (env.channels[<agent>])
    //   - "grant:<service>" — service env vars an APPROVED grant WOULD inject at spawn,
    //                          derived from the def's already-resolved connections via
    //                          serviceEnvVar() — NO grant material is fetched.
    // A lower-precedence entry shadowed by a higher one is marked overridden:true.
    // RESILIENT: the env-store layers always resolve (a local file read); a missing
    // def (agent not vault-native / idle registry) returns the env layers + a note,
    // never a 500. admin-gated to match the rest of the agents surface.
    //
    //   GET /api/agents/<name>/env → { env: [{ name, source, overridden? }], note? }
    //
    // Externally hub strips `/agent`, so this is `<hub>/agent/api/agents/<name>/env`.
    // Safe to add AFTER the single-segment `/api/agents/<name>` DELETE + `/restart`
    // routes above: the `\/env$` suffix + GET-only method never collide with them.
    // ---------------------------------------------------------------------
    const envMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/env$/);
    if (envMatch && req.method === "GET") {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;
      const name = decodeURIComponent(envMatch[1]!);
      // Find the agent's live def by name (agent ≡ channel). Its `connections` carry the
      // hub-resolved grant status (resolved at instantiate, NOT a live material fetch), so
      // the grant-env names derive without any secret fetch. Absent → env-store layers only.
      const def = agentDefs?.listDetailed().find((d) => d.name === name);
      return json(
        resolveEffectiveEnv(name, {
          ...(def ? { connections: def.connections } : {}),
          hasDef: Boolean(def),
        }),
      );
    }

    // ---------------------------------------------------------------------
    // Vault-native agent DEFINITIONS — the v2 API layer (design
    // 2026-06-18-agent-ui-v2-and-reactivity.md Part 2 Phase 1). A `#agent/definition`
    // note IS the agent (body = system prompt, metadata = config); these routes
    // list + create + edit + delete them in a configured def-vault, reloading the
    // changed note into a LIVE agent IMMEDIATELY (the per-note reload, NOT the 60s
    // poll). NO secrets surfaced (no tokens). Externally `<hub>/agent/api/agent-defs`.
    //
    //   GET    /api/agent-defs           → list (read-scoped) — per def: noteId, name,
    //                                       backend, mode, vault, status, pending,
    //                                       systemPromptPreview, wants, channel
    //   GET    /api/agent-defs/<noteId>  → one def, FULL (read-scoped) — noteId, name,
    //                                       backend, vault, mode, wants, systemPrompt
    //                                       (FULL body), status. Pre-fills the edit form.
    //   POST   /api/agent-defs           { vault, name, backend, systemPrompt, wants?,
    //                                       metadata? } → write note + reload live (admin)
    //   PATCH  /api/agent-defs/<noteId>  { systemPrompt?, wants?, metadata? } → edit +
    //                                       reload (admin)
    //   DELETE /api/agent-defs/<noteId>  → delete note + deregister (admin)
    // ---------------------------------------------------------------------
    if (url.pathname === "/api/agent-defs" && (req.method === "GET" || req.method === "POST")) {
      // GET is READ-scoped (a listing, no secrets); POST is admin (it mints/writes).
      //
      // NOTE (step-up, agent#80/#154): POST is intentionally NOT step-up-gated, even
      // though a `#agent/definition` note can carry `filesystem: "full"`. Authoring a
      // def already requires the scope-gated `vault:write` (the daemon writes the note
      // with a vault token), so a step-up challenge here would gate a capability the
      // caller already had to hold a write credential to reach — mirrors the carve-out
      // comment on the vault-native parse path in agent-defs.ts. The `filesystem:full`
      // SPAWN path (`POST /api/agents`) IS step-up-gated; this AUTHORING path is not.
      const scope = req.method === "GET" ? SCOPE_READ : SCOPE_ADMIN;
      const denied = await requireScope(req, url, scope);
      if (denied) return denied;
      if (!agentDefs) {
        // No def-vaults configured — an empty list (GET) / a clear 400 (POST).
        if (req.method === "GET") return json({ defs: [] });
        return json({ error: "no def-vaults configured (add one via POST /api/agent-vaults)" }, 400);
      }

      if (req.method === "GET") {
        return json({ defs: agentDefs.listDetailed() });
      }

      // POST — create a new def note + reload it live.
      let body: { vault?: unknown; name?: unknown; backend?: unknown; systemPrompt?: unknown; wants?: unknown; metadata?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (typeof body.vault !== "string" || body.vault.length === 0) {
        return json({ error: "body.vault (string) is required" }, 400);
      }
      if (typeof body.name !== "string" || body.name.length === 0) {
        return json({ error: "body.name (string) is required" }, 400);
      }
      // DUAL-READ the legacy backend value `"channel"` → canonical `"attached"`, so an
      // API client still passing the pre-rename value is accepted (and persisted as the
      // canonical value by createDef). The routing key `channel` is a separate concept.
      const rawBackend = body.backend === undefined ? "programmatic" : body.backend;
      const backend = rawBackend === "channel" ? "attached" : rawBackend;
      if (backend !== "programmatic" && backend !== "attached") {
        return json({ error: 'body.backend must be "programmatic" or "attached"' }, 400);
      }
      if (body.systemPrompt !== undefined && typeof body.systemPrompt !== "string") {
        return json({ error: "body.systemPrompt must be a string" }, 400);
      }
      if (body.wants !== undefined && typeof body.wants !== "string") {
        return json({ error: "body.wants must be a comma-separated string" }, 400);
      }
      if (body.metadata !== undefined && (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata))) {
        return json({ error: "body.metadata must be an object of strings" }, 400);
      }
      try {
        const detail = await agentDefs.createDef({
          vault: body.vault,
          name: body.name,
          backend,
          systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : "",
          ...(typeof body.wants === "string" ? { wants: body.wants } : {}),
          ...(body.metadata ? { metadata: coerceStringMap(body.metadata) } : {}),
        });
        return json({ ok: true, def: detail }, 201);
      } catch (err) {
        if (err instanceof AgentDefWriteError) return json({ error: err.message }, err.status);
        return json({ error: `failed to create agent def: ${(err as Error).message}` }, 502);
      }
    }

    // GET /api/agent-defs/<noteId> — the FULL editable def (the whole system-prompt
    // body, not the list's ~200-char preview) so the edit form pre-fills correctly.
    // READ-scoped, mirroring GET /api/agent-defs (a listing, no secrets — the body is
    // the prompt, never a token). 404 for an unknown id / a note that isn't a live def.
    const defGetMatch = url.pathname.match(/^\/api\/agent-defs\/(.+)$/);
    if (defGetMatch && req.method === "GET") {
      const denied = await requireScope(req, url, SCOPE_READ);
      if (denied) return denied;
      const noteId = decodeURIComponent(defGetMatch[1]!);
      if (!agentDefs) {
        return json({ error: "no def-vaults configured" }, 400);
      }
      try {
        const full = await agentDefs.getFullDef(noteId);
        if (!full) return json({ error: `note ${noteId} is not a live agent definition` }, 404);
        return json({ def: full });
      } catch (err) {
        if (err instanceof AgentDefWriteError) return json({ error: err.message }, err.status);
        return json({ error: `failed to fetch agent def: ${(err as Error).message}` }, 502);
      }
    }

    const defMatch = url.pathname.match(/^\/api\/agent-defs\/(.+)$/);
    if (defMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;
      const noteId = decodeURIComponent(defMatch[1]!);
      if (!agentDefs) {
        return json({ error: "no def-vaults configured" }, 400);
      }

      if (req.method === "DELETE") {
        try {
          const removed = await agentDefs.deleteDef(noteId);
          // FIX 5 (PR #3) — surface a PARTIAL success: the note delete completed, but if
          // best-effort grant cleanup failed, say so (the agent's approved hub grants may
          // be orphaned) rather than reporting a clean full success. The delete itself is
          // still a 200 (the def IS gone — grant GC is best-effort, not delete-blocking).
          if (!removed.grantsReconciled) {
            console.warn(
              `parachute-agent: deleted agent def "${removed.name}" but grant cleanup failed — ` +
                `its approved hub grants may be orphaned.`,
            );
          }
          return json({ ok: true, ...removed, removed: true });
        } catch (err) {
          if (err instanceof AgentDefWriteError) return json({ error: err.message }, err.status);
          return json({ error: `failed to delete agent def: ${(err as Error).message}` }, 502);
        }
      }

      // PATCH — edit body and/or metadata, reload live.
      let body: { systemPrompt?: unknown; wants?: unknown; metadata?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (body.systemPrompt !== undefined && typeof body.systemPrompt !== "string") {
        return json({ error: "body.systemPrompt must be a string" }, 400);
      }
      if (body.wants !== undefined && typeof body.wants !== "string") {
        return json({ error: "body.wants must be a comma-separated string" }, 400);
      }
      if (body.metadata !== undefined && (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata))) {
        return json({ error: "body.metadata must be an object of strings" }, 400);
      }
      try {
        const detail = await agentDefs.editDef(noteId, {
          ...(typeof body.systemPrompt === "string" ? { systemPrompt: body.systemPrompt } : {}),
          ...(typeof body.wants === "string" ? { wants: body.wants } : {}),
          ...(body.metadata ? { metadata: coerceStringMap(body.metadata) } : {}),
        });
        return json({ ok: true, def: detail });
      } catch (err) {
        if (err instanceof AgentDefWriteError) return json({ error: err.message }, err.status);
        return json({ error: `failed to edit agent def: ${(err as Error).message}` }, 502);
      }
    }

    // ---------------------------------------------------------------------
    // Module-level DEF-VAULT list — which vault(s) this module reads
    // `#agent/definition` notes from (`agent-vaults.json`). Today invisible +
    // uneditable; the v2 API surfaces + manages it. NO token VALUE surfaced (only
    // present/absent). Externally `<hub>/agent/api/agent-vaults`. Admin-scoped.
    //
    //   GET    /api/agent-vaults         → list { vault, url, tokenPresent } (read)
    //   POST   /api/agent-vaults         { vault, url? } → mint token + persist + live (admin)
    //   DELETE /api/agent-vaults/<name>  → drop from file + deregister its agents (admin)
    // ---------------------------------------------------------------------
    if (url.pathname === "/api/agent-vaults" && (req.method === "GET" || req.method === "POST")) {
      // GET is READ-scoped to mirror GET /api/agent-defs — the listing is non-sensitive
      // ({vault,url,tokenPresent}); `tokenPresent` is a boolean, NEVER the token value.
      // POST is admin (it mints a token + writes config).
      //
      // NOTE (step-up, agent#80/#154): POST is intentionally NOT step-up-gated. It mints
      // a VAULT-SCOPED token (`vault:<name>:write`) — a lower blast radius than the
      // Claude OAuth credential / terminal / full-fs spawn the step-up PIN guards (those
      // can exfiltrate every token or open a raw host shell). A def-vault token only
      // reaches the named vault's notes, so `agent:admin` alone is the right bar here.
      const scope = req.method === "GET" ? SCOPE_READ : SCOPE_ADMIN;
      const denied = await requireScope(req, url, scope);
      if (denied) return denied;

      if (req.method === "GET") {
        // Source of truth: the LIVE registry's bound vaults (a boot-minted binding
        // shows its token even before the file write lands). NEVER the token value. We
        // fall back to the persisted file only when no registry is wired (idle path),
        // so the listing isn't silently empty. The url defaults to the loopback vault.
        if (agentDefs) {
          return json({ vaults: agentDefs.vaultStatuses() });
        }
        let persisted: DefVaultBinding[] = [];
        try {
          persisted = readDefVaultsFile(defaultStateDir())?.vaults ?? [];
        } catch {
          persisted = [];
        }
        const vaults = persisted
          .map((v) => ({
            vault: v.vault,
            url: v.vaultUrl ?? DEFAULT_DEF_VAULT_URL,
            tokenPresent: typeof v.token === "string" && v.token.length > 0,
          }))
          .sort((a, b) => a.vault.localeCompare(b.vault));
        return json({ vaults });
      }

      // POST — add a def-vault (mint token + persist + load its defs live).
      let body: { vault?: unknown; url?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (typeof body.vault !== "string" || body.vault.length === 0) {
        return json({ error: "body.vault (string) is required" }, 400);
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(body.vault)) {
        return json({ error: `body.vault "${body.vault}" must be a slug (alphanumeric, dash, underscore)` }, 400);
      }
      if (body.url !== undefined && typeof body.url !== "string") {
        return json({ error: "body.url must be a string (the vault REST origin)" }, 400);
      }
      try {
        const added = await addDefVault({
          vault: body.vault,
          ...(typeof body.url === "string" && body.url.length > 0 ? { url: body.url } : {}),
        });
        return json({ ok: true, vault: added }, 201);
      } catch (err) {
        if (err instanceof MintError) {
          return json({ error: `token mint failed: ${err.message}` }, err.status >= 400 && err.status < 600 ? err.status : 502);
        }
        // A duplicate / no-operator-token / no-registry error → 400 (operator-actionable).
        return json({ error: `failed to add def-vault: ${(err as Error).message}` }, 400);
      }
    }

    const vaultDelMatch = url.pathname.match(/^\/api\/agent-vaults\/([^/]+)$/);
    if (vaultDelMatch && req.method === "DELETE") {
      const denied = await requireScope(req, url, SCOPE_ADMIN);
      if (denied) return denied;
      const name = decodeURIComponent(vaultDelMatch[1]!);
      if (!agentDefs) {
        return json({ error: "no def-vaults configured" }, 400);
      }
      // GUARD: don't remove the last def-vault — that would orphan the module's whole
      // vault-native path (no vault to define agents in). Mirror the channels.json
      // posture: removing the only one is a clear 400, not a silent orphan.
      const names = agentDefs.vaultNames();
      if (!names.includes(name)) {
        return json({ ok: true, vault: name, removed: false }, 200);
      }
      if (names.length <= 1) {
        return json(
          { error: `cannot remove the only def-vault "${name}" — the vault-native agent path would have no vault to define agents in. Add another first.` },
          400,
        );
      }
      // ORDERING (#106 review): persist the file FIRST, then tear down in-memory state.
      // The prior order (deregister → write → remove) left an INCOHERENT state on a write
      // failure: agents already torn down but the vault still in the live registry, while
      // the on-disk file was unchanged — so a restart re-instantiated agents the operator
      // had just deleted. Writing first means a write failure leaves EVERYTHING untouched
      // (vault + agents still live, file unchanged); only after the durable write commits
      // do we deregister the agents and drop the vault from the live registry.
      try {
        const stateDir = defaultStateDir();
        const file = readDefVaultsFile(stateDir);
        if (file) {
          writeDefVaultsFile({ vaults: file.vaults.filter((v) => v.vault !== name) }, stateDir);
        }
      } catch (err) {
        return json({ error: `failed to update agent-vaults.json: ${(err as Error).message}` }, 500);
      }
      // File is durable without this vault → tear down its live agents + drop it from the
      // live registry. A deregister failure now leaves the file already-correct, so a
      // restart converges to the intended (removed) state rather than resurrecting it.
      try {
        await agentDefs.deregisterAllForVault(name);
      } catch (err) {
        return json({ error: `failed to deregister agents for "${name}": ${(err as Error).message}` }, 502);
      }
      agentDefs.removeVault(name);
      return json({ ok: true, vault: name, removed: true });
    }

    // ---------------------------------------------------------------------
    // OAuth discovery for the HTTP MCP surface — RFC 9728 + RFC 8414, in the
    // PATH-INSERTION form (`.well-known` ABOVE the resource path). This is the
    // shape a Claude Code HTTP-MCP client probes when adding the channel by URL
    // (the same shape vault serves). For the resource at `/mcp/<channel>`:
    //
    //   /.well-known/oauth-protected-resource/mcp/<channel>
    //   /.well-known/oauth-authorization-server/mcp/<channel>
    //
    // Both are PUBLIC (no auth) — they have to be reachable before the client
    // holds a token. Externally they're `<hub>/agent/.well-known/...`; hub's
    // stripPrefix removes `/agent`, so the daemon matches the bare path and
    // re-adds the prefix in the advertised URLs via x-forwarded-host.
    // ---------------------------------------------------------------------
    if (req.method === "GET") {
      const prm = url.pathname.match(/^\/\.well-known\/oauth-protected-resource\/mcp\/([^/]+)$/);
      if (prm) return handleProtectedResource(req, decodeURIComponent(prm[1]!));
      const asm = url.pathname.match(/^\/\.well-known\/oauth-authorization-server\/mcp\/([^/]+)$/);
      if (asm) return handleAuthorizationServer(req, decodeURIComponent(asm[1]!));
    }

    // SSE event stream — bridges subscribe by channel. Bridge-facing: requires
    // a hub JWT with `agent:read`.
    if (req.method === "GET" && url.pathname === "/events") {
      const denied = await requireScope(req, url, SCOPE_READ);
      if (denied) return denied;
      let channel = url.searchParams.get("channel") ?? undefined;
      if (!channel) {
        channel = DEFAULT_CHANNEL;
        console.warn(
          `parachute-agent: /events without ?channel= — defaulting to "${DEFAULT_CHANNEL}". ` +
            `This back-compat default is deprecated; pass ?channel=<name>.`,
        );
      }
      const subscribedChannel = channel;
      const clientId = crypto.randomUUID();
      const stream = new ReadableStream<string>({
        start(controller) {
          registry.add(clientId, {
            channel: subscribedChannel,
            enqueue: (payload) => controller.enqueue(payload),
          });
          controller.enqueue(": connected\n\n");
          // (The deaf-on-restart BACKLOG REPLAY that used to fire here — replaying the
          // messages a reconnecting stdio bridge missed while detached — was retired
          // with the interactive backend: design 2026-06-19-retire-interactive-
          // backend.md. The live route still pushes new inbound to subscribed clients.)
        },
        cancel() {
          registry.remove(clientId);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    // Reply — bridge-facing: requires `agent:write`.
    if (req.method === "POST" && url.pathname === "/api/reply") {
      const denied = await requireScope(req, url, SCOPE_WRITE);
      if (denied) return denied;
      try {
        const body = (await req.json()) as {
          channel?: string;
          chat_id?: string;
          text?: string;
          reply_to?: string;
          files?: string[];
          meta?: Record<string, string>;
        };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        const result = await transport.reply(toReplyArgs(body));
        return json({ sent: result.sent });
      } catch (err) {
        return errResponse(err);
      }
    }

    // React — bridge-facing: requires `agent:write`.
    if (req.method === "POST" && url.pathname === "/api/react") {
      const denied = await requireScope(req, url, SCOPE_WRITE);
      if (denied) return denied;
      try {
        const body = (await req.json()) as {
          channel?: string;
          chat_id?: string;
          message_id: string;
          emoji: string;
          meta?: Record<string, string>;
        };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        if (!transport.react) return methodMissing(body.channel!, "react");
        const args: ReactArgs = {
          channel: body.channel!,
          message_id: body.message_id,
          emoji: body.emoji,
          meta: mergeMeta(body),
        };
        await transport.react(args);
        return json({ ok: true });
      } catch (err) {
        return errResponse(err);
      }
    }

    // Edit message — bridge-facing: requires `agent:write`.
    if (req.method === "POST" && url.pathname === "/api/edit") {
      const denied = await requireScope(req, url, SCOPE_WRITE);
      if (denied) return denied;
      try {
        const body = (await req.json()) as {
          channel?: string;
          chat_id?: string;
          message_id: string;
          text: string;
          meta?: Record<string, string>;
        };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        if (!transport.edit) return methodMissing(body.channel!, "edit");
        const args: EditArgs = {
          channel: body.channel!,
          message_id: body.message_id,
          text: body.text,
          meta: mergeMeta(body),
        };
        await transport.edit(args);
        return json({ ok: true });
      } catch (err) {
        return errResponse(err);
      }
    }

    // Permission prompt — bridge forwards permission_request here.
    // Bridge-facing: requires `agent:write`.
    if (req.method === "POST" && url.pathname === "/api/permission") {
      const denied = await requireScope(req, url, SCOPE_WRITE);
      if (denied) return denied;
      try {
        const body = (await req.json()) as {
          channel?: string;
          request_id: string;
          tool_name: string;
          description: string;
          input_preview: string;
        };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        if (!transport.sendPermission) return methodMissing(body.channel!, "sendPermission");
        const args: PermissionArgs = {
          channel: body.channel!,
          request_id: body.request_id,
          tool_name: body.tool_name,
          description: body.description,
          input_preview: body.input_preview,
        };
        const result = await transport.sendPermission(args);
        return json({ sent: result.sent });
      } catch (err) {
        return errResponse(err);
      }
    }

    // Download attachment — bridge-facing: requires `agent:write`.
    if (req.method === "POST" && url.pathname === "/api/download") {
      const denied = await requireScope(req, url, SCOPE_WRITE);
      if (denied) return denied;
      try {
        const body = (await req.json()) as { channel?: string; file_id: string };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        if (!transport.download) return methodMissing(body.channel!, "download");
        const args: DownloadArgs = { channel: body.channel!, file_id: body.file_id };
        const result = await transport.download(args);
        return json({ path: result.path });
      } catch (err) {
        return errResponse(err);
      }
    }

    // Vault inbound webhook — a vault trigger POSTs here when a new
    // `#agent/message/inbound` note appears. Resolves the target channel from
    // `note.metadata.channel`, asserts it's a vault-transport channel, and hands
    // the note to that transport's `ingestInbound`, which `ctx.emit`s it →
    // wakes the subscribed bridge / MCP session.
    //
    // Auth — two paths, in order:
    //   1. PREFERRED: `Authorization: Bearer <hub JWT>` (aud:agent, scope
    //      `agent:send` — the trigger is effectively "posting an inbound
    //      message"). The hub registers the trigger with `action.auth.bearer`
    //      set to a minted agent:send token, so a fresh setup never touches a
    //      shared secret. Validated via the same scope-guard path as the bridge.
    //   2. DEPRECATED back-compat: a shared `?secret=` (or `X-Channel-Webhook-Secret`)
    //      validated against the target channel's vault-transport `webhookSecret`,
    //      for existing manual setups whose triggers still ride the secret in the
    //      URL. Logs a one-line deprecation warning when used.
    // A request with NEITHER → 401. We keep the uniform-401 (no channel
    // enumeration) behavior on both paths.
    if (req.method === "POST" && url.pathname === "/api/vault/inbound") {
      let body: {
        trigger?: string;
        event?: string;
        note?: {
          id?: string;
          path?: string;
          content?: string;
          tags?: string[];
          metadata?: Record<string, unknown>;
          // The vault `send: "json"` trigger payload includes the note's attachments
          // inline (each `{ id, path, mimeType, ... }`) — the has-attachments signal +
          // fast-path the transport uses to surface inbound files (Phase 1).
          attachments?: Array<{ id?: string; path?: string; mimeType?: string }>;
        };
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const note = body.note;
      if (!note || typeof note.id !== "string" || !note.id) {
        return json({ error: "body must include note.id" }, 400);
      }
      // Dual-read the routing key: the NEW `agent` field, falling back to the legacy
      // `channel` field (the expand-phase dual-read) — a note written by either an
      // agent-speaking or a legacy channel-speaking writer routes.
      const channelName = noteAgentKey(note.metadata);
      if (!channelName) {
        return json(
          { error: "note.metadata.agent (or legacy channel) is required to route the message" },
          400,
        );
      }
      const ch = channels.get(channelName);
      const vt = ch?.transport instanceof VaultTransport ? ch.transport : undefined;

      // Branch on Authorization-header PRESENCE, not token truthiness. A
      // whitespace-only `Authorization: Bearer   ` (which extractBearer trims to
      // empty/falsy) must NOT fall through to the `?secret=` path — that would let
      // a caller who knows the secret but lacks a valid JWT force the secret path.
      // Any Authorization header at all → JWT path, full stop; a malformed/empty
      // token fails hard via requireScope's 401. The deprecated `?secret=`
      // fallback runs ONLY when there is no Authorization header.
      const authHeader = req.headers.get("authorization");
      if (authHeader !== null) {
        // JWT path — validate the hub token, require agent:send. This is a
        // tailnet-reachable webhook, so we keep it uniform-401: any auth failure
        // (missing/malformed/expired token OR insufficient scope OR unknown
        // channel) collapses to the SAME 401, so it can't be probed for valid
        // scopes or channel names. (requireScope would otherwise distinguish 401
        // vs 403 — fine for the operator-facing config API, but this endpoint
        // stays opaque.)
        const denied = await requireScope(req, url, SCOPE_SEND);
        if (denied || !vt) {
          return json({ error: "unauthorized" }, 401);
        }
      } else {
        // DEPRECATED shared-secret fallback — only reachable with NO Authorization
        // header. The secret is per-channel, so resolve the channel first, then
        // constant-time compare. Uniform 401 for an unknown vault channel, a
        // channel with no configured secret (nothing to validate against), OR a
        // bad secret — never reveal which (no channel enumeration on this
        // tailnet-reachable endpoint). webhookSecretMatches treats an empty/absent
        // configured secret as never-matching, so a JWT-only channel (no secret)
        // can't be opened by a `?secret=` request.
        const presented =
          url.searchParams.get("secret") ?? req.headers.get("x-channel-webhook-secret") ?? "";
        if (!vt || !webhookSecretMatches(presented, vt.webhookSecret ?? "")) {
          return json({ error: "unauthorized" }, 401);
        }
        console.warn(
          `parachute-agent: /api/vault/inbound authenticated via DEPRECATED ?secret= shared secret ` +
            `for channel "${channelName}". Migrate to a hub-JWT trigger (action.auth.bearer, scope agent:send).`,
        );
      }
      // Idempotency: a duplicate trigger delivery for the same note must not
      // double-wake. First-seen → process; already-seen → ack without emitting.
      if (markSeen(note.id)) {
        // Await — ingestInbound is async when the note carries attachments (it fetches
        // the attachment list before emitting). The `note.attachments` inline list from
        // the trigger payload is forwarded as the has-attachments signal (Phase 1).
        await vt.ingestInbound({
          id: note.id,
          content: note.content,
          tags: note.tags,
          metadata: note.metadata,
          ...(note.attachments ? { attachments: note.attachments } : {}),
        });
      }
      // Never write back to the note — the v1 trigger handles its own
      // created/rendered_at markers vault-side.
      return json({ ok: true });
    }

    // ---------------------------------------------------------------------
    // Vault-native agent-def RELOAD webhook — POST /api/vault/agent-def
    // (design 2026-06-17-vault-native-agents, Phase 4a). A vault trigger on
    // `#agent/definition` created/updated/deleted POSTs here; we reload that one
    // agent (per-note granularity). Mirrors /api/vault/inbound's auth (hub JWT,
    // scope agent:send — the trigger is a vault→module action) and its uniform-401.
    // Body: { event?, vault?, note: { id, ... } }. `vault` names the source
    // def-vault (the hub fills it / it defaults to the single configured one when
    // exactly one is bound). Externally `<hub>/agent/api/vault/agent-def`.
    // ---------------------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/vault/agent-def") {
      const denied = await requireScope(req, url, SCOPE_SEND);
      if (denied) return json({ error: "unauthorized" }, 401);
      if (!agentDefs) {
        // No def-vaults configured — nothing to reload. Clean ack (the trigger
        // shouldn't have fired, but don't error a benign delivery).
        return json({ ok: true, reloaded: "skipped" });
      }
      let body: {
        event?: "created" | "updated" | "deleted";
        vault?: string;
        note?: { id?: string; path?: string; metadata?: Record<string, unknown> };
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const noteId =
        typeof body.note?.id === "string" && body.note.id
          ? body.note.id
          : typeof body.note?.path === "string"
            ? body.note.path
            : undefined;
      if (!noteId) {
        return json({ error: "body must include note.id" }, 400);
      }
      // Resolve the source vault: the explicit `vault` field, else the sole
      // configured def-vault (the single-vault default — unambiguous), else 400.
      let vault = typeof body.vault === "string" && body.vault ? body.vault : undefined;
      if (!vault) {
        const names = agentDefs.list();
        const distinct = new Set([...names.map((d) => d.vault)]);
        // Fall back to the lone bound vault even with zero live defs yet.
        if (agentDefs.vaultCount === 1) {
          vault = agentDefs.soleVaultName();
        } else if (distinct.size === 1) {
          vault = [...distinct][0];
        }
      }
      if (!vault) {
        return json({ error: "body.vault is required (multiple def-vaults configured)" }, 400);
      }
      // Coerce `event` to the declared union (it's an untrusted webhook body) — any
      // unrecognized value becomes `undefined` (a hint only; reload() re-reads ground
      // truth regardless, but keep the runtime honest with the type contract).
      const event =
        body.event === "created" || body.event === "updated" || body.event === "deleted"
          ? body.event
          : undefined;
      const result = await agentDefs.reload(vault, noteId, event);
      return json({ ok: true, reloaded: result });
    }

    // One-time SSE ticket mint — POST /api/ui/sse-ticket (agent#25). The chat
    // page can't put its hub JWT in an EventSource URL without leaking it into
    // access logs, so it trades the JWT (presented HERE as a Bearer header — no
    // leak) for a single-use, ≤60s opaque ticket it puts in the SSE URL instead.
    // Bearer-gated on `agent:read` (the scope both browser SSE streams require);
    // the minted ticket carries ONLY the token's own validated scopes, so it can
    // never authorize more than the JWT did. An unauthenticated mint is impossible
    // — `mintSseTicket` runs the scope gate before issuing anything. Returns
    // `{ ticket, expires_at }`. Externally `<hub>/agent/api/ui/sse-ticket`.
    if (req.method === "POST" && url.pathname === "/api/ui/sse-ticket") {
      return mintSseTicket(req, url, SCOPE_READ, mintTicket);
    }

    // Turn-event SSE — GET /api/channels/<ch>/turn-events (chat-facing; gated on
    // a one-time SSE ticket carrying `agent:read`). The streaming
    // view (design 2026-06-16 build item #1): the chat subscribes here to watch a
    // PROGRAMMATIC turn work in real time — interim assistant text + tool_use, then a
    // done/error lifecycle event. EPHEMERAL by design: no backlog/replay (the durable
    // record is the `#agent/message/outbound` note the turn still writes). A channel
    // with no programmatic agent simply never receives a `turn` frame (the stream
    // stays open + idle). Open to any live channel — unknown channel still opens the
    // stream (it just never emits), matching the low-stakes ephemeral contract.
    // Externally `<hub>/agent/api/channels/<ch>/turn-events`.
    {
      const turnMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/turn-events$/);
      if (req.method === "GET" && turnMatch) {
        // Browser EventSource can't set an Authorization header, so this SSE
        // authenticates via a one-time `?ticket=<nonce>` (agent#25) — minted by
        // POST /api/ui/sse-ticket (Bearer-gated) and consumed single-use here. The
        // hub JWT never rides in this URL. (The stdio-bridge /events SSE uses a
        // Bearer header, so it never needed a query credential at all.)
        const denied = requireSseTicket(url, SCOPE_READ);
        if (denied) return denied;
        const channelName = decodeURIComponent(turnMatch[1]!);
        const clientId = crypto.randomUUID();
        const stream = new ReadableStream<string>({
          start(controller) {
            turnEvents.add(clientId, {
              channel: channelName,
              enqueue: (payload) => controller.enqueue(payload),
            });
            controller.enqueue(": connected\n\n");
          },
          cancel() {
            turnEvents.remove(clientId);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }
    }

    // Transcript read — GET /api/channels/<ch>/messages (chat-facing; gated on
    // `agent:read`, same as /ui/events). The built-in chat polls this to render
    // a channel's durable history and pick up replies + messages from other
    // clients (Telegram, other browsers). Behavior by transport:
    //   - vault → loadTranscript() against the channel's vault (the daemon does
    //     the vault I/O with the channel's stored vault token — the chat's
    //     agent:read token never touches the vault).
    //   - http-ui → that transport's traffic is ephemeral (SSE-only, no buffer),
    //     so there's no durable transcript to replay → { messages: [] }.
    //   - other (telegram) → no transcript surface here → { messages: [] }.
    // 404 for an unknown channel. Externally `<hub>/agent/api/channels/<ch>/messages`.
    {
      const msgMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
      if (req.method === "GET" && msgMatch) {
        const denied = await requireScope(req, url, SCOPE_READ);
        if (denied) return denied;
        const channelName = decodeURIComponent(msgMatch[1]!);
        const ch = channels.get(channelName);
        if (!ch) {
          return json(
            {
              error: `unknown channel "${channelName}" — known channels: ${[...channels.keys()].join(", ") || "(none)"}`,
            },
            404,
          );
        }
        if (ch.transport instanceof VaultTransport) {
          try {
            const messages = await ch.transport.loadTranscript();
            return json({ messages });
          } catch (err) {
            // The vault read failed (unreachable / bad token / 5xx). Surface a
            // 502 so the chat shows "couldn't load history" rather than a silent
            // empty transcript that looks like "no messages yet".
            return json({ error: String(err) }, 502);
          }
        }
        // http-ui + telegram: no durable transcript to replay here.
        return json({ messages: [] });
      }
    }

    // Send for a VAULT channel — POST /api/channels/<ch>/send (chat-facing; gated
    // on `agent:send`, same scope http-ui's send uses). The daemon owns this for
    // vault transports because the http-ui transport's ingestHttp only matches its
    // OWN channel name; a vault channel needs the daemon to dispatch. For a vault
    // channel the daemon writes a `#agent/message/inbound` note via the channel's
    // stored vault token — which WAKES the session through the existing vault
    // trigger (we do NOT also emit; that would double-wake). http-ui channels fall
    // through to their transport's ingestHttp (unchanged), so this guard handles
    // ONLY vault channels and passes everything else on.
    {
      const sendMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/send$/);
      if (req.method === "POST" && sendMatch) {
        const channelName = decodeURIComponent(sendMatch[1]!);
        const ch = channels.get(channelName);
        // Only intercept VAULT channels; let http-ui keep its ingestHttp send path
        // (and an unknown channel falls through to the final 404, matching prior
        // behavior — http-ui's ingestHttp also only answered for a live channel).
        if (ch && ch.transport instanceof VaultTransport) {
          const denied = await requireScope(req, url, SCOPE_SEND);
          if (denied) return denied;
          let text: string;
          try {
            const body = (await req.json()) as { text?: unknown };
            if (typeof body.text !== "string" || body.text.length === 0) {
              return json({ error: "body must be { text: <non-empty string> }" }, 400);
            }
            text = body.text;
          } catch {
            return json({ error: "invalid JSON body" }, 400);
          }
          try {
            // Writing the inbound note IS the wake (via the vault trigger) — the
            // transport deliberately does not emit. Return { ok, id } so the chat
            // can reconcile its optimistic echo against the real note id on the
            // next poll.
            const { id } = await ch.transport.writeInbound(text, "operator");
            return json({ ok: true, id });
          } catch (err) {
            return errResponse(err);
          }
        }
      }
    }

    // Retired built-in chat page (Phase 4c) — the SPA Chat view replaces it.
    // EXACT `/ui` only (NOT a prefix): `/ui/events` is the message SSE the SPA
    // Chat depends on and is owned by the http-ui transport's `ingestHttp` (run
    // at the bottom of this handler) — it MUST keep routing. Redirect to the SPA
    // Chat route: relative `app/chat` → `/app/chat` direct / `/agent/app/chat`
    // proxied, which the SPA BrowserRouter (basename `/app`|`/agent/app`) renders
    // as the `/chat` route (`web/ui/src/App.tsx`).
    if (req.method === "GET" && url.pathname === "/ui") {
      return redirect("app/chat");
    }

    // Retired config/admin page (Phase 4c) — def-vaults + the unified create
    // flow live in the SPA now. 302 to the SPA app root. `configUiUrl` in
    // module.json points at `/agent/app/` so the hub frames the SPA directly.
    if (req.method === "GET" && url.pathname === "/admin") {
      return redirect("app/");
    }

    // Stateful HTTP MCP — a session connects directly over HTTP (URL + OAuth,
    // no stdio bridge): POST/GET/DELETE /mcp/<channel>. Externally this is
    // `<hub>/agent/mcp/<channel>`; hub's stripPrefix removes `/agent`, so the
    // daemon sees `/mcp/<channel>`. A session needs `agent:read` to connect +
    // receive the wake; the reply/react/edit tools additionally require
    // `agent:write`, enforced inside the tool handlers from the connection's
    // own scopes. This endpoint is ADDITIVE — the stdio bridge over /events is
    // unchanged.
    const mcpMatch = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (mcpMatch) {
      const channel = decodeURIComponent(mcpMatch[1]!);
      const transport = transportFor(channel);
      if (!transport) {
        return json(
          {
            error: `unknown channel "${channel}" — known channels: ${[...channels.keys()].join(", ") || "(none)"}`,
          },
          404,
        );
      }
      // Gate on agent:read — short-circuits to 401 pre-JWKS when no token is
      // presented (testable without a live hub, same as the other endpoints).
      // On a 401 (no/invalid bearer), decorate with the RFC 9728
      // `WWW-Authenticate` challenge so a Claude Code HTTP-MCP client knows
      // where to discover OAuth (mirrors vault's withMcpChallenge). The other
      // endpoints (/events, /api/*) stay plain 401 — only the /mcp path drives
      // a spec OAuth client, so only it carries the challenge.
      const denied = await requireScope(req, url, SCOPE_READ);
      if (denied) {
        if (denied.status === 401) {
          const headers = new Headers(denied.headers);
          headers.set("WWW-Authenticate", mcpWwwAuthenticate(req, channel));
          return new Response(await denied.text(), { status: 401, headers });
        }
        return denied;
      }
      // Re-validate to surface the caller's scopes for the write-tool checks.
      // (requireScope already proved the token valid + carrying agent:read;
      // this second pass hits the warm JWKS cache.) A token present but missing
      // here would have been rejected above, so claims must resolve.
      let scopes: string[] = [];
      try {
        const token = extractToken(req, url);
        if (token) scopes = (await validateHubJwt(token)).scopes;
      } catch {
        // Unreachable in practice (requireScope passed); fall back to read-only.
        scopes = [SCOPE_READ];
      }
      return handleMcp(req, channel, transport, scopes, attachedQueue);
    }

    // Give each transport a chance to handle a route the daemon didn't. Runs
    // after the daemon's own built-in routes and before the final 404. A
    // transport returns a Response if it owns the path, or null to pass.
    for (const ch of channels.values()) {
      const res = await ch.transport.ingestHttp?.(req, url);
      if (res) return res;
    }

    return json({ error: "not found" }, 404);
  };
}

// ---------------------------------------------------------------------------
// Request helpers (module-scope; hoisted, referenced from inside the factory)
// ---------------------------------------------------------------------------

/**
 * Map a thrown error to a response: ChannelConfigError → 400 (operator must fix
 * config), anything else → 500 (runtime fault). Lets callers distinguish the two.
 */
function errResponse(err: unknown): Response {
  if (err instanceof ChannelConfigError) return json({ error: err.message }, 400);
  return json({ error: String(err) }, 500);
}

/**
 * Build the meta map for outbound calls. Telegram addressing historically came
 * in as a top-level `chat_id`; preserve that by folding it into `meta.chat_id`
 * while letting an explicit `meta` object take precedence/extend.
 */
function mergeMeta(body: { chat_id?: string; meta?: Record<string, string> }): Record<string, string> {
  const meta: Record<string, string> = { ...(body.meta ?? {}) };
  if (body.chat_id !== undefined && meta.chat_id === undefined) meta.chat_id = body.chat_id;
  return meta;
}

function toReplyArgs(body: {
  channel?: string;
  chat_id?: string;
  text?: string;
  reply_to?: string;
  files?: string[];
  meta?: Record<string, string>;
}): ReplyArgs {
  return {
    channel: body.channel!,
    text: body.text,
    files: body.files,
    reply_to: body.reply_to,
    meta: mergeMeta(body),
  };
}

// ---------------------------------------------------------------------------
// Boot — load the registry, bind Bun.serve, start every transport.
//
// Gated on `import.meta.main` so importing this module (e.g. from a test that
// only wants `createFetchHandler` / `requireScope`) does NOT load the registry,
// bind a port, or `process.exit` on a missing config.
// ---------------------------------------------------------------------------

function main(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(INBOX_DIR, { recursive: true });

  // BOOT DEPENDENCY PREFLIGHT (agent#156). A fresh box can't run a programmatic
  // `claude -p` turn until bwrap/rg/socat + the claude CLI are on PATH — pre-#156
  // each surfaced only as a failed *turn*, one at a time. Check them ONCE at boot and
  // log a single clear warning (with the install one-liners) when any is missing. It's
  // advisory, never fatal: the daemon may run only attached-backend agents that need
  // none of these, so we warn + keep serving. The result is also surfaced on /health.
  const preflight = runBootPreflight();

  // Verify the one MCP SDK internal our HTTP-MCP delivery accounting reads
  // (`_streamMapping['_GET_stream']`, see assertMcpSdkStreamContract). A screaming
  // boot error on SDK drift beats discovering it as silent message loss later.
  assertMcpSdkStreamContract();

  let channels: Map<string, Channel>;
  try {
    channels = loadRegistry({ stateDir: STATE_DIR });
  } catch (err) {
    console.error(`parachute-agent: failed to load channel registry: ${err}`);
    process.exit(1);
  }

  if (channels.size === 0) {
    // Zero channels is a valid STARTING state, not a fatal error. The daemon must
    // stay up and serve its HTTP surface so an operator can create the first agent
    // (the /agent/admin + create-agent UI POST to this very daemon — exiting here is
    // a chicken-and-egg: you couldn't define the first channel), and so future
    // vault-defined agents can appear into a running module. Channels added live
    // (via the API/UI, or hot-added) are picked up immediately. So: warn + idle.
    console.warn(
      `parachute-agent: no channels configured yet — starting idle.\n` +
        `  Create an agent via the admin UI at /agent/app/ (or add ${join(STATE_DIR, "channels.json")}).\n` +
        `  The daemon stays up; channels added live are picked up immediately.`,
    );
  }

  const registry = new ClientRegistry();

  // Per-channel delivery high-water-mark store, constructed ONCE at boot with the
  // daemon's boot time as the default mark — so a channel with no persisted mark
  // replays only messages that arrive AFTER this start (the deaf-window case),
  // never its whole vault history. Persisted marks (from a prior run) survive the
  // restart and replay exactly the gap. Shared by `contextFor.emit` (advance) and
  // both connect-hook replays (MCP session + SSE bridge).
  const deliveryState = new DeliveryState({
    stateDir: STATE_DIR,
    defaultMark: new Date().toISOString(),
  });

  // The per-channel turn-event SSE registry (the streaming view, design build item
  // #1), constructed ONCE at boot and shared by the fetch handler's
  // `/api/channels/<ch>/turn-events` route (subscriber registration) and the
  // programmatic registry's turn-event sink (live-progress fan-out) — so a turn's
  // interim events reach the chat subscribers the route registered.
  const turnEvents = new ClientRegistry();

  // The PROGRAMMATIC-agent registry (design 2026-06-16), constructed ONCE at boot
  // and shared by the fetch handler (the /api/agents + /health routes), the
  // transports' `contextFor` (inbound enqueue), and the boot re-register below — so
  // the SAME instance the routes operate on is the one inbound enqueues onto. Built
  // here (not lazily in createFetchHandler) precisely so the transports started
  // below route inbound to it. Threaded with the turn-event sink so each turn streams
  // its interim progress to `turnEvents` (the chat's live view).
  const programmatic = createDefaultProgrammaticRegistry(channels, buildTurnEventSink(turnEvents));

  // The ATTACHED-backend queue registry (design 2026-06-18-channel-backend.md),
  // constructed ONCE at boot and shared by the fetch handler (the channel MCP surface),
  // the transports' `contextFor` (the routing fork — an attached inbound is NOT enqueued
  // to the programmatic worker), the agent-def instantiate path (a `backend:attached`
  // def registers here, not with programmatic), and the periodic sweep below. The
  // durable queue + claim state lives on the inbound notes in each channel's vault, so
  // this registry holds no per-message state of its own — it's the claim/peek/reply
  // surface over those notes.
  const attachedQueue = new AttachedQueueRegistry();

  // The terminal WS handler set (pty↔socket relay + backpressure flow control,
  // src/terminal.ts). One handler object serves every terminal connection;
  // per-connection state lives on `ws.data`. The fetch handler routes accepted
  // upgrades into these via `server.upgrade(req, { data })`.
  const terminalWs = createTerminalWsHandlers();

  // The vault-native scheduled-job store + the runner (design 2026-06-17). The
  // store reads/writes `#agent/job` notes in each vault channel's vault; the
  // runner ticks every 30s, loading jobs from the store, firing due ones by
  // injecting an inbound note onto the job's vault channel (the existing trigger →
  // agent-turn → outbound flow does the rest). Shared with the fetch handler so
  // the /api/jobs routes + the scheduler operate on the SAME store, and "Run now"
  // goes through the runner's bookkeeping path.
  const jobStore = new VaultJobStore(channels);
  const runner = new Runner({
    loadJobs: () => jobStore.listAll(),
    // Fire = inject an inbound note onto the job's vault channel, exactly like a
    // human typing in chat. Resolve the channel's vault transport at fire time so
    // a job whose channel was deleted logs + records an error rather than throwing
    // the tick. No new authority — uses the channel's existing vault write token.
    fire: async (job) => {
      const transport = vaultTransportFor(channels, job.channel);
      if (!transport) {
        throw new Error(`channel "${job.channel}" is not a live vault channel`);
      }
      await transport.injectInbound({ content: job.message, sender: `runner:${job.id}` });
    },
    // Persist bookkeeping (lastRunAt/lastStatus) back onto the job note (addressed
    // by its vault note id). A job loaded from the store always carries `noteId`.
    persistFire: async (job) => {
      if (!job.noteId) return; // nothing to address (shouldn't happen for a loaded job).
      await jobStore.patch(job.noteId, job.channel, {
        lastRunAt: job.lastRunAt,
        lastStatus: job.lastStatus,
      });
    },
    driver: realTickDriver(),
  });

  // The vault-native agent-def registry (design 2026-06-17-vault-native-agents,
  // Phase 4a). Reads `#agent/definition` notes from the configured def-vaults and
  // instantiates each as a live agent (a vault channel + a programmatic agent) via
  // the SAME machinery the create-agent flow uses (buildInstantiateDeps). Constructed
  // here (empty) so it's shared with the fetch handler's reload webhook; the boot
  // resolve below (resolveDefVaults → addVault → loadAll) fills it. ADDITIVE to
  // channels.json — both paths coexist.
  const agentDefs = new AgentDefRegistry(
    buildInstantiateDeps(channels, registry, deliveryState, programmatic, attachedQueue),
  );

  const fetchHandler = createFetchHandler(channels, registry, { deliveryState, programmatic, attachedQueue, turnEvents, jobStore, runner, agentDefs, preflight });
  const server = Bun.serve<TerminalWsData, never>({
    port: PORT,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    // `fetch` receives `server` as its 2nd arg at runtime — needed for
    // `server.upgrade()` on the terminal WS route.
    fetch: (req, srv) => fetchHandler(req, srv),
    websocket: terminalWs,
  });

  console.log(`parachute-agent: daemon listening on http://127.0.0.1:${PORT}`);
  console.log(`parachute-agent: state dir: ${STATE_DIR}`);
  console.log(
    `parachute-agent: ${channels.size} channel(s): ${[...channels.values()]
      .map((c) => `${c.name}→${c.transport.kind}`)
      .join(", ")}`,
  );

  // Self-register into ~/.parachute/services.json so hub lists this module in the
  // portal and reverse-proxies `<expose>/agent/*` → this loopback daemon.
  // Best-effort: a failure must not stop the daemon from serving locally. Honors
  // PARACHUTE_HOME, so sandboxed/e2e daemons never touch the real services.json.
  try {
    upsertService({
      name: "parachute-agent",
      port: PORT,
      paths: ["/agent"],
      health: "/health",
      version: PKG_VERSION,
      displayName: "Agent",
      tagline: "Chat with your Claude Code sessions — a channel per session.",
      installDir: INSTALL_DIR,
      // The command the hub supervisor spawns to start/restart/adopt us. Without
      // this the supervisor knows our port but not how to launch the process, so
      // `parachute restart agent` 404s and we don't survive reboot (agent#34).
      startCmd: START_CMD,
      stripPrefix: true,
      uiUrl: "/agent/app/", // portal "Open UI" link → the SPA (canonical in module.json, which hub prefers; written here only as a services.json fallback hint)
      configUiUrl: "/agent/app/", // module-owned config surface (modular-UI P4); hub frames/links it. Canonical in module.json (hub prefers it); this is a services.json fallback hint.
      // WebSocket support — tells the hub's Bun-native upgrade bridge to forward
      // `Upgrade: websocket` requests on `/agent/*` to this daemon (the
      // in-page terminal, design §5.1). DENY-BY-DEFAULT in the hub: without this
      // the upgrade is refused (426) before it ever reaches us. Declared on
      // module.json too (the install-time contract); the hub honors either
      // source. No hub change needed — the hub already reads this field.
      websocket: true,
      // The terminal mount, declared as a `uis` sub-unit with audience "surface"
      // so the hub's audience gate PASSES IT THROUGH (the agent daemon owns
      // admission end-to-end — operator-grade agent:admin, enforced here). A
      // `surface` audience is the same pass-through the no-uis-match default
      // gives, but declaring it explicitly future-proofs against a later `uis`
      // declaration accidentally gating the terminal at hub-users. Design §5.3.
      uis: {
        // The web spawn/list/kill surface — the DEFAULT way to operate (spawn an
        // agent, scope it, watch it). audience "surface" so the hub passes it
        // through; agent owns admission end-to-end (operator-grade agent:admin,
        // enforced on every /api/agents call). Design §4/§5.
        agents: {
          displayName: "Agents",
          tagline: "Spawn, scope, and watch sandboxed Claude Code sessions.",
          path: "/agent/agents",
          audience: "surface",
        },
        terminal: {
          displayName: "Terminal",
          tagline: "Attach to a session's live tmux pane in the browser.",
          path: "/agent/terminal",
          audience: "surface",
        },
      },
    });
    console.log(`parachute-agent: self-registered into services.json (port ${PORT}, mount /agent)`);
  } catch (err) {
    console.error(`parachute-agent: services.json self-registration failed (continuing): ${err}`);
  }

  // Start each channel via the same single-channel add path the config API uses
  // (`addChannelLive`), so boot and hot-add can't drift. The map already holds
  // the channels (from `loadRegistry`); addChannelLive replaces-in-place, which
  // for a freshly-instantiated boot transport means stop()→re-instantiate→start.
  // Per-channel failures are logged and don't abort the others; the daemon must
  // still serve the channels that did come up. Pass the programmatic registry so a
  // channel with a registered programmatic agent routes inbound to its serial queue.
  for (const channel of [...channels.values()]) {
    addChannelLive(channels, registry, channel.entry, deliveryState, programmatic, attachedQueue).catch((err) => {
      console.error(`parachute-agent: transport "${channel.name}" start failed:`, err);
    });
  }

  // BOOT RE-REGISTER (design 2026-06-16 step 2). A programmatic agent has NO
  // resident process, so it doesn't survive a daemon restart as a tmux session
  // would — but its spec.json (carrying `backend: "programmatic"`) persists. Scan
  // the per-session workspaces and re-register every programmatic spec so inbound
  // for its channel resumes routing to an on-demand turn (the session UUID on the
  // `#agent/thread` note makes the next turn `--resume` the prior conversation — no
  // deaf problem). Best-
  // effort: a single bad spec is logged and skipped. The live `channels` map gates
  // it: only a spec whose wake channel is a configured channel is re-registered, so
  // a leaked/orphaned spec dir can't resurrect a phantom agent (agent#75).
  void reregisterProgrammaticAgents(programmatic, channels);

  // Start the runner's scheduled-job tick (design 2026-06-17). Tolerant of an
  // empty/missing job set (no `#agent/job` notes → idle) and of a daemon with no
  // vault channels (listAll queries nothing → idle). A job targeting a now-deleted
  // channel sets lastStatus:error on fire rather than throwing the tick. The tick
  // is `unref`'d so it never keeps the process alive on its own.
  runner.start();
  console.log(`parachute-agent: runner started (scheduled-job tick)`);

  // ATTACHED-BACKEND CLAIM TTL SWEEP (design 2026-06-18-channel-backend.md). A periodic
  // tick scans every attached-backend agent's in-flight inbound notes and resets any
  // claimed longer than the claim TTL (15 min) back to `pending` — so a crashed /
  // abandoned connected session can't strand the queue. Cheap + idempotent (a
  // channel with no attached agents lists nothing). `unref` so it never holds the
  // process open; runs at the same 30s cadence as the runner tick.
  const sweepIntervalMs = parseInt(process.env.PARACHUTE_AGENT_SWEEP_MS ?? "", 10) || 30_000;
  const channelSweep = setInterval(() => {
    void attachedQueue.sweepExpired().catch((err) => {
      console.error(`parachute-agent: attached-queue sweep failed (continuing): ${(err as Error).message}`);
    });
  }, sweepIntervalMs);
  channelSweep.unref?.();

  // VAULT-NATIVE AGENT DEFINITIONS (design 2026-06-17-vault-native-agents, Phase 4a).
  // Resolve the def-vault bindings (agent-vaults.json, or the minted single-`default`
  // default), add each to the registry, and instantiate every `#agent/definition`
  // note in them — each becomes a live agent (a vault channel + a programmatic agent).
  // Fire-and-forget so a slow/unreachable vault never blocks the daemon from serving;
  // the reload webhook (POST /api/vault/agent-def) keeps them in sync reactively, and
  // a poll fallback re-syncs vaults without trigger support. Best-effort throughout —
  // a def-vault failure is logged and never affects channels.json-defined channels.
  let agentDefPoll: ReturnType<typeof setInterval> | undefined;
  void (async () => {
    let managerBearer: string | null = null;
    try {
      managerBearer = resolveSpawnDeps().managerBearer;
    } catch {
      // No operator token yet — resolveDefVaults handles the null (idle vault-native
      // path; channels.json unaffected).
    }
    // 4b: wire the hub grants client now the manager bearer is resolved (the registry
    // was constructed before the operator token was read). With it, each def's `wants:`
    // connections register as pending grants on instantiate + status derives from the
    // hub's grant statuses. No bearer → null → the registry falls back to the pure
    // status (pending if anything is declared) and the vault-native path still runs
    // own-vault. design 2026-06-17-agent-connectors-4b.md.
    if (managerBearer) {
      agentDefs.setGrantsClient(new GrantsClient({ hubOrigin: getHubOrigin(), managerBearer }));
    }
    const bindings = await resolveDefVaults({ hubOrigin: getHubOrigin(), managerBearer });
    for (const b of bindings) agentDefs.addVault(b);
    if (bindings.length === 0) return; // nothing bound — vault-native path idle.

    // AUTO-REGISTER the per-def-vault runtime triggers (agent#157) so "define an
    // agent → it runs" needs NO manual trigger setup + NO restart-to-pick-up:
    //   - the def-watch create/edit triggers, BARE-keyed (`agent/definition`) so a
    //     created/edited def auto-fires the rescan — upsert-by-name REPLACES any
    //     stale `#agent/definition`-keyed `conn_agentdefs-*` row the hub provisioned;
    //   - the inbound trigger (`agent/message/inbound` + has_metadata:[agent]) so a
    //     new inbound note wakes the agent without a hand-registered trigger.
    // Mints the admin (triggers API) + agent:send (webhook bearer) tokens the same
    // way the hub's Connections engine does (attenuated to the operator bearer).
    // Best-effort: a mint refusal / unreachable vault is logged, never fatal — the
    // 60s loadAll poll below stays the correctness floor. Skipped with no operator
    // bearer (can't mint) — the vault-native path still runs own-vault.
    if (managerBearer) {
      await registerAllDefVaultTriggers(bindings, { hubOrigin: getHubOrigin(), managerBearer }).catch(
        (err) => {
          console.warn(
            `parachute-agent: def-vault trigger auto-registration failed (continuing): ${(err as Error).message}`,
          );
        },
      );
    }

    const n = await agentDefs.loadAll();
    console.log(
      `parachute-agent: vault-native agent defs — ${n} instantiated from ${bindings.length} def-vault(s).`,
    );
    // Poll fallback (every 60s): re-load all defs so a created/updated/deleted note
    // converges even with no webhook. The created/updated reload webhook is the fast path;
    // this is the safety net — AND the ONLY automatic path for a DELETE (there is no vault
    // `deleted` trigger, so a def removed out-of-band converges only here; loadAll's
    // removed-def diff deregisters the orphaned agent). `unref` so it never holds the
    // process open. Cheap + idempotent (re-instantiate replaces in place).
    const interval = parseInt(process.env.PARACHUTE_AGENT_DEF_POLL_MS ?? "", 10) || 60_000;
    agentDefPoll = setInterval(() => {
      void agentDefs.loadAll().catch((err) => {
        console.error(`parachute-agent: agent-def poll failed (continuing): ${(err as Error).message}`);
      });
    }, interval);
    agentDefPoll.unref?.();
  })().catch((err) => {
    console.error(`parachute-agent: vault-native agent-def boot failed (continuing): ${(err as Error).message}`);
  });

  // Graceful shutdown — stop the runner + all transports.
  async function shutdown(): Promise<void> {
    runner.stop();
    clearInterval(channelSweep);
    if (agentDefPoll) clearInterval(agentDefPoll);
    await Promise.allSettled([...channels.values()].map((c) => c.transport.stop()));
    server.stop();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) main();
