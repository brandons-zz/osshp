// POST /api/admin/account/recovery-codes — (re)generate the recovery-code set.
//
// Returns the fresh plaintext codes ONCE for the operator to record (R4 —
// display-once; regeneration invalidates the prior set). Codes are stored HASHED.
// Regenerating credentials is a credential change (S4): all sessions are revoked
// and a fresh one issued for the operator. Admin surface (default-deny + handler
// re-validate). CSRF-guarded; audit-emitting (no code value is ever logged).

import { getDb } from "@/lib/db/client";
import {
  createSession,
  guardMutation,
  recordAuthEvent,
  regenerateRecoveryCodes,
  revokeAllSessions,
  sessionCookieHeader,
} from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/platform";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const generated = await regenerateRecoveryCodes(db);
  await revokeAllSessions(db);
  recordAuthEvent("session.revoke_all", "success", {
    request,
    details: { reason: "recovery_codes_regenerated" },
  });
  recordAuthEvent("credential.change", "success", {
    request,
    details: { credential: "recovery_codes" },
  });
  const session = await createSession(db);
  return Response.json(
    // Plaintext returned ONCE; only hashes are stored.
    { codes: generated.plaintext },
    { headers: { "set-cookie": sessionCookieHeader(session) } },
  );
});
