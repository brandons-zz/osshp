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
  const key = clientKey("recovery-code", request);
  const limit = recoveryCodeLimiter.check(key);
  if (!limit.allowed) {
    recordAuthEvent("lockout", "failure", {
      request,
      details: { lane: "recovery-code" },
    });
    return rateLimitedResponse(limit);
  }

  const body = await readJson<{ code?: string }>(request);
  if (!body?.code) {
    return Response.json({ error: "code is required" }, { status: 400 });
  }

  const reenrollToken = await consumeRecoveryCode(db, body.code);
  if (!reenrollToken) {
    recordAuthEvent("recovery.failure", "failure", {
      request,
      details: { lane: "recovery-code" },
    });
    return Response.json({ error: "recovery failed" }, { status: 401 });
  }

  recoveryCodeLimiter.reset(key);
  recordAuthEvent("recovery.success", "success", {
    request,
    details: { lane: "recovery-code" },
  });
  // No session issued — the operator now has a possession-bound re-enrollment
  // window to register a fresh passkey (R6). The single-use reenrollToken is
  // returned ONCE here; the client presents it to the register ceremony (F1).
  return Response.json({ ok: true, reenroll: true, reenrollToken });
});
