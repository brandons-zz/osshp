# Contributing to osshp

Thanks for looking at this. osshp is AGPL-3.0; contributions are welcome and
are accepted under that same license.

## Development setup

The verified, day-to-day workflow is the full Docker Compose stack — every
build/security gate in this project's history was exercised against the
production standalone artifact (`bun server.js` inside the `app` container),
not the Next.js dev server, so that's the environment most likely to match
what you'll actually ship:

```sh
git clone <this-repo> osshp && cd osshp
./scripts/setup.sh                     # creates .env + config/garage.toml
# fill in the CHANGE_ME values — see docs/setup-runbook.md, including the
# one-time Garage provisioning step
docker compose up -d
```

Iterate by rebuilding the `app` service after each change:

```sh
docker compose up -d --build app
docker compose logs -f app
```

This is slower per-iteration than a hot-reloading dev server, but it's the
one path every documented gate in this repo has actually exercised.
`app/package.json` also has a `bun run dev` script (`next dev`) for local
iteration on code that doesn't need a live database/storage connection —
`db` and `storage` are **not** exposed to the host by `docker-compose.yml`
(only `proxy` publishes ports), so pointing `next dev` at them requires your
own temporary port-mapping override; there's no established/verified
workflow for that in this project yet, so treat it as an unsupported
shortcut rather than the documented path.

```sh
cd app
bun install
bun test        # doesn't need either container — see "Running the test suite" below
```

## Running the test suite

```sh
cd app
bun test
```

Tests run against an in-process PostgreSQL (`@electric-sql/pglite`, WASM) —
no external database needed for the test suite itself.

## Before you push: the pre-push gate

Install it once per clone:

```sh
bash scripts/setup-hooks.sh
```

This wires a `pre-push` git hook that runs, **locally, on every push**
(never GitHub CI — there's no per-commit CI cost model to fight here):

1. `bun run build` — the Next.js production build must succeed.
2. `bun test` — the full test suite must pass.
3. `bun audit` — every dependency in `bun.lock` is scanned against the npm
   advisory database; **any** advisory (moderate or above) fails the gate.
4. A TipTap Cloud/Pro exclusion check (`scripts/check-tiptap-cloud.sh`) —
   fails the push if any proprietary TipTap Cloud/Pro-tier package is ever
   imported or declared. Only the open-source MIT TipTap packages are
   AGPL-compatible; this guard exists specifically to keep it that way.

Don't skip the gate with `--no-verify` — fix the underlying issue instead.
If `bun audit` blocks you on a transitive dependency you don't control
directly, see `docs/dependency-update-cadence.md` for the update workflow
(update the root package that pulls in the vulnerable transitive dep, not
just the leaf).

## Where things live

- `app/src/lib/theme/` + `app/src/themes/` — the theme engine and shipped
  themes. Building a new theme: `docs/theme-author-guide.md`.
- `app/src/lib/module/` + `app/src/modules/` — the module system and shipped
  modules (Blog, Pages, Photos). What each module does, operator-facing:
  `docs/modules.md`.
- `app/src/lib/auth/` — passkey/session/recovery auth core.
- `app/src/lib/export/`, `app/src/lib/import/` — the content portability
  pair; format frozen by `docs/decisions/0003-content-export-format.md` and
  `docs/decisions/0004-content-import.md`.
- `app/scripts/` — headless CLI entry points (`export-content.ts`,
  `import-content.ts`, `admin-break-glass.ts`), each built as a standalone
  binary via `bun build --compile` and run inside the container
  (`docker compose exec app ./<script-name>`).
- `docs/decisions/` — Architecture Decision Records for choices that are
  expensive to reverse (a format, a library selection, a security posture).
  If you're proposing a change to one of the frozen contracts those cover
  (the export/import archive format, the auth core's session model, the
  chosen UI primitive), open the discussion as an ADR update in the same
  change, not a silent behavior change.

## Contracts you're building against

Two rules govern the app's internal seams and are binding on any new theme
or module, not just advisory:

- **Theme contract:** a theme may set color and material values only — it
  must never touch structural tokens, and must respect the
  public-content-only / sanitized-output security boundary. Documented in
  full, with worked examples, in `docs/theme-author-guide.md`.
- **Module contract:** the five capabilities a module may register (routes,
  admin nav, content types, settings, theme hooks), the
  default-deny-on-unspecified-access rule, and the disable-never-destroys-
  data lifecycle guarantee. Documented in full, with worked examples, in
  `docs/modules.md`.

Read the relevant one before adding a new theme or module — both documents
explain *why* each rule exists, not just what it is, and the shipped
Editorial/Skeleton themes and Blog/Pages/Photos modules are all worked
examples of following them.

## Accessibility

WCAG 2.1 AA is a build requirement for the core, both shipped reference
themes, and every owned UI component — not a nice-to-have pass at the end.
If you're touching anything visual: verify contrast ratios (≥4.5:1 body
text, ≥3:1 large text/non-text boundaries), that every interactive element
remains keyboard-operable with a visible focus ring, and that the page
reflows cleanly at 320px with no horizontal scroll and no clipped content.
`docs/theme-author-guide.md`'s accessibility section has the specifics for
theme work.

## Reporting a security issue

If you find something you believe is a genuine security vulnerability (not
a general bug), please report it privately to the maintainer rather than
opening a public issue, so a fix can land before the details are public.
This repository doesn't yet have a dedicated security-contact channel set
up (there's no public remote to publish one against yet); once the project
is published this section will point at a real reporting address.
