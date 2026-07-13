// Security-event notifications (Security Center Slice 2, §6).
//
// The dispatch, taxonomy, coalescing, and egress-allowlist logic are channel-
// independent; the two transports (generic webhook + Pushover preset) are behind
// one seam. These tests drive the core `dispatchNotification` directly (awaitable),
// mirroring the audit-store test approach — the fire-and-forget wrapper in
// recordAuthEvent is not deterministically awaitable. NO test touches the network:
// notifiers are either in-memory fakes or real transports pointed at a mock fetch.

process.env.OSSHP_ORIGIN = "https://osshp.example.com";
process.env.OSSHP_TRUSTED_PROXY_HOPS = "1";

import { afterEach, expect, test } from "bun:test";
import {
  buildAuditRecord,
  buildNotification,
  dispatchNotification,
  recordAuthEvent,
  setAuditSink,
  setTestNotifiers,
  resetNotifyCoalescing,
  shouldNotify,
  WebhookNotifier,
  PushoverNotifier,
  type AuthAuditEvent,
  type AuthAuditOutcome,
  type AuthAuditRecord,
  type SecurityNotification,
  type SecurityNotifier,
} from "../index";

// ── Fakes / seam restore ──────────────────────────────────────────────────────

/** A notifier that records every notification it is asked to send. */
class RecordingNotifier implements SecurityNotifier {
  readonly channel = "recording";
  readonly sent: SecurityNotification[] = [];
  async send(n: SecurityNotification): Promise<void> {
    this.sent.push(n);
  }
}

/** A notifier whose send always rejects (forced transport failure). */
class FailingNotifier implements SecurityNotifier {
  readonly channel = "failing";
  attempts = 0;
  async send(): Promise<void> {
    this.attempts += 1;
    throw new Error("transport down");
  }
}

let restoreSink: ((r: AuthAuditRecord) => void) | null = null;
afterEach(() => {
  if (restoreSink) setAuditSink(restoreSink);
  restoreSink = null;
  setTestNotifiers(null);
  resetNotifyCoalescing();
});

function req(ip = "9.9.9.9"): Request {
  return new Request("https://osshp.example.com/api/auth/x", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

// A source-event record for a given taxonomy member.
function record(
  event: AuthAuditEvent,
  outcome: AuthAuditOutcome,
  details?: Record<string, unknown>,
): AuthAuditRecord {
  return buildAuditRecord(event, outcome, { request: req(), details });
}

// ── Taxonomy ──────────────────────────────────────────────────────────────────

test("NOTIFY_EVENTS membership: fires for taxonomy members, silent otherwise", () => {
  expect(shouldNotify("passkey.enroll", "success")).toBe(true);
  expect(shouldNotify("credential.change", "success")).toBe(true);
  expect(shouldNotify("recovery.success", "success")).toBe(true);
  expect(shouldNotify("session.revoke_others", "success")).toBe(true);
  // "any"-outcome members fire on failure too.
  expect(shouldNotify("break_glass", "failure")).toBe(true);
  expect(shouldNotify("lockout", "failure")).toBe(true);
  // success-only members do NOT fire on failure.
  expect(shouldNotify("credential.change", "failure")).toBe(false);
  expect(shouldNotify("passkey.enroll", "failure")).toBe(false);
  // Deliberately-silent events.
  expect(shouldNotify("login.success", "success")).toBe(false);
  expect(shouldNotify("stepup.grant", "success")).toBe(false);
  expect(shouldNotify("session.revoke", "success")).toBe(false);
  // Recursion guard: notify.* are NEVER members.
  expect(shouldNotify("notify.sent", "success")).toBe(false);
  expect(shouldNotify("notify.failure", "failure")).toBe(false);
});

// ── fires exactly one notification per taxonomy event when ENABLED ──────

test("fires-when-enabled: each taxonomy event fires exactly one send", async () => {
  const cases: Array<[AuthAuditEvent, AuthAuditOutcome, Record<string, unknown>?]> = [
    ["passkey.enroll", "success", { mode: "bootstrap" }],
    ["credential.change", "success", { credential: "password", factor: "passkey" }],
    ["recovery.success", "success", { lane: "recovery-code" }],
    ["break_glass", "success", { reason: "break_glass" }],
    ["lockout", "failure", { lane: "recovery-code" }],
    ["session.revoke_others", "success", { revoked: 3, factor: "passkey" }],
  ];
  for (const [event, outcome, details] of cases) {
    const notifier = new RecordingNotifier();
    await dispatchNotification(record(event, outcome, details), undefined, {
      notifiers: [notifier],
    });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0].event).toBe(event);
  }
});

