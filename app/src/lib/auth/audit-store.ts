// Durable, bounded persistence for the auth audit trail (Security Center, Slice 2).
//
// recordAuthEvent (audit.ts) builds ONE post-redaction AuthAuditRecord and emits
// it to stdout (unchanged). When a Db handle is available it ALSO hands that same
// record here to be persisted — the two sinks are projections of the same object,
// so there is exactly one redaction point and they can never disagree about
// content. This module owns only the storage concern; it does NO record building
// and NO redaction (both already happened in buildAuditRecord).
//
// Two load-bearing properties:
//  1. BEST-EFFORT — persistAuditEvent never throws. A DB failure (down, migration
//     lag, constraint) must never break, block, or fail the auth path the audit
//     log observes. The auth route completes normally; the durable copy is simply
//     missed for that event (the stdout line still landed).
//  2. BOUNDED — the audit store is a flood target (an unauthenticated attacker can
//     generate failure events at the rate limiter's pace). Every persist sweeps by
//     BOTH age (365 days) and row count (20,000, oldest-first) so the table cannot
//     be bloated. Bounds are module constants, test-overridable but NOT env-var
//     settable — an operator must not quietly stretch or shrink the record.
//
// Reads/writes go through the same `Db` executor seam every other store uses, so
// the exact same SQL runs in production (postgres.js) and in the pre-push gate
// (PGlite). Type-only import of `Db`/`AuthAuditRecord` keeps this module free of
// any runtime dependency that would pull it (or audit.ts) into the Edge bundle.

import type { Db } from "@/lib/db/types";
import type { AuthAuditRecord } from "./audit";

/**
 * Age bound: rows older than this many days are pruned on the next persist.
 * A module constant, not an env var (design D5): retention is a security property
 * the operator must not silently widen or narrow. Test-overridable via opts.
 */
export const AUDIT_RETENTION_DAYS = 365;

/**
 * Count bound: at most this many rows are retained; a persist that pushes the
 * table past the cap deletes the OLDEST rows down to the cap. This is the DoS
 * bound — under a sustained flood it can push genuine older events out of the DB
 * window, but the stdout line (unaffected by DB pruning) remains the deeper record
 * in container logs. Module constant, test-overridable via opts.
 */
export const AUDIT_MAX_ROWS = 20_000;

const MS_PER_DAY = 86_400_000;

export interface AuditPersistOptions {
  /** Age bound override (days). Test seam only — production uses the constant. */
  retentionDays?: number;
  /** Count bound override (rows). Test seam only — production uses the constant. */
  maxRows?: number;
  /** Injected "now" (epoch ms) for deterministic age-prune tests. Defaults to Date.now(). */
  now?: number;
}

/**
 * Prune the audit table to its two bounds. The ONLY delete path against
 * auth_audit_events (insert-only-except-sweep contract). Both DELETEs take
 * constant/derived predicates — no external, caller-supplied, or API parameter
 * reaches them.
 *
 *  - Age:   DELETE rows whose ts is older than `retentionDays` before `now`.
 *  - Count: keep the newest `maxRows` rows (ts DESC, id DESC for a total order),
 *           DELETE everything past that. `OFFSET n` with no LIMIT selects exactly
 *           the rows beyond the newest n.
 */
async function sweep(
  db: Db,
  retentionDays: number,
  maxRows: number,
  now: number,
): Promise<void> {
  const cutoffIso = new Date(now - retentionDays * MS_PER_DAY).toISOString();
  await db.query(`DELETE FROM auth_audit_events WHERE ts < $1`, [cutoffIso]);
  await db.query(
    `DELETE FROM auth_audit_events
       WHERE id IN (
         SELECT id FROM auth_audit_events
         ORDER BY ts DESC, id DESC
         OFFSET $1
       )`,
    [maxRows],
  );
}

