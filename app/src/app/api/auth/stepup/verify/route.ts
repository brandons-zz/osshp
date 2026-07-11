// POST /api/auth/stepup/verify — finish a step-up passkey assertion, mint a grant (A1).
//
// PRIMARY step-up lane, step 2. Verifies the assertion via the existing
// verifyAuthentication (single-use challenge consumption, pinned origin/rpID,
// userVerification required, counter persistence). On success it mints ONE
// step-up grant bound to the CURRENT session id and returns the plaintext EXACTLY
// ONCE (the only place the plaintext ever appears). No session rotation (§6.2):
// step-up confers no new authority on the cookie — all new authority lives in the
// grant, which is already single-use and session-bound. A valid session is
// required (401). CSRF-guarded; rate-limited; audit-emitting (never the token).

import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { getDb } from "@/lib/db/client";
import {
  clearedStepupChallengeCookieHeader,
  clientKey,
  guardMutation,
  issueStepUpGrant,
  readSessionCookie,
  readStepupChallengeCookie,
  recordAuthEvent,
  stepupLimiter,
  validateSession,
  verifyAuthentication,
  WebAuthnVerificationError,
} from "@/lib/auth";
import { rateLimitedResponse, readJson } from "../../_shared";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  const session = await validateSession(db, readSessionCookie(request));
  if (!session) {
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

  const body = await readJson<{ response?: AuthenticationResponseJSON }>(request);
  if (!body?.response) {
    return Response.json({ error: "missing authentication response" }, { status: 400 });
  }

  const ceremonyId = readStepupChallengeCookie(request);
  try {
    await verifyAuthentication(db, { response: body.response, ceremonyId });
  } catch (error) {
    if (error instanceof WebAuthnVerificationError) {
      // Bad / absent / replayed assertion → mint NOTHING, generic error.
      recordAuthEvent("stepup.failure", "failure", { db,
        request,
        details: { lane: "stepup", reason: error.message },
      });
      return Response.json(
        { error: error.message },
        { status: 400, headers: { "set-cookie": clearedStepupChallengeCookieHeader() } },
      );
    }
    throw error;
  }

  // Fresh presence proven → mint exactly one grant for THIS session.
  const { grant, expiresAt } = await issueStepUpGrant(db, session.id, "passkey");
  recordAuthEvent("stepup.grant", "success", { db,
    request,
    details: { factor: "passkey" },
  });
  return Response.json(
    { ok: true, grant, expiresAt: expiresAt.toISOString() },
    { headers: { "set-cookie": clearedStepupChallengeCookieHeader() } },
  );
});
