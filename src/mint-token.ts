/**
 * Scoped-token minting for a sandboxed agent session (design §4.2 step 1, §4.3).
 *
 * A hub-issued JWT's `aud` is single-valued, so each resource an arm reaches gets
 * its OWN token: `channel:read channel:write` per channel, `vault:<name>:<verb>`
 * (optionally tag-scoped via `permissions.scoped_tags`) for the vault. The
 * spawn-manager mints these by attenuating its own grant — it presents its OWN
 * operator bearer to the hub's `POST /api/auth/mint-token`, which enforces
 * capability attenuation server-side (`parachute-hub/src/api-mint-token.ts`,
 * `canGrant`): the manager CANNOT mint a child token exceeding its own authority.
 * A `vault:default:read` manager bearer cannot mint a child `vault:default:write`
 * — the hub returns 400 `invalid_scope` (§4.3). This module is the client of that
 * server-enforced bound; the bound itself lives in the hub.
 *
 * One token per `aud`: a multi-resource spec calls this once per resource, each
 * with the resource's scope (and the hub infers `aud` from the scope, or the
 * caller pins it). Tokens are ephemeral by default for one-shot helpers; the TTL
 * is the hub's default unless overridden.
 */

export interface MintRequest {
  /** Space-joined scope string, e.g. "channel:read channel:write". */
  scope: string;
  /** Pin the audience. Omitted = hub infers it from the scope. */
  audience?: string;
  /** TTL in seconds. Omitted = hub default (~90d non-ephemeral). */
  expiresIn?: number;
  /**
   * Extra JWT claims, e.g. `{ scoped_tags: ["#channel-message"] }` for a
   * tag-scoped vault token. Passed through as the mint API's `permissions`.
   */
  permissions?: Record<string, unknown>;
}

export interface MintResult {
  jti: string;
  token: string;
  expiresAt: string;
  scope: string;
  permissions?: Record<string, unknown>;
}

/** A failed mint — carries the hub's error code + the HTTP status. */
export class MintError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "MintError";
  }
}

export interface MintTokenDeps {
  /** Hub public origin. */
  hubOrigin: string;
  /**
   * The spawn-manager's OWN operator bearer, presented to the hub. The hub
   * attenuates against THIS bearer's authority — child tokens can never exceed it.
   */
  managerBearer: string;
  /** Inject fetch for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

/**
 * Mint ONE scoped token against the hub, attenuated to the manager's bearer.
 * Throws {@link MintError} on any non-200 (the hub's attenuation 400, an auth
 * 401/403, etc.) so the caller fails loud rather than launching a session with a
 * missing/over-broad credential.
 */
export async function mintScopedToken(
  req: MintRequest,
  deps: MintTokenDeps,
): Promise<MintResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const url = `${stripTrailingSlash(deps.hubOrigin)}/api/auth/mint-token`;

  const body: Record<string, unknown> = { scope: req.scope };
  if (req.audience) body.audience = req.audience;
  if (req.expiresIn !== undefined) body.expires_in = req.expiresIn;
  if (req.permissions) body.permissions = req.permissions;

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.managerBearer}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new MintError(`mint request failed to reach hub: ${msg}`, 0, undefined);
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }

  if (!res.ok) {
    const e = (parsed ?? {}) as { error?: string; error_description?: string; message?: string };
    const code = e.error;
    const detail = e.error_description ?? e.message ?? `HTTP ${res.status}`;
    throw new MintError(`mint refused (${code ?? "error"}): ${detail}`, res.status, code);
  }

  const r = (parsed ?? {}) as Partial<MintResult> & { expires_at?: string };
  if (typeof r.token !== "string" || r.token.length === 0) {
    throw new MintError("mint succeeded but response had no token", res.status, undefined);
  }
  return {
    jti: typeof r.jti === "string" ? r.jti : "",
    token: r.token,
    expiresAt: typeof r.expires_at === "string" ? r.expires_at : "",
    scope: typeof r.scope === "string" ? r.scope : req.scope,
    ...(r.permissions ? { permissions: r.permissions } : {}),
  };
}

/** Build the space-joined channel scope string for a read[+write] grant. */
export function channelScope(opts: { write: boolean }): string {
  return opts.write ? "channel:read channel:write" : "channel:read";
}

/** Build the vault scope string for a named verb, e.g. `vault:default:read`. */
export function vaultScope(name: string, verb: "read" | "write" | "admin"): string {
  return `vault:${name}:${verb}`;
}
