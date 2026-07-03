// Public barrel for the module system core (module-contract).
//
// The five-capability registration surface + toggle lifecycle that every feature
// beyond the core (Blog, Pages, Photos — M1.8/M2) builds against. A module
// declares a ModuleManifest; the registry validates and normalizes it
// fail-closed; the lifecycle drives it on/off via the single
// `site.enabledModules` toggle, preserving data on disable. Theme hooks plug into
// the existing M1.4 slot registry — no parallel mechanism.

export * from "./types";
export {
  createModuleRegistry,
  validateManifest,
  resolveRouteAccess,
  resolveFieldVisibility,
  type ModuleRegistry,
  type RegisteredModule,
} from "./registry";
export {
  ENABLED_MODULES_KEY,
  getEnabledModuleIds,
  isEnabled,
  enableModule,
  disableModule,
  setEnabledModules,
  getActiveCapabilities,
  collectModuleSlotContributions,
  collectModuleSlots,
  type ActiveCapabilities,
  type SetEnabledModulesResult,
} from "./lifecycle";
