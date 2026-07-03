// Blog manifest — registers clean and classifies routes correctly (the contract's
// load-bearing security clause: public reading routes public, admin authoring
// routes admin/deny). Verifies intent: a real first-party module is expressible
// through the five-capability surface with no validation errors.

import { expect, test } from "bun:test";
import { createModuleRegistry, getActiveCapabilities } from "@/lib/module";
import { blogModule, BLOG_MODULE_ID } from "../manifest";

test("blog manifest registers with zero validation errors", () => {
  const registry = createModuleRegistry([blogModule]);
  const mod = registry.get(BLOG_MODULE_ID);
  expect(mod).toBeDefined();
  expect(mod!.errors).toEqual([]);
  expect(mod!.valid).toBe(true);
});

test("public reading routes are public; admin authoring routes are admin/deny", () => {
  const registry = createModuleRegistry([blogModule]);
  const routes = registry.get(BLOG_MODULE_ID)!.routes;
  const byPath = Object.fromEntries(routes.map((r) => [r.path, r.access]));

  // Public reading surfaces render through the theme.
  expect(byPath["/blog"]).toBe("public");
  expect(byPath["/blog/[slug]"]).toBe("public");
  expect(byPath["/tags/[slug]"]).toBe("public");

  // Admin authoring surfaces are admin — including /admin/blog which OMITS access
  // (the default-deny fail-safe must resolve it to admin, not public).
  expect(byPath["/admin/blog"]).toBe("admin");
  expect(byPath["/admin/blog/new"]).toBe("admin");
  expect(byPath["/admin/blog/[id]/edit"]).toBe("admin");
});

test("enabled blog contributes its admin nav; disabled contributes nothing", () => {
  const registry = createModuleRegistry([blogModule]);
  expect(getActiveCapabilities(registry, [BLOG_MODULE_ID]).adminNav).toHaveLength(1);
  // Not in the enabled set → no capabilities mounted (§5 rule 1 / §3.1 rule 4).
  expect(getActiveCapabilities(registry, []).adminNav).toHaveLength(0);
});

test("blog manifest has a head.meta theme hook that contributes the RSS autodiscovery link", () => {
  // The fold-in fix: the RSS <link> is contributed by the Blog module to
  // head.meta so it is suppressed when Blog is disabled.
  const hooks = blogModule.themeHooks ?? [];
  const headHook = hooks.find((h) => h.slot === "head.meta");
  expect(headHook).toBeDefined();

  // Render the hook with a stub sanitizeHead and verify it produces the RSS link.
  let capturedHtml = "";
  const mockCtx = {
    sanitize: (raw: string) => raw as ReturnType<typeof blogModule.themeHooks![0]["render"]>["html"],
    sanitizeHead: (raw: string) => {
      capturedHtml = raw;
      return raw as ReturnType<typeof blogModule.themeHooks![0]["render"]>["html"];
    },
  };
  headHook!.render(mockCtx);
  expect(capturedHtml).toContain("application/rss+xml");
  expect(capturedHtml).toContain("/rss.xml");
});
