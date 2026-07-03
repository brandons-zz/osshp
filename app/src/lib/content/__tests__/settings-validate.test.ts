// Unit tests for settings-validate.ts — pure module, no I/O or DB required.
//
// Covers three security hardening areas (per security-gate findings):
//   F1 — site.logo src scheme whitelist (reject javascript:/data:)
//   F2 — site.nav/social per-item shape filter (drop malformed items)
//   F3 — site.nav/social href scheme whitelist (reject javascript:)

import { describe, expect, test } from "bun:test";
import {
  isSafeHref,
  isSafeUrl,
  sanitizeSettingValue,
} from "../settings-validate";

// ── Helper unit tests ─────────────────────────────────────────────────────────

describe("isSafeUrl", () => {
  test("accepts a relative path starting /", () => {
    expect(isSafeUrl("/media/logo.png")).toBe(true);
  });
  test("accepts an absolute https URL", () => {
    expect(isSafeUrl("https://cdn.example.com/logo.png")).toBe(true);
  });
  test("accepts an absolute http URL", () => {
    expect(isSafeUrl("http://cdn.example.com/logo.png")).toBe(true);
  });
  test("accepts HTTPS with uppercase scheme (case-insensitive)", () => {
    expect(isSafeUrl("HTTPS://cdn.example.com/logo.png")).toBe(true);
  });
  test("rejects javascript:", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
  });
  test("rejects JavaScript: (mixed case)", () => {
    expect(isSafeUrl("JavaScript:alert(1)")).toBe(false);
  });
  test("rejects data:text/html", () => {
    expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });
  test("rejects blob:", () => {
    expect(isSafeUrl("blob:https://example.com/some-uuid")).toBe(false);
  });
});

describe("isSafeHref", () => {
  test("accepts a relative path starting /", () => {
    expect(isSafeHref("/about")).toBe(true);
  });
  test("accepts an in-page fragment starting #", () => {
    expect(isSafeHref("#section")).toBe(true);
  });
  test("accepts an absolute https URL", () => {
    expect(isSafeHref("https://example.com")).toBe(true);
  });
  test("accepts an absolute http URL", () => {
    expect(isSafeHref("http://example.com")).toBe(true);
  });
  test("accepts mailto:", () => {
    expect(isSafeHref("mailto:x@y.z")).toBe(true);
  });
  test("accepts MAILTO: (case-insensitive)", () => {
    expect(isSafeHref("MAILTO:x@y.z")).toBe(true);
  });
  test("rejects javascript:", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
  });
  test("rejects JavaScript: (mixed case)", () => {
    expect(isSafeHref("JavaScript:alert(1)")).toBe(false);
  });
  test("rejects data:", () => {
    expect(isSafeHref("data:text/html,x")).toBe(false);
  });
  test("rejects vbscript:", () => {
    expect(isSafeHref("vbscript:MsgBox(1)")).toBe(false);
  });
});

// ── Finding 1: site.logo src scheme whitelist ─────────────────────────────────

describe("sanitizeSettingValue site.logo — F1 src scheme whitelist", () => {
  test("javascript: src is rejected — value is null", () => {
    const result = sanitizeSettingValue("site.logo", {
      src: "javascript:alert(1)",
      alt: "x",
    });
    expect(result).toEqual({ value: null });
  });

  test("data:text/html src is rejected — value is null", () => {
    const result = sanitizeSettingValue("site.logo", {
      src: "data:text/html,x",
      alt: "x",
    });
    expect(result).toEqual({ value: null });
  });

  test("relative /media/logo.png src is preserved", () => {
    const result = sanitizeSettingValue("site.logo", {
      src: "/media/logo.png",
      alt: "My logo",
    });
    expect(result).toEqual({ value: { src: "/media/logo.png", alt: "My logo" } });
  });

  test("https CDN src is preserved", () => {
    const result = sanitizeSettingValue("site.logo", {
      src: "https://cdn.example/l.png",
      alt: "CDN logo",
    });
    expect(result).toEqual({ value: { src: "https://cdn.example/l.png", alt: "CDN logo" } });
  });

  test("null raw value is accepted (clears logo)", () => {
    expect(sanitizeSettingValue("site.logo", null)).toEqual({ value: null });
  });

  test("missing src field → null (not a crash)", () => {
    expect(sanitizeSettingValue("site.logo", { alt: "x" })).toEqual({
      value: null,
    });
  });

  test("empty src string → null (was already rejected pre-hardening)", () => {
    expect(sanitizeSettingValue("site.logo", { src: "", alt: "x" })).toEqual({
      value: null,
    });
  });
});

// ── Finding 2: nav/social per-item shape filter ───────────────────────────────

