// Auth audit-log seam (owasp-audit A09): structured records, trusted-proxy-aware
// source IP, and enforced secret-redaction ("no secrets in logs" is a real control).

process.env.OSSHP_TRUSTED_PROXY_HOPS = "1";

import { afterEach, expect, test } from "bun:test";
import {
  buildAuditRecord,
  recordAuthEvent,
  redactDetails,
  setAuditSink,
  type AuthAuditRecord,
} from "../audit";

function reqWithIp(ip: string): Request {
  return new Request("https://blog.example.com/api/auth/login/verify", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

// Always restore the default sink so capture in one test never leaks into others.
let restore: ((r: AuthAuditRecord) => void) | null = null;
afterEach(() => {
  if (restore) setAuditSink(restore);
  restore = null;
});

test("redactDetails replaces secret-bearing keys, keeps safe ones", () => {
  const out = redactDetails({
    lane: "login",
    mode: "bootstrap",
    totpSecret: "JBSWY3DPEHPK3PXP",
    password: "hunter2",
    recovery_code: "abcd-efgh",
    sessionToken: "deadbeef.cafef00d",
    nested: { apiKey: "sk-12345", note: "fine" },
  });
  expect(out.lane).toBe("login");
  expect(out.mode).toBe("bootstrap");
  expect(out.totpSecret).toBe("[REDACTED]");
  expect(out.password).toBe("[REDACTED]");
  expect(out.recovery_code).toBe("[REDACTED]");
  expect(out.sessionToken).toBe("[REDACTED]");
  expect((out.nested as Record<string, unknown>).apiKey).toBe("[REDACTED]");
  expect((out.nested as Record<string, unknown>).note).toBe("fine");
});

// ── A2 array-redaction: redactDetails recurses into arrays (hardening advisory ──
// A2, v0.4.1). No current writer emits an array-of-objects detail value, but a
// future one could (e.g. `details.sessions: [{...}]`) — this proves such a
// value is redacted, not shipped through verbatim (the pre-fix behavior).

test("A2 array-redaction: a secret-bearing object nested inside an array is redacted", () => {
  const out = redactDetails({
    lane: "recovery-code",
    // Array of plain objects, each with a mix of safe + secret-bearing keys.
    sessions: [
      { id: "safe-1", token: "should-not-survive" },
      { id: "safe-2", note: "fine", apiKey: "sk-also-should-not-survive" },
    ],
    // Array nested two levels deep (array of arrays of objects).
    grouped: [[{ recovery_code: "abcd-efgh" }], [{ label: "ok" }]],
  });

  const sessions = out.sessions as Array<Record<string, unknown>>;
  expect(sessions[0].id).toBe("safe-1");
  expect(sessions[0].token).toBe("[REDACTED]");
  expect(sessions[1].note).toBe("fine");
  expect(sessions[1].apiKey).toBe("[REDACTED]");

  const grouped = out.grouped as Array<Array<Record<string, unknown>>>;
  expect(grouped[0][0].recovery_code).toBe("[REDACTED]");
  expect(grouped[1][0].label).toBe("ok");

  // Belt-and-suspenders: no secret value anywhere in the serialized output.
  const blob = JSON.stringify(out);
  expect(blob.includes("should-not-survive")).toBe(false);
  expect(blob.includes("sk-also-should-not-survive")).toBe(false);
  expect(blob.includes("abcd-efgh")).toBe(false);
});

// ── A3 non-plain-object redaction: Date/Map (and Set) get predictable handling
// (hardening advisory A3). Pre-fix, redactValue treated ANY `typeof === "object"`
// value as a plain record and ran it through redactDetails/Object.entries —
// which returns `[]` for a Date or a Map (their real content lives in internal
// slots, not own enumerable string-keyed properties), so both silently
// collapsed to a misleading `{}`: a benign Date lost its value with no signal
// anything was dropped, and a Map's entries — including any secret-bearing
// key — were never even reached by the SECRET_KEY_RE check. No current writer
// emits either, so this closes a defense-in-depth gap, not a live leak.

test("A3: a Date detail value is preserved as an ISO string, not silently mangled to {}", () => {
  const when = new Date("2026-07-12T03:04:05.000Z");
  const out = redactDetails({ lane: "login", occurredAt: when });
  // Pre-fix this was `{}` (Object.entries(date) === []) — a silent, misleading
  // collapse of a benign value. Post-fix it is the lossless ISO projection.
  expect(out.occurredAt).toBe("2026-07-12T03:04:05.000Z");
  expect(out.occurredAt).not.toEqual({});
});

test("A3: a Map detail value redacts secret-looking keys and keeps safe ones (no bypass)", () => {
  const sessions = new Map<string, unknown>([
    ["token", "should-not-survive"],
    ["label", "primary"],
  ]);
  const out = redactDetails({ lane: "session.revoke_others", sessions });

  // Pre-fix this was `{}` — the Map's keys were never checked against
  // SECRET_KEY_RE at all (Object.entries(map) === []), so the secret-bearing
  // key wasn't merely unredacted, it (and the benign key) vanished silently.
  expect(out.sessions).not.toEqual({});
  const redactedSessions = out.sessions as Record<string, unknown>;
  expect(redactedSessions.token).toBe("[REDACTED]");
  expect(redactedSessions.label).toBe("primary");

  // Belt-and-suspenders: the secret value never reaches the serialized line.
  const blob = JSON.stringify(out);
  expect(blob.includes("should-not-survive")).toBe(false);
});

test("A3: a Map with non-string keys still redacts via the stringified key", () => {
  const m = new Map<unknown, unknown>([
    [Symbol("totpSecret"), "should-not-survive"],
    [1, "fine"],
  ]);
  const out = redactDetails({ lane: "login", m });
  const redacted = out.m as Record<string, unknown>;
  // Symbol("totpSecret") stringifies to "Symbol(totpSecret)" — still matches
  // SECRET_KEY_RE's /totp/i substring test, so it redacts.
  expect(Object.values(redacted)).toContain("[REDACTED]");
  expect(redacted["1"]).toBe("fine");
  const blob = JSON.stringify(out);
  expect(blob.includes("should-not-survive")).toBe(false);
});

test("A3: a Set detail value redacts element-wise like an array, no silent collapse", () => {
  const out = redactDetails({
    lane: "login",
    tags: new Set(["safe-a", "safe-b"]),
    nested: new Set([{ recovery_code: "abcd-efgh" }, { label: "ok" }]),
  });
  expect(out.tags).toEqual(["safe-a", "safe-b"]);
  const nested = out.nested as Array<Record<string, unknown>>;
  expect(nested[0].recovery_code).toBe("[REDACTED]");
  expect(nested[1].label).toBe("ok");
  const blob = JSON.stringify(out);
  expect(blob.includes("abcd-efgh")).toBe(false);
});

test("A3: an unrecognized non-plain-object (RegExp) is redacted conservatively, not leaked or silently emptied", () => {
  const out = redactDetails({ lane: "login", pattern: /secret-value/ });
  // Pre-fix this collapsed to `{}` too (Object.entries(regexp) === []) — same
  // silent-mangle failure mode. Post-fix it is an explicit, labeled marker:
  // never mistaken for "nothing was here," and never a chance to leak
  // whatever internal structure a future opaque type might carry.
  expect(out.pattern).toBe("[REDACTED:non-plain-object]");
  const blob = JSON.stringify(out);
  expect(blob.includes("secret-value")).toBe(false);
});

test("buildAuditRecord carries event/outcome and a trusted-proxy-aware source IP", () => {
  const rec = buildAuditRecord("login.failure", "failure", {
    request: reqWithIp("9.9.9.9"),
    details: { reason: "assertion failed" },
  });
  expect(rec.event).toBe("login.failure");
  expect(rec.outcome).toBe("failure");
  expect(rec.ip).toBe("9.9.9.9");
  expect(typeof rec.ts).toBe("string");
  expect(rec.details).toEqual({ reason: "assertion failed" });
});

test("ip is null when the source is unattributable (no XFF)", () => {
  const rec = buildAuditRecord("session.revoke", "success", {
    request: new Request("https://blog.example.com/api/auth/logout", {
      method: "POST",
    }),
  });
  expect(rec.ip).toBeNull();
});

test("login/failure/revoke lines are emitted with NO secret value in the line (AC)", () => {
  const lines: string[] = [];
  restore = setAuditSink((r) => lines.push(JSON.stringify(r)));

  const SECRET = "JBSWY3DPEHPK3PXP-super-secret";
  recordAuthEvent("login.success", "success", { request: reqWithIp("9.9.9.9") });
  // A careless call site that passes a secret-keyed value must still be redacted.
  recordAuthEvent("login.failure", "failure", {
    request: reqWithIp("9.9.9.9"),
    details: { reason: "bad", totpSecret: SECRET },
  });
  recordAuthEvent("session.revoke", "success", { request: reqWithIp("9.9.9.9") });

  expect(lines.length).toBe(3);
  const events = lines.map((l) => JSON.parse(l).event);
  expect(events).toEqual(["login.success", "login.failure", "session.revoke"]);
  // The secret value appears in NONE of the emitted lines.
  for (const line of lines) {
    expect(line.includes(SECRET)).toBe(false);
  }
  expect(lines[1].includes("[REDACTED]")).toBe(true);
});

test("recordAuthEvent never throws into the caller even if the sink throws", () => {
  restore = setAuditSink(() => {
    throw new Error("sink boom");
  });
  expect(() => recordAuthEvent("setup.complete", "success")).not.toThrow();
});
