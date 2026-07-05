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
  const query = async <Row = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<Row[]> => {
    const result = await pg.query<Row>(text, params as unknown[]);
    return result.rows;
  };
  const db: Db = {
    query,
    // PGlite is a single in-process connection, so BEGIN/COMMIT/ROLLBACK issued
    // as plain statements form a real transaction (no pool to split across).
    // Mirrors the production postgres.js `sql.begin` semantics for tests.
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      await query("BEGIN");
      try {
        const result = await fn(db);
        await query("COMMIT");
        return result;
      } catch (e) {
        await query("ROLLBACK");
        throw e;
      }
    },
  };
  await migrate(db);
  if (opts.seed) await seedCoreSettings(db);
  return { db, close: () => pg.close() };
}
