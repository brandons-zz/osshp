import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { ensureTag, getTagBySlug, listTags } from "../tags";

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
