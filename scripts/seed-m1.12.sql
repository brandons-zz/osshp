-- M1.12 deploy seed — representative published content for the M1.G owner review.
--
-- Run against a fresh or reset DB:
--   cat osshp/scripts/seed-m1.12.sql | docker exec -i osshp-db-1 psql -U osshp -d osshp
--
-- This script is IDEMPOTENT if you clear the data first (DELETE / TRUNCATE).
-- It does NOT create an admin_user — the bootstrap window stays open so the
-- owner can run /setup to create an admin and explore authoring.
--
-- What it seeds:
--   tags:      Technical, Opinion, Tutorial
--   posts:     2 published (long technical with code block, short opinion)
--              + 1 draft (must remain invisible publicly)
--   pages:     About (published) — public page route is M2 work
--   settings:  site.title, site.description, site.setupComplete=false
--              site.activeTheme=editorial is already in the DB from seedCoreSettings

-- 1. Reset gate/prior state
DELETE FROM sessions;
DELETE FROM auth_challenges;
DELETE FROM admin_user;
DELETE FROM post_tags;
DELETE FROM posts;
DELETE FROM tags;
DELETE FROM pages;

UPDATE settings SET value = 'false'::jsonb WHERE key = 'site.setupComplete';
UPDATE settings SET value = '"The osshp Blog"'::jsonb WHERE key = 'site.title';
UPDATE settings SET value = '"Exploring modern web publishing and the open web."'::jsonb WHERE key = 'site.description';

-- 2. Tags
INSERT INTO tags (id, name, slug) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'Technical', 'technical'),
  ('a1000000-0000-0000-0000-000000000002', 'Opinion',   'opinion'),
  ('a1000000-0000-0000-0000-000000000003', 'Tutorial',  'tutorial');

-- 3. Posts

-- Post 1: Long technical post with code block (published)
INSERT INTO posts (id, title, slug, body, excerpt, type, status, publish_date, created_at, updated_at)
VALUES (
  'b1000000-0000-0000-0000-000000000001',
  'How osshp Handles Content Rendering',
  'how-osshp-handles-content-rendering',
  '# How osshp Handles Content Rendering' || E'\n\n' ||
  'osshp separates the concerns of content storage, theming, and delivery into distinct layers. This post walks through how a published post travels from the database to the browser.' || E'\n\n' ||
  '## The Rendering Pipeline' || E'\n\n' ||
  'When a visitor requests `/blog/some-slug`, the platform follows these steps:' || E'\n\n' ||
  '1. **Route handler** checks that the Blog module is enabled.' || E'\n' ||
  '2. **Content layer** fetches only published posts — drafts are never materialised.' || E'\n' ||
  '3. **Theme context builder** assembles a public-only render context.' || E'\n' ||
  '4. **Active theme** receives the context and returns a React element tree.' || E'\n' ||
  '5. **`renderToStaticMarkup`** converts the tree to an HTML string, served as `text/html`.' || E'\n\n' ||
  '## The Published-Only Boundary' || E'\n\n' ||
  'The platform enforces a hard boundary at the content layer:' || E'\n\n' ||
  '```typescript' || E'\n' ||
  '// Only published posts are ever returned to the theme.' || E'\n' ||
  'export async function listPublishedPosts(db: Db) {' || E'\n' ||
  '  return db.query(' || E'\n' ||
  '    `SELECT * FROM posts' || E'\n' ||
  '     WHERE status = ''published''' || E'\n' ||
  '       AND publish_date <= now()' || E'\n' ||
  '     ORDER BY publish_date DESC`' || E'\n' ||
  '  );' || E'\n' ||
  '}' || E'\n' ||
  '```' || E'\n\n' ||
  'This means a draft post with a known slug returns a 404.' || E'\n\n' ||
  '## Settings and Theming' || E'\n\n' ||
  'The active theme is resolved from the `site.activeTheme` admin setting at request time. The platform falls back to the first registered theme if the setting is missing, so the site always renders.' || E'\n\n' ||
  'Public settings (title, description, accent colour) are injected into the render context. Admin settings and secrets never reach a theme — the context type itself has no field for them.' || E'\n\n' ||
  '## Markdown Sanitisation' || E'\n\n' ||
  'Post bodies are stored as Markdown and rendered through a sanitisation pipeline before the theme receives them. The theme sees `SanitizedHtml`, not raw input, so a malicious post body cannot inject scripts into the page.' || E'\n\n' ||
  '## What Is Next' || E'\n\n' ||
  'The M2 milestone adds media uploads backed by Garage S3-compatible object storage, a richer admin editing experience, and a tag-filtered post list. The rendering pipeline stays unchanged — new features extend the context, not bypass it.',
  'A walkthrough of how osshp routes a published post from the database to the browser, covering the content boundary, theme context, and sanitisation pipeline.',
  'article',
  'published',
  '2026-06-25 10:00:00+00',
  '2026-06-25 10:00:00+00',
  '2026-06-25 10:00:00+00'
);

