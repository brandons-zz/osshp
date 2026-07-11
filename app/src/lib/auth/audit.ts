// Structured auth-event audit log (owasp-audit A09).
//
// There was ZERO logging in the auth paths — the single largest observability
// blind spot. This seam emits one structured JSON line per security-relevant auth
// event: who/what/when/outcome/source-IP, and NEVER a secret. The source IP is
// resolved trusted-proxy-aware (the same logic the rate limiter keys on), so it
// reflects the entry an operator-trusted proxy appended, not an attacker-rotatable
// client header.
//
// Secret-redaction is a REAL control, enforced two ways:
//  1. Call sites pass only safe, non-secret detail fields (event, lane, mode…).
//  2. redactDetails() is the backstop: any detail key that looks secret-bearing is
//     replaced with "[REDACTED]" before serialization, recursively. So even a
//     future careless call site cannot leak a secret value into a log line.
//
// Runtime-agnostic (no node:crypto, no Buffer); imported only by Node route
// handlers, never by the Edge middleware.

import type { Db } from "@/lib/db/types";
import { clientIp } from "./rate-limit";
import { persistAuditEvent } from "./audit-store";
import { dispatchNotification } from "./notify";

/**
 * Security-relevant auth events. M2.1 covered the existing lanes; the M2.2
 * recovery lanes add recovery.success/failure (password+TOTP or recovery-code
 * lane outcomes), lockout (a recovery lane rate-limit trip), break_glass (CLI
 * admin reset), and credential.change (password/TOTP/recovery-code mutation).
 * session.revoke_all was already defined and is now wired wherever the recovery
 * lanes call revokeAllSessions.
 */
export type AuthAuditEvent =
  | "login.success"
  | "login.failure"
  | "passkey.enroll"
  | "passkey.enroll_failure"
  | "session.revoke"
  | "session.revoke_all"
  // Security Center (Slice 2, §4): the asymmetric revoke-others eviction primitive
  // — every session but the caller's is terminated, then the caller's is rotated.
  | "session.revoke_others"
  | "rate_limit.trip"
  | "setup.complete"
  | "recovery.success"
  | "recovery.failure"
  | "lockout"
  | "break_glass"
  | "credential.change"
  // Step-up re-authentication (A1): a successful grant mint, a failed mint attempt
  // (bad assertion / wrong fallback factors), and a denial at a gated route (grant
  // absent/expired/consumed/wrong/foreign). None ever carries the grant token.
  | "stepup.grant"
  | "stepup.failure"
  | "stepup.denied"
  // Security notification delivery outcomes (Security Center Slice 2, §6.4). These
  // are audited so a silently-broken channel is visible in the feed. They are
  // STRUCTURALLY excluded from NOTIFY_EVENTS (the recursion guard) — recording one
  // never triggers another notification.
  | "notify.sent"
  | "notify.failure";

export type AuthAuditOutcome = "success" | "failure";

export interface AuthAuditRecord {
  /** ISO-8601 UTC timestamp. */
  ts: string;
  event: AuthAuditEvent;
  outcome: AuthAuditOutcome;
  /** Trusted-proxy-aware source IP, or null when unattributable. */
  ip: string | null;
  /** Redacted, non-secret context (lane, mode, reason…). */
  details?: Record<string, unknown>;
}

// Keys whose values must never reach a log line. Matched case-insensitively as a
// substring so e.g. `totpSecret`, `recovery_code`, `password_hash`, `sessionToken`
// are all caught. This is the enforced "no secrets in logs" backstop.
const SECRET_KEY_RE =
  /secret|token|password|passwd|totp|recovery|hash|cookie|credential|challenge|private|\bkey\b|apikey|api_key/i;

const REDACTED = "[REDACTED]";

