# osshp — Dependency Update Cadence

**Audience:** operators, contributors (team-internal)
**Established:** M2.6 (2026-06-29) — supply-chain hardening (OWASP A05/A06/A08)

---

## Why this document exists

All service and base images are pinned by `@sha256` digest in `osshp/docker-compose.yml`
and `osshp/app/Dockerfile`. Pinned digests make the fleet reproducible and prevent silent
tag-drift (the supply-chain gap OWASP A05/A06/A08 surfaces). Pinning does not mean
never updating — it means updating **deliberately**, not silently.

The pre-push gate runs `bun audit` and fails on any advisory. This forces dependency
updates to be explicit and gated before reaching the fleet.

---

## Scheduled cadence (minimum)

| Trigger | What to review |
|---|---|
| **Monthly** | `bun audit` output in the gate run log; npm advisory feed for any package in `bun.lock` |
| **On upstream release** | Any new minor/patch release of postgres, caddy, bun, or garage |
| **On CVE announcement** | Immediately for any CVSS ≥7.0 affecting a pinned component |
| **Before any M-milestone release** | Full audit pass (run the pre-push gate manually: `bash osshp/scripts/pre-push`) |

---

## Bumping a pinned image digest (docker-compose.yml / Dockerfile)

```bash
# 1. Pull the updated tag from the registry
docker pull postgres:17-alpine          # or caddy:2-alpine, dxflrs/garage:<newtag>, oven/bun:1-alpine

# 2. Get the new digest
docker inspect postgres:17-alpine --format '{{index .RepoDigests 0}}'
# → postgres@sha256:<newhash>

# 3. Update osshp/docker-compose.yml (or osshp/app/Dockerfile for oven/bun)
#    Replace the old sha256 hash with the new one. Keep the human-readable tag.

# 4. Verify the stack boots with the updated digest
cd osshp
docker compose build   # if app/Dockerfile changed
docker compose up -d
docker compose ps      # all services healthy?
docker compose logs --tail=20

# 5. Tear down the test stack
docker compose down

# 6. Run the full pre-push gate to confirm no regressions
bash osshp/scripts/pre-push

# 7. Commit the updated docker-compose.yml and/or Dockerfile
git add osshp/docker-compose.yml osshp/app/Dockerfile
git commit -m "chore(osshp): bump <image> digest to <newhash>"
```

---

## Updating npm dependencies (bun audit / bun.lock)

When `bun audit` finds an advisory in the pre-push gate:

```bash
cd osshp/app

# 1. Identify the vulnerable package and the fix
bun audit

# 2a. Direct dependency — update it
bun update <package-name>

# 2b. Transitive dependency (e.g. postcss via next.js) — update the root package
#     that pulls it in; check the advisory for the minimum-fixed root version
bun update next           # or whichever root package carries the vulnerable dep

# 3. Re-run the audit to confirm the advisory is gone
bun audit

# 4. Run the full gate
bash osshp/scripts/pre-push

# 5. Commit the updated bun.lock (and package.json if the version range changed)
git add osshp/app/bun.lock osshp/app/package.json
git commit -m "chore(osshp): update <package> to resolve <advisory>"
```

---

## Current known state (M2.6 baseline)

| Image / Package | Pinned reference | Pinned at |
|---|---|---|
| `postgres:17-alpine` | `postgres@sha256:dc17045c…` | 2026-06-29 |
| `caddy:2-alpine` | `caddy@sha256:5f5c8640…` | 2026-06-29 |
| `dxflrs/garage:v2.3.0` | `dxflrs/garage@sha256:866bd13e…` | 2026-06-29 |
| `oven/bun:1-alpine` | `oven/bun@sha256:5acc90a9…` | 2026-06-29 |

**Active advisory at M2.6 baseline:**
- `postcss <8.5.10` (moderate) via `next › postcss` — XSS via unescaped `</style>` in CSS
  stringify output. Resolution: update `next` to a version that pulls in `postcss ≥8.5.10`.
  The pre-push gate will block pushes until this is resolved. Track with M2.8 when
  next.js is updated for the TipTap integration.

---

## Notes

- **Do not skip the gate** (`--no-verify`). The CVE scan exists to protect the fleet.
- **Transitive deps count.** A vulnerable transitive dep in one operator's build is a
  fleet-wide exposure for a distributed AGPL self-host.
- **The gate pairs with the M2.8 TipTap-cloud CI guard** on the same pre-push surface.
  Both guards must PASS before any push.
- Update this document's "Current known state" table whenever digests or bun.lock are bumped.