/**
 * Persist one already-built, already-redacted audit record durably, then enforce
 * the retention bounds. Best-effort: any failure is swallowed so the auth path
 * that produced the event is never affected.
 *
 * The record's OWN `ts` is stored (not a fresh DEFAULT now()), so the persisted
 * row and the stdout line share an identical timestamp — the same-object dual-sink
 * guarantee. `details` is passed as JSON text and cast with `$5::jsonb`, portable
 * across postgres.js and PGlite (the seam's JSONB convention); an absent `details`
 * stores SQL NULL.
 */
export async function persistAuditEvent(
  db: Db,
  record: AuthAuditRecord,
  opts: AuditPersistOptions = {},
): Promise<void> {
  const retentionDays = opts.retentionDays ?? AUDIT_RETENTION_DAYS;
  const maxRows = opts.maxRows ?? AUDIT_MAX_ROWS;
  const now = opts.now ?? Date.now();
  try {
    await db.query(
      `INSERT INTO auth_audit_events (ts, event, outcome, ip, details)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        record.ts,
        record.event,
        record.outcome,
        record.ip,
        record.details === undefined ? null : JSON.stringify(record.details),
      ],
    );
    await sweep(db, retentionDays, maxRows, now);
  } catch {
    // Best-effort (design §5.2): durable audit persistence must never throw into,
    // block, or fail the auth path it observes. A missed durable copy is the
    // accepted degradation; the stdout sink already captured the event.
  }
}

/** Server-side upper bound on a single events page (design §3.1). */
export const AUDIT_PAGE_MAX = 100;

/** Default page size when the caller does not request one (design §3.1). */
export const AUDIT_PAGE_DEFAULT = 50;

/** One row of the read surface — the durable record plus its stable row id (used
 *  only as a React key; carries no security meaning). Rows are SAFE to return by
 *  construction: they were redacted before storage (§5.4), so the read side needs
 *  no projection of its own. */
export interface AuditEventPage {
  id: string;
  ts: string;
  event: string;
  outcome: string;
  ip: string | null;
  details: Record<string, unknown> | null;
}

/**
 * Read a newest-first page of the durable audit trail (design §3.1). SELECT-only
 * — this is the read half of the insert-only-except-sweep contract; it never
 * writes. `limit` is clamped to [1, AUDIT_PAGE_MAX] server-side so a caller cannot
 * request an unbounded page. `before` is an ISO cursor: when present, only rows
 * strictly older than it are returned (keyset pagination for "load older"). The
 * tiebreak on id keeps the total order stable across pages when timestamps collide.
 */
export async function listAuditEvents(
  db: Db,
  opts: { limit?: number; before?: string | null } = {},
): Promise<AuditEventPage[]> {
  const requested = opts.limit ?? AUDIT_PAGE_DEFAULT;
  const limit = Math.max(1, Math.min(AUDIT_PAGE_MAX, Math.floor(requested)));
  // Ignore an unparseable cursor rather than letting it reach the SQL timestamp
  // comparison (which would throw). The route rejects a malformed cursor with a
  // 400 up front; this keeps the store itself total as defense in depth.
  const rawBefore = opts.before ?? null;
  const before = rawBefore && !Number.isNaN(Date.parse(rawBefore)) ? rawBefore : null;
  const rows = await db.query<{
    id: string;
    ts: unknown;
    event: string;
    outcome: string;
    ip: string | null;
    details: Record<string, unknown> | null;
  }>(
    before
      ? `SELECT id, ts, event, outcome, ip, details
           FROM auth_audit_events
          WHERE ts < $1
          ORDER BY ts DESC, id DESC
          LIMIT $2`
      : `SELECT id, ts, event, outcome, ip, details
           FROM auth_audit_events
          ORDER BY ts DESC, id DESC
          LIMIT $1`,
    before ? [before, limit] : [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    ts: new Date(String(r.ts)).toISOString(),
    event: r.event,
    outcome: r.outcome,
    ip: r.ip,
    details: r.details ?? null,
  }));
}
