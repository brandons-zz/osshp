import { gzipSync } from "node:zlib";
import { expect, test } from "bun:test";
import { buildTar } from "@/lib/export/tar";
import {
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  isSafeArchivePath,
  isTarReadError,
  parseTar,
  readArchive,
} from "../tar-reader";

test("round-trips entries written by the export writer (buildTar)", () => {
  const tar = buildTar([
    { path: "posts/hello.md", data: Buffer.from("---\ntitle: \"Hi\"\n---\n\nbody\n") },
    { path: "media/abc/800.jpg", data: Buffer.from("jpeg-bytes") },
  ]);
  const entries = parseTar(tar);
  expect(entries.every((e) => !isTarReadError(e))).toBe(true);
  const paths = entries.map((e) => e.path);
  expect(paths).toContain("posts/hello.md");
  expect(paths).toContain("media/abc/800.jpg");
  const post = entries.find((e) => e.path === "posts/hello.md");
  expect(!isTarReadError(post!) && post!.data.toString("utf8")).toContain("title");
});

test("readArchive auto-detects and decompresses a gzip-wrapped tar", async () => {
  const tar = buildTar([{ path: "pages/about.md", data: Buffer.from("# About") }]);
  const gz = Buffer.from((globalThis as unknown as { Bun: { gzipSync(b: Uint8Array): Uint8Array } }).Bun.gzipSync(tar));
  const entries = await readArchive(gz);
  expect(entries.length).toBe(1);
  expect(isTarReadError(entries[0])).toBe(false);
  expect(entries[0].path).toBe("pages/about.md");
});

test("readArchive rejects a highly-compressible over-cap archive with a clean bounded rejection (decompression-bomb defense, issue 026)", async () => {
  // A large run of zeros compresses to a tiny archive but would decompress to
  // well over MAX_TOTAL_BYTES — the shape a real zip-bomb upload would take.
  // Gzipping something bigger than the cap proves the bound is enforced DURING
  // inflate (streamed, chunk by chunk), not just against the final size after
  // the whole payload was already materialized.
  const bomb = Buffer.alloc(MAX_TOTAL_BYTES + 10 * 1024 * 1024, 0);
  const gz = gzipSync(bomb);
  // The compressed upload itself is tiny relative to what it decompresses to
  // (well under 1% of the cap) — this is the "small but highly-compressible"
  // shape the issue describes, not a coincidentally-large upload.
  expect(gz.length).toBeLessThan(MAX_TOTAL_BYTES / 100);

  const entries = await readArchive(gz);
  expect(entries.length).toBe(1);
  expect(isTarReadError(entries[0])).toBe(true);
  expect(isTarReadError(entries[0]) && entries[0].error).toContain(
    `exceeds ${MAX_TOTAL_BYTES} total bytes after decompression`,
  );
});

test("isSafeArchivePath rejects traversal, absolute, and drive-letter paths", () => {
  expect(isSafeArchivePath("posts/hello.md")).toBe(true);
  expect(isSafeArchivePath("../../etc/passwd")).toBe(false);
  expect(isSafeArchivePath("posts/../../etc/passwd")).toBe(false);
  expect(isSafeArchivePath("/etc/passwd")).toBe(false);
  expect(isSafeArchivePath("C:/Windows/System32")).toBe(false);
  expect(isSafeArchivePath("posts/./hello.md")).toBe(false);
  expect(isSafeArchivePath("")).toBe(false);
});

test("parseTar rejects a hand-crafted entry whose name encodes a traversal path (zip-slip)", () => {
  const tar = buildTar([{ path: "media/x/800.jpg", data: Buffer.from("bytes") }]);
  // The writer never emits a traversal path, so hand-craft one by patching the
  // header's name field directly (bytes 0..100) to prove the reader — not the
  // writer — is what blocks it.
  const patched = Buffer.from(tar);
  const evil = "../../../etc/passwd";
  patched.write(evil, 0, 100, "utf8");
  patched.fill(0, evil.length, 100); // NUL-pad the rest of the name field
  // Recompute checksum so the corrupted header still parses as a valid entry
  // header (isolates the traversal check from the corruption check).
  patched.write("        ", 148, 8, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += patched[i];
  patched.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");

  const entries = parseTar(patched);
  expect(entries.length).toBe(1);
  expect(isTarReadError(entries[0])).toBe(true);
  expect(isTarReadError(entries[0]) && entries[0].error).toContain("unsafe archive path");
});

test("parseTar reports and does not extract an oversized entry (defense against zip-bomb-shaped archives)", () => {
  const tar = buildTar([{ path: "media/huge/1.jpg", data: Buffer.from("small-but-header-claims-more") }]);
  const patched = Buffer.from(tar);
  // Forge the declared size field to exceed the per-entry cap without actually
  // providing that many bytes — proves the cap is checked against the header,
  // not just against however many bytes happen to be present.
  const hugeOctal = (MAX_ENTRY_BYTES + 1024).toString(8).padStart(11, "0") + "\0";
  patched.write(hugeOctal, 124, 12, "ascii");
  const entries = parseTar(patched);
  expect(entries.length).toBe(1);
  expect(isTarReadError(entries[0])).toBe(true);
  expect(isTarReadError(entries[0]) && entries[0].error).toContain("exceeds");
});

test("parseTar rejects a symlink entry instead of treating it as file data", () => {
  const tar = buildTar([{ path: "posts/link.md", data: Buffer.from("target-path-as-data") }]);
  const patched = Buffer.from(tar);
  patched.write("2", 156, 1, "ascii"); // typeflag '2' = symlink
  let sum = 0;
  patched.write("        ", 148, 8, "ascii");
  for (let i = 0; i < 512; i++) sum += patched[i];
  patched.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");

  const entries = parseTar(patched);
  expect(entries.length).toBe(1);
  expect(isTarReadError(entries[0])).toBe(true);
  expect(isTarReadError(entries[0]) && entries[0].error).toContain("unsupported tar entry type");
});

test("parseTar stops (does not crash) on a truncated/corrupt archive", () => {
  const tar = buildTar([{ path: "posts/a.md", data: Buffer.from("x".repeat(1000)) }]);
  const truncated = tar.subarray(0, 600); // cuts off mid-data
  const entries = parseTar(truncated);
  expect(entries.length).toBe(1);
  expect(isTarReadError(entries[0])).toBe(true);
});

test("a fully empty buffer parses to zero entries, not a crash", () => {
  expect(parseTar(Buffer.alloc(0))).toEqual([]);
});
