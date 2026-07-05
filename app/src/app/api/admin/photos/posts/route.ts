// POST /api/admin/photos/posts — create a photo post (draft, published, or
// scheduled). Photo posts share the core `posts` table with blog articles; this
// route forces type='photo-post' so the post surfaces in the Photos grid.
//
// Admin surface: not on the public allowlist, so the default-deny middleware
// already requires a validly-signed session to reach here; this handler ALSO
// authoritatively validates it (revocation/expiry). guardMutation-wrapped (CSRF,
// no-store). Cover media is uploaded separately through /api/admin/media (the M2.9
// pipeline → EXIF/GPS stripped by default); the cover URL renders as the grid tile.

import { getDb } from "@/lib/db/client";
import { createPost } from "@/lib/content/posts";
import type { ContentStatus, ImageRef } from "@/lib/content/types";
import { guardMutation } from "@/lib/auth";
import { getSessionFromRequest, requireModuleEnabled } from "@/lib/platform";
import { PHOTOS_MODULE_ID } from "@/modules/photos/manifest";
import { validateTitleSlugLength } from "@/lib/content/limits";
import { autoImportExternalImages, getMediaStorage } from "@/lib/media";
import {
  normalizeGallery,
  galleryTooLarge,
  checkGalleryMedia,
  resolveEffectiveAlt,
  galleryPublishAltError,
  MAX_GALLERY_SIZE,
} from "./_gallery";

interface CreateBody {
  title?: string;
  slug?: string;
  body?: string;
  excerpt?: string;
  status?: ContentStatus;
  publishDate?: string | null;
  coverImage?: ImageRef | null;
  tags?: Array<{ name: string; slug: string }>;
  /** When true, opts this photo-post into the /blog listing stream. Default false. */
  showInBlog?: boolean;
  /** Feature this photo-post in the home "Selected" showcase (issue 012). Default false. */
  featured?: boolean;
  /** Gallery mode (issue 047): mark this a gallery photo post. Default false. */
  isGallery?: boolean;
  /** Gallery only: chosen cover media id (null/omitted ⇒ first image). */
  coverMediaId?: string | null;
  /** Gallery only: the ordered images to persist. */
  gallery?: unknown;
}

// published → stamp now (reachable immediately); scheduled → the requested future
// date (required); draft → null.
function resolvePublishDate(
  status: ContentStatus,
  requested: string | null | undefined,
): string | null {
  if (status === "published") return requested ?? new Date().toISOString();
  if (status === "scheduled") return requested ?? null;
  return null;
}

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const disabledGate = await requireModuleEnabled(db, PHOTOS_MODULE_ID, "Photos");
  if (disabledGate) return disabledGate;
  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const title = body.title?.trim();
  const slug = body.slug?.trim();
  if (!title || !slug) {
    return Response.json(
      { error: "title and slug are required" },
      { status: 400 },
    );
  }
  const lengthError = validateTitleSlugLength(title, slug);
  if (lengthError) {
    return Response.json({ error: lengthError }, { status: 400 });
  }
  const status: ContentStatus = body.status ?? "draft";
  if (status === "scheduled" && !body.publishDate) {
    return Response.json(
      { error: "publishDate is required when scheduling" },
      { status: 400 },
    );
  }
  const isGallery = body.isGallery ?? false;
  const gallery = normalizeGallery(body.gallery);
  // Server-side hard cap — a raw request must not submit an unbounded array.
  if (galleryTooLarge(gallery)) {
    return Response.json(
      { error: `A gallery can hold at most ${MAX_GALLERY_SIZE} photographs.` },
      { status: 400 },
    );
  }
  // Validate referenced media EXISTS before writing (clean 4xx, never a 500),
  // and resolve effective alt (payload alt else the media row's stored alt).
  let effectiveGallery: typeof gallery = gallery ?? (isGallery ? [] : undefined);
  if (gallery && gallery.length > 0) {
    const check = await checkGalleryMedia(db, gallery);
    if (check.error) {
      return Response.json({ error: check.error }, { status: 400 });
    }
    effectiveGallery = resolveEffectiveAlt(gallery, check.storedAlt);
  }
  // AA 1.1.1: a gallery cannot be published/scheduled with any image missing alt.
  const altError = galleryPublishAltError(status, isGallery, effectiveGallery);
  if (altError) {
    return Response.json({ error: altError }, { status: 422 });
  }
  // Issue 077: auto-import any external inline image before persisting.
  const { body: importedBody, report: imageImports } = await autoImportExternalImages(
    db,
    getMediaStorage(),
    body.body ?? "",
  );
  const post = await createPost(db, {
    title,
    slug,
    body: importedBody,
    excerpt: body.excerpt?.trim() || "",
    type: "photo-post", // this module owns photo posts, regardless of the body
    showInBlog: body.showInBlog ?? false,
    featured: body.featured ?? false,
    isGallery,
    coverMediaId: body.coverMediaId ?? null,
    gallery,
    status,
    publishDate: resolvePublishDate(status, body.publishDate),
    coverImage: body.coverImage ?? null,
    tags: body.tags ?? [],
  });
  return Response.json(
    {
      id: post.id,
      slug: post.slug,
      ...(imageImports.length > 0 ? { imageImports } : {}),
    },
    { status: 201 },
  );
});
