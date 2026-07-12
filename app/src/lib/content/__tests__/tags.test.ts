import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import {
  ensureTag,
  getTagBySlug,
  getTagById,
  listTags,
  listPublishedTagCounts,
  listTagsWithCounts,
  searchTags,
  renameTag,
  mergeTags,
  deleteTag,
  validateTagName,
  TAG_NAME_MAX_LENGTH,
} from "../tags";
import { createPost, getPostById } from "../posts";

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

// ── validateTagName ──────────────────────────────────────────────────────────

test("validateTagName rejects empty/whitespace-only names", () => {
  expect(validateTagName("")).not.toBeNull();
  expect(validateTagName("   ")).not.toBeNull();
});

test("validateTagName rejects a name over the max length", () => {
  expect(validateTagName("a".repeat(TAG_NAME_MAX_LENGTH + 1))).not.toBeNull();
  expect(validateTagName("a".repeat(TAG_NAME_MAX_LENGTH))).toBeNull();
});

test("validateTagName rejects a name that slugifies to nothing", () => {
  expect(validateTagName("!!!")).not.toBeNull();
});

test("validateTagName accepts an ordinary name", () => {
  expect(validateTagName("Self-Hosting")).toBeNull();
});

// ── searchTags — the editor combobox's typeahead source ─────────────────────

test("searchTags matches case-insensitively and substring, ordered by name", async () => {
  await ensureTag(db, "Docker", "docker");
  await ensureTag(db, "Kubernetes", "kubernetes");
  await ensureTag(db, "Docker Compose", "docker-compose");

  const results = await searchTags(db, "dock");
  expect(results.map((t) => t.slug).sort()).toEqual(["docker", "docker-compose"]);
});

test("searchTags treats % and _ in the query as literal characters, not wildcards", async () => {
  await ensureTag(db, "100% Open Source", "100-open-source");
  await ensureTag(db, "Docker", "docker");

  // A naive, unescaped ILIKE '%<query>%' would treat the user's own "%" as a
  // wildcard and match every tag; escaping means only the literal-% tag hits.
  const results = await searchTags(db, "100%");
  expect(results.map((t) => t.slug)).toEqual(["100-open-source"]);
});

test("searchTags respects the limit", async () => {
  for (let i = 0; i < 12; i++) {
    await ensureTag(db, `Tag ${i}`, `tag-${i}`);
  }
  expect((await searchTags(db, "tag", 5)).length).toBe(5);
});

test("searchTags surfaces an existing tag whose spelling differs only by hyphens/spaces/case", async () => {
  // The whole point of the typeahead: prevent a self-hosting/selfhosting fork.
  await ensureTag(db, "Self-Hosting", "self-hosting");

  // Every separator/case variant of the query must find the existing tag —
  // a plain substring ILIKE misses "selfhosting" because the stored name has
  // a hyphen.
  for (const variant of ["selfhosting", "self hosting", "SELFHOSTING", "Self-Hosting"]) {
    const results = await searchTags(db, variant);
    expect(results.map((t) => t.slug)).toContain("self-hosting");
  }
});

test("searchTags does NOT match a genuinely different word (normalization is not fuzzy matching)", async () => {
  await ensureTag(db, "Self-Hosting", "self-hosting");
  // "selfhostel" normalizes to "selfhostel", which is not a substring of
  // "selfhosting" — so the existing tag is correctly NOT surfaced, leaving the
  // combobox free to offer "Create tag".
  expect(await searchTags(db, "selfhostel")).toEqual([]);
});

// ── listTagsWithCounts — the /admin/tags list ────────────────────────────────

test("listTagsWithCounts includes a tag with zero posts (unlike the published-only view)", async () => {
  await ensureTag(db, "Unused", "unused");
  const rows = await listTagsWithCounts(db);
  expect(rows).toEqual([{ tag: { id: rows[0]!.tag.id, name: "Unused", slug: "unused" }, count: 0 }]);
});

test("listTagsWithCounts counts posts of every status, not just published", async () => {
  await createPost(db, {
    title: "Draft",
    slug: "draft-x",
    body: "x",
    status: "draft",
    tags: [{ name: "WIP", slug: "wip" }],
  });
  const rows = await listTagsWithCounts(db);
  expect(rows.find((r) => r.tag.slug === "wip")!.count).toBe(1);
});

// ── renameTag ────────────────────────────────────────────────────────────────

test("renameTag updates the name/slug and every post using it reflects the change", async () => {
  const post1 = await createPost(db, {
    title: "P1",
    slug: "p1",
    body: "x",
    status: "draft",
    tags: [{ name: "selfhosting", slug: "selfhosting" }],
  });
  const post2 = await createPost(db, {
    title: "P2",
    slug: "p2",
    body: "x",
    status: "draft",
    tags: [{ name: "selfhosting", slug: "selfhosting" }],
  });
  const tag = (await getTagBySlug(db, "selfhosting"))!;

  const result = await renameTag(db, tag.id, "Self-Hosting");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.tag.name).toBe("Self-Hosting");
  expect(result.tag.slug).toBe("self-hosting");

  // Both posts resolve the renamed tag — no per-post rewrite needed, and no
  // dangling reference to the old slug.
  const p1After = await getPostById(db, post1.id);
  const p2After = await getPostById(db, post2.id);
  expect(p1After!.tags).toEqual([{ id: tag.id, name: "Self-Hosting", slug: "self-hosting" }]);
  expect(p2After!.tags).toEqual([{ id: tag.id, name: "Self-Hosting", slug: "self-hosting" }]);
  expect(await getTagBySlug(db, "selfhosting")).toBeNull();
});

