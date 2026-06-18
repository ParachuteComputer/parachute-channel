/**
 * Shared channel-PROVISIONING client logic, factored out of `admin-ui.ts` so the
 * Config page and the unified "create an agent" flow (`agents-ui.ts`) run the
 * SAME provisioning paths and can't drift apart.
 *
 * Why this module exists: the create-agent flow (Phase-1 consolidation,
 * `design/2026-06-17-parachute-agent-blueprint.md` §Sequencing step 1) fuses the
 * two old steps — create-channel, then spawn-agent-on-it — into one form. The
 * channel half MUST reuse the existing, carefully-built provisioning paths:
 *
 *   - VAULT (the default/primary transport) — a HUB-MEDIATED flow. The page POSTs
 *     to `<hub-origin>/admin/connections` (cookie-gated, `credentials:"include"`).
 *     The HUB mints the `vault:default:write` token, registers the inbound vault
 *     trigger, fills vaultUrl / notePathPrefix, and persists the channel. The
 *     channel daemon does NOT and CANNOT mint vault tokens — so the client
 *     orchestrates against the hub, exactly as the Config page does.
 *   - TELEGRAM / HTTP-UI — a plain `POST <mount>/api/channels` to the channel
 *     daemon (agent:admin Bearer), `{ name, transport, config? }`.
 *
 * These functions are pure browser JS exposed as a STRING (`PROVISION_JS`) so the
 * pages interpolate it into their inline `<script>` exactly like `SHELL_JS`. The
 * string is asserted backtick-free (a `bun:test` guards it), so it never breaks a
 * host template literal. Every function is promise-shaped and NEVER rejects — it
 * resolves a structured result `{ ok, ... }` so the calling page renders one clear
 * banner per outcome (auth, error, restart_needed, success).
 *
 * Exposed on the page as a namespace object `window.ChannelProvision` with:
 *   - channelExists({ apiUrl, token, name })       → Promise<{ ok, exists, transport, channel, auth, error }>
 *   - provisionVaultChannel({ origin, name, vault }) → Promise<{ ok, connection, connect, auth, forbidden, status, error }>
 *   - provisionDaemonChannel({ apiUrl, token, name, transport, config }) → Promise<{ ok, restart_needed, auth, status, error }>
 *   - listVaults({ origin })                        → Promise<{ ok, vaults, error }>
 *
 * The connection-body shape (vault.note.created → agent.message.deliver) is the
 * single canonical definition — both pages get it from `vaultConnectionBody(name,
 * vault)` here, so the trigger filter can never diverge between the two surfaces.
 */

/**
 * The canonical hub-Connections request body for a vault-backed channel. Shared so
 * the Config page and the create-agent flow register byte-identical triggers (the
 * inbound-tag filter is the loop-avoidance contract; see CLAUDE.md "Vault
 * integration"). Pure data — also re-derived inside `PROVISION_JS` for the browser.
 */
export function vaultConnectionBody(name: string, vault: string): {
  requestedBy: string;
  source: {
    module: string;
    vault: string;
    event: string;
    filter: { tags: string[]; has_metadata: string[]; missing_metadata: string[] };
  };
  sink: { module: string; action: string; params: { channel: string } };
} {
  return {
    requestedBy: "agent",
    source: {
      module: "vault",
      vault,
      event: "note.created",
      filter: {
        tags: ["#agent/message/inbound"],
        has_metadata: ["channel"],
        missing_metadata: ["channel_inbound_rendered_at"],
      },
    },
    sink: { module: "agent", action: "message.deliver", params: { channel: name } },
  };
}

/**
 * The browser-side provisioning client, injected into a page's `<script>` as
 * `${PROVISION_JS}` (its content is inserted at runtime, so its own contents —
 * which contain no backtick — never collide with the host page's template
 * literal). Defines `window.ChannelProvision`.
 *
 * NOTE: keep this backtick-free (the `provision-agent.test.ts` asserts it). Use
 * string concatenation, never template literals.
 */
