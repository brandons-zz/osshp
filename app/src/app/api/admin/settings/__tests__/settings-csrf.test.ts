// Settings API: CSRF guard, auth guard, and write-validation unit tests.
//
// CSRF and auth tests follow the same pattern as authoring-csrf.test.ts:
//   • Cross-site PATCH → rejected by guardMutation (403) before the handler runs.
//   • Same-origin PATCH with no session cookie → reaches the handler, which
//     calls getSessionFromRequest. validateSession(db, null) returns null
//     immediately without a DB query (sessions.ts line 132: if (!token) return null),
//     so no real database connection is required for the auth-rejection test.
//
// Validation tests exercise sanitizeSettingValue as a pure unit (no DB, no HTTP).

process.env.OSSHP_ORIGIN = "https://osshp.example.com";
// DATABASE_URL is required by getDb() (the postgres.js pool is lazy — it does
// not connect until a query is issued, and the auth-rejection test never issues
// one because the null-token path short-circuits before any db.query() call).
process.env.DATABASE_URL = "postgres://localhost/osshp_test_placeholder";
process.env.SESSION_SECRET = "test-session-secret-do-not-use-in-prod";

import { describe, expect, test } from "bun:test";
import { sanitizeSettingValue } from "@/lib/content/settings-validate";

// ── Helper request factories ─────────────────────────────────────────────────

function crossSite(body: unknown = {}): Request {
  return new Request("https://osshp.example.com/api/admin/settings", {
    method: "PATCH",
    headers: {
      origin: "https://evil.example.com",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function sameSite(body: unknown = {}): Request {
  return new Request("https://osshp.example.com/api/admin/settings", {
    method: "PATCH",
    headers: {
      origin: "https://osshp.example.com",
      "content-type": "application/json",
    },
    // No Cookie header → no session token.
    body: JSON.stringify(body),
  });
}

// ── CSRF guard ───────────────────────────────────────────────────────────────

test("PATCH rejects a cross-site request with 403 + no-store", async () => {
  const { PATCH } = (await import("@/app/api/admin/settings/route")) as {
    PATCH: (r: Request) => Promise<Response>;
  };
  const res = await PATCH(crossSite({ "site.title": "Injected" }));
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

// ── Auth guard ───────────────────────────────────────────────────────────────
//
// No Cookie header → readSessionCookie returns undefined → validateSession(db, undefined)
// returns null immediately (no DB query needed) → handler returns 401.

test("PATCH rejects a same-origin request with no session with 401", async () => {
  const { PATCH } = (await import("@/app/api/admin/settings/route")) as {
    PATCH: (r: Request) => Promise<Response>;
  };
  const res = await PATCH(sameSite({ "site.title": "Test" }));
  expect(res.status).toBe(401);
  // guardMutation always stamps no-store on responses it passes through.
  expect(res.headers.get("cache-control")).toBe("no-store");
});

// ── Write validation: admin-only key rejection ────────────────────────────────

describe("sanitizeSettingValue — admin-only key rejection", () => {
  test("site.activeTheme is not writable (absent from allowlist)", () => {
    const result = sanitizeSettingValue("site.activeTheme", "evil");
    expect(result.error).toMatch(/non-editable/);
  });

  test("site.enabledModules is not writable", () => {
    const result = sanitizeSettingValue("site.enabledModules", []);
    expect(result.error).toMatch(/non-editable/);
  });

  test("secrets.smtp is not writable", () => {
    const result = sanitizeSettingValue("secrets.smtp", { host: "x" });
    expect(result.error).toMatch(/non-editable/);
  });
});

// ── Write validation: accent clamping ────────────────────────────────────────
//
// A malformed/injected accent must be clamped to the safe fallback (#2563eb)
// — never persisted verbatim — so the inline <style> never receives injection.

describe("sanitizeSettingValue — accent clamping (A03-G1 emission boundary)", () => {
  test("CSS-injection attempt is clamped to the fallback accent", () => {
    const result = sanitizeSettingValue("branding.accent", "red;}@import url(//evil)");
    expect(result.error).toBeUndefined();
    // Must be a valid hex — never the injected string.
    expect(result.value).toBe("#2563eb");
    expect(String(result.value)).not.toContain("@import");
    expect(String(result.value)).not.toContain(";");
  });

  test("a valid 6-char hex is accepted unchanged (with leading #)", () => {
    const result = sanitizeSettingValue("branding.accent", "#FF6600");
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("#FF6600");
  });

  test("a valid 3-char hex is accepted (normalized with leading #)", () => {
    const result = sanitizeSettingValue("branding.accent", "#F60");
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("#F60");
  });

  test("null accent is clamped to the fallback", () => {
    const result = sanitizeSettingValue("branding.accent", null);
    expect(result.value).toBe("#2563eb");
  });
});

// ── Write validation: font clamping ──────────────────────────────────────────

describe("sanitizeSettingValue — font family clamping", () => {
  test("an injected font string is clamped to null (system stack used)", () => {
    const result = sanitizeSettingValue("branding.fontHeading", 'x;}@import url(//evil)');
    expect(result.error).toBeUndefined();
    expect(result.value).toBeNull();
  });

  test("null font is accepted as-is (clears the override)", () => {
    const result = sanitizeSettingValue("branding.fontBody", null);
    expect(result.value).toBeNull();
  });

  test("a safe font family string is accepted unchanged", () => {
    const result = sanitizeSettingValue("branding.fontHeading", "Georgia, serif");
    expect(result.value).toBe("Georgia, serif");
  });
});

// ── Write validation: other fields ───────────────────────────────────────────

describe("sanitizeSettingValue — other identity fields", () => {
  test("site.title accepts a string", () => {
    const result = sanitizeSettingValue("site.title", "My Site");
    expect(result.value).toBe("My Site");
  });

  test("site.nav coerces non-array to []", () => {
    const result = sanitizeSettingValue("site.nav", "not-an-array");
    expect(result.value).toStrictEqual([]);
  });

  test("site.logo accepts a valid { src, alt } object", () => {
    const result = sanitizeSettingValue("site.logo", { src: "/logo.png", alt: "Logo" });
    expect(result.value).toStrictEqual({ src: "/logo.png", alt: "Logo" });
  });

  test("site.logo coerces an empty src to null", () => {
    const result = sanitizeSettingValue("site.logo", { src: "", alt: "Logo" });
    expect(result.value).toBeNull();
  });

  test("site.logo coerces null to null", () => {
    const result = sanitizeSettingValue("site.logo", null);
    expect(result.value).toBeNull();
  });

  test("branding.defaultScheme accepts light/dark/auto", () => {
    expect(sanitizeSettingValue("branding.defaultScheme", "light").value).toBe("light");
    expect(sanitizeSettingValue("branding.defaultScheme", "dark").value).toBe("dark");
    expect(sanitizeSettingValue("branding.defaultScheme", "auto").value).toBe("auto");
  });

  test("branding.defaultScheme coerces invalid value to 'auto'", () => {
    expect(sanitizeSettingValue("branding.defaultScheme", "invalid").value).toBe("auto");
  });
});
