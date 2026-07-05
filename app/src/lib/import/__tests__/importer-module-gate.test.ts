// Regression tests for issue 069 — POST /api/admin/import (via importSource,
// its single shared entry point for both the admin route and the CLI) must
// enforce module-enablement per item exactly like the blog/pages/photos admin
// content-API routes do (requireModuleEnabled, issue 028 NB-A). Run against
// pre-fix code, every test below fails: import always created/updated the
// item regardless of which module owns its content type.
//
// A real (PGlite) Postgres, no HTTP/route-handler plumbing — importSource
// takes only a Db, matching the module-gate.test.ts convention for the
// underlying requireModuleEnabled gate.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { getPageBySlug, getPostBySlug, listPages, listPosts } from "@/lib/content";
import { setSetting } from "@/lib/content/settings";
import type { MediaStorage, StoredObject } from "@/lib/media";
import { sourceFromSingleMarkdown, sourceFromTar } from "../source";
import { importSource } from "../importer";
import { buildTar } from "@/lib/export/tar";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";
import { PAGES_MODULE_ID } from "@/modules/pages/manifest";
import { PHOTOS_MODULE_ID } from "@/modules/photos/manifest";

class FakeMediaStorage implements MediaStorage {
  private readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  async ensureBucket(): Promise<void> {}
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }
  async get(key: string): Promise<StoredObject> {
    const obj = this.objects.get(key);
    if (!obj) throw new Error(`not found: ${key}`);
    return { stream: Readable.from([obj.body]), contentType: obj.contentType, size: obj.body.length };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

let h: TestDb;
let db: Db;
let storage: FakeMediaStorage;

// Fresh-install default: no module is enabled until the setup wizard or an
// admin toggle runs it through enableModule — each test sets its own scenario.
beforeEach(async () => {
  h = await createTestDb({ seed: true });
  db = h.db;
  storage = new FakeMediaStorage();
});
afterEach(() => h.close());

function md(fields: Record<string, unknown>, body: string): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

test("an article import is rejected with a per-item error when the Blog module is disabled", async () => {
  await setSetting(db, "site.enabledModules", [PHOTOS_MODULE_ID, PAGES_MODULE_ID], "admin");
  const file = md({ title: "Hello", slug: "hello", type: "article" }, "body");
  const { source } = sourceFromSingleMarkdown("hello.md", Buffer.from(file));

  const report = await importSource(db, storage, source, "skip");

  expect(report.createdCount).toBe(0);
  expect(report.errorCount).toBe(1);
  expect(report.items[0].outcome).toBe("error");
  expect(report.items[0].reason).toBe("the Blog module is disabled");
  expect(await getPostBySlug(db, "hello")).toBeNull();
});

test("a photo-post import is rejected with a per-item error when the Photos module is disabled (Blog enabled)", async () => {
  await setSetting(db, "site.enabledModules", [BLOG_MODULE_ID, PAGES_MODULE_ID], "admin");
  const file = md({ title: "Gallery", slug: "gallery", type: "photo-post" }, "body");
  const { source } = sourceFromSingleMarkdown("gallery.md", Buffer.from(file));

  const report = await importSource(db, storage, source, "skip");

  expect(report.createdCount).toBe(0);
  expect(report.errorCount).toBe(1);
  expect(report.items[0].reason).toBe("the Photos module is disabled");
  expect(await getPostBySlug(db, "gallery")).toBeNull();
});

test("a page import is rejected with a per-item error when the Pages module is disabled", async () => {
  await setSetting(db, "site.enabledModules", [BLOG_MODULE_ID, PHOTOS_MODULE_ID], "admin");
  const file = md({ title: "About", slug: "about", type: "page" }, "about body");
  const { source } = sourceFromSingleMarkdown("about.md", Buffer.from(file));

  const report = await importSource(db, storage, source, "skip");

  expect(report.createdCount).toBe(0);
  expect(report.errorCount).toBe(1);
  expect(report.items[0].reason).toBe("the Pages module is disabled");
  expect(await getPageBySlug(db, "about")).toBeNull();
});

test("with every module disabled (fresh install default), import of any content type is rejected", async () => {
  const file = md({ title: "Hello", slug: "hello", type: "article" }, "body");
  const { source } = sourceFromSingleMarkdown("hello.md", Buffer.from(file));

  const report = await importSource(db, storage, source, "skip");

  expect(report.errorCount).toBe(1);
  expect(report.items[0].reason).toBe("the Blog module is disabled");
});

test("a disabled module's item does not abort the batch — items for enabled modules still import (per-item, not per-batch)", async () => {
  await setSetting(db, "site.enabledModules", [BLOG_MODULE_ID], "admin");
  const tar = buildTar([
    { path: "posts/one.md", data: Buffer.from(md({ title: "One", slug: "one", type: "article" }, "body one")) },
    { path: "posts/two.md", data: Buffer.from(md({ title: "Two", slug: "two", type: "photo-post" }, "body two")) },
    { path: "pages/about.md", data: Buffer.from(md({ title: "About", slug: "about", type: "page" }, "about body")) },
  ]);
  const { source } = await sourceFromTar(tar);
  const report = await importSource(db, storage, source, "skip");

  expect(report.createdCount).toBe(1);
  expect(report.errorCount).toBe(2);
  const byPath = Object.fromEntries(report.items.map((i) => [i.path, i]));
  expect(byPath["posts/one.md"].outcome).toBe("created");
  expect(byPath["posts/two.md"].outcome).toBe("error");
  expect(byPath["posts/two.md"].reason).toBe("the Photos module is disabled");
  expect(byPath["pages/about.md"].outcome).toBe("error");
  expect(byPath["pages/about.md"].reason).toBe("the Pages module is disabled");

  expect((await listPosts(db)).length).toBe(1);
  expect((await listPages(db)).length).toBe(0);
});

test("re-enabling the owning module allows a subsequent import of the same content to succeed", async () => {
  const file = md({ title: "Hello", slug: "hello", type: "article" }, "body");
  const { source } = sourceFromSingleMarkdown("hello.md", Buffer.from(file));

  const firstReport = await importSource(db, storage, source, "skip");
  expect(firstReport.errorCount).toBe(1);
  expect(await getPostBySlug(db, "hello")).toBeNull();

  await setSetting(db, "site.enabledModules", [BLOG_MODULE_ID], "admin");
  const { source: source2 } = sourceFromSingleMarkdown("hello.md", Buffer.from(file));
  const secondReport = await importSource(db, storage, source2, "skip");

  expect(secondReport.createdCount).toBe(1);
  expect(secondReport.errorCount).toBe(0);
  expect(await getPostBySlug(db, "hello")).not.toBeNull();
});
