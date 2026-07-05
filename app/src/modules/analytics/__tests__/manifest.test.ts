// Analytics manifest — registers clean, admin-only dashboard route, and its
// admin-nav entry mounts/unmounts with enabled state (module-contract §5 rule 1).
// Same shape as blog/pages/photos' manifest tests.

import { expect, test } from "bun:test";
import { createModuleRegistry, getActiveCapabilities } from "@/lib/module";
import { analyticsModule, ANALYTICS_MODULE_ID } from "../manifest";

test("analytics manifest registers with zero validation errors", () => {
  const registry = createModuleRegistry([analyticsModule]);
  const mod = registry.get(ANALYTICS_MODULE_ID);
  expect(mod).toBeDefined();
  expect(mod!.errors).toEqual([]);
  expect(mod!.valid).toBe(true);
});

test("the dashboard route is admin (access omitted → admin default-deny fail-safe)", () => {
  const registry = createModuleRegistry([analyticsModule]);
  const routes = registry.get(ANALYTICS_MODULE_ID)!.routes;
  const byPath = Object.fromEntries(routes.map((r) => [r.path, r.access]));
  expect(byPath["/admin/analytics"]).toBe("admin");
});

test("analytics has no public routes at all", () => {
  expect(analyticsModule.routes!.every((r) => r.access === "admin" || r.access === undefined)).toBe(true);
  expect(analyticsModule.publicNav ?? []).toEqual([]);
});

test("enabled analytics contributes its admin nav; disabled contributes nothing (dashboard link hidden)", () => {
  const registry = createModuleRegistry([analyticsModule]);
  const enabledCaps = getActiveCapabilities(registry, [ANALYTICS_MODULE_ID]);
  expect(enabledCaps.adminNav).toHaveLength(1);
  expect(enabledCaps.adminNav[0]).toMatchObject({
    label: "Analytics",
    href: "/admin/analytics",
    moduleId: ANALYTICS_MODULE_ID,
  });

  const disabledCaps = getActiveCapabilities(registry, []);
  expect(disabledCaps.adminNav).toHaveLength(0);
  // Also gone from the mounted route list — the admin nav guard and the route
  // list agree, matching every other module.
  expect(disabledCaps.routes).toHaveLength(0);
});

test("analytics ships enabled by default on a fresh install", () => {
  expect(analyticsModule.defaultEnabled).toBe(true);
});
