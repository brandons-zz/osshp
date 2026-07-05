// GET /api/admin/photos/posts/[id]/media — media-cleanup preview for a photo
// post (issue 056). Returns how many photos the post owns and, of those, how
// many are referenced ONLY by this post (deletable with it) vs shared with other
// content (kept). Powers the honest "Also delete the N photos?" delete dialog on
// both the photos list and the editor — without mutating anything.
//
// Admin surface (default-deny) + authoritative session validation; no-store
// (admin data must not cache). GET is a safe method — no CSRF guard needed.

import { getDb } from "@/lib/db/client";
import { withNoStore } from "@/lib/auth";
import { getSessionFromRequest, requireModuleEnabled } from "@/lib/platform";
import { PHOTOS_MODULE_ID } from "@/modules/photos/manifest";
import { getPostById } from "@/lib/content/posts";
import { postMediaDeletionPreview } from "@/lib/content/media-delete";

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
  const disabledGate = await requireModuleEnabled(db, PHOTOS_MODULE_ID, "Photos");
  if (disabledGate) return disabledGate;

  const { id } = await params;
  const post = await getPostById(db, id);
  if (!post || post.type !== "photo-post") {
    return withNoStore(
      Response.json({ error: "photo post not found" }, { status: 404 }),
    );
  }
  const preview = await postMediaDeletionPreview(db, id);
  return withNoStore(Response.json(preview));
}
