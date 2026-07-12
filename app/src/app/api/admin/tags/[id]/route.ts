// PATCH  /api/admin/tags/[id] — rename a tag (reflected across every post).
// DELETE /api/admin/tags/[id] — delete a tag (cleared from every post; the
//   posts themselves are untouched — post_tags cascades on the FK).
//
// Admin surface (default-deny) + authoritative session validation. Inline
// CSRF guard (host-comparison + no-store) because these handlers take the
// route `params` arg and so cannot use the single-arg guardMutation wrapper
// (same protection as the pages/blog/photos [id] routes, §M2.1).

import { getDb } from "@/lib/db/client";
import { config } from "@/lib/config";
import { isSameOrigin, withNoStore } from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/platform";
import { renameTag, deleteTag, validateTagName } from "@/lib/content/tags";

interface RenameBody {
  name?: string;
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
  let body: RenameBody;
  try {
    body = (await request.json()) as RenameBody;
  } catch {
    return withNoStore(
      Response.json({ error: "invalid JSON body" }, { status: 400 }),
    );
  }
  const name = body.name ?? "";
  const nameError = validateTagName(name);
  if (nameError) {
    return withNoStore(Response.json({ error: nameError }, { status: 400 }));
  }

  const result = await renameTag(db, id, name.trim());
  if (!result.ok && result.reason === "not-found") {
    return withNoStore(Response.json({ error: "tag not found" }, { status: 404 }));
  }
  if (!result.ok && result.reason === "collision") {
    return withNoStore(
      Response.json(
        {
          error: `A tag named "${result.existing.name}" already exists. Use Merge if you meant to combine them.`,
          existingTag: result.existing,
        },
        { status: 409 },
      ),
    );
  }
  if (!result.ok) {
    // Exhaustiveness guard — every RenameTagResult variant is handled above.
    return withNoStore(Response.json({ error: "rename failed" }, { status: 500 }));
  }
  return withNoStore(Response.json({ tag: result.tag }));
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
  const result = await deleteTag(db, id);
  if (!result) {
    return withNoStore(Response.json({ error: "tag not found" }, { status: 404 }));
  }
  return withNoStore(Response.json({ affectedPosts: result.affectedPosts }));
}
