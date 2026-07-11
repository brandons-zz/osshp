// GET /api/admin/security/overview — the Security Center at-a-glance payload
// (sessions/devices view + recovery-code / TOTP / passkey status). §3.1.
//
// Session-gated only (401 without a valid session), NOT step-up-gated: reads are
// the operator's own visibility surface — requiring a passkey tap just to LOOK
// would train the owner not to look. GET, so no CSRF guard (guardMutation is
// mutation-only). The response carries session metadata → Cache-Control: no-store.
//
// Full session ids never leave the server: the view returns 8-char id prefixes and
// a server-computed `current` flag (§3.3). Notifications booleans are deliberately
// omitted from this slice (the notification channel is an open owner decision).

import { getDb } from "@/lib/db/client";
import {
  buildSecurityOverview,
  readSessionCookie,
  validateSession,
  withNoStore,
} from "@/lib/auth";

export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  const session = await validateSession(db, readSessionCookie(request));
  if (!session) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const overview = await buildSecurityOverview(db, session.id);
  return withNoStore(Response.json(overview));
}
