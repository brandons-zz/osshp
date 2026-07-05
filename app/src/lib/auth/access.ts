// Default-deny access decision + inbound-header hygiene (auth-security-assessment H1-H3).
//
// This is the pure, testable core of the middleware choke point:
//  - normalizePath() defeats the classic path-normalization bypass set (//, %2F,
//    case, trailing dot, matrix params) BEFORE matching (H2).
//  - decideAccess() is DENY-BY-DEFAULT: a path is "protected" unless it matches
//    the explicit public allowlist. A new route is private until it is added to
//    the allowlist — never the reverse (H1).
//  - stripPrincipalHeaders() removes any client-supplied identity/principal
//    header so a caller can never inject "I am already authenticated" (H3).
//
// Edge-safe (no Node APIs) — imported directly by src/middleware.ts.

// Identity/principal headers a client must never be trusted to set. Stripped on
// EVERY inbound request before any auth logic runs (H3).
export const PRINCIPAL_HEADERS: readonly string[] = [
  "x-osshp-principal",
  "x-osshp-user",
  "x-osshp-admin",
  "x-internal-principal",
  "x-authenticated-user",
  "x-user",
  "x-user-id",
  "x-forwarded-user",
  "x-remote-user",
  "remote-user",
];

/** Return a copy of `headers` with all principal headers removed (H3). */
export function stripPrincipalHeaders(headers: Headers): Headers {
  const cleaned = new Headers(headers);
  for (const name of PRINCIPAL_HEADERS) cleaned.delete(name);
  return cleaned;
}

/**
 * Normalize a request path into a canonical form for allowlist matching, closing
 * the classic path-normalization bypass set (H2):
 *  - strip query/fragment
 *  - percent-decode once (so %2F / %2e cannot smuggle a separator past the match)
 *  - drop matrix params (`;…`) per segment
 *  - collapse repeated slashes
 *  - lowercase (case-variation bypass)
 *  - strip trailing dots per segment (trailing-dot bypass)
 *  - drop a trailing slash (except root)
 */
export function normalizePath(rawPath: string): string {
  let path = rawPath.split("?")[0].split("#")[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // Malformed encoding → leave as-is; it will fail the allowlist and be denied.
  }
  path = path.replace(/\\/g, "/"); // backslash → slash

  // Resolve segments — crucially, "." and ".." are resolved as path navigation
  // (so /posts/../admin canonicalizes to /admin and cannot masquerade as public)
  // BEFORE trailing-dot stripping, which would otherwise eat a ".." segment.
  const out: string[] = [];
  for (let seg of path.split("/")) {
    seg = seg.split(";")[0]; // drop matrix params
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    seg = seg.replace(/\.+$/, ""); // trailing-dot bypass (Windows-style)
    if (seg === "") continue;
    out.push(seg);
  }

  const normalized = "/" + out.join("/");
  return normalized === "/" ? "/" : normalized.toLowerCase();
}

// ── Public allowlist (deny-by-default everything not listed here) ────────────
// Anything not matched is PROTECTED. M1.8 (public site/admin shell) and future
// modules extend these lists explicitly — that explicit-add step is the H1
// contract, not an oversight.

const PUBLIC_EXACT: ReadonlySet<string> = new Set([
  "/",
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
  "/rss.xml",
  "/feed.xml",
  "/manifest.webmanifest",
  "/api/health",
  // First-run + login surfaces — an unauthenticated operator must reach these to
  // provision the admin and to sign in (M1.8). Explicit-add is the H1 contract.
  //
  // SECURITY NOTE (/setup, OWASP A05, 2026-06-29): /setup MUST remain on this
  // allowlist to preserve the bootstrap flow — on a fresh install an unauthenticated
  // operator follows the root (/) redirect here and has no session yet. Removing it
  // from PUBLIC_EXACT would block that path. Instead, the security guarantee is
  // enforced at the page layer: src/app/setup/page.tsx calls notFound() when
  // isBootstrapAvailable(db) is false OR site.setupComplete is true, so post-config
  // requests get a 404 regardless of whether they reach the handler.
  "/setup",
  "/login",
  // The Blog module's public post-list page (its post pages are the /blog/ prefix).
  // NOTE: /login/recovery (the fallback auth page) is covered by the /login/ prefix
  // in PUBLIC_PREFIXES below.
  "/blog",
  // The Photos module's public lightbox gallery grid.
  "/photos",
]);

const PUBLIC_PREFIXES: readonly string[] = [
  "/_next/", // framework assets
  "/static/",
  "/assets/",
  "/structural.css", // app-owned Layer-1 stylesheet, served statically
  "/shiki.css", // Shiki syntax-highlight CSS — public, served from 'self' (V-013)
  "/themes/", // theme token stylesheets (served statically)
  "/vendor/", // vendored third-party public assets (e.g. the GLightbox lib)
  "/api/auth/", // the auth endpoints themselves must be reachable unauthenticated
  // Login sub-pages (recovery/fallback login — /login/recovery). Unauthenticated
  // operators must reach these to regain access after a lost passkey (H1 / R6).
  "/login/",
  // Public CONTENT surfaces (the theme-rendered site). M1.8 wires these routes;
  // listing the prefixes here is the explicit allowlist entry for "the public
  // site" (H1 names it as an allowlisted category).
  "/blog/",
  "/posts/",
  "/pages/",
  "/tags/",
  "/media/",
  // The Photos module's individual photo-item pages (issue 004). The exact
  // "/photos" path (the lightbox grid) is in PUBLIC_EXACT above; this prefix
  // covers /photos/<slug> single-item pages.
  "/photos/",
];

export type AccessDecision = "public" | "protected";

/** True iff the (normalized) path is on the public allowlist. */
export function isPublicPath(rawPath: string): boolean {
  const path = normalizePath(rawPath);
  if (PUBLIC_EXACT.has(path)) return true;
  return PUBLIC_PREFIXES.some(
    (prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix),
  );
}

/**
 * Deny-by-default decision: every path is "protected" (requires authentication)
 * unless explicitly allowlisted as public. This is the choke-point rule (H1).
 */
export function decideAccess(rawPath: string): AccessDecision {
  return isPublicPath(rawPath) ? "public" : "protected";
}
