// PATCH /api/admin/blog/posts/[id] — edit a post / publish it.
//
// Publishing is PATCH status:"published"; when a post transitions to published
// without an explicit publishDate we stamp it now so it sorts and appears on the
// public site immediately. Admin surface (default-deny) + authoritative session
// validation, same as the create route.

import { getDb } from "@/lib/db/client";
import { getPostById, updatePost, deletePost } from "@/lib/content/posts";
import type { ContentStatus, ImageRef, PostType } from "@/lib/content/types";
import { config } from "@/lib/config";
import { isSameOrigin, withNoStore } from "@/lib/auth";
import { getSessionFromRequest, requireModuleEnabled } from "@/lib/platform";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";

interface UpdateBody {
  title?: string;
  slug?: string;
  body?: string;
  excerpt?: string;
  type?: PostType;
  status?: ContentStatus;
  publishDate?: string | null;
  coverImage?: ImageRef | null;
  tags?: Array<{ name: string; slug: string }>;
  /** Feature this post in the home "Selected" showcase (issue 012). */
  featured?: boolean;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Same-origin CSRF guard, applied inline because this handler takes the route
  // `params` arg and so cannot use the single-arg guardMutation wrapper — same
  // protection (host-comparison + no-store), just not the wrapper sugar.
  if (!isSameOrigin(request, config.origin)) {
    return withNoStore(Response.json({ error: "csrf_failed" }, { status: 403 }));
  }
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return withNoStore(
      Response.json({ error: "unauthenticated" }, { status: 401 }),
    );
  }
  const disabledGate = await requireModuleEnabled(db, BLOG_MODULE_ID, "Blog");
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
    type: body.type,
    featured: body.featured,
    status: body.status,
    publishDate,
    coverImage: body.coverImage,
    tags: body.tags,
  });
  if (!updated) {
    return withNoStore(
      Response.json({ error: "post not found" }, { status: 404 }),
    );
  }
  return withNoStore(
    Response.json({ id: updated.id, slug: updated.slug, status: updated.status }),
  );
}

// DELETE /api/admin/blog/posts/[id] — hard-delete a blog post.
// Removes the post row (cascades to post_tags). Media objects in object storage
// are NOT removed here — that is a future garbage-collection concern. Auth-guarded
// and CSRF-protected (inline, same pattern as PATCH above).
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
  const disabledGate = await requireModuleEnabled(db, BLOG_MODULE_ID, "Blog");
  if (disabledGate) return disabledGate;
  const { id } = await params;
  const existing = await getPostById(db, id);
  if (!existing) {
    return withNoStore(
      Response.json({ error: "post not found" }, { status: 404 }),
    );
  }
  await deletePost(db, id);
  return withNoStore(new Response(null, { status: 204 }));
}
