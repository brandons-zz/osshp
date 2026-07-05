// GET /api/admin/media/[id]/usage — the full where-used list for a media item
// (issue 037 §1.4). Drives the detail panel's "Used by" section and the
// delete-blocking dialog. Same on-demand content scan (§5) that powers the list
// counts — one code path, three consumers.
//
// Admin surface (default-deny) + authoritative session validation. Safe method
// (no CSRF) but stamped no-store — admin data must not cache.

import { getDb } from "@/lib/db/client";
import { withNoStore } from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/platform";
import { findMediaUsage } from "@/lib/content/media-usage";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return withNoStore(
      Response.json({ error: "unauthenticated" }, { status: 401 }),
    );
  }
  const { id } = await params;
  const usage = await findMediaUsage(db, id);
  return withNoStore(Response.json({ usage }));
}
