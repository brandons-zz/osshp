// Blog-route type guard (issue 051).
//
// The blog PATCH/DELETE routes may only operate on `type='article'` rows. A
// photo/gallery post edited through the blog route would bypass the photos
// route's publish-time alt gate (issue 047's effectivePublishAltError) — the
// blog route has no gallery-alt validation of its own and previously had no
// type restriction either, so a raw-client PATCH could status-flip a
// missing-alt gallery straight to published. Restricting this route to
// articles closes that cross-route hole: a photo/gallery post must always be
// edited via the photos route, where the alt gate runs.
import type { Post } from "@/lib/content/types";

/** True only for an existing `article` row — the shape the blog route may
 *  edit or delete. `null` (not found) and any non-article type are refused. */
export function isBlogArticle(existing: Pick<Post, "type"> | null): boolean {
  return existing !== null && existing.type === "article";
}
