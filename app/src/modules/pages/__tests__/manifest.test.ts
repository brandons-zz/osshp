// Pages manifest — registers clean and classifies routes correctly. Verifies
// intent: the page content type maps to the theme's fixed `page` render target;
// public reading routes are public; admin authoring routes are admin/deny;
// disable preserves data (module lifecycle contract §5).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import {
  createModuleRegistry,
  getActiveCapabilities,
  enableModule,
  disableModule,
  getEnabledModuleIds,
} from "@/lib/module";
import { createPage, getPageBySlug, listPages } from "@/lib/content/pages";
import { pagesModule, PAGES_MODULE_ID } from "../manifest";

test("pages manifest registers with zero validation errors", () => {
  const registry = createModuleRegistry([pagesModule]);
  const mod = registry.get(PAGES_MODULE_ID);
  expect(mod).toBeDefined();
  expect(mod!.errors).toEqual([]);
  expect(mod!.valid).toBe(true);
});

test("public page reading route is public; admin authoring routes are admin/deny", () => {
  const registry = createModuleRegistry([pagesModule]);
  const routes = registry.get(PAGES_MODULE_ID)!.routes;
  const byPath = Object.fromEntries(routes.map((r) => [r.path, r.access]));

  // Public reading surface renders through the theme.
  expect(byPath["/pages/[slug]"]).toBe("public");

  // Admin authoring surfaces are admin — the /admin/pages listing omits access
  // (the default-deny fail-safe must resolve it to admin, not public).
  expect(byPath["/admin/pages"]).toBe("admin");
  expect(byPath["/admin/pages/new"]).toBe("admin");
  expect(byPath["/admin/pages/[id]/edit"]).toBe("admin");
});

test("enabled pages contributes its admin nav; disabled contributes nothing", () => {
  const registry = createModuleRegistry([pagesModule]);
  expect(
    getActiveCapabilities(registry, [PAGES_MODULE_ID]).adminNav,
  ).toHaveLength(1);
  expect(getActiveCapabilities(registry, []).adminNav).toHaveLength(0);
});

test("page content type maps to the theme's fixed `page` render target", () => {
  const registry = createModuleRegistry([pagesModule]);
  const mod = registry.get(PAGES_MODULE_ID)!;
  const pageType = mod.manifest.contentTypes?.find((ct) => ct.id === "page");
  expect(pageType).toBeDefined();
  expect(pageType!.publicRender).toEqual({
    mode: "core-render-target",
    target: "page",
  });
});

// ── Disable-preserves-data (module-contract §5 rule 2) ────────────────────────

let h: TestDb;
let db: Db;

beforeEach(async () => {
  h = await createTestDb({ seed: true });
  db = h.db;
});
afterEach(() => h.close());

test("disabling pages module preserves page data; re-enabling brings it back", async () => {
  const registry = createModuleRegistry([pagesModule]);

  // Enable the module and write a page through the content store.
  await enableModule(db, registry, PAGES_MODULE_ID);
  await createPage(db, {
    title: "About",
    slug: "about",
    body: "# About\n\nHello world.",
    status: "published",
  });
  expect(await listPages(db)).toHaveLength(1);

  // Disable the module.
  await disableModule(db, registry, PAGES_MODULE_ID);

  // The toggle no longer lists it.
  expect(await getEnabledModuleIds(db)).not.toContain(PAGES_MODULE_ID);

  // BUT the page data is untouched — disable never deletes content (§5 rule 2).
  expect(await listPages(db)).toHaveLength(1);
  const page = await getPageBySlug(db, "about");
  expect(page).not.toBeNull();
  expect(page!.title).toBe("About");

  // Re-enabling restores the module with its data intact.
  await enableModule(db, registry, PAGES_MODULE_ID);
  expect(await getEnabledModuleIds(db)).toContain(PAGES_MODULE_ID);
  expect(await listPages(db)).toHaveLength(1);
});
