// Security-event notifications — Security Center (Slice 2).
//
// Dispatch hangs off the audit CHOKE POINT (recordAuthEvent), not the routes:
// ONE definition (NOTIFY_EVENTS) covers every current and future writer that
// audits a credential event (the 051/066 lesson applied at design time). A route
// that skips auditing fails louder review than one that skips a bespoke notify
// call. `notify.*` events are structurally excluded from NOTIFY_EVENTS — the
// recursion guard is a set-membership check, not a convention.
//
// Vendor-neutral transport: everything above the wire (taxonomy, coalescing,
// egress projection, delivery semantics) is channel-independent. Two opt-in
// channels ship, both behind the same `SecurityNotifier` seam so a future channel
// (email, SMS…) slots in without touching dispatch or egress:
//   • generic WEBHOOK   — POST the plain-JSON security event to OSSHP_WEBHOOK_URL.
//   • Pushover PRESET   — map the event into Pushover form params + POST it.
//
// EGRESS is an explicit field ALLOWLIST projection (§6.3): tokens, hashes, session
// ids, user-agent strings, and any unlisted detail key NEVER leave the box. Site
// identity comes from config (never a request-derived Host, per W2/070). The
// message is INFORM-ONLY — no actionable link (an actionable link becomes a
// phishing template the moment the channel is spoofed).
//
// BEST-EFFORT: dispatch is post-mutation, fire-and-forget; it MUST NOT block,
// delay, or fail the auth path (same discipline as the audit store dual-write).
// Delivery outcomes are audited (`notify.sent` / `notify.failure`) so a silently
// broken channel is visible in the very feed the center displays.
//
// Node-only (imported only by audit.ts, a Node route-handler module); nothing here
// enters the Edge bundle. HMAC signing uses the Web Crypto global (crypto.subtle),
// never node:crypto, matching sessions.ts.

import { isIP } from "node:net";
import type { Db } from "@/lib/db/types";
import { config } from "@/lib/config";
import {
  recordAuthEvent,
  type AuthAuditEvent,
  type AuthAuditOutcome,
  type AuthAuditRecord,
} from "./audit";

// ── Taxonomy (§6.2) — the ONE definition ─────────────────────────────────────
// Maps a notifying event to its outcome rule: "success" fires only on success;
// "any" fires on success OR failure. Every event NOT in this map is silent —
// including notify.sent/notify.failure (the structural recursion guard) and the
// deliberately-silent login.*/stepup.*/rate_limit.trip/session.revoke/setup.complete.
const NOTIFY_EVENTS: ReadonlyMap<AuthAuditEvent, "success" | "any"> = new Map([
  ["passkey.enroll", "success"],
  ["credential.change", "success"],
  ["recovery.success", "success"],
  ["break_glass", "any"],
  ["lockout", "any"],
  ["session.revoke_others", "success"],
]);

/** True iff (event, outcome) is a member of NOTIFY_EVENTS. `notify.*` are never
 *  members — this membership check IS the recursion guard (§6.4). */
export function shouldNotify(
  event: AuthAuditEvent,
  outcome: AuthAuditOutcome,
): boolean {
  const rule = NOTIFY_EVENTS.get(event);
  if (rule === undefined) return false;
  return rule === "any" || outcome === "success";
}

// ── Egress allowlist projection (§6.3) ───────────────────────────────────────
// ONLY these detail keys may leave the box. Allowlist over blocklist is the
// load-bearing control; the SECRET_KEY_RE redaction that already ran in
// buildAuditRecord is the backstop, not the gate. Note `credential`: its VALUE is
// already "[REDACTED]" by the time a record reaches here (SECRET_KEY_RE matches
// the key), so the notification projects EVENT-LEVEL intent (below), never the
// redacted detail value.
const EGRESS_DETAIL_KEYS = [
  "credential",
  "action",
  "lane",
  "factor",
  "mode",
  "scope",
  "revoked",
] as const;

