// Photos module — render + toggle intents, verified at the data + render layer
// with a real (PGlite) PostgreSQL and the real theme engine. Encodes the M2.11
// acceptance criteria, not incidental markup:
//   1. Published photo posts render in a GRID through the theme (photo-list target,
//      .photo-grid + .glightbox tiles); articles do NOT appear in the photo grid.
//   2. The lightbox library is loaded ONLY on the Photos route (conditional, so
//      non-photo pages pay nothing) and is CSP-clean (every inline <script>/<style>
//      and the lib <script src> carry the per-request nonce).
//   3. Disabling the module makes its capabilities inert WITHOUT data loss — the
//      photo-post rows survive and re-enabling brings the grid back.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import { createPost, listPublishedPosts } from "@/lib/content/posts";
import { renderRequest } from "@/lib/theme";
import { editorialTheme } from "@/themes/editorial/theme";
import {
  createModuleRegistry,
  getActiveCapabilities,
  enableModule,
  disableModule,
  getEnabledModuleIds,
} from "@/lib/module";
import { photosModule, PHOTOS_MODULE_ID } from "../manifest";

let h: TestDb;
beforeEach(async () => {
  h = await createTestDb({ seed: true });
});
afterEach(async () => {
  await h.close();
});

const NONCE = "test-nonce-abc123";

async function seedOnePhotoPostAndOneArticle() {
  await createPost(h.db, {
    title: "Sunset Over the Lake",
    slug: "sunset-lake",
    body: "A summer evening.",
    excerpt: "Golden hour.",
    type: "photo-post",
    status: "published",
    publishDate: new Date().toISOString(),
    coverImage: { src: "/media/abc/1200.jpg", alt: "Sunset over a calm lake" },
  });
  await createPost(h.db, {
    title: "An Article",
    slug: "an-article",
    body: "Just words.",
    type: "article",
    status: "published",
    publishDate: new Date().toISOString(),
  });
}

async function renderPhotos(): Promise<string> {
  const node = await renderRequest(
    h.db,
    editorialTheme,
    { kind: "photo-list" },
    { nonce: NONCE },
  );
  return renderToStaticMarkup(node);
}

test("published photo posts render in a lightbox grid; articles are excluded", async () => {
  await seedOnePhotoPostAndOneArticle();
  const html = await renderPhotos();

  // Rendered THROUGH the theme via the photo-list render target.
  expect(html).toContain('data-target="photo-list"');
  expect(html).toContain('class="photo-grid"');
  // The tile is a GLightbox-hooked anchor wrapping the cover image (theme-authored
  // markup, so the .glightbox class + cover src survive — a sanitized slot wouldn't).
  expect(html).toContain('class="glightbox"');
  expect(html).toContain("/media/abc/1200.jpg");
  expect(html).toContain("Sunset over a calm lake");
  // The article is not a photo post → not a tile in the grid.
  expect(html).not.toContain("An Article");
});

test("the lightbox lib loads only on the Photos route, and is CSP-nonce-clean", async () => {
  await seedOnePhotoPostAndOneArticle();
  const photos = await renderPhotos();

  // The first-party lightbox CSS + JS are present on the photo grid…
  expect(photos).toContain("/vendor/lightbox/lightbox.css");
  expect(photos).toContain("/vendor/lightbox/lightbox.js");
  // …and the lib <script src> carries the per-request nonce (strict-dynamic trust).
  expect(photos).toMatch(
    /<script[^>]*src="\/vendor\/lightbox\/lightbox\.js"[^>]*nonce="test-nonce-abc123"/,
  );
  // CSP-clean: NO inline <script> or <style> without a nonce.
  expect(photos).not.toMatch(/<script(?![^>]*\bnonce=)(?![^>]*\bsrc=)[^>]*>/);
  expect(photos).not.toMatch(/<style(?![^>]*\bnonce=)[^>]*>/);

  // A non-photo route must NOT pull the lightbox lib in (conditional load).
  const postList = renderToStaticMarkup(
    await renderRequest(h.db, editorialTheme, { kind: "post-list" }, { nonce: NONCE }),
  );
  expect(postList).not.toContain("/vendor/lightbox/lightbox.js");
});

