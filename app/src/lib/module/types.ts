// The module contract — surface types (module-contract §2–§6).
//
// A module's ENTIRE interface to the core is the ModuleManifest it exports
// (module-contract §2, §4). It declares exactly the five capabilities the spec
// enumerates — routes, admin nav, content types, settings panels, theme hooks
// (§3) — plus a toggle lifecycle (§5). The core reaches into a module only
// through these declarations; a module never imports the admin shell, the theme,
// another module, a raw DB handle, or secrets (§6). That one-way,
// capability-mediated direction is the property that keeps the future
// untrusted-plugin door open without building it (§7).
//
// Theme hooks are NOT a parallel mechanism: a theme hook contributes
// `SanitizedSlotOutput` to a `ThemeSlotId` from the M1.4 theme layer (§3.5).
// Both types are imported here verbatim — this file does not redefine them.

import type { ReactNode } from "react";
import type { Db } from "@/lib/db/types";
import type { ContentStatus, SettingVisibility } from "@/lib/content/types";
import type {
  ContentTargetId,
  SanitizedHtml,
  SanitizedSlotOutput,
  ThemeSlotId,
} from "@/lib/theme/types";

// ── 3.1 Routes — classified public/admin, default admin/deny ─────────────────

export type RouteAccess = "public" | "admin";

export interface ModuleRoute {
  /** App-Router path this module serves, within the module's namespace (§3.1.2). */
  path: string;
  /**
   * SECURITY-CRITICAL. Optional in the type; the registrar coerces an absent OR
   * unrecognized value to "admin" (deny). A route reaches anonymous visitors
   * only by explicitly declaring `access: "public"` (§3.1 rule 1).
   */
  access?: RouteAccess;
  /** Which app render target serves it (public → a theme target; admin → shell). */
  render: string;
}

// ── 3.2 Admin navigation ─────────────────────────────────────────────────────

export interface AdminNavEntry {
  label: string;
  /** MUST resolve to one of this module's own `admin` routes (§3.2). */
  href: string;
  icon?: string;
  order: number;
}

/**
 * A PUBLIC-site navigation entry a module offers for the masthead nav (issue 053
 * — a published photo at /photos was unreachable because modules only contributed
 * ADMIN nav). Analogous to AdminNavEntry, but points at one of this module's own
 * PUBLIC routes. It is a SUGGESTION, not an auto-injection: an enabled module's
 * public-nav entries surface as one-click "Add" chips in the Settings nav editor,
 * so the operator keeps full control — they choose whether to add it, where it
 * sits, and can remove it (owner-adds-it default; see the settings nav editor).
 * A disabled module contributes nothing (the suggestion list is filtered to
 * enabled modules). The rendered nav still comes solely from `site.nav`.
 */
export interface PublicNavEntry {
  label: string;
  /** MUST resolve to one of this module's own `public` routes (validated §3.2). */
  href: string;
  order?: number;
}

// ── 3.3 Content types — public-render mapping is the seam to the theme contract ─

/** A typed field schema; shape is owned by the content layer, opaque to the core. */
export type ContentFieldSchema = Record<string, unknown>;

export type ContentPublicRender =
  /** Maps to one of the theme's fixed render targets (theme-contract §3.2/§3.3). */
  | { mode: "core-render-target"; target: ContentTargetId }
  /** Surfaces only via theme slots (§3.5) — no theme-contract change. */
  | { mode: "slot-only" }
  /** Never reaches a theme (e.g. Analytics aggregates). */
  | { mode: "admin-only" };

export interface ContentTypeDefinition {
  id: string;
  fields: ContentFieldSchema;
  statusModel: ContentStatus[];
  publicRender: ContentPublicRender;
}

// ── 3.4 Settings panels — public/admin field split mirrors the theme boundary ─

export type ModuleSettingsFieldType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "media-ref";

export interface ModuleSettingsField {
  key: string;
  type: ModuleSettingsFieldType;
  default: unknown;
  /**
   * Load-bearing for the theme boundary (theme-contract §3.1): a "public" field
   * flows into the public settings subset a theme can read; "admin" (the default)
   * never reaches a theme. Absent/unrecognized → admin (§3.4).
   */
  visibility?: SettingVisibility;
}

/** Opaque admin-shell context the settings panel receives (M1.7 fills it). */
export interface AdminPanelContext {
  [key: string]: unknown;
}

export interface ModuleSettingsPanel {
  schema: ModuleSettingsField[];
  /** Admin UI built from the owned components; never a raw DB or secret handle. */
  panel: (ctx: AdminPanelContext) => ReactNode;
}

// ── 3.5 Theme hooks — plug into the M1.4 slot seam, no parallel mechanism ─────

/**
 * The context a slot renderer receives. `sanitize` is the ONLY way a module can
 * obtain a `SanitizedHtml`: a module cannot mint one itself (§6.2). The app owns
 * the sanitizer (theme-contract §9); the module's output passes through it before
 * entering `ThemeRenderContext.slots`.
 *
 * `sanitizeHead` is the head-element variant — it allows <link>/<meta> elements
 * with safe attributes, appropriate for the head.meta slot. Falls back to
 * `sanitize` when not provided (backward compatible).
 */
export interface ModuleSlotContext {
  sanitize(raw: string): SanitizedHtml;
  sanitizeHead?(raw: string): SanitizedHtml;
}

export interface ModuleThemeHook {
  /** One of the theme contract's append-only `ThemeSlotId`s (§3.5 / §8.1). */
  slot: ThemeSlotId;
  render: (ctx: ModuleSlotContext) => SanitizedSlotOutput;
}

// ── 5 Toggle lifecycle — through core APIs only ──────────────────────────────

export interface ModuleLifecycleContext {
  db: Db;
}

export interface ModuleLifecycle {
  /** One-time wiring through core storage/settings APIs (never a raw handle). */
  onEnable?: (ctx: ModuleLifecycleContext) => Promise<void>;
  /** Deactivate only — MUST NOT destroy module data; disable is reversible (§5). */
  onDisable?: (ctx: ModuleLifecycleContext) => Promise<void>;
}

// ── 4 The manifest — the single, load-bearing interface ──────────────────────

export interface ModuleManifest {
  id: string; // stable slug — namespaces routes/settings (§4)
  name: string;
  description: string;
  version: string;
  defaultEnabled?: boolean;

  routes?: ModuleRoute[];
  adminNav?: AdminNavEntry[];
  /** Public masthead-nav suggestions (issue 053) — offered to the Settings nav
   *  editor as one-click adds; hrefs must point at this module's public routes. */
  publicNav?: PublicNavEntry[];
  contentTypes?: ContentTypeDefinition[];
  settings?: ModuleSettingsPanel;
  themeHooks?: ModuleThemeHook[];

  lifecycle?: ModuleLifecycle;
}

// ── Normalized (fail-closed) forms the registry stores ───────────────────────

/** A route whose access is resolved — never undefined, never an open default. */
export interface NormalizedRoute extends ModuleRoute {
  access: RouteAccess;
}

/** A settings field whose visibility is resolved — defaults to admin. */
export interface NormalizedSettingsField extends ModuleSettingsField {
  visibility: SettingVisibility;
}
