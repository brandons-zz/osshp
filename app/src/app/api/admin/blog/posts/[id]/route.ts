// PATCH /api/admin/blog/posts/[id] — edit a post / publish it.
//
// Publishing is PATCH status:"published"; when a post transitions to published
// without an explicit publishDate we stamp it now so it sorts and appears on the
// public site immediately. Admin surface (default-deny) + authoritative session
// validation, same as the create route.

import { getDb } from "@/lib/db/client";
import { getPostById, updatePost, deletePost } from "@/lib/content/posts";
import type { ContentStatus, ImageRef } from "@/lib/content/types";
import { config } from "@/lib/config";
import { isSameOrigin, withNoStore } from "@/lib/auth";
import { getSessionFromRequest, requireModuleEnabled } from "@/lib/platform";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";
import { isBlogArticle } from "../_type-guard";
import { validateTitleSlugLength } from "@/lib/content/limits";
import { autoImportExternalImages, getMediaStorage } from "@/lib/media";
import type { ImageImportResult } from "@/lib/media";

// No `type` field: this route only ever edits an existing article (guarded
// below by isBlogArticle) and never changes what an article IS (issue 071) —
// a raw request cannot flip an existing row to `photo-post` through this
// route regardless of what it sends, mirroring the photos PATCH route's own
// unconditional `type: "photo-post"`.
interface UpdateBody {
  title?: string;
  slug?: string;
  body?: string;
  excerpt?: string;
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
  const lengthError = validateTitleSlugLength(body.title, body.slug);
  if (lengthError) {
    return withNoStore(Response.json({ error: lengthError }, { status: 400 }));
  }

  // This route only edits articles (issue 051): a photo/gallery post must be
  // edited via the photos route so its publish-time alt gate (issue 047) is
  // enforced. Without this check, a status-flip PATCH here could publish a
  // missing-alt gallery — the blog route has no gallery-alt validation.
  const existing = await getPostById(db, id);
  if (!isBlogArticle(existing)) {
    return withNoStore(
      Response.json({ error: "post not found" }, { status: 404 }),
    );
  }

  // Stamp publishDate when transitioning to published without an explicit date.
  let publishDate = body.publishDate;
  if (body.status === "published" && publishDate === undefined) {
    if (existing && !existing.publishDate) {
      publishDate = new Date().toISOString();
    }
  }

  // Issue 077: auto-import any external inline image in the (possibly edited)
  // body before it's persisted. Only runs when a body was actually sent —
  // `undefined` means "leave the stored body unchanged" and must stay that way.
  let imageImports: ImageImportResult[] = [];
  let importedBody = body.body;
  if (importedBody !== undefined) {
    const result = await autoImportExternalImages(db, getMediaStorage(), importedBody);
    importedBody = result.body;
    imageImports = result.report;
  }

  const updated = await updatePost(db, id, {
    title: body.title,
    slug: body.slug,
    body: importedBody,
    excerpt: body.excerpt,
    type: "article", // keep this row an article regardless of the body (issue 071)
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
    Response.json({
      id: updated.id,
      slug: updated.slug,
      status: updated.status,
      ...(imageImports.length > 0 ? { imageImports } : {}),
    }),
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
  // Type-checked (issue 051), matching the photos DELETE route's own
  // type-check: this route only removes articles.
  if (!isBlogArticle(existing)) {
    return withNoStore(
      Response.json({ error: "post not found" }, { status: 404 }),
    );
  }
  await deletePost(db, id);
  return withNoStore(new Response(null, { status: 204 }));
}