describe("sanitizeSettingValue site.nav — F2 per-item shape filter", () => {
  test("null, number, and missing-label items are dropped; valid item is kept", () => {
    const result = sanitizeSettingValue("site.nav", [
      null,
      42,
      { label: "OK", href: "/ok" },
      { href: "/no-label" }, // missing label
    ]);
    expect(result).toEqual({ value: [{ label: "OK", href: "/ok" }] });
  });

  test("non-array raw value → empty array (graceful)", () => {
    expect(sanitizeSettingValue("site.nav", "bad")).toEqual({ value: [] });
  });

  test("an item that is itself an array is dropped", () => {
    const result = sanitizeSettingValue("site.nav", [
      ["label", "/href"],
      { label: "Valid", href: "/valid" },
    ]);
    expect(result).toEqual({ value: [{ label: "Valid", href: "/valid" }] });
  });

  test("an item with numeric label is dropped", () => {
    const result = sanitizeSettingValue("site.nav", [
      { label: 42, href: "/ok" },
      { label: "Real", href: "/ok" },
    ]);
    expect(result).toEqual({ value: [{ label: "Real", href: "/ok" }] });
  });

  test("issue 020 — a corresponding shape filter applies to site.social, keyed on `network` (the real client-emitted field), not `label`", () => {
    // Real client shape: SocialItem in SettingsForm.tsx / SiteIdentity["social"]
    // in theme/types.ts both key on `network`, never `label`. A fixture using
    // `{label, href}` here would encode the bug (settings-validate.ts issue
    // 020), not the intended contract — see security-review NB-5 and QA gate
    // V-011 for the defect this test guards against.
    const result = sanitizeSettingValue("site.social", [
      null,
      { network: "GitHub", href: "https://github.com/owner" },
      { network: 123, href: "/bad-network" }, // network must be a string
      { href: "/no-network" }, // missing network entirely
    ]);
    expect(result).toEqual({
      value: [{ network: "GitHub", href: "https://github.com/owner" }],
    });
  });
});

// ── Finding 3: nav/social href scheme whitelist ───────────────────────────────

describe("sanitizeSettingValue site.nav — F3 href scheme whitelist", () => {
  test("javascript: href is dropped", () => {
    const result = sanitizeSettingValue("site.nav", [
      { label: "Evil", href: "javascript:alert(1)" },
    ]);
    expect(result).toEqual({ value: [] });
  });

  test("mailto: href is kept", () => {
    const result = sanitizeSettingValue("site.nav", [
      { label: "Mail", href: "mailto:x@y.z" },
    ]);
    expect(result).toEqual({ value: [{ label: "Mail", href: "mailto:x@y.z" }] });
  });

  test("relative / href is kept", () => {
    const result = sanitizeSettingValue("site.nav", [
      { label: "Home", href: "/" },
    ]);
    expect(result).toEqual({ value: [{ label: "Home", href: "/" }] });
  });

  test("JavaScript: (mixed case) href is dropped", () => {
    const result = sanitizeSettingValue("site.nav", [
      { label: "Evil", href: "JavaScript:alert(1)" },
    ]);
    expect(result).toEqual({ value: [] });
  });

  test("# in-page fragment href is kept", () => {
    const result = sanitizeSettingValue("site.nav", [
      { label: "Jump", href: "#section" },
    ]);
    expect(result).toEqual({ value: [{ label: "Jump", href: "#section" }] });
  });

  test("https href is kept", () => {
    const result = sanitizeSettingValue("site.nav", [
      { label: "External", href: "https://example.com" },
    ]);
    expect(result).toEqual({
      value: [{ label: "External", href: "https://example.com" }],
    });
  });

  test("data: href is dropped", () => {
    const result = sanitizeSettingValue("site.nav", [
      { label: "Data", href: "data:text/html,<script>xss</script>" },
    ]);
    expect(result).toEqual({ value: [] });
  });

  test("issue 020 — the same href whitelist applies to site.social, using the real {network,href} shape", () => {
    const result = sanitizeSettingValue("site.social", [
      { network: "Bad", href: "javascript:void(0)" },
      { network: "Twitter", href: "https://x.com/owner" },
    ]);
    expect(result).toEqual({
      value: [{ network: "Twitter", href: "https://x.com/owner" }],
    });
  });
});

// ── Regression: previously-valid paths still pass ────────────────────────────

describe("regression — valid values still round-trip unchanged", () => {
  test("a fully-valid nav array round-trips", () => {
    const nav = [
      { label: "Home", href: "/" },
      { label: "Blog", href: "/blog" },
      { label: "Contact", href: "mailto:hi@example.com" },
      { label: "GitHub", href: "https://github.com/owner" },
    ];
    const result = sanitizeSettingValue("site.nav", nav);
    expect(result).toEqual({ value: nav });
  });

  test("issue 020 — a fully-valid social array (real {network,href} shape) round-trips", () => {
    const social = [
      { network: "Twitter", href: "https://x.com/owner" },
      { network: "Mastodon", href: "https://mastodon.social/@owner" },
    ];
    const result = sanitizeSettingValue("site.social", social);
    expect(result).toEqual({ value: social });
  });

  test("existing behavior: accent/font/scheme/title untouched by logo+nav changes", () => {
    expect(sanitizeSettingValue("site.title", "My Site")).toEqual({
      value: "My Site",
    });
    expect(sanitizeSettingValue("branding.defaultScheme", "dark")).toEqual({
      value: "dark",
    });
    expect(sanitizeSettingValue("branding.fontHeading", null)).toEqual({
      value: null,
    });
  });

  test("issue 012 — home.intro is a writable string setting (coerces non-strings to '')", () => {
    expect(sanitizeSettingValue("home.intro", "I write about self-hosting.")).toEqual({
      value: "I write about self-hosting.",
    });
    // Non-string input coerces to an empty string (never errors, never null).
    expect(sanitizeSettingValue("home.intro", 42)).toEqual({ value: "" });
  });
});
