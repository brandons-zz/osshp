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

import { clientIp } from "./rate-limit";

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
  | "rate_limit.trip"
  | "setup.complete"
  | "recovery.success"
  | "recovery.failure"
  | "lockout"
  | "break_glass"
  | "credential.change";

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
 * Recursively replace any secret-bearing detail value with "[REDACTED]". Plain
 * objects are walked; arrays and primitives under a safe key pass through. A value
 * under a secret-looking key is redacted regardless of its type.
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
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = redactDetails(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
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

/** Record (build + emit) one auth audit event. Never throws into the caller. */
export function recordAuthEvent(
  event: AuthAuditEvent,
  outcome: AuthAuditOutcome,
  opts: { request?: Request; details?: Record<string, unknown> } = {},
): void {
  try {
    sink(buildAuditRecord(event, outcome, opts));
  } catch {
    // Audit logging must never break the auth path it observes.
  }
}
