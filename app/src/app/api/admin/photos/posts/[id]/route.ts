// PATCH /api/admin/photos/posts/[id] — edit / publish a photo post. Mirrors the
// blog post PATCH route, forcing type='photo-post'. Admin surface (default-deny) +
// authoritative session validation; same-origin CSRF guard applied inline because
// this handler takes the route `params` arg (so it cannot use the single-arg
// guardMutation wrapper) — same protection (host-comparison + no-store).

import { getDb } from "@/lib/db/client";
import { getPostById, updatePost, deletePost } from "@/lib/content/posts";
import type { ContentStatus, ImageRef } from "@/lib/content/types";
import { config } from "@/lib/config";
import { isSameOrigin, withNoStore } from "@/lib/auth";
import { getSessionFromRequest, requireModuleEnabled } from "@/lib/platform";
import { PHOTOS_MODULE_ID } from "@/modules/photos/manifest";

interface UpdateBody {
  title?: string;
  slug?: string;
  body?: string;
  excerpt?: string;
  status?: ContentStatus;
  publishDate?: string | null;
  coverImage?: ImageRef | null;
  tags?: Array<{ name: string; slug: string }>;
  /** When true, opts this photo-post into the /blog listing stream. */
  showInBlog?: boolean;
  /** Feature this photo-post in the home "Selected" showcase (issue 012). */
  featured?: boolean;
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
  const disabledGate = await requireModuleEnabled(db, PHOTOS_MODULE_ID, "Photos");
  if (disabledGate) return disabledGate;
  const { id } = await params;
  let body: UpdateBody;
  try {
    body = (await request.json()) as UpdateBody;
  } catch {
    return withNoStore(
      Response.json({ error: "invalid JSON body" }, { status: 400 }),
    );
  }

  // Stamp publishDate when transitioning to published without an explicit date.
  let publishDate = body.publishDate;
  if (body.status === "published" && publishDate === undefined) {
    const existing = await getPostById(db, id);
    if (existing && !existing.publishDate) {
      publishDate = new Date().toISOString();
    }
  }

  const updated = await updatePost(db, id, {
    title: body.title,
    slug: body.slug,
    body: body.body,
    excerpt: body.excerpt,
    type: "photo-post", // keep this row a photo post regardless of payload
    showInBlog: body.showInBlog,
    featured: body.featured,
    status: body.status,
    publishDate,
    coverImage: body.coverImage,
    tags: body.tags,
  });
  if (!updated) {
    return withNoStore(
      Response.json({ error: "photo post not found" }, { status: 404 }),
    );
  }
  return withNoStore(
    Response.json({ id: updated.id, slug: updated.slug, status: updated.status }),
  );
}

// DELETE /api/admin/photos/posts/[id] — hard-delete a photo post.
// Auth-guarded and CSRF-protected (inline, same pattern as PATCH above).
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
  const disabledGate = await requireModuleEnabled(db, PHOTOS_MODULE_ID, "Photos");
  if (disabledGate) return disabledGate;
  const { id } = await params;
  const existing = await getPostById(db, id);
  if (!existing || existing.type !== "photo-post") {
    return withNoStore(
      Response.json({ error: "photo post not found" }, { status: 404 }),
    );
  }
  await deletePost(db, id);
  return withNoStore(new Response(null, { status: 204 }));
}
