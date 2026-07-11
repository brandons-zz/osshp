# osshp — Accepted Security Trade-offs

This document records the security trade-offs osshp accepts by design, and
what you as the operator are responsible for as a result. It is written
under osshp's **single-admin threat model**: one install is one site with
one administrator (the WordPress.org model). There is no multi-tenant
isolation to breach, no second account to escalate into, and no untrusted
co-admin. The person who controls the host controls the instance — that is
the whole design, not a gap in it.

The items below are not bugs and not open work. They are places where a
control has a real, irreducible limit, and where the remaining protection
depends on an operational discipline that osshp cannot enforce from inside
the application. Each one is safe under the single-admin model; each one is
written down so you can make an informed decision rather than discover the
edge later.

---

## 1. The secret-strength check cannot prove entropy — the real control is how you generate the secret

osshp refuses to boot with a weak `SESSION_SECRET` or `OSSHP_ENCRYPTION_KEY`.
The check (`src/lib/auth/secret-strength.ts`, enforced at startup in
`instrumentation.register`) rejects a secret that is too short (< 32
characters), too low-variety (too few distinct characters), or a known
weak literal. This fails **loud** — the container reports unhealthy and
every request returns 500 until you supply a real secret — rather than
silently running an easily brute-forced instance.

**The trade-off:** a length-and-variety floor is a *heuristic*. It can
reject an obviously bad secret, but it cannot prove a secret is actually
high-entropy. A 64-character string that looks random to the heuristic but
was derived from something guessable (a passphrase, a keyboard walk, a
value reused from elsewhere) will pass the check and still be weak. No
in-process check can distinguish real randomness from a convincing
imitation of it.

**Your responsibility — the real control:** generate each secret with a
cryptographic RNG, exactly as the setup runbook specifies:

```
openssl rand -hex 32     # SESSION_SECRET, OSSHP_ENCRYPTION_KEY
openssl rand -hex 24     # POSTGRES_PASSWORD
```

`openssl rand -hex` is the control that actually delivers entropy. The
boot-time check is a backstop that catches a secret you clearly did not
generate this way — it is not a substitute for generating it this way.
Do not hand-type secrets, do not reuse them across instances, and do not
weaken them to something memorable.

---

## 2. The backup archive intentionally contains `OSSHP_ENCRYPTION_KEY` — archive confidentiality rests entirely on the backup passphrase

A full backup (`scripts/backup.sh`) produces a single encrypted archive
that contains **every secret this instance holds** — including
`OSSHP_ENCRYPTION_KEY`, the AES-256-GCM key that decrypts the admin's TOTP
secrets already inside the Postgres dump.

This is required, not incidental. `OSSHP_ENCRYPTION_KEY` must travel with
the database dump, or a restore produces an instance whose TOTP secrets are
permanently undecryptable — a broken instance, not a working one. The
admin's passkey credentials and recovery codes are restored byte-for-byte
for the same reason: so the same admin can log back in after a restore with
no re-enrollment. A backup that omitted these secrets would not be a
backup.

