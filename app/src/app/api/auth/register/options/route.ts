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
  consumeStepUpGrant,
  guardMutation,
  isBootstrapAvailable,
  readSessionCookie,
  recordAuthEvent,
  RegistrationForbiddenError,
  registrationLimiter,
  stepUpRequiredResponse,
  validateSession,
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

  const authenticated = Boolean(
    await validateSession(db, readSessionCookie(request)),
  );
  // Step-up gate (A1 / §3 #4): the AUTHENTICATED passkey-enroll lane —
  // resolveRegistrationMode's "step-up" mode, which is exactly (admin exists AND
  // authenticated) — is a credential change and requires a fresh step-up grant,
  // consumed HERE at options. verify then rides the single-use registration
  // challenge only this gated options request can store (no challenge ⇒ no verify),
  // so the enroll costs exactly one step-up. The bootstrap and reenroll lanes are
  // untouched (bootstrap: nothing to step up from; reenroll: possession-bound by
  // the 031 token) — the grant check applies ONLY to the step-up mode branch.
  if (!bootstrap && authenticated) {
    const factor = await consumeStepUpGrant(db, request);
    if (!factor) {
      recordAuthEvent("stepup.denied", "failure", { db,
        request,
        details: { action: "passkey_enroll" },
      });
      return stepUpRequiredResponse();
    }
  }
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
