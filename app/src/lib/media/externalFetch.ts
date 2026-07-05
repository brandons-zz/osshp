// SSRF-safe external image fetch (issue 077) — the transport layer built on
// top of the pure boundary in ssrf.ts.
//
// This is osshp's FIRST server-side fetch-by-URL. Every hop (the initial
// request and every redirect) is validated and DNS-pinned the same way:
//   1. Scheme allowlist — http/https only (checked before any resolution).
//   2. resolvePublicHost() resolves the hostname to a single validated IP
//      (ssrf.ts — refuses private/loopback/link-local/reserved ranges).
//   3. The actual TCP/TLS connection is forced onto that EXACT IP via a
//      custom `lookup` callback on the request — the address checked is
//      always the address connected to, so a DNS answer that changes between
//      "resolve" and "connect" (rebinding) cannot matter: there is no second
//      resolution to rebind.
//   4. Connect + total time budget capped at FETCH_TIMEOUT_MS (10s).
//   5. The response body is streamed and aborted the instant it would exceed
//      MAX_FETCH_BYTES — never buffered unbounded.
//   6. The response must declare an `image/*` Content-Type — this is a hint
//      only; the caller (autoImport.ts) still content-sniffs the actual bytes
//      through the same classifyUpload() path every upload goes through.
//
// No request headers/cookies are ever forwarded from anywhere — the outbound
// request is built from scratch with a fixed User-Agent + Accept header, so
// nothing this server holds can leak outbound through this fetch.

import * as http from "node:http";
import * as https from "node:https";
import type { IncomingMessage } from "node:http";
import { resolvePublicHost, type LookupFn } from "./ssrf";

/** Connect + total time budget for the whole fetch (all redirect hops plus
 *  body read), per issue 077's hard requirement (<=10s). */
export const FETCH_TIMEOUT_MS = 10_000;

/** Matches the existing admin media upload cap (MAX_UPLOAD_BYTES in
 *  src/app/api/admin/media/route.ts) — one size ceiling for "an image this
 *  server will hold," regardless of how it arrived. */
export const MAX_FETCH_BYTES = 25 * 1024 * 1024;

const MAX_REDIRECTS = 5;
const USER_AGENT = "osshp-image-importer/1.0";

export type PerformRequest = (
  target: URL,
  pinnedIp: string,
  family: 4 | 6,
  deadline: number,
) => Promise<IncomingMessage>;

export interface ExternalFetchDeps {
  /** Injectable DNS resolver — tests only; see ssrf.ts. */
  lookup?: LookupFn;
  /** Injectable IP-block predicate — tests only; see ssrf.ts. Never overridden
   *  by any production call site. */
  isBlockedIpFn?: (ip: string) => boolean;
  /** Injectable transport — tests only. Defaults to `performRequest` below
   *  (real node:http/https with the DNS pin applied). */
  requestFn?: PerformRequest;
  /** Test-only override of the connect+total time budget — production always
   *  uses FETCH_TIMEOUT_MS (10s); tests use a small value to prove the
   *  timeout path deterministically without a real multi-second wait. */
  timeoutMs?: number;
  /** Test-only override of the response-size cap — production always uses
   *  MAX_FETCH_BYTES; tests use a small value to prove the abort-on-oversize
   *  path without generating a multi-megabyte fixture. */
  maxBytes?: number;
}

export interface ExternalFetchResult {
  ok: true;
  buffer: Buffer;
  /** The response's declared Content-Type — a hint only, never trusted alone. */
  contentType: string;
  finalUrl: string;
}

export interface ExternalFetchFailure {
  ok: false;
  /** Clear, author-facing explanation — safe to surface verbatim in a report. */
  reason: string;
}

/**
 * Perform one HTTP(S) request, forcing the TCP connection onto `pinnedIp`
 * (the address `resolvePublicHost` already validated) via a custom `lookup`
 * on the request options. `servername`/the Host header still use the
 * original hostname, so TLS SNI/certificate validation and virtual-hosted
 * origins behave exactly as if a normal DNS lookup had happened — only the
 * actual socket target is pinned.
 */
// The DNS-pin callback shape @types/node declares for `http.RequestOptions.
// lookup` (a single `(address: string, family: number)` result) does not
// match what this runtime actually invokes it with (an options object plus an
// ARRAY-style `(err, addresses: {address,family}[])` callback — verified
// directly against this repo's Bun version). The pin logic itself is
// exercised by dedicated tests (externalFetch.test.ts); this cast only
// bridges a type-declaration gap, not a behavior gap.
type RuntimeLookupFn = (
  hostname: string,
  options: unknown,
  callback: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void,
) => void;

/**
 * Perform one HTTP(S) request, forcing the TCP connection onto `pinnedIp`
 * (the address `resolvePublicHost` already validated) via a custom `lookup`
 * on the request options. `servername`/the Host header still use the
 * original hostname, so TLS SNI/certificate validation and virtual-hosted
 * origins behave exactly as if a normal DNS lookup had happened — only the
 * actual socket target is pinned.
 */
