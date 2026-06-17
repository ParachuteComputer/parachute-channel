/**
 * Scheduled-job model + VAULT-NATIVE store for the runner (design
 * `2026-06-17-runner-scheduled-agent-turns.md`).
 *
 * A scheduled job is "an automated human": send message M to agent (channel) A on
 * schedule S. The runner does NOT execute anything — it authors an inbound
 * `#agent-message/inbound` note on a schedule, and the existing vault trigger →
 * agent-turn → outbound flow does the rest.
 *
 * STORAGE IS VAULT-NATIVE (Aaron's call, 2026-06-17): a job IS a `#agent-job`
 * note in the TARGET channel's vault — durable, queryable, and renderable by any
 * surface, converging with the blueprint's "vault as the spine" and the future
 * `tag:job` idea. There is NO jobs.json. The vault note I/O lives on
 * `VaultTransport` (it owns the vault URL + token + encoding); this module is the
 * thin, storage-agnostic FACADE that keeps the same read-all / upsert / remove
 * interface the runner + API call. Token handling is never duplicated here.
 *
 * `metadata` on the note is all string-typed (the vault stores metadata as
 * strings): `{ channel, cron, tz?, enabled, createdAt, lastRunAt?, lastStatus? }`.
 * `nextRunAt` is NOT persisted — the runner computes it in memory each tick.
 *
 * `validateJob` is the pure gate the API runs before writing: slug-shaped id, a
 * known channel that's a VAULT transport, and a parseable cron.
 */

import { parseCron, CronParseError } from "./cron.ts";
import { VaultTransport } from "./transports/vault.ts";
import type { Channel } from "./registry.ts";

/** A job's schedule: a 5-field cron expr + optional IANA tz (default daemon-local). */
export interface JobSchedule {
  /** 5-field cron: `min hour dom mon dow`. */
  cron: string;
  /** IANA timezone (e.g. "America/Los_Angeles"). Optional — default daemon-local. */
  tz?: string;
}

/**
 * One scheduled job. The in-memory shape the runner + API operate on; persisted as
 * a `#agent-job` vault note (see the store below). `id` is the slug (also the
 * `runner:<id>` sender provenance + the note path segment).
 */
export interface Job {
  /** The operator-facing slug (typed on create; addresses the job in `/api/jobs/:id`). */
  id: string;
  /**
   * The vault note id/path that addresses the persisted note for PATCH/DELETE.
   * Absent on a freshly-created in-memory `Job` (set after `upsert` / on `listAll`).
   * The runner + UI key off `id` (the slug); the store uses `noteId` for I/O.
   */
  noteId?: string;
  /** The channel to inject into — MUST be a vault channel. */
  channel: string;
  /** The message text written as the inbound note content (= the job note's content). */
  message: string;
  /** When to fire. */
  schedule: JobSchedule;
  /** Whether the runner considers this job (default true on create). */
  enabled: boolean;
  /** ISO timestamp the job was created. */
  createdAt: string;
  /** ISO timestamp of the most recent fire (set by the runner; persisted via PATCH). */
  lastRunAt?: string;
  /** "ok" or "error: <detail>" from the most recent fire (persisted via PATCH). */
  lastStatus?: string;
  /** ISO timestamp of the next scheduled fire — COMPUTED IN MEMORY, never persisted. */
  nextRunAt?: string;
}

/** A slug: alphanumeric, dash, underscore (same shape as channel names). */
const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

/** The result of validating a candidate job. `ok:false` carries an operator-facing reason. */
export type JobValidation = { ok: true } | { ok: false; error: string };

/**
 * Validate a candidate job before it's persisted. The API runs this and maps an
 * `ok:false` to a 400. Pure (no vault I/O) — `isVaultChannel(name)` is injected:
 *   - returns `true`  → known + vault,
 *   - returns `false` → known but NOT vault,
 *   - returns `null`  → unknown channel.
 *
 * Checks, in order: id slug → non-empty message → parseable cron → valid tz (if
 * present) → channel known AND vault (the inject path is "write an inbound note,"
 * which only a vault transport supports).
 */
export function validateJob(
  candidate: {
    id?: unknown;
    channel?: unknown;
    message?: unknown;
    schedule?: unknown;
    enabled?: unknown;
  },
  isVaultChannel: (name: string) => boolean | null,
): JobValidation {
  if (typeof candidate.id !== "string" || !SLUG_RE.test(candidate.id)) {
    return { ok: false, error: "id must be a slug (alphanumeric, dash, underscore)" };
  }
  if (typeof candidate.message !== "string" || candidate.message.trim().length === 0) {
    return { ok: false, error: "message must be a non-empty string" };
  }
  const sched = candidate.schedule as { cron?: unknown; tz?: unknown } | undefined;
  if (!sched || typeof sched.cron !== "string" || sched.cron.trim().length === 0) {
    return { ok: false, error: "schedule.cron must be a non-empty cron expression" };
  }
  try {
    parseCron(sched.cron);
  } catch (err) {
    const msg = err instanceof CronParseError ? err.message : String(err);
    return { ok: false, error: `invalid schedule.cron: ${msg}` };
  }
  if (sched.tz !== undefined) {
    if (typeof sched.tz !== "string" || sched.tz.length === 0) {
      return { ok: false, error: "schedule.tz must be a non-empty IANA timezone string" };
    }
    try {
      // Construct a formatter to validate the zone — throws RangeError if invalid.
      new Intl.DateTimeFormat("en-US", { timeZone: sched.tz });
    } catch {
      return { ok: false, error: `invalid schedule.tz: "${sched.tz}" is not a known IANA timezone` };
    }
  }
  if (typeof candidate.channel !== "string" || candidate.channel.length === 0) {
    return { ok: false, error: "channel must be a non-empty string" };
  }
  const vault = isVaultChannel(candidate.channel);
  if (vault === null) {
    return { ok: false, error: `unknown channel "${candidate.channel}"` };
  }
  if (vault === false) {
    return {
      ok: false,
      error: `channel "${candidate.channel}" is not a vault channel — scheduled jobs require a vault-backed agent (the runner injects an inbound note)`,
    };
  }
  return { ok: true };
}

