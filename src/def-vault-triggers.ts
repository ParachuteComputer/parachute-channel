/**
 * Auto-register the per-def-vault runtime triggers the daemon needs so that
 * "just define an agent in the vault and it works" — no manual trigger setup, no
 * `parachute restart agent` to pick up a new/edited def (agent#157).
 *
 * Two wiring gaps this closes:
 *
 *  1. **Def-watch triggers were stale `#`-keyed.** A def-vault carried
 *     `conn_agentdefs-create-<vault>` / `conn_agentdefs-edit-<vault>` triggers
 *     keyed on the PRE-canonicalization tag `#agent/definition`. Since defs are
 *     now bare `agent/definition`, those triggers never fired → creating/editing
 *     a def did NOT auto-rescan; only the 60s `loadAll` poll converged it. We
 *     re-register them BARE-keyed on (re)start, upsert-by-name, so the stale
 *     `#`-keyed rows are REPLACED in place (the runtime triggers API is an upsert
 *     by `name`, and we reuse the hub's `conn_agentdefs-{create,edit}-<vault>`
 *     names so our POST overwrites the hub-provisioned ones).
 *
 *  2. **The inbound trigger was never auto-registered.** Defining a def + the
 *     daemon discovering it (the channel appears) is NOT enough — nothing wakes
 *     the agent until an `agent_inbound` trigger fires the inbound webhook. The
 *     hub provisioned it only via the operator's explicit "Connect" click (or the
 *     hub Connections builder); a fresh box needed it registered BY HAND. We now
 *     register ONE inbound trigger per def-vault on (re)start (one trigger routes
 *     ALL agents in the vault by `metadata.agent`).
 *
 * ## How this mirrors the hub's provisioning path
 *
 * The hub's Connections engine (`parachute-hub/src/admin-connections.ts`) already
 * registers these triggers by:
 *   - minting a `vault:<v>:admin` token (the triggers API is ADMIN-scoped — a
 *     webhook trigger exfiltrates note data, so even listing is admin, not write),
 *   - minting an `agent:send` webhook bearer for `action.auth.bearer`,
 *   - POSTing `{ name, events, when, action }` to
 *     `<vaultUrl>/vault/<v>/api/triggers` (upsert by name),
 *   - naming the def-watch triggers `conn_agentdefs-{create,edit}-<vault>`.
 *
 * We do the SAME thing, daemon-side, on boot — reusing the daemon's own
 * `mintScopedToken` (attenuated to the operator bearer) for BOTH mints. This is
 * the credential the hub uses too; the daemon already holds the operator bearer
 * (it mints the def-vault `vault:<v>:write` token the same way), so the admin mint
 * succeeds exactly when the operator's authority covers it.
 *
 * ## Scope caveat (admin mint)
 *
 * The triggers API requires `vault:<v>:admin`. The def-vault token the daemon
 * persists in `agent-vaults.json` is only `vault:<v>:write`, so we CANNOT register
 * triggers with that token — we MINT a short-lived `vault:<v>:admin` token against
 * the operator bearer instead. If the operator bearer's own authority doesn't cover
 * `vault:<v>:admin`, the hub returns `invalid_scope` on the mint (the same bound the
 * hub's own provisioning hits) — we log + skip, never crash boot. The 60s `loadAll`
 * poll remains the correctness floor either way.
 *
 * ## Webhook URL
 *
 * The webhook points at `<hub-origin>/agent/api/vault/{inbound,agent-def}` — the
 * hub origin + the agent module's `/agent` proxy mount + the action endpoint
 * (mirrors the hub's `buildWebhook` and the `AGENT_*_VAULT_TRIGGER_TEMPLATE`
 * placeholders). The hub reverse-proxies `/agent/*` to the loopback daemon, so
 * this works co-located AND exposed; and the daemon validates the webhook bearer's
 * `iss` against the hub origin anyway, so the hub origin is the right base.
 *
 * Best-effort throughout: every failure is caught + logged, never thrown — a
 * def-vault with no admin authority (or an unreachable vault) must never block the
 * daemon from serving, and the poll fallback covers reactivity.
 */

import type { DefVaultBinding } from "./agent-defs.ts";
import { mintScopedToken, vaultScope, MintError } from "./mint-token.ts";
import { DEFAULT_DEF_VAULT_URL } from "./def-vaults.ts";

