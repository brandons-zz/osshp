// Regenerate the SMALL favicon rasters from the SIMPLIFIED brand mark
// (public/favicon.svg) — the solid teal hexagon + navy house silhouette that
// Hand-authored for legibility at tiny tab sizes. The full detailed badge
// is too dense below ~48px, so the small tab sizes (16/32/48) and the .ico use
// this simplified mark instead. The large assets (apple-touch-icon 180,
// icon-192, icon-512) keep the full badge — see gen-favicons.mjs.
//
// Uses the app's own `sharp` (librsvg-backed) — no new dependency. The SVG is
// rendered once at a high raster size then downscaled to each target so the
// small sizes get proper antialiasing rather than a direct low-res rasterize.
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Derive paths relative to this script's location (repo path standard — no
// hardcoded absolute paths). This file lives at app/scripts/, so app/ is one
// level up.
const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(APP_DIR, "public");
const SVG = path.join(OUT_DIR, "favicon.svg");

async function main() {
  // High-density master render of the simplified mark (density scales the
  // rasterization of the 100-unit viewBox; 384dpi → a crisp ~512px master).
  const master = await sharp(SVG, { density: 384 })
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const sizes = [
    ["favicon-16x16.png", 16],
    ["favicon-32x32.png", 32],
    ["favicon-48x48.png", 48],
  ];
  for (const [name, size] of sizes) {
    await sharp(master)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(OUT_DIR, name));
    console.log(`wrote ${name} (${size}x${size}) from simplified favicon.svg`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