test("a non-taxonomy (silent) event fires NO notification even when enabled", async () => {
  const notifier = new RecordingNotifier();
  await dispatchNotification(record("login.success", "success"), undefined, {
    notifiers: [notifier],
  });
  await dispatchNotification(record("stepup.grant", "success"), undefined, {
    notifiers: [notifier],
  });
  expect(notifier.sent).toHaveLength(0);
});

// ── none-when-disabled ─────────────────────────────────────────────────

test("none-when-disabled: no configured notifier ⇒ zero sends, no audit", async () => {
  const lines: AuthAuditRecord[] = [];
  restoreSink = setAuditSink((r) => lines.push(r));
  // Empty notifier list = notifications OFF.
  await dispatchNotification(record("credential.change", "success", { credential: "password" }), undefined, {
    notifiers: [],
  });
  // No notify.sent / notify.failure recorded.
  expect(lines.filter((r) => r.event.startsWith("notify."))).toHaveLength(0);
});

// ── Lockout coalescing: 1 per lane per 60 min ─────────────────────────────────

test("lockout coalesces to one send per lane per 60-min window", async () => {
  const notifier = new RecordingNotifier();
  const base = 1_000_000_000_000;
  const rec = () => record("lockout", "failure", { lane: "recovery-code" });

  await dispatchNotification(rec(), undefined, { notifiers: [notifier], now: base });
  // Second trip on the SAME lane, 10 min later → coalesced (no send).
  await dispatchNotification(rec(), undefined, { notifiers: [notifier], now: base + 10 * 60_000 });
  expect(notifier.sent).toHaveLength(1);

  // A DIFFERENT lane within the window is independent → sends.
  await dispatchNotification(record("lockout", "failure", { lane: "password-totp" }), undefined, {
    notifiers: [notifier],
    now: base + 11 * 60_000,
  });
  expect(notifier.sent).toHaveLength(2);

  // Same first lane AFTER the 60-min window → sends again.
  await dispatchNotification(rec(), undefined, { notifiers: [notifier], now: base + 61 * 60_000 });
  expect(notifier.sent).toHaveLength(3);
});

// ── no secret-bearing field in the dispatched payload (hostile content) ─

test("no-secret-egress: allowlist projection drops hostile keys and secrets", () => {
  // A record salted with hostile/secret detail keys. buildAuditRecord redacts by
  // KEY; buildNotification then projects only the egress allowlist.
  const SECRET = "JBSWY3DPEHPK3PXP-super-secret";
  const rec = buildAuditRecord("credential.change", "success", {
    request: req("203.0.113.7"),
    details: {
      credential: "password", // allowlisted KEY, but value is redacted by SECRET_KEY_RE
      factor: "passkey", // allowlisted, survives
      totpSecret: SECRET, // secret — must never leave
      sessionToken: "abc.def", // secret — must never leave
      sessionId: "sess_deadbeef", // not allowlisted — dropped
      user_agent: "Mozilla/5.0 (evil)", // not allowlisted — dropped
      passwordHash: "$2b$deadbeef", // secret — must never leave
      nested: { recovery_code: SECRET }, // not allowlisted — dropped
    },
  });

  const n = buildNotification(rec);
  const blob = JSON.stringify(n);

  // Only allowlisted keys survive in details.
  expect(Object.keys(n.details).sort()).toEqual(["credential", "factor"]);
  // The credential VALUE is the already-redacted marker — event-level intent, not
  // the real class (the cross-slice SECRET_KEY_RE gotcha).
  expect(n.details.credential).toBe("[REDACTED]");
  expect(n.details.factor).toBe("passkey");

  // No secret / session id / UA anywhere in the serialized payload.
  expect(blob.includes(SECRET)).toBe(false);
  expect(blob.includes("sess_deadbeef")).toBe(false);
  expect(blob.includes("Mozilla")).toBe(false);
  expect(blob.includes("$2b$deadbeef")).toBe(false);
  expect(blob.toLowerCase().includes("totpsecret")).toBe(false);
  expect(blob.toLowerCase().includes("sessiontoken")).toBe(false);

  // Site identity is the CONFIGURED origin, never request-derived.
  expect(n.site).toBe("https://osshp.example.com");
  // Message is inform-only: no URL/link scheme beyond the site identity line.
  expect(n.message).not.toMatch(/click|https?:\/\/(?!osshp\.example\.com)/i);
  expect(n.message).toContain("If this wasn't you");
});

