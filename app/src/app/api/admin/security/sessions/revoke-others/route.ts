// POST /api/admin/security/sessions/revoke-others — end every session but the
// caller's, then rotate the caller's (Security Center §4).
//
// This is an ASYMMETRIC eviction primitive: it spares the caller, so a session
// thief could otherwise repeatedly kick the owner out while keeping their own
// access — converting temporary access into exclusive control. It is therefore
// A1-step-up-gated through the SINGLE shared gate (consumeStepUpGrant), exactly
// like a credential change; plain logout (self-revocation) stays ungated (§4.2).
//
// On success, in order (§4.1):
//   1. delete every other session — their step-up grants cascade-die with them;
//   2. rotate the caller's session — a token exfiltrated before this click (incl.
//      the caller's own, possibly-stolen one) is now dead too;
//   3. audit session.revoke_others { revoked, factor }.
// Post-state: exactly one valid session exists in the world and it was minted in
// this response. The operator is not signed out — the fresh cookie rides back.
//
// Order of operations (A1 D8 shape): guardMutation CSRF → validateSession (401) →
// consumeStepUpGrant (uniform 403, no oracle) → delete others → rotate → audit.

import { getDb } from "@/lib/db/client";
import {
  consumeStepUpGrant,
  guardMutation,
  readSessionCookie,
  recordAuthEvent,
  revokeOtherSessions,
  rotateSession,
  sessionCookieHeader,
  sessionMetadataFromRequest,
  stepUpRequiredResponse,
  validateSession,
} from "@/lib/auth";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  const sessionToken = readSessionCookie(request);
  const session = await validateSession(db, sessionToken);
  if (!session) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Step-up gate (A1): revoke-others is an owner-eviction primitive — it must cost
  // a fresh factor proof. Absent/expired/consumed/foreign grant → uniform 403.
  const factor = await consumeStepUpGrant(db, request);
  if (!factor) {
    recordAuthEvent("stepup.denied", "failure", {
      db,
      request,
      details: { action: "revoke_others" },
    });
    return stepUpRequiredResponse();
  }

  // 1. Terminate every OTHER session (their grants cascade-die). 2. Rotate the
  // caller's own — so after this response exactly one valid token exists anywhere.
  const revoked = await revokeOtherSessions(db, session.id);
  const fresh = await rotateSession(db, sessionToken, sessionMetadataFromRequest(request));
  recordAuthEvent("session.revoke_others", "success", {
    db,
    request,
    details: { revoked, factor },
  });

  return Response.json(
    { revoked },
    { headers: { "set-cookie": sessionCookieHeader(fresh) } },
  );
});
