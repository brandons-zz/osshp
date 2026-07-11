// POST /api/auth/register/verify — finish a passkey enrollment ceremony.
//
// Bootstrap success provisions the admin (closing the single-use wizard, NO-GO
// #1) and issues a fresh session so the operator continues authenticated. Step-up
// appends a credential to the existing admin (already authenticated). Same lane
// gating + rate limiting as the options route.

import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { getDb } from "@/lib/db/client";
import {
  bootstrapLimiter,
  clientKey,
  createSession,
  guardMutation,
  isBootstrapAvailable,
  readSessionCookie,
  recordAuthEvent,
  RegistrationForbiddenError,
  registrationLimiter,
  revokeAllSessions,
  rotateSession,
  sessionCookieHeader,
  validateSession,
  verifyRegistration,
  WebAuthnVerificationError,
  sessionMetadataFromRequest,
} from "@/lib/auth";
import { rateLimitedResponse, readJson } from "../../_shared";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  const bootstrap = await isBootstrapAvailable(db);
  const lane = bootstrap ? "bootstrap" : "register";
  const limiter = bootstrap ? bootstrapLimiter : registrationLimiter;
  const limit = await limiter.check(db, clientKey(lane, request));
  if (!limit.allowed) {
    recordAuthEvent("rate_limit.trip", "failure", { db, request, details: { lane } });
    return rateLimitedResponse(limit);
  }

  const body = await readJson<{
    response?: RegistrationResponseJSON;
    reenrollToken?: string;
  }>(request);
  if (!body?.response) {
    return Response.json({ error: "missing registration response" }, { status: 400 });
  }

  const oldToken = readSessionCookie(request);
  const authenticated = Boolean(await validateSession(db, oldToken));

  try {
    const result = await verifyRegistration(db, {
      authenticated,
      response: body.response,
      reenrollToken: body.reenrollToken,
    });
    recordAuthEvent("passkey.enroll", "success", { db,
      request,
      details: { mode: result.mode },
    });
    if (result.mode === "bootstrap" || result.mode === "reenroll") {
      // bootstrap: no prior session — issue one so the wizard proceeds authed.
      // reenroll: a recovery window let the operator re-establish a passkey;
      // standing access is now legitimately earned by the freshly-verified
      // credential (R6 — access follows the new passkey, not the recovery code).
      const session = await rotateSession(db, oldToken, sessionMetadataFromRequest(request));
      return Response.json(
        { verified: true, mode: result.mode },
        { headers: { "set-cookie": sessionCookieHeader(session) } },
      );
    }
    // step-up (authenticated) enroll. D9 — S4 alignment (intentional behavior
    // change shipped with A1): adding a passkey is a credential change, so revoke
    // ALL sessions and issue a fresh one for the operator — matching the password /
    // TOTP / recovery-code routes and the S4 doctrine in sessions.ts. Previously
    // step-up returned no cookie and revoked nothing (a named drift from S4). The
    // grant for this enroll was already consumed at register/options (§3 #4).
    await revokeAllSessions(db);
    recordAuthEvent("session.revoke_all", "success", { db,
      request,
      details: { reason: "passkey_enroll" },
    });
    const session = await createSession(db, sessionMetadataFromRequest(request));
    return Response.json(
      { verified: true, mode: result.mode },
      { headers: { "set-cookie": sessionCookieHeader(session) } },
    );
  } catch (error) {
    if (error instanceof RegistrationForbiddenError) {
      recordAuthEvent("passkey.enroll_failure", "failure", { db,
        request,
        details: { lane, reason: "forbidden" },
      });
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof WebAuthnVerificationError) {
      recordAuthEvent("passkey.enroll_failure", "failure", { db,
        request,
        details: { lane, reason: error.message },
      });
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
});
