# ADR 0002 — Auth core: first-party sessions + SimpleWebAuthn, uniform Web Crypto

- **Status:** Accepted (M1.6, 2026-06-29)
- **Builds on:** the Phase 0 auth security go/no-go assessment
- **Supersedes nothing.** Gated next by an independent security review (M1.7).

## Context

The admin console is the crown-jewel surface: full takeover means content
publication under the operator's identity, fleet-wide. Auth must be safe-by-default
on an unattended self-host. M1.6 builds the auth CORE — the passkey, session,
bootstrap, default-deny, and rate-limit lanes — with the governing NO-GO gates
holding from the first deploy. Layered recovery (password+TOTP, recovery codes,
CLI break-glass) is M2.

## Decisions

1. **First-party session management, NOT Auth.js** (assessment §4). osshp is
   single-admin with a bespoke factor matrix; Auth.js's provider/account/session
   model fights that shape and would place its experimental passkey provider in
   the crown-jewel path. We own a ≥128-bit CSPRNG session id + HMAC-signed cookie
   token (`<id>.<hmac>`), a server-side revocable record, rotation on auth, and
   expiry.

2. **Uniform Web Crypto (`crypto.subtle`) for all session signing/verification.**
   The same implementation runs in Node route handlers, in bun tests, AND in the
   Edge-runtime middleware — one code path, no node:crypto/Web-Crypto split. This
   is what lets the middleware verify the cookie signature statelessly without
   pulling Node-only crypto into the Edge bundle. `crypto.subtle.verify` is
   constant-time, so the signature compare needs no separate timing-safe step (S1).

3. **Two-layer default-deny.** The middleware choke point is the stateless layer-1
   gate: strip principal headers (H3), normalize the path against a known
   header-spoofing bypass set (H2), deny-by-default unless allowlisted (H1), and
   require a validly-signed session cookie for protected paths. The authoritative
   revocable/expiry check is
   `validateSession()` (DB-backed) in the route handlers (S4/S5). A forged or
   absent cookie is denied at the choke point; a revoked cookie is denied at the
   handler. Edge-safe separation: middleware imports only `access.ts` + the
   session signature verifier; the WebAuthn/Buffer code lives in Node-only modules.

4. **RP-ID / expected-origin pinned from operator config, never from a request**
   (assessment W2, NO-GO #4). `rpConfig()` reads `OSSHP_RP_ID` / `OSSHP_ORIGIN`
   from env only and takes no `Request` argument — an X-Forwarded-Host header has
   no path into the ceremony by construction, closing the same class of
   host-header/bind-host hazard seen in other Node/Next.js deployments.

5. **Single-use setup wizard, fail-closed registration gating** (NO-GO #1/#2).
   `resolveRegistrationMode()` returns `bootstrap` only while no admin exists;
   the instant the admin row is created (guarded by the `admin_user.lock_col`
   UNIQUE), bootstrap is permanently closed and every further enrollment requires
   an authenticated session (step-up) — an unauthenticated re-run throws.

6. **Secure cookies by default** (S2). Caddy terminates TLS in-stack, so there is
   no loopback/plaintext exception needed in production. The default is always
   Secure; an explicit `SESSION_COOKIE_INSECURE=true` exists only for local
   http:// dev.

7. **Single-use challenges + per-lane rate limiting.** WebAuthn challenges are
   stored server-side and consumed once on verify (W1). Every auth lane (passkey
   login, registration, bootstrap) has its own in-memory fixed-window limiter
   (H4, NO-GO #7) — correct for a single-instance self-host.

## Consequences

- The full WebAuthn ceremony verify (attestation/assertion) cannot be unit-tested
  without a real authenticator; M1.6 tests cover the glue (RP-ID source, gating,
  challenge single-use, sessions, default-deny, rate limit). The live ceremony
  and the X-Forwarded-Host / path-normalization HTTP probes are the M1.7
  independent security gate.
- In-memory rate limiting is per-process; horizontal scaling would need a shared
  store, which the single-admin shape does not call for.
