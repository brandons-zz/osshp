// POST /api/auth/login/verify — finish a passkey authentication ceremony.
//
// On success, rotates the session (S3 — fresh id post-auth, fixation defense) and
// sets a Secure-by-default cookie. Rate-limited (NO-GO #7).

import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { getDb } from "@/lib/db/client";
import {
  clientKey,
  guardMutation,
  loginLimiter,
  readSessionCookie,
  recordAuthEvent,
  rotateSession,
  sessionCookieHeader,
  verifyAuthentication,
  WebAuthnVerificationError,
} from "@/lib/auth";
import { rateLimitedResponse, readJson } from "../../_shared";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  const limit = loginLimiter.check(clientKey("login", request));
  if (!limit.allowed) {
    recordAuthEvent("rate_limit.trip", "failure", {
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
  try {
    await verifyAuthentication(db, { response: body.response });
    const session = await rotateSession(db, oldToken); // S3
    recordAuthEvent("login.success", "success", { request });
    return Response.json(
      { verified: true },
      { headers: { "set-cookie": sessionCookieHeader(session) } },
    );
  } catch (error) {
    if (error instanceof WebAuthnVerificationError) {
      recordAuthEvent("login.failure", "failure", {
        request,
        details: { reason: error.message },
      });
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
});