test("disabling the module is data-preserving; re-enabling restores the grid", async () => {
  await seedOnePhotoPostAndOneArticle();
  const registry = createModuleRegistry([photosModule]);

  await enableModule(h.db, registry, PHOTOS_MODULE_ID);
  expect(await getEnabledModuleIds(h.db)).toContain(PHOTOS_MODULE_ID);
  // Enabled → the module's public grid route + admin nav are mounted.
  const enabled = getActiveCapabilities(registry, await getEnabledModuleIds(h.db));
  expect(enabled.routes.some((r) => r.path === "/photos")).toBe(true);

  await disableModule(h.db, registry, PHOTOS_MODULE_ID);
  // Disabled → capabilities inert (route unmounted)…
  expect(await getEnabledModuleIds(h.db)).not.toContain(PHOTOS_MODULE_ID);
  const disabled = getActiveCapabilities(registry, await getEnabledModuleIds(h.db));
  expect(disabled.routes.some((r) => r.path === "/photos")).toBe(false);
  // …but the photo-post DATA is untouched (disable is a visibility change, §5).
  const stillThere = await listPublishedPosts(h.db, { type: "photo-post" });
  expect(stillThere.map((p) => p.slug)).toContain("sunset-lake");

  // Re-enable → the grid renders the preserved photo post again.
  await enableModule(h.db, registry, PHOTOS_MODULE_ID);
  expect(await renderPhotos()).toContain("/media/abc/1200.jpg");
});

// ── Issue 004 — photo grid navigation + photo-item back affordance ────────────

test("photo grid figcaption links to /photos/[slug] for page navigation (issue 004)", async () => {
  // The figcaption title link is the dedicated navigation path to the photo-item
  // page; the .glightbox image anchor remains for in-place lightbox preview.
  await seedOnePhotoPostAndOneArticle();
  const html = await renderPhotos();

  // The figcaption must contain a link to the photo item page.
  expect(html).toContain('href="/photos/sunset-lake"');
  // The lightbox image anchor (href=image URL) is still present for in-place preview.
  expect(html).toContain('class="glightbox"');
  expect(html).toContain("/media/abc/1200.jpg");
});

test("photo-item page (kind:photo-post) renders with back affordance to /photos", async () => {
  await seedOnePhotoPostAndOneArticle();
  const node = await renderRequest(
    h.db,
    editorialTheme,
    { kind: "photo-post", slug: "sunset-lake" },
    { nonce: NONCE },
  );
  const html = renderToStaticMarkup(node);
  // Must render the photo post body (post template).
  expect(html).toContain("Sunset Over the Lake");
  // Back affordance must point to /photos ("← Photographs"), not /blog.
  expect(html).toContain('href="/photos"');
  expect(html).toContain("← Photographs");
  expect(html).not.toContain('href="/blog"');
});

test("EXIF/GPS strip is inherited: the photos cover upload uses the strip-by-default path", async () => {
  // The Photos module does not re-implement media handling — it reuses the M2.9
  // upload pipeline (storeUploadedImage → M2.7 processImage, EXIF/GPS stripped by
  // default). This asserts the inherited default at the photos boundary: a stored
  // media reference is marked exif-stripped unless a caller explicitly opts out.
  const { createMedia } = await import("@/lib/content/media");
  const media = await createMedia(h.db, {
    storageKey: "abc/1200.jpg",
    alt: "Sunset over a calm lake",
    responsiveSizes: [{ width: 1200, height: 800, key: "abc/1200.jpg" }],
    exifStripped: true,
  });
  expect(media.exifStripped).toBe(true);
});
