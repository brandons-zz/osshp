// POST /api/auth/stepup/options — begin a step-up passkey-assertion ceremony (A1).
//
// PRIMARY step-up lane, step 1. The operator already holds a valid session; this
// endpoint builds a WebAuthn AUTHENTICATION ceremony (pinned rpID/origin from
// config, userVerification required, per-ceremony single-use challenge) whose
// ceremony id round-trips via its OWN cookie (osshp_stepup_ceremony,
// Path=/api/auth/stepup) so step-up and login ceremonies never cross. A valid
// session is required (401 otherwise). CSRF-guarded; rate-limited (login-class);
// audit-emitting.

import { getDb } from "@/lib/db/client";
import {
  buildAuthenticationOptions,
  clientKey,
  guardMutation,
  recordAuthEvent,
  stepupChallengeCookieHeader,
  stepupLimiter,
  validateSession,
  readSessionCookie,
} from "@/lib/auth";
import { rateLimitedResponse } from "../../_shared";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  // A step-up ceremony is meaningful only for an already-authenticated operator.
  if (!(await validateSession(db, readSessionCookie(request)))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const limit = await stepupLimiter.check(db, clientKey("stepup", request));
  if (!limit.allowed) {
    recordAuthEvent("rate_limit.trip", "failure", { db,
      request,
      details: { lane: "stepup" },
    });
    return rateLimitedResponse(limit);
  }

  // Reuse the per-ceremony auth_login_challenges machinery (issue-075 scoping),
  // but round-trip the ceremony id via the step-up-scoped cookie.
  const { options, ceremonyId } = await buildAuthenticationOptions(db);
  return Response.json(options, {
    headers: { "set-cookie": stepupChallengeCookieHeader(ceremonyId) },
  });
});
