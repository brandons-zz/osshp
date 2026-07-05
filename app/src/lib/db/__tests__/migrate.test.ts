import { afterEach, beforeEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "../types";
import { migrate } from "../migrate";

let pg: PGlite;
let db: Db;

beforeEach(() => {
  pg = new PGlite();
  db = {
    query: async (text, params = []) =>
      (await pg.query(text, params as unknown[])).rows as never[],
  };
});

afterEach(() => pg.close());

test("first run applies the init migration", async () => {
  const ran = await migrate(db);
  expect(ran).toContain("0001_content_and_settings_core");

  // All §8 tables exist after migration.
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const names = new Set(tables.map((t) => t.table_name));
  for (const t of [
    "posts",
    "tags",
    "post_tags",
    "pages",
    "media",
    "settings",
    "admin_user",
    "schema_migrations",
    "analytics_events",
  ]) {
    expect(names.has(t)).toBe(true);
  }
});

test("is idempotent and restart-safe — re-running is a no-op", async () => {
  await migrate(db);
  // Second call (simulating a dev-server restart) must not throw and must
  // report zero migrations run, because the first run is already recorded.
  const ranAgain = await migrate(db);
  expect(ranAgain).toEqual([]);

  // A third call is still safe.
  const ranThird = await migrate(db);
  expect(ranThird).toEqual([]);
});
