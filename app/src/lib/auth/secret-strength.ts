// Boot-time secret strength floor (owasp-audit A02-G1; security-review NB-1).
//
// SESSION_SECRET and OSSHP_ENCRYPTION_KEY (config.ts) are each only required to be
// NON-EMPTY. A self-hoster who sets `changeme` would get a working — but
// brute-forceable / weakly-encrypted — instance, silently. This module fails LOUD
// at boot (instrumentation.register) if a secret is below a real floor, so a weak
// value stops the server from serving rather than shipping a forgeable-cookie or
// weak-TOTP-encryption instance.
//
// The floor is length + variety, chosen NOT to reject the documented generation
// method (`openssl rand -hex 32` → 64 lowercase hex chars, ~16 distinct symbols):
//  - length ≥ 32 chars
//  - ≥ 8 distinct characters (catches `aaaa…`, `changemechangeme…` repeats; a real
//    64-hex secret has ~16 distinct, far above the floor)
//  - not a known weak literal
//
// SESSION_SECRET is always required at boot (config.sessionSecret throws if
// unset), so an empty value is itself a failure. OSSHP_ENCRYPTION_KEY is
// optional at boot — it is only required lazily when the TOTP lane is first used
// (secret-box.ts / config.encryptionKey throw at that point, per the existing
// fail-closed guarantee) — so an unset encryption key is NOT a strength failure
// here; only a *weak but present* value is rejected.
//
// Pure (no I/O) so it is exhaustively unit-tested; the boot caller turns a failure
// into a hard process error.

/** Minimum secret length in characters. */
export const MIN_SECRET_LENGTH = 32;

/** Minimum number of distinct characters (entropy-variety floor). */
export const MIN_DISTINCT_CHARS = 8;

const WEAK_LITERALS: ReadonlySet<string> = new Set([
  "changeme",
  "change-me",
  "change_me",
  "changethis",
  "secret",
  "password",
  "default",
  "insecure",
  "session-secret",
]);

export interface SecretAssessment {
  ok: boolean;
  reason?: string;
}

/**
 * Assess a present (non-empty) secret's strength against the floor. Pure; does
 * NOT handle the empty/unset case — callers decide whether absence is itself a
 * failure (SESSION_SECRET) or an acceptable not-yet-configured state
 * (OSSHP_ENCRYPTION_KEY).
 */
function assessPresentSecret(secret: string, label: string): SecretAssessment {
  if (WEAK_LITERALS.has(secret.toLowerCase())) {
    return { ok: false, reason: `${label} is a known weak value` };
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      reason: `${label} is too short (${secret.length} chars; minimum ${MIN_SECRET_LENGTH})`,
    };
  }
  const distinct = new Set(secret).size;
  if (distinct < MIN_DISTINCT_CHARS) {
    return {
      ok: false,
      reason: `${label} has too few distinct characters (${distinct}; minimum ${MIN_DISTINCT_CHARS}) — looks low-entropy`,
    };
  }
  return { ok: true };
}

/** Assess SESSION_SECRET strength against the floor. Pure; returns a verdict. */
export function assessSessionSecret(
  secret: string | undefined | null,
): SecretAssessment {
  if (!secret) {
    return { ok: false, reason: "SESSION_SECRET is empty" };
  }
  return assessPresentSecret(secret, "SESSION_SECRET");
}

/**
 * Assess OSSHP_ENCRYPTION_KEY strength against the same floor as SESSION_SECRET.
 * Pure; returns a verdict. An unset/empty key is `ok: true` here — the key is
 * optional at boot (see module header) and its absence is already fail-closed at
 * first use via config.encryptionKey / secret-box.ts.
 */
export function assessEncryptionKeyStrength(
  secret: string | undefined | null,
): SecretAssessment {
  if (!secret) {
    return { ok: true };
  }
  return assessPresentSecret(secret, "OSSHP_ENCRYPTION_KEY");
}

/**
 * Boot-time guard: throw a hard error if SESSION_SECRET is below the floor.
 * Called from instrumentation.register() so a weak secret crashes startup with a
 * clear, actionable message instead of silently serving a brute-forceable instance.
 */
export function assertSessionSecretStrength(
  secret: string | undefined | null,
): void {
  const verdict = assessSessionSecret(secret);
  if (!verdict.ok) {
    throw new Error(
      `Refusing to start: ${verdict.reason}. ` +
        `Generate a strong secret with \`openssl rand -hex 32\` and set SESSION_SECRET in your .env.`,
    );
  }
}

/**
 * Boot-time guard: throw a hard error if OSSHP_ENCRYPTION_KEY is SET but below
 * the floor. Called from instrumentation.register() so a weak encryption key
 * crashes startup with a clear, actionable message instead of silently
 * SHA-256-deriving a weak AES-256-GCM key and degrading TOTP-secret
 * confidentiality at rest. An unset key does not throw here (see
 * assessEncryptionKeyStrength) — it fails closed at first use instead.
 */
export function assertEncryptionKeyStrength(
  secret: string | undefined | null,
): void {
  const verdict = assessEncryptionKeyStrength(secret);
  if (!verdict.ok) {
    throw new Error(
      `Refusing to start: ${verdict.reason}. ` +
        `Generate a strong key with \`openssl rand -hex 32\` and set OSSHP_ENCRYPTION_KEY in your .env.`,
    );
  }
}
