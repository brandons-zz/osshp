// POST /api/auth/login/options — begin a passkey authentication ceremony.
// Rate-limited (NO-GO #7). RP-ID is pinned from config inside the builder (W2).

import { getDb } from "@/lib/db/client";
import {
  buildAuthenticationOptions,
  clientKey,
  guardMutation,
  isBootstrapAvailable,
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
  const options = await buildAuthenticationOptions(db);
  return Response.json(options);
});
