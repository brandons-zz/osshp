import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createPost } from "@/lib/content";
import { buildRenderContext } from "../context";
import {
  pickTemplate,
  renderContent,
  renderPage,
  renderRequest,
  resolveTarget,
  validateManifest,
} from "../engine";
import { brandTokensToCss } from "../brand";
import type { ThemeManifest } from "../types";
import { testTheme } from "./test-theme";

let h: TestDb;
let db: Db;

beforeEach(async () => {
  h = await createTestDb({ seed: true });
  db = h.db;
});
afterEach(() => h.close());

const brandCss = brandTokensToCss({ accent: "#2563eb" });

describe("render-target routing (§3.2)", () => {
  test("route kinds map to content targets; photo-post → post", () => {
    expect(resolveTarget("home")).toBe("home");
    expect(resolveTarget("post")).toBe("post");
    expect(resolveTarget("photo-post")).toBe("post");
    expect(resolveTarget("page")).toBe("page");
    expect(resolveTarget("tag")).toBe("tag");
    expect(resolveTarget("not-found")).toBe("not-found");
  });

  test("an absent optional target falls back: tag → post-list", () => {
    // testTheme ships no `tag` template — the engine must reuse post-list.
    expect(pickTemplate(testTheme, "tag")).toBe(testTheme.templates["post-list"]);
  });

  test("validateManifest throws when a required target is missing", () => {
    const broken: ThemeManifest = {
      ...testTheme,
      templates: { post: testTheme.templates.post }, // missing home/page/post-list
    };
    expect(() => validateManifest(broken)).toThrow(/required render target/);
  });
});

describe("end-to-end render of public content through the engine", () => {
  test("a published home page renders the post title through the trivial theme", async () => {
    await createPost(db, {
      title: "Hello World Post",
      slug: "hello-world",
      body: "body copy",
      status: "published",
    });
    const ctx = await buildRenderContext(db, { kind: "home" });
    const html = renderToStaticMarkup(
      renderPage(testTheme, ctx, { brandTokenCss: brandCss }),
    );

    // Public content rendered.
    expect(html).toContain("Hello World Post");
    expect(html).toContain('data-target="post-list"');
    // Document shell: scheme attribute, both stylesheets, brand CSS injected.
    expect(html).toContain("data-scheme=");
    expect(html).toContain(testTheme.tokenStylesheetHref);
    expect(html).toContain("--accent-solid:");
    // No-flash hook present before body (§6).
    expect(html).toContain("data-scheme"); // set by the inline script too
    expect(html).toContain("localStorage");
  });

  test("a single post renders sanitized body HTML, not raw script", async () => {
    await createPost(db, {
      title: "Post With XSS",
      slug: "xss-post",
      body: "# Heading\n\n<script>alert(1)</script>\n",
      status: "published",
    });
    const ctx = await buildRenderContext(db, { kind: "post", slug: "xss-post" });
    const html = renderToStaticMarkup(renderContent(testTheme, ctx));
    expect(html).toContain('data-target="post"');
    expect(html).toContain("Post With XSS");
    expect(html).not.toContain("<script>alert");
  });

  test("a tag route renders via the post-list fallback template", async () => {
    await createPost(db, {
      title: "Tagged Post",
      slug: "tagged",
      body: "x",
      status: "published",
      tags: [{ name: "News", slug: "news" }],
    });
    const ctx = await buildRenderContext(db, { kind: "tag", slug: "news" });
    const html = renderToStaticMarkup(renderContent(testTheme, ctx));
    expect(html).toContain('data-target="post-list"');
    expect(html).toContain("Tagged Post");
  });

  test("renderRequest ties build-context + render together end-to-end", async () => {
    await createPost(db, {
      title: "Wired Post",
      slug: "wired",
      body: "x",
      status: "published",
    });
    const node = await renderRequest(db, testTheme, { kind: "home" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Wired Post");
    expect(html).toContain("--accent-solid:"); // brand CSS derived from settings
    expect(html).toContain("localStorage"); // no-flash hook
  });
});
