// Module registry + manifest validation (module-contract §3, §4).
//
// The registry is the single place the core reads a module: it validates each
// manifest, NORMALIZES the security-critical fields to their fail-closed defaults
// at registration (route access → admin, settings visibility → admin), and stores
// the result. A manifest that fails validation is registered but flagged invalid
// with its errors — it is never enabled and never mounts a capability (§4). The
// fail-closed resolution happening here, at registration, is what makes "forgot
// to set access" a safe failure rather than an open admin route (§3.1 rule 1).

import { CONTENT_TARGET_IDS, THEME_SLOT_IDS } from "@/lib/theme/types";
import type {
  ModuleManifest,
  ModuleRoute,
  ModuleSettingsField,
  NormalizedRoute,
  NormalizedSettingsField,
  RouteAccess,
} from "./types";
import type { SettingVisibility } from "@/lib/content/types";

const ID_RX = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Resolve a route's access fail-closed: anything that is not exactly the string
 * "public" becomes "admin" (deny). This is the load-bearing security clause
 * (§3.1 rule 1) — exported so it can be unit-tested directly.
 */
export function resolveRouteAccess(access: unknown): RouteAccess {
  return access === "public" ? "public" : "admin";
}

/**
 * Resolve a settings field's visibility fail-closed: anything other than "public"
 * becomes "admin" (§3.4). Keeps an admin/secret field from leaking to a theme.
 */
export function resolveFieldVisibility(visibility: unknown): SettingVisibility {
  return visibility === "public" ? "public" : "admin";
}

function normalizeRoute(route: ModuleRoute): NormalizedRoute {
  return { ...route, access: resolveRouteAccess(route.access) };
}

function normalizeField(field: ModuleSettingsField): NormalizedSettingsField {
  return { ...field, visibility: resolveFieldVisibility(field.visibility) };
}

/** A module after registration: the manifest, its normalized capability views,
 *  and a validity verdict the admin module list surfaces (§4). */
export interface RegisteredModule {
  manifest: ModuleManifest;
  /** Routes with access resolved (fail-closed). */
  routes: NormalizedRoute[];
  /** Settings fields with visibility resolved (fail-closed). */
  settingsFields: NormalizedSettingsField[];
  valid: boolean;
  errors: string[];
}

/**
 * Validate a single manifest in isolation (namespace, admin-nav targets, content
 * render targets, theme-hook slots). Returns the error list — empty means valid.
 * Cross-module checks (path collisions) live in the registry's register(), which
 * is the only place that can see sibling modules.
 */
export function validateManifest(manifest: ModuleManifest): string[] {
  const errors: string[] = [];
  const id = manifest.id;

  if (!id || !ID_RX.test(id)) {
    errors.push(`Module id "${id}" must be a lowercase slug ([a-z0-9-]).`);
    // Namespace checks below derive from id; without a valid id they are noise.
    return errors;
  }

  const routes = manifest.routes ?? [];
  const adminBase = `/admin/${id}`;
  const seenPaths = new Set<string>();

  for (const route of routes) {
    const access = resolveRouteAccess(route.access);
    if (seenPaths.has(route.path)) {
      errors.push(`Duplicate route path "${route.path}".`);
    }
    seenPaths.add(route.path);

    if (access === "admin") {
      // Load-bearing: an admin route must live under THIS module's admin
      // namespace — no /admin/* land-grab of the core or another module (§3.1.2).
      if (route.path !== adminBase && !route.path.startsWith(`${adminBase}/`)) {
        errors.push(
          `Admin route "${route.path}" must be under "${adminBase}".`,
        );
      }
    } else {
      // A public route must never live under the admin tree — that would smuggle
      // an admin surface in as unauthenticated. (NOTE: §3.1.2's example phrasing
      // "public paths under /<id>/*" is contradicted by its own worked Blog
      // example, which registers a public "/tag/[slug]" outside "/blog"; the
      // enforceable, non-averaged rule is therefore "public routes are not under
      // /admin", with cross-module collisions caught in register().)
      if (route.path === "/admin" || route.path.startsWith("/admin/")) {
        errors.push(
          `Public route "${route.path}" must not be under "/admin".`,
        );
      }
    }
  }

  // Admin-nav hrefs must point at one of THIS module's own admin routes (§3.2).
  const adminRoutePaths = new Set(
    routes
      .filter((r) => resolveRouteAccess(r.access) === "admin")
      .map((r) => r.path),
  );
  for (const entry of manifest.adminNav ?? []) {
    if (!adminRoutePaths.has(entry.href)) {
      errors.push(
        `Admin-nav href "${entry.href}" does not match an admin route of this module.`,
      );
    }
  }

  // A core-render-target content type must map onto a real theme render target
  // (§3.3); a new shape requires a coordinated theme-contract enum append, not a
  // private mechanism, so an unknown target is rejected here.
  for (const ct of manifest.contentTypes ?? []) {
    if (
      ct.publicRender.mode === "core-render-target" &&
      !CONTENT_TARGET_IDS.includes(ct.publicRender.target)
    ) {
      errors.push(
        `Content type "${ct.id}" maps to unknown render target "${ct.publicRender.target}".`,
      );
    }
  }

  // Theme hooks plug into the EXISTING slot registry only — a slot must be a real
  // ThemeSlotId from the M1.4 theme layer (§3.5). No parallel slot vocabulary.
  for (const hook of manifest.themeHooks ?? []) {
    if (!THEME_SLOT_IDS.includes(hook.slot)) {
      errors.push(`Theme hook targets unknown slot "${hook.slot}".`);
    }
  }

  return errors;
}

export interface ModuleRegistry {
  /** Validate + normalize + store a manifest; returns its registered record. */
  register(manifest: ModuleManifest): RegisteredModule;
  get(id: string): RegisteredModule | undefined;
  has(id: string): boolean;
  list(): RegisteredModule[];
}

export function createModuleRegistry(
  initial: readonly ModuleManifest[] = [],
): ModuleRegistry {
  const modules = new Map<string, RegisteredModule>();

  const register = (manifest: ModuleManifest): RegisteredModule => {
    const errors = validateManifest(manifest);

    // Cross-module: a route path already claimed by a different registered module
    // is a namespace collision (§3.1.2). Only the registry can see siblings.
    const ownPaths = manifest.routes ?? [];
    for (const route of ownPaths) {
      for (const other of modules.values()) {
        if (other.manifest.id === manifest.id) continue;
        if (other.routes.some((r) => r.path === route.path)) {
          errors.push(
            `Route path "${route.path}" collides with module "${other.manifest.id}".`,
          );
        }
      }
    }

    const record: RegisteredModule = {
      manifest,
      routes: (manifest.routes ?? []).map(normalizeRoute),
      settingsFields: (manifest.settings?.schema ?? []).map(normalizeField),
      valid: errors.length === 0,
      errors,
    };
    modules.set(manifest.id, record);
    return record;
  };

  for (const m of initial) register(m);

  return {
    register,
    get: (id) => modules.get(id),
    has: (id) => modules.has(id),
    list: () => [...modules.values()],
  };
}