/**
 * Validate that `ip` is actually shaped like an IPv4 or IPv6 address (via
 * node:net's `isIP`, which returns 0 for anything else) before it is allowed
 * to egress in a notification's Source IP field. Returns the value unchanged
 * when it is IP-shaped, or `null` otherwise.
 *
 * `record.ip` comes from clientIp()/forwardedClientIp() (rate-limit.ts),
 * which picks the entry at the trusted-proxy-configured offset from
 * `X-Forwarded-For` for RATE-LIMIT KEYING and AUDIT LOGGING. That resolution
 * is correct for its own purposes and is NOT changed here (hardening
 * advisory A1, v0.4.1 — the trusted-proxy keying logic is out of scope). But
 * under a MISCONFIGURED `OSSHP_TRUSTED_PROXY_HOPS` (declared hop count
 * doesn't match the real proxy chain in front of the app), the entry at that
 * offset can be arbitrary attacker-supplied text rather than an IP — the
 * offset is computed from `entries.length`, which an unauthenticated caller
 * controls by how many comma-separated segments they put in their own XFF
 * header. Without this check, that text would be echoed verbatim into the
 * Source IP line of a lockout/credential-change alert. This validator is the
 * NOTIFICATION EGRESS boundary specifically: a non-IP-shaped value becomes
 * `null` (omitted from the message and the `ip` field), never echoed.
 */
function validatedSourceIp(ip: string | null): string | null {
  if (ip === null) return null;
  return isIP(ip) === 0 ? null : ip;
}

/** Inform-only guidance suffix — no link, no state-changing endpoint (§6.3). */
const GUIDANCE =
  "If this wasn't you, open your admin console → Security, revoke other " +
  "sessions, and rotate your credentials.";

/** The channel-independent notification handed to every SecurityNotifier. Built
 *  ONLY from allowlisted fields + config-derived site identity. */
export interface SecurityNotification {
  event: AuthAuditEvent;
  outcome: AuthAuditOutcome;
  ts: string;
  /** Trusted-proxy-resolved source IP of the triggering request, validated as
   *  IP-shaped (validatedSourceIp) before it reaches this field — never
   *  unvalidated request text. Null when unattributable or not IP-shaped. */
  ip: string | null;
  /** Site identity — the configured origin, NEVER a request-derived host. */
  site: string;
  /** Short subject line. */
  title: string;
  /** Inform-only body (no actionable link). */
  message: string;
  /** Allowlisted detail subset only (never tokens/hashes/session ids/UA). */
  details: Record<string, unknown>;
}

/** Event-level intent (§6.3): a human title+body derived from the event and only
 *  the surviving, non-secret allowlisted detail keys — never the redacted
 *  `details.credential` value. */
function describe(record: AuthAuditRecord): { title: string; body: string } {
  const d = record.details ?? {};
  switch (record.event) {
    case "passkey.enroll":
      return {
        title: "New passkey added",
        body: "A new passkey was added to your admin account.",
      };
    case "credential.change":
      // The specific credential class is redacted out of details.credential; the
      // surviving `action` key still lets us name a passkey removal specifically.
      return {
        title: "Credential changed",
        body:
          d.action === "remove"
            ? "A passkey was removed from your admin account."
            : "A sign-in credential was changed.",
      };
    case "recovery.success":
      return {
        title: "Recovery lane used",
        body: "A recovery code or fallback login was used on your admin account.",
      };
    case "break_glass":
      return {
        title: "Break-glass reset",
        body: "The CLI break-glass admin reset was invoked.",
      };
    case "lockout": {
      const lane = typeof d.lane === "string" ? d.lane : "sign-in";
      return {
        title: "Repeated failed attempts",
        body: `Repeated failed attempts locked the ${lane} lane.`,
      };
    }
    case "session.revoke_others":
      return {
        title: "Other sessions revoked",
        body: "All other sessions on your admin account were terminated.",
      };
    default:
      return {
        title: "Security event",
        body: `Security event: ${record.event}.`,
      };
  }
}

/** Project a redacted audit record into a secret-free, allowlist-only
 *  SecurityNotification. Site identity is taken from config, so a forged Host on
 *  the triggering request cannot influence it. */
