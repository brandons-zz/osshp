// Default-deny middleware choke point (auth-security-assessment H1-H3).
//
// One place, deny-by-default. On EVERY request it:
//  1. Strips client-supplied principal/identity headers (H3) so no caller can
//     inject "I'm authenticated".
//  2. Decides public-vs-protected from the explicit allowlist (H1), after
//     normalizing the path against the classic path-normalization bypass set (H2).
//  3. For a protected path, requires a validly-HMAC-signed session cookie. This
//     is the stateless layer-1 gate (Edge-safe Web Crypto, no DB); the
//     authoritative revocable/expiry check is validateSession() in the route
//     handlers (sessions.ts). A forged or absent cookie is denied here.
//
// Edge-safe: imports only access.ts (pure), verifyTokenSignature (Web Crypto), and
// security/headers (Web Crypto + btoa) — no node:crypto, no Buffer.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decideAccess, stripPrincipalHeaders } from "@/lib/auth/access";
import { SESSION_COOKIE_NAME, verifyTokenSignature } from "@/lib/auth/sessions";
import {
  CSP_HEADER,
  NONCE_HEADER,
  generateNonce,
  securityHeaders,
} from "@/lib/security/headers";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  // H3 — strip principal headers on every inbound path, before any auth logic.
  const cleanedHeaders = stripPrincipalHeaders(request.headers);

  // A1/A2 — per-request CSP nonce + the full security-header set, applied to
  // EVERY response (forward / 401 / redirect). The nonce + CSP are also placed on
  // the FORWARDED request headers so (a) Next.js auto-nonces its own framework
  // <script> tags and (b) the public theme route handlers read the nonce
  // (x-nonce) to nonce the theme's inline brand <style> and no-flash scripts.
  const pathname = request.nextUrl.pathname;
  const nonce = generateNonce();
  const headers = securityHeaders(nonce, pathname);
  const csp = buildHeaderMap(headers).get("Content-Security-Policy") ?? "";
  cleanedHeaders.set(NONCE_HEADER, nonce);
  cleanedHeaders.set(CSP_HEADER, csp);

  const withSecurity = (res: NextResponse): NextResponse => {
    for (const h of headers) res.headers.set(h.name, h.value);
    return res;
  };
  const forward = () =>
    withSecurity(NextResponse.next({ request: { headers: cleanedHeaders } }));

  // H1/H2 — deny-by-default unless allowlisted (path normalized first).
  if (decideAccess(pathname) === "public") {
    return forward();
  }

  // Protected — require a validly-signed session cookie (layer-1 choke point).
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const sessionId = token ? await verifyTokenSignature(token) : null;
  if (sessionId) return forward();

  // Unauthenticated: APIs get 401 JSON; pages redirect to the (M1.8) login page.
  if (pathname.startsWith("/api/")) {
    return withSecurity(
      NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    );
  }
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return withSecurity(NextResponse.redirect(loginUrl));
}

/** Index the security-header list by name (small, used once per request). */
function buildHeaderMap(
  headers: ReadonlyArray<{ name: string; value: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of headers) map.set(h.name, h.value);
  return map;
}

// Run on everything except framework static assets (those are public and hot;
// the allowlist still governs the decision for everything that reaches here).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
