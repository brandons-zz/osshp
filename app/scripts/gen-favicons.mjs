// One-off favicon generator for osshp — run once with `bun run` (or `node`),
// not part of the app runtime. Uses the app's own `sharp` dependency, no new
// package added.
//
// The source PNG (osshp_icon.png) was supplied as "transparent background"
// but actually has NO alpha channel (channels:3, hasAlpha:false) — the
// background is a checkerboard pattern *baked into the RGB pixels*
// (alternating ~247/~254 near-white grays in ~32px cells), almost certainly
// from a tool that flattened a transparency-preview checkerboard on export.
//
// This script reconstructs real alpha: flood-fill from the image border
// through near-white/near-gray pixels (the checker) and mark them
// transparent. Because the interior white lock-icon detail is fully enclosed
// by opaque teal/navy shapes (not touching the border), the flood fill does
// not reach it, so it stays opaque white as intended.
import sharp from "sharp";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Derive paths relative to this script's location (repo path standard — no
// hardcoded absolute paths). This file lives at app/scripts/, so app/ is one
// level up.
const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BRAND_DIR = path.join(APP_DIR, "public", "brand");
const SRC = path.join(BRAND_DIR, "osshp-icon-source.png");
const OUT_DIR = path.join(APP_DIR, "public");

function isBackgroundish(r, g, b) {
  // Near-white/near-gray, low saturation — matches both checker tones
  // (~247,247,247 and ~254,254,254) without catching the icon's saturated
  // teal or dark navy.
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  return minc > 225 && maxc - minc < 8;
}

async function reconstructAlpha() {
  const { data, info } = await sharp(SRC)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const bg = new Uint8Array(width * height); // 1 = background (to become transparent)
  const visited = new Uint8Array(width * height);
  const stack = [];

  function idx(x, y) {
    return y * width + x;
  }
  function pushIfBg(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = idx(x, y);
    if (visited[i]) return;
    visited[i] = 1;
    const p = i * channels;
    if (isBackgroundish(data[p], data[p + 1], data[p + 2])) {
      bg[i] = 1;
      stack.push([x, y]);
    }
  }

  // Seed from every border pixel.
  for (let x = 0; x < width; x++) {
    pushIfBg(x, 0);
    pushIfBg(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    pushIfBg(0, y);
    pushIfBg(width - 1, y);
  }

  while (stack.length) {
    const [x, y] = stack.pop();
    pushIfBg(x + 1, y);
    pushIfBg(x - 1, y);
    pushIfBg(x, y + 1);
    pushIfBg(x, y - 1);
  }

  let bgCount = 0;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    const o = i * 4;
    rgba[o] = data[p];
    rgba[o + 1] = data[p + 1];
    rgba[o + 2] = data[p + 2];
    if (bg[i]) {
      rgba[o + 3] = 0;
      bgCount++;
    } else {
      rgba[o + 3] = 255;
    }
  }
  console.log(
    `Flood-fill: ${bgCount} / ${width * height} px marked transparent (${((bgCount / (width * height)) * 100).toFixed(1)}%)`,
  );

  return sharp(rgba, { raw: { width, height, channels: 4 } }).png();
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const transparent = await reconstructAlpha();
  const transparentBuf = await transparent.clone().toBuffer();

  // Keep a reconstructed transparent master alongside the source (brand dir)
  // for future re-derivation without repeating the flood-fill.
  await writeFile(
    path.join(BRAND_DIR, "osshp-icon-transparent.png"),
    transparentBuf,
  );

  const sizes = [
    ["favicon-16x16.png", 16],
    ["favicon-32x32.png", 32],
    ["favicon-48x48.png", 48],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
  ];

  for (const [name, size] of sizes) {
    await sharp(transparentBuf)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(OUT_DIR, name));
    console.log(`wrote ${name} (${size}x${size})`);
  }

  // apple-touch-icon: iOS renders transparency as solid black, so flatten
  // onto the brand dark-navy (sampled from the icon's own navy shapes) at
  // 180x180 per Apple's spec. A small padding avoids the badge touching the
  // rounded-corner mask iOS applies.
  const NAVY = { r: 12, g: 29, b: 47 }; // sampled brand dark-navy (icon roof/server fill)
  await sharp({
    create: {
      width: 180,
      height: 180,
      channels: 4,
      background: { ...NAVY, alpha: 1 },
    },
  })
    .composite([
      {
        input: await sharp(transparentBuf)
          .resize(152, 152, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .toBuffer(),
        left: 14,
        top: 14,
      },
    ])
    .png()
    .toFile(path.join(OUT_DIR, "apple-touch-icon.png"));
  console.log("wrote apple-touch-icon.png (180x180, navy background)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
