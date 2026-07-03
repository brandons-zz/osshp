// Production database client — binds the Db seam to postgres.js.
//
// Server-only. The connection is cached on globalThis so Next.js dev hot-reload
// does not open a new pool on every recompile. After applying a new migration in
// dev, restart the dev server: a cached connection holds a snapshot of the
// schema from when it was opened.

import postgres from "postgres";
import type { Db } from "./types";
import { config } from "@/lib/config";
import { migrate } from "./migrate";
import { seedCoreSettings } from "@/lib/content/settings";

type Sql = ReturnType<typeof postgres>;

const globalForDb = globalThis as unknown as { __osshpSql?: Sql };

function rawSql(): Sql {
  if (!globalForDb.__osshpSql) {
    globalForDb.__osshpSql = postgres(config.databaseUrl);
  }
  return globalForDb.__osshpSql;
}

let cachedDb: Db | null = null;

// PostgreSQL json / jsonb OIDs. Under Bun, postgres.js's built-in json parser does
// not fire for these via sql.unsafe (jsonb columns come back as raw JSON TEXT),
// whereas the PGlite test adapter returns them already parsed. To keep production
// behavior identical to the test gate — every store expects parsed jsonb (settings
// values, post tag arrays, media responsive sizes, admin credential arrays) — the
// seam parses json/jsonb string columns itself, exactly as the built-in parser
// would. Plain text columns are left untouched.
const JSON_OIDS = new Set([114, 3802]);

/** A postgres.js result: a row array that also carries column type metadata. */
export interface PgResult extends Array<Record<string, unknown>> {
  columns?: ReadonlyArray<{ name: string; type: number }>;
}

/**
 * Replicate postgres.js's built-in json/jsonb parser (which does not fire under
 * Bun via sql.unsafe): JSON.parse every json/jsonb string column in place, by the
 * result's own column type OIDs. Mutates and returns the same array. Text columns,
 * already-parsed (non-string) values, and (defensively) non-JSON strings are left
 * untouched. Exported for direct unit testing — this is the production/PGlite
 * parity fix surfaced by the M1.8 runtime smoke.
 */
export function applyJsonColumnParsers(result: PgResult): PgResult {
  const jsonCols = (result.columns ?? [])
    .filter((c) => JSON_OIDS.has(c.type))
    .map((c) => c.name);
  if (jsonCols.length === 0) return result;
  for (const row of result) {
    for (const name of jsonCols) {
      const v = row[name];
      if (typeof v === "string") {
        try {
          row[name] = JSON.parse(v);
        } catch {
          // Leave a non-JSON string as-is (defensive; should not happen).
        }
      }
    }
  }
  return result;
}

/** The shared Db handle for the running app. */
export function getDb(): Db {
  if (cachedDb) return cachedDb;
  const sql = rawSql();
  cachedDb = {
    query: async <Row = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<Row[]> => {
      const result = (await sql.unsafe(
        text,
        params as never[],
      )) as unknown as PgResult;
      return applyJsonColumnParsers(result) as unknown as Row[];
    },
  };
  return cachedDb;
}

/**
 * Bring the database to the current schema and seed core settings. Idempotent
 * and safe to call on every server boot (migrate() no-ops when current).
 */
export async function initializeDatabase(db: Db = getDb()): Promise<void> {
  await migrate(db);
  await seedCoreSettings(db);
}
