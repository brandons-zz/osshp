// SSRF-safe transport tests (issue 077) — proves the full fetch pipeline
// (redirect handling, timeouts, size caps, scheme allowlist) against a REAL
// local HTTP server and a real socket.
//
// Test-only exception, documented once here: a real server for these tests
// can only bind to loopback (127.0.0.1) — which is exactly one of the ranges
// production must block. Every test in this file that needs a live
// connection therefore injects an `isBlockedIpFn` that is the REAL
// `isBlockedIp` with ONLY 127.0.0.1 carved out — every OTHER address
// (including the redirect-to-internal target below, a literal IP validated
// by the same composed function) is still checked for real. The exhaustive,
// unmodified boundary is proven in ssrf.test.ts; this file proves the
// PLUMBING around that boundary.

import { describe, expect, test, afterEach } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { fetchExternalImage } from "../externalFetch";
import { isBlockedIp } from "../ssrf";

/** The real isBlockedIp, with ONLY 127.0.0.1 carved out for these tests —
 *  every other address (10/8, 169.254.169.254, etc.) is still refused for
 *  real by this same function. */
function allowLoopbackOnly(ip: string): boolean {
  if (ip === "127.0.0.1") return false;
  return isBlockedIp(ip);
}

async function tinyJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .jpeg()
    .toBuffer();
}

let server: http.Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function listen(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve((server!.address() as AddressInfo).port);
    });
  });
}

describe("fetchExternalImage — scheme allowlist", () => {
  test("refuses a non-http(s) URL outright", async () => {
    const result = await fetchExternalImage("file:///etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("http/https");
  });

  test("refuses a malformed URL", async () => {
    const result = await fetchExternalImage("not a url");
    expect(result.ok).toBe(false);
  });
});

describe("fetchExternalImage — SSRF: bracketed IPv6 literals blocked by the predicate, not by luck", () => {
  test("refuses http://[::ffff:169.254.169.254]/ (HEX IPv4-mapped cloud metadata) end-to-end, with no DNS fallthrough", async () => {
    let lookupCalled = false;
    const result = await fetchExternalImage("http://[::ffff:169.254.169.254]/x.jpg", {
      // If the bracketed literal were NOT recognized as an IP, it would fall
      // through to DNS — asserting lookup is never called proves the predicate
      // itself did the blocking (robust by construction).
      lookup: async () => {
        lookupCalled = true;
        return [{ address: "8.8.8.8", family: 4 }];
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("private/internal");
    expect(lookupCalled).toBe(false);
  });

  test("refuses http://[::ffff:a9fe:a9fe]/ (same address, hex tail) end-to-end", async () => {
    const result = await fetchExternalImage("http://[::ffff:a9fe:a9fe]/x.jpg");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("private/internal");
  });

  test("refuses http://[::1]/ (bracketed loopback) end-to-end", async () => {
    const result = await fetchExternalImage("http://[::1]/x.jpg");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("private/internal");
  });
});

describe("fetchExternalImage — happy path (real socket, real bytes)", () => {
  test("fetches a real image over a real connection and returns its bytes + content-type", async () => {
    const jpeg = await tinyJpeg();
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(jpeg);
    });

    const result = await fetchExternalImage(`http://127.0.0.1:${port}/photo.jpg`, {
      isBlockedIpFn: allowLoopbackOnly,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contentType).toBe("image/jpeg");
      expect(Buffer.compare(result.buffer, jpeg)).toBe(0);
    }
  });
});

describe("fetchExternalImage — redirect handling", () => {
  test("follows one redirect to a legitimate image", async () => {
    const jpeg = await tinyJpeg();
    const port = await listen((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/final.jpg" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(jpeg);
    });

    const result = await fetchExternalImage(`http://127.0.0.1:${port}/redirect`, {
      isBlockedIpFn: allowLoopbackOnly,
    });
    expect(result.ok).toBe(true);
  });

  test("SSRF: refuses a redirect whose target is a private/internal literal IP (169.254.169.254 cloud metadata)", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });

    // Even with the loopback-only carve-out for THIS test's own server, the
    // redirect target is a DIFFERENT, literal address — checked for real.
    const result = await fetchExternalImage(`http://127.0.0.1:${port}/redirect`, {
      isBlockedIpFn: allowLoopbackOnly,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("private/internal");
  });

  test("SSRF: refuses a redirect to a hostname that RESOLVES to a private address", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(302, { location: "http://internal.attacker.example/x" });
      res.end();
    });

    const result = await fetchExternalImage(`http://127.0.0.1:${port}/redirect`, {
      isBlockedIpFn: allowLoopbackOnly,
      lookup: async (hostname) => {
        // The INITIAL host (127.0.0.1) is a literal IP and never calls lookup;
        // only the redirect target hostname reaches DNS resolution here.
        expect(hostname).toBe("internal.attacker.example");
        return [{ address: "10.0.0.9", family: 4 }];
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("private/internal");
  });

  test("refuses too many redirects (redirect loop)", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(302, { location: "/loop" }); // always redirects to itself
      res.end();
    });

    const result = await fetchExternalImage(`http://127.0.0.1:${port}/loop`, {
      isBlockedIpFn: allowLoopbackOnly,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("too many redirects");
  });

  test("refuses a redirect to a non-http(s) scheme", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(302, { location: "file:///etc/passwd" });
      res.end();
    });
    const result = await fetchExternalImage(`http://127.0.0.1:${port}/redirect`, {
      isBlockedIpFn: allowLoopbackOnly,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("http/https");
  });
});

