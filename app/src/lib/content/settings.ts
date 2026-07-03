// Settings store — key / value / visibility.
//
// The public/admin split is the theme boundary. visibility defaults to 'admin'
// (module-contract §3.4: absent/unrecognized → admin, the fail-safe default), so
// a setting can only ever reach a theme if it was explicitly marked 'public'.
// getPublicSettings() filters at the SQL level; selectPublic() is the same rule
// as a pure function, so the boundary can be unit-tested without a database.

import type { Db } from "@/lib/db/types";
import type { SettingRow, SettingVisibility } from "./types";

interface RawSettingRow {
  key: string;
  value: unknown;
  visibility: SettingVisibility;
}

/** Pure projection: keep only public settings as a key→value map. */
export function selectPublic(
  rows: readonly SettingRow[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.visibility === "public") out[row.key] = row.value;
  }
  return out;
}

export async function setSetting(
  db: Db,
  key: string,
  value: unknown,
  visibility: SettingVisibility,
): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, visibility) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, visibility = EXCLUDED.visibility`,
    [key, JSON.stringify(value), visibility],
  );
}

export async function getSetting<T = unknown>(
  db: Db,
  key: string,
): Promise<T | undefined> {
  const rows = await db.query<{ value: T }>(
    `SELECT value FROM settings WHERE key = $1`,
    [key],
  );
  return rows[0]?.value;
}

/** Admin view — every setting, both visibilities. */
export async function listSettings(db: Db): Promise<SettingRow[]> {
  const rows = await db.query<RawSettingRow>(
    `SELECT key, value, visibility FROM settings ORDER BY key`,
  );
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    visibility: r.visibility,
  }));
}

/**
 * Theme-facing view — ONLY public settings, as a key→value map. The admin user
 * record, secrets, and admin-only settings are unreachable through this call by
 * construction (theme-rendering-contract §3.1 public-only boundary).
 */
export async function getPublicSettings(
  db: Db,
): Promise<Record<string, unknown>> {
  const rows = await db.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings WHERE visibility = 'public' ORDER BY key`,
  );
  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

/**
 * Core settings defaults (spec §8 Settings model). Public fields are the ones
 * the theme legitimately needs (site identity, branding, nav, social). Admin
 * fields (active theme, enabled modules, secrets) never reach a theme.
 */
export const CORE_SETTING_DEFAULTS: ReadonlyArray<{
  key: string;
  value: unknown;
  visibility: SettingVisibility;
}> = [
  // ── Public: site identity & chrome ──
  { key: "site.title", value: "", visibility: "public" },
  { key: "site.description", value: "", visibility: "public" },
  // Home-page intro/lead (issue 012). Rendered as the serif-italic deck under the
  // home title; unset (empty) ⇒ the deck is omitted with no fallback. Distinct
  // from site.description (the masthead runline + SEO fallback) by design.
  { key: "home.intro", value: "", visibility: "public" },
  { key: "site.locale", value: "en", visibility: "public" },
  { key: "site.nav", value: [], visibility: "public" },
  { key: "site.social", value: [], visibility: "public" },
  { key: "site.logo", value: null, visibility: "public" },
  // ── Public: branding (consumed by the app AA-guardrail → theme) ──
  { key: "branding.accent", value: "#2563eb", visibility: "public" },
  { key: "branding.fontHeading", value: null, visibility: "public" },
  { key: "branding.fontBody", value: null, visibility: "public" },
  { key: "branding.defaultScheme", value: "auto", visibility: "public" },
  // ── Admin: operational (never served to a theme) ──
  { key: "site.activeTheme", value: "editorial", visibility: "admin" },
  { key: "site.enabledModules", value: [], visibility: "admin" },
  // ── Admin: secret-bearing (never served to a theme) ──
  { key: "secrets.smtp", value: null, visibility: "admin" },
];

/** Idempotently insert the core defaults — safe to run on every boot. */
export async function seedCoreSettings(db: Db): Promise<void> {
  for (const s of CORE_SETTING_DEFAULTS) {
    await db.query(
      `INSERT INTO settings (key, value, visibility) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO NOTHING`,
      [s.key, JSON.stringify(s.value), s.visibility],
    );
  }
}
