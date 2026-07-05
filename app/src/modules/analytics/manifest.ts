// The Analytics module (issue 029) — first-party, self-hosted, server-side
// pageview analytics. No client script, no cookies, no third-party dependency;
// see docs/modules.md § Analytics for the operator-facing privacy posture.
//
// Unlike Blog/Pages/Photos, this module has no public routes and no authored
// content type: it has exactly one capability, an admin-only dashboard reading
// aggregates the core render path (lib/platform/render.ts) already writes via
// lib/analytics/capture.ts. Disabling the module stops capture immediately (the
// render path only calls recordPageview for an enabled module id — see
// render.ts) AND makes the dashboard route render as inert, mirroring every
// other module's disable behavior (module-contract §5 rule 2) — recorded events
// are never deleted by a disable, only future capture and the dashboard view
// are turned off; re-enabling resumes both immediately with history intact.

import type { ModuleManifest } from "@/lib/module/types";

export const ANALYTICS_MODULE_ID = "analytics";

export const analyticsModule: ModuleManifest = {
  id: ANALYTICS_MODULE_ID,
  name: "Analytics",
  description:
    "First-party, self-hosted pageview analytics. No third-party script, no cookies, no PII — everything stays in your Postgres.",
  version: "0.1.0",
  // Fresh installs: enabled by default. Capture is cookieless, script-free, and
  // stores no PII (see docs/modules.md § Analytics), so it carries none of the
  // third-party-analytics trade-offs the owner wanted osshp to avoid — an
  // operator gets basic visibility into their own site out of the box, the same
  // way Blog/Pages/Photos ship on by default. This has NO effect on an existing
  // install: adding a new module manifest never auto-enables it for a site that
  // already completed setup (site.enabledModules is only ever changed by the
  // setup wizard or an explicit admin toggle) — an operator upgrading from a
  // pre-Analytics osshp must opt in via Admin → Settings → Modules.
  defaultEnabled: true,

  // §3.1 routes — the dashboard is the only surface, and it is admin (access
  // omitted → admin, the default-deny fail-safe). There is no public route: the
  // capture path is not a "route" a visitor requests, it is a side effect of the
  // public render path (render.ts) reading this module's enabled state.
  routes: [{ path: "/admin/analytics", render: "admin-dashboard" }],

  // §3.2 admin nav — after the three content modules.
  adminNav: [
    { label: "Analytics", href: "/admin/analytics", icon: "chart-bar", order: 40 },
  ],

  // §3.4 settings — none. The privacy posture (retention window, DNT/GPC
  // honoring, bot filtering) is fixed behavior, not operator-configurable —
  // making it configurable would let an operator silently weaken the privacy
  // guarantees this module exists to provide.
  settings: { schema: [], panel: () => null },

  // §3.5 theme hooks — none; analytics aggregates never reach a theme.
  themeHooks: [],

  // §5 lifecycle — through core APIs only; disable never destroys recorded events.
  lifecycle: {
    // The analytics_events table is core-owned and already migrated
    // (0010_analytics_events); enable is a no-op beyond the toggle list.
    onEnable: async () => {},
    // Deactivate only — stops future capture and hides the dashboard; recorded
    // history is retained and reappears immediately on re-enable (§5 rule 2).
    onDisable: async () => {},
  },
};
