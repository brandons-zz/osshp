// POST /api/admin/blog/posts — create a Blog post (draft or published).
//
// Admin surface: not on the public allowlist, so the default-deny middleware
// already requires a validly-signed session to reach here; this handler ALSO
// authoritatively validates the session (revocation/expiry, not just signature).
// Creating a post directly as "published" stamps publishDate so it is immediately
// reachable on the public site (the published-only theme boundary keys on status).

import { getDb } from "@/lib/db/client";
import { createPost } from "@/lib/content/posts";
import type { ContentStatus, ImageRef, PostType } from "@/lib/content/types";
import { guardMutation } from "@/lib/auth";
import { getSessionFromRequest, requireModuleEnabled } from "@/lib/platform";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";

interface CreateBody {
  title?: string;
  slug?: string;
  body?: string;
  excerpt?: string;
  type?: PostType;
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
    type: body.type ?? "article",
    featured: body.featured ?? false,
    status,
    publishDate: resolvePublishDate(status, body.publishDate),
    coverImage: body.coverImage ?? null,
    tags: body.tags ?? [],
  });
  return Response.json({ id: post.id, slug: post.slug }, { status: 201 });
});
