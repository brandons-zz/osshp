// POST /api/auth/register/options — begin a passkey enrollment ceremony.
//
// Lane-gated (auth-security-assessment W5, NO-GO #1/#2): bootstrap when no admin
// exists, authenticated step-up otherwise, or a token-bearing reenroll during an
// open recovery window (F1 — the reenroll token is presented in the request body
// and must match the single-use token the recovery event minted; without it the
// caller gets 403 whether or not a window is open, so there is no window oracle).
// Rate-limited (NO-GO #7). RP-ID / origin are pinned from config inside
// buildRegistrationOptions (W2) — no header reaches the ceremony.

import { getDb } from "@/lib/db/client";
import {
  bootstrapLimiter,
  buildRegistrationOptions,
  clientKey,
  guardMutation,
  isBootstrapAvailable,
  readSessionCookie,
  recordAuthEvent,
  RegistrationForbiddenError,
  registrationLimiter,
  validateSession,
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

  const authenticated = Boolean(
    await validateSession(db, readSessionCookie(request)),
  );
  const body = await readJson<{ reenrollToken?: string }>(request);
  try {
    const options = await buildRegistrationOptions(db, {
      authenticated,
      reenrollToken: body?.reenrollToken,
    });
    return Response.json(options);
  } catch (error) {
    if (error instanceof RegistrationForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
});