/**
 * Resolve a channel name to its live `VaultTransport`, or null if the channel is
 * unknown or not vault-backed. Shared by the store + the runner's discovery so the
 * "is this a vault channel?" check is one implementation.
 */
export function vaultTransportFor(
  channels: Map<string, Channel>,
  name: string,
): VaultTransport | null {
  const t = channels.get(name)?.transport;
  return t instanceof VaultTransport ? t : null;
}

/**
 * The vault-native job store. Same read-all / upsert / remove interface the file
 * store had, now backed by `#agent-job` vault notes via the channel's
 * `VaultTransport`. Each method resolves the target channel's vault transport (the
 * channel carries the vault binding + write token) and delegates the I/O to it.
 *
 * `listAll` queries every UNIQUE vault among the live vault-channels once and maps
 * each job note to a `Job`, routing by `metadata.channel`. A job note whose
 * `channel` no longer names a live vault channel is still RETURNED (so the API/UI
 * can show + let the operator delete a stale job), but the runner's discovery
 * (which composes on top) skips firing it.
 */
export class VaultJobStore {
  constructor(private readonly channels: Map<string, Channel>) {}

  /**
   * List all scheduled jobs across every vault the live channels point at. We
   * query each DISTINCT vault transport once (dedup by vault URL + name), then map
   * job notes to `Job`s. A note read from one vault may target ANY channel on that
   * vault (routing is by `metadata.channel`), so we keep every well-formed job
   * note. De-dup by job id across vaults isn't needed — ids are namespaced by the
   * channel's vault in practice — but if two notes share an id we keep both (the
   * runner routes each by its own `channel`).
   */
  async listAll(): Promise<Job[]> {
    // Dedup the vault transports we query: many channels can share one vault.
    const seen = new Set<VaultTransport>();
    const transports: VaultTransport[] = [];
    for (const ch of this.channels.values()) {
      if (ch.transport instanceof VaultTransport && !seen.has(ch.transport)) {
        seen.add(ch.transport);
        transports.push(ch.transport);
      }
    }
    const jobs: Job[] = [];
    for (const t of transports) {
      const notes = await t.listJobNotes();
      for (const n of notes) {
        jobs.push({
          id: n.id, // the operator-facing slug (metadata.jobId)
          noteId: n.noteId, // the vault note id/path — for PATCH/DELETE
          channel: n.channel,
          message: n.message,
          schedule: { cron: n.cron, ...(n.tz ? { tz: n.tz } : {}) },
          enabled: n.enabled,
          createdAt: n.createdAt ?? "",
          ...(n.lastRunAt ? { lastRunAt: n.lastRunAt } : {}),
          ...(n.lastStatus ? { lastStatus: n.lastStatus } : {}),
        });
      }
    }
    return jobs;
  }

  /**
   * Create or replace a job (by slug id) as a `#agent-job` note in its target
   * channel's vault. Throws if the target channel isn't a live vault channel
   * (the API validates this first, so it's a guard, not the primary check).
   * Returns the persisted job with its `noteId` filled in (the `id` stays the slug).
   */
  async upsert(job: Job): Promise<Job> {
    const t = vaultTransportFor(this.channels, job.channel);
    if (!t) {
      throw new Error(`cannot store job "${job.id}": channel "${job.channel}" is not a live vault channel`);
    }
    const { id: noteId } = await t.upsertJobNote({
      id: job.id,
      message: job.message,
      channel: job.channel,
      cron: job.schedule.cron,
      ...(job.schedule.tz ? { tz: job.schedule.tz } : {}),
      enabled: job.enabled,
      createdAt: job.createdAt,
      ...(job.lastRunAt ? { lastRunAt: job.lastRunAt } : {}),
      ...(job.lastStatus ? { lastStatus: job.lastStatus } : {}),
    });
    return { ...job, noteId }; // id stays the slug; noteId addresses the persisted note.
  }

  /**
   * Delete a job by its vault note id/path. The job lives in ITS channel's vault,
   * so we need that channel to resolve the right transport. The API passes the
   * job's `noteId` + channel (it has the job in hand from a prior list). Throws on
   * a non-ok vault response.
   */
  async remove(noteId: string, channel: string): Promise<void> {
    const t = vaultTransportFor(this.channels, channel);
    if (!t) {
      throw new Error(`cannot delete job in channel "${channel}": not a live vault channel`);
    }
    await t.deleteJobNote(noteId);
  }

  /**
   * PATCH a job's bookkeeping (lastRunAt / lastStatus / enabled) onto its vault
   * note. Used by the runner after a fire. Throws on a non-ok vault response (the
   * runner swallows it — status persistence is best-effort).
   */
  async patch(
    noteId: string,
    channel: string,
    fields: { lastRunAt?: string; lastStatus?: string; enabled?: boolean },
  ): Promise<void> {
    const t = vaultTransportFor(this.channels, channel);
    if (!t) {
      throw new Error(`cannot patch job in channel "${channel}": not a live vault channel`);
    }
    await t.patchJobNote(noteId, fields);
  }
}
