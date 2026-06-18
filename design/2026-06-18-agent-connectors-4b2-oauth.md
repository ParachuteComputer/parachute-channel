# Agent connectors 4b-2 — hub as OAuth client (remote vaults / remote MCPs)

**Status:** design-of-record (2026-06-18). The build spec for slice 2 of
[`2026-06-17-agent-connectors-4b.md`](./2026-06-17-agent-connectors-4b.md).
4b-1 (shipped + live-verified) grants an agent **local** vaults + **service**
creds. 4b-2 lets a `#agent/definition` declare a **remote MCP** (incl. a remote
Parachute vault) — `wants: "mcp:https://other.host/vault/eng/mcp"` — and have the
operator authorize it **once in their browser**, after which the agent reaches it
**headlessly forever** (auto-refreshed). `claude -p` never does an interactive
OAuth dance; it just gets a valid Bearer in its per-spawn `.mcp.json`.

## The one invariant (unchanged)
**A vault note can only REQUEST; it can never GRANT.** A `mcp:` want sits
`pending` until the operator completes the OAuth consent in the hub. No note can
self-authorize a remote reach — worst case it sits pending forever.

## What 4b-1 already left in place
- The agent module parses `mcp:<https-url>` → `{kind:"mcp", target:url}`
  ([`grants.ts:parseMcpUrlWant`](../src/grants.ts)) and registers it. The hub
  stores it `pending` with reason `"oauth not yet supported"`; `approve` 409s
  (`not_grantable`). 4b-2 flips both: the reason becomes
  `"awaiting oauth consent"` and `approve` **starts the flow**.
- `resolveInjectedGrants` already injects a vault-material entry as an MCP server.
  An `mcp`-material grant injects the **same way** — it's just another
  `{url, token}` MCP entry. So the agent-side change is small.

## The production shape (why a Parachute hub is the perfect OAuth provider)
A Parachute hub is already a spec-compliant OAuth **issuer**: RFC 8414
`/.well-known/oauth-authorization-server` + RFC 9728
`/.well-known/oauth-protected-resource`, RFC 7591 dynamic client registration at
`/oauth/register`, an authorize endpoint with **PKCE S256 required**, and a token
endpoint speaking `authorization_code` + `refresh_token`. 4b-2 makes **this hub**
act as a **client** of **another** hub's issuer (or any RFC-compliant MCP issuer).
The hub-as-client and hub-as-issuer are the two ends of the same wire.

## The OAuth-client flow (hub side)

```
operator (browser)        this hub (CLIENT)              remote hub (ISSUER + MCP)
─────────────────         ─────────────────              ─────────────────────────
                          ── on `approve` (kind:mcp) ──▶
                            1. discover: GET <mcp-url>/.well-known/oauth-protected-resource
                                          → authorization_servers[0] = <issuer>
                                         GET <issuer>/.well-known/oauth-authorization-server
                                          → authorization_endpoint, token_endpoint, registration_endpoint
                            2. DCR: POST <issuer>/oauth/register
                                    { client_name, redirect_uris:[<this-hub>/oauth/agent-grant/callback],
                                      grant_types:["authorization_code","refresh_token"],
                                      response_types:["code"], token_endpoint_auth_method:"none" }
                                    → { client_id }
                            3. mint PKCE verifier+challenge (S256) + random `state`;
                               persist a pending-flow record bound to (grantId, state):
                               { state, grantId, issuer, clientId, tokenEndpoint, verifier,
                                 mcpUrl, scope, redirectUri, createdAt }   [10-min TTL]
   ◀── 302 / {authorizeUrl} ──  4. return authorizeUrl =
                                    <issuer>/oauth/authorize?response_type=code&client_id=…
                                      &redirect_uri=<cb>&scope=<scope>&state=<state>
                                      &code_challenge=<chal>&code_challenge_method=S256
   ── follows, consents ────────────────────────────────────────────────▶ (operator's remote session)
   ◀── 302 redirect_uri?code=…&state=… ─────────────────────────────────
   ── GET <this-hub>/oauth/agent-grant/callback?code=…&state=… ──▶
                            5. look up pending-flow by `state` (single-use; delete on use).
                               POST <issuer>/oauth/token
                                    grant_type=authorization_code&code=…&code_verifier=<verifier>
                                    &redirect_uri=<cb>&client_id=<clientId>
                                    → { access_token, refresh_token, expires_in }
                            6. store grant material; status=approved.
   ◀── HTML "connected, you can close this" ──
```

