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
  const status: ContentStatus = body.status ?? "draft";
  if (status === "scheduled" && !body.publishDate) {
    return Response.json(
      { error: "publishDate is required when scheduling" },
      { status: 400 },
    );
  }
  const post = await createPost(db, {
    title,
    slug,
    body: body.body ?? "",
    excerpt: body.excerpt?.trim() || "",
    type: "photo-post", // this module owns photo posts, regardless of the body
    showInBlog: body.showInBlog ?? false,
    featured: body.featured ?? false,
    status,
    publishDate: resolvePublishDate(status, body.publishDate),
    coverImage: body.coverImage ?? null,
    tags: body.tags ?? [],
  });
  return Response.json({ id: post.id, slug: post.slug }, { status: 201 });
});