export function performRequest(
  target: URL,
  pinnedIp: string,
  family: 4 | 6,
  deadline: number,
): Promise<IncomingMessage> {
  const mod = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    // Settle exactly once: on this runtime, `req.destroy(err)` after a
    // 'timeout' event does not reliably re-emit 'error' afterward, so the
    // timeout handler below settles the promise directly rather than relying
    // on a subsequent 'error' event.
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const remaining = Math.max(1, deadline - Date.now());
    const pinnedLookup: RuntimeLookupFn = (_hostname, options, callback) => {
      const cb = typeof options === "function" ? (options as typeof callback) : callback;
      cb(null, [{ address: pinnedIp, family }]);
    };
    const req = mod.request(target, {
      method: "GET",
      headers: { "user-agent": USER_AGENT, accept: "image/*" },
      timeout: remaining,
      lookup: pinnedLookup as unknown as http.RequestOptions["lookup"],
      ...(target.protocol === "https:" ? { servername: target.hostname } : {}),
    }, (res) => settle(() => resolve(res)));
    req.on("timeout", () => settle(() => {
      req.destroy();
      reject(new Error("connect timed out"));
    }));
    req.on("error", (e) => settle(() => reject(e)));
    req.end();
  });
}

function isImageContentType(ct: string | undefined): boolean {
  return !!ct && /^\s*image\//i.test(ct);
}

function sizeLimitMb(maxBytes: number): number {
  return Math.max(1, Math.floor(maxBytes / (1024 * 1024)));
}

/** Stream the response body, aborting (never buffering unbounded) the instant
 *  it would exceed `maxBytes`, and enforcing the remaining time budget. */
function readBodyCapped(
  res: IncomingMessage,
  maxBytes: number,
  deadline: number,
): Promise<Buffer | { error: string }> {
  const declared = res.headers["content-length"];
  if (declared && Number(declared) > maxBytes) {
    res.destroy();
    return Promise.resolve({ error: `image exceeds the ${sizeLimitMb(maxBytes)} MB size limit` });
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: Buffer | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      res.destroy();
      finish({ error: "timed out fetching the image" });
    }, Math.max(1, deadline - Date.now()));

    res.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        res.destroy();
        finish({ error: `image exceeds the ${sizeLimitMb(maxBytes)} MB size limit` });
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => finish(Buffer.concat(chunks)));
    res.on("error", (e) => finish({ error: `error while reading the image: ${e.message}` }));
  });
}

/**
 * Fetch an external image with the full SSRF boundary applied. Returns the
 * raw bytes + declared content-type on success, or a clear failure reason —
 * never throws. Callers must still content-sniff the bytes before trusting
 * that this is really an image (see media/detect.ts).
 */
export async function fetchExternalImage(
  rawUrl: string,
  deps: ExternalFetchDeps = {},
): Promise<ExternalFetchResult | ExternalFetchFailure> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }

  const deadline = Date.now() + (deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  const maxBytes = deps.maxBytes ?? MAX_FETCH_BYTES;
  const request = deps.requestFn ?? performRequest;
  let hops = 0;

  for (;;) {
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return {
        ok: false,
        reason: `refuses to fetch a "${target.protocol}" URL — only http/https are allowed`,
      };
    }
    if (Date.now() > deadline) {
      return { ok: false, reason: "timed out fetching the image" };
    }

    const validation = await resolvePublicHost(target.hostname, {
      lookup: deps.lookup,
      isBlockedIpFn: deps.isBlockedIpFn,
    });
    if (!validation.ok) {
      return { ok: false, reason: validation.reason! };
    }

    let res: IncomingMessage;
    try {
      res = await request(target, validation.address!, validation.family!, deadline);
    } catch (e) {
      return {
        ok: false,
        reason: `could not connect to fetch the image: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume(); // discard the redirect response body
      hops++;
      if (hops > MAX_REDIRECTS) {
        return { ok: false, reason: "too many redirects while fetching the image" };
      }
      let next: URL;
      try {
        next = new URL(res.headers.location, target);
      } catch {
        return { ok: false, reason: "the redirect target is not a valid URL" };
      }
      target = next;
      continue; // re-validate + re-resolve the NEW host from scratch
    }

    if (status !== 200) {
      res.resume();
      return { ok: false, reason: `fetching the image returned status ${status}` };
    }

    const contentType = res.headers["content-type"] ?? "";
    if (!isImageContentType(contentType)) {
      res.resume();
      return {
        ok: false,
        reason: `the URL did not return an image (content-type: ${contentType || "none"})`,
      };
    }

    const body = await readBodyCapped(res, maxBytes, deadline);
    if (!Buffer.isBuffer(body)) {
      return { ok: false, reason: body.error };
    }
    return { ok: true, buffer: body, contentType, finalUrl: target.toString() };
  }
}
