# osshp — Backup and Restore

Full-site backup and restore for a self-hosted osshp instance. This is the
operational safety net for the whole running stack (database + media +
config/secrets) — separate from the Markdown content export/import feature
(`docs/content-export-import.md`), which moves individual posts/pages in and
out as portable Markdown.

## What a backup contains

Running `scripts/backup.sh` produces **one file**:

- `backups/osshp-backup-<UTC-timestamp>.tar.age` — the encrypted archive.
  There is no separate integrity sidecar to keep track of — see
  "Integrity" below for why.

Inside the archive (encrypted, see below):

| Item | Source | How |
|---|---|---|
| Database content | Postgres (`osshp` DB — posts, pages, tags, settings, admin account, sessions) | `pg_dump` custom format, taken live, no downtime |
| Media | Garage object storage (`garage-data` + `garage-meta` Docker volumes) | Volume-level snapshot — captures uploaded files **and** Garage's own bucket/key/cluster-layout state, so restore needs no manual Garage re-provisioning |
| Operator secrets/config | `.env` and `config/garage.toml` | Copied verbatim |
| Manifest | Generated | Timestamp, source commit, app image ID, DB name, S3 bucket name |

A restore from this archive reconstitutes a **complete working instance** —
same content, same media, same admin account and passkeys, same secrets —
on the same host or a fresh one.

## Secrets are in scope, and that's deliberate