export const PROVISION_JS = `
  (function () {
    "use strict";

    // GET <mount>/api/channels (agent:admin Bearer) and report whether a channel
    // with this name already exists — the idempotency check both the Config page
    // and the create-agent flow use to REUSE an existing channel instead of
    // double-provisioning. Resolves { ok:true, exists, transport, channel } on a
    // successful list; { ok:false, auth:true } on 401/403; { ok:false, error } on
    // anything else. Never rejects.
    function channelExists(opts) {
      opts = opts || {};
      var headers = { accept: "application/json" };
      if (opts.token) headers.authorization = "Bearer " + opts.token;
      return fetch(opts.apiUrl, { headers: headers }).then(function (res) {
        if (res.status === 401 || res.status === 403) return { ok: false, auth: true };
        if (!res.ok) return { ok: false, error: "HTTP " + res.status };
        return res.json().catch(function () { return {}; }).then(function (data) {
          var channels = (data && Array.isArray(data.channels)) ? data.channels : [];
          var match = null;
          for (var i = 0; i < channels.length; i++) {
            if (channels[i] && channels[i].name === opts.name) { match = channels[i]; break; }
          }
          return {
            ok: true,
            exists: !!match,
            transport: match ? match.transport : null,
            channel: match,
          };
        });
      }).catch(function (err) {
        return { ok: false, error: "network error: " + (err && err.message ? err.message : String(err)) };
      });
    }

    // The canonical hub-Connections body for a vault-backed channel — re-derived
    // here so the browser doesn't depend on a server import. MUST stay in sync with
    // vaultConnectionBody() above (the test asserts the shapes agree).
    function vaultConnectionBody(name, vault) {
      return {
        requestedBy: "agent",
        source: {
          module: "vault",
          vault: vault,
          event: "note.created",
          filter: {
            tags: ["#agent/message/inbound"],
            has_metadata: ["channel"],
            missing_metadata: ["channel_inbound_rendered_at"]
          }
        },
        sink: { module: "agent", action: "message.deliver", params: { channel: name } }
      };
    }

    // VAULT provisioning — the HUB-MEDIATED path. POST <origin>/admin/connections
    // with the operator's hub SESSION COOKIE (credentials:"include"); the click IS
    // the approval. The hub mints the cross-module tokens + registers the vault
    // trigger and returns { connection, connect }. The channel daemon is NOT
    // involved (it can't mint vault tokens). Resolves a structured result; never
    // rejects. requestedBy:"agent" labels provenance in the hub Connections view.
    function provisionVaultChannel(opts) {
      opts = opts || {};
      var body = vaultConnectionBody(opts.name, opts.vault);
      return fetch(opts.origin + "/admin/connections", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body)
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (payload) {
          if (res.status === 401) return { ok: false, auth: true, status: 401 };
          if (res.status === 403) {
            return { ok: false, forbidden: true, status: 403, error: (payload && payload.error_description) || "" };
          }
          if (!res.ok) {
            return { ok: false, status: res.status, error: (payload && (payload.error_description || payload.error)) || ("HTTP " + res.status) };
          }
          return { ok: true, connection: payload && payload.connection, connect: payload && payload.connect };
        });
      }).catch(function (err) {
        return { ok: false, error: "network error: " + (err && err.message ? err.message : String(err)) };
      });
    }

    // TELEGRAM / HTTP-UI provisioning — the plain daemon path. POST
    // <mount>/api/channels (agent:admin Bearer), { name, transport, config? }.
    // A 200 may still carry restart_needed:true (persisted, hot-add failed).
    // Resolves a structured result; never rejects.
    function provisionDaemonChannel(opts) {
      opts = opts || {};
      var headers = { "content-type": "application/json", accept: "application/json" };
      if (opts.token) headers.authorization = "Bearer " + opts.token;
      var postBody = { name: opts.name, transport: opts.transport };
      if (opts.config) postBody.config = opts.config;
      return fetch(opts.apiUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(postBody)
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (payload) {
          if (res.status === 401 || res.status === 403) return { ok: false, auth: true, status: res.status };
          if (!res.ok) {
            return { ok: false, status: res.status, error: (payload && payload.error) || ("HTTP " + res.status) };
          }
          return { ok: true, restart_needed: !!(payload && payload.restart_needed), error: payload && payload.error };
        });
      }).catch(function (err) {
        return { ok: false, error: "network error: " + (err && err.message ? err.message : String(err)) };
      });
    }

    // List installed vaults from the hub's PUBLIC discovery doc
    // (<origin>/.well-known/parachute.json). No token needed — it's public. Resolves
    // { ok:true, vaults:[names] } or { ok:false, error }; never rejects.
    function listVaults(opts) {
      opts = opts || {};
      return fetch(opts.origin + "/.well-known/parachute.json", {
        headers: { accept: "application/json" },
        credentials: "include"
      }).then(function (r) {
        if (!r.ok) return { ok: false, error: "HTTP " + r.status };
        return r.json().catch(function () { return null; }).then(function (doc) {
          var vaults = (doc && Array.isArray(doc.vaults)) ? doc.vaults.map(function (v) { return v.name; }) : [];
          return { ok: true, vaults: vaults };
        });
      }).catch(function (err) {
        return { ok: false, error: "network error: " + (err && err.message ? err.message : String(err)) };
      });
    }

    window.ChannelProvision = {
      channelExists: channelExists,
      vaultConnectionBody: vaultConnectionBody,
      provisionVaultChannel: provisionVaultChannel,
      provisionDaemonChannel: provisionDaemonChannel,
      listVaults: listVaults
    };
  })();
`;
