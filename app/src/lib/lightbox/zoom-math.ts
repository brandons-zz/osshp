// Pure zoom/pan math for the photo lightbox (issue 065).
//
// This is the REFERENCE + test-covered source of truth for the two tricky
// formulas the lightbox uses. The vendored browser script
// (public/vendor/lightbox/lightbox.js) mirrors these exact formulas inline —
// it is a CSP-loaded, non-module IIFE that cannot `import`, so the math lives
// here (unit-tested) and is kept in lockstep there. Any change to the focal or
// clamp math must change both, and this test is the spec that pins the intent.

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;

export interface Pan {
  tx: number;
  ty: number;
}

export interface ZoomState extends Pan {
  scale: number;
}

/** Clamp v into [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Clamp a pan so it never reveals empty space beyond the picture's own edges.
 * At scale s the image overflows its fit box by (s-1)*half on each side, so the
 * translation magnitude may not exceed that. At scale 1 the only legal pan is 0.
 */
export function clampPan(
  scale: number,
  imgWidth: number,
  imgHeight: number,
  tx: number,
  ty: number,
): Pan {
  const maxX = ((scale - 1) * imgWidth) / 2;
  const maxY = ((scale - 1) * imgHeight) / 2;
  // `|| 0` normalizes a -0 result (from clamping into a zero-width range at
  // scale 1) to +0 — keeps the transform string tidy and comparisons sane.
  return { tx: clamp(tx, -maxX, maxX) || 0, ty: clamp(ty, -maxY, maxY) || 0 };
}

/**
 * Zoom to `newScale` while keeping the picture point currently under the client
 * point (cx,cy) fixed there. `centerX/centerY` are the image's current on-screen
 * center; `tx/ty` its current pan. Transform origin is the image center, so:
 *   screenX(f) = centerX + scale*f   ⇒   f = (cx - centerX) / scale
 * holding cx fixed at newScale gives  tx += (cx - centerX) * (1 - newScale/scale).
 * Snaps to a centered fit at/under MIN_SCALE (a zoomed-out image re-centers).
 * Note: the returned pan is NOT edge-clamped here — callers apply clampPan with
 * the live rendered image size (which this pure module does not know).
 */
export function focalZoom(
  scale: number,
  newScale: number,
  cx: number,
  cy: number,
  centerX: number,
  centerY: number,
  tx: number,
  ty: number,
  min: number = MIN_SCALE,
  max: number = MAX_SCALE,
): ZoomState {
  const target = clamp(newScale, min, max);
  const ratio = target / scale;
  let nextTx = tx + (cx - centerX) * (1 - ratio);
  let nextTy = ty + (cy - centerY) * (1 - ratio);
  let nextScale = target;
  if (nextScale <= min) {
    nextScale = min;
    nextTx = 0;
    nextTy = 0;
  }
  return { scale: nextScale, tx: nextTx, ty: nextTy };
}
