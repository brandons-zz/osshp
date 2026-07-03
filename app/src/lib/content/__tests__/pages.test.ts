import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import {
  createPage,
  deletePage,
  getPageBySlug,
  getPublishedPageBySlug,
  listPages,
  listPublishedPagesForNav,
  updatePage,
} from "../pages";

let h: TestDb;
let db: Db;

beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

test("round-trips a page", async () => {
  const created = await createPage(db, {
    title: "About",
    slug: "about",
    body: "About me",
    status: "published",
  });
  const fetched = await getPageBySlug(db, "about");
  expect(fetched!.id).toBe(created.id);
  expect(fetched!.body).toBe("About me");
  expect((await listPages(db)).length).toBe(1);
});

test("published-only read excludes a draft page", async () => {
  await createPage(db, { title: "Hidden", slug: "hidden", body: "x", status: "draft" });
  expect(await getPublishedPageBySlug(db, "hidden")).toBeNull();
  // Admin read still sees it.
  expect(await getPageBySlug(db, "hidden")).not.toBeNull();
});

test("updatePage edits fields; deletePage removes the row", async () => {
  const page = await createPage(db, { title: "T", slug: "t", body: "x" });
  await updatePage(db, page.id, { title: "T2", status: "published" });
  const after = await getPageBySlug(db, "t");
  expect(after!.title).toBe("T2");
  expect(after!.status).toBe("published");

  expect(await deletePage(db, page.id)).toBe(true);
  expect(await getPageBySlug(db, "t")).toBeNull();
});

test("showInNav defaults false; updatePage can toggle it", async () => {
  const page = await createPage(db, {
    title: "My Page",
    slug: "my-page",
    body: "x",
    status: "published",
  });
  expect(page.showInNav).toBe(false);

  await updatePage(db, page.id, { showInNav: true });
  const updated = await getPageBySlug(db, "my-page");
  expect(updated!.showInNav).toBe(true);
});

test("listPublishedPagesForNav returns only published pages with showInNav=true", async () => {
  await createPage(db, {
    title: "Draft Nav",
    slug: "draft-nav",
    body: "x",
    status: "draft",
    showInNav: true, // draft — should NOT appear
  });
  await createPage(db, {
    title: "Published No Nav",
    slug: "pub-no-nav",
    body: "x",
    status: "published",
    showInNav: false,
  });
  await createPage(db, {
    title: "Published In Nav",
    slug: "pub-in-nav",
    body: "x",
    status: "published",
    showInNav: true,
  });

  const navPages = await listPublishedPagesForNav(db);
  const titles = navPages.map((p) => p.title);
  expect(titles).toContain("Published In Nav");
  expect(titles).not.toContain("Draft Nav");
  expect(titles).not.toContain("Published No Nav");
});
