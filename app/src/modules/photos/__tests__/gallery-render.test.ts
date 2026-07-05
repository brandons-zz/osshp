// Gallery photo posts (issue 047) — public RENDER behavior through the real
// theme engine + a real (PGlite) PostgreSQL. Encodes the acceptance criteria:
//   1. A gallery photo-post page renders a UNIFORM plate grid whose plates are
//      grouped .glightbox anchors (data-gallery="post-<slug>") with per-image
//      captions on data-title/data-description, lazy-loaded — no single cover.
//   2. The Photographs index shows a gallery as ONE cover plate with a count
//      badge, and the plate LINKS to /photos/<slug> (not an in-place lightbox).
//   3. A Single photo post is unchanged on both surfaces (in-place lightbox, no
//      badge) — zero regression.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import { createPost } from "@/lib/content/posts";
import { createMedia } from "@/lib/content/media";
import { renderRequest } from "@/lib/theme";
import { editorialTheme } from "@/themes/editorial/theme";

let h: TestDb;
beforeEach(async () => {
  h = await createTestDb({ seed: true });
});
afterEach(async () => {
  await h.close();
});

const NONCE = "test-nonce-xyz";

async function seedGallery(): Promise<void> {
  const ids: string[] = [];
  // Three images; the last is a 16:9 landscape (→ wide plate).
  const dims = [
    { w: 1200, h: 900 },
    { w: 1200, h: 800 },
    { w: 1920, h: 1080 },
  ];
  for (let i = 0; i < 3; i++) {
    const m = await createMedia(h.db, {
      storageKey: `g${i}/1200.jpg`,
      alt: `Gallery image ${i}`,
      width: dims[i].w,
      height: dims[i].h,
      exifStripped: true,
    });
    ids.push(m.id);
  }
  await createPost(h.db, {
    title: "Dolomites, June",
    slug: "dolomites-june",
    body: "A week in the mountains.",
    excerpt: "An album.",
    type: "photo-post",
    status: "published",
    publishDate: new Date().toISOString(),
    isGallery: true,
    gallery: [
      { mediaId: ids[0], caption: "Ridge at dawn", alt: "Sunlit ridge" },
      { mediaId: ids[1], caption: "Meadow", alt: "Alpine meadow" },
      { mediaId: ids[2], caption: "", alt: "Wide valley" },
    ],
  });
}

async function seedSingle(): Promise<void> {
  await createPost(h.db, {
    title: "One Shot",
    slug: "one-shot",
    body: "",
    excerpt: "Single.",
    type: "photo-post",
    status: "published",
    publishDate: new Date().toISOString(),
    coverImage: { src: "/media/solo/1200.jpg", alt: "A single photo" },
  });
}

async function render(kind: "photo-list" | "photo-post", slug?: string) {
  const node = await renderRequest(
    h.db,
    editorialTheme,
    slug ? { kind, slug } : { kind },
    { nonce: NONCE },
  );
  return renderToStaticMarkup(node);
}

test("gallery page renders a grouped, lazy-loaded plate grid with per-image captions", async () => {
  await seedGallery();
  const html = await render("photo-post", "dolomites-june");

  // The album grid (theme-authored, so the .glightbox hooks survive).
  expect(html).toContain("album-grid");
  // Every plate is grouped by post-<slug> so the lightbox collects them as one set.
  const groupHooks = html.match(/data-gallery="post-dolomites-june"/g) ?? [];
  expect(groupHooks.length).toBe(3);
  // All three image srcs render, lazy-loaded.
  expect(html).toContain("/media/g0/1200.jpg");
  expect(html).toContain("/media/g1/1200.jpg");
  expect(html).toContain("/media/g2/1200.jpg");
  expect(html).toContain('loading="lazy"');
  // Captions ride the lightbox (data-title / data-description), not the grid.
  expect(html).toContain('data-title="Ridge at dawn"');
  expect(html).toContain('data-description="Ridge at dawn"');
  // The 16:9 image (index 2) is a wide (span-2) plate.
  expect(html).toContain("photo-tile wide");
  // Per-image alt is on each grid <img>.
  expect(html).toContain('alt="Sunlit ridge"');
  // No single-cover figure for a gallery post.
  expect(html).not.toContain('class="plate cover"');
  // The lightbox lib still loads on the photo-post route.
  expect(html).toContain("/vendor/lightbox/lightbox.js");
  // Back affordance to /photos.
  expect(html).toContain("← Photographs");
});

test("index shows a gallery as one badged cover plate linking to /photos/<slug>", async () => {
  await seedGallery();
  const html = await render("photo-list");

  // One cover plate for the gallery (its cover = first image).
  expect(html).toContain("/media/g0/1200.jpg");
  // The count badge (3 images) is present.
  expect(html).toContain("photo-badge");
  expect(html).toContain(">3<"); // the count text node
  // The whole plate links to the gallery page (plate-link, not glightbox).
  expect(html).toContain('class="plate-link"');
  expect(html).toContain('href="/photos/dolomites-june"');
  // Accessible label names it as a gallery.
  expect(html).toContain("gallery of 3 photographs");
  // A gallery plate is NOT an in-place lightbox anchor.
  expect(html).not.toMatch(
    /class="glightbox"[^>]*href="\/media\/g0\/1200\.jpg"/,
  );
});

test("a Single photo post is unchanged on the index (in-place lightbox, no badge)", async () => {
  await seedSingle();
  const html = await render("photo-list");

  // Single plate keeps the shipped in-place glightbox anchor on the cover src.
  expect(html).toMatch(/class="glightbox"[^>]*href="\/media\/solo\/1200\.jpg"/);
  // No count badge, no gallery link for a single.
  expect(html).not.toContain("photo-badge");
  expect(html).not.toContain("plate-link");
});

test("a Single photo post page is unchanged (single cover figure, no album grid)", async () => {
  await seedSingle();
  const html = await render("photo-post", "one-shot");
  // The single cover figure remains; no album grid.
  expect(html).toContain('class="plate cover"');
  expect(html).not.toContain("album-grid");
  // The cover is still a glightbox anchor (V-019).
  expect(html).toContain('class="glightbox"');
});