export function buildNotification(
  record: AuthAuditRecord,
): SecurityNotification {
  const details: Record<string, unknown> = {};
  const src = record.details ?? {};
  for (const key of EGRESS_DETAIL_KEYS) {
    if (key in src) details[key] = src[key];
  }
  const { title, body } = describe(record);
  const site = config.origin;
  const ip = validatedSourceIp(record.ip);
  const lines = [
    body,
    "",
    `Site: ${site}`,
    `When: ${record.ts}`,
  ];
  if (ip) lines.push(`Source IP: ${ip}`);
  lines.push("", GUIDANCE);
  return {
    event: record.event,
    outcome: record.outcome,
    ts: record.ts,
    ip,
    site,
    title,
    message: lines.join("\n"),
    details,
  };
}

// ── Transports (behind one seam) ─────────────────────────────────────────────

/** A delivery channel. Everything above the wire is channel-independent. */
export interface SecurityNotifier {
  /** Stable channel id, audited in notify.sent/failure details (never a secret). */
  readonly channel: string;
  /** Deliver one notification. MUST reject on a non-2xx / transport failure so
   *  the dispatcher can retry and audit the outcome. */
  send(notification: SecurityNotification): Promise<void>;
}

/** Injectable fetch (default: the global). Tests pass a mock — no real network. */
type FetchImpl = typeof fetch;

const DELIVERY_TIMEOUT_MS = 10_000;

async function timedFetch(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // redirect:"error" — a redirect is a config error, not something to chase (§6.4).
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      redirect: "error",
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Hex HMAC-SHA256 of `body` under `secret`, via Web Crypto (no node:crypto). */
async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Generic webhook: POST the plain-JSON security event. Optional HMAC signature
 *  header lets the receiver authenticate osshp. Vendor-neutral by design. */
export class WebhookNotifier implements SecurityNotifier {
  readonly channel = "webhook";
  constructor(
    private readonly url: string,
    private readonly opts: {
      secret?: string | null;
      fetchImpl?: FetchImpl;
      timeoutMs?: number;
    } = {},
  ) {}

  async send(notification: SecurityNotification): Promise<void> {
    const body = JSON.stringify(notification);
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.opts.secret) {
      headers["x-osshp-signature"] = `sha256=${await hmacHex(this.opts.secret, body)}`;
    }
    const res = await timedFetch(
      this.opts.fetchImpl ?? fetch,
      this.url,
      { method: "POST", headers, body },
      this.opts.timeoutMs ?? DELIVERY_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new Error(`webhook responded ${res.status}`);
    }
  }
}

/** Pushover PRESET: map the channel-independent notification into Pushover's
 *  expected form params and POST to the messages API. Only a token + user key are
 *  needed; works out of the box for a self-hoster who sets just those two env vars.
 *  The message carries no secret (§6.3) and no actionable link. */
export class PushoverNotifier implements SecurityNotifier {
  readonly channel = "pushover";
  constructor(
    private readonly cfg: {
      token: string;
      userKey: string;
      apiBase: string;
      fetchImpl?: FetchImpl;
      timeoutMs?: number;
    },
  ) {}

  async send(notification: SecurityNotification): Promise<void> {
    const form = new URLSearchParams({
      token: this.cfg.token,
      user: this.cfg.userKey,
      title: notification.title,
      message: notification.message,
      // Elevate the two highest-signal events; everything else is normal priority.
      priority:
        notification.event === "break_glass" ||
        notification.event === "lockout"
          ? "1"
          : "0",
    });
    const res = await timedFetch(
      this.cfg.fetchImpl ?? fetch,
      this.cfg.apiBase,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
      this.cfg.timeoutMs ?? DELIVERY_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new Error(`pushover responded ${res.status}`);
    }
  }
}

/** Build the set of configured notifiers from env (opt-in by presence). Webhook
 *  and Pushover are independent — either, both, or neither may be active. An empty
 *  list means notifications are OFF. */
