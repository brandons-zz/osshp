// Unit tests for content-based image detection (issue 048).
//
// The behavior that matters: an iOS HEIC arriving with a BLANK or
// application/octet-stream MIME must still be accepted (sniffed by magic bytes),
// while a genuine non-image is still rejected. These are the exact false-reject
// and false-accept boundaries the upload route depends on.

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sniffImageFormat, classifyUpload, isHeicFormat } from "../detect";

const HEIC = readFileSync(join(import.meta.dir, "fixtures", "sample.heic"));

// Minimal magic-byte heads for the non-HEIC formats (enough for the sniffer).
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP"),
]);
const AVIF = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypavif"),
  Buffer.from([0, 0, 0, 0]),
]);
const NOT_IMAGE = Buffer.from("this is a plain text file, not an image at all");

describe("sniffImageFormat — magic-byte identification", () => {
  test("identifies the standard web formats", () => {
    expect(sniffImageFormat(JPEG)).toBe("jpeg");
    expect(sniffImageFormat(PNG)).toBe("png");
    expect(sniffImageFormat(GIF)).toBe("gif");
    expect(sniffImageFormat(WEBP)).toBe("webp");
    expect(sniffImageFormat(AVIF)).toBe("avif");
  });

  test("identifies a real HEIC file by its ftyp brand", () => {
    expect(sniffImageFormat(HEIC.subarray(0, 32))).toBe("heic");
    expect(isHeicFormat(sniffImageFormat(HEIC.subarray(0, 32)))).toBe(true);
  });

  test("returns null for a non-image", () => {
    expect(sniffImageFormat(NOT_IMAGE)).toBeNull();
    expect(sniffImageFormat(Buffer.from([1, 2, 3]))).toBeNull(); // too short
  });
});

describe("classifyUpload — accept/reject + HEIC decision", () => {
  test("accepts a HEIC that iOS reports with a BLANK MIME (the 048 bug)", () => {
    const c = classifyUpload({
      declaredType: "",
      filename: "IMG_0421.HEIC",
      head: HEIC.subarray(0, 32),
    });
    expect(c.accept).toBe(true);
    expect(c.isHeic).toBe(true);
  });

  test("accepts a HEIC reported as application/octet-stream", () => {
    const c = classifyUpload({
      declaredType: "application/octet-stream",
      filename: "photo.heic",
      head: HEIC.subarray(0, 32),
    });
    expect(c.accept).toBe(true);
    expect(c.isHeic).toBe(true);
  });

  test("accepts a normal JPEG with a proper MIME (not flagged HEIC)", () => {
    const c = classifyUpload({
      declaredType: "image/jpeg",
      filename: "pic.jpg",
      head: JPEG,
    });
    expect(c.accept).toBe(true);
    expect(c.isHeic).toBe(false);
  });

  test("rejects a genuine non-image (no signature, no image MIME/ext)", () => {
    const c = classifyUpload({
      declaredType: "text/plain",
      filename: "notes.txt",
      head: NOT_IMAGE,
    });
    expect(c.accept).toBe(false);
    expect(c.isHeic).toBe(false);
  });

  test("still accepts a normal image whose bytes are unrecognized but MIME is image/*", () => {
    const c = classifyUpload({
      declaredType: "image/png",
      filename: "x.png",
      head: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    });
    expect(c.accept).toBe(true);
  });
});