-- Post 2: Short opinion post (published)
INSERT INTO posts (id, title, slug, body, excerpt, type, status, publish_date, created_at, updated_at)
VALUES (
  'b1000000-0000-0000-0000-000000000002',
  'Own Your Words',
  'own-your-words',
  '# Own Your Words' || E'\n\n' ||
  'Every post you publish on a third-party platform is a loan, not an asset. The platform can close your account, change its algorithm, or vanish entirely — and your writing goes with it.' || E'\n\n' ||
  'Running your own site is not nostalgia. It is a practical hedge against the volatility of platforms you do not control. You choose the domain. You choose the format. You choose who can read it and when.' || E'\n\n' ||
  'The web was built for this. A URL you own, pointing at content you control, is one of the most durable publishing primitives we have. Platforms come and go. Well-maintained personal sites from the early 2000s are still online.' || E'\n\n' ||
  'Your words deserve a home you own.',
  'A case for self-hosted publishing and why owning your writing matters more than ever.',
  'article',
  'published',
  '2026-06-28 09:00:00+00',
  '2026-06-28 09:00:00+00',
  '2026-06-28 09:00:00+00'
);

-- Post 3: Draft (must NOT appear publicly — 404 on any public route)
INSERT INTO posts (id, title, slug, body, excerpt, type, status, created_at, updated_at)
VALUES (
  'b1000000-0000-0000-0000-000000000003',
  'Draft: M2 Feature Ideas',
  'draft-m2-feature-ideas',
  '# Draft: M2 Feature Ideas' || E'\n\n' ||
  'This is a draft post and should never appear on the public site.' || E'\n\n' ||
  '- Media upload UI' || E'\n' ||
  '- Tag filter page' || E'\n' ||
  '- RSS feed' || E'\n' ||
  '- Scheduled publishing',
  'Draft — not for public consumption.',
  'article',
  'draft',
  '2026-06-29 08:00:00+00',
  '2026-06-29 08:00:00+00'
);

-- 4. Post-tag joins
INSERT INTO post_tags (post_id, tag_id) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003'),
  ('b1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000002');

-- 5. About page (published; public /about route is M2 work — data is seeded now)
INSERT INTO pages (id, title, slug, body, status, created_at, updated_at)
VALUES (
  'c1000000-0000-0000-0000-000000000001',
  'About',
  'about',
  '# About' || E'\n\n' ||
  'This site runs on osshp — a self-hosted static site platform built with Next.js, Bun, PostgreSQL, and Garage S3-compatible object storage.' || E'\n\n' ||
  'The platform is designed to be operator-owned from the ground up: your content lives in a database you control, your media in storage you control, and your domain points wherever you choose.' || E'\n\n' ||
  '## Why osshp?' || E'\n\n' ||
  'Most publishing tools trade ownership for convenience. osshp makes ownership the default:' || E'\n\n' ||
  '- No third-party accounts required' || E'\n' ||
  '- Single Docker Compose stack — runs on a laptop or a $5 VPS' || E'\n' ||
  '- WebAuthn passkey authentication (no passwords)' || E'\n' ||
  '- Editorial Clarity theme included — AA-contrast, keyboard-navigable, mobile-friendly' || E'\n\n' ||
  '## Get in Touch' || E'\n\n' ||
  'This instance is for review and exploration. Use the `/setup` wizard to create an admin account and try authoring.',
  'published',
  '2026-06-29 10:00:00+00',
  '2026-06-29 10:00:00+00'
);
