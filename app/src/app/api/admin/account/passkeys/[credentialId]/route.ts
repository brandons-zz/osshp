// DELETE /api/admin/account/passkeys/:credentialId — remove a passkey (A1 / D10).
//
// Admin surface (default-deny requires a session; re-validated here). Removing a
// passkey is a credential change: it requires a fresh step-up grant, and REFUSES to
// remove the last remaining passkey (400 — passkey-primary invariant; enroll a
// replacement first, or use the recovery lanes for a lost-passkey case). On success
// it revokes ALL sessions (S4) and issues a fresh one for the operator. CSRF-guarded;
// audit-emitting.
//
// The credential id is read from the URL path (guardMutation forwards only the
// Request), decoded once — it is a base64url credential id and may be percent-encoded.

import { getDb } from "@/lib/db/client";
import {
  consumeStepUpGrant,
  createSession,
  guardMutation,
  recordAuthEvent,
  removePasskey,
  revokeAllSessions,
  sessionCookieHeader,
  stepUpRequiredResponse,
  sessionMetadataFromRequest,
} from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/platform";

/** Extract and decode the trailing :credentialId path segment. */
function credentialIdFromRequest(request: Request): string {
  const { pathname } = new URL(request.url);
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export const DELETE = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const factor = await consumeStepUpGrant(db, request);
  if (!factor) {
    recordAuthEvent("stepup.denied", "failure", { db,
      request,
      details: { action: "passkey_remove" },
    });
    return stepUpRequiredResponse();
  }

  const credentialId = credentialIdFromRequest(request);
  const result = await removePasskey(db, credentialId);
  if (result === "not_found") {
    return Response.json({ error: "passkey not found" }, { status: 404 });
  }
  if (result === "last_passkey") {
    // Passkey-primary invariant: never strand the operator with no primary factor.
    return Response.json(
      { error: "cannot remove the last remaining passkey" },
      { status: 400 },
    );
  }

  // Credential change → revoke ALL sessions (S4), issue a fresh one for the operator.
  await revokeAllSessions(db);
  recordAuthEvent("session.revoke_all", "success", { db,
    request,
    details: { reason: "passkey_remove" },
  });
  recordAuthEvent("credential.change", "success", { db,
    request,
    details: { credential: "passkey", action: "remove", factor },
  });
  const session = await createSession(db, sessionMetadataFromRequest(request));
  return Response.json(
    { ok: true },
    { headers: { "set-cookie": sessionCookieHeader(session) } },
  );
});
