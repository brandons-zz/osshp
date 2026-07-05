// Gallery photo-post API (issue 047) — the two guarantees the create/update
// routes add, tested at the levels the codebase tests them:
//   1. The AA 1.1.1 alt-on-publish rule (pure decision logic in _gallery.ts):
//      a gallery with any image missing alt CANNOT be Published/Scheduled, but
//      Save-draft is allowed; and the untrusted gallery payload is normalized.
//   2. The new mutations stay CSRF-guarded: a cross-site POST/PATCH is rejected
//      with 403 + no-store BEFORE the handler touches the store (pre-DB path).

process.env.OSSHP_ORIGIN = "https://osshp.example.com";
process.env.DATABASE_URL = "postgres://localhost/osshp_test_placeholder";
process.env.SESSION_SECRET = "test-session-secret-do-not-use-in-prod";

import { expect, test } from "bun:test";
import {
  normalizeGallery,
  galleryPublishAltError,
  galleryTooLarge,
  resolveEffectiveAlt,
  effectivePublishAltError,
  MAX_GALLERY_SIZE,
} from "../_gallery";

// ── Alt-on-publish decision logic ────────────────────────────────────────────

test("a gallery with a missing alt is blocked from Publish", () => {
  const gallery = normalizeGallery([
    { mediaId: "a", caption: "x", alt: "described" },
    { mediaId: "b", caption: "", alt: "" }, // missing
  ]);
  const err = galleryPublishAltError("published", true, gallery);
  expect(err).not.toBeNull();
  expect(err).toContain("1 photograph");
});

test("the same missing-alt gallery IS allowed as a draft", () => {
  const gallery = normalizeGallery([
    { mediaId: "a", alt: "" },
    { mediaId: "b", alt: "" },
  ]);
  expect(galleryPublishAltError("draft", true, gallery)).toBeNull();
});

test("a fully-alt-texted gallery publishes cleanly; scheduling enforces it too", () => {
  const ok = normalizeGallery([
    { mediaId: "a", alt: "one" },
    { mediaId: "b", alt: "two" },
  ]);
  expect(galleryPublishAltError("published", true, ok)).toBeNull();
  expect(galleryPublishAltError("scheduled", true, ok)).toBeNull();
  const bad = normalizeGallery([{ mediaId: "a", alt: "" }]);
  expect(galleryPublishAltError("scheduled", true, bad)).not.toBeNull();
});

test("an empty gallery cannot be published; a single (non-gallery) post is exempt", () => {
  expect(galleryPublishAltError("published", true, [])).not.toBeNull();
  // A Single photo post (isGallery=false) is not subject to the gallery rule.
  expect(galleryPublishAltError("published", false, undefined)).toBeNull();
});

test("normalizeGallery drops entries without a mediaId and preserves order", () => {
  const g = normalizeGallery([
    { mediaId: "first", caption: "c1", alt: "a1" },
    { caption: "orphan" }, // no mediaId → dropped
    { mediaId: "  ", alt: "blank id" }, // blank → dropped
    { mediaId: "second", alt: "a2" },
  ]);
  expect(g).toEqual([
    { mediaId: "first", caption: "c1", alt: "a1" },
    { mediaId: "second", caption: "", alt: "a2" },
  ]);
  // A non-array (no gallery field sent) → undefined (leave gallery unchanged).
  expect(normalizeGallery(undefined)).toBeUndefined();
});

// ── Server-side hardening (security-review finding 2) ──────────────────────────────────

test("the server-side hard cap rejects an oversized gallery array", () => {
  const under = normalizeGallery(
    Array.from({ length: MAX_GALLERY_SIZE }, (_, i) => ({
      mediaId: `id-${i}`,
      alt: "a",
    })),
  );
  expect(galleryTooLarge(under)).toBe(false);
  const over = normalizeGallery(
    Array.from({ length: MAX_GALLERY_SIZE + 1 }, (_, i) => ({
      mediaId: `id-${i}`,
      alt: "a",
    })),
  );
  expect(galleryTooLarge(over)).toBe(true);
  // A non-array (no gallery sent) is never "too large".
  expect(galleryTooLarge(undefined)).toBe(false);
});

