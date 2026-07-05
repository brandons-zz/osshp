// Auto-import orchestration tests (issue 077).
//
// Covers: happy-path import + URL rewrite + attribution capture + figcaption-
// ready title rewrite, idempotency (re-saving an already-imported body is a
// no-op fetch-wise), and the failure contract (a bad image never drops
// content or throws — the original URL stays and the reason is reported).
//
// A real local HTTP server provides the "external host" for the happy-path
// tests; SSRF-blocked cases (the failure path) don't need a server at all —
// resolvePublicHost refuses them before any connection is attempted.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import sharp from "sharp";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { getMediaByKey } from "@/lib/content/media";
import { autoImportExternalImages } from "../autoImport";
import { isBlockedIp } from "../ssrf";
import type { MediaStorage, StoredObject } from "../storage";

function allowLoopbackOnly(ip: string): boolean {
  if (ip === "127.0.0.1") return false;
  return isBlockedIp(ip);
}

class MemoryStorage implements MediaStorage {
  readonly objects = new Map<string, { buffer: Buffer; contentType: string }>();
  async ensureBucket(): Promise<void> {}
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { buffer: body, contentType });
  }
  async get(key: string): Promise<StoredObject> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`no object: ${key}`);
    return { stream: Readable.from(o.buffer), contentType: o.contentType, size: o.buffer.length };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

async function tinyJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .toBuffer();
}

let h: TestDb;
let db: Db;
let server: http.Server | undefined;

beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => {
  h.close();
  server?.close();
  server = undefined;
});

function listen(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
  });
}

describe("autoImportExternalImages — happy path", () => {
  test("imports an external image, rewrites the body URL, and captures attribution", async () => {
    const jpeg = await tinyJpeg();
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(jpeg);
    });
    const storage = new MemoryStorage();
    const url = `http://127.0.0.1:${port}/cat.jpg`;
    const body = `# A post\n\n![A cat](${url} "Photo by Jane Doe")\n\nSome text.`;

    const result = await autoImportExternalImages(db, storage, body, {
      isBlockedIpFn: allowLoopbackOnly,
    });

    expect(result.report).toHaveLength(1);
    expect(result.report[0].outcome).toBe("imported");
    expect(result.report[0].url).toBe(url);
    expect(result.report[0].mediaUrl).toMatch(/^\/media\//);

    // The image SRC is same-origin now — the external host is no longer the
    // fetch target (it deliberately still appears in the credit text below).
    expect(result.body).not.toContain(`](${url}`);
    expect(result.body).toContain(result.report[0].mediaUrl!);
    // The credited title carries the author's caption + the source link, so
    // the render pipeline (figureCaption.ts) can build a figcaption with a
    // linked source credit purely from the markdown text.
    expect(result.body).toContain(`Photo by Jane Doe — Source: ${url}`);
    expect(result.body).toContain("Some text."); // rest of the body untouched

    // The media row records the attribution metadata.
    const key = result.report[0].mediaUrl!.replace(/^\/media\//, "");
    const media = await getMediaByKey(db, key);
    expect(media).not.toBeNull();
    expect(media!.sourceUrl).toBe(url);
    expect(media!.attribution).toBe("Photo by Jane Doe");
    expect(storage.objects.size).toBeGreaterThan(0);
  });

  test("imports an image with no author-supplied title using a bare Source credit", async () => {
    const jpeg = await tinyJpeg();
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(jpeg);
    });
    const storage = new MemoryStorage();
    const url = `http://127.0.0.1:${port}/plain.jpg`;
    const body = `![alt text](${url})`;

    const result = await autoImportExternalImages(db, storage, body, {
      isBlockedIpFn: allowLoopbackOnly,
    });

    expect(result.report[0].outcome).toBe("imported");
    expect(result.body).toContain(`Source: ${url}`);
    const key = result.report[0].mediaUrl!.replace(/^\/media\//, "");
    const media = await getMediaByKey(db, key);
    expect(media!.attribution).toBeNull();
    expect(media!.sourceUrl).toBe(url);
  });

  test("de-duplicates: the same external URL used twice is fetched once and both occurrences rewritten", async () => {
    const jpeg = await tinyJpeg();
    let fetchCount = 0;
    const port = await listen((_req, res) => {
      fetchCount++;
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(jpeg);
    });
    const storage = new MemoryStorage();
    const url = `http://127.0.0.1:${port}/dup.jpg`;
    const body = `![first](${url} "one")\n\n![second](${url} "two")`;

    const result = await autoImportExternalImages(db, storage, body, {
      isBlockedIpFn: allowLoopbackOnly,
    });

    expect(fetchCount).toBe(1); // one distinct URL => one fetch
    expect(result.report).toHaveLength(1);
    expect(result.body).not.toContain(`](${url}`);
    // Both occurrences rewritten to the same new media URL.
    const mediaUrl = result.report[0].mediaUrl!;
    expect(result.body.split(mediaUrl).length - 1).toBe(2);
  });
});

