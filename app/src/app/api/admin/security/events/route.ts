// GET /api/admin/security/events?limit=50&before=<ISO ts> — a newest-first page
// over the durable auth audit trail (§3.1 / §5).
//
// Session-gated only (401 without a valid session), NOT step-up-gated (reads are
// visibility, §3.1). Rows are SAFE to return by construction: they were redacted
// before they were stored (§5.4), so the read side adds no projection. `limit` is
// clamped to ≤ 100 server-side (in listAuditEvents); `before` is an ISO keyset
// cursor for "load older". The feed begins at this slice's ship time — earlier
// events live only in container logs, which the UI states rather than faking.

import { getDb } from "@/lib/db/client";
import {
  listAuditEvents,
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
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const parsedLimit = limitParam !== null ? Number(limitParam) : NaN;
  const before = url.searchParams.get("before");
  // A malformed `before` cursor is a client error, not a server fault: reject it
  // with a 400 rather than letting an unparseable value reach the SQL timestamp
  // comparison (which would 500). No detail is leaked either way.
  if (before !== null && Number.isNaN(Date.parse(before))) {
    return withNoStore(Response.json({ error: "invalid before cursor" }, { status: 400 }));
  }
  const events = await listAuditEvents(db, {
    limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    before,
  });
  return withNoStore(Response.json({ events }));
}
