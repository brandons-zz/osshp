// Test-only Db binding backed by PGlite (PostgreSQL compiled to WASM, in-process).
//
// This lets the content/settings stores be exercised against real PostgreSQL SQL
// in `bun test` with no external database — the pre-push gate stays self-contained
// while testing the exact dialect production runs. Imported ONLY by test files, so
// PGlite is never traced into the app bundle.

import { PGlite } from "@electric-sql/pglite";
import type { Db } from "./types";
import { migrate } from "./migrate";
import { seedCoreSettings } from "@/lib/content/settings";

export interface TestDb {
  db: Db;
  close: () => Promise<void>;
}

/**
 * Fresh in-memory PostgreSQL with the schema migrated. Pass { seed: true } to
 * also insert the core settings defaults.
 */
export async function createTestDb(
  opts: { seed?: boolean } = {},
): Promise<TestDb> {
  const pg = new PGlite();
  const db: Db = {
    query: async <Row = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<Row[]> => {
      const result = await pg.query<Row>(text, params as unknown[]);
      return result.rows;
    },
  };
  await migrate(db);
  if (opts.seed) await seedCoreSettings(db);
  return { db, close: () => pg.close() };
}