test("site identity ignores a forged Host on the triggering request", () => {
  const rec = buildAuditRecord("session.revoke_others", "success", {
    request: new Request("https://attacker.example/api/auth/x", {
      method: "POST",
      headers: { host: "attacker.example", "x-forwarded-host": "evil.test" },
    }),
    details: { revoked: 2, factor: "passkey" },
  });
  const n = buildNotification(rec);
  expect(n.site).toBe("https://osshp.example.com");
  expect(JSON.stringify(n)).not.toContain("evil.test");
  expect(JSON.stringify(n)).not.toContain("attacker.example");
});

// ── A1 ip-shape: a malformed/spoofed XFF cannot inject raw text into the ──────
// notification's IP field (hardening advisory A1, v0.4.1). Under a
// misconfigured OSSHP_TRUSTED_PROXY_HOPS (declared hop count doesn't match the
// real chain in front of the app), forwardedClientIp() can resolve to whatever
// text an unauthenticated caller put in their own X-Forwarded-For header — the
// offset it reads from is `entries.length`, which the caller controls by how
// many comma-separated segments they send. buildNotification must never echo
// that text verbatim into the Source IP line; it must be validated-IP-or-null.

test("A1 ip-shape: a bogus single-entry XFF resolves to a validated-or-omitted IP, never raw text", () => {
  // hops=1 (test env default): with exactly ONE comma-separated entry, the
  // trusted-proxy offset (entries.length - hops = 0) selects that entry — the
  // same position a real proxy-appended IP would occupy. An attacker who can
  // reach the app directly (bypassing/spoofing the trusted proxy) controls
  // this text completely.
  const bogus = "'; DROP TABLE users; --<script>alert(1)</script>";
  const rec = buildAuditRecord("credential.change", "success", {
    request: new Request("https://osshp.example.com/api/auth/x", {
      method: "POST",
      headers: { "x-forwarded-for": bogus },
    }),
    details: { action: "remove", factor: "passkey" },
  });
  // As of the client-IP-attribution fix (2026-07-12, §5), clientIp() IP-shape-
  // validates at the SOURCE, so the raw text no longer even reaches the audit
  // record — A1 is now closed at origin, not just at the notification egress.
  expect(rec.ip).toBeNull();

  // … and a fortiori it must NOT reach the notification: not in the `ip` field,
  // not in the rendered message, anywhere in the serialized payload.
  const n = buildNotification(rec);
  expect(n.ip).toBeNull();
  expect(n.message).not.toContain("Source IP");
  expect(n.message).not.toContain(bogus);
  expect(JSON.stringify(n)).not.toContain(bogus);
});

test("A1 ip-shape: a genuine IPv4/IPv6 address still egresses normally (no regression)", () => {
  const rec4 = buildAuditRecord("lockout", "failure", {
    request: req("203.0.113.7"),
    details: { lane: "recovery-code" },
  });
  const n4 = buildNotification(rec4);
  expect(n4.ip).toBe("203.0.113.7");
  expect(n4.message).toContain("Source IP: 203.0.113.7");

  const rec6 = buildAuditRecord("lockout", "failure", {
    request: req("2001:db8::1"),
    details: { lane: "recovery-code" },
  });
  const n6 = buildNotification(rec6);
  expect(n6.ip).toBe("2001:db8::1");
  expect(n6.message).toContain("Source IP: 2001:db8::1");
});

