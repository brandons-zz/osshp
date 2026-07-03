// POST /api/admin/account/password — set or change the admin password (argon2id).
//
// Admin surface (not on the public allowlist → the default-deny middleware
// already requires a signed session; this handler re-validates it). Setting a
// password is a credential change (S4): all sessions are revoked and a fresh one
// is issued for the operator who made the change, so other sessions are killed
// while this one stays live. CSRF-guarded; audit-emitting.

import { getDb } from "@/lib/db/client";
import {
  createSession,
  guardMutation,
  recordAuthEvent,
  revokeAllSessions,
  sessionCookieHeader,
  setPassword,
} from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/platform";

/** Minimum admin password length — a real floor, not a vacuous check. */
const MIN_PASSWORD_LENGTH = 12;

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  let body: { password?: string };
  try {
    body = (await request.json()) as { password?: string };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const password = body.password ?? "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return Response.json(
      { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 },
    );
  }

  await setPassword(db, password);
  // Credential change → revoke ALL sessions (S4), then issue a fresh one for the
  // operator who made the change so they remain logged in.
  await revokeAllSessions(db);
  recordAuthEvent("session.revoke_all", "success", {
    request,
    details: { reason: "password_change" },
  });
  recordAuthEvent("credential.change", "success", {
    request,
    details: { credential: "password" },
  });
  const session = await createSession(db);
  return Response.json(
    { ok: true },
    { headers: { "set-cookie": sessionCookieHeader(session) } },
  );
});
