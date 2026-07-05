// Analytics module-disabled gate (issue 029 acceptance evidence) — the exact primitive the
// dashboard page (app/admin/analytics/page.tsx) calls to decide whether to render
// its inert "module is disabled" message instead of the dashboard. Same layer/
// pattern as module-gate.test.ts (requireModuleEnabled) for blog/pages/photos.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import { isModuleEnabled } from "../index";
import { ANALYTICS_MODULE_ID } from "@/modules/analytics/manifest";
import { setSetting } from "@/lib/content/settings";

let h: TestDb;
beforeEach(async () => {
  h = await createTestDb({ seed: true });
});
afterEach(() => h.close());

test("isModuleEnabled(analytics) is false on a fresh install (nothing enabled yet)", async () => {
  expect(await isModuleEnabled(h.db, ANALYTICS_MODULE_ID)).toBe(false);
});

test("isModuleEnabled(analytics) is true once analytics is in the enabled set", async () => {
  await setSetting(h.db, "site.enabledModules", [ANALYTICS_MODULE_ID], "admin");
  expect(await isModuleEnabled(h.db, ANALYTICS_MODULE_ID)).toBe(true);
});

test("disabling analytics after it was enabled flips the gate back to false", async () => {
  await setSetting(h.db, "site.enabledModules", [ANALYTICS_MODULE_ID], "admin");
  expect(await isModuleEnabled(h.db, ANALYTICS_MODULE_ID)).toBe(true);

  await setSetting(h.db, "site.enabledModules", [], "admin");
  expect(await isModuleEnabled(h.db, ANALYTICS_MODULE_ID)).toBe(false);
});
