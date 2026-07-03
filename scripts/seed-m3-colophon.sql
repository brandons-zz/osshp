-- M3 Colophon review-instance seed script (additive on top of M2.15 seed)
-- Run inside the db container: docker exec -i osshp-db-1 psql -U osshp -d osshp < scripts/seed-m3-colophon.sql
--
-- Adds a pull-quote article to the existing M2.15 content set.
-- M2.15 content (photo posts + code block articles + essays + About page) must already be present.

-- Pull-quote blog article
INSERT INTO posts (id, title, slug, body, excerpt, type, status, publish_date, created_at)
VALUES (
  'd3000000-0000-0000-0000-000000000001',
  'Writing for an Audience of One',
  'writing-for-an-audience-of-one',
  'The standard advice for writers is: know your audience. Know who you are writing for, what they want to hear, how much they already know.

That advice is good for marketing copy. It is bad for writing worth reading.

> The best writing is addressed to a single imagined reader who represents, for the writer, the ideal reader — someone who is intelligent, well-informed, and genuinely curious. Everyone else who reads it is, in a sense, eavesdropping.

Writing for a mass audience produces writing by committee: flattened to the lowest common denominator, hedged against every possible misreading, stripped of anything that might alienate the statistically average reader. The result is technically readable and completely forgettable.

The alternative is to write for the one person who would most benefit from what you have to say. Not a demographic. Not an abstraction. A specific, imagined reader who would recognize your concern as their own.

## Why This Works

When you write for a mass audience, you are guessing at what people want. When you write for a single reader, you know exactly what matters, because you can ask: does this serve that person? Would they find this clear? Does this earn their time?

The paradox is that this narrowness produces broader appeal. Writing shaped for one reader''s genuine interests is sharper, more personal, and more useful than writing shaped for everyone''s average interests.

This is the argument for publishing a personal site rather than writing for platforms with algorithmic distribution. The platform wants scale. Scale wants blandness. A personal site lets you write for the one reader who would care.',
  'Why writing for a single imagined reader produces sharper, more resonant work than writing for a mass audience.',
  'article',
  'published',
  '2026-06-29T10:00:00Z',
  now()
)
ON CONFLICT (id) DO NOTHING;

-- Tag association for the pull-quote post
INSERT INTO post_tags (post_id, tag_id)
SELECT 'd3000000-0000-0000-0000-000000000001', id FROM tags WHERE slug = 'self-hosting'
ON CONFLICT DO NOTHING;

-- Reset to clean pre-admin state (no admin, setupComplete=false)
BEGIN;
DELETE FROM admin_user;
DELETE FROM auth_challenges;
DELETE FROM sessions;
UPDATE settings SET value = 'false'::jsonb WHERE key = 'site.setupComplete';
UPDATE settings SET value = '"osshp — Demo Instance"'::jsonb WHERE key = 'site.title';
COMMIT;

-- Verify
SELECT 'DB state after M3 seed:' AS status;
SELECT key, value FROM settings WHERE key IN ('site.setupComplete', 'site.enabledModules', 'site.title');
SELECT COUNT(*) as published_posts FROM posts WHERE status='published';
SELECT COUNT(*) as admin_users FROM admin_user;