test("renameTag refuses (does not merge) when the new name collides with a DIFFERENT existing tag", async () => {
  const dell = await ensureTag(db, "Dell", "dell");
  await ensureTag(db, "Lenovo", "lenovo");

  const result = await renameTag(db, dell.id, "Lenovo");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.reason).toBe("collision");
  if (result.reason !== "collision") throw new Error("unreachable");
  expect(result.existing.slug).toBe("lenovo");

  // Refusing means BOTH tags still exist, untouched — a blocked rename must
  // never partially apply.
  expect(await getTagBySlug(db, "dell")).not.toBeNull();
  expect(await getTagBySlug(db, "lenovo")).not.toBeNull();
});

test("renameTag allows a no-op slug (cosmetic name-only change)", async () => {
  const tag = await ensureTag(db, "docker", "docker");
  const result = await renameTag(db, tag.id, "Docker");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.tag.slug).toBe("docker");
});

test("renameTag returns not-found for an unknown id", async () => {
  const result = await renameTag(db, "00000000-0000-0000-0000-000000000000", "X");
  expect(result).toEqual({ ok: false, reason: "not-found" });
});

// ── mergeTags — data-integrity crux: no orphan/dup post_tags rows ────────────

async function postTagRows(db: Db, tagId: string): Promise<string[]> {
  const rows = await db.query<{ post_id: string }>(
    `SELECT post_id FROM post_tags WHERE tag_id = $1`,
    [tagId],
  );
  return rows.map((r) => r.post_id);
}

test("mergeTags moves every post from source to target with no duplicate post_tags rows", async () => {
  const dellOnly = await createPost(db, {
    title: "Dell only",
    slug: "dell-only",
    body: "x",
    status: "draft",
    tags: [{ name: "Dell", slug: "dell" }],
  });
  const both = await createPost(db, {
    title: "Both",
    slug: "both",
    body: "x",
    status: "draft",
    // Already tagged with BOTH — the case that would create a duplicate
    // post_tags row if merge didn't dedupe on insert.
    tags: [
      { name: "Dell", slug: "dell" },
      { name: "Lenovo", slug: "lenovo" },
    ],
  });
  const dell = (await getTagBySlug(db, "dell"))!;
  const lenovo = (await getTagBySlug(db, "lenovo"))!;

  const result = await mergeTags(db, dell.id, lenovo.id);
  expect(result).toEqual({ ok: true, affectedPosts: 2 });

  // Source tag is gone entirely.
  expect(await getTagById(db, dell.id)).toBeNull();

  // Target has exactly one post_tags row per post — no duplicates.
  const targetRows = await postTagRows(db, lenovo.id);
  expect(targetRows.sort()).toEqual([both.id, dellOnly.id].sort());
  expect(new Set(targetRows).size).toBe(targetRows.length); // no dup rows

  // Both posts now show Lenovo (and Lenovo only, once, on the shared post).
  const dellOnlyAfter = await getPostById(db, dellOnly.id);
  const bothAfter = await getPostById(db, both.id);
  expect(dellOnlyAfter!.tags.map((t) => t.slug)).toEqual(["lenovo"]);
  expect(bothAfter!.tags.map((t) => t.slug)).toEqual(["lenovo"]);
});

test("mergeTags refuses merging a tag into itself", async () => {
  const tag = await ensureTag(db, "Solo", "solo");
  const result = await mergeTags(db, tag.id, tag.id);
  expect(result).toEqual({ ok: false, reason: "same-tag" });
  expect(await getTagById(db, tag.id)).not.toBeNull(); // untouched
});

test("mergeTags returns not-found when either id is unknown", async () => {
  const tag = await ensureTag(db, "Real", "real");
  const bogus = "00000000-0000-0000-0000-000000000000";
  expect(await mergeTags(db, bogus, tag.id)).toEqual({ ok: false, reason: "not-found" });
  expect(await mergeTags(db, tag.id, bogus)).toEqual({ ok: false, reason: "not-found" });
});

test("mergeTags on a source tag with zero posts still deletes it cleanly", async () => {
  const empty = await ensureTag(db, "Empty", "empty");
  const target = await ensureTag(db, "Target", "target");
  const result = await mergeTags(db, empty.id, target.id);
  expect(result).toEqual({ ok: true, affectedPosts: 0 });
  expect(await getTagById(db, empty.id)).toBeNull();
});

// ── deleteTag — post↔tag associations cleared, posts untouched ──────────────

test("deleteTag clears the tag from every post but leaves the posts intact", async () => {
  const post = await createPost(db, {
    title: "Tagged post",
    slug: "tagged-post",
    body: "hello",
    status: "draft",
    tags: [
      { name: "Keep", slug: "keep" },
      { name: "DropMe", slug: "dropme" },
    ],
  });
  const dropMe = (await getTagBySlug(db, "dropme"))!;

  const result = await deleteTag(db, dropMe.id);
  expect(result).toEqual({ affectedPosts: 1 });

  expect(await getTagById(db, dropMe.id)).toBeNull();
  expect(await postTagRows(db, dropMe.id)).toEqual([]);

  const after = await getPostById(db, post.id);
  expect(after).not.toBeNull(); // the post itself is untouched
  expect(after!.title).toBe("Tagged post");
  expect(after!.tags.map((t) => t.slug)).toEqual(["keep"]);
});

test("deleteTag returns null for an unknown id (no-op, not an error)", async () => {
  expect(await deleteTag(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
});
