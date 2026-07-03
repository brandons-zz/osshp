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
};

export default nextConfig;
