/**
 * OAuth discovery endpoints for parachute-channel's HTTP MCP surface — the
 * *resource server* side of the authorization story.
 *
 * Mirrors `parachute-vault/src/oauth-discovery.ts` exactly. The channel is a
 * resource server, not an authorization server: the hub is the OAuth issuer
 * (see the hub-as-portal-oauth design doc). These endpoints advertise that
 * contract to clients per RFC 9728 + RFC 8414 so a Claude Code HTTP-MCP client
 * adding the channel by URL can auto-discover the hub and run the OAuth flow —
 * the same way it discovers a vault.
 *
 *   - `handleProtectedResource` — RFC 9728: "this is the protected resource at
 *     `<channel>/mcp/<channel>`; the authorization server lives at <hub>".
 *   - `handleAuthorizationServer` — RFC 8414: "go to <hub>/oauth/* for the
 *     authorization endpoints" (forwarded shape — issuer + every endpoint name
 *     the hub).
 *
 * The channel resource lives at `/mcp/<channel>` on the daemon, externally
 * `<hub>/channel/mcp/<channel>` (hub's stripPrefix removes `/channel`). The
 * metadata `resource` value is built from the request's forwarded host so the
 * advertised URL is the public one, not loopback.
 *
 * `PARACHUTE_HUB_ORIGIN` (via `getHubOrigin()`) is required for these endpoints
 * to advertise the right issuer URL — the hub stamps that origin as the token
 * `iss`. The loopback fallback is for a co-located, never-exposed dev daemon.
 */

import { getHubOrigin } from "./hub-jwt.ts";
import { SCOPE_READ, SCOPE_WRITE } from "./auth.ts";

/**
 * OAuth scopes the channel publishes through discovery. These are the channel
 * session scopes: a session needs `channel:read` to connect + receive the wake,
 * and `channel:write` to send (reply/react/edit). A spec-following MCP client
 * reads `scopes_supported` from this PRM and requests exactly these scopes.
 */
function scopesSupported(): string[] {
  return [SCOPE_READ, SCOPE_WRITE];
}

/**
 * Public-facing base URL of the daemon. Honors `x-forwarded-*` headers so a
 * Cloudflare Tunnel / Tailscale Funnel / reverse-proxied (hub) deployment
 * advertises the right external origin in the `resource` URL. Mirrors vault's
 * `getBaseUrl`.
 *
 * Exported so the daemon can build a `WWW-Authenticate` challenge header that
 * points at the same origin as the `/.well-known/*` metadata documents.
 */
export function getBaseUrl(req: Request): string {
  const forwardedHost = req.headers.get("x-forwarded-host");
  const forwardedProto = req.headers.get("x-forwarded-proto");
  if (forwardedHost) {
    return `${forwardedProto || "https"}://${forwardedHost}`;
  }
  const url = new URL(req.url);
  return url.origin;
}

/**
 * The mount prefix the channel sits under when served through the hub expose.
 * Hub reverse-proxies `<expose>/channel/*` → the loopback daemon with
 * `stripPrefix:true`, so the daemon itself never sees `/channel`. But the
 * PUBLIC resource URL a client must address is `<hub>/channel/mcp/<channel>`.
 *
 * When the request carries `x-forwarded-host` (i.e. it came through the hub),
 * the public URL needs the `/channel` prefix re-added; a direct loopback
 * request (no forwarded host) addresses `/mcp/<channel>` with no prefix. We key
 * off the forwarded-host presence to decide.
 */
function mountPrefix(req: Request): string {
  return req.headers.get("x-forwarded-host") ? "/channel" : "";
}

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * Advertises the channel's `/mcp/<channel>` endpoint as the protected resource
 * and names the hub as the authorization server. Clients following the spec
 * fetch this, then fetch the AS metadata at
 * `<hub>/.well-known/oauth-authorization-server` to drive the full flow.
 */
export function handleProtectedResource(req: Request, channel: string): Response {
  const base = getBaseUrl(req);
  const prefix = mountPrefix(req);
  return Response.json({
    resource: `${base}${prefix}/mcp/${channel}`,
    authorization_servers: [getHubOrigin()],
    scopes_supported: scopesSupported(),
    bearer_methods_supported: ["header"],
  });
}

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414).
 *
 * The channel is a resource server, not an authorization server — but we serve
 * this document as a *forwarding* metadata document: issuer + every endpoint
 * name the hub. Clients that follow the PRM pointer land here and discover the
 * hub's actual endpoints; conformant clients that probe AS metadata directly at
 * the channel path get the same answer. Mirrors vault.
 */
export function handleAuthorizationServer(_req: Request, _channel: string): Response {
  const hub = getHubOrigin();
  return Response.json({
    issuer: hub,
    authorization_endpoint: `${hub}/oauth/authorize`,
    token_endpoint: `${hub}/oauth/token`,
    registration_endpoint: `${hub}/oauth/register`,
    jwks_uri: `${hub}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: scopesSupported(),
  });
}

/**
 * RFC 9728 `WWW-Authenticate` challenge value pointing at the protected-resource
 * metadata document for `channel`. When a Claude Code HTTP-MCP client hits
 * `/mcp/<channel>` with no/invalid bearer and gets a 401 carrying this header,
 * it knows where to fetch the OAuth discovery metadata and start the flow.
 *
 * The advertised metadata URL uses the path-insertion form Claude Code probes
 * (`/.well-known/oauth-protected-resource/mcp/<channel>`) so the client's first
 * fetch off this header lands on a route the daemon actually serves. Built from
 * the same `getBaseUrl` as the metadata document so the origins match.
 */
export function mcpWwwAuthenticate(req: Request, channel: string): string {
  const base = getBaseUrl(req);
  const prefix = mountPrefix(req);
  return `Bearer resource_metadata="${base}${prefix}/.well-known/oauth-protected-resource/mcp/${channel}"`;
}
