import { expect, test } from "bun:test";
import {
  createModuleRegistry,
  resolveFieldVisibility,
  resolveRouteAccess,
  validateManifest,
} from "../registry";
import type { ModuleManifest } from "../types";

// A minimal, throwaway valid manifest the tests mutate per case. The Phase-1
// modules (Blog/Pages/Photos) are M1.8/M2 — this is only a fixture.
function baseManifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id: "demo",
    name: "Demo",
    description: "A demo module.",
    version: "1.0.0",
    routes: [
      { path: "/demo", access: "public", render: "post-list" },
      { path: "/admin/demo", access: "admin", render: "admin-list" },
    ],
    adminNav: [{ label: "Demo", href: "/admin/demo", order: 10 }],
    contentTypes: [
      {
        id: "thing",
        fields: {},
        statusModel: ["draft", "published"],
        publicRender: { mode: "core-render-target", target: "post" },
      },
    ],
    settings: {
      schema: [{ key: "perPage", type: "number", default: 10, visibility: "public" }],
      panel: () => null,
    },
    themeHooks: [
      {
        slot: "post.aside",
        render: (ctx) => ({ sourceModuleId: "demo", order: 1, html: ctx.sanitize("") }),
      },
    ],
    ...overrides,
  };
}

test("resolveRouteAccess is fail-closed: only the exact string 'public' opens", () => {
  expect(resolveRouteAccess("public")).toBe("public");
  expect(resolveRouteAccess("admin")).toBe("admin");
  expect(resolveRouteAccess(undefined)).toBe("admin"); // forgot to set → deny
  expect(resolveRouteAccess("Public")).toBe("admin"); // misspelled → deny
  expect(resolveRouteAccess("")).toBe("admin");
  expect(resolveRouteAccess(null)).toBe("admin");
});

test("resolveFieldVisibility is fail-closed: only 'public' is public", () => {
  expect(resolveFieldVisibility("public")).toBe("public");
  expect(resolveFieldVisibility(undefined)).toBe("admin");
  expect(resolveFieldVisibility("PUBLIC")).toBe("admin");
});

test("a route with UNSPECIFIED access normalizes to admin/deny (the headline)", () => {
  const reg = createModuleRegistry();
  const rec = reg.register(
    baseManifest({
      // access omitted on the admin route on purpose — must default to admin.
      routes: [
        { path: "/demo", access: "public", render: "post-list" },
        { path: "/admin/demo", render: "admin-list" }, // no access
      ],
    }),
  );
  expect(rec.valid).toBe(true);
  const adminRoute = rec.routes.find((r) => r.path === "/admin/demo");
  // It must NOT have leaked through as public; it is admin behind default-deny.
  expect(adminRoute?.access).toBe("admin");
});

test("an admin route outside /admin/<id> is rejected (no land-grab)", () => {
  const errors = validateManifest(
    baseManifest({
      routes: [
        { path: "/demo", access: "public", render: "post-list" },
        { path: "/admin/other", access: "admin", render: "x" }, // escapes namespace
      ],
      adminNav: [],
    }),
  );
  expect(errors.some((e) => e.includes("/admin/other"))).toBe(true);
});

test("a public route under /admin is rejected (no admin-tree smuggle)", () => {
  const errors = validateManifest(
    baseManifest({
      routes: [{ path: "/admin/sneaky", access: "public", render: "x" }],
      adminNav: [],
    }),
  );
  expect(errors.some((e) => e.includes("must not be under"))).toBe(true);
});

test("admin-nav href must point at one of the module's own admin routes", () => {
  const bad = validateManifest(
    baseManifest({ adminNav: [{ label: "X", href: "/admin/elsewhere", order: 1 }] }),
  );
  expect(bad.some((e) => e.includes("Admin-nav href"))).toBe(true);

  const good = validateManifest(
    baseManifest({ adminNav: [{ label: "Demo", href: "/admin/demo", order: 1 }] }),
  );
  expect(good).toEqual([]);
});

