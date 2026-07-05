// Intent test for the demonstrable path (M2.9, owner's explicit priority): an
// uploaded image, linked to a post as its cover, RENDERS on the public site
// through the theme.
//
// This renders the LOCKED Editorial theme's post template with a cover image whose
// src is a /media/<key> URL (what the upload pipeline returns + the serve route
// resolves). The assertion is that the public HTML carries an <img> pointing at
// that URL with the captured alt text — i.e. media resolves and renders through
// the theme, not merely that a record exists.
//
// (Live runtime proof of the full upload→Garage→serve→render loop is verified
// separately at deploy time; this unit test guards the theme-render half
// deterministically.)

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderPage } from "@/lib/theme/engine";
import { emptySlots } from "@/lib/theme/registry";
import type {
  SanitizedHtml,
  ThemeContent,
  ThemeRenderContext,
} from "@/lib/theme/types";
import { editorialTheme } from "@/themes/editorial/theme";

const sani = (s: string) => s as unknown as SanitizedHtml;

function ctxWithCover(): ThemeRenderContext {
  const content: ThemeContent = {
    kind: "post",
    post: {
      title: "From the road",
      slug: "from-the-road",
      bodyHtml: sani("<p>A photo post.</p>"),
      gallery: [],      excerpt: "A photo post.",
      coverImage: { src: "/media/abc123/1600.jpg", alt: "A quiet harbor at dawn" },
      type: "article",
      panoramic: false,
      publishedAt: "2026-06-29T00:00:00.000Z",
      tags: [],
    },
  };
  return {
    site: {
      title: "Alex Rivera",
      description: "",
      nav: [],
      social: [],
      logo: null,
      defaultScheme: "light",
      locale: "en",
    },
    route: { kind: "post", canonicalUrl: "https://example.com/blog/from-the-road" },
    content,
    brand: {
      accentSolid: "var(--accent-solid)",
      accentText: "var(--accent-text)",
      onAccent: "var(--on-accent)",
      fontHeading: "system-ui",
      fontBody: "system-ui",
      fontMono: "monospace",
    },
    scheme: "light",
    slots: emptySlots(),
    helpers: {
      assetUrl: (k) => `/media/${k}`,
      formatDate: (iso) => iso.slice(0, 10),
      excerpt: (h, n) => h.slice(0, n),
    },
  };
}

test("a post's uploaded cover image renders as an <img> on the public page", () => {
  const html = renderToStaticMarkup(
    renderPage(editorialTheme, ctxWithCover(), {
      brandTokenCss: ":root{--accent-solid:#2F5FE0}",
    }),
  );
  expect(html).toContain('src="/media/abc123/1600.jpg"');
  expect(html).toContain('alt="A quiet harbor at dawn"');
});
