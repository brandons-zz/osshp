// POST /api/auth/recovery/code — the single-use recovery-code lane.
//
// For an operator who lost both their passkey and their TOTP authenticator. A
// valid code is consumed (single-use), ALL sessions are revoked (S4), and a
// re-enrollment window opens (R6 — re-enrollment, NOT standing access): this
// returns NO session. The operator then re-establishes a passkey through the
// re-enrollment registration lane, which issues a session only once the new
// passkey is verified. Rate-limited as account lockout (B4); CSRF-guarded;
// audit-emitting (session.revoke_all is emitted inside consumeRecoveryCode).

import { getDb } from "@/lib/db/client";
import {
  clientKey,
  consumeRecoveryCode,
  guardMutation,
  recordAuthEvent,
  recoveryCodeLimiter,
} from "@/lib/auth";
import { rateLimitedResponse, readJson } from "../../_shared";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  // Cheap, no-side-effect body-shape validation runs BEFORE the rate-limit
  // check (which now persists to the database, migration 0013) — a request
  // with no code can never authenticate regardless, so there is no reason to
  // spend a database round trip or a unit of the caller's throttle budget on it.
  const body = await readJson<{ code?: string }>(request);
  if (!body?.code) {
    return Response.json({ error: "code is required" }, { status: 400 });
  }

  const key = clientKey("recovery-code", request);
  const limit = await recoveryCodeLimiter.check(db, key);
  if (!limit.allowed) {
    recordAuthEvent("lockout", "failure", { db,
      request,
      details: { lane: "recovery-code" },
    });
    return rateLimitedResponse(limit);
  }

  const reenrollToken = await consumeRecoveryCode(db, body.code);
  if (!reenrollToken) {
    recordAuthEvent("recovery.failure", "failure", { db,
      request,
      details: { lane: "recovery-code" },
    });
    return Response.json({ error: "recovery failed" }, { status: 401 });
  }

  await recoveryCodeLimiter.reset(db, key);
  recordAuthEvent("recovery.success", "success", { db,
    request,
    details: { lane: "recovery-code" },
  });
  // No session issued — the operator now has a possession-bound re-enrollment
  // window to register a fresh passkey (R6). The single-use reenrollToken is
  // returned ONCE here; the client presents it to the register ceremony (F1).
  return Response.json({ ok: true, reenroll: true, reenrollToken });
});
