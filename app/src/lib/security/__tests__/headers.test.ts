import { describe, expect, test } from "bun:test";
import {
  buildContentSecurityPolicy,
  generateNonce,
  isNoindexPath,
  securityHeaders,
} from "../headers";

// Intent: the platform's XSS/clickjacking/downgrade backstop (gap-assessment
// A1/A2). These encode the security properties, not the exact string — a
// regression that drops strict-dynamic, leaks unsafe-inline into script-src, or
// loses a header would fail a real control.

describe("CSP nonce (A1) — Edge-safe + unguessable", () => {
  test("each nonce is unique and base64 of 16 bytes", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    // 16 bytes → 24 base64 chars (with padding).
    expect(a.length).toBeGreaterThanOrEqual(22);
    expect(atob(a).length).toBe(16);
  });
});

describe("buildContentSecurityPolicy (A1)", () => {
  const csp = buildContentSecurityPolicy("NONCEVAL");

  test("script-src is nonce + strict-dynamic with NO unsafe-inline", () => {
    expect(csp).toContain("script-src 'self' 'nonce-NONCEVAL' 'strict-dynamic'");
    // The exploitable case: unsafe-inline must never appear on script-src.
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"))!;
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  test("style-src is nonce-based with NO unsafe-inline", () => {
    expect(csp).toContain("style-src 'self' 'nonce-NONCEVAL'");
    const styleSrc = csp.split(";").find((d) => d.trim().startsWith("style-src"))!;
    expect(styleSrc).not.toContain("'unsafe-inline'");
  });

  test("form-action is 'self' and framing is denied (clickjacking)", () => {
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });
});

describe("securityHeaders (A2)", () => {
  test("emits the full header set for a public path", () => {
    const names = securityHeaders("N", "/blog").map((h) => h.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "Content-Security-Policy",
        "X-Frame-Options",
        "X-Content-Type-Options",
        "Referrer-Policy",
        "Permissions-Policy",
        "Strict-Transport-Security",
      ]),
    );
    const byName = new Map(securityHeaders("N", "/blog").map((h) => [h.name, h.value]));
    expect(byName.get("X-Frame-Options")).toBe("DENY");
    expect(byName.get("X-Content-Type-Options")).toBe("nosniff");
    expect(byName.get("Strict-Transport-Security")).toContain("max-age=");
  });

  test("admin/auth paths get noindex; public pages do not", () => {
    expect(isNoindexPath("/admin")).toBe(true);
    expect(isNoindexPath("/admin/blog")).toBe(true);
    expect(isNoindexPath("/setup")).toBe(true);
    expect(isNoindexPath("/login")).toBe(true);
    expect(isNoindexPath("/api/setup")).toBe(true);
    expect(isNoindexPath("/")).toBe(false);
    expect(isNoindexPath("/blog")).toBe(false);
    // a public path that merely starts with the same letters is not noindexed
    expect(isNoindexPath("/administrative-musings")).toBe(false);

    const adminNames = securityHeaders("N", "/admin").map((h) => h.name);
    expect(adminNames).toContain("X-Robots-Tag");
    const publicNames = securityHeaders("N", "/blog").map((h) => h.name);
    expect(publicNames).not.toContain("X-Robots-Tag");
  });
});
