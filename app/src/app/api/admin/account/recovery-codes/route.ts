// POST /api/admin/account/recovery-codes — (re)generate the recovery-code set.
//
// Returns the fresh plaintext codes ONCE for the operator to record (R4 —
// display-once; regeneration invalidates the prior set). Codes are stored HASHED.
// Regenerating credentials is a credential change (S4): all sessions are revoked
// and a fresh one issued for the operator. Admin surface (default-deny + handler
// re-validate). CSRF-guarded; audit-emitting (no code value is ever logged).

import { getDb } from "@/lib/db/client";
import {
  consumeStepUpGrant,
  createSession,
  guardMutation,
  recordAuthEvent,
  regenerateRecoveryCodes,
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
  // Step-up gate (A1): regenerating recovery codes invalidates the prior set and
  // surfaces a fresh set an attacker could capture — a credential change requiring
  // a fresh step-up grant.
  const factor = await consumeStepUpGrant(db, request);
  if (!factor) {
    recordAuthEvent("stepup.denied", "failure", { db,
      request,
      details: { action: "recovery_codes" },
    });
    return stepUpRequiredResponse();
  }

  const generated = await regenerateRecoveryCodes(db);
  await revokeAllSessions(db);
  recordAuthEvent("session.revoke_all", "success", { db,
    request,
    details: { reason: "recovery_codes_regenerated" },
  });
  recordAuthEvent("credential.change", "success", { db,
    request,
    details: { credential: "recovery_codes", factor },
  });
  const session = await createSession(db, sessionMetadataFromRequest(request));
  return Response.json(
    // Plaintext returned ONCE; only hashes are stored.
    { codes: generated.plaintext },
    { headers: { "set-cookie": sessionCookieHeader(session) } },
  );
});
