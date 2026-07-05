// Photos manifest — registers clean and classifies routes correctly (the
// contract's load-bearing security clause: the public grid route is public, admin
// authoring routes are admin/deny). Verifies intent: the Photos module is
// expressible through the five-capability surface with no validation errors, and
// its content type maps to a real render target (the registry rejects unknown ones).

import { expect, test } from "bun:test";
import { createModuleRegistry, getActiveCapabilities } from "@/lib/module";
import { photosModule, PHOTOS_MODULE_ID } from "../manifest";

test("photos manifest registers with zero validation errors", () => {
  const registry = createModuleRegistry([photosModule]);
  const mod = registry.get(PHOTOS_MODULE_ID);
  expect(mod).toBeDefined();
  expect(mod!.errors).toEqual([]);
  expect(mod!.valid).toBe(true);
});

test("the public grid route is public; admin authoring routes are admin/deny", () => {
  const registry = createModuleRegistry([photosModule]);
  const routes = registry.get(PHOTOS_MODULE_ID)!.routes;
  const byPath = Object.fromEntries(routes.map((r) => [r.path, r.access]));

  expect(byPath["/photos"]).toBe("public");
  // /admin/photos OMITS access → must resolve to admin (default-deny fail-safe).
  expect(byPath["/admin/photos"]).toBe("admin");
  expect(byPath["/admin/photos/new"]).toBe("admin");
  expect(byPath["/admin/photos/[id]/edit"]).toBe("admin");
});

test("the photo-post content type maps to a valid render target", () => {
  // A core-render-target pointing at an unknown target would be a validation
  // error; zero errors proves 'post' is a real ContentTargetId.
  const registry = createModuleRegistry([photosModule]);
  const mod = registry.get(PHOTOS_MODULE_ID)!;
  const ct = mod.manifest.contentTypes?.[0];
  expect(ct?.id).toBe("photo-post");
  expect(ct?.publicRender).toEqual({ mode: "core-render-target", target: "post" });
  expect(mod.valid).toBe(true);
});

test("enabled photos contributes its admin nav; disabled contributes nothing", () => {
  const registry = createModuleRegistry([photosModule]);
  expect(getActiveCapabilities(registry, [PHOTOS_MODULE_ID]).adminNav).toHaveLength(1);
  expect(getActiveCapabilities(registry, []).adminNav).toHaveLength(0);
});

test("photos offers a public-nav entry to /photos (issue 053) — enabled contributes, disabled does not", () => {
  const registry = createModuleRegistry([photosModule]);
  // The manifest declares it and it validates (points at the public /photos route).
  expect(registry.get(PHOTOS_MODULE_ID)!.errors).toEqual([]);
  expect(photosModule.publicNav).toEqual([{ label: "Photos", href: "/photos", order: 30 }]);

  // Surfaced by the active-capability projection only when enabled.
  const enabled = getActiveCapabilities(registry, [PHOTOS_MODULE_ID]).publicNav;
  expect(enabled).toHaveLength(1);
  expect(enabled[0]).toMatchObject({ label: "Photos", href: "/photos", moduleId: PHOTOS_MODULE_ID });
  expect(getActiveCapabilities(registry, []).publicNav).toHaveLength(0);
});
