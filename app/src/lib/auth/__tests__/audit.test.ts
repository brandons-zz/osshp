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
