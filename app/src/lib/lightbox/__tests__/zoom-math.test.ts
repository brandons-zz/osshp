import { expect, test } from "bun:test";
import {
  clampPan,
  focalZoom,
  MIN_SCALE,
  MAX_SCALE,
} from "../zoom-math";

// ── clampPan ────────────────────────────────────────────────────────────────

test("at fit (scale 1) the only legal pan is centered", () => {
  expect(clampPan(1, 800, 600, 250, -130)).toEqual({ tx: 0, ty: 0 });
});

test("pan is clamped to (scale-1)*half on each axis", () => {
  // scale 2, 800x600 → maxX = (1)*400 = 400, maxY = 300.
  expect(clampPan(2, 800, 600, 999, 999)).toEqual({ tx: 400, ty: 300 });
  expect(clampPan(2, 800, 600, -999, -999)).toEqual({ tx: -400, ty: -300 });
  // An in-range pan is left untouched.
  expect(clampPan(2, 800, 600, 120, -90)).toEqual({ tx: 120, ty: -90 });
});

// ── focalZoom: the point under the cursor stays under the cursor ─────────────

// The invariant: the picture feature under the cursor stays under the cursor.
// `centerX` is the image's CURRENT on-screen center (it already includes the
// current pan). The feature under the cursor is at f = (cx - centerX)/scale in
// picture-about-center coords. A pan moves the center, so after the zoom the new
// on-screen center is centerX + (next.tx - tx); the feature then renders at
// newCenter + next.scale*f, which must land back on the cursor.
function featureScreenAfterZoom(
  cx: number,
  centerX: number,
  scale: number,
  tx: number,
  next: { scale: number; tx: number },
): number {
  const f = (cx - centerX) / scale;
  const newCenter = centerX + (next.tx - tx);
  return newCenter + next.scale * f;
}

test("focalZoom keeps the point under the cursor fixed (zoom in)", () => {
  const scale = 1,
    tx = 0,
    ty = 0,
    centerX = 500,
    centerY = 400;
  const cx = 650,
    cy = 300; // cursor 150px right, 100px above center
  const next = focalZoom(scale, 2.5, cx, cy, centerX, centerY, tx, ty);
  // The SAME feature must now render at the same client point on both axes.
  expect(
    featureScreenAfterZoom(cx, centerX, scale, tx, next),
  ).toBeCloseTo(cx, 6);
  expect(
    featureScreenAfterZoom(cy, centerY, scale, ty, {
      scale: next.scale,
      tx: next.ty,
    }),
  ).toBeCloseTo(cy, 6);
});

test("focalZoom keeps the point under the cursor fixed (zoom out from a pan)", () => {
  const scale = 3,
    tx = -120,
    ty = 60,
    centerX = 500,
    centerY = 400;
  const cx = 430,
    cy = 470;
  const next = focalZoom(scale, 1.8, cx, cy, centerX, centerY, tx, ty);
  expect(next.scale).toBe(1.8);
  expect(
    featureScreenAfterZoom(cx, centerX, scale, tx, next),
  ).toBeCloseTo(cx, 6);
  expect(
    featureScreenAfterZoom(cy, centerY, scale, ty, {
      scale: next.scale,
      tx: next.ty,
    }),
  ).toBeCloseTo(cy, 6);
});

test("focalZoom snaps to a centered fit at or below MIN_SCALE", () => {
  const next = focalZoom(2.5, 0.5, 650, 300, 500, 400, 90, -40);
  expect(next).toEqual({ scale: MIN_SCALE, tx: 0, ty: 0 });
});

test("focalZoom clamps the target scale to [MIN, MAX]", () => {
  const up = focalZoom(3, 99, 500, 400, 500, 400, 0, 0);
  expect(up.scale).toBe(MAX_SCALE);
  // A zoom about the exact center leaves the pan unchanged (no clamp needed).
  expect(up.tx).toBe(0);
  expect(up.ty).toBe(0);
});