### Auto-refresh (lazy, at material-fetch)
The agent fetches `GET /admin/grants/<id>/material` **fresh every spawn**. For an
`mcp` grant, the hub checks `expiresAt`: if the access token is expired or within a
**120 s skew window**, it refreshes first —
`POST <tokenEndpoint> grant_type=refresh_token&refresh_token=…&client_id=…` —
persists the new access (and rotated refresh, if returned), then returns the live
access token. So revocation/expiry both take effect by the next spawn; no
background timer needed. If refresh **fails** (refresh token revoked/expired):
the grant flips to `status:"needs_consent"` (reason carries the error), `material`
is dropped, and `/material` 409s → the connection is simply absent next spawn and
the operator sees "reconnect" in admin. (A grant can always be re-consented by
`approve` again — same flow, fresh tokens.)

**`needs_consent` is a NEW first-class status** (review #94). It MUST be added to
`grants-store.ts` `GrantStatus = "pending" | "approved" | "revoked" | "needs_consent"`
**and** to the lenient `readGrants` filter — otherwise the existing filter silently
drops `needs_consent` rows on re-read (they'd read back as 404, not 409). It is
distinct from `revoked` (operator-intended teardown) — it means "was working,
refresh died, re-consent to revive." The status resolver treats it as not-approved
(→ the def shows it in `pending:[…]`).

### Static-bearer fallback (non-OAuth remote MCPs)
Some remote MCPs don't speak OAuth. The operator can instead `approve` a `kind:mcp`
grant with a pasted `{ token }` in the body → stored as
`material:{kind:"mcp", access_token:<paste>, mcpUrl}` with **no** refresh. Same
injection. This honors "I'm also okay with putting API tokens in" without the OAuth
dance. (Discovery is skipped when a token is pasted.) `approve` with **no** token →
OAuth flow. **Weaker lifecycle than OAuth** (see Security): a static bearer has no
expiry, no auto-refresh, and no issuer-side revocation on `revoke` (we just drop our
copy; the operator rotates it upstream). Capped at `MAX_TOKEN_LEN` (8192), same as
the 4b-1 service-token paste.

### Re-consent, concurrency, and DCR client lifecycle (review #94)
- **Re-approve an already-`approved` mcp grant** mirrors the 4b-1 vault precedent:
  it starts a **fresh** OAuth flow; the successful callback **replaces** the stored
  material and **best-effort revokes the prior refresh token** at the issuer's
  `revocation_endpoint` first (exactly one live credential per grant). `needs_consent`
  re-approves identically.
- **DCR client reuse:** if the grant's stored material already carries a `clientId`
  for the **same `issuer`**, re-consent **reuses** it (skips `/oauth/register`). A
  fresh grant (or a different issuer) registers anew. Orphaned DCR clients only
  accrue if the issuer rotates its registration — accepted (no cross-issuer client
  GC; noted, not built).
- **Concurrent `approve(mcp)`** for one grant id (double-tap): first callback to
  return wins + flips the grant `approved`; the loser's pending-flow record is stale
  and expires via TTL. Accepted (first-wins).

## Wire contract (the integration seam — both repos build to this)

### Hub endpoints (parachute-hub)
Extends the 4b-1 grants API ([`admin-agent-grants.ts`](../../parachute-hub/src/admin-agent-grants.ts)).

- **`POST /admin/grants/<id>/approve`** — operator-auth (first-admin cookie +
  same-origin belt), **for `kind:mcp`**:
  - body `{}` (or no token) → **start OAuth**: discover + DCR (or reuse stored
    `clientId`) + mint PKCE/state + persist pending-flow → `200` with a
    **`GrantListing` PLUS an optional `authorizeUrl` field**
    (`{ id, agent, connection, status:"pending", reason:"awaiting oauth consent",
    authorizeUrl }`). The admin UI redirects the browser to `authorizeUrl`. (A
    superset of the 4b-1 listing shape — the UI ignores `authorizeUrl` for
    vault/service approves where it's absent.)
  - body `{ token }` → **static bearer**: store + `status:approved` immediately
    (no discovery). Returns the grant listing (no material, no `authorizeUrl`).
  - vault/service kinds: unchanged from 4b-1.
- **`GET /oauth/agent-grant/callback?code=&state=`** — **operator browser redirect
  target.** Lives under `/oauth/*` (server-rendered, standalone — NOT under
  `/admin/*`, so the admin SPA catch-all never swallows it; alongside the hub's
  other browser-facing OAuth routes). GET, no Bearer; gated by the single-use
  `state` it carries (same-origin not required — it's a cross-site redirect *in*
  from the remote issuer). Looks up the pending-flow by `state` (delete-on-use),
  exchanges the code at the issuer token endpoint, stores material, flips the grant
  `approved`. Renders a tiny HTML "connected — you can close this tab" page (or an
  error page on failure: unknown/replayed `state`, token error → grant stays
  pending/`needs_consent`). Also handles the RFC 6749 §4.1.2.1 error redirect
  (`?error=access_denied&state=…` when the operator clicks Deny).
- **`GET /admin/grants/<id>/material`** — module-auth (host-admin Bearer),
  **for an approved `mcp` grant**: refresh-if-needed (see above), then
  `200 { kind:"mcp", token:<access_token>, mcpUrl:<remote-mcp-url> }`.
  404 unknown / 409 not-approved (incl. `needs_consent`) — unchanged contract.
- **`POST /admin/grants/<id>/revoke`** — operator-auth: drop material + best-effort
  call the issuer's `revocation_endpoint` for the refresh token; `status:revoked`.

### Material shape (grants-store.ts `GrantMaterial` union — extend)
Add the `mcp` variant:
```ts
| { kind: "mcp";
    access_token: string;
    refresh_token?: string;        // absent for static-bearer
    expiresAt?: string;            // ISO; absent for static-bearer (never refreshed)
    issuer?: string;               // for refresh + revoke
    clientId?: string;             // DCR client_id, for refresh
    tokenEndpoint?: string;        // cached from discovery
    revocationEndpoint?: string;   // cached, for revoke
    mcpUrl: string;                // what the agent connects to
  }
```
`/material` returns ONLY `{ kind:"mcp", token, mcpUrl }` — the refresh/issuer
internals never leave the hub. **Field-name seam (don't leak the internal name):**
the access token is stored as `access_token` *inside* the grant material, but the
`/material` wire response projects it as **`token`** (matching the vault/service
material wire shape the agent already consumes). Builder: read `material.access_token`
from the store, emit `{ kind:"mcp", token: material.access_token, mcpUrl }` on the wire.

### Pending-flow store (the consent in-flight record)
A dedicated on-disk store `agent-oauth-flows.json` in the hub state dir (0600, same
discipline as `agent-grants.json`), keyed by `state`. Each record:
`{ state, grantId, issuer, clientId, tokenEndpoint, revocationEndpoint?, verifier,
mcpUrl, scope?, redirectUri, createdAt }`. **On-disk (not in-memory)** so a hub
restart mid-consent doesn't orphan the `state` (the 10-min window spans a possible
supervisor restart). **TTL 10 min**, pruned opportunistically on every read/write +
deleted on successful callback use (single-use). The `verifier` is a secret (PKCE) —
0600, never logged, never returned.

### Scope at flow-start (review #94)
The hub requests the scopes the resource advertises: read `scopes_supported` from
the RFC 9728 protected-resource metadata (fallback: the RFC 8414 auth-server
metadata). Request them space-joined in the authorize URL. If neither advertises any,
**omit `scope`** (let the issuer apply its default). For a Parachute vault MCP the
advertised scope is `vault:<name>:read` (+`:write`); the operator sees + consents to
exactly that on the remote authorize screen. (A scope-selection UI is deferred —
Open/later.)

### Agent module (parachute-agent)
- **Add the `mcp` member to the agent-side `GrantMaterial` union**
  ([`grants.ts:303`](../src/grants.ts)):
  `| { kind: "mcp"; token: string; mcpUrl: string }`. (The vault member already
  carries `token` + `mcpUrl`; the mcp `/material` response is byte-identical to it,
  so the injection branch is trivial — but the type member must exist for the
  `switch (material.kind)` to stay exhaustive.)
- **Add `grantMcpEntryKey(slug)`** — a NEW exported helper parallel to the existing
  `grantVaultEntryKey`/`grantServiceEntryKey` ([`grants.ts:574`](../src/grants.ts)),
  returning `grant-mcp-<slug>` (slug derived from the grant id — stable + collision-
  free vs `grant-vault-*` / `grant-service-*` / the def-vault `parachute-vault-*`).
- `resolveInjectedGrants`: add a `material.kind === "mcp"` branch → push
  `{ name: grantMcpEntryKey(g.id), url: material.mcpUrl, token: material.token }`
  to `mcpEntries`. vault/service branches unchanged.
- No `parseWants` change — `mcp:<url>` already parses to `{kind:"mcp"}`
  (`parseMcpUrlWant`). The status resolver already treats a non-`approved` grant as
  pending, so a `mcp` want shows in `pending:[…]` until consent completes, then the
  def flips `enabled`. (`needs_consent` is non-approved → stays pending-listed.)

## Security posture
- **PKCE S256** on every flow (the remote hub requires it; we generate the verifier).
- **`state`** is single-use, random (32 bytes base64url), TTL-bound, deleted on
  callback — defends the callback against CSRF/replay.
- **Tokens at rest**: refresh + access live ONLY in the hub's 0600 grant store,
  NEVER in a vault note, NEVER logged, NEVER returned except the access token via
  the approved+module-auth `/material`.
- **Consent is the operator's browser action** — headless-impossible by design
  (same invariant as 4b-1 approve). The `state`-bound callback can't be driven by a
  note.
- **Denylist** still applies downstream — an injected MCP grant can't set a
  protected env var (it injects an MCP server, not env).
- **`redirect_uri`** is exactly `<this-hub-origin>/oauth/agent-grant/callback`,
  registered via DCR; the callback rejects a `state` it didn't mint.
- **Static-bearer grants have weaker lifecycle controls** than OAuth grants — no
  expiry, no auto-refresh, no issuer-side revocation (drop-our-copy only). The
  operator owns + rotates that secret upstream. Surfaced as such in admin.
- **SSRF surface (noted, accepted on a single-owner box):** the hub makes outbound
  requests to the operator-supplied MCP URL (discovery, DCR, token, revoke). On the
  owner-operated trust model this URL is operator-supplied = trusted. If the hub ever
  runs **multi-tenant**, this becomes a live SSRF surface and needs an egress
  allowlist / metadata-endpoint block — out of scope here, flagged for that future.
- **`http://` targets** are accepted for loopback/dev (the real-path verify uses
  `http://127.0.0.1:1939/...`). For a remote `mcp:` target over plaintext the
  operator bears the interception risk; the approval UI should warn on a non-loopback
  `http://` target. Tokens still ride `Authorization: Bearer` regardless.

## Phasing within 4b-2
1. Hub: `oauth-client.ts` (discovery, DCR, PKCE-gen, code+refresh exchange,
   `fetchWithTimeout`), pending-flow store, `GrantMaterial` mcp variant,
   `approve`(mcp)/callback/`material`(refresh)/`revoke` wiring, routes, tests.
2. Agent: mcp-material injection branch + tests.
3. End-to-end real-path verify against the hub's **own** issuer over the
   tailnet/loopback origin (a genuine remote-shaped Parachute issuer reachable
   without the Cloudflare bot-wall that blocks `our.parachute.computer` S2S).

## Real-path verification plan (4a/4b-1 lesson: mocked tests miss real bugs)
- Define an agent with `wants:"mcp:http://127.0.0.1:1939/vault/default/mcp"`
  (the hub's own vault MCP, reached as a generic OAuth resource — exercises
  discovery→DCR→authorize→callback→token, all real).
- Drive `approve` → get `authorizeUrl` → complete consent (same-hub auto-approve
  with the operator session) → callback → token stored.
- `GET /material` → confirm a live access token that **authenticates against the
  vault MCP** (`tools/list` 200). Force expiry → confirm lazy refresh mints a new
  one. Revoke → confirm `/material` 409 + the token dies.
- Clean up all test artifacts (note, grant, pending-flow, DCR client).

## Open / later
- Background refresh timer (lazy-at-fetch is enough today; revisit if a long-idle
  agent's refresh token rotates on an issuer with short refresh TTL).
- Per-grant approval-TTL re-prompt (off by default, from 4b).
- Scope selection UI for remote MCPs (today: request the resource's default scope;
  the operator consents to whatever the remote authorize screen shows).
