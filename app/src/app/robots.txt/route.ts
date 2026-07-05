// GET /robots.txt — robots directive for search engine crawlers.
//
// Allows all crawlers to index the full public site and references the sitemap
// for automatic URL discovery. /robots.txt is in PUBLIC_EXACT (access.ts) so
// it requires no authentication.
//
// The sitemap URL uses the operator-pinned origin (config.origin / OSSHP_ORIGIN)
// — never derived from request headers (same security rule as the RSS feed and
// auth layer, auth-security-assessment W2 / NO-GO #4).

import { config } from "@/lib/config";

// Force dynamic rendering — OSSHP_ORIGIN is a runtime env var (not set during
// `next build`) and the sitemap URL must reflect the live deployment origin.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const origin = config.origin.replace(/\/$/, "");
  const body = [
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
