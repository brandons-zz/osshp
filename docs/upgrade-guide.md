# osshp — Upgrade Guide

**Audience:** operators updating an already-running osshp instance to a newer
version of the codebase.

This covers **feature/version upgrades** (new source code, rebuild the image).
For routine dependency and base-image maintenance on a version you're already
running (CVE patches, digest bumps) see `docs/dependency-update-cadence.md` —
that document's cadence table and procedures still apply during an upgrade,
they're just triggered by a different reason.

---

## Before you upgrade: take a backup

Upgrades touch the running database schema and (occasionally) the media
pipeline. Take a backup first — it's the same command either way:

```sh
cd osshp/
BACKUP_PASSPHRASE='your-passphrase' ./scripts/backup.sh
```

See `docs/backup-restore.md` for the full mechanics and what's inside the
archive. If an upgrade goes wrong, restoring that backup returns you to
exactly where you started.

## How an upgrade works

osshp has no separate migration-runner step to remember — **schema
migrations run automatically, every time the app boots**
(`initializeDatabase()` → `migrate()` in `app/src/lib/db/client.ts`). Every
migration is written idempotently (`CREATE TABLE IF NOT EXISTS`, `ALTER
TABLE ... ADD COLUMN IF NOT EXISTS`), so booting the new version against your
existing database applies whatever schema changes shipped since your last
deploy, in order, with no manual `migrate` command and no risk of re-running
an already-applied migration. There is currently no down-migration/rollback
mechanism — the safety net for a bad upgrade is the backup you just took.

An upgrade is therefore just: **get the new source on the host, rebuild the
`app` image, restart it.** Postgres and Garage (`db`/`storage` containers)
are not rebuilt or touched by a normal upgrade.

## Upgrade steps

```sh
cd osshp/

# 1. Get the new source (however you distribute it — git pull, a release
#    tarball, etc.)
git pull origin main          # or: checkout the release tag/commit you want

# 2. Rebuild the app image from the new source and restart just that service
docker compose up -d --build app

# 3. Confirm it came up healthy on the new code
docker compose ps             # app should report Up (healthy) within ~15-30s
docker compose logs --tail=30 app
```

`db`, `storage`, and `proxy` are unaffected — `docker compose up -d --build
app` only rebuilds and recreates the `app` service; the other three keep
running throughout.

### What "downtime" this causes

The `app` container serves **both** the public site and the admin console —
rebuilding and recreating it means a brief interruption (typically single-
digit seconds) for all osshp traffic while the new container starts and
passes its healthcheck. `db` and `storage` stay up the entire time, so no
data is at risk during the gap — visitors just see a moment of connection
refused/retry from Caddy before the new `app` container is healthy. There is
no zero-downtime/rolling-upgrade path for a single-instance self-host today;
schedule upgrades for low-traffic windows if a few seconds of interruption
matters to you (the same guidance `docs/backup-restore.md` gives for the
backup window).

### Confirming the deployed version matches what you expect

```sh
docker compose images app     # shows the image ID currently running
git rev-parse HEAD             # the commit you built from
```

osshp does not yet have an in-app "About / version" page — the release
version and what shipped in it live in `CHANGELOG.md` at the repo root,
alongside the git commit you built the image from. `app/package.json`
carries the current version string (`0.1.0` as of the first tagged
release). Keep a note of which commit you deployed if you need an audit
trail beyond the CHANGELOG entry.

## If something goes wrong after an upgrade

1. Check `docker compose logs app` for the actual error first — most
   upgrade-time failures are a missing new `.env` variable a feature added
   (compare your `.env` against the current `.env.example` for anything new)
   or a genuine app bug.
2. If the app won't come up healthy and the fix isn't obvious, roll back the
   **source** and rebuild:
   ```sh
   git checkout <previous-commit-or-tag>
   docker compose up -d --build app
   ```
   Because migrations are additive/idempotent, rolling back the app code
   while the database has already picked up a newer schema is usually safe
   for a same-day rollback — the older code simply won't use the new
   columns/tables. It is **not** guaranteed safe across a schema change that
   altered or removed something the old code depends on; if you're not sure,
   or the rollback itself misbehaves, restore the backup you took before the
   upgrade instead:
   ```sh
   BACKUP_PASSPHRASE='your-passphrase' ./scripts/restore.sh backups/osshp-backup-<pre-upgrade-timestamp>.tar.age
   ```
   `restore.sh` also restores `.env`/`config/garage.toml`, so this returns
   the whole instance — code you then also need to check out at the matching
   commit, database, media, and config — to its pre-upgrade state.

## Dependency and base-image updates (a related but separate concern)

Bumping `postgres`/`caddy`/`garage`/`bun` base-image digests, or updating an
npm dependency to clear a `bun audit` advisory, is **not** a feature upgrade
of osshp itself — it's routine maintenance on the version you're already
running. That has its own cadence, triggers, and step-by-step procedure,
fully covered in `docs/dependency-update-cadence.md`. Do both together when
convenient (e.g. right before a release), but they're independent concerns:
you can update dependencies without changing osshp's feature code, and vice
versa.