test("A1 ip-shape: unattributable (null) IP stays null, no Source IP line", () => {
  const rec = buildAuditRecord("recovery.success", "success", {
    details: { lane: "recovery-code" },
  }); // no `request` opt ⇒ ip is null
  const n = buildNotification(rec);
  expect(n.ip).toBeNull();
  expect(n.message).not.toContain("Source IP");
});

// ── forced transport failure never breaks the auth path ────────────────

test("failure-doesnt-break-auth: dispatch resolves + audits notify.failure on forced failure", async () => {
  const lines: AuthAuditRecord[] = [];
  restoreSink = setAuditSink((r) => lines.push(r));
  const failing = new FailingNotifier();

  // retryDelayMs: 0 so the single retry runs immediately (no real 30 s wait).
  await expect(
    dispatchNotification(record("break_glass", "success", { reason: "break_glass" }), undefined, {
      notifiers: [failing],
      retryDelayMs: 0,
    }),
  ).resolves.toBeUndefined();

  // Two attempts (initial + one retry), then a notify.failure audit — no throw.
  expect(failing.attempts).toBe(2);
  const notifyEvents = lines.filter((r) => r.event.startsWith("notify."));
  expect(notifyEvents).toHaveLength(1);
  expect(notifyEvents[0].event).toBe("notify.failure");
  expect(notifyEvents[0].details).toEqual({ channel: "failing", event: "break_glass" });
});

test("recordAuthEvent (the auth-path call) never throws when a notifier fails", () => {
  // Install a throwing notifier as the CONFIGURED channel; make the retry instant.
  setTestNotifiers([new FailingNotifier()]);
  // The synchronous auth-path call must return normally; dispatch is fire-and-forget.
  expect(() =>
    recordAuthEvent("credential.change", "success", {
      request: req(),
      details: { credential: "totp" },
    }),
  ).not.toThrow();
});

test("a successful send audits notify.sent through recordAuthEvent wiring", async () => {
  const lines: AuthAuditRecord[] = [];
  restoreSink = setAuditSink((r) => lines.push(r));
  const notifier = new RecordingNotifier();

  // Drive the CORE with a capturing audit so we can await deterministically.
  await dispatchNotification(record("passkey.enroll", "success", { mode: "reenroll" }), undefined, {
    notifiers: [notifier],
    audit: (event, outcome, opts) => {
      lines.push({ ts: "", event, outcome, ip: null, details: opts?.details });
    },
  });
  expect(notifier.sent).toHaveLength(1);
  const sent = lines.filter((r) => r.event === "notify.sent");
  expect(sent).toHaveLength(1);
  expect(sent[0].details).toEqual({ channel: "recording", event: "passkey.enroll" });
});

// ── Transport: generic webhook against a MOCK fetch (no network) ───────────────