**The trade-off:** because the archive carries the keys to everything, its
confidentiality cannot come from those keys — it can only come from the
one secret that is *not* inside it: the **backup passphrase** you supply.
The archive is encrypted with [age](https://age-encryption.org) in
passphrase mode (an AEAD construction — ChaCha20-Poly1305 over a
scrypt-derived key), streamed so no plaintext copy is ever written to disk,
and authenticated so any tampered or truncated byte is rejected before a
restore touches anything. All of that protects the archive in transit and
at rest — but only as strongly as the passphrase behind it. Anyone who
obtains both the archive and its passphrase can fully impersonate this
instance's admin.

**Your responsibility:** treat the backup archive as **at least as
sensitive as `.env` itself**.

- Choose a strong, unique backup passphrase (`openssl rand -hex 24` is a
  fine source).
- **Store the passphrase separately from the archive** — a password
  manager, never a note next to the backup file, never committed anywhere.
- Losing the passphrase makes the archive permanently unrecoverable, by
  design — there is no backdoor.
- `backups/` is gitignored; never commit an archive. When you copy an
  archive off-host (recommended — a backup that lives only on the machine
  it protects is not a backup), age's authenticated encryption is what
  makes an untrusted channel or storage provider safe — provided the
  passphrase is not stored alongside it.

---

## 3. Non-interactive backups keep the passphrase in an environment variable — the one unavoidable channel

An interactive backup prompts for the passphrase on the terminal, and it
never enters the script's memory or environment at all. But a scheduled
backup (cron, automated disaster recovery) has no terminal to prompt on,
so the passphrase is supplied through the `BACKUP_PASSPHRASE` environment
variable.

This is unavoidable, and here is exactly why. osshp uses `age` in
passphrase mode, and `age -p` deliberately accepts a passphrase **only**
from an interactive terminal — no flag, no stdin/fd convention, no env-var
input of its own (an upstream design decision;
[age discussions #256/#275](https://github.com/FiloSottile/age/discussions/256)).
To drive it from a script, osshp bridges `BACKUP_PASSPHRASE` into age's
terminal prompt through a real pseudo-terminal
(`scripts/lib/age-pty.exp`). The passphrase travels **environment variable
→ Tcl interpreter memory → pty**. It is never placed on any process's
command line (argv), and never written to a temp file — so it does not
appear in `ps`, in `/proc/<pid>/cmdline`, or on disk. The env-var entry
point is the only channel age leaves open for the non-interactive case.

**The trade-off:** for the duration of a scheduled run, the passphrase
lives in the environment of the backup process. This is the **same threat
class as any cron secret** — a database password in a cron job's
environment, an API token a scheduled task reads. Under the single-admin
model, an attacker who can read another process's environment on this host
already has host-level access, and therefore already has `.env` (and thus
every secret the backup would protect) — so this channel does not widen the
blast radius beyond what such an attacker already holds.

**Your responsibility:** protect the source of `BACKUP_PASSPHRASE` the way
you would any cron secret.

- Keep it in a root-readable-only file and read it inline in the cron line,
  rather than hard-coding it in the crontab:

  ```
  0 3 * * * BACKUP_PASSPHRASE="$(cat /root/.osshp-backup-passphrase)" /path/to/osshp/scripts/backup.sh >> /var/log/osshp-backup.log 2>&1
  ```

- `chmod 600` (root-only) that passphrase file.
- Do not echo it into logs or shell history.
- For a purely manual backup regime, prefer the interactive prompt — it
  keeps the passphrase off the process environment entirely.

---

## 4. Cloudflare Tunnel mode trusts Cloudflare's edge — and the connector token is visible to anyone who can inspect the containers

In tunnel mode, TLS terminates at Cloudflare's edge: Cloudflare can read and
modify all traffic to your site in plaintext, including admin session cookies.
(Passkey *credentials* remain safe — WebAuthn assertions are origin-bound and
cannot be replayed — but a hostile or compelled edge could hijack a live
session.) This is the same trade every Cloudflare-proxied site makes; direct
mode exists for operators who don't want it.

The tunnel connector token in `.env` (`CLOUDFLARE_TUNNEL_TOKEN`) is passed to
cloudflared on its command line, so it is visible in `docker inspect` /
`docker compose config` output on the host — the standard cloudflared
deployment pattern. Under the single-admin model this adds nothing: anyone who
can inspect your containers can already read `.env`. Treat the token like
every other secret (it grants the right to serve your hostname and to remap
the tunnel's ingress); if it leaks, revoke/rotate it in the Zero Trust
dashboard. Never commit `.env` — or the `.env.bak-*` files setup.sh writes —
to version control.

Remapping the tunnel's ingress with a stolen token is bounded by the Docker
network, not just by the Cloudflare dashboard: `cloudflared` sits on a
dedicated `edge` network with only `proxy` on it (issue 035), so even a
compromised token can't be used to reach `db`, `storage`, or `app`
directly — only whatever `proxy` itself serves.

---

## 5. Don't point `OSSHP_WEBHOOK_URL` at this instance's own auth endpoints — self-notification loop / amplification

Security notifications (`OSSHP_WEBHOOK_URL` / Pushover — see the "Security
notifications" block in `.env.example`, implemented in
`src/lib/auth/notify.ts`) are meant to be delivered to a channel you read
*outside* this instance — a chat relay, your own separate service, a LAN
endpoint. Pointing the webhook back at this same osshp instance's admin
or auth surface (e.g. an authenticated endpoint that itself performs a
credential mutation, or anything designed to provoke a login/recovery
attempt) creates a self-notification loop: each delivery is itself a request
to the app, and if that request lands on a route this instance's own audit
log tracks as a notifying event (§6.2's `NOTIFY_EVENTS` — passkey enrollment,
a credential change, a recovery-lane use, break-glass, an all-other-sessions
revoke, or repeated lockouts), it can trigger another notification, whose
delivery makes another request, and so on — an amplifying loop against your
own app and outbound channel.

**This is bounded, not eliminated, regardless of configuration.** The
`lockout` event — the one most plausible to trip accidentally in a loop
(repeated failed attempts against an auth endpoint) — is coalesced to **at
most one send per lane per 60-minute window** (`LOCKOUT_COALESCE_MS` in
`notify.ts`), so even a genuine self-referential loop against a lockout-
generating route cannot exceed that rate. The other `NOTIFY_EVENTS` members
are not coalesced, so do not rely on coalescing alone as a reason this is
safe — the real control is simply not wiring the webhook back into your own
auth surface in the first place.

**Your responsibility:** point `OSSHP_WEBHOOK_URL` at an external receiver
you control, never at this instance's own domain or any endpoint that could
itself generate an auth-audited event.

---

## Summary

| Trade-off | The real control | Your responsibility |
|---|---|---|
| Secret-strength check is a heuristic, not an entropy proof | `openssl rand -hex` generation | Generate every secret with a CSPRNG; never hand-type or reuse |
| Backup archive contains `OSSHP_ENCRYPTION_KEY` (so TOTP restores) | The backup passphrase | Choose it strong and unique; store it separately from the archive |
| Cron backups pass the passphrase via `BACKUP_PASSPHRASE` env var | Same as any cron secret | Root-only passphrase file; read inline; keep it out of logs/history |
| Tunnel mode terminates TLS at Cloudflare's edge; the connector token is host-inspectable | The single-admin trust boundary + Cloudflare's edge | Choose direct mode if you won't trust the edge; keep `.env`/`.env.bak-*` out of git; revoke a leaked token in Zero Trust |
| A webhook pointed at this instance's own auth surface can create a self-notification loop | Lockout coalescing bounds the worst case (1/lane/60min); it is not a substitute for correct config | Point `OSSHP_WEBHOOK_URL` at an external receiver, never back at this instance |

All five are safe under osshp's single-admin threat model. They are
documented here so the operational disciplines they depend on — strong
generation, separate passphrase storage, cron-secret hygiene, a deliberate
edge-trust choice, and pointing outbound alerts at a genuinely external
receiver — are visible choices, not hidden assumptions.
