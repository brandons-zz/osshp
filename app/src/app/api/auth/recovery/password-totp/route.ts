// POST /api/auth/recovery/password-totp — the password+TOTP fallback login lane.
//
// For an operator who lost their passkey but holds the password AND a TOTP code.
// BOTH factors are required — password alone NEVER authenticates (NO-GO #3); the
// verification lives in verifyPasswordAndTotp. On success the session is rotated
// (a fresh login; the operator can then re-enroll a passkey via step-up). The lane
// is rate-limited as the account-lockout control (B4): N failures per window lock
// the trusted-proxy-aware key; a success resets the counter (consecutive-failure
// semantics). CSRF-guarded; audit-emitting (no secret reaches a log line).

import { getDb } from "@/lib/db/client";
import {
  clientKey,
  guardMutation,
  passwordTotpLimiter,
  readSessionCookie,
  recordAuthEvent,
  rotateSession,
  sessionCookieHeader,
  verifyPasswordAndTotp,
  sessionMetadataFromRequest,
} from "@/lib/auth";
import { rateLimitedResponse, readJson } from "../../_shared";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  // Cheap, no-side-effect body-shape validation runs BEFORE the rate-limit
  // check (which now persists to the database, migration 0013) — a malformed
  // request with no password/totpToken can never authenticate regardless, so
  // there is no reason to spend a database round trip or a unit of the
  // caller's throttle budget on it.
  const body = await readJson<{ password?: string; totpToken?: string }>(request);
  if (!body?.password || !body?.totpToken) {
    return Response.json(
      { error: "password and totpToken are required" },
      { status: 400 },
    );
  }

  const key = clientKey("recovery-password-totp", request);
  const limit = await passwordTotpLimiter.check(db, key);
  if (!limit.allowed) {
    recordAuthEvent("lockout", "failure", { db,
      request,
      details: { lane: "recovery-password-totp" },
    });
    return rateLimitedResponse(limit);
  }

  const ok = await verifyPasswordAndTotp(db, body.password, body.totpToken);
  if (!ok) {
    recordAuthEvent("recovery.failure", "failure", { db,
      request,
      details: { lane: "recovery-password-totp" },
    });
    // Generic error — never reveal which factor failed.
    return Response.json({ error: "recovery failed" }, { status: 401 });
  }

  // Both factors verified: reset the lockout counter and rotate to a fresh session.
  await passwordTotpLimiter.reset(db, key);
  const session = await rotateSession(
    db,
    readSessionCookie(request),
    sessionMetadataFromRequest(request),
  );
  recordAuthEvent("recovery.success", "success", { db,
    request,
    details: { lane: "recovery-password-totp" },
  });
  recordAuthEvent("login.success", "success", { db,
    request,
    details: { lane: "recovery-password-totp" },
  });
  return Response.json(
    { verified: true },
    { headers: { "set-cookie": sessionCookieHeader(session) } },
  );
});