test("webhook transport POSTs the plain-JSON event to a mock endpoint, no secrets", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const n = buildNotification(
    buildAuditRecord("recovery.success", "success", {
      request: req("198.51.100.4"),
      details: { lane: "recovery-code", totpSecret: "should-not-appear" },
    }),
  );

  const notifier = new WebhookNotifier("https://mock.internal/hook", { fetchImpl: mockFetch });
  await notifier.send(n);

  expect(captured).not.toBeNull();
  expect(captured!.url).toBe("https://mock.internal/hook");
  expect(captured!.init.method).toBe("POST");
  expect((captured!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  expect(captured!.init.redirect).toBe("error");
  const body = JSON.parse(captured!.init.body as string);
  expect(body.event).toBe("recovery.success");
  expect(body.site).toBe("https://osshp.example.com");
  expect(body.details).toEqual({ lane: "recovery-code" });
  expect(captured!.init.body as string).not.toContain("should-not-appear");
});

test("webhook transport signs the body with HMAC-SHA256 when a secret is set", async () => {
  let sig: string | undefined;
  let body: string | undefined;
  const mockFetch = (async (_url: string, init?: RequestInit) => {
    sig = (init?.headers as Record<string, string>)["x-osshp-signature"];
    body = init?.body as string;
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const n = buildNotification(record("break_glass", "success", { reason: "break_glass" }));
  await new WebhookNotifier("https://mock.internal/hook", {
    fetchImpl: mockFetch,
    secret: "shared-secret",
  }).send(n);

  expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  // Recompute the expected HMAC to prove the header is a real signature of the body.
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("shared-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body!));
  const expected =
    "sha256=" +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  expect(sig).toBe(expected);
});

test("webhook transport rejects on a non-2xx response (so the dispatcher retries)", async () => {
  const mockFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  const n = buildNotification(record("lockout", "failure", { lane: "recovery-code" }));
  await expect(
    new WebhookNotifier("https://mock.internal/hook", { fetchImpl: mockFetch }).send(n),
  ).rejects.toThrow();
});

// ── Transport: Pushover PRESET against a MOCK fetch (no network) ───────────────

test("pushover preset maps the event into Pushover form params against a mock endpoint", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify({ status: 1 }), { status: 200 });
  }) as unknown as typeof fetch;

  const n = buildNotification(
    buildAuditRecord("passkey.enroll", "success", {
      request: req("192.0.2.9"),
      details: { mode: "bootstrap", totpSecret: "should-not-appear" },
    }),
  );

  await new PushoverNotifier({
    token: "app-token-xyz",
    userKey: "user-key-abc",
    apiBase: "https://mock.pushover.local/1/messages.json",
    fetchImpl: mockFetch,
  }).send(n);

  expect(captured).not.toBeNull();
  expect(captured!.url).toBe("https://mock.pushover.local/1/messages.json");
  expect(captured!.init.method).toBe("POST");
  expect((captured!.init.headers as Record<string, string>)["content-type"]).toBe(
    "application/x-www-form-urlencoded",
  );
  expect(captured!.init.redirect).toBe("error");

  const form = new URLSearchParams(captured!.init.body as string);
  expect(form.get("token")).toBe("app-token-xyz");
  expect(form.get("user")).toBe("user-key-abc");
  expect(form.get("title")).toBe("New passkey added");
  expect(form.get("message")).toContain("A new passkey was added");
  expect(form.get("priority")).toBe("0");
  // No secret leaks into the form body.
  expect(captured!.init.body as string).not.toContain("should-not-appear");
});

test("pushover preset elevates break_glass / lockout to priority 1", async () => {
  let form: URLSearchParams | null = null;
  const mockFetch = (async (_u: string, init?: RequestInit) => {
    form = new URLSearchParams(init!.body as string);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  await new PushoverNotifier({
    token: "t",
    userKey: "u",
    apiBase: "https://mock.pushover.local/1/messages.json",
    fetchImpl: mockFetch,
  }).send(buildNotification(record("break_glass", "success", { reason: "break_glass" })));

  expect(form!.get("priority")).toBe("1");
});

test("pushover preset rejects on a non-2xx response (dispatcher retries)", async () => {
  const mockFetch = (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
  await expect(
    new PushoverNotifier({
      token: "t",
      userKey: "u",
      apiBase: "https://mock.pushover.local/1/messages.json",
      fetchImpl: mockFetch,
    }).send(buildNotification(record("lockout", "failure", { lane: "recovery-code" }))),
  ).rejects.toThrow();
});

// ── Both channels active: one send each, independently ────────────────────────

test("both webhook + pushover configured ⇒ each channel receives the event once", async () => {
  const webhookHits: string[] = [];
  const pushoverHits: string[] = [];
  const webhookFetch = (async (_u: string, init?: RequestInit) => {
    webhookHits.push(init!.body as string);
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const pushoverFetch = (async (_u: string, init?: RequestInit) => {
    pushoverHits.push(init!.body as string);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const notifiers = [
    new WebhookNotifier("https://mock.internal/hook", { fetchImpl: webhookFetch }),
    new PushoverNotifier({
      token: "t",
      userKey: "u",
      apiBase: "https://mock.pushover.local/1/messages.json",
      fetchImpl: pushoverFetch,
    }),
  ];

  await dispatchNotification(record("credential.change", "success", { credential: "password" }), undefined, {
    notifiers,
    audit: () => {},
  });

  expect(webhookHits).toHaveLength(1);
  expect(pushoverHits).toHaveLength(1);
});
