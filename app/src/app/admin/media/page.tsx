// /admin/media — the media library (issue 037 §2). A CORE admin surface: the
// `media` table is shared by Blog, Photos, and Pages, so it is a static admin-nav
// link (added in admin/layout.tsx), not projected from a module's adminNav.
//
// Server component: the admin layout already enforces the session; this reads the
// media store + all content once and computes usage counts (§5 scan) for the
// initial render, then hands off to the client MediaLibrary for interaction. No
// image-first flash — the grid is server-rendered.

import { getDb } from "@/lib/db/client";
import { listMediaWithUsage } from "@/lib/content/media-usage";
import { MediaLibrary } from "./MediaLibrary";

export default async function MediaAdminPage() {
  // Gallery-aware usage counts (issues 056/057): shared with GET /api/admin/media
  // via one helper so the SSR first paint and the API never disagree — a
  // gallery-only photo reads "Used", not "Unused".
  const items = await listMediaWithUsage(getDb());
  return <MediaLibrary initialItems={items} />;
}
