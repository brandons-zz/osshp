// TOTP (RFC 6238) for the recovery fallback lane (auth-security-assessment §5).
//
// Wraps otplib (spec §7 adopted; do NOT hand-roll — the RFC6238-over-node:crypto
// escape hatch is noted but only for an upstream-abandonment contingency). otplib
// v13's default crypto is a pure-JS Noble plugin, so this is runtime-agnostic (no
// node:crypto) and works identically in route handlers and `bun test`.
//
// SECURITY invariants enforced here:
//  - T1: secrets are ≥160-bit (otplib default 20 bytes → 32 base32 chars). The
//    secret itself is encrypted at rest by secret-box.ts; this module only
//    generates/verifies, never persists.
//  - T2: verifyTotp returns the matched time-STEP so the caller can reject reuse
//    of a code within its window (one-time-per-step).
//  - T4: window ≤ ±1 step — epochTolerance is one period (30s), i.e. exactly one
//    step on either side. A wider drift window is never used.

import { generate, generateSecret, generateURI, verify } from "otplib";

/** TOTP period in seconds (standard 30s step). */
const PERIOD_SECONDS = 30;

/**
 * Window tolerance in seconds. One period each side = window ±1 step (T4); never
 * widened. otplib accepts codes whose step is within ⌊tolerance / period⌋ of the
 * current step.
 */
const EPOCH_TOLERANCE_SECONDS = PERIOD_SECONDS;

/** Generate a fresh base32 TOTP secret (otplib default = 20 bytes / 160-bit, T1). */
export function generateTotpSecret(): string {
  return generateSecret();
}

/** Build an otpauth:// provisioning URI for an authenticator app (display once). */
export function totpProvisioningUri(
  secret: string,
  opts: { issuer: string; label: string },
): string {
  return generateURI({
    secret,
    issuer: opts.issuer,
    label: opts.label,
    period: PERIOD_SECONDS,
  });
}

export interface TotpVerifyResult {
  /** True iff the token is valid within the ±1-step window. */
  valid: boolean;
  /**
   * The absolute time-step the token matched, for one-time-per-step tracking
   * (T2). Null when invalid. Strictly increasing over time; reject a token whose
   * step ≤ the last consumed step.
   */
  step: number | null;
}

/**
 * Verify a TOTP token against a secret within the ±1-step window. `epoch` (seconds)
 * is injectable so the time-dependent behavior is unit-tested deterministically;
 * it defaults to the current time. Returns the matched step (T2) on success.
 */
export async function verifyTotp(
  secret: string,
  token: string,
  opts: { epoch?: number } = {},
): Promise<TotpVerifyResult> {
  const epoch = opts.epoch ?? Math.floor(Date.now() / 1000);
  try {
    const result = await verify({
      secret,
      token: token.trim(),
      period: PERIOD_SECONDS,
      epoch,
      epochTolerance: EPOCH_TOLERANCE_SECONDS,
    });
    if (!result.valid) return { valid: false, step: null };
    // otplib's `delta` is the matched step's offset from the current step (0 =
    // current, -1 = previous, +1 = next). The absolute step is the current step
    // plus that offset — strictly increasing in time, so callers can enforce
    // monotonic one-time-per-step consumption (T2).
    const currentStep = Math.floor(epoch / PERIOD_SECONDS);
    return { valid: true, step: currentStep + result.delta };
  } catch {
    return { valid: false, step: null };
  }
}

/** Generate the current token for a secret (test helper / parity with verify). */
export async function currentTotpToken(
  secret: string,
  opts: { epoch?: number } = {},
): Promise<string> {
  const epoch = opts.epoch ?? Math.floor(Date.now() / 1000);
  return generate({ secret, period: PERIOD_SECONDS, epoch });
}
