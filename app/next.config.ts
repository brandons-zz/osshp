import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for Docker deployment.
  // The .next/standalone directory contains a self-contained server (server.js)
  // that can be run with: bun server.js
  output: "standalone",

  // Pin the output file tracing root to this app directory so Next.js does
  // not mistake the repo-root bun.lock (from a prior internal project) as our lockfile.
  outputFileTracingRoot: path.resolve(__dirname),

  experimental: {
    // Raise the middleware request-body buffer cap above the media route's 25 MB
    // MAX_UPLOAD_BYTES (issue 049 — the TRUE root cause). Our default-deny
    // middleware (src/middleware.ts) matches /api/admin/media, and Next.js
    // buffers the request body in middleware up to middlewareClientMaxBodySize
    // (DEFAULT 10 MB). A normal >10 MB photo was silently truncated to 10 MB
    // before the route ran, so request.formData() saw an incomplete multipart
    // body and threw "missing final boundary" → surfaced as "expected multipart
    // form data" after a long pause. 30 MB clears the 25 MB route cap plus
    // multipart overhead. NOTE: this raises the buffer for ALL middleware-matched
    // routes; that is an accepted memory trade-off (was 10 MB, now 30 MB) on a
    // single-admin self-hosted app — the routes still enforce their own 25 MB cap.
    // We deliberately keep the upload routes UNDER the default-deny middleware
    // (session + security-header choke point) rather than excluding them.
    middlewareClientMaxBodySize: 30 * 1024 * 1024,
  },
};

export default nextConfig;
