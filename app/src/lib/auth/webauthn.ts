// SimpleWebAuthn ceremony wrappers (auth-security-assessment §3).
//
// SimpleWebAuthn owns the four ceremony halves; we own the challenge store, the
// credential record, the session, and — critically — the RP-ID/origin SOURCE.
//
// SECURITY invariants enforced here:
//  - W2/NO-GO #4: rpID + expectedOrigin come from rpConfig() (operator config),
//    NEVER from a request header. No function in this module reads a Request.
//  - W1: challenge is single-use (storeChallenge / consumeChallenge).
//  - W4: userVerification = "required".
//  - W5/NO-GO #1/#2: registration lane is gated (resolveRegistrationMode).
//  - W6: synced-passkey counter regression is tolerated (no hard-fail on 0).
//  - W7: attestationType = "none".
//
// Node-only (uses base64url Buffer encoding) — imported by route handlers, not
// the Edge middleware.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Db } from "@/lib/db/types";
import type { PasskeyCredential } from "@/lib/content/types";
import {
  createAdminUser,
  getAdminUser,
  updateAdminUser,
} from "@/lib/content/admin-user";
import { config } from "@/lib/config";
import {
  storeChallenge,
  consumeChallenge,
  newCeremonyId,
  storeLoginChallenge,
  consumeLoginChallenge,
} from "./challenges";
import { resolveRegistrationMode, type RegistrationMode } from "./bootstrap";
import { clearReenrollment } from "./reenroll";
import { base64urlToBytes, bytesToBase64url } from "./encoding";

/** Stable user handle for the single admin (cosmetic; not a secret). */
const ADMIN_USER_HANDLE = new TextEncoder().encode("osshp-admin");
const ADMIN_USER_NAME = "admin";

/**
 * The pinned Relying Party config. Read from operator env ONLY (config.rpId /
 * config.origin) — this is the W2 / NO-GO #4 guarantee. There is deliberately no
 * Request parameter: an attacker-controlled Host / X-Forwarded-Host header has
 * no path into the ceremony.
 */
export function rpConfig(): { rpName: string; rpID: string; origin: string } {
  return { rpName: config.rpName, rpID: config.rpId, origin: config.origin };
}

export class WebAuthnVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAuthnVerificationError";
  }
}

function asTransports(
  transports: string[] | undefined,
): AuthenticatorTransportFuture[] | undefined {
  return transports as AuthenticatorTransportFuture[] | undefined;
}

function toCredentialDescriptors(creds: PasskeyCredential[]) {
  return creds.map((c) => ({
    id: c.credentialId,
    transports: asTransports(c.transports),
  }));
}

// ── Registration (passkey enrollment) ────────────────────────────────────────

/**
 * Build registration options. Gated by resolveRegistrationMode (throws unless a
 * lane is permitted: bootstrap, authenticated step-up, or a token-bearing reenroll
 * during an open window — F1). Stores the single-use challenge.
 */
export async function buildRegistrationOptions(
  db: Db,
  ctx: { authenticated: boolean; reenrollToken?: string },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  await resolveRegistrationMode(db, ctx); // throws RegistrationForbiddenError if denied
  const { rpName, rpID } = rpConfig();
  const admin = await getAdminUser(db);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: ADMIN_USER_NAME,
    userID: ADMIN_USER_HANDLE,
    attestationType: "none", // W7
    excludeCredentials: toCredentialDescriptors(admin?.passkeyCredentials ?? []),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required", // W4
    },
  });
  await storeChallenge(db, "registration", options.challenge); // W1
  return options;
}

export interface RegistrationResult {
  mode: RegistrationMode;
  credentialId: string;
}

/**
 * Verify a registration response and persist the credential. On bootstrap this
 * creates the admin (closing the wizard, NO-GO #1); on step-up it appends a
 * credential to the existing admin. The caller is responsible for issuing a
 * rotated session after a successful bootstrap.
 */