/** The bare def-discriminator tag the def-watch triggers filter on (post-canonicalization). */
export const DEFINITION_TAG = "agent/definition";
/** The bare inbound-message child tag the inbound trigger fires on. */
export const INBOUND_TAG = "agent/message/inbound";

/** The `agent:send` scope minted for every webhook `action.auth.bearer`. */
const WEBHOOK_SCOPE = "agent:send";
/** Short TTL for the throwaway `vault:<v>:admin` registration token. */
const ADMIN_MINT_TTL_SECONDS = 60;

/**
 * The shape POSTed to `<vaultUrl>/vault/<v>/api/triggers`. The vault validates
 * `events` ⊆ {created, updated} (NO `deleted` — so the def-watch is two triggers,
 * create + edit, not one create/updated/deleted trigger).
 */
export interface VaultTriggerInput {
  name: string;
  events: Array<"created" | "updated">;
  when: {
    tags: string[];
    has_metadata?: string[];
    missing_metadata?: string[];
  };
  action: {
    webhook: string;
    send: "json";
    auth?: { bearer: string };
  };
}

/**
 * The stable def-watch trigger name for a (vault, kind). MUST match the hub's
 * `conn_${defReloadId(vault, kind)}` (web/ui/src/lib/hub.ts → `agentdefs-<kind>-<vault>`,
 * hub admin-connections → `conn_<id>`) so our upsert REPLACES any stale `#`-keyed
 * trigger the hub provisioned, rather than orphaning it alongside a new one.
 */
export function defWatchTriggerName(vault: string, kind: "create" | "edit"): string {
  return `conn_agentdefs-${kind}-${vault}`;
}

/**
 * The inbound trigger name for a vault. ONE per def-vault — it routes ALL agents
 * by `metadata.agent`, so it isn't per-agent. Stable so the POST upserts in place.
 */
export function inboundTriggerName(vault: string): string {
  return `conn_agentinbound-${vault}`;
}

