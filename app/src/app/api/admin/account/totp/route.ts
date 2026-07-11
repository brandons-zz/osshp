// Admin TOTP enrollment (verify-before-enable).
//
//  POST /api/admin/account/totp  — begin enrollment: mint a secret (stored
//        ENCRYPTED at rest), return the secret + otpauth:// URI for ONE-TIME
//        display. The lane is not active yet (verify-before-enable, T5).
//  PUT  /api/admin/account/totp  — confirm enrollment with a current code; on
//        success the lane is enabled. Enabling TOTP is a credential change (S4):
//        revoke all sessions, issue a fresh one for the operator.
//
// Admin surface (default-deny requires a session; re-validated here). CSRF-guarded;
// audit-emitting. The secret is returned ONLY at enrollment and never logged.

import { getDb } from "@/lib/db/client";
import {
  confirmTotp,
  consumeStepUpGrant,
  createSession,
  enrollTotp,
  guardMutation,
  recordAuthEvent,
  revokeAllSessions,
  sessionCookieHeader,
  stepUpRequiredResponse,
  sessionMetadataFromRequest,
} from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/platform";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  // Step-up gate (A1 / D1): POST /totp is MUTATING — enrollTotp overwrites the
  // stored TOTP secret and disables the lane even when a confirmed lane is active,
  // so a session-only caller could silently destroy the owner's fallback factor.
  // It therefore requires a step-up grant (the PUT confirm is self-gated by the
  // pending secret the gated POST minted, and stays session-only).
  const factor = await consumeStepUpGrant(db, request);
  if (!factor) {
    recordAuthEvent("stepup.denied", "failure", { db,
      request,
      details: { action: "totp_begin" },
    });
    return stepUpRequiredResponse();
  }
  const enrollment = await enrollTotp(db, { issuer: "osshp", label: "admin" });
  // Returned ONCE for QR/manual entry; never persisted in plaintext, never logged.
  return Response.json({ secret: enrollment.secret, uri: enrollment.uri });
});

export const PUT = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  let body: { token?: string };
  try {
    body = (await request.json()) as { token?: string };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.token) {
    return Response.json({ error: "token is required" }, { status: 400 });
  }

  const ok = await confirmTotp(db, body.token);
  if (!ok) {
    recordAuthEvent("credential.change", "failure", { db,
      request,
      details: { credential: "totp", reason: "invalid_code" },
    });
    return Response.json({ error: "invalid TOTP code" }, { status: 400 });
  }

  await revokeAllSessions(db);
  recordAuthEvent("session.revoke_all", "success", { db,
    request,
    details: { reason: "totp_enrolled" },
  });
  recordAuthEvent("credential.change", "success", { db,
    request,
    details: { credential: "totp" },
  });
  const session = await createSession(db, sessionMetadataFromRequest(request));
  return Response.json(
    { ok: true },
    { headers: { "set-cookie": sessionCookieHeader(session) } },
  );
});