/**
 * Redact one detail VALUE (as opposed to a keyed field): recurses into plain
 * objects (via redactDetails, so their own keys are checked against
 * SECRET_KEY_RE) and into arrays (element-wise, recursively — an array can
 * hold further arrays or secret-bearing objects). Primitives pass through
 * unchanged; a primitive is only ever redacted at its parent key.
 *
 * No current writer emits an array-of-objects detail value, but redactDetails
 * previously left arrays untouched entirely (the `!Array.isArray(value)`
 * guard skipped them and fell through to `out[key] = value` verbatim), so a
 * future event carrying e.g. `details.sessions: [{ token: "…" }]` would have
 * shipped its secret straight through unredacted. Hardened as defense in
 * depth (advisory A2, v0.4.1 — no live regression, the fix closes a gap for
 * writers that don't exist yet).
 */
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v));
  }
  if (value !== null && typeof value === "object") {
    return redactDetails(value as Record<string, unknown>);
  }
  return value;
}

/**
 * Recursively replace any secret-bearing detail value with "[REDACTED]". A
 * value under a secret-looking KEY is redacted regardless of its type
 * (object, array, or primitive); a value under a safe key recurses into
 * plain objects AND arrays (redactValue) so a secret-bearing field nested
 * inside either is still caught wherever it appears.
 */
export function redactDetails(
  details: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactValue(value);
  }
  return out;
}

/** Build the audit record (pure — no I/O), with details redacted and IP resolved. */
export function buildAuditRecord(
  event: AuthAuditEvent,
  outcome: AuthAuditOutcome,
  opts: { request?: Request; details?: Record<string, unknown> } = {},
): AuthAuditRecord {
  const record: AuthAuditRecord = {
    ts: new Date().toISOString(),
    event,
    outcome,
    ip: opts.request ? clientIp(opts.request) : null,
  };
  if (opts.details) record.details = redactDetails(opts.details);
  return record;
}

// Pluggable sink so tests can capture lines without intercepting console. The
// default emits a single structured JSON line to stdout — a self-hoster's `docker
// logs` / journald captures it; no separate log infrastructure is required.
type AuditSink = (record: AuthAuditRecord) => void;

let sink: AuditSink = (record) => {
  console.log(JSON.stringify({ kind: "auth_audit", ...record }));
};

/** Replace the audit sink (test seam). Returns the previous sink for restore. */
export function setAuditSink(next: AuditSink): AuditSink {
  const prev = sink;
  sink = next;
  return prev;
}

/**
 * Record (build + emit) one auth audit event. Never throws into the caller.
 *
 * The record is built ONCE (redaction happens there, buildAuditRecord) and then
 * dual-written: always to the stdout sink (unchanged), and — when `opts.db` is
 * present — durably to auth_audit_events (§5). The two sinks carry the SAME
 * post-redaction object, so they can never disagree about content. The durable
 * write is BEST-EFFORT and fire-and-forget: persistAuditEvent already swallows its
 * own failures (never rejects), so it cannot throw into or block this synchronous
 * auth-path call. A call site without a `db` (early boot, tests, the Edge plane)
 * degrades to console-only — never an error.
 */
export function recordAuthEvent(
  event: AuthAuditEvent,
  outcome: AuthAuditOutcome,
  opts: { request?: Request; details?: Record<string, unknown>; db?: Db } = {},
): void {
  let record: AuthAuditRecord;
  try {
    record = buildAuditRecord(event, outcome, opts);
    sink(record);
  } catch {
    // Audit logging must never break the auth path it observes.
    return;
  }
  if (opts.db) {
    // Fire-and-forget: does not block the auth path, and persistAuditEvent never
    // rejects (the .catch is belt-and-suspenders against a future refactor).
    void persistAuditEvent(opts.db, record).catch(() => {});
  }
  // Security notifications hang off THIS choke point (§6.1): one NOTIFY_EVENTS
  // definition covers every writer. Fire-and-forget, best-effort — the dispatcher
  // never blocks or throws into the auth path (a Pushover/webhook failure never
  // breaks a login/credential/recovery flow). notify.* are structurally excluded
  // from NOTIFY_EVENTS, so auditing a delivery outcome cannot recurse.
  void dispatchNotification(record, opts.db).catch(() => {});
}