test("public-nav href must point at one of the module's own public routes (issue 053)", () => {
  const bad = validateManifest(
    baseManifest({ publicNav: [{ label: "Nope", href: "/admin/demo" }] }), // admin route, not public
  );
  expect(bad.some((e) => e.includes("Public-nav href"))).toBe(true);

  const alsoBad = validateManifest(
    baseManifest({ publicNav: [{ label: "Ghost", href: "/nonexistent" }] }),
  );
  expect(alsoBad.some((e) => e.includes("Public-nav href"))).toBe(true);

  const good = validateManifest(
    baseManifest({ publicNav: [{ label: "Demo", href: "/demo" }] }), // the module's public route
  );
  expect(good).toEqual([]);
});

test("settings field with absent visibility normalizes to admin (fail-safe)", () => {
  const reg = createModuleRegistry();
  const rec = reg.register(
    baseManifest({
      settings: {
        schema: [{ key: "secretish", type: "string", default: "" }], // no visibility
        panel: () => null,
      },
    }),
  );
  expect(rec.settingsFields[0].visibility).toBe("admin");
});

test("theme hook targeting an unknown slot is rejected; a real ThemeSlotId passes", () => {
  const bad = validateManifest(
    baseManifest({
      themeHooks: [
        // @ts-expect-error — intentionally invalid slot id
        { slot: "not.a.slot", render: (ctx) => ({ sourceModuleId: "demo", order: 1, html: ctx.sanitize("") }) },
      ],
    }),
  );
  expect(bad.some((e) => e.includes("unknown slot"))).toBe(true);

  const good = validateManifest(
    baseManifest({
      themeHooks: [
        { slot: "head.meta", render: (ctx) => ({ sourceModuleId: "demo", order: 1, html: ctx.sanitize("") }) },
      ],
    }),
  );
  expect(good).toEqual([]);
});

test("content type mapping to an unknown render target is rejected", () => {
  const errors = validateManifest(
    baseManifest({
      contentTypes: [
        {
          id: "thing",
          fields: {},
          statusModel: ["draft"],
          // @ts-expect-error — intentionally invalid render target
          publicRender: { mode: "core-render-target", target: "nope" },
        },
      ],
    }),
  );
  expect(errors.some((e) => e.includes("unknown render target"))).toBe(true);
});

test("a fully-formed manifest validates clean", () => {
  expect(validateManifest(baseManifest())).toEqual([]);
});

test("a non-slug id is rejected", () => {
  expect(validateManifest(baseManifest({ id: "Bad Id" })).length).toBeGreaterThan(0);
});

test("duplicate route paths within a module are rejected", () => {
  const errors = validateManifest(
    baseManifest({
      routes: [
        { path: "/demo", access: "public", render: "post-list" },
        { path: "/demo", access: "public", render: "post" },
      ],
      adminNav: [],
    }),
  );
  expect(errors.some((e) => e.includes("Duplicate route path"))).toBe(true);
});

test("a route path colliding with another registered module is rejected", () => {
  const reg = createModuleRegistry();
  reg.register(baseManifest({ id: "demo" }));
  const other = reg.register(
    baseManifest({
      id: "other",
      // public path collides with demo's "/demo"
      routes: [
        { path: "/demo", access: "public", render: "post-list" },
        { path: "/admin/other", access: "admin", render: "admin-list" },
      ],
      adminNav: [{ label: "Other", href: "/admin/other", order: 1 }],
    }),
  );
  expect(other.valid).toBe(false);
  expect(other.errors.some((e) => e.includes("collides with module"))).toBe(true);
});

test("an invalid manifest is registered but flagged invalid with its errors", () => {
  const reg = createModuleRegistry();
  const rec = reg.register(baseManifest({ id: "BAD" }));
  expect(rec.valid).toBe(false);
  expect(rec.errors.length).toBeGreaterThan(0);
  expect(reg.has("BAD")).toBe(true); // surfaced in the admin list, not silently dropped
});