describe("fetchExternalImage — content-type hint check", () => {
  test("refuses a response that does not declare an image content-type", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>not an image</html>");
    });
    const result = await fetchExternalImage(`http://127.0.0.1:${port}/page`, {
      isBlockedIpFn: allowLoopbackOnly,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("did not return an image");
  });

  test("refuses a non-200 status", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(404, { "content-type": "image/jpeg" });
      res.end();
    });
    const result = await fetchExternalImage(`http://127.0.0.1:${port}/missing.jpg`, {
      isBlockedIpFn: allowLoopbackOnly,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("404");
  });
});

describe("fetchExternalImage — size cap (never buffers unbounded)", () => {
  test("aborts via declared Content-Length before reading any body", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": "1000000" });
      // Deliberately never writes 1MB of body — if the implementation read
      // past the Content-Length check it would hang waiting for bytes that
      // never arrive, and this test would time out (a failure signal itself).
      res.write(Buffer.alloc(10));
    });
    const result = await fetchExternalImage(`http://127.0.0.1:${port}/huge.jpg`, {
      isBlockedIpFn: allowLoopbackOnly,
      maxBytes: 100, // far below the declared content-length
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("size limit");
  });

  test("aborts mid-stream when actual bytes exceed the cap (no Content-Length declared)", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" }); // chunked, no content-length
      const chunk = Buffer.alloc(64, 1);
      const timer = setInterval(() => res.write(chunk), 5);
      res.on("close", () => clearInterval(timer));
    });
    const result = await fetchExternalImage(`http://127.0.0.1:${port}/drip.jpg`, {
      isBlockedIpFn: allowLoopbackOnly,
      maxBytes: 128, // a couple of chunks and we're over
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("size limit");
  });
});

describe("fetchExternalImage — timeout enforcement", () => {
  test("times out a slow-responding server within the injected budget", async () => {
    const port = await listen((_req, res) => {
      // Never respond — simulates a hung/slow origin.
      void res;
    });
    const started = Date.now();
    const result = await fetchExternalImage(`http://127.0.0.1:${port}/slow.jpg`, {
      isBlockedIpFn: allowLoopbackOnly,
      timeoutMs: 200,
    });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    // Bounded well under the real 10s production budget — proves the
    // injected timeout actually fired rather than the test hanging.
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("fetchExternalImage — DNS-rebind defense at the transport layer", () => {
  test("resolves the hostname exactly once and pins the connection to that address (no re-resolution before connect)", async () => {
    const jpeg = await tinyJpeg();
    let lookupCalls = 0;
    let connectedIp: string | null = null;

    const result = await fetchExternalImage("http://rebind-target.example/photo.jpg", {
      isBlockedIpFn: () => false, // this test's fake hostname is never a real address
      lookup: async () => {
        lookupCalls++;
        // A real attacker's authoritative DNS could answer differently on a
        // later query — proving there IS no later query is the point.
        return [{ address: "203.0.113.5", family: 4 }];
      },
      requestFn: async (_target, pinnedIp) => {
        connectedIp = pinnedIp;
        const { Readable } = await import("node:stream");
        const res = Readable.from(jpeg) as unknown as import("node:http").IncomingMessage;
        (res as unknown as { statusCode: number; headers: Record<string, string> }).statusCode = 200;
        (res as unknown as { headers: Record<string, string> }).headers = {
          "content-type": "image/jpeg",
        };
        return res;
      },
    });

    expect(lookupCalls).toBe(1);
    expect(connectedIp).toBe("203.0.113.5");
    expect(result.ok).toBe(true);
  });
});
