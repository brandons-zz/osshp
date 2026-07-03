// Shared row-mapping helpers.

/**
 * Normalize a TIMESTAMPTZ column to an ISO 8601 string. postgres.js returns a
 * Date; PGlite may return a Date or a string — handle both so the domain layer
 * always sees ISO strings regardless of the bound executor.
 */
export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value as string).toISOString();
}

/** Same as toIso but preserves null (for nullable timestamp columns). */
export function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}
