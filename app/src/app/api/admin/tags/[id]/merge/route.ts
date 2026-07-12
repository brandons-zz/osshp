// POST /api/admin/tags/[id]/merge — merge the tag at [id] (the "source", the
// one that disappears) INTO body.targetId (the "target", the one that
// survives). Every post carrying the source ends up tagged with the target,
// with no duplicate post_tags rows (composite PK + ON CONFLICT DO NOTHING in
// the store), and the source tag is removed.
//
// Admin surface (default-deny) + authoritative session validation. Inline
// CSRF guard (host-comparison + no-store), same protection as the sibling
// [id] route (§M2.1) — this route also takes a `params` arg.

import { getDb } from "@/lib/db/client";
import { config } from "@/lib/config";
import { isSameOrigin, withNoStore } from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/platform";
import { mergeTags } from "@/lib/content/tags";

interface MergeBody {
  targetId?: string;
}

export async function POST(
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
  let body: MergeBody;
  try {
    body = (await request.json()) as MergeBody;
  } catch {
    return withNoStore(
      Response.json({ error: "invalid JSON body" }, { status: 400 }),
    );
  }
  const targetId = body.targetId?.trim();
  if (!targetId) {
    return withNoStore(
      Response.json({ error: "targetId is required" }, { status: 400 }),
    );
  }

  const result = await mergeTags(db, id, targetId);
  if (!result.ok && result.reason === "same-tag") {
    return withNoStore(
      Response.json({ error: "a tag cannot be merged into itself" }, { status: 400 }),
    );
  }
  if (!result.ok && result.reason === "not-found") {
    return withNoStore(Response.json({ error: "tag not found" }, { status: 404 }));
  }
  if (!result.ok) {
    return withNoStore(Response.json({ error: "merge failed" }, { status: 500 }));
  }
  return withNoStore(Response.json({ affectedPosts: result.affectedPosts }));
}
