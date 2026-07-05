-- M2.15 review-instance seed script
-- Run inside the db container: docker exec -i osshp-db-1 psql -U osshp -d osshp < scripts/seed-m2-review.sql
--
-- WARNING: This script MODIFIES and REPLACES gate-artifact content. It is intended
-- for a fresh review instance, NOT for a production deployment with real user content.
--
-- Prerequisites:
--   - Stack is up (docker compose -f docker-compose.yml up -d)
--   - setup.sh has been run (first-run wizard already completed)
--   - 3 seed images uploaded to Garage (see m2.15-deploy-notes.md)
--     Keys: a2f3c840-1b2e-4d5f-9a6b-7c8d9e0f1a2b/800.jpg (coastal)
--           b3e4d950-2c3f-5e6a-0b7c-8d9e0f1a2b3c/800.jpg (golden)
--           c4f5e061-3d4e-6f7b-1c8d-9e0f1a2b3c4d/800.jpg (forest)

-- 1. Move the "Draft: M2 Feature Ideas" gate post back to draft
UPDATE posts SET status='draft' WHERE id='b1000000-0000-0000-0000-000000000003';

-- 2. Replace M2.12 gate photo artifacts with real review photo posts
UPDATE posts
SET
  title       = 'Fog Rolling Over the Bay',
  slug        = 'fog-rolling-over-the-bay',
  body        = 'The bay looked different this morning. The fog had settled low, muffling the usual sounds of boats and birds, leaving only a quiet grey expanse where the water should have been.',
  excerpt     = 'A still morning on the bay when the fog erased the horizon.',
  cover_image_src = '/media/a2f3c840-1b2e-4d5f-9a6b-7c8d9e0f1a2b/800.jpg',
  cover_image_alt = 'Dense morning fog over a calm bay, blue-grey tones',
  publish_date = '2026-06-28T08:00:00Z',
  updated_at  = now()
WHERE id='b457d5b2-77b9-4724-a695-b6b04c1d4686';

UPDATE posts
SET
  title       = 'Last Light: A Golden Hour Study',
  slug        = 'last-light-golden-hour',
  body        = 'There is a window — maybe twelve minutes — when the light turns gold and everything in the frame looks like it was placed there deliberately. These are notes from chasing that window.',
  excerpt     = 'Chasing the twelve-minute window when light turns everything gold.',
  status      = 'published',
  cover_image_src = '/media/b3e4d950-2c3f-5e6a-0b7c-8d9e0f1a2b3c/800.jpg',
  cover_image_alt = 'Warm orange-gold gradient light of golden hour, landscape silhouette',
  publish_date = '2026-06-27T17:30:00Z',
  updated_at  = now()
WHERE id='45c99a00-69d4-4b4b-908b-066b7c1162c4';

-- 3. Update Alpine Morning Light cover to use the forest image
UPDATE posts
SET
  cover_image_src = '/media/c4f5e061-3d4e-6f7b-1c8d-9e0f1a2b3c4d/800.jpg',
  cover_image_alt = 'Misty morning light filtering through a green forest canopy',
  updated_at  = now()
WHERE id='a449875e-9627-44b5-a26d-b4cb72529a8d';

-- 4. Media records for the 3 new Garage objects
INSERT INTO media (id, storage_key, alt, mime_type, width, height, exif_stripped)
VALUES
  (gen_random_uuid(), 'a2f3c840-1b2e-4d5f-9a6b-7c8d9e0f1a2b/800.jpg',
   'Dense morning fog over a calm bay, blue-grey tones', 'image/jpeg', 800, 600, true),
  (gen_random_uuid(), 'b3e4d950-2c3f-5e6a-0b7c-8d9e0f1a2b3c/800.jpg',
   'Warm orange-gold gradient light of golden hour, landscape silhouette', 'image/jpeg', 800, 600, true),
  (gen_random_uuid(), 'c4f5e061-3d4e-6f7b-1c8d-9e0f1a2b3c4d/800.jpg',
   'Misty morning light filtering through a green forest canopy', 'image/jpeg', 800, 600, true)