export function getConfiguredNotifiers(): SecurityNotifier[] {
  if (testNotifiers !== null) return testNotifiers;
  const notifiers: SecurityNotifier[] = [];
  const webhookUrl = config.notifyWebhookUrl;
  if (webhookUrl) {
    notifiers.push(
      new WebhookNotifier(webhookUrl, { secret: config.notifyWebhookSecret }),
    );
  }
  const token = config.pushoverToken;
  const userKey = config.pushoverUserKey;
  if (token && userKey) {
    notifiers.push(
      new PushoverNotifier({ token, userKey, apiBase: config.pushoverApiBase }),
    );
  }
  return notifiers;
}

// ── Delivery + coalescing ────────────────────────────────────────────────────

/** Lockout coalescing window: at most one notification per lane per 60 min
 *  (§6.2). Process-local in-memory state — a restart's worst case is one extra
 *  notification, never a missed first one, so no persistence is needed. */
const LOCKOUT_COALESCE_MS = 60 * 60 * 1000;

/** One retry after 30 s on failure, then give up (§6.4 / D13). */
const RETRY_DELAY_MS = 30_000;

const lastLockoutNotifiedAt = new Map<string, number>();

const sleep = (ms: number) =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

type AuditFn = typeof recordAuthEvent;

/** Deliver to one notifier with one retry; audit the outcome. Never throws. */
async function deliver(
  notifier: SecurityNotifier,
  notification: SecurityNotification,
  retryDelayMs: number,
  db: Db | undefined,
  audit: AuditFn,
): Promise<void> {
  const outcomeDetails = { channel: notifier.channel, event: notification.event };
  try {
    await notifier.send(notification);
    audit("notify.sent", "success", { db, details: outcomeDetails });
    return;
  } catch {
    // fall through to a single retry
  }
  await sleep(retryDelayMs);
  try {
    await notifier.send(notification);
    audit("notify.sent", "success", { db, details: outcomeDetails });
  } catch {
    audit("notify.failure", "failure", { db, details: outcomeDetails });
  }
}

export interface DispatchOptions {
  /** Override the configured notifiers (test seam). */
  notifiers?: SecurityNotifier[];
  /** Injected "now" (epoch ms) for deterministic coalescing tests. */
  now?: number;
  /** Retry delay override (ms). Tests pass 0 to avoid a real 30 s wait. */
  retryDelayMs?: number;
  /** Audit function override (test seam); defaults to recordAuthEvent. */
  audit?: AuditFn;
}

/**
 * Dispatch a notification for one audit record IF it is a NOTIFY_EVENTS member.
 * Post-mutation, best-effort, never throws into the auth path. The caller
 * (recordAuthEvent) invokes this fire-and-forget. Auditing notify.sent/failure
 * re-enters recordAuthEvent → dispatchNotification, but notify.* are not
 * NOTIFY_EVENTS members, so it returns immediately (recursion guard).
 */
export async function dispatchNotification(
  record: AuthAuditRecord,
  db?: Db,
  opts: DispatchOptions = {},
): Promise<void> {
  if (!shouldNotify(record.event, record.outcome)) return;

  const now = opts.now ?? Date.now();

  // Lockout coalescing (§6.2): one send per lane per window.
  if (record.event === "lockout") {
    const lane =
      typeof record.details?.lane === "string" ? record.details.lane : "unknown";
    const last = lastLockoutNotifiedAt.get(lane);
    if (last !== undefined && now - last < LOCKOUT_COALESCE_MS) return;
    lastLockoutNotifiedAt.set(lane, now);
  }

  const notifiers = opts.notifiers ?? getConfiguredNotifiers();
  if (notifiers.length === 0) return; // notifications disabled

  const notification = buildNotification(record);
  const audit = opts.audit ?? recordAuthEvent;
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;

  for (const notifier of notifiers) {
    await deliver(notifier, notification, retryDelayMs, db, audit);
  }
}

// ── Test seams ───────────────────────────────────────────────────────────────
let testNotifiers: SecurityNotifier[] | null = null;

/** Install a fixed notifier list that getConfiguredNotifiers returns (test seam).
 *  Pass null to restore env-derived behavior. */
export function setTestNotifiers(notifiers: SecurityNotifier[] | null): void {
  testNotifiers = notifiers;
}

/** Clear lockout coalescing state between tests. */
export function resetNotifyCoalescing(): void {
  lastLockoutNotifiedAt.clear();
}