/** Build the webhook URL `<hub-origin>/agent/api/vault/<endpoint>`. */
function buildWebhook(hubOrigin: string, endpoint: string): string {
  const origin = hubOrigin.replace(/\/+$/, "");
  const ep = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${origin}/agent${ep}`;
}

/**
 * The three triggers a def-vault needs, bare-keyed, with the webhook bearer filled.
 * Exported for tests (asserts the bare tag + the trigger shapes without the live mints).
 */
export function buildDefVaultTriggers(
  vault: string,
  hubOrigin: string,
  webhookBearer: string,
): VaultTriggerInput[] {
  const defWebhook = buildWebhook(hubOrigin, "/api/vault/agent-def");
  const inboundWebhook = buildWebhook(hubOrigin, "/api/vault/inbound");
  const auth = { bearer: webhookBearer };
  return [
    // Def-watch CREATE — a new bare `agent/definition` note instantiates its agent live.
    {
      name: defWatchTriggerName(vault, "create"),
      events: ["created"],
      when: { tags: [DEFINITION_TAG] },
      action: { webhook: defWebhook, send: "json", auth },
    },
    // Def-watch EDIT — an edited bare `agent/definition` note re-instantiates its agent.
    {
      name: defWatchTriggerName(vault, "edit"),
      events: ["updated"],
      when: { tags: [DEFINITION_TAG] },
      action: { webhook: defWebhook, send: "json", auth },
    },
    // INBOUND — a new bare `agent/message/inbound` note (routed by metadata.agent,
    // not yet rendered) wakes the agent. One trigger routes every agent in the vault.
    {
      name: inboundTriggerName(vault),
      events: ["created"],
      when: {
        tags: [INBOUND_TAG],
        has_metadata: ["agent"],
        missing_metadata: ["agent_inbound_rendered_at"],
      },
      action: { webhook: inboundWebhook, send: "json", auth },
    },
  ];
}

/** Dependencies for {@link registerDefVaultTriggers} (injected for tests). */
export interface RegisterTriggersDeps {
  /** Hub public origin (the webhook base + the mint endpoint + the JWT `iss`). */
  hubOrigin: string;
  /** The operator bearer the per-resource mints attenuate against. */
  managerBearer: string;
  /** Inject fetch for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/** The outcome of registering one def-vault's triggers (for logging/tests). */
export interface RegisterTriggersResult {
  vault: string;
  /** Trigger names that registered (HTTP 200). */
  registered: string[];
  /** `name: reason` for each failure (mint refusal, vault non-2xx, fetch error). */
  failures: string[];
}

/**
 * Register (idempotent upsert) the def-watch + inbound triggers for ONE def-vault.
 * Mints a `vault:<v>:admin` token for the triggers API and an `agent:send` token
 * for the webhook bearer, then POSTs each trigger. Best-effort: never throws — a
 * mint refusal (insufficient operator authority) or an unreachable vault is logged
 * and returned in `failures`. The poll fallback is the correctness floor.
 */
export async function registerDefVaultTriggers(
  binding: DefVaultBinding,
  deps: RegisterTriggersDeps,
): Promise<RegisterTriggersResult> {
  const vault = binding.vault;
  const vaultUrl = (binding.vaultUrl ?? DEFAULT_DEF_VAULT_URL).replace(/\/+$/, "");
  const fetchFn = deps.fetchFn ?? fetch;
  const result: RegisterTriggersResult = { vault, registered: [], failures: [] };

  // 1. Mint the webhook bearer (agent:send) — the trigger fires this at the daemon.
  let webhookBearer: string;
  try {
    const minted = await mintScopedToken(
      { scope: WEBHOOK_SCOPE },
      { hubOrigin: deps.hubOrigin, managerBearer: deps.managerBearer, ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}) },
    );
    webhookBearer = minted.token;
  } catch (err) {
    const detail = err instanceof MintError ? err.message : (err as Error).message;
    result.failures.push(`mint ${WEBHOOK_SCOPE}: ${detail}`);
    return result; // No bearer → no trigger can be registered.
  }

  // 2. Mint the ADMIN token for the triggers API (the def-vault write token can't
  //    register triggers — admin-scoped endpoint). If the operator bearer's authority
  //    doesn't cover admin, the hub returns invalid_scope here — log + skip.
  let adminToken: string;
  try {
    const minted = await mintScopedToken(
      { scope: vaultScope(vault, "admin"), expiresIn: ADMIN_MINT_TTL_SECONDS },
      { hubOrigin: deps.hubOrigin, managerBearer: deps.managerBearer, ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}) },
    );
    adminToken = minted.token;
  } catch (err) {
    const detail = err instanceof MintError ? err.message : (err as Error).message;
    result.failures.push(`mint ${vaultScope(vault, "admin")}: ${detail}`);
    return result; // No admin token → can't POST triggers.
  }

  // 3. POST each trigger (upsert by name).
  const triggers = buildDefVaultTriggers(vault, deps.hubOrigin, webhookBearer);
  const url = `${vaultUrl}/vault/${vault}/api/triggers`;
  for (const trigger of triggers) {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify(trigger),
      });
      if (res.ok) {
        result.registered.push(trigger.name);
      } else {
        const detail = await res.text().catch(() => "");
        result.failures.push(`${trigger.name}: HTTP ${res.status} ${detail}`.trim());
      }
    } catch (err) {
      result.failures.push(`${trigger.name}: ${(err as Error).message}`);
    }
  }
  return result;
}

/**
 * Register triggers for EVERY def-vault binding. Best-effort + sequential (a
 * handful of vaults at most); a per-vault failure never blocks the others. Logs a
 * one-line summary per vault. Returns the per-vault results (for tests).
 */
export async function registerAllDefVaultTriggers(
  bindings: DefVaultBinding[],
  deps: RegisterTriggersDeps,
): Promise<RegisterTriggersResult[]> {
  const results: RegisterTriggersResult[] = [];
  for (const binding of bindings) {
    const r = await registerDefVaultTriggers(binding, deps).catch(
      (err): RegisterTriggersResult => ({
        vault: binding.vault,
        registered: [],
        failures: [`unexpected: ${(err as Error).message}`],
      }),
    );
    results.push(r);
    if (r.failures.length === 0) {
      console.log(
        `parachute-agent: def-vault "${r.vault}" — auto-registered ${r.registered.length} trigger(s) ` +
          `(def-watch create/edit + inbound, bare-keyed).`,
      );
    } else {
      console.warn(
        `parachute-agent: def-vault "${r.vault}" — registered ${r.registered.length}, ` +
          `${r.failures.length} failed (continuing; the 60s poll is the correctness floor): ${r.failures.join("; ")}`,
      );
    }
  }
  return results;
}
