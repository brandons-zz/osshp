// Validation and sanitization of incoming settings values before persistence.
//
// Extracted from the API route because Next.js prohibits named exports from a
// route.ts that aren't HTTP method handlers or Next.js config exports. Keeping
// this as a pure module also makes it testable without any HTTP machinery.
//
// All validation is intentionally pure (no I/O) so it can be exercised by unit
// tests without a database or request context.

import { sanitizeAccent, sanitizeFontFamily } from "@/lib/theme/brand";

// ── URL safety helpers ────────────────────────────────────────────────────────
//
// These helpers enforce a strict scheme whitelist at the persistence boundary
// so that no dangerous URL ever reaches the database or the rendered page.

/**
 * Returns true when `url` is safe for use as an image src attribute:
 * a relative path starting with `/`, or an absolute http/https URL.
 *
 * Scheme comparison is case-insensitive so `HTTPS://…` and `JavaScript:…`
 * are handled correctly. `data:`, `blob:`, and `javascript:` variants are
 * all rejected by construction — they do not appear in the whitelist.
 */
export function isSafeUrl(url: string): boolean {
  if (url.startsWith("/")) return true;
  const lower = url.toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://");
}

/**
 * Returns true when `href` is safe for use as a nav/social link href:
 * - relative path starting `/`
 * - in-page fragment starting `#`
 * - absolute http/https URL
 * - mailto: link
 *
 * `javascript:`, `data:`, `vbscript:`, and any other scheme are rejected.
 */
export function isSafeHref(href: string): boolean {
  if (href.startsWith("/") || href.startsWith("#")) return true;
  const lower = href.toLowerCase();
  return (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:")
  );
}

// ── Writable key allowlist ────────────────────────────────────────────────────
//
// Explicit allowlist of the identity/branding keys an operator may write from
// the admin console. Any key absent from this set is rejected with a descriptive
// error before any write occurs. Admin-only keys (site.activeTheme,
// site.enabledModules) and secret keys (secrets.smtp) are intentionally absent —
// they cannot be reached through this path by construction, not by a blocklist.

export const SETTINGS_WRITABLE_KEYS: ReadonlySet<string> = new Set([
  "site.title",
  "site.description",
  "home.intro",
  "site.locale",
  "site.nav",
  "site.social",
  "site.logo",
  "branding.accent",
  "branding.fontHeading",
  "branding.fontBody",
  "branding.defaultScheme",
]);

/** Visibility for every writable key (all are public identity/branding settings). */
export const SETTINGS_WRITABLE_VISIBILITY = "public" as const;

export type SanitizeResult =
  | { value: unknown; error?: undefined }
  | { value?: undefined; error: string };

/**
 * Validate and sanitize one setting value before persistence.
 *
 * - On success: `{ value }` where `value` is sanitized (possibly clamped).
 * - On failure: `{ error }` — caller returns 400.
 *
 * `branding.accent` and `branding.fontHeading/fontBody` clamp rather than reject:
 * a malformed/injected value falls back to the safe default so that a single bad
 * branding setting cannot 500 the live site (AA-guardrail design, brand.ts A03-G1).
 */
export function sanitizeSettingValue(key: string, raw: unknown): SanitizeResult {
  switch (key) {
    case "site.title":
    case "site.description":
    case "home.intro":
    case "site.locale":
      return { value: typeof raw === "string" ? raw : "" };

    case "branding.accent":
      // sanitizeAccent (brand.ts, A03-G1 emission boundary) clamps any
      // malformed / CSS-injected value to FALLBACK_ACCENT (#2563eb). A
      // string like "red;}@import url(//evil)" is rejected and falls back.
      return {
        value: sanitizeAccent(typeof raw === "string" ? raw : null),
      };

    case "branding.fontHeading":
    case "branding.fontBody":
      // null / undefined → clear the override (system stack is used at render).
      // An invalid/injected string → sanitizeFontFamily returns null (same
      // result: system stack). Never persists a value that could break out of
      // the inline <style> declaration.
      if (raw === null || raw === undefined) return { value: null };
      return {
        value: sanitizeFontFamily(typeof raw === "string" ? raw : null),
      };

    case "branding.defaultScheme":
      return {
        value:
          raw === "light" || raw === "dark" || raw === "auto" ? raw : "auto",
      };

    case "site.nav": {
      // Keep only well-formed items — objects with string `label` AND string
      // `href` — AND only when `href` uses a safe URL scheme.  Anything else
      // (null, a number, an object missing a field, a javascript: href) is
      // silently dropped so a malformed item can never crash the theme's
      // `.map(item => <a href={item.href}>)` or inject a visitor-facing XSS.
      const items = Array.isArray(raw) ? raw : [];
      const safe = items.filter(
        (item): item is { label: string; href: string } =>
          typeof item === "object" &&
          item !== null &&
          !Array.isArray(item) &&
          typeof (item as Record<string, unknown>).label === "string" &&
          typeof (item as Record<string, unknown>).href === "string" &&
          isSafeHref((item as Record<string, unknown>).href as string),
      );
      return { value: safe };
    }

    case "site.social": {
      // Social items carry `network` (not `label` — see SocialItem in
      // SettingsForm.tsx and buildSiteIdentity() in theme/context.ts, which
      // both key on `network`). Keep only well-formed items — objects with
      // string `network` AND string `href` — AND only when `href` uses a safe
      // URL scheme. Anything else (null, a number, an object missing a field,
      // a javascript: href) is silently dropped so a malformed item can never
      // crash the theme's `.map(item => <a href={item.href}>)` or inject a
      // visitor-facing XSS.
      const items = Array.isArray(raw) ? raw : [];
      const safe = items.filter(
        (item): item is { network: string; href: string } =>
          typeof item === "object" &&
          item !== null &&
          !Array.isArray(item) &&
          typeof (item as Record<string, unknown>).network === "string" &&
          typeof (item as Record<string, unknown>).href === "string" &&
          isSafeHref((item as Record<string, unknown>).href as string),
      );
      return { value: safe };
    }

    case "site.logo": {
      if (raw === null || raw === undefined) return { value: null };
      if (
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        "src" in raw &&
        "alt" in raw
      ) {
        const { src, alt } = raw as { src: unknown; alt: unknown };
        if (
          typeof src === "string" &&
          typeof alt === "string" &&
          src !== "" &&
          isSafeUrl(src)
        ) {
          return { value: { src, alt } };
        }
      }
      // Null out the logo rather than persisting a dangerous src value.
      return { value: null };
    }

    default:
      return { error: `unknown or non-editable setting key: ${key}` };
  }
}