export async function verifyRegistration(
  db: Db,
  ctx: {
    authenticated: boolean;
    response: RegistrationResponseJSON;
    reenrollToken?: string;
  },
): Promise<RegistrationResult> {
  const mode = await resolveRegistrationMode(db, ctx); // re-checked at verify (defense in depth)
  const challenge = await consumeChallenge(db, "registration"); // single-use
  if (!challenge) {
    throw new WebAuthnVerificationError("No active registration challenge.");
  }
  const { rpID, origin } = rpConfig();
  const verification = await verifyRegistrationResponse({
    response: ctx.response,
    expectedChallenge: challenge,
    expectedOrigin: origin, // W2 — pinned
    expectedRPID: rpID, // W2 — pinned
    requireUserVerification: true, // W4
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new WebAuthnVerificationError("Registration could not be verified.");
  }

  const cred = verification.registrationInfo.credential;
  const stored: PasskeyCredential = {
    credentialId: cred.id,
    publicKey: bytesToBase64url(cred.publicKey),
    counter: cred.counter,
    transports: cred.transports,
  };

  if (mode === "bootstrap") {
    // createAdminUser throws if an admin already exists (lock_col UNIQUE) — a
    // second, race-y bootstrap can never provision a second admin (NO-GO #1).
    await createAdminUser(db, { passkeyCredentials: [stored] });
  } else {
    // step-up (authenticated) OR reenroll (recovery-window) — both append a
    // credential to the existing admin.
    const admin = await getAdminUser(db);
    if (!admin) throw new WebAuthnVerificationError("Admin record missing.");
    await updateAdminUser(db, {
      passkeyCredentials: [...admin.passkeyCredentials, stored],
    });
    // A successful re-enrollment closes the recovery window the instant a new
    // passkey is established (R6 — the grant was a one-shot re-enrollment chance).
    if (mode === "reenroll") await clearReenrollment(db);
  }
  return { mode, credentialId: stored.credentialId };
}

// ── Authentication (passkey login) ───────────────────────────────────────────

export interface AuthenticationCeremony {
  options: PublicKeyCredentialRequestOptionsJSON;
  /** Bound to the caller via a short-lived cookie (issue 075) — scopes this
   *  challenge to THIS ceremony so a concurrent, unrelated caller cannot
   *  clobber it. The caller (route) must round-trip this to verifyAuthentication. */
  ceremonyId: string;
}

/**
 * Build authentication options (allowing the admin's registered credentials).
 * POST /api/auth/login/options is reachable by any unauthenticated caller by
 * design (someone has to be able to start signing in) — the returned
 * ceremonyId is what keeps two concurrent callers' challenges from clobbering
 * each other (issue 075), replacing the old shared "authentication" row.
 */
export async function buildAuthenticationOptions(
  db: Db,
): Promise<AuthenticationCeremony> {
  const { rpID } = rpConfig();
  const admin = await getAdminUser(db);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required", // W4
    allowCredentials: toCredentialDescriptors(admin?.passkeyCredentials ?? []),
  });
  const ceremonyId = newCeremonyId();
  await storeLoginChallenge(db, ceremonyId, options.challenge); // W1 + issue 075 scoping
  return { options, ceremonyId };
}

export interface AuthenticationResult {
  credentialId: string;
}

/**
 * Verify an authentication response. `ceremonyId` (from the caller's own
 * login-ceremony cookie, issue 075) scopes which challenge row this call may
 * consume — a stale, missing, or foreign ceremonyId always fails here,
 * regardless of what any OTHER concurrent caller did to their own row. On
 * success the credential counter is persisted (W6: a non-incrementing counter
 * from a synced passkey is tolerated — we never hard-fail on counter stasis,
 * we only persist the max seen). The caller issues a rotated session after
 * success (S3).
 */
export async function verifyAuthentication(
  db: Db,
  ctx: { response: AuthenticationResponseJSON; ceremonyId: string | undefined },
): Promise<AuthenticationResult> {
  const challenge = await consumeLoginChallenge(db, ctx.ceremonyId); // single-use, issue 075 scoping
  if (!challenge) {
    throw new WebAuthnVerificationError("No active authentication challenge.");
  }
  const admin = await getAdminUser(db);
  if (!admin) throw new WebAuthnVerificationError("No admin to authenticate.");

  const credentialId = ctx.response.id;
  const stored = admin.passkeyCredentials.find(
    (c) => c.credentialId === credentialId,
  );
  if (!stored) {
    throw new WebAuthnVerificationError("Unknown credential.");
  }

  const { rpID, origin } = rpConfig();
  const verification = await verifyAuthenticationResponse({
    response: ctx.response,
    expectedChallenge: challenge,
    expectedOrigin: origin, // W2 — pinned
    expectedRPID: rpID, // W2 — pinned
    requireUserVerification: true, // W4
    credential: {
      id: stored.credentialId,
      publicKey: base64urlToBytes(stored.publicKey),
      counter: stored.counter,
      transports: asTransports(stored.transports),
    },
  });
  if (!verification.verified) {
    throw new WebAuthnVerificationError("Authentication could not be verified.");
  }

  // W6: persist the highest counter seen; never hard-fail on a synced passkey
  // that reports 0 / does not increment.
  const newCounter = verification.authenticationInfo.newCounter;
  if (newCounter > stored.counter) {
    const updated = admin.passkeyCredentials.map((c) =>
      c.credentialId === credentialId ? { ...c, counter: newCounter } : c,
    );
    await updateAdminUser(db, { passkeyCredentials: updated });
  }
  return { credentialId };
}
