// POST /api/setup — finish the first-run setup wizard's config steps: name/brand
// the site and choose which modules are enabled, then mark setup complete.
//
// The admin-provision step (passkey enrollment) is the single-use bootstrap
// (M1.6 NO-GO #1); by the time this route is called the operator is already
// authenticated (the bootstrap ceremony issued a session). This route is NOT on
// the public allowlist, so the default-deny middleware requires that session;
// the handler re-validates it. Re-running these config writes while authenticated
// is harmless (it is the admin editing settings) — the un-re-runnable part is
// admin provisioning, which the bootstrap gate owns.

import { getDb } from "@/lib/db/client";
import { guardMutation, recordAuthEvent } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/content/settings";
import { enableModule, getEnabledModuleIds } from "@/lib/module";
import { getModuleRegistry, getSessionFromRequest } from "@/lib/platform";

/** GET /api/setup — the bundled modules the wizard offers + current state. */
export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const available = getModuleRegistry()
    .list()
    .filter((m) => m.valid)
    .map((m) => ({
      id: m.manifest.id,
      name: m.manifest.name,
      description: m.manifest.description,
      defaultEnabled: m.manifest.defaultEnabled ?? false,
    }));
  const setupComplete = (await getSetting<boolean>(db, "site.setupComplete")) ?? false;
  const enabled = await getEnabledModuleIds(db);
  return Response.json({ available, enabled, setupComplete });
}

interface SetupBody {
  title?: string;
  description?: string;
  accent?: string;
  modules?: string[];
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  let body: SetupBody;
  try {
    body = (await request.json()) as SetupBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const title = (body.title ?? "").trim();
  if (!title) {
    return Response.json({ error: "site title is required" }, { status: 400 });
  }

  await setSetting(db, "site.title", title, "public");
  await setSetting(db, "site.description", (body.description ?? "").trim(), "public");
  if (body.accent && HEX_RE.test(body.accent)) {
    await setSetting(db, "branding.accent", body.accent, "public");
  }

  // Enable the chosen modules through the single toggle (runs each onEnable).
  const registry = getModuleRegistry();
  const chosen = Array.isArray(body.modules) ? body.modules : [];
  for (const mod of registry.list()) {
    if (chosen.includes(mod.manifest.id) && mod.valid) {
      await enableModule(db, registry, mod.manifest.id);
    }
  }

  await setSetting(db, "site.setupComplete", true, "admin");
  recordAuthEvent("setup.complete", "success", { db, request });
  return Response.json({ ok: true });
});
