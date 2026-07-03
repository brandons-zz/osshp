// POST /api/auth/logout — revoke the current session and clear the cookie.

import { getDb } from "@/lib/db/client";
import {
  clearedSessionCookieHeader,
  guardMutation,
  readSessionCookie,
  recordAuthEvent,
  revokeSession,
} from "@/lib/auth";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  await revokeSession(db, readSessionCookie(request));
  recordAuthEvent("session.revoke", "success", { request });
  return Response.json(
    { ok: true },
    { headers: { "set-cookie": clearedSessionCookieHeader() } },
  );
});
