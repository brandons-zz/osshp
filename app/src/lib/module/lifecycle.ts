// Module enable/disable lifecycle (module-contract §5).
//
// The set of enabled modules is a single admin setting — `site.enabledModules`
// (spec §8) — written by both the setup wizard and the admin module list. There
// is exactly one toggle (§5 rule 4). Enabling wires every capability; disabling
// un-wires them symmetrically while PRESERVING the module's data (§5 rule 2):
// disable only removes the id from the toggle list and runs the deactivation
// hook — the core never deletes the module's content or settings. The active
// capability views (routes, admin nav, content types, settings panels) and the
// theme-hook slot collection all read the enabled set, so a disabled module
// contributes nothing and is inert (§3.1 rule 4).
//
// Theme hooks plug into the EXISTING M1.4 slot registry: collectModuleSlots
// pipes the enabled modules' contributions through `collectSlots` from
// @/lib/theme — there is no parallel slot mechanism here (§3.5).

import type { Db } from "@/lib/db/types";
import { getSetting, setSetting } from "@/lib/content/settings";
import {
  collectSlots,
  type SlotContribution,
} from "@/lib/theme/registry";
import type { SanitizedSlotOutput, ThemeSlotId } from "@/lib/theme/types";
import type { ModuleRegistry } from "./registry";
import type {
  AdminNavEntry,
  ContentTypeDefinition,
  ModuleSettingsPanel,
  ModuleSlotContext,
  NormalizedRoute,
} from "./types";

/** The single enablement toggle (spec §8; matches the seeded settings key). */
export const ENABLED_MODULES_KEY = "site.enabledModules";

