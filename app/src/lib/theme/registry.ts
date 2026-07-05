// Theme registry + slot registry (theme-rendering-contract §4, §8).
//
// The theme registry is the swap seam: a second bundled theme drops in by
// registering its ThemeManifest — zero app changes, zero changes to other themes
// (§4). The slot registry is the seam the step-5 module contract plugs into:
// modules contribute SanitizedSlotOutput to a ThemeSlotId; the app collects,
// sanitizes (already done before this point), orders by `order`, and exposes the
// result via ThemeRenderContext.slots (§8.2). Neither themes nor modules import
// each other — they meet only here.

import {
  THEME_SLOT_IDS,
  type SanitizedSlotOutput,
  type ThemeManifest,
  type ThemeSlotId,
} from "./types";

// ── Theme registry (the swap seam, §4) ───────────────────────────────────────

export interface ThemeRegistry {
  register(manifest: ThemeManifest): void;
  get(id: string): ThemeManifest | undefined;
  has(id: string): boolean;
  list(): ThemeManifest[];
}

export function createThemeRegistry(
  initial: readonly ThemeManifest[] = [],
): ThemeRegistry {
  const themes = new Map<string, ThemeManifest>();
  const register = (manifest: ThemeManifest) => {
    themes.set(manifest.id, manifest);
  };
  for (const m of initial) register(m);
  return {
    register,
    get: (id) => themes.get(id),
    has: (id) => themes.has(id),
    list: () => [...themes.values()],
  };
}

/**
 * Resolve the active theme from `settings.activeTheme` (§4). Falls back to the
 * first registered theme so the site still renders if the active id is stale.
 */
export function selectActiveTheme(
  registry: ThemeRegistry,
  activeThemeId: string | undefined,
): ThemeManifest | undefined {
  if (activeThemeId) {
    const found = registry.get(activeThemeId);
    if (found) return found;
  }
  return registry.list()[0];
}

// ── Slot registry (the module seam, §8) ──────────────────────────────────────

/** A module's slot contribution, tagged with its target slot for collection. */
export interface SlotContribution extends SanitizedSlotOutput {
  slot: ThemeSlotId;
}

/** An empty, fully-keyed slot map — every ThemeSlotId present (§8.2). */
export function emptySlots(): Record<ThemeSlotId, SanitizedSlotOutput[]> {
  const out = {} as Record<ThemeSlotId, SanitizedSlotOutput[]>;
  for (const id of THEME_SLOT_IDS) out[id] = [];
  return out;
}

/**
 * Group module contributions by slot and order each slot deterministically by
 * `order` (§8.2.3). The app calls this; a theme reads the result via ctx.slots.
 * Contributions are already sanitized (§8.2.4) before they reach here — the
 * SanitizedHtml type makes that unforgeable.
 */
export function collectSlots(
  contributions: readonly SlotContribution[],
): Record<ThemeSlotId, SanitizedSlotOutput[]> {
  const slots = emptySlots();
  for (const c of contributions) {
    if (!slots[c.slot]) continue; // ignore unknown slot ids defensively
    slots[c.slot].push({
      sourceModuleId: c.sourceModuleId,
      order: c.order,
      html: c.html,
    });
  }
  for (const id of THEME_SLOT_IDS) {
    slots[id].sort((a, b) => a.order - b.order);
  }
  return slots;
}