ON CONFLICT (storage_key) DO NOTHING;

-- 5. New blog posts
INSERT INTO posts (id, title, slug, body, excerpt, type, status, publish_date, created_at)
VALUES (
  'c2000000-0000-0000-0000-000000000001',
  'Running Your Site from a Single Docker Compose File',
  'running-site-from-docker-compose',
  'Most "self-hosting guides" start with five services, a load balancer, and a secrets manager. This one starts with a single file.

A personal site has modest traffic. What it needs is reliability, not scale. A single Docker Compose stack on a $5 VPS handles that easily — and the whole thing fits in a file you can read in ten minutes.

## The Stack

```yaml
services:
  app:
    image: your-cms:latest
    restart: unless-stopped
    environment:
      DATABASE_URL: ${DATABASE_URL}
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:17-alpine
    restart: unless-stopped
    volumes:
      - db-data:/var/lib/postgresql/data

  proxy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data

volumes:
  db-data:
  caddy-data:
```

That is the entire production infrastructure for a personal site. Postgres for data. Caddy for automatic HTTPS. App for your content.

## Why Caddy Instead of Nginx

Nginx is an excellent proxy, but HTTPS configuration requires a certificate manager, renewal cron, and a fair amount of config. Caddy automates all of it: point a domain at the server, write a two-line Caddyfile, and it handles Let''s Encrypt provisioning and renewal with no extra services.

## Moving Later

The stack is portable: `docker compose up -d` on a new host, restore a Postgres backup, and the site is back. No vendor lock-in, no migration tool, no managed service that can delete your data.',
  'How to run a personal site from a single Docker Compose file — Postgres, Caddy, and your app, that is it.',
  'article',
  'published',
  '2026-06-26T09:00:00Z',
  now()
),
(
  'c2000000-0000-0000-0000-000000000002',
  'Working in the Open',
  'working-in-the-open',
  'Building something in the open means accepting that the thing is visibly imperfect for most of its existence. That is uncomfortable. It is also, I think, the better way.

Closed projects have a final reveal: a polished product appears, fully formed. The narrative is clean. But clean narratives are retroactive fictions. The real process is iterative, messy, and full of dead ends that you do not show anyone.

Working in the open collapses the gap between process and product. The work-in-progress is the artifact. The git history is the story. The commit messages are the author''s notes.

There is accountability in this that closed work lacks. You cannot quietly abandon a feature you announced. You cannot quietly ship something broken without it being visible. The constraint is uncomfortable; the constraint is also why the work tends to be better.

This site is built in the open. The code is on GitHub. The design decisions are documented. The mistakes are committed, not erased.',
  'Why building something visibly imperfect in public is better than the clean narrative of a private project.',
  'article',
  'published',
  '2026-06-24T10:00:00Z',
  now()
)
ON CONFLICT (id) DO NOTHING;

-- 6. Tags
INSERT INTO tags (id, name, slug) VALUES
  ('a2000000-0000-0000-0000-000000000001', 'Docker', 'docker'),
  ('a2000000-0000-0000-0000-000000000002', 'Self-hosting', 'self-hosting'),
  ('a2000000-0000-0000-0000-000000000003', 'Open source', 'open-source')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO post_tags (post_id, tag_id) VALUES
  ('c2000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001'),
  ('c2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003'),
  ('c2000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000002'),
  ('c2000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000003'),
  ('b1000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000002')
ON CONFLICT DO NOTHING;

-- 7. Update site settings
UPDATE settings SET value = '"osshp — Demo Instance"' WHERE key = 'site.title';
UPDATE settings SET value = '"A live demo of osshp, a self-hostable personal site platform. Blog, photos, and portfolio in one Docker Compose stack."' WHERE key = 'site.description';
UPDATE settings SET value = '"#1a6bbf"' WHERE key = 'branding.accent';
