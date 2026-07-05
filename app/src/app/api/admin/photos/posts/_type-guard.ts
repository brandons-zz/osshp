// Photos-route type guard (issue 071, mirroring the blog route's
// `isBlogArticle` from issue 051).
//
// The photos PATCH route forces `type: "photo-post"` on every write, but
// before this guard it never checked what the row being edited WAS before
// that write — an existing `article` row's id could be PATCHed through this
// route and be silently converted in place into a gallery photo-post, never
// having passed through the photos route's own creation path (or the Blog
// module's enablement state, which this route's gate doesn't consult).
// Restricting this route to existing photo-posts closes that cross-route
// hole: an article must always be edited via the blog route, and a
// photo-post via this one.
import type { Post } from "@/lib/content/types";

/** True only for an existing `photo-post` row — the shape this route may
 *  edit. `null` (not found) and any non-photo-post type are refused. */
export function isPhotoPost(existing: Pick<Post, "type"> | null): boolean {
  return existing !== null && existing.type === "photo-post";
}
