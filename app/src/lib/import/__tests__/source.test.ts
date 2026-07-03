import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTar } from "@/lib/export/tar";
import { sourceFromDirectory, sourceFromSingleMarkdown, sourceFromTar } from "../source";

test("sourceFromSingleMarkdown wraps one loose file with no entry errors", () => {
  const { source, entryErrors } = sourceFromSingleMarkdown("my-post.md", Buffer.from("---\ntitle: \"X\"\n---\n\nbody\n"));
  expect(entryErrors).toEqual([]);
  expect(source.markdownFiles.size).toBe(1);
  expect(source.markdownFiles.has("my-post.md")).toBe(true);
  expect(source.mediaFiles.size).toBe(0);
});

test("sourceFromTar classifies posts/, pages/, media/ and ignores manifest.json", async () => {
  const tar = buildTar([
    { path: "posts/hello.md", data: Buffer.from("post") },
    { path: "pages/about.md", data: Buffer.from("page") },
    { path: "media/abc/800.jpg", data: Buffer.from("bytes") },
    { path: "manifest.json", data: Buffer.from("{}") },
  ]);
  const { source, entryErrors } = await sourceFromTar(tar);
  expect(entryErrors).toEqual([]);
  expect([...source.markdownFiles.keys()].sort()).toEqual(["pages/about.md", "posts/hello.md"]);
  expect([...source.mediaFiles.keys()]).toEqual(["abc/800.jpg"]);
});

test("sourceFromTar reports an unrecognized top-level path without aborting the batch", async () => {
  const tar = buildTar([
    { path: "posts/hello.md", data: Buffer.from("post") },
    { path: "readme.txt", data: Buffer.from("hi") },
  ]);
  const { source, entryErrors } = await sourceFromTar(tar);
  expect(source.markdownFiles.size).toBe(1); // the good entry still lands
  expect(entryErrors.length).toBe(1);
  expect(entryErrors[0].path).toBe("readme.txt");
});

test("sourceFromTar surfaces tar-reader errors (e.g. traversal) as entryErrors, not a thrown exception", async () => {
  const tar = buildTar([{ path: "media/x/800.jpg", data: Buffer.from("bytes") }]);
  const patched = Buffer.from(tar);
  const evil = "../../../etc/passwd";
  patched.write(evil, 0, 100, "utf8");
  patched.fill(0, evil.length, 100);
  patched.write("        ", 148, 8, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += patched[i];
  patched.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");

  const { source, entryErrors } = await sourceFromTar(patched);
  expect(source.mediaFiles.size).toBe(0);
  expect(entryErrors.length).toBe(1);
  expect(entryErrors[0].reason).toContain("unsafe archive path");
});

let tmpDir: string | undefined;
afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

test("sourceFromDirectory walks posts/pages/media recursively", async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "osshp-import-src-"));
  await mkdir(join(tmpDir, "posts"), { recursive: true });
  await mkdir(join(tmpDir, "media", "abc"), { recursive: true });
  await writeFile(join(tmpDir, "posts", "hello.md"), "post body");
  await writeFile(join(tmpDir, "media", "abc", "800.jpg"), "img bytes");
  await writeFile(join(tmpDir, "manifest.json"), "{}");

  const { source, entryErrors } = await sourceFromDirectory(tmpDir);
  expect(entryErrors).toEqual([]);
  expect([...source.markdownFiles.keys()]).toEqual(["posts/hello.md"]);
  expect([...source.mediaFiles.keys()]).toEqual(["abc/800.jpg"]);
});

test("sourceFromDirectory skips symlinks rather than following them", async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "osshp-import-src-"));
  await mkdir(join(tmpDir, "posts"), { recursive: true });
  await writeFile(join(tmpDir, "posts", "hello.md"), "post body");
  await symlink("/etc/passwd", join(tmpDir, "posts", "evil-link.md")).catch(() => {
    // symlink creation can fail in sandboxed CI environments without that
    // permission; the assertion below is skipped in that case rather than
    // failing the whole suite on an environment limitation.
  });

  const { source, entryErrors } = await sourceFromDirectory(tmpDir);
  expect(source.markdownFiles.has("posts/hello.md")).toBe(true);
  expect(source.markdownFiles.has("posts/evil-link.md")).toBe(false);
  if (entryErrors.length > 0) {
    expect(entryErrors.some((e) => e.reason.includes("symlink"))).toBe(true);
  }
});
