// Pack favicon-16x16.png, favicon-32x32.png, favicon-48x48.png into a single
// multi-size favicon.ico using the "PNG-in-ICO" format (ICONDIR + per-image
// ICONDIRENTRY headers, each entry's payload is a raw PNG file byte-for-byte).
// Supported by every modern browser (Chrome, Firefox, Safari, Edge) since this
// avoids re-encoding to raw BMP/AND-mask bitmaps — cheap and valid.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Derive paths relative to this script's location (repo path standard — no
// hardcoded absolute paths). This file lives at app/scripts/, so app/ is one
// level up.
const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUB = path.join(APP_DIR, "public");
const files = [
  { name: "favicon-16x16.png", size: 16 },
  { name: "favicon-32x32.png", size: 32 },
  { name: "favicon-48x48.png", size: 48 },
];

async function main() {
  const images = await Promise.all(
    files.map(async (f) => ({ ...f, buf: await readFile(`${PUB}/${f.name}`) })),
  );

  const headerSize = 6 + 16 * images.length;
  let offset = headerSize;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4); // image count

  const entries = [];
  const payloads = [];
  for (const img of images) {
    const entry = Buffer.alloc(16);
    // width/height: 0 means 256; our sizes (16/32/48) fit in a byte directly.
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    entry.writeUInt8(0, 2); // color palette count (0 = no palette, PNG)
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(img.buf.length, 8); // payload size
    entry.writeUInt32LE(offset, 12); // payload offset
    offset += img.buf.length;
    entries.push(entry);
    payloads.push(img.buf);
  }

  const ico = Buffer.concat([header, ...entries, ...payloads]);
  await writeFile(`${PUB}/favicon.ico`, ico);
  console.log(`wrote favicon.ico (${ico.length} bytes, ${images.length} sizes: ${files.map((f) => f.size).join("/")})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