test("normalizeGallery bounds caption and alt length (unbounded TEXT defense)", () => {
  const g = normalizeGallery([
    { mediaId: "a", caption: "c".repeat(5000), alt: "x".repeat(5000) },
  ]);
  expect(g![0].caption!.length).toBeLessThanOrEqual(2000);
  expect(g![0].alt!.length).toBeLessThanOrEqual(1000);
});

test("resolveEffectiveAlt fills a missing payload alt from the stored media alt", () => {
  const stored = new Map([["a", "stored alt A"]]);
  const eff = resolveEffectiveAlt([{ mediaId: "a", caption: "cap" }], stored);
  expect(eff[0].alt).toBe("stored alt A");
  // A supplied alt wins over the stored one.
  const eff2 = resolveEffectiveAlt([{ mediaId: "a", alt: "typed" }], stored);
  expect(eff2[0].alt).toBe("typed");
});

// ── The publish-while-editing bypass (security-review finding 1) ───────────────────────

test("editing an already-published gallery while OMITTING status still enforces alt", () => {
  // Stored: published gallery whose second image has empty (stored) alt. The
  // PATCH omits status and omits gallery — the OLD code (gated on body.status)
  // skipped the check; the effective-decision blocks it.
  const err = effectivePublishAltError({
    bodyStatus: undefined, // omitted
    bodyIsGallery: undefined, // omitted
    existingStatus: "published",
    existingIsGallery: true,
    writtenGallery: null, // gallery not re-sent
    storedGallery: [
      { mediaId: "a", alt: "described" },
      { mediaId: "b", alt: "" }, // stored missing alt
    ],
  });
  expect(err).not.toBeNull();
});

test("effective decision: omitted status + all stored alt present → allowed", () => {
  expect(
    effectivePublishAltError({
      existingStatus: "published",
      existingIsGallery: true,
      writtenGallery: null,
      storedGallery: [
        { mediaId: "a", alt: "one" },
        { mediaId: "b", alt: "two" },
      ],
    }),
  ).toBeNull();
});

test("effective decision: a still-draft gallery is never blocked", () => {
  expect(
    effectivePublishAltError({
      existingStatus: "draft",
      existingIsGallery: true,
      writtenGallery: [{ mediaId: "a", alt: "" }],
      storedGallery: [],
    }),
  ).toBeNull();
});

test("effective decision: writing a missing-alt image while publishing is blocked", () => {
  expect(
    effectivePublishAltError({
      bodyStatus: "published",
      existingStatus: "draft",
      existingIsGallery: true,
      writtenGallery: [
        { mediaId: "a", alt: "ok" },
        { mediaId: "b", alt: "" }, // being written without alt
      ],
      storedGallery: [],
    }),
  ).not.toBeNull();
});

// ── CSRF guard on the new mutation surface ───────────────────────────────────

function crossSite(method: string, path: string): Request {
  return new Request(`https://osshp.example.com${path}`, {
    method,
    headers: {
      origin: "https://evil.example.com",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: "x", slug: "x", isGallery: true, gallery: [] }),
  });
}

test("photos create (POST) with a gallery rejects a cross-site request (403 + no-store)", async () => {
  const { POST } = (await import("../route")) as {
    POST: (r: Request) => Promise<Response>;
  };
  const res = await POST(crossSite("POST", "/api/admin/photos/posts"));
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("photos edit (PATCH [id]) with a gallery rejects a cross-site request (403 + no-store)", async () => {
  const { PATCH } = (await import("../[id]/route")) as {
    PATCH: (
      r: Request,
      ctx: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
  };
  const res = await PATCH(crossSite("PATCH", "/api/admin/photos/posts/abc"), {
    params: Promise.resolve({ id: "abc" }),
  });
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});
