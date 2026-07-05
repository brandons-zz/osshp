import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import type { SettingRow } from "../types";
import {
  CORE_SETTING_DEFAULTS,
  getPublicSettings,
  getSetting,
  listSettings,
  selectPublic,
  setSetting,
} from "../settings";

let h: TestDb;
let db: Db;

beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

test("getPublicSettings hides admin settings; admin view shows all", async () => {
  await setSetting(db, "site.title", "My Site", "public");
  await setSetting(db, "secrets.smtp", { user: "u", pass: "p" }, "admin");

  const publicView = await getPublicSettings(db);
  expect(publicView["site.title"]).toBe("My Site");
  // The admin/secret setting MUST NOT be in the theme-facing view.
  expect("secrets.smtp" in publicView).toBe(false);

  // It does still exist for the admin.
  const all = await listSettings(db);
  expect(all.find((s) => s.key === "secrets.smtp")?.value).toEqual({
    user: "u",
    pass: "p",
  });
});

test("a setting defaults to admin visibility when none is given (fail-safe)", async () => {
  // The DB column default is 'admin' (module-contract §3.4). Insert without a
  // visibility and confirm it is treated as admin → never public.
  await db.query(`INSERT INTO settings (key, value) VALUES ('x.secret', '"v"'::jsonb)`);
  const publicView = await getPublicSettings(db);
  expect("x.secret" in publicView).toBe(false);
});

test("setSetting round-trips JSON values and upserts visibility", async () => {
  await setSetting(db, "site.nav", [{ label: "Home", href: "/" }], "public");
  expect(await getSetting(db, "site.nav")).toEqual([{ label: "Home", href: "/" }]);

  // Re-set with a different visibility — upsert.
  await setSetting(db, "site.nav", [], "admin");
  expect("site.nav" in (await getPublicSettings(db))).toBe(false);
});

test("seeded core settings expose only the intended public keys", async () => {
  const seeded = await createTestDb({ seed: true });
  try {
    const publicView = await getPublicSettings(seeded.db);
    expect("site.title" in publicView).toBe(true);
    expect("branding.accent" in publicView).toBe(true);
    // Operational + secret defaults are admin-only.
    expect("site.enabledModules" in publicView).toBe(false);
    expect("site.activeTheme" in publicView).toBe(false);
    expect("secrets.smtp" in publicView).toBe(false);
  } finally {
    await seeded.close();
  }
});

test("selectPublic (pure) applies the same split without a database", () => {
  const rows: SettingRow[] = [
    { key: "a", value: 1, visibility: "public" },
    { key: "b", value: 2, visibility: "admin" },
  ];
  expect(selectPublic(rows)).toEqual({ a: 1 });
});

test("every core default declares an explicit visibility", () => {
  for (const s of CORE_SETTING_DEFAULTS) {
    expect(s.visibility === "public" || s.visibility === "admin").toBe(true);
  }
});