The archive contains every secret this instance holds: `SESSION_SECRET`,
`OSSHP_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, the S3 access/secret key pair,
and the Garage RPC secret.

This is required, not incidental: `OSSHP_ENCRYPTION_KEY` is the AES-256-GCM
key that decrypts TOTP secrets already sitting inside the Postgres dump. A
backup that excluded it would restore a database with permanently
undecryptable TOTP secrets — a broken instance, not a working one. The
admin's passkey credentials and recovery codes are similarly restored
byte-for-byte, so the same admin can log back in after a restore with no
re-enrollment needed.

**Because of this, the backup archive is at least as sensitive as `.env`
itself** — anyone who obtains it and the passphrase can fully impersonate
this instance's admin. Treat it accordingly:

- The archive is encrypted with **[age](https://age-encryption.org)** in
  passphrase mode, using a passphrase you supply (`BACKUP_PASSPHRASE` env
  var, or an interactive prompt). The staged content is **streamed
  directly into `age`** — `tar` and `age` are connected by a pipe, so a
  plaintext copy of the archive is never written to disk, on success or
  on failure (disk-full, a killed process, an `age` error — none of them
  can leave a readable plaintext archive behind, because one was never
  created). `backup.sh` also sets a strict `umask 077` for its whole run,
  so the short-lived staged files it does write to disk while assembling
  the archive (`db.dump`, `env.backup`, etc., cleaned up immediately
  after) are owner-only (`600`) the moment they're created, not after the
  fact.
- The output file is `chmod 600` on write.
- **Store the passphrase separately from the archive** — a password
  manager, not a note next to the backup file, not committed anywhere.
  Losing the passphrase makes the archive permanently unrecoverable
  (by design — there is no backdoor).
- `backups/` is gitignored. Never commit a backup archive.
- If you copy the archive off-host (recommended — a backup that lives only
  on the machine it protects isn't a backup), `age`'s authenticated
  encryption is what makes that safe to do over an untrusted channel or
  storage provider — see "Integrity" below. There's no sidecar file to
  remember to copy alongside it; the single `.tar.age` file is
  self-contained.

### Integrity: age's authenticated encryption, verified before extraction

`age` in passphrase mode is an AEAD construction (a scrypt-derived key over
ChaCha20-Poly1305, via age's STREAM chunking) — integrity is intrinsic to
the ciphertext itself. There is no separate HMAC sidecar to compute, ship,
or verify (an earlier version of this tooling used AES-256-CBC + a
companion `.hmac` file for exactly this reason; `age` makes that whole
mechanism unnecessary).

`restore.sh` makes two passes over the archive before touching anything:

1. **Verify pass** — decrypts the entire archive to `/dev/null`. This
   proves every chunk in the file authenticates against the supplied
   passphrase, without extracting a single file. (`age`'s streaming
   construction authenticates chunk-by-chunk as it decrypts; a
   decrypt-and-extract-in-one-pass approach could, for a tamper located
   late in a large archive, have already written some early — genuinely
   valid — files to disk before hitting the bad chunk. The verify pass
   exists specifically to rule that out: nothing is extracted until the
   *whole* archive has authenticated.)
2. **Extract pass** — only runs if the verify pass succeeded; decrypts and
   extracts for real.

A wrong passphrase or any tampered/corrupted byte anywhere in the archive
fails the verify pass, and `restore.sh` aborts right there — before any
file is extracted, before the manifest is shown, before the confirmation
prompt, and long before any destructive restore step. This holds in
scripted disaster-recovery runs too (`--yes`).

`restore.sh` also stopped `source`-ing the restored `.env`: it reads it
with a plain `KEY=VALUE` line parser that performs no shell expansion,
command substitution, or code execution of any kind, as defense in depth
independent of the integrity check above.

### Delivery channel: how the passphrase reaches `age` without ever touching argv

`age -p` (passphrase mode) is deliberately interactive-only in the
reference CLI — no flag, environment variable, or stdin/fd convention
exists to feed it a passphrase; the maintainers' documented position is
that automation should use recipient/identity (public-key) mode instead
([discussion #256](https://github.com/FiloSottile/age/discussions/256),
[#275](https://github.com/FiloSottile/age/discussions/275)). osshp's
backup/restore model needs a genuine shared-secret **passphrase** — not a
key file the operator has to separately protect and back up — so this
tooling drives `age -p` itself, through two different paths depending on
whether a real terminal is available:

- **Interactive** (no `BACKUP_PASSPHRASE` set, run from a real terminal):
  the scripts invoke `age -p` directly and let it prompt on the terminal
  itself. The passphrase never enters `backup.sh`/`restore.sh`'s own
  memory or environment at all — it goes from your keyboard straight into
  `age`.
- **Non-interactive** (`BACKUP_PASSPHRASE` set — cron, scripted DR): with
  no real terminal available, `age -p`'s prompt can't be satisfied
  directly. `scripts/lib/age-pty.exp` bridges it: it allocates a real
  pseudo-terminal (`expect`'s whole purpose — driving interactive
  terminal programs from a script) and, from inside that Tcl
  interpreter, reads `BACKUP_PASSPHRASE` and sends it directly into the
  pty. The channel is: environment variable → Tcl interpreter memory →
  pty. **At no point does the passphrase, or any key derived from it,
  appear on any process's command line.** This was verified live: a
  400MB test archive's encrypt and decrypt runs were sampled with `ps`
  dozens of times over their full duration, with a canary string in
  place of the real passphrase — it never appeared in any process's
  command line.

The one channel this doesn't eliminate is `BACKUP_PASSPHRASE` as an
**environment variable** for the non-interactive case — there's no
alternative for `age -p`, which accepts nothing else non-interactively.
This is not a new exposure: the prior AES-256-CBC/openssl implementation
also delivered the passphrase this way for cron use. What *is* new and
fixed by this change: the prior implementation additionally derived a
second (HMAC) key from that passphrase and passed it to `openssl dgst
-macopt hexkey:...`, which put the **derived key** — not just the
passphrase — on that process's command line, visible to any other local
user via world-readable `/proc/<pid>/cmdline` on Linux. `age` has no
equivalent step; there is no derived key that ever touches argv, and the
passphrase itself never does either, interactive or not.

## Installing `age`

`age` is a host binary (like `tar`/`git`), not a pinned container image —
install it via your distro's package manager or a release binary:

```sh
# Debian/Ubuntu
sudo apt install age
# Fedora/RHEL
sudo dnf install age
# Alpine
sudo apk add age
# macOS
brew install age
```

Tested against **age v1.3.1**. Any 1.x release is expected to work — the
`-p`/`-o`/positional-`INPUT` surface these scripts depend on has been
stable since age's first stable release. `backup.sh`/`restore.sh` print
the detected version and warn (without blocking) if it looks unusually
old. If you install from a [GitHub release
binary](https://github.com/FiloSottile/age/releases) instead of a
package manager, verify it against the checksums file the release
publishes before trusting it.

**Non-interactive (cron/scripted) runs additionally need `expect`** — see
"Delivery channel" above for why. It ships in essentially every distro's
base repos:

```sh
sudo apt install expect   # or dnf/apk/brew
```

Interactive runs (a human at a terminal, no `BACKUP_PASSPHRASE` set) do
not need `expect` at all.

## Taking a backup

```sh
cd osshp/
BACKUP_PASSPHRASE='your-passphrase' ./scripts/backup.sh   # non-interactive (cron)
./scripts/backup.sh                                        # prompts for a passphrase
```

Output: `backups/osshp-backup-<UTC-timestamp>.tar.age` — `chmod 600`, a
single self-contained file.

**What happens to the running site:** the database dump is taken live —
posts, admin console, and the public site are unaffected throughout. The
Garage `storage` container is briefly stopped for the volume snapshot
(needed because Garage's metadata store can't be copied safely while it's
being written to — the same class of risk as copying a live SQLite WAL
file). During that window, media requests (`/media/...` — post cover
images, uploaded photos) fail; everything else keeps working. The window
is proportional to your media volume size; for a typical self-hosted blog
this is seconds. Schedule backups for low-traffic hours if this matters to
you.

### Scheduling (cron)

```cron
# Nightly at 3am, passphrase from a root-only file
0 3 * * * BACKUP_PASSPHRASE="$(cat /root/.osshp-backup-passphrase)" /path/to/osshp/scripts/backup.sh >> /var/log/osshp-backup.log 2>&1
```

Rotate old archives yourself (e.g. `find backups/ -name '*.tar.age' -mtime +30 -delete`) — `backup.sh` does not delete prior backups.

## Restoring

```sh
cd osshp/
BACKUP_PASSPHRASE='your-passphrase' ./scripts/restore.sh backups/osshp-backup-<timestamp>.tar.age
```

`restore.sh` first verifies the archive over its full length (see
"Integrity" above) — this happens before anything is extracted. Only once
that passes does it extract for real and print the backup's manifest
(timestamp, source commit); without `--yes` it then requires you to type
`restore` to confirm — this is a **destructive** operation: it replaces
the current database and Garage volumes, and overwrites `.env` /
`config/garage.toml` with the backed-up versions. Pass `--yes` to skip the
confirmation prompt (e.g. scripted disaster recovery) — the integrity
check still runs and still blocks a bad archive even with `--yes`.

### Restoring to the same host (recovering from data loss)

The stack is already deployed. Just run `restore.sh` — it stops the `app`
and `storage` containers for the swap, restores the database and volumes,
then brings everything back up and waits for `/api/health` to pass.

### Restoring to a fresh host (migration)

1. Clone/copy the osshp repo to the new host (no `.env` needed yet — it
   comes from the backup).
2. `docker compose up -d db storage` once, to create the empty volumes and
   network `restore.sh` needs.
3. Run `restore.sh <backup-file>` — it writes `.env`/`config/garage.toml`,
   restores the database, and replaces the Garage volumes with the
   snapshot. Because the snapshot includes Garage's own metadata (not just
   object bytes), the bucket, access keys, and cluster layout come back
   exactly as they were — **no manual `garage bucket create` / `garage key
   import` steps.**
4. `docker compose up -d` for the rest of the stack (`app`, `proxy`).
5. Point DNS at the new host and confirm Caddy issues a certificate for
   `OSSHP_DOMAIN` (restored from `.env`).

## Old-format archives (pre-cutover)

Earlier versions of this tooling produced `.tar.enc` + `.tar.enc.hmac`
pairs (AES-256-CBC + a separate HMAC-SHA256 sidecar, verified before
decrypt). `restore.sh` no longer reads that format at all — it refuses
immediately with a clear error if you point it at a `.tar.enc` file,
rather than silently misbehaving. osshp has not had a tagged release yet
(this cutover landed pre-`v0.1.0`), so there is no installed base to carry
forward compatibility for; the switch is clean.

If you have an old-format archive from local testing and need to recover
it, decrypt it by hand with the original tool:

```sh
# 1. Verify the HMAC sidecar first (never skip this step)
MAC_SALT_HEX="$(cut -d: -f1 backup.tar.enc.hmac)"
STORED_HMAC="$(cut -d: -f2 backup.tar.enc.hmac)"
MAC_KEY="$(openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -S "$MAC_SALT_HEX" -pass env:BACKUP_PASSPHRASE -P | awk -F= '/^key=/{print $2}')"
COMPUTED_HMAC="$(openssl dgst -sha256 -mac hmac -macopt "hexkey:$MAC_KEY" backup.tar.enc | awk -F'= ' '{print $2}')"
[ "$COMPUTED_HMAC" = "$STORED_HMAC" ] || { echo "INTEGRITY CHECK FAILED — stop"; exit 1; }

