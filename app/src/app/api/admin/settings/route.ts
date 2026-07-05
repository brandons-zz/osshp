// GET /api/admin/settings — current values of the identity/branding settings.
// PATCH /api/admin/settings — update one or more identity/branding settings.
//
// Admin surface: the middleware requires a signed session to reach here; these
// handlers ALSO authoritatively validate the session (revocation/expiry).
// PATCH is CSRF-protected via guardMutation (host/origin comparison, A3).
//
// Only public-appropriate identity/branding settings are writable. Admin-only
// and secret keys are absent from SETTINGS_WRITABLE_KEYS and therefore rejected
// with 400 by construction — not by a blocklist that could drift.

import { getDb } from "@/lib/db/client";
import { getSetting, setSetting } from "@/lib/content/settings";
import {
  SETTINGS_WRITABLE_KEYS,
  SETTINGS_WRITABLE_VISIBILITY,
  sanitizeSettingValue,
} from "@/lib/content/settings-validate";
import { guardMutation } from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/platform";

/** GET /api/admin/settings — returns the current values of all writable settings. */
export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const keys = [...SETTINGS_WRITABLE_KEYS];
  const pairs = await Promise.all(
    keys.map(
      async (key) => [key, await getSetting(db, key)] as [string, unknown],
    ),
  );
  return Response.json(Object.fromEntries(pairs));
}

/**
 * PATCH /api/admin/settings — update one or more identity/branding settings.
 *
 * Body: `{ "setting.key": newValue, ... }` — partial updates are allowed.
 * Accent and font values are sanitized (clamped) before persistence; any key
 * not in SETTINGS_WRITABLE_KEYS is rejected with 400 before any write occurs.
 */
export const PATCH = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json(
      { error: "body must be a JSON object" },
      { status: 400 },
    );
  }

  // Validate and sanitize all keys before any write so the update is
  // all-or-nothing (a validation failure returns 400 with no partial writes).
  const updates: Array<{ key: string; value: unknown }> = [];
  for (const [key, raw] of Object.entries(body as Record<string, unknown>)) {
    if (!SETTINGS_WRITABLE_KEYS.has(key)) {
      return Response.json(
        { error: `unknown or non-editable setting key: ${key}` },
        { status: 400 },
      );
    }
    const result = sanitizeSettingValue(key, raw);
    if (result.error) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    updates.push({ key, value: result.value });
  }

  await Promise.all(
    updates.map(({ key, value }) =>
      setSetting(db, key, value, SETTINGS_WRITABLE_VISIBILITY),
    ),
  );
  return Response.json({ ok: true });
});
