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
];
