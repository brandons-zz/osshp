// POST /api/auth/login/options — begin a passkey authentication ceremony.
// Rate-limited (NO-GO #7). RP-ID is pinned from config inside the builder (W2).
//
// This endpoint is reachable by ANY unauthenticated caller by design (someone
// has to be able to start signing in) — issue 075: the ceremonyId returned by
// buildAuthenticationOptions is round-tripped to the browser via a short-lived,
// HttpOnly cookie (Path=/api/auth/login) so a concurrent, unrelated caller's
// own options request cannot clobber THIS caller's in-flight challenge.

import { getDb } from "@/lib/db/client";
import {
  buildAuthenticationOptions,
  clientKey,
  guardMutation,
  isBootstrapAvailable,
  loginChallengeCookieHeader,
  loginLimiter,
  recordAuthEvent,
} from "@/lib/auth";
import { rateLimitedResponse } from "../../_shared";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  const limit = loginLimiter.check(clientKey("login", request));
  if (!limit.allowed) {
    recordAuthEvent("rate_limit.trip", "failure", {
      request,
      details: { lane: "login" },
    });
    return rateLimitedResponse(limit);
  }

  if (await isBootstrapAvailable(db)) {
    return Response.json({ error: "no admin provisioned" }, { status: 409 });
  }
  const { options, ceremonyId } = await buildAuthenticationOptions(db);
  return Response.json(options, {
    headers: { "set-cookie": loginChallengeCookieHeader(ceremonyId) },
  });
});
