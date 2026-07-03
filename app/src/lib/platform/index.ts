// Platform wiring — the app singletons that bind the core seams together for the
// running app: the THEME registry (M1.4 swap seam) with the bundled skeleton theme,
// the MODULE registry (M1.5) with the Blog module, the public-site render path
// (build a public-only context → collect enabled modules' theme-hook slots →
// render through the active theme), and the admin capability projection + session
// helpers the admin shell uses.
//
// Server-only: imports the content stores, the theme engine, and the module
// system. Route handlers and admin server components import from here.

import { cookies } from "next/headers";
import type { Db } from "@/lib/db/types";
import { getDb } from "@/lib/db/client";
import { getSetting } from "@/lib/content/settings";
import {
  SESSION_COOKIE_NAME,
  readSessionCookie,
  validateSession,
  type SessionRecord,
} from "@/lib/auth/sessions";
import { withNoStore } from "@/lib/auth/csrf";
import {
  createThemeRegistry,
  selectActiveTheme,
  type ThemeRegistry,
} from "@/lib/theme/registry";
import type { ThemeManifest } from "@/lib/theme/types";
import {
  createModuleRegistry,
  getActiveCapabilities,
  getEnabledModuleIds,
  isEnabled,
  type ActiveCapabilities,
  type ModuleRegistry,
} from "@/lib/module";
import { editorialTheme } from "@/themes/editorial/theme";
import { skeletonTheme } from "@/themes/skeleton/theme";
import { blogModule } from "@/modules/blog/manifest";
import { pagesModule } from "@/modules/pages/manifest";
import { photosModule } from "@/modules/photos/manifest";

// ── Singletons (cached on globalThis so dev hot-reload reuses one instance) ───

const ACTIVE_THEME_SETTING = "site.activeTheme";

const g = globalThis as unknown as {
  __osshpThemeRegistry?: ThemeRegistry;
  __osshpModuleRegistry?: ModuleRegistry;
};

/** The theme registry, seeded with every bundled theme. "editorial" is the
 *  polished reference theme an operator gets out of the box (the default
 *  `site.activeTheme`); the skeleton remains registered as a fallback. */
export function getThemeRegistry(): ThemeRegistry {
  if (!g.__osshpThemeRegistry) {
    g.__osshpThemeRegistry = createThemeRegistry([editorialTheme, skeletonTheme]);
  }
  return g.__osshpThemeRegistry;
}

/** The module registry, seeded with every bundled module. */
export function getModuleRegistry(): ModuleRegistry {
  if (!g.__osshpModuleRegistry) {
    g.__osshpModuleRegistry = createModuleRegistry([
      blogModule,
      pagesModule,
      photosModule,
    ]);
  }
  return g.__osshpModuleRegistry;
}

/** Resolve the active theme from settings, falling back to the first registered
 *  theme so the site always renders even if the active id is stale (§4). */
export async function getActiveTheme(db: Db): Promise<ThemeManifest> {
  const activeId = await getSetting<string>(db, ACTIVE_THEME_SETTING);
  const theme = selectActiveTheme(getThemeRegistry(), activeId);
  if (!theme) throw new Error("No theme registered.");
  return theme;
}

// The public-site render path (renderPublicRoute) lives in ./render — it imports
// react-dom/server, which Next forbids in any module reachable from the component
// graph, and this module IS reachable from the admin server components. Keeping it
// separate lets the admin shell import the registries/session helpers here without
// dragging react-dom/server into the component graph.

/** True iff the named module is enabled — gates a module's public routes. */
export async function isModuleEnabled(db: Db, id: string): Promise<boolean> {
  return isEnabled(await getEnabledModuleIds(db), id);
}

/**
 * Enforce that a module is enabled before an admin content-API handler
 * proceeds — returns a 404 (no-store) "as if it doesn't exist" Response when
 * disabled, matching the module's own public routes and admin UI (§3.1 rule
 * 4), or null when the caller may continue. Every module-owned admin
 * content-API handler (create/edit/delete) calls this right after session
 * validation. Closes issue 028 NB-A: a disabled module's admin content-API
 * previously stayed functional (session + CSRF checked, module state never
 * consulted) even though its public routes and admin UI already went inert —
 * not an authz bypass under single-admin, but a completeness gap.
 */
export async function requireModuleEnabled(
  db: Db,
  moduleId: string,
  moduleName: string,
): Promise<Response | null> {
  if (await isModuleEnabled(db, moduleId)) return null;
  return withNoStore(
    Response.json(
      { error: `the ${moduleName} module is disabled` },
      { status: 404 },
    ),
  );
}

// ── Admin capability projection + session helpers ────────────────────────────

/** The live capability set (routes/admin-nav/content-types/settings) from the
 *  enabled, valid modules — the admin shell mounts exactly this (§5 rule 1). */
export async function getEnabledCapabilities(
  db: Db,
): Promise<ActiveCapabilities> {
  const enabled = await getEnabledModuleIds(db);
  return getActiveCapabilities(getModuleRegistry(), enabled);
}

/**
 * Authoritatively resolve the current admin session from the request cookie
 * (revocation + expiry, not just the middleware's stateless signature check).
 * Returns null when unauthenticated. API route handlers use this.
 */
export async function getSessionFromRequest(
  db: Db,
  request: Request,
): Promise<SessionRecord | null> {
  return validateSession(db, readSessionCookie(request));
}

/**
 * Server-component variant: resolve the admin session from the request cookies
 * (next/headers). Returns null when unauthenticated — admin pages redirect to
 * /login in that case.
 */
export async function getAdminSession(): Promise<SessionRecord | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value ?? null;
  return validateSession(getDb(), token);
}
