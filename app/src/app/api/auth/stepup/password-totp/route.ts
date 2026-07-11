// POST /api/auth/stepup/password-totp — the ONLY step-up fallback lane (A1).
//
// For an operator who cannot use their passkey right now but holds the password
// AND a TOTP code. BOTH factors are required — password alone NEVER authenticates
// (NO-GO #3, verifyPasswordAndTotp reused, not reimplemented). On success it mints
// ONE step-up grant (factor = 'password+totp'), same response shape as the passkey
// lane. A valid session is required (401). Rate-limited as its OWN lockout lane
// ("stepup-password-totp") — independent of the recovery-login lockout so neither
// locks the other. Failure is GENERIC (never which factor failed). CSRF-guarded;
// audit-emitting (no secret reaches a log line).

import { getDb } from "@/lib/db/client";
import {
  clientKey,
  guardMutation,
  issueStepUpGrant,
  readSessionCookie,
  recordAuthEvent,
  stepupFallbackLimiter,
  validateSession,
  verifyPasswordAndTotp,
} from "@/lib/auth";
import { rateLimitedResponse, readJson } from "../../_shared";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  const session = await validateSession(db, readSessionCookie(request));
  if (!session) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const key = clientKey("stepup-password-totp", request);
  const limit = await stepupFallbackLimiter.check(db, key);
  if (!limit.allowed) {
    recordAuthEvent("lockout", "failure", { db,
      request,
      details: { lane: "stepup-password-totp" },
    });
    return rateLimitedResponse(limit);
  }

  const body = await readJson<{ password?: string; totpToken?: string }>(request);
  if (!body?.password || !body?.totpToken) {
    return Response.json(
      { error: "password and totpToken are required" },
      { status: 400 },
    );
  }

  const ok = await verifyPasswordAndTotp(db, body.password, body.totpToken);
  if (!ok) {
    recordAuthEvent("stepup.failure", "failure", { db,
      request,
      details: { lane: "stepup-password-totp" },
    });
    // Generic — never reveal which factor failed (mirrors the recovery lane).
    return Response.json({ error: "step-up failed" }, { status: 401 });
  }

  // Both factors verified: reset the lockout counter and mint the grant.
  await stepupFallbackLimiter.reset(db, key);
  const { grant, expiresAt } = await issueStepUpGrant(db, session.id, "password+totp");
  recordAuthEvent("stepup.grant", "success", { db,
    request,
    details: { factor: "password+totp" },
  });
  return Response.json({ ok: true, grant, expiresAt: expiresAt.toISOString() });
});