# 2. Only if that matched, decrypt
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in backup.tar.enc -out plain.tar
tar xf plain.tar
```

You'll then have the raw `db.dump` / `garage-volumes.tar.gz` / `env.backup`
/ `manifest.json` contents to work with by hand; there's no automated path
from there into a fresh `restore.sh` run.

## What is verified, and how

A backup→restore round-trip was exercised against the live review
instance (not a synthetic sandbox), directly with the shipped
`scripts/backup.sh` / `scripts/restore.sh` (via a throwaway passphrase,
against the real running `osshp` Docker Compose project — never a copy),
after switching the archive format from AES-256-CBC + a separate HMAC
sidecar to age passphrase-mode AEAD:

**Round-trip (byte-identical):**

1. Captured a content fingerprint before backup: row-content MD5 hashes of
   `posts` (9 rows), `settings` (15 rows), and `admin_user` (1 row, incl.
   passkey credentials).
2. Ran the real `backup.sh` against the running stack (non-interactive,
   `BACKUP_PASSPHRASE` env var — the cron path) — produced a single
   `.tar.age` archive.
3. Ran the real `restore.sh --yes` against that archive — the actual
   destructive path: verify pass, extract pass, DB dropped/recreated/
   restored, both Garage volumes wiped and replaced from the snapshot,
   `.env` / `garage.toml` overwritten, stack restarted.
4. Re-captured the same fingerprint post-restore: **all three row-content
   MD5s identical**, all containers healthy, `/api/health` 200, public
   site 200.
5. Repeated the whole round-trip a second time with the *interactive*
   code path (a real pty simulating a terminal user, answering `age`'s
   own native prompts — no `age-pty.exp` bridge involved) to confirm both
   delivery paths produce working archives. Same fingerprint match, same
   healthy result.

**Failure-mode tests:**

- **No-plaintext-on-failure (V-1):** ran `backup.sh` with `age` on `PATH`
  replaced by a stub that always fails — twice: once where the stub exits
  immediately (no output), once where it writes garbage bytes to its `-o`
  path before failing (simulating a mid-write disk-full). Both times the
  script failed loudly (exit 1) and `backups/` was left exactly as it was
  before the run — no plaintext, no partial ciphertext, no leftover
  staging directory.
- **Tamper detection, pre-extraction (V-2):** flipped one byte in the
  middle of a real encrypted archive (from a live backup, not a synthetic
  one) and ran `restore.sh <tampered-file> --yes` — the exact scripted
  disaster-recovery mode the docs recommend. The verify pass failed and
  the script aborted **before the extract pass ever ran** — confirmed by
  checking the extraction directory was completely empty afterward, not
  just that the DB/volumes were untouched. No container was stopped, no
  destructive step was reached.
- **Wrong passphrase:** against the real, untampered live archive —
  failed at the same verify-pass check (a wrong passphrase can't
  authenticate any chunk, so it's indistinguishable from tampering at
  this stage — the correct fail-closed behavior). DB fingerprint
  confirmed unchanged afterward.
- **No secret on argv:** sampled `ps` dozens of times during both a real
  encrypt and a real decrypt run (each driven through the `age-pty.exp`
  bridge, the non-interactive path) using a canary string in place of the
  real passphrase. It never appeared in any process's command line, on
  either the encrypt or the decrypt side.
- **`OSSHP_ENCRYPTION_KEY` travels correctly:** confirmed the restored
  `.env` is present with `OSSHP_ENCRYPTION_KEY` and `SESSION_SECRET`
  intact, and the live site (session/TOTP stack depends on
  `OSSHP_ENCRYPTION_KEY` initializing correctly) served 200s on both `/`
  and `/api/health` immediately after restore.

This proves the mechanism restores byte-identical content and admin
credentials — not just "a database exists and the app boots" — that
neither failure mode from the pre-age implementation survived the switch,
and that the specific property the switch was for (no secret, derived or
otherwise, on any process's argv) actually holds under a real run, not
just by code inspection.

### Linux/amd64 verification (the encryption/pty layer)

The round-trip above was first exercised on macOS (`age v1.3.1`, BSD
`expect`) — the shipped `linux/amd64` image runs on Linux, where `expect`
and `age`'s prompt wording under a Linux TTY could in principle differ.
This was subsequently re-verified directly on `linux/amd64` (Debian
12 "bookworm", `age v1.3.1`, Debian's `expect` package) by driving the
real, unmodified `scripts/lib/age-pty.exp` against a real `age` binary and
real Linux `expect`:

- **Round-trip:** encrypt via the exact `AGE_CMD` shape `backup.sh` uses
  (`tar cf - | age -p -o file` through `age-pty.exp`), then the exact
  two-pass verify+extract shape `restore.sh` uses. All four staged files
  came back SHA-256-identical.
- **Tamper, fail-closed:** one byte flipped mid-archive (~1.5 MB in, well
  into the ciphertext) — the verify pass failed with the same
  "failed to decrypt and authenticate payload chunk" error seen on macOS,
  and the extraction directory stayed completely empty (zero files, matching
  the "no extraction before authentication" property `restore.sh`'s
  two-pass design relies on).
- **Wrong passphrase, fail-closed:** same verify-pass failure path,
  `age: error: incorrect passphrase`.
- **No divergence found:** `age-pty.exp`'s prompt patterns
  (`Enter passphrase*` / `Confirm passphrase*`) and `age`'s actual prompt
  text matched exactly between macOS and Linux — no code change was
  needed in `age-pty.exp`, `backup.sh`, or `restore.sh`.

**A verification-environment note, not an osshp issue:** the first attempt
at this used QEMU-based `--platform linux/amd64` emulation on an Apple
Silicon (arm64) Docker host, and produced a *consistent, deterministic*
"failed to decrypt and authenticate payload chunk" error on every payload
above roughly 256–1000 bytes — reproducible with `age`'s own recipient/
identity mode alone (no `age-pty.exp`, no pipe, no `expect` involved at
all), which isolated it to QEMU's emulation of the AVX2 instructions Go's
ChaCha20-Poly1305 implementation uses for larger buffers, not to anything
in this repo. Setting `GODEBUG=cpu.avx2=off` (forcing the non-vectorized
fallback) made the corruption disappear completely and reproducibly. This
only matters if you're reproducing this specific verification via QEMU
emulation on an ARM host; it does not affect real `linux/amd64` hardware
(where AVX2 executes correctly) or the `linux/amd64` release image itself.

## Design notes (why volume-level, not S3-API-level, for media)

An alternative design would sync objects via the S3 API (`aws s3 sync`)
rather than snapshot the Garage volumes directly. That was rejected for
this tool: Garage's own bucket/key/cluster-layout state lives in its
metadata store, not in the S3 object namespace, so an S3-level sync alone
would restore your photos but not your bucket or access keys — a fresh
host would need manual `garage bucket create` / `garage key import`
reconciliation, and the restored key material would have to be
reconciled with what's already in the backed-up `.env`. Snapshotting
`garage-data` + `garage-meta` together restores Garage's entire state
atomically, which is what "reconstitute a working instance" requires. The
cost is the brief `storage` container stop during backup (see above) —
an acceptable trade for a self-hosted single-node deployment.

## Design notes (why age passphrase mode, not a key file)

`age`'s own maintainers recommend recipient/identity (public-key) mode for
scripted use, precisely because passphrase mode is deliberately
interactive-only in the CLI (see "Delivery channel" above). That would
have been the simpler implementation — no `expect` dependency, no pty
bridge, no chunk-authentication ordering subtlety to work around with a
verify pass. It was rejected here anyway, because it changes a security
property this tooling relies on: a memorized passphrase, kept
*deliberately outside* both `.env` and the backup archive, means that
compromising this host and its backups together still isn't enough to
decrypt them. Storing an age identity in `.env` — the natural place for a
self-hosted app to keep a secret it needs at runtime — would put the
decryption key back inside the very system (and the very archive) it's
supposed to protect, which is exactly the property a passphrase-based
scheme is meant to avoid. The `expect`-based bridge is the cost of keeping
that property while still supporting unattended cron/DR use.
