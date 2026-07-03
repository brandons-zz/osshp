// The single database executor seam.
//
// Every content/settings store depends only on this interface — never on a
// concrete client. Production binds it to `postgres` (postgres.js); tests bind
// it to an in-process PGlite (real PostgreSQL compiled to WASM) so the exact
// same SQL is exercised in the pre-push gate with no external service. The
// dependency-injection seam is deliberate: it keeps the stores client-agnostic
// and the tests dialect-identical to production.

export interface Db {
  /**
   * Run a parameterized SQL statement and return the result rows.
   * Use `$1`, `$2`, … placeholders. JSONB values are passed as JSON text and
   * cast with `$n::jsonb` in the statement (portable across both adapters).
   */
  query<Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<Row[]>;
}
