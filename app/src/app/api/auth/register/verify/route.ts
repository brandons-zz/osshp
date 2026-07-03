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
  guardMutation,
  isBootstrapAvailable,
  readSessionCookie,
  recordAuthEvent,
  RegistrationForbiddenError,
  registrationLimiter,
  rotateSession,
  sessionCookieHeader,
  validateSession,
  verifyRegistration,
  WebAuthnVerificationError,
} from "@/lib/auth";
import { rateLimitedResponse, readJson } from "../../_shared";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  const bootstrap = await isBootstrapAvailable(db);
  const lane = bootstrap ? "bootstrap" : "register";
  const limiter = bootstrap ? bootstrapLimiter : registrationLimiter;
  const limit = limiter.check(clientKey(lane, request));
  if (!limit.allowed) {
    recordAuthEvent("rate_limit.trip", "failure", { request, details: { lane } });
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
    recordAuthEvent("passkey.enroll", "success", {
      request,
      details: { mode: result.mode },
    });
    if (result.mode === "bootstrap" || result.mode === "reenroll") {
      // bootstrap: no prior session — issue one so the wizard proceeds authed.
      // reenroll: a recovery window let the operator re-establish a passkey;
      // standing access is now legitimately earned by the freshly-verified
      // credential (R6 — access follows the new passkey, not the recovery code).
      const session = await rotateSession(db, oldToken);
      return Response.json(
        { verified: true, mode: result.mode },
        { headers: { "set-cookie": sessionCookieHeader(session) } },
      );
    }
    return Response.json({ verified: true, mode: result.mode });
  } catch (error) {
    if (error instanceof RegistrationForbiddenError) {
      recordAuthEvent("passkey.enroll_failure", "failure", {
        request,
        details: { lane, reason: "forbidden" },
      });
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof WebAuthnVerificationError) {
      recordAuthEvent("passkey.enroll_failure", "failure", {
        request,
        details: { lane, reason: error.message },
      });
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
});
