import { expect, test } from "bun:test";
import { buildTar, type TarEntry } from "../tar";

// A minimal test-only USTAR reader — enough to round-trip what buildTar()
// produces, without depending on a system `tar` binary or a new dependency.
function parseTar(buf: Buffer): Array<{ path: string; data: Buffer }> {
  const out: Array<{ path: string; data: Buffer }> = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive zero block

    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const sizeOctal = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0.*$/s, "")
      .trim();
    const size = Number.parseInt(sizeOctal, 8) || 0;
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const path = prefix ? `${prefix}/${name}` : name;

    offset += 512;
    const data = Buffer.from(buf.subarray(offset, offset + size));
    out.push({ path, data });
    offset += size;
    const pad = size % 512 === 0 ? 0 : 512 - (size % 512);
    offset += pad;
  }
  return out;
}

test("round-trips a small set of entries", () => {
  const entries: TarEntry[] = [
    { path: "posts/hello-world.md", data: Buffer.from("# Hello\n", "utf8") },
    { path: "media/abc/800.jpg", data: Buffer.from([1, 2, 3, 4, 5]) },
    { path: "manifest.json", data: Buffer.from("{}", "utf8") },
  ];
  const tar = buildTar(entries);
  const parsed = parseTar(tar);

  expect(parsed.length).toBe(entries.length);
  for (let i = 0; i < entries.length; i++) {
    expect(parsed[i].path).toBe(entries[i].path);
    expect(parsed[i].data.equals(entries[i].data)).toBe(true);
  }
});

test("round-trips an empty-body entry (zero-length data)", () => {
  const entries: TarEntry[] = [{ path: "pages/empty.md", data: Buffer.alloc(0) }];
  const parsed = parseTar(buildTar(entries));
  expect(parsed.length).toBe(1);
  expect(parsed[0].data.length).toBe(0);
});

test("round-trips a path requiring the USTAR name/prefix split (>100 bytes, <=255)", () => {
  const longDir = "media/" + "a".repeat(120);
  const path = `${longDir}/800.jpg`;
  expect(path.length).toBeGreaterThan(100);
  const entries: TarEntry[] = [{ path, data: Buffer.from("x") }];
  const parsed = parseTar(buildTar(entries));
  expect(parsed[0].path).toBe(path);
});

test("throws (fails loud) on a path that cannot be represented in USTAR (>255 bytes)", () => {
  const path = "media/" + "a".repeat(300) + "/800.jpg";
  expect(() => buildTar([{ path, data: Buffer.from("x") }])).toThrow();
});

test("data spanning multiple 512-byte blocks round-trips exactly (padding correctness)", () => {
  const data = Buffer.alloc(1500, 7); // not a multiple of 512
  const parsed = parseTar(buildTar([{ path: "media/big.bin", data }]));
  expect(parsed[0].data.length).toBe(1500);
  expect(parsed[0].data.equals(data)).toBe(true);
});

test("output is deterministic for a fixed mtime (safe to byte-compare in tests)", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const entries: TarEntry[] = [{ path: "a.md", data: Buffer.from("x") }];
  const a = buildTar(entries, now);
  const b = buildTar(entries, now);
  expect(a.equals(b)).toBe(true);
});
