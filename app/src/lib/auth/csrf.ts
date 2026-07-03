// Same-origin CSRF guard for state-changing requests (gap-assessment A3).
//
// Defense model: HOST-COMPARISON, not a fixed allowlist. A mutating request must
// carry an Origin (or, as a fallback, a Referer) header whose origin matches the
// operator-pinned config.origin (OSSHP_ORIGIN). config.origin is the SAME pinned
// value the WebAuthn ceremony trusts — it is never derived from a client Host /
// X-Forwarded-Host header, which is what makes this Caddy/tunnel-safe: behind a
// reverse proxy the operator sets OSSHP_ORIGIN to the public origin once, and the
// check holds regardless of the internal Host the proxy forwards.
//
// Browsers attach Origin to every cross-origin request and to same-origin
// state-changing requests, so a forged cross-site POST either omits Origin (no
// scripted same-origin context) or sends a foreign origin — both fail-closed.
// Safe methods (GET/HEAD/OPTIONS) are never blocked.
//
// Edge-safe: pure header/URL string ops, no node:crypto, no Buffer. (Not imported
// by the middleware today — each mutating route consumes guardMutation — but kept
// Edge-safe so it could be hoisted into middleware without bundle regression.)

import { config } from "@/lib/config";

/** HTTP methods that change server state and therefore require the CSRF check. */
const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** True for state-changing methods (POST/PUT/PATCH/DELETE). */
export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/** Parse the origin (scheme://host[:port]) from a URL string; null if unparseable. */
function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Decide whether a request passes the same-origin CSRF check. Safe methods always
 * pass. For a mutating method, the request's Origin (or Referer fallback) origin
 * MUST equal `expectedOrigin`; a missing/unparseable header fails closed.
 */
export function isSameOrigin(request: Request, expectedOrigin: string): boolean {
  if (!isMutatingMethod(request.method)) return true;
  const expected = originOf(expectedOrigin);
  if (expected === null) return false; // misconfigured origin → fail closed
  const candidate =
    request.headers.get("origin") ?? request.headers.get("referer");
  const actual = originOf(candidate);
  if (actual === null) return false; // no usable Origin/Referer → fail closed
  return actual === expected;
}

/** Set `Cache-Control: no-store` on a response (mutating responses must not cache). */
export function withNoStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

type RouteHandler = (request: Request) => Promise<Response>;

/**
 * Wrap a mutating route handler with the same-origin CSRF guard. A cross-site (or
 * header-less) mutating request is rejected with 403 BEFORE the handler runs; an
 * allowed request runs the handler and the response is stamped Cache-Control:
 * no-store. The session cookie's SameSite=Lax attribute is unchanged (set in
 * sessions.ts) — this guard is an independent, complementary layer.
 *
 * Every new mutating route (recovery lanes, authoring, media, modules) consumes
 * this primitive so it is born CSRF-compliant rather than retrofitted.
 */
export function guardMutation(handler: RouteHandler): RouteHandler {
  return async (request: Request): Promise<Response> => {
    if (!isSameOrigin(request, config.origin)) {
      return withNoStore(
        Response.json({ error: "csrf_failed" }, { status: 403 }),
      );
    }
    return withNoStore(await handler(request));
  };
}