/** Read the enabled-module id list; missing/non-array → empty (nothing live). */
export async function getEnabledModuleIds(db: Db): Promise<string[]> {
  const ids = await getSetting<unknown>(db, ENABLED_MODULES_KEY);
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

/** enabledModules is admin-visibility — it must never reach a theme. */
async function setEnabledModuleIds(db: Db, ids: string[]): Promise<void> {
  await setSetting(db, ENABLED_MODULES_KEY, ids, "admin");
}

export function isEnabled(
  enabledIds: readonly string[],
  id: string,
): boolean {
  return enabledIds.includes(id);
}

/**
 * Enable a module: add it to the single toggle (idempotent) and run its onEnable
 * hook. Refuses unknown or invalid modules — an invalid manifest never mounts (§4).
 */
export async function enableModule(
  db: Db,
  registry: ModuleRegistry,
  id: string,
): Promise<void> {
  const mod = registry.get(id);
  if (!mod) throw new Error(`Cannot enable unknown module "${id}".`);
  if (!mod.valid) {
    throw new Error(
      `Cannot enable invalid module "${id}": ${mod.errors.join("; ")}`,
    );
  }
  const ids = await getEnabledModuleIds(db);
  if (!ids.includes(id)) await setEnabledModuleIds(db, [...ids, id]);
  await mod.manifest.lifecycle?.onEnable?.({ db });
}

/**
 * Disable a module: remove it from the toggle and run its onDisable hook. This
 * function NEVER deletes the module's content or settings — disable is a
 * visibility/activation change, fully reversible by re-enabling (§5 rule 2).
 */
export async function disableModule(
  db: Db,
  registry: ModuleRegistry,
  id: string,
): Promise<void> {
  const ids = await getEnabledModuleIds(db);
  if (ids.includes(id)) {
    await setEnabledModuleIds(db, ids.filter((x) => x !== id));
  }
  await registry.get(id)?.manifest.lifecycle?.onDisable?.({ db });
}

export interface SetEnabledModulesResult {
  ok: boolean;
  /** The enabled set after the call (unchanged from before on `ok: false`). */
  enabled: string[];
  error?: string;
}

/**
 * Set the FULL desired enabled-module set in one call — the admin module toggle
 * (issue 027) reads this as its write path, and the setup wizard could route
 * through it too. Every requested id must name a registered AND valid module;
 * an unknown or invalid id rejects the ENTIRE request before any write occurs
 * (a typo can never partially apply). Ids newly present are enabled (onEnable
 * runs); ids dropped from the set are disabled (onDisable runs; data is
 * preserved per §5 rule 2). Ids whose membership is unchanged are left alone —
 * no redundant enable/disable cycle.
 */
export async function setEnabledModules(
  db: Db,
  registry: ModuleRegistry,
  requestedIds: readonly string[],
): Promise<SetEnabledModulesResult> {
  for (const id of requestedIds) {
    const mod = registry.get(id);
    if (!mod || !mod.valid) {
      return {
        ok: false,
        enabled: await getEnabledModuleIds(db),
        error: `unknown module id: ${id}`,
      };
    }
  }

  const requestedSet = new Set(requestedIds);
  const current = new Set(await getEnabledModuleIds(db));
  for (const mod of registry.list()) {
    const id = mod.manifest.id;
    const wantEnabled = requestedSet.has(id);
    const isEnabled = current.has(id);
    if (wantEnabled && !isEnabled) {
      await enableModule(db, registry, id);
    } else if (!wantEnabled && isEnabled) {
      await disableModule(db, registry, id);
    }
  }

  return { ok: true, enabled: await getEnabledModuleIds(db) };
}

// ── Active capability views — enabled, valid modules only ────────────────────

export interface ActiveCapabilities {
  routes: Array<NormalizedRoute & { moduleId: string }>;
  adminNav: Array<AdminNavEntry & { moduleId: string }>;
  contentTypes: Array<ContentTypeDefinition & { moduleId: string }>;
  settingsPanels: Array<{ moduleId: string; panel: ModuleSettingsPanel }>;
}

/**
 * Project the live capability set from the enabled modules. A module that is not
 * enabled — or is invalid — contributes nothing, so its routes are unmounted, its
 * nav hidden, and its panels absent (§3.1 rule 4 / §5 rule 1). The consumer
 * (middleware, admin shell) mounts exactly what this returns.
 */
export function getActiveCapabilities(
  registry: ModuleRegistry,
  enabledIds: readonly string[],
): ActiveCapabilities {
  const out: ActiveCapabilities = {
    routes: [],
    adminNav: [],
    contentTypes: [],
    settingsPanels: [],
  };
  for (const id of enabledIds) {
    const mod = registry.get(id);
    if (!mod || !mod.valid) continue;
    for (const r of mod.routes) out.routes.push({ ...r, moduleId: id });
    for (const n of mod.manifest.adminNav ?? []) {
      out.adminNav.push({ ...n, moduleId: id });
    }
    for (const c of mod.manifest.contentTypes ?? []) {
      out.contentTypes.push({ ...c, moduleId: id });
    }
    if (mod.manifest.settings) {
      out.settingsPanels.push({ moduleId: id, panel: mod.manifest.settings });
    }
  }
  return out;
}

// ── Theme hooks → the existing slot registry (no parallel mechanism, §3.5) ────

/**
 * Render each enabled module's theme hooks and tag the output with its slot,
 * producing `SlotContribution[]` the theme layer's `collectSlots` understands.
 * Disabled/invalid modules contribute nothing.
 */
export function collectModuleSlotContributions(
  registry: ModuleRegistry,
  enabledIds: readonly string[],
  ctx: ModuleSlotContext,
): SlotContribution[] {
  const out: SlotContribution[] = [];
  for (const id of enabledIds) {
    const mod = registry.get(id);
    if (!mod || !mod.valid) continue;
    for (const hook of mod.manifest.themeHooks ?? []) {
      const output = hook.render(ctx);
      out.push({ slot: hook.slot, ...output });
    }
  }
  return out;
}

/**
 * The convenience that proves the seam: enabled modules' slot output flows
 * straight into the M1.4 `collectSlots`, yielding the same fully-keyed,
 * order-sorted map a theme reads via `ThemeRenderContext.slots`.
 */
export function collectModuleSlots(
  registry: ModuleRegistry,
  enabledIds: readonly string[],
  ctx: ModuleSlotContext,
): Record<ThemeSlotId, SanitizedSlotOutput[]> {
  return collectSlots(collectModuleSlotContributions(registry, enabledIds, ctx));
}
