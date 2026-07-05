// Security response headers + nonce-based Content-Security-Policy
// (gap-assessment A1 CSP, A2 header set).
//
// Edge-safe by construction: the only runtime caller is middleware.ts, which is an
// Edge bundle. This module uses ONLY Web Crypto (`crypto.getRandomValues`) and
// `btoa` — never `node:crypto` or `Buffer` — so it never drags a Node builtin into
// the Edge bundle. Pure string/array ops otherwise (Karpathy rule 5, no model).
//
// CSP shape: a per-request nonce + `strict-dynamic` on script-src (the reflected/
// DOM-XSS backstop for the full-takeover admin surface), nonce on style-src so the
// theme's inline brand <style> is the only inline style that runs, and
// `form-action 'self'` (osshp has no OAuth lane, so 'self' is correct and
// complete). No `'unsafe-inline'` on script-src or style-src.

/** Request/response header carrying the per-request CSP nonce. */
export const NONCE_HEADER = "x-nonce";

/** The Content-Security-Policy header name (lower-case, used on req + res). */
export const CSP_HEADER = "content-security-policy";

/**
 * Generate a per-request CSP nonce: base64 of 16 CSPRNG bytes. Edge-safe — uses
 * the Web Crypto global, never `node:crypto`. Unguessable (128 bits) and unique
 * per request.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Build the nonce-based Content-Security-Policy. `script-src` uses
 * nonce + strict-dynamic (no host allowlist, no 'unsafe-inline'); `style-src`
 * uses nonce only (the theme's inline brand <style> carries it). Dynamic colors
 * (e.g. the setup accent swatch) are applied via the CSSOM at runtime, which CSP
 * does not govern, so no `style-src-attr 'unsafe-inline'` is needed.
 */
export function buildContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
  ].join("; ");
}

/** Admin/auth path prefixes whose responses must carry a noindex directive. */
const NOINDEX_PREFIXES = ["/admin", "/setup", "/login", "/api"] as const;

/** True for admin/auth surfaces that must not be indexed (design §9 "admin not indexed"). */
export function isNoindexPath(pathname: string): boolean {
  return NOINDEX_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export interface SecurityHeader {
  name: string;
  value: string;
}

/**
 * The full security-header set for a response (A1 CSP + A2 headers). HSTS is safe
 * by default — Caddy terminates TLS in-stack, so there is no plaintext-loopback
 * exception to make; browsers ignore HSTS over plain http, so it is harmless in
 * dev too. Admin/auth paths additionally get X-Robots-Tag: noindex.
 */
export function securityHeaders(
  nonce: string,
  pathname: string,
): SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { name: "Content-Security-Policy", value: buildContentSecurityPolicy(nonce) },
    { name: "X-Frame-Options", value: "DENY" },
    { name: "X-Content-Type-Options", value: "nosniff" },
    { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      name: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()",
    },
    {
      name: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains",
    },
  ];
  if (isNoindexPath(pathname)) {
    headers.push({ name: "X-Robots-Tag", value: "noindex, nofollow" });
  }
  return headers;
}
