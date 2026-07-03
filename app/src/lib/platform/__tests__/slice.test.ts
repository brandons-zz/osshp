// The walking-skeleton vertical slice — verified at the data + render layer with a
// real (PGlite) PostgreSQL and the real theme engine + module system. Proves the
// load-bearing intents M1.8 exists to deliver:
//   1. Only PUBLISHED posts render publicly; drafts never reach the theme (§3.3).
//   2. Public content renders THROUGH the theme engine (theme markup present).
//   3. The module→theme slot seam carries an enabled module's contribution.
//   4. The setup wizard's admin-provision step is single-use (bootstrap closes).
//
// Tests the same engine/module functions the platform wiring composes, without
// importing the platform module itself (which pulls next/headers, request-scoped).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import { createPost } from "@/lib/content/posts";
import { createAdminUser } from "@/lib/content/admin-user";
import { isBootstrapAvailable } from "@/lib/auth/bootstrap";
import { renderRequest } from "@/lib/theme";
import { sanitizeHtmlFragment } from "@/lib/theme/sanitize";
import {
  createModuleRegistry,
  collectModuleSlotContributions,
} from "@/lib/module";
import { skeletonTheme } from "@/themes/skeleton/theme";
import { blogModule, BLOG_MODULE_ID } from "@/modules/blog/manifest";

let h: TestDb;
beforeEach(async () => {
  h = await createTestDb({ seed: true });
});
afterEach(async () => {
  await h.close();
});

const registry = createModuleRegistry([blogModule]);
const slots = () =>
  collectModuleSlotContributions(registry, [BLOG_MODULE_ID], {
    sanitize: sanitizeHtmlFragment,
  });

async function renderHtml(
  req: Parameters<typeof renderRequest>[2],
): Promise<string> {
  const node = await renderRequest(h.db, skeletonTheme, req, { slots: slots() });
  return renderToStaticMarkup(node);
}

test("only published posts appear in the public post list; drafts are excluded", async () => {
  await createPost(h.db, {
    title: "Hello World",
    slug: "hello-world",
    body: "First post.",
    status: "published",
    publishDate: new Date().toISOString(),
  });
  await createPost(h.db, {
    title: "Secret Draft",
    slug: "secret-draft",
    body: "Not ready.",
    status: "draft",
  });

  const html = await renderHtml({ kind: "post-list" });
  // Rendered THROUGH the theme (theme markup present).
  expect(html).toContain('data-target="post-list"');
  expect(html).toContain('class="post-list"');
  // Published appears; draft does not.
  expect(html).toContain("Hello World");
  expect(html).toContain("/blog/hello-world");
  expect(html).not.toContain("Secret Draft");
});

test("a published post renders through the theme; an unpublished slug is not-found", async () => {
  await createPost(h.db, {
    title: "Hello World",
    slug: "hello-world",
    body: "The body text.",
    status: "published",
    publishDate: new Date().toISOString(),
  });
  await createPost(h.db, {
    title: "Secret Draft",
    slug: "secret-draft",
    body: "Hidden body.",
    status: "draft",
  });

  const published = await renderHtml({ kind: "post", slug: "hello-world" });
  expect(published).toContain('data-target="post"');
  expect(published).toContain("Hello World");
  expect(published).toContain("The body text.");

  // A draft slug must NOT render its body — the engine falls back to not-found.
  const draft = await renderHtml({ kind: "post", slug: "secret-draft" });
  expect(draft).not.toContain("Hidden body.");
  expect(draft).toContain("Not found");
});

test("an enabled module's theme-hook output reaches the rendered page (slot seam)", async () => {
  const html = await renderHtml({ kind: "post-list" });
  // Blog contributes a footer.widgets slot; it must appear in the theme footer.
  expect(html).toContain("RSS feed");
});

test("the setup admin-provision step is single-use: bootstrap closes once the admin exists", async () => {
  expect(await isBootstrapAvailable(h.db)).toBe(true);
  await createAdminUser(h.db, {});
  expect(await isBootstrapAvailable(h.db)).toBe(false);
});
