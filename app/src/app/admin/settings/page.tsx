// /admin/settings — identity and branding editor. Reads current settings from
// the DB server-side (auth is enforced by the admin layout) and renders the
// client form pre-filled with current values. The layout already redirects to
// /login if the session is absent, so no additional auth check is needed here.

import { getDb } from "@/lib/db/client";
import { getPublicSettings } from "@/lib/content/settings";
import {
  getEnabledModuleIds,
  getActiveCapabilities,
  getDisabledModuleNavBases,
} from "@/lib/module";
import { getModuleRegistry } from "@/lib/platform";
import type { SiteIdentity } from "@/lib/theme/types";
import { SettingsForm } from "./SettingsForm";
import { ModulesPanel } from "./ModulesPanel";

export default async function SettingsPage() {
  const db = getDb();
  // getPublicSettings returns exactly the public identity/branding settings.
  // All writable settings from the API are public, so this is the right call.
  const s = await getPublicSettings(db);

  // ── Extract and coerce each setting into a prop-safe type ─────────────────
  const title = typeof s["site.title"] === "string" ? s["site.title"] : "";
  const description =
    typeof s["site.description"] === "string" ? s["site.description"] : "";
  const homeIntro =
    typeof s["home.intro"] === "string" ? s["home.intro"] : "";
  const locale = typeof s["site.locale"] === "string" ? s["site.locale"] : "en";
  const accent =
    typeof s["branding.accent"] === "string" ? s["branding.accent"] : "#2563eb";

  const fontHeading =
    typeof s["branding.fontHeading"] === "string" ? s["branding.fontHeading"] : "";
  const fontBody =
    typeof s["branding.fontBody"] === "string" ? s["branding.fontBody"] : "";

  const rawScheme = s["branding.defaultScheme"];
  const defaultScheme: "light" | "dark" | "auto" =
    rawScheme === "light" || rawScheme === "dark" || rawScheme === "auto"
      ? rawScheme
      : "auto";

  // nav and social are serialized to JSON for the textarea inputs.
  const navRaw = s["site.nav"];
  const navJson = Array.isArray(navRaw)
    ? JSON.stringify(navRaw, null, 2)
    : "[]";

  const socialRaw = s["site.social"];
  const socialJson = Array.isArray(socialRaw)
    ? JSON.stringify(socialRaw, null, 2)
    : "[]";

  // logo: { src, alt } | null
  const logoRaw = s["site.logo"] as SiteIdentity["logo"] | null | undefined;
  const logoSrc =
    logoRaw && typeof logoRaw === "object" ? logoRaw.src : "";
  const logoAlt =
    logoRaw && typeof logoRaw === "object" ? logoRaw.alt : "";

  // issue 027 — module enable/disable, structured checklist like SetupWizard's
  // module step. Only VALID registered modules are toggleable (an invalid
  // manifest never mounts regardless of the toggle, module-contract §4).
  const enabledIds = await getEnabledModuleIds(db);
  const enabledModuleIds = new Set(enabledIds);
  const registry = getModuleRegistry();
  const modules = registry
    .list()
    .filter((m) => m.valid)
    .map((m) => ({
      id: m.manifest.id,
      name: m.manifest.name,
      description: m.manifest.description,
      enabled: enabledModuleIds.has(m.manifest.id),
    }));

  // issue 053 — public masthead-nav suggestions from ENABLED, valid modules
  // (Blog, Photos), via the same active-capabilities projection that mounts the
  // admin nav. Offered as one-click "Add" chips in the nav editor so a published
  // photo at /photos is reachable; a disabled module contributes nothing.
  const moduleNavSuggestions = getActiveCapabilities(registry, enabledIds)
    .publicNav.slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((n) => ({ label: n.label, href: n.href }));

  // issue 053 defect — nav bases of DISABLED modules, so the editor can FLAG a
  // saved nav item that now points at a disabled module (the public site already
  // drops it; the flag tells the owner why so they can remove or keep it).
  const disabledModuleNavBases = getDisabledModuleNavBases(registry, enabledIds);

  return (
    <div className="stack">
      <h1>Settings</h1>
      <p className="muted">
        Site identity, branding, and navigation. Changes are reflected on the
        live site immediately after saving.
      </p>
      <ModulesPanel modules={modules} />
      <SettingsForm
        title={title}
        description={description}
        homeIntro={homeIntro}
        locale={locale}
        accent={accent}
        fontHeading={fontHeading}
        fontBody={fontBody}
        defaultScheme={defaultScheme}
        navJson={navJson}
        socialJson={socialJson}
        logoSrc={logoSrc}
        logoAlt={logoAlt}
        moduleNavSuggestions={moduleNavSuggestions}
        disabledModuleNavBases={disabledModuleNavBases}
      />
    </div>
  );
}