describe("autoImportExternalImages — idempotency", () => {
  test("re-running on an already-imported body does not re-fetch or change anything", async () => {
    const jpeg = await tinyJpeg();
    let fetchCount = 0;
    const port = await listen((_req, res) => {
      fetchCount++;
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(jpeg);
    });
    const storage = new MemoryStorage();
    const url = `http://127.0.0.1:${port}/once.jpg`;
    const body = `![alt](${url} "credit")`;

    const first = await autoImportExternalImages(db, storage, body, {
      isBlockedIpFn: allowLoopbackOnly,
    });
    expect(fetchCount).toBe(1);

    const second = await autoImportExternalImages(db, storage, first.body, {
      isBlockedIpFn: allowLoopbackOnly,
    });
    expect(fetchCount).toBe(1); // no second fetch — the URL is now same-origin
    expect(second.report).toHaveLength(0); // nothing external left to report on
    expect(second.body).toBe(first.body); // byte-for-byte unchanged
  });

  test("a body with no images at all is returned unchanged with an empty report", async () => {
    const storage = new MemoryStorage();
    const body = "# Just text\n\nNo images here.";
    const result = await autoImportExternalImages(db, storage, body);
    expect(result.body).toBe(body);
    expect(result.report).toEqual([]);
  });

  test("already-local /media/ and data: images are left completely alone", async () => {
    const storage = new MemoryStorage();
    const body =
      `![local](/media/abc123/800.jpg "already here")\n\n` +
      `![inline](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)`;
    const result = await autoImportExternalImages(db, storage, body);
    expect(result.body).toBe(body);
    expect(result.report).toEqual([]);
  });
});

describe("autoImportExternalImages — failure contract: never lose content, never throw", () => {
  test("an SSRF-blocked URL leaves the original markdown untouched and reports a clear reason", async () => {
    const storage = new MemoryStorage();
    const blockedUrl = "http://169.254.169.254/latest/meta-data/";
    const body = `![alt](${blockedUrl} "caption")\n\nRest of the post stays intact.`;

    const result = await autoImportExternalImages(db, storage, body);

    expect(result.body).toBe(body); // byte-for-byte unchanged — nothing lost
    expect(result.report).toHaveLength(1);
    expect(result.report[0].outcome).toBe("failed");
    expect(result.report[0].url).toBe(blockedUrl);
    expect(result.report[0].reason).toBeTruthy();
    expect(result.report[0].reason).toContain("private/internal");
    expect(result.report[0].mediaUrl).toBeUndefined();
  });

  test("a non-image response leaves the original URL and reports why, without throwing", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>nope</html>");
    });
    const storage = new MemoryStorage();
    const url = `http://127.0.0.1:${port}/page.html`;
    const body = `![alt](${url})`;

    const result = await autoImportExternalImages(db, storage, body, {
      isBlockedIpFn: allowLoopbackOnly,
    });

    expect(result.body).toBe(body);
    expect(result.report[0].outcome).toBe("failed");
    expect(result.report[0].reason).toContain("did not return an image");
  });

  test("a server that LIES about content-type (declares image/jpeg but sends non-image bytes) is still rejected — the header is never trusted alone", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" }); // lying
      res.end(Buffer.from("this is definitely not a jpeg"));
    });
    const storage = new MemoryStorage();
    const url = `http://127.0.0.1:${port}/lie.jpg`;
    const body = `![alt](${url})`;

    const result = await autoImportExternalImages(db, storage, body, {
      isBlockedIpFn: allowLoopbackOnly,
    });

    expect(result.body).toBe(body); // untouched
    expect(result.report[0].outcome).toBe("failed");
    // Nothing was ever written to the media library from the lie.
    expect(storage.objects.size).toBe(0);
  });

  test("a mix of one good and one bad image: the good one imports, the bad one's URL survives, and the save is not aborted", async () => {
    const jpeg = await tinyJpeg();
    const port = await listen((req, res) => {
      if (req.url === "/good.jpg") {
        res.writeHead(200, { "content-type": "image/jpeg" });
        res.end(jpeg);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const storage = new MemoryStorage();
    const goodUrl = `http://127.0.0.1:${port}/good.jpg`;
    const badUrl = `http://127.0.0.1:${port}/missing.jpg`;
    const body = `![good](${goodUrl})\n\n![bad](${badUrl})`;

    const result = await autoImportExternalImages(db, storage, body, {
      isBlockedIpFn: allowLoopbackOnly,
    });

    expect(result.report).toHaveLength(2);
    const good = result.report.find((r) => r.url === goodUrl)!;
    const bad = result.report.find((r) => r.url === badUrl)!;
    expect(good.outcome).toBe("imported");
    expect(bad.outcome).toBe("failed");
    expect(result.body).not.toContain(`](${goodUrl}`);
    expect(result.body).toContain(`](${badUrl})`); // the failed one's original markdown survives verbatim
  });
});
