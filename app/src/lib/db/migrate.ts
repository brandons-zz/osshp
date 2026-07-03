// Migration runner — idempotent and dev-server-restart-safe.
//
// Tracks applied migrations in schema_migrations. Re-running migrate() on every
// boot is a no-op once all migrations have been applied. Combined with the
// IF NOT EXISTS statements in each migration, the schema converges safely even
// if the tracking table is lost.

import type { Db } from "./types";
import { MIGRATIONS } from "./migrations";

const TRACKING_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/**
 * Apply any migrations not yet recorded. Returns the ids that were run this
 * call (empty array when the schema is already current).
 */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(TRACKING_TABLE);

  const appliedRows = await db.query<{ id: string }>(
    `SELECT id FROM schema_migrations`,
  );
  const applied = new Set(appliedRows.map((r) => r.id));

  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    for (const statement of migration.statements) {
      await db.query(statement);
    }
    await db.query(
      `INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [migration.id],
    );
    ran.push(migration.id);
  }
  return ran;
}
