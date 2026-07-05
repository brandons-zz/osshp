// Typed environment access for the osshp app.
//
// All env-var reads go through this module — never read process.env directly in
// routes, server functions, or components. Getters are lazy so importing this
// module never throws at build time (e.g. when DATABASE_URL is unset during
// `next build`); the value is only required at the point of use.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it in your .env (see .env.example).`,
    );
  }
  return value;
}

export const config = {
  /** PostgreSQL connection string for the content/settings store (spec §4). */
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },

  // ── Auth (M1.6) ───────────────────────────────────────────────────────────
  // SECURITY: rpId/origin are PINNED from operator config at setup. They are
  // NEVER derived from a request Host / X-Forwarded-Host header (auth-security
  // -assessment W2, NO-GO #4). Reading them here — from env only, never from a
  // Request — is what makes the X-Forwarded-Host probe a no-op by construction.

  /** WebAuthn Relying Party ID — the registrable domain, no scheme/port. */
  get rpId(): string {
    return required("OSSHP_RP_ID");
  },
  /** WebAuthn expected origin — full origin including scheme. */
  get origin(): string {
    return required("OSSHP_ORIGIN");
  },
  /** User-visible RP display name (cosmetic only). */
  get rpName(): string {
    return process.env.OSSHP_RP_NAME ?? "osshp";
  },
  /** Secret for HMAC-signing session cookie tokens (`openssl rand -hex 32`). */
  get sessionSecret(): string {
    return required("SESSION_SECRET");
  },

  /**
   * Symmetric key for encrypting the TOTP secret at rest (auth-security-assessment
   * T1 / NO-GO #6). REQUIRED whenever the TOTP recovery lane is used: an absent key
   * is a clear config error, NEVER a silent fallback to plaintext storage. Any
   * sufficiently strong operator string works — secret-box derives a 32-byte AES
   * key from it. Generate with `openssl rand -hex 32`.
   */
  get encryptionKey(): string {
    return required("OSSHP_ENCRYPTION_KEY");
  },
  /**
   * Session cookies are Secure by default (auth-security-assessment S2 — Caddy
   * terminates TLS in-stack, so there is no plaintext-loopback exception to make).
   * Set SESSION_COOKIE_INSECURE=true ONLY for local http:// dev; the default is
   * always secure.
   */
  get cookieSecure(): boolean {
    return process.env.SESSION_COOKIE_INSECURE !== "true";
  },

  /**
   * Session idle-timeout window in milliseconds (owasp-audit A07-G1). Enforced by
   * validateSession ALONGSIDE the 7-day absolute TTL: a session is rejected once
   * `now − last_seen_at` exceeds this window, even before absolute expiry. Active
   * use refreshes last_seen_at, sliding the window. Default 24h; override with
   * SESSION_IDLE_MS.
   */
  get sessionIdleMs(): number {
    const raw = process.env.SESSION_IDLE_MS;
    if (raw === undefined) return 1000 * 60 * 60 * 24; // 24 hours
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 1000 * 60 * 60 * 24;
  },

  /**
   * Number of trusted reverse proxies in front of the app. Used to pick the
   * trustworthy entry from `X-Forwarded-For` when keying the auth rate limiter
   * (auth-security-assessment H4, NO-GO #7). The default deployment is Caddy
   * in-stack → 1 hop. Set 0 for direct exposure (no proxy): the forwarded header
   * is then fully untrusted and ignored for throttling, leaving the IP-independent
   * global per-lane cap as the bound.
   *
   * SECURITY: like rpId/origin, this is OPERATOR config — never inferred from a
   * client header. Trusting the leftmost (client-supplied) XFF token is exactly
   * the bypass NO-GO #7 must prevent.
   */
  get trustedProxyHops(): number {
    const raw = process.env.OSSHP_TRUSTED_PROXY_HOPS;
    if (raw === undefined) return 1;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 1;
  },

  // ── Object storage (S3-compatible: Garage v2 locally → real S3 later) ───────
  // The minio npm client talks to any S3-compatible endpoint unchanged (spec §4).
  // Garage runs as the `storage` compose service; for real S3 the operator changes
  // S3_ENDPOINT only — no code change.

  /** S3 endpoint URL (scheme://host[:port]); the compose default is Garage. */
  get s3Endpoint(): string {
    return required("S3_ENDPOINT");
  },
  /** S3 access key id (provisioned during Garage setup). */
  get s3AccessKey(): string {
    return required("S3_ACCESS_KEY");
  },
  /** S3 secret access key. */
  get s3SecretKey(): string {
    return required("S3_SECRET_KEY");
  },
  /** Bucket holding uploaded media binaries + their responsive variants. */
  get s3Bucket(): string {
    return process.env.S3_BUCKET ?? "osshp-media";
  },
  /** S3 region (Garage is region-agnostic; real S3 needs the right value). */
  get s3Region(): string {
    return process.env.S3_REGION ?? "us-east-1";
  },
};
