# osshp app — Multi-stage Docker build (Next.js App Router + Bun)
#
# Stages:
#   deps    — install production + dev dependencies
#   builder — build the Next.js standalone output
#   runner  — minimal production image
#
# The standalone output (server.js) is run with Bun in the runner stage.
# HOSTNAME=0.0.0.0 is required for Next.js standalone to bind on all interfaces.
#
# Base image digest pinned for supply-chain reproducibility (A05/A06/A08 — M2.6).
# To bump: docker pull oven/bun:1-alpine && docker inspect oven/bun:1-alpine
#          --format '{{index .RepoDigests 0}}' — update BUN_BASE below.
ARG BUN_BASE=oven/bun:1-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

# ---- deps ---------------------------------------------------------------
FROM ${BUN_BASE} AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# ---- builder ------------------------------------------------------------
FROM ${BUN_BASE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build
# Compile the break-glass CLI into a self-contained binary so it runs in the
# runner without the full node_modules (standalone strips them).
# The binary embeds all imports (@/lib/db/client, @/lib/auth, postgres, etc.).
RUN bun build --compile scripts/admin-break-glass.ts --outfile /app/admin-break-glass
# Content-export CLI (issue 001) — same self-contained-binary pattern.
RUN bun build --compile scripts/export-content.ts --outfile /app/export-content
# Content-import CLI (issue 002) — same self-contained-binary pattern.
RUN bun build --compile scripts/import-content.ts --outfile /app/import-content

# ---- runner -------------------------------------------------------------
FROM ${BUN_BASE} AS runner
WORKDIR /app
# WORKDIR creates /app as root, before any --chown COPY below runs — those
# only chown the individual files/dirs they copy IN, not the /app directory
# entry itself. Without this, the non-root `bun` user (issue 073) can read
# and execute everything under /app but cannot CREATE new entries directly
# in /app — which the export/import CLIs below need for their default
# relative output/scratch path (e.g. `./export-content` with no argument
# writes to `./export-<timestamp>` under the CWD, /app).
RUN chown bun:bun /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Required: Next.js standalone server must bind on all interfaces in Docker
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Release provenance — standard OCI labels, no runtime effect.
# VERSION mirrors app/package.json "version"; REVISION is the git commit the
# image was built from. Pass both at build time:
#   docker build --build-arg VERSION=0.1.0 --build-arg REVISION=$(git rev-parse HEAD) ...
# Verify a running/built image against HEAD with:
#   docker inspect <image> --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="osshp" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

# Copy the standalone server and its static assets. --chown to the base
# image's built-in unprivileged `bun` user (uid/gid 1000, shipped by
# oven/bun:*-alpine) so the runtime USER below can read/execute everything
# without a container-filesystem chown step (and without a rebuild-time
# `RUN chown -R`, which would otherwise duplicate every copied layer).
COPY --from=builder --chown=bun:bun /app/.next/standalone ./
COPY --from=builder --chown=bun:bun /app/.next/static ./.next/static
COPY --from=builder --chown=bun:bun /app/public ./public

# Break-glass CLI (NO-GO #5 — local exec only, no HTTP route).
# Self-contained binary compiled in the builder stage — no extra deps required.
# Run inside the container: ./admin-break-glass
#                        or: bun run admin:break-glass
COPY --from=builder --chown=bun:bun /app/admin-break-glass ./admin-break-glass

# Content-export CLI (issue 001) — headless backup, self-contained binary.
# Run inside the container: ./export-content [output-dir]
#                        or: bun run export:content -- [output-dir]
COPY --from=builder --chown=bun:bun /app/export-content ./export-content

# Content-import CLI (issue 002) — headless bulk import, self-contained binary.
# Run inside the container: ./import-content <path> [--mode=skip|overwrite|create]
#                        or: bun run import:content -- <path> [--mode=...]
COPY --from=builder --chown=bun:bun /app/import-content ./import-content

EXPOSE 3000

# Issue 073: run as the base image's built-in non-root `bun` user (uid/gid
# 1000) instead of root. The app writes nothing to its own container
# filesystem in normal HTTP-serving operation (media goes to Garage/S3, not
# local disk); the export/import CLIs above default their output/scratch
# path to the current working directory (/app, owned by `bun` via the
# --chown copies above), so they keep working non-interactively and when an
# operator passes an explicit path. Placed last so every prior instruction
# (which needs root to write into the image layers) is unaffected.
USER bun

# Run the standalone Next.js server via Bun
CMD ["bun", "server.js"]
