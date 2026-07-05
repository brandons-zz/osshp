// issue 053 defect — dead-link nav guard. Pure matcher + the registry-driven
// disabled-module base computation used to hide masthead links into disabled
// modules' 404'd routes.

import { expect, test, describe } from "bun:test";
import {
  routeNavBase,
  hrefUnderBase,
  hrefTargetsDisabledModule,
} from "../nav-guard";
import { createModuleRegistry, getDisabledModuleNavBases } from "@/lib/module";
import { blogModule } from "@/modules/blog/manifest";
import { photosModule } from "@/modules/photos/manifest";

describe("routeNavBase", () => {
  test("static route stays as-is", () => {
    expect(routeNavBase("/photos")).toBe("/photos");
  });
  test("dynamic route collapses to its static prefix", () => {
    expect(routeNavBase("/blog/[slug]")).toBe("/blog");
    expect(routeNavBase("/tags/[slug]")).toBe("/tags");
  });
});

describe("hrefUnderBase", () => {
  test("exact match and descendant match", () => {
    expect(hrefUnderBase("/photos", "/photos")).toBe(true);
    expect(hrefUnderBase("/photos/sunset", "/photos")).toBe(true);
  });
  test("look-alike sibling does NOT match", () => {
    expect(hrefUnderBase("/photobooth", "/photos")).toBe(false);
  });
  test("never treats the site root as owned", () => {
    expect(hrefUnderBase("/anything", "/")).toBe(false);
    expect(hrefUnderBase("/anything", "")).toBe(false);
  });
});

describe("hrefTargetsDisabledModule", () => {
  test("true only when the href falls under one of the disabled bases", () => {
    const bases = ["/photos", "/blog", "/tags"];
    expect(hrefTargetsDisabledModule("/photos", bases)).toBe(true);
    expect(hrefTargetsDisabledModule("/blog/hello", bases)).toBe(true);
    expect(hrefTargetsDisabledModule("/pages/about", bases)).toBe(false);
    expect(hrefTargetsDisabledModule("https://example.com", bases)).toBe(false);
    expect(hrefTargetsDisabledModule("/photos", [])).toBe(false);
  });
});

describe("getDisabledModuleNavBases", () => {
  test("returns a disabled module's public bases; enabled modules contribute nothing", () => {
    const registry = createModuleRegistry([blogModule, photosModule]);

    // Photos disabled, Blog enabled → only Photos' public base is returned.
    const photosOff = getDisabledModuleNavBases(registry, ["blog"]);
    expect(photosOff).toContain("/photos");
    expect(photosOff).not.toContain("/blog");

    // Both enabled → nothing disabled.
    expect(getDisabledModuleNavBases(registry, ["blog", "photos"])).toEqual([]);

    // Blog disabled → its public bases (/blog and /tags) are returned; admin
    // routes never appear.
    const blogOff = getDisabledModuleNavBases(registry, ["photos"]);
    expect(blogOff).toContain("/blog");
    expect(blogOff).toContain("/tags");
    expect(blogOff.some((b) => b.startsWith("/admin"))).toBe(false);
  });
});
