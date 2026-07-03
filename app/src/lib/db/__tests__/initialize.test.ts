// Tests the startup migration fix (Defect #2 from M1.10 gate).
//
// DEFECT: initializeDatabase() existed in client.ts but was never called on any
// startup path, so a fresh deployment 500s on the first DB-touching request
// (the admin_user table does not exist yet).
//
// FIX: src/instrumentation.ts calls initializeDatabase() on the "nodejs" runtime
// before the first request, so migrations auto-run on server boot.
//
// This test verifies the BEHAVIOUR — not the instrumentation wiring (which is
// runtime-only and cannot be unit-driven). It does so by running the exact same
// logic initializeDatabase() delegates to (migrate + seedCoreSettings) against a
// fresh PGlite database, then asserting that the first "real" DB query succeeds
// (rather than throwing "relation does not exist").
//
// We drive migrate + seedCoreSettings directly here rather than importing from
// client.ts so that the test never touches the postgres.js driver or DATABASE_URL
// (which are not available in the test environment). initializeDatabase() is a
// two-line wrapper:
//
//   export async function initializeDatabase(db: Db = getDb()): Promise<void> {
//     await migrate(db);
//     await seedCoreSettings(db);
//   }
//
// Testing its two constituents on a test Db is a faithful behavioural proxy.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "../types";
import { migrate } from "../migrate";
import { seedCoreSettings } from "@/lib/content/settings";

let pg: PGlite;
let db: Db;

beforeEach(() => {
  pg = new PGlite();
  db = {
    query: async <Row = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<Row[]> => {
      const result = await pg.query<Row>(text, params as unknown[]);
      return result.rows;
    },
  };
});

afterEach(() => pg.close());

test("fresh-DB first request succeeds — admin_user query does not throw", async () => {
  // Before migrations: this query would throw "relation 'admin_user' does not exist".
  // After initializeDatabase equivalent: it succeeds with an empty result set.
  await migrate(db);
  await seedCoreSettings(db);

  // This is the exact query a first DB-touching request makes on the root route
  // (via isBootstrapAvailable → checks admin_user count). It must not throw.
  const rows = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM admin_user`,
  );
  expect(rows).toHaveLength(1);
  expect(Number(rows[0]!.count)).toBe(0);
});

test("idempotent — safe to call on an already-migrated DB (no-op restart)", async () => {
  // First boot: apply migrations.
  await migrate(db);
  await seedCoreSettings(db);

  // Second boot (server restart on an already-migrated DB): must not throw.
  await expect(
    (async () => {
      await migrate(db);
      await seedCoreSettings(db);
    })(),
  ).resolves.toBeUndefined();

  // Schema is still correct — no corruption from the second run.
  const rows = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM admin_user`,
  );
  expect(Number(rows[0]!.count)).toBe(0);
});

test("without migrations, querying admin_user throws — verifies the defect was real", async () => {
  // On a fresh (un-migrated) DB the table does not exist; the first request would
  // have 500'd. This test documents the pre-fix broken state.
  let threw = false;
  try {
    await db.query(`SELECT COUNT(*) AS count FROM admin_user`);
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});
