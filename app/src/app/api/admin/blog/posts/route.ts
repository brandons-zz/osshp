// POST /api/admin/blog/posts — create a Blog post (draft or published).
//
// Admin surface: not on the public allowlist, so the default-deny middleware
// already requires a validly-signed session to reach here; this handler ALSO
// authoritatively validates the session (revocation/expiry, not just signature).
// Creating a post directly as "published" stamps publishDate so it is immediately
// reachable on the public site (the published-only theme boundary keys on status).

import { getDb } from "@/lib/db/client";
import { createPost } from "@/lib/content/posts";
import type { ContentStatus, ImageRef } from "@/lib/content/types";
import { guardMutation } from "@/lib/auth";
import { getSessionFromRequest, requireModuleEnabled } from "@/lib/platform";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";
import { validateTitleSlugLength } from "@/lib/content/limits";
import { autoImportExternalImages, getMediaStorage } from "@/lib/media";

// No `type` field: this route owns articles only (issue 071, mirroring the
// photos create route's own `type: "photo-post"` — always forced, never
// client-controlled). A raw request cannot create a `photo-post` row through
// the blog route regardless of what it sends; that content type belongs to
// the Photos route (issue 051 "each route owns its content type"), which
// also runs the publish-time gallery alt gate this route has no knowledge of.
interface CreateBody {
  title?: string;
  slug?: string;
  body?: string;
  excerpt?: string;
  status?: ContentStatus;
  publishDate?: string | null;
  coverImage?: ImageRef | null;
  tags?: Array<{ name: string; slug: string }>;
  /** Feature this post in the home "Selected" showcase (issue 012). Default false. */
  featured?: boolean;
}

// Resolve publish_date from the requested status (publish/schedule wiring):
//   published → now (stamp immediately so it is reachable on the public site)
//   scheduled → the requested future date (required)
//   draft     → null
function resolvePublishDate(
  status: ContentStatus,
  requested: string | null | undefined,
): string | null {
  if (status === "published") return requested ?? new Date().toISOString();
  if (status === "scheduled") return requested ?? null;
  return null;
}

// Mutating route — guardMutation-wrapped (CSRF, no-store). The default-deny
// middleware requires a signed session to reach here; this also authoritatively
// validates it (revocation/expiry).
export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const disabledGate = await requireModuleEnabled(db, BLOG_MODULE_ID, "Blog");
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
  // Issue 077: auto-import any external inline image (`![alt](https://…)`) into
  // the media library so it renders under the strict img-src CSP; failures
  // never abort the save — the original URL is left in place and reported.
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
    type: "article", // this module owns articles only, regardless of the body (issue 071)
    featured: body.featured ?? false,
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
