// Schema migrations for the osshp content + settings core (spec §8).
//
// Each migration is an ordered list of single SQL statements (the executor seam
// runs one statement per call, portable across postgres.js and PGlite). Every
// statement is written to be safe to re-run (IF NOT EXISTS), and the migrate()
// runner additionally tracks applied migrations — so migrations are idempotent
// and dev-server-restart-safe by two independent mechanisms.
//
// Status is modeled as TEXT + CHECK rather than a Postgres ENUM type: CHECK
// constraints enforce the draft/published/scheduled model just as strictly, and
// avoid the non-idempotent `CREATE TYPE` (which has no IF NOT EXISTS).

export interface Migration {
  id: string;
  statements: string[];
}

const STATUS_CHECK = "status IN ('draft', 'published', 'scheduled')";

export const MIGRATIONS: Migration[] = [
  {
    id: "0001_content_and_settings_core",
    statements: [
      // ── Tags ────────────────────────────────────────────────────────────
      `CREATE TABLE IF NOT EXISTS tags (
        id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE
      )`,

      // ── Posts (spec §8: article | photo-post; draft|published|scheduled) ─
      `CREATE TABLE IF NOT EXISTS posts (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title           TEXT NOT NULL,
        slug            TEXT NOT NULL UNIQUE,
        body            TEXT NOT NULL,
        excerpt         TEXT NOT NULL DEFAULT '',
        cover_image_src TEXT,
        cover_image_alt TEXT,
        type            TEXT NOT NULL DEFAULT 'article'
                          CHECK (type IN ('article', 'photo-post')),
        status          TEXT NOT NULL DEFAULT 'draft'
                          CHECK (${STATUS_CHECK}),
        publish_date    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS posts_status_publish_date_idx
        ON posts (status, publish_date DESC)`,

      // ── Post ↔ Tag join ─────────────────────────────────────────────────
      `CREATE TABLE IF NOT EXISTS post_tags (
        post_id UUID NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
        tag_id  UUID NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
        PRIMARY KEY (post_id, tag_id)
      )`,

      // ── Pages (spec §8: About/portfolio). Status added so the published-
      //    only theme boundary (theme-rendering-contract §3.3) applies to
      //    pages too — a page with no status could never be held as a draft. ─
      `CREATE TABLE IF NOT EXISTS pages (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title      TEXT NOT NULL,
        slug       TEXT NOT NULL UNIQUE,
        body       TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'draft' CHECK (${STATUS_CHECK}),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,

      // ── Media references (binaries live in Garage; this stores references).
      //    responsive_sizes + exif_stripped are MODELED now; the resize/strip
      //    pipeline that populates them is M2.4/M2.5 (spec §8). ──────────────
      `CREATE TABLE IF NOT EXISTS media (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        storage_key      TEXT NOT NULL UNIQUE,
        alt              TEXT NOT NULL DEFAULT '',
        mime_type        TEXT,
        width            INTEGER,
        height           INTEGER,
        responsive_sizes JSONB NOT NULL DEFAULT '[]'::jsonb,
        exif_stripped    BOOLEAN NOT NULL DEFAULT false,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,

      // ── Settings (key/value/visibility). The public/admin split is the
      //    theme boundary: visibility defaults to 'admin' (module-contract
      //    §3.4 — fail-safe), and only 'public' rows can be served to a theme.
      `CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'admin'
                     CHECK (visibility IN ('public', 'admin'))
      )`,

      // ── Single admin user (spec §8). Fields for passkeys/password/TOTP/
      //    recovery are MODELED now; the auth behavior is M1.6/M2.1. The
      //    lock_col + UNIQUE + CHECK guarantees at most one admin row. ───────
      `CREATE TABLE IF NOT EXISTS admin_user (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lock_col            CHAR(1) NOT NULL DEFAULT 'X' UNIQUE
                              CHECK (lock_col = 'X'),
        passkey_credentials JSONB NOT NULL DEFAULT '[]'::jsonb,
        password_hash       TEXT,
        totp_secret         TEXT,
        recovery_codes      JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    ],
  },

  {
    // ── Auth core (M1.6) ────────────────────────────────────────────────────
    // First-party, server-side, revocable sessions + single-use WebAuthn
    // challenge store. The cookie carries `<id>.<hmac>`; the row keyed by the
    // high-entropy id is the authoritative, revocable record (delete = revoke).
    // auth_challenges holds the in-flight ceremony challenge, consumed once on
    // verify (single-use, auth-security-assessment W1).
    id: "0002_auth_sessions_and_challenges",
    statements: [
      `CREATE TABLE IF NOT EXISTS sessions (
        id           TEXT PRIMARY KEY,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at   TIMESTAMPTZ NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS sessions_expires_at_idx
        ON sessions (expires_at)`,

      // One in-flight challenge per ceremony type (single admin = one ceremony
      // at a time). PRIMARY KEY (type) makes store an upsert and consume a
      // delete-returning, so a challenge can never be replayed (W1).
      `CREATE TABLE IF NOT EXISTS auth_challenges (
        type       TEXT PRIMARY KEY
                     CHECK (type IN ('registration', 'authentication')),
        challenge  TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    ],
  },

  {
    // ── Panoramic flag for photo-posts (DRIFT-3 fix — Direction A Colophon) ─
    // Enables the .wide span-2 tile in the Editorial photo grid. Defaulting
    // false is safe: all existing photo-posts render as square tiles until an
    // author explicitly marks one panoramic.
    id: "0004_panoramic_photo_posts",
    statements: [
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS panoramic BOOLEAN NOT NULL DEFAULT false`,
    ],
  },

  {
    // ── "Also show in blog stream" flag for photo-posts ──────────────────────
    // Photo-posts live at /photos/<slug>; by default they are excluded from the
    // /blog listing. When show_in_blog is true the photo-post appears in the
    // blog listing too, but its link still points to its /photos/<slug> home.
    // Articles ignore this column (the blog-stream query filter only activates it
    // for photo-post rows). Defaulting false is safe: all existing photo-posts
    // stay out of the blog stream until an author opts them in.
    id: "0005_photo_post_blog_flag",
    statements: [
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS show_in_blog BOOLEAN NOT NULL DEFAULT false`,
    ],
  },

  {
    // ── Layered recovery lanes (M2.2) ───────────────────────────────────────
    // The single-identity model has no peer-admin recovery, so the layered
    // recovery chain (password+TOTP fallback, recovery codes, CLI break-glass)
    // IS the compensating control. password_hash / totp_secret / recovery_codes
    // already exist on admin_user (modeled in 0001); these columns add the
    // behavior state the lanes need:
    //  - totp_enabled: TOTP is verify-before-enable (auth-security-assessment
    //    T5) — a secret is stored on enroll but the lane only counts once a valid
    //    code confirms it, so totp_secret-set ≠ active.
    //  - totp_last_step: the last consumed TOTP time-step, for one-time-per-step
    //    replay rejection (T2). A code whose step ≤ this value is refused.
    //  - reenroll_until: a time-boxed re-enrollment grant opened by a recovery
    //    event (recovery-code use / CLI break-glass). It grants RE-ENROLLMENT,
    //    not standing access (R6): while open, the passkey registration ceremony
    //    is permitted unauthenticated; it issues no session by itself.
    id: "0003_recovery_lanes",
    statements: [
      `ALTER TABLE admin_user
        ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE admin_user
        ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NOT NULL DEFAULT 0`,
      `ALTER TABLE admin_user
        ADD COLUMN IF NOT EXISTS reenroll_until TIMESTAMPTZ`,
    ],
  },

  {
    // ── "Show in navigation" flag for pages (V-010) ─────────────────────────
    // When true, a published page is automatically merged into the rendered site
    // nav alongside the manually-managed site.nav entries from Settings. Defaults
    // false so all existing pages stay out of the nav until an author opts them
    // in via the page editor toggle.
    id: "0006_page_show_in_nav",
    statements: [
      `ALTER TABLE pages ADD COLUMN IF NOT EXISTS show_in_nav BOOLEAN NOT NULL DEFAULT false`,
    ],
  },

  {
    // ── "Featured" flag for the home showcase (issue 012) ───────────────────
    // When true, a published post (article OR photo-post) is eligible for the
    // home "§ 00 · Selected" showcase. The home renders up to four featured
    // items at a time, randomly rotating through the set when more than four
    // are flagged. Applies to BOTH post types (unlike show_in_blog, which is
    // photo-post only). Defaults false so nothing is featured until an author
    // opts a post in via the editor toggle.
    id: "0007_post_featured_flag",
    statements: [
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false`,
    ],
  },

  {
    // ── Possession-bound re-enrollment token (F1 — external security review) ─
    // reenroll_until (0003) is time-boxed but NOT possession-bound: any
    // unauthenticated caller who reaches the public register ceremony during an
    // open window could enroll their own passkey. This column binds the window to
    // a single-use CSPRNG token, stored HASHED — the reenroll registration lane
    // now requires window-open AND a matching token. NULL when no window is open;
    // cleared alongside reenroll_until the instant a re-enrollment succeeds.
    id: "0008_reenroll_token",
    statements: [
      `ALTER TABLE admin_user ADD COLUMN IF NOT EXISTS reenroll_token_hash TEXT`,
    ],
  },

  {
    // ── Gallery photo posts (issue 047) ─────────────────────────────────────
    // A photo post is one of two MODES: Single (today's flow — one cover image
    // stored on cover_image_src/alt, byte-behavior-identical, untouched) or
    // Gallery (an ordered set of media references). The mode flag `is_gallery`
    // makes the choice explicit even for a zero-image draft; it defaults false
    // so every existing photo post stays a Single with zero behavior change.
    //
    //  - post_media: the ordered join — one row per gallery image, carrying its
    //    display `position` and an optional per-photo `caption`. Alt is NOT here;
    //    it lives on the referenced media row (the canonical, single source of
    //    alt). Removing a gallery image drops its post_media row only — the media
    //    binary stays in the library (galleries reference media, they don't own
    //    it). ON DELETE CASCADE on post_id cleans a deleted post's rows; ON
    //    DELETE CASCADE on media_id drops a reference if the media is hard-deleted.
    //  - cover_media_id: which gallery image is the post's card/index/OG cover
    //    (author-picks; defaults to the first). SET NULL if that media is deleted
    //    so a dangling cover never 404s — the read falls back to the first image.
    //
    // Single-photo posts are the degenerate case: is_gallery=false, no post_media
    // rows, cover on cover_image_src as before. The public/index reads branch on
    // is_gallery, so the Single path never touches this table.
    id: "0009_gallery_photo_posts",
    statements: [
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_gallery BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS cover_media_id UUID REFERENCES media (id) ON DELETE SET NULL`,
      `CREATE TABLE IF NOT EXISTS post_media (
        post_id  UUID NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
        media_id UUID NOT NULL REFERENCES media (id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        caption  TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (post_id, media_id)
      )`,
      `CREATE INDEX IF NOT EXISTS post_media_post_position_idx
        ON post_media (post_id, position)`,
    ],
  },

  {
    // ── First-party analytics events (issue 029) ────────────────────────────
    // One row per recorded public pageview. Deliberately LEAN and PII-free per
    // the ratified privacy posture: no raw IP, no User-Agent string, no cookie
    // id — only the UTC calendar day, the served path (no query string), the
    // referrer's HOST only (no full URL/query string), and a salted visitor
    // hash. The hash is computed from (IP, UA, UTC day) using a daily-rotating
    // random salt that lives ONLY in server memory for its own day and is never
    // persisted — see lib/analytics/salt.ts — so a stored hash can never be
    // reversed to an IP/UA, and hashes are unlinkable across day boundaries by
    // construction (COUNT DISTINCT visitor_hash over a window is therefore an
    // ESTIMATE that never re-identifies a returning visitor across days, not an
    // exact unique count).
    //
    // `day` (not created_at) is the retention/aggregation key throughout —
    // pruning ("older than 90 days") and windowed rollups (7/30/90-day) both
    // filter on it, so behavior matches the "UTC day" model exactly.
    id: "0010_analytics_events",
    statements: [
      `CREATE TABLE IF NOT EXISTS analytics_events (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        day           DATE NOT NULL,
        path          TEXT NOT NULL,
        referrer_host TEXT,
        visitor_hash  TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS analytics_events_day_idx
        ON analytics_events (day)`,
      `CREATE INDEX IF NOT EXISTS analytics_events_day_path_idx
        ON analytics_events (day, path)`,
      `CREATE INDEX IF NOT EXISTS analytics_events_day_referrer_idx
        ON analytics_events (day, referrer_host)`,
    ],
  },

  {
    // auth_login_challenges — issue 075. The login/authentication ceremony is
    // reachable by ANY unauthenticated caller by design (someone has to be able
    // to start signing in). Sharing one row keyed on a fixed literal ("the
    // authentication challenge", as auth_challenges.type did) let a second,
    // unrelated caller's POST /api/auth/login/options silently overwrite the
    // first caller's in-flight challenge — an availability DoS on the admin's
    // own passkey login. Each row here is keyed on a per-attempt, server-
    // generated, high-entropy ceremony_id (bound to the caller via a short-lived
    // cookie, never client-chosen) instead of a shared literal, so two
    // concurrent login attempts get two independent rows and cannot clobber
    // each other. Registration is NOT similarly exposed (gated by
    // resolveRegistrationMode) and keeps using auth_challenges unchanged.
    id: "0011_auth_login_challenges",
    statements: [
      `CREATE TABLE IF NOT EXISTS auth_login_challenges (
        ceremony_id TEXT PRIMARY KEY,
        challenge   TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS auth_login_challenges_expires_at_idx
        ON auth_login_challenges (expires_at)`,
    ],
  },

  {
    // ── Media attribution (issue 077) ───────────────────────────────────────
    // External inline images (`![alt](https://other-host/…)`) are blocked by the
    // strict `img-src 'self' data:` CSP. The fix is to auto-fetch such images
    // server-side (SSRF-bounded — see lib/media/externalFetch.ts), re-encode
    // them through the existing M2.7/M2.9 pipeline, and store them like any
    // other upload. These three columns record where an auto-imported image
    // came from, so the credit obligation is honored (attribution ≠ license —
    // the operator remains responsible for having the right to use the image):
    //  - source_url:  the original external URL the image was fetched from.
    //    NULL for an ordinary upload (never fetched from anywhere).
    //  - attribution: optional author/credit text, captured from the markdown
    //    image's title slot at import time (`![alt](url "credit")`). NULL when
    //    no credit was supplied.
    //  - license:     optional license note (e.g. "CC BY 4.0"). NULL when not
    //    recorded. Not settable by auto-import itself (markdown has no license
    //    slot) — reserved for a future media-library edit affordance.
    // All three are nullable so ordinary uploads are unaffected.
    id: "0012_media_attribution",
    statements: [
      `ALTER TABLE media ADD COLUMN IF NOT EXISTS source_url TEXT`,
      `ALTER TABLE media ADD COLUMN IF NOT EXISTS attribution TEXT`,
      `ALTER TABLE media ADD COLUMN IF NOT EXISTS license TEXT`,
    ],
  },

  {
    // ── Rate-limit windows — durable throttle state (auth-security-assessment
    //    H4 follow-up) ────────────────────────────────────────────────────────
    // The auth rate-limiter (lib/auth/rate-limit.ts) previously kept its fixed
    // windows in a process-local Map: correct within a process, but every
    // recorded attempt (and the brute-force resistance it represents) was
    // silently wiped on every restart/deploy. This table gives each window —
    // per-key AND the IP-independent per-lane global window — a durable row so
    // a restart never resets an in-progress lockout.
    //
    //  - key:      the window's storage key. Per-key windows use the same
    //              `<lane>:<client-ip>` string rate-limit.ts already computes
    //              (clientKey); each lane's global window uses a distinct
    //              `__global__:<lane>` key so lanes never collide.
    //  - count:    hits recorded in the current window.
    //  - reset_at: epoch-ms the window expires — plain BIGINT (not
    //              TIMESTAMPTZ) so the limiter's existing clock-injectable
    //              `now: number` design (unit-tested with fixed epoch values)
    //              carries straight through to the persisted row with no
    //              conversion, and so restart-durability and expiry can be
    //              asserted with plain integer comparisons in tests.
    // No foreign keys, no cascade — this is throttle bookkeeping, not content.
    // A row past its reset_at is inert (the next check() on that key treats it
    // as expired and starts fresh); sweepExpiredRateLimitWindows() also prunes
    // expired rows periodically (mirrors the auth_login_challenges sweep-on-
    // access pattern) so the table does not grow unbounded under rotating-key
    // traffic — the same guarantee issue 023 established for the in-memory Map.
    id: "0013_rate_limit_windows",
    statements: [
      `CREATE TABLE IF NOT EXISTS rate_limit_windows (
        key      TEXT PRIMARY KEY,
        count    INTEGER NOT NULL,
        reset_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS rate_limit_windows_reset_at_idx
        ON rate_limit_windows (reset_at)`,
    ],
  },

  {
    // ── Step-up re-authentication grants ──────────────────────────────────────
    // A step-up grant is a single-use, short-lived, factor-bound authorization to
    // perform exactly ONE credential-changing admin action. The operator, already
    // holding a valid session, proves fresh presence (passkey assertion primary;
    // password+TOTP fallback) at a step-up endpoint; that mint stores a salted-
    // hashed token here bound to THAT session id. The gated credential-change
    // request presents the plaintext in a header; the route consumes the grant
    // atomically (delete-returning), verifies the hash in constant time + expiry,
    // then performs the change. Absent/expired/consumed/wrong/foreign-session
    // grant → one uniform 403, no oracle.
    //
    // Load-bearing properties:
    //  - PRIMARY KEY (session_id) → at most one active grant per session; minting
    //    upserts (a new step-up replaces any unconsumed prior grant, never
    //    accumulates).
    //  - REFERENCES sessions(id) ON DELETE CASCADE → the grant dies instantly on
    //    ANY revocation, including the post-change revokeAllSessions (S4) and every
    //    recovery event; a grant can never outlive the session that earned it and
    //    never survives session rotation (a rotated session is a new id).
    //  - token_hash is `<saltHex>:<hashHex>` (salted SHA-256, the reenroll.ts F1
    //    shape); the plaintext is surfaced exactly once in the mint response and
    //    never persisted or logged.
    //
    // Migration numbering: 0013 is the parallel throttle-persistence build (A2,
    // above); this design's table is 0014.
    id: "0014_stepup_grants",
    statements: [
      `CREATE TABLE IF NOT EXISTS stepup_grants (
        session_id TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        factor     TEXT NOT NULL CHECK (factor IN ('passkey', 'password+totp')),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    ],
  },

  {
    // ── Durable auth audit trail (Security Center Slice 2 — §5 of the design) ─
    // Finding #4 of the security review: every security-relevant auth event
    // (login, passkey enroll, recovery lane use, lockout, session revocation,
    // credential change, step-up) is emitted as a structured, redacted console
    // line by recordAuthEvent (lib/auth/audit.ts) — but with ZERO durable
    // retention. After a real incident the sole operator has no queryable
    // history. This table is that history: the SAME post-redaction record the
    // console line carries is dual-written here, so the two sinks can never
    // disagree about content, and the console line remains the out-of-DB tamper
    // anchor (an attacker with DB write access cannot reach docker logs).
    //
    // Insert-only by contract: the ONLY statements that ever touch this table are
    // the INSERT (lib/auth/audit-store.ts persistAuditEvent) and the retention
    // sweep's two constant-predicate DELETEs (age > AUDIT_RETENTION_DAYS, and the
    // oldest-first count cap beyond AUDIT_MAX_ROWS). No UPDATE exists; no API
    // parameter reaches the sweep predicates; the read side (a later slice) is
    // SELECT-only. `event` is TEXT (not CHECK-enumerated): the AuthAuditEvent
    // union is the code-side contract and a CHECK would make every future event
    // a migration for zero integrity gain on an insert-only, single-writer table.
    //
    // Migration numbering: 0014 (stepup_grants, A1) is on main; this slice is
    // 0015. Only the audit table lands here — the sessions-metadata and
    // recovery-code-age columns from the full center design are separate slices
    // (sessions view / recovery status), each taking its own later number.
    id: "0015_auth_audit_events",
    statements: [
      `CREATE TABLE IF NOT EXISTS auth_audit_events (
        id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
        event    TEXT NOT NULL,
        outcome  TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
        ip       TEXT,
        details  JSONB
      )`,
      `CREATE INDEX IF NOT EXISTS auth_audit_events_ts_idx
        ON auth_audit_events (ts DESC)`,
    ],
  },

  {
    // ── Security Center view metadata (Slice 2 — §3.2/§3.4 of the design) ─────
    // The audit table landed in 0015; this migration adds the remaining columns
    // the Security Center READ surfaces need (sessions/devices view + recovery-
    // code age). All three are nullable — no backfill: NULL is the honest state
    // for rows created before this migration (a session issued pre-v0.4.0, or a
    // recovery-code set generated before age tracking), and the UI renders a
    // documented fallback rather than fabricating history.
    //
    //  - sessions.created_ip / user_agent: session metadata captured at issuance
    //    (createSession). created_ip is the trusted-proxy-aware clientIp (the 070
    //    lesson — never a raw client-rotatable header); user_agent is attacker-
    //    influenceable free text, stored truncated (256 chars, enforced in
    //    createSession) and rendered strictly as text. Both are a courtesy label
    //    for "was this me?" triage, NEVER a validity signal — missing metadata
    //    degrades display only. These describe the OPERATOR's own admin sessions
    //    (shown only to the authenticated operator), a different plane from the
    //    PII-free public-visitor analytics posture (0010), which is untouched.
    //  - admin_user.recovery_codes_generated_at: set to now() inside the same
    //    write that regenerates the recovery-code set, so the center can show
    //    code age. NULL for sets generated before this column existed.
    id: "0016_security_center_metadata",
    statements: [
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_ip TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT`,
      `ALTER TABLE admin_user ADD COLUMN IF NOT EXISTS recovery_codes_generated_at TIMESTAMPTZ`,
    ],
  },
];
