// GET /api/admin/modules — the registered, valid modules + which are enabled.
// PATCH /api/admin/modules — set the enabled module set (issue 027).
//
// Deliberately a DEDICATED route, not a key on the generic /api/admin/settings
// allowlist: `site.enabledModules` is admin-visibility (never reaches a theme,
// settings.ts CORE_SETTING_DEFAULTS + lifecycle.ts) and toggling it must run each
// module's onEnable/onDisable lifecycle hook (module-contract §5) — a blanket
// array overwrite through the public-settings sanitizer would bypass both. The
// actual validation + write logic is `setEnabledModules` (lifecycle.ts), built on
// the same `enableModule`/`disableModule` the setup wizard's module step calls
// (api/setup/route.ts) — this route is a thin HTTP wrapper over it, testable at
// the lib layer without HTTP/DB fixtures (module/__tests__/lifecycle.test.ts).
//
// Admin surface: the middleware requires a signed session to reach here; this
// handler ALSO authoritatively validates the session (revocation/expiry). PATCH
// is CSRF-protected via guardMutation (host/origin comparison, A3).

import { getDb } from "@/lib/db/client";
import { getEnabledModuleIds, setEnabledModules } from "@/lib/module";
import { guardMutation } from "@/lib/auth";
import { getModuleRegistry, getSessionFromRequest } from "@/lib/platform";

/** GET /api/admin/modules — registered modules + current enabled state. */
export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const enabled = new Set(await getEnabledModuleIds(db));
  const modules = getModuleRegistry()
    .list()
    .filter((m) => m.valid)
    .map((m) => ({
      id: m.manifest.id,
      name: m.manifest.name,
      description: m.manifest.description,
      enabled: enabled.has(m.manifest.id),
    }));
  return Response.json({ modules });
}

interface PatchBody {
  enabled?: unknown;
}

/**
 * PATCH /api/admin/modules — body `{ enabled: string[] }` is the FULL desired
 * enabled set (not a delta). `setEnabledModules` rejects the whole request with
 * 400 (no partial writes) if any id is not a registered, valid module; otherwise
 * it enables newly-added ids, disables dropped ids (onEnable/onDisable each run;
 * disable preserves data — module-contract §5 rule 2), and leaves unchanged ids
 * alone.
 */
export const PATCH = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.enabled) || body.enabled.some((v) => typeof v !== "string")) {
    return Response.json(
      { error: "enabled must be an array of module id strings" },
      { status: 400 },
    );
  }

  const result = await setEnabledModules(db, getModuleRegistry(), body.enabled as string[]);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }
  return Response.json({ ok: true, enabled: result.enabled });
});
