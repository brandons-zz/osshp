// /admin/tags — the tag-management surface (tag-management feature). A CORE
// admin surface: tags are shared by Blog and Photos posts, so — like
// /admin/media — it is a static admin-nav link (AdminNav.tsx), not projected
// from a single module's adminNav.
//
// Server component reading every tag + its post count (all statuses, not
// just published — an operator managing tags needs to see everything,
// including a tag that only appears on a draft). Hands off to the client
// TagsManager for rename/merge/delete interaction.

import { getDb } from "@/lib/db/client";
import { listTagsWithCounts } from "@/lib/content/tags";
import { TagsManager } from "./TagsManager";

export default async function TagsAdminPage() {
  const rows = await listTagsWithCounts(getDb());
  return (
    <TagsManager
      initialTags={rows.map(({ tag, count }) => ({ ...tag, count }))}
    />
  );
}
