import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { ensureTag, getTagBySlug, listTags, listPublishedTagCounts } from "../tags";
import { createPost } from "../posts";

let h: TestDb;
let db: Db;

beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

test("ensureTag is get-or-create by slug (no duplicate rows)", async () => {
  const first = await ensureTag(db, "Docker", "docker");
  const second = await ensureTag(db, "Docker", "docker");
  expect(second.id).toBe(first.id);
  expect((await listTags(db)).length).toBe(1);
});

test("ensureTag refreshes the name on an existing slug", async () => {
  await ensureTag(db, "Mac", "macos");
  const updated = await ensureTag(db, "macOS", "macos");
  expect(updated.name).toBe("macOS");
  expect((await getTagBySlug(db, "macos"))!.name).toBe("macOS");
});

test("getTagBySlug returns null for an unknown slug", async () => {
  expect(await getTagBySlug(db, "nope")).toBeNull();
});

// ── listPublishedTagCounts — the /tags index source (issue 061) ─────────────

test("listPublishedTagCounts counts only VISIBLE posts per tag, alphabetically", async () => {
  await createPost(db, {
    title: "Post A",
    slug: "post-a",
    body: "x",
    status: "published",
    publishDate: "2026-06-01T00:00:00.000Z",
    tags: [{ name: "Docker", slug: "docker" }],
  });
  await createPost(db, {
    title: "Post B",
    slug: "post-b",
    body: "x",
    status: "published",
    publishDate: "2026-06-02T00:00:00.000Z",
    tags: [
      { name: "Docker", slug: "docker" },
      { name: "Bash", slug: "bash" },
    ],
  });

  const counts = await listPublishedTagCounts(db);
  // Alphabetical by tag name (matches listPublishedPages' "ORDER BY title").
  expect(counts.map((c) => c.tag.slug)).toEqual(["bash", "docker"]);
  expect(counts.find((c) => c.tag.slug === "docker")!.count).toBe(2);
  expect(counts.find((c) => c.tag.slug === "bash")!.count).toBe(1);
});

test("listPublishedTagCounts drops a tag whose only posts are draft or future-scheduled", async () => {
  await ensureTag(db, "Orphan", "orphan");
  await createPost(db, {
    title: "Draft post",
    slug: "draft-post",
    body: "x",
    status: "draft",
    tags: [{ name: "Orphan", slug: "orphan" }],
  });
  await createPost(db, {
    title: "Future post",
    slug: "future-post",
    body: "x",
    status: "scheduled",
    publishDate: "2099-01-01T00:00:00.000Z",
    tags: [{ name: "Orphan", slug: "orphan" }],
  });

  // The tag row itself exists (ensureTag + both posts attach it), but neither
  // post is VISIBLE, so it must not appear in the index — a tag with a "0"
  // count would be a dead-end link, worse than omitting it entirely.
  expect(await listPublishedTagCounts(db)).toEqual([]);
});

test("listPublishedTagCounts includes a past-scheduled post's tags (auto-reveal, matches listPublishedPosts)", async () => {
  await createPost(db, {
    title: "Past scheduled",
    slug: "past-scheduled",
    body: "x",
    status: "scheduled",
    publishDate: "2020-01-01T00:00:00.000Z",
    tags: [{ name: "Utah", slug: "utah" }],
  });

  const counts = await listPublishedTagCounts(db);
  expect(counts).toEqual([{ tag: { id: counts[0]!.tag.id, name: "Utah", slug: "utah" }, count: 1 }]);
});
