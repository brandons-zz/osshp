// Shared helpers for the auth API route handlers.

import type { RateLimitResult } from "@/lib/auth";

/** 429 response carrying a Retry-After header derived from the limiter. */
export function rateLimitedResponse(result: RateLimitResult): Response {
  return Response.json(
    { error: "rate_limited" },
    {
      status: 429,
      headers: { "retry-after": String(Math.ceil(result.retryAfterMs / 1000)) },
    },
  );
}

/** Parse a JSON body, returning null on malformed/absent input (never throws). */
export async function readJson<T = unknown>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
