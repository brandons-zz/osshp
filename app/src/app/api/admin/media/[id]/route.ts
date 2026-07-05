// PATCH  /api/admin/media/[id] — edit a media item's canonical alt text (§1.3).
// DELETE /api/admin/media/[id] — delete a media item, usage-aware (§1.2).
//
// Admin surface (default-deny) + authoritative session validation. Inline CSRF
// guard (host-comparison + no-store) because these handlers take the route
// `params` arg and so cannot use the single-arg guardMutation wrapper — same
// protection as the sibling authoring routes (M2.1).
//
// DELETE is usage-aware: if the image is referenced by any post/page and the
// request did not pass ?force=1, it returns 409 with the reference list so the
// client can show the honest "Delete anyway" dialog (design §2.4). Never
// silently orphans content, never silently blocks the single admin.

import { getDb } from "@/lib/db/client";
import { config } from "@/lib/config";
import { isSameOrigin, withNoStore } from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/platform";
import { updateMediaAlt } from "@/lib/content/media";
import { findMediaUsage } from "@/lib/content/media-usage";
import { deleteMediaById } from "@/lib/content/media-delete";
import { toMediaListItem } from "@/lib/content/media-view";
import { getMediaStorage } from "@/lib/media";

interface PatchBody {
  alt?: string;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOrigin(request, config.origin)) {
    return withNoStore(Response.json({ error: "csrf_failed" }, { status: 403 }));
  }
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return withNoStore(
      Response.json({ error: "unauthenticated" }, { status: 401 }),
    );
  }
  const { id } = await params;
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return withNoStore(
      Response.json({ error: "invalid JSON body" }, { status: 400 }),
    );
  }
  if (typeof body.alt !== "string") {
    return withNoStore(
      Response.json({ error: "alt must be a string" }, { status: 400 }),
    );
  }
  const updated = await updateMediaAlt(db, id, body.alt);
  if (!updated) {
    return withNoStore(
      Response.json({ error: "media not found" }, { status: 404 }),
    );
  }
  // Recompute usage so the client's list entry stays consistent after the edit.
  const usage = await findMediaUsage(db, id);
  return withNoStore(Response.json(toMediaListItem(updated, usage.length)));
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOrigin(request, config.origin)) {
    return withNoStore(Response.json({ error: "csrf_failed" }, { status: 403 }));
  }
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return withNoStore(
      Response.json({ error: "unauthenticated" }, { status: 401 }),
    );
  }
  const { id } = await params;
  const force = new URL(request.url).searchParams.get("force") === "1";

  // Usage-aware delete via the shared helper (also used by bulk + post-delete
  // cleanup). When referenced without force it returns "in_use"; the force path
  // strips dangling cover/body references first (QA finding 1) then removes the
  // objects + row. Gallery membership is cleaned by the post_media FK cascade.
  const result = await deleteMediaById(db, getMediaStorage(), id, { force });
  if (result.status === "not_found") {
    return withNoStore(
      Response.json({ error: "media not found" }, { status: 404 }),
    );
  }
  if (result.status === "in_use") {
    // Blocking response — the client renders the usage-aware confirm (§2.4).
    return withNoStore(
      Response.json({ error: "in_use", usage: result.usage }, { status: 409 }),
    );
  }
  return withNoStore(new Response(null, { status: 204 }));
}
