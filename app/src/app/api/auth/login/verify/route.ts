// POST /api/auth/login/verify — finish a passkey authentication ceremony.
//
// On success, rotates the session (S3 — fresh id post-auth, fixation defense) and
// sets a Secure-by-default cookie. Rate-limited (NO-GO #7).
//
// issue 075: the login-ceremony cookie set by /login/options scopes which
// challenge THIS caller may consume — verifyAuthentication rejects a stale,
// missing, or foreign ceremonyId regardless of what any other concurrent
// caller did to their own row.

import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { getDb } from "@/lib/db/client";
import {
  clearedLoginChallengeCookieHeader,
  clientKey,
  guardMutation,
  loginLimiter,
  readLoginChallengeCookie,
  readSessionCookie,
  recordAuthEvent,
  rotateSession,
  sessionCookieHeader,
  verifyAuthentication,
  WebAuthnVerificationError,
  sessionMetadataFromRequest,
} from "@/lib/auth";
import { rateLimitedResponse, readJson } from "../../_shared";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  const limit = await loginLimiter.check(db, clientKey("login", request));
  if (!limit.allowed) {
    recordAuthEvent("rate_limit.trip", "failure", { db,
      request,
      details: { lane: "login" },
    });
    return rateLimitedResponse(limit);
  }

  const body = await readJson<{ response?: AuthenticationResponseJSON }>(request);
  if (!body?.response) {
    return Response.json({ error: "missing authentication response" }, { status: 400 });
  }

  const oldToken = readSessionCookie(request);
  const ceremonyId = readLoginChallengeCookie(request);
  try {
    await verifyAuthentication(db, { response: body.response, ceremonyId });
    const session = await rotateSession(db, oldToken, sessionMetadataFromRequest(request)); // S3
    recordAuthEvent("login.success", "success", { db, request });
    const headers = new Headers();
    headers.append("set-cookie", sessionCookieHeader(session));
    // Hygiene, not a security boundary: the single-use row is already gone —
    // this just stops a spent ceremony id lingering in the browser.
    headers.append("set-cookie", clearedLoginChallengeCookieHeader());
    return Response.json({ verified: true }, { headers });
  } catch (error) {
    if (error instanceof WebAuthnVerificationError) {
      recordAuthEvent("login.failure", "failure", { db,
        request,
        details: { reason: error.message },
      });
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
});
