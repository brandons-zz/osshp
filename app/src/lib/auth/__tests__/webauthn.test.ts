// WebAuthn ceremony glue: RP-ID/origin pinned from config (never headers),
// registration gating, and the single-use challenge handshake.

process.env.OSSHP_RP_ID = "blog.example";
process.env.OSSHP_ORIGIN = "https://blog.example";
process.env.OSSHP_RP_NAME = "Example Blog";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createAdminUser } from "@/lib/content/admin-user";
import { consumeChallenge, consumeLoginChallenge } from "../challenges";
import { RegistrationForbiddenError } from "../bootstrap";
import { buildAuthenticationOptions, buildRegistrationOptions, rpConfig } from "../webauthn";

let h: TestDb;
let db: Db;
beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

test("rpConfig is sourced from operator config and takes no request", () => {
  // It is a zero-argument function — there is NO path for a Host /
  // X-Forwarded-Host header to influence the RP-ID/origin (W2, NO-GO #4).
  expect(rpConfig.length).toBe(0);
  expect(rpConfig()).toEqual({
    rpName: "Example Blog",
    rpID: "blog.example",
    origin: "https://blog.example",
  });
});

test("registration options pin RP-ID from config and set the security knobs", async () => {
  const options = await buildRegistrationOptions(db, { authenticated: false });
  // RP-ID comes from OSSHP_RP_ID — not derivable from any inbound header.
  expect(options.rp.id).toBe("blog.example");
  expect(options.authenticatorSelection?.userVerification).toBe("required"); // W4
  expect(options.attestation).toBe("none"); // W7
});

test("RP-ID is unchanged regardless of request context (X-Forwarded-Host is a no-op, W2)", async () => {
  // buildRegistrationOptions never sees a Request, so a spoofed host cannot steer
  // the ceremony. The RP-ID always equals the pinned config value. (Live HTTP
  // probe with an X-Forwarded-Host header is a separate M1.7 security gate.)
  const a = await buildRegistrationOptions(db, { authenticated: false });
  const b = await buildRegistrationOptions(db, { authenticated: false });
  expect(a.rp.id).toBe(process.env.OSSHP_RP_ID);
  expect(b.rp.id).toBe(process.env.OSSHP_RP_ID);
});

test("registration stores a single-use challenge", async () => {
  const options = await buildRegistrationOptions(db, { authenticated: false });
  const stored = await consumeChallenge(db, "registration");
  expect(stored).toBe(options.challenge);
  // Consumed — cannot be replayed.
  expect(await consumeChallenge(db, "registration")).toBeNull();
});

test("after provisioning, building options for an anonymous caller is forbidden (W5, NO-GO #2)", async () => {
  await createAdminUser(db);
  await expect(
    buildRegistrationOptions(db, { authenticated: false }),
  ).rejects.toBeInstanceOf(RegistrationForbiddenError);
});

// ── Login-lane ceremony scoping (issue 075) ──────────────────────────────────
//
// buildAuthenticationOptions is reachable by any unauthenticated caller by
// design (POST /api/auth/login/options has no session/gate). This is the exact
// AC sequence from issue 075: request options as "admin", request options
// again as "attacker", then confirm admin's original challenge is still
// exactly what it was — B's later options call must not have clobbered it.

test("authentication options each get their own ceremonyId and single-use challenge", async () => {
  const { options, ceremonyId } = await buildAuthenticationOptions(db);
  expect(typeof ceremonyId).toBe("string");
  expect(ceremonyId.length).toBeGreaterThan(0);
  const stored = await consumeLoginChallenge(db, ceremonyId);
  expect(stored).toBe(options.challenge);
  // Consumed — cannot be replayed (W1).
  expect(await consumeLoginChallenge(db, ceremonyId)).toBeNull();
});

test("a concurrent caller's options request does not clobber an earlier caller's challenge (issue 075)", async () => {
  // "admin" loads /login and gets a challenge.
  const admin = await buildAuthenticationOptions(db);
  // Before admin completes the passkey prompt, an unrelated caller (attacker)
  // also calls /login/options. Pre-fix this shared one row keyed on the
  // literal "authentication" and would have overwritten admin's challenge.
  const attacker = await buildAuthenticationOptions(db);

  expect(admin.ceremonyId).not.toBe(attacker.ceremonyId);
  expect(admin.options.challenge).not.toBe(attacker.options.challenge);

  // admin's own ceremony still resolves to admin's OWN original challenge —
  // proving attacker's later call did not clobber it.
  expect(await consumeLoginChallenge(db, admin.ceremonyId)).toBe(
    admin.options.challenge,
  );
  // attacker's ceremony is independently intact too.
  expect(await consumeLoginChallenge(db, attacker.ceremonyId)).toBe(
    attacker.options.challenge,
  );
});
