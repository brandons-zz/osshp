// PATCH /api/admin/photos/posts/[id] — edit / publish a photo post. Mirrors the
// blog post PATCH route, forcing type='photo-post'. Admin surface (default-deny) +
// authoritative session validation; same-origin CSRF guard applied inline because
// this handler takes the route `params` arg (so it cannot use the single-arg
// guardMutation wrapper) — same protection (host-comparison + no-store).

import { getDb } from "@/lib/db/client";
import { getPostById, updatePost } from "@/lib/content/posts";
import { deletePostWithMedia } from "@/lib/content/media-delete";
import { autoImportExternalImages, getMediaStorage } from "@/lib/media";
import type { ImageImportResult } from "@/lib/media";
import type { ContentStatus, ImageRef } from "@/lib/content/types";
import { config } from "@/lib/config";
import { isSameOrigin, withNoStore } from "@/lib/auth";
import { getSessionFromRequest, requireModuleEnabled } from "@/lib/platform";
import { PHOTOS_MODULE_ID } from "@/modules/photos/manifest";
import { validateTitleSlugLength } from "@/lib/content/limits";
import {
  normalizeGallery,
  galleryTooLarge,
  checkGalleryMedia,
  resolveEffectiveAlt,
  effectivePublishAltError,
  MAX_GALLERY_SIZE,
} from "../_gallery";
import { isPhotoPost } from "../_type-guard";

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
  /** Gallery mode (issue 047): mark this a gallery photo post. */
  isGallery?: boolean;
  /** Gallery only: chosen cover media id (null ⇒ first image). */
  coverMediaId?: string | null;
  /** Gallery only: the ordered images to persist (replaces membership). */
  gallery?: unknown;
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
  const lengthError = validateTitleSlugLength(body.title, body.slug);
  if (lengthError) {
    return withNoStore(Response.json({ error: lengthError }, { status: 400 }));
  }

  const existing = await getPostById(db, id);

  // This route only edits existing photo-posts (issue 071, mirroring the
  // blog route's isBlogArticle guard from issue 051): without this check, an
  // existing article's id could be PATCHed through here and silently
  // converted in place into a gallery photo-post — never created through
  // this route's own path, and regardless of the Blog module's enablement
  // state (this route's gate only consults Photos).
  if (!isPhotoPost(existing)) {
    return withNoStore(
      Response.json({ error: "photo post not found" }, { status: 404 }),
    );
  }

  // Stamp publishDate when transitioning to published without an explicit date.
  let publishDate = body.publishDate;
  if (body.status === "published" && publishDate === undefined) {
    if (existing && !existing.publishDate) {
      publishDate = new Date().toISOString();
    }
  }

  const gallery = normalizeGallery(body.gallery);
  // Server-side hard cap — a raw request must not submit an unbounded array.
  if (galleryTooLarge(gallery)) {
    return withNoStore(
      Response.json(
        { error: `A gallery can hold at most ${MAX_GALLERY_SIZE} photographs.` },
        { status: 400 },
      ),
    );
  }
  // When a gallery is being WRITTEN, validate referenced media exists first — a
  // nonexistent/malformed id returns a clean 4xx, never a 500 mid-write.
  let storedAlt = new Map<string, string>();
  if (gallery && gallery.length > 0) {
    const check = await checkGalleryMedia(db, gallery);
    if (check.error) {
      return withNoStore(Response.json({ error: check.error }, { status: 400 }));
    }
    storedAlt = check.storedAlt;
  }

  // AA 1.1.1: block Publish/Schedule when any gallery image lacks alt — judged on
  // the EFFECTIVE result (status + membership), NOT gated on body.status being
  // present, so editing an ALREADY-published gallery while OMITTING status can't
  // slip a missing-alt image past the check (the raw-API bypass fix).
  const altError = effectivePublishAltError({
    bodyStatus: body.status,
    bodyIsGallery: body.isGallery,
    existingStatus: existing?.status,
    existingIsGallery: existing?.isGallery,
    writtenGallery:
      gallery !== undefined
        ? resolveEffectiveAlt(gallery, storedAlt).map((g) => ({
            mediaId: g.mediaId,
            alt: g.alt ?? "",
          }))
        : null,
    storedGallery: (existing?.gallery ?? []).map((g) => ({
      mediaId: g.mediaId,
      alt: g.alt,
    })),
  });
  if (altError) {
    return withNoStore(Response.json({ error: altError }, { status: 422 }));
  }

  // Issue 077: auto-import any external inline image in the (possibly edited)
  // body. Only runs when a body was actually sent — `undefined` means "leave
  // the stored body unchanged."
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
    type: "photo-post", // keep this row a photo post regardless of payload
    showInBlog: body.showInBlog,
    featured: body.featured,
    isGallery: body.isGallery,
    coverMediaId: body.coverMediaId,
    gallery,
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
    Response.json({
      id: updated.id,
      slug: updated.slug,
      status: updated.status,
      ...(imageImports.length > 0 ? { imageImports } : {}),
    }),
  );
}

// DELETE /api/admin/photos/posts/[id] — hard-delete a photo post. With
// ?deleteMedia=1, ALSO delete the post's now-unreferenced media (issue 056) so a
// deleted gallery does not leave its 26 photos orphaned in the library. The
// deletion is usage-aware: a photo still used by another post/page is kept, never
// silently orphaned. Without the flag this is the prior behavior (post only).
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
  const deleteMedia =
    new URL(request.url).searchParams.get("deleteMedia") === "1";
  const result = await deletePostWithMedia(db, getMediaStorage(), id, {
    deleteMedia,
  });
  return withNoStore(
    Response.json(
      { deletedMedia: result.deletedMedia, keptMedia: result.keptMedia },
      { status: 200 },
    ),
  );
}
