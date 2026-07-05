// requireModuleEnabled (issue 028 NB-A) — the shared gate every module-owned
// admin content-API handler (blog/photos posts, pages, and their [id] variants)
// calls right after session validation. Verified at the same layer as
// isModuleEnabled/getEnabledModuleIds it's built on: a real (PGlite) Postgres,
// no HTTP/route-handler plumbing needed since the gate takes only a Db.
//
// This is the regression test for issue 028's "Also in scope" NB-A finding: a
// disabled module's admin content-API previously stayed functional (session +
// CSRF checked, module state never consulted) even though its public routes
// and admin UI already went inert. Run against pre-fix code (no
// requireModuleEnabled export, routes never call it) this test fails to even
// import — a hard, unambiguous fail-on-old.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import { setSetting } from "@/lib/content/settings";
import { requireModuleEnabled } from "../index";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";
import { PHOTOS_MODULE_ID } from "@/modules/photos/manifest";
import { PAGES_MODULE_ID } from "@/modules/pages/manifest";

let h: TestDb;
beforeEach(async () => {
  // seed: true inserts core setting defaults, incl. site.enabledModules=[] (no
  // module is enabled until the setup wizard or admin toggle runs it through
  // enableModule) — tests set the enabled set explicitly per scenario.
  h = await createTestDb({ seed: true });
});
afterEach(() => h.close());

test("requireModuleEnabled returns null (proceed) when the module is enabled", async () => {
  await setSetting(h.db, "site.enabledModules", [BLOG_MODULE_ID], "admin");
  const gate = await requireModuleEnabled(h.db, BLOG_MODULE_ID, "Blog");
  expect(gate).toBeNull();
});

test("requireModuleEnabled returns a 404 no-store Response when NO module is enabled (fresh install default)", async () => {
  const gate = await requireModuleEnabled(h.db, BLOG_MODULE_ID, "Blog");
  expect(gate).not.toBeNull();
  expect(gate!.status).toBe(404);
});

test("requireModuleEnabled returns a 404 no-store Response when the module is disabled", async () => {
  await setSetting(h.db, "site.enabledModules", [PHOTOS_MODULE_ID, PAGES_MODULE_ID], "admin");

  const gate = await requireModuleEnabled(h.db, BLOG_MODULE_ID, "Blog");
  expect(gate).not.toBeNull();
  expect(gate!.status).toBe(404);
  expect(gate!.headers.get("cache-control")).toBe("no-store");
  const json = (await gate!.json()) as { error: string };
  expect(json.error).toBe("the Blog module is disabled");
});

test("re-enabling the module restores the gate to null (proceed)", async () => {
  await setSetting(h.db, "site.enabledModules", [PHOTOS_MODULE_ID, PAGES_MODULE_ID], "admin");
  expect((await requireModuleEnabled(h.db, BLOG_MODULE_ID, "Blog"))).not.toBeNull();

  await setSetting(h.db, "site.enabledModules", [BLOG_MODULE_ID, PHOTOS_MODULE_ID, PAGES_MODULE_ID], "admin");
  expect(await requireModuleEnabled(h.db, BLOG_MODULE_ID, "Blog")).toBeNull();
});

test("each module gates independently — disabling Photos does not affect Blog or Pages", async () => {
  await setSetting(h.db, "site.enabledModules", [BLOG_MODULE_ID, PAGES_MODULE_ID], "admin");

  expect(await requireModuleEnabled(h.db, BLOG_MODULE_ID, "Blog")).toBeNull();
  expect(await requireModuleEnabled(h.db, PAGES_MODULE_ID, "Pages")).toBeNull();
  const photosGate = await requireModuleEnabled(h.db, PHOTOS_MODULE_ID, "Photos");
  expect(photosGate).not.toBeNull();
  expect(photosGate!.status).toBe(404);
});
