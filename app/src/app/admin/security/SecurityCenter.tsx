"use client";

// SecurityCenter — the client half of /admin/security (Slice 2).
//
// Renders four read surfaces from the SSR-injected initial data — at-a-glance
// posture (recovery-code status is the required one; passkeys/TOTP are free reads),
// sessions/devices, and the durable auth-events feed — plus the one mutation the
// center owns: revoke every session but this one. That mutation is A1-step-up-gated
// via the EXISTING StepUpDialog (unmodified, imported the same way AccountSecurity
// does); the passkey/fallback ceremony IS the confirmation — no second confirm
// dialog is stacked on top (spec §9 / 4.1.2).
//
// AA (spec §9): severity is never carried by text color — every event/session line
// keeps --text/--text-muted labels and pairs an aria-hidden glyph with the words;
// the current-session badge is fill+text+glyph (not color alone); the events feed
// is a tabbable role="region"; the revoke result is a polite role="status" live
// region; full flow is native <button>/<dialog>, keyboard-operable, reflows at
// 320px.
//
// IP-as-location-signal (v0.4.x follow-up): the operator's only practical way to
// recognize an unexpected session/event is the source IP — the session id is
// deliberately truncated (a full id is a live credential). `IpField` renders a
// labeled "IP <value>" pair (never bare mono text) in both the sessions list and
// the events feed, leading ahead of the session's truncated ref, plus an
// explicit, quiet "IP not recorded" state for rows/events with a NULL ip
// (written before the v0.4.0 capture existed) — never a silent blank.

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { StepUpDialog } from "../account/security/StepUpDialog";
import type {
  AuditEventPage,
  SecurityOverview,
  SessionView,
} from "@/lib/auth";

const GRANT_HEADER = "x-osshp-stepup-grant";
const EXPIRED_MSG = "Your confirmation expired. Please try again.";
/** Recovery-code low-count warning threshold (spec §3.4). */
const RECOVERY_WARN_AT = 3;

type RequestStepUp = (actionLabel: string) => Promise<string | null>;

// ── time + label helpers ─────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const diff = Date.now() - then;
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  const pick = (): string => {
    if (s < 45) return "just now";
    const m = s / 60;
    if (m < 45) return `${Math.round(m)} minute${Math.round(m) === 1 ? "" : "s"}`;
    const h = m / 60;
    if (h < 22) return `${Math.round(h)} hour${Math.round(h) === 1 ? "" : "s"}`;
    const d = h / 24;
    if (d < 26) return `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"}`;
    const w = d / 7;
    if (w < 8) return `${Math.round(w)} week${Math.round(w) === 1 ? "" : "s"}`;
    const mo = d / 30;
    if (mo < 18) return `${Math.round(mo)} month${Math.round(mo) === 1 ? "" : "s"}`;
    return `${Math.round(d / 365)} year${Math.round(d / 365) === 1 ? "" : "s"}`;
  };
  const phrase = pick();
  if (phrase === "just now") return phrase;
  return future ? `in ${phrase}` : `${phrase} ago`;
}

function daysAgo(iso: string): number | null {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

/** UA is a courtesy hint, never an identity claim (spec §3.2) — a coarse
 *  phone/desktop split for a decorative glyph only. */
function isMobileUa(ua: string | null): boolean {
  return !!ua && /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
}

/** A short, non-identity device label for a session row. NULL metadata → the
 *  documented pre-v0.4.0 fallback (§3.2); never a warning. */
function sessionLabel(s: SessionView): { label: string; fallback: boolean } {
  if (s.userAgent === null && s.createdIp === null) {
    return { label: "unknown (issued before v0.4.0)", fallback: true };
  }
  if (s.userAgent) {
    return { label: isMobileUa(s.userAgent) ? "Mobile device" : "Desktop browser", fallback: false };
  }
  return { label: "This account", fallback: false };
}

type Kind = "success" | "danger" | "warn" | "info";

/** Map a stored audit record to plain-language text + a glyph kind. The label is
 *  always the carrier of meaning; the glyph/color is a scan aid (spec §9, 1.4.1). */
function describeEvent(e: AuditEventPage): { label: string; kind: Kind } {
  const d = (e.details ?? {}) as Record<string, unknown>;
  switch (e.event) {
    case "login.success":
      return { label: "Signed in successfully", kind: "success" };
    case "login.failure":
      return { label: "Failed sign-in attempt", kind: "danger" };
    case "passkey.enroll":
      return e.outcome === "success"
        ? { label: "A new passkey was added", kind: "info" }
        : { label: "A passkey enrollment failed", kind: "danger" };
    case "passkey.enroll_failure":
      return { label: "A passkey enrollment failed", kind: "danger" };
    case "session.revoke":
      return { label: "A session was signed out", kind: "info" };
    case "session.revoke_all":
      return { label: "All sessions were signed out", kind: "info" };
    case "session.revoke_others": {
      const n = typeof d.revoked === "number" ? d.revoked : null;
      return {
        label: n === null
          ? "All other sessions were terminated"
          : `All other sessions were terminated (${n} revoked)`,
        kind: "info",
      };
    }
    case "rate_limit.trip":
      return { label: "Too many attempts were throttled", kind: "warn" };
    case "setup.complete":
      return { label: "Initial setup completed", kind: "info" };
    case "recovery.success":
      return { label: "A recovery code / fallback login was used", kind: "warn" };
    case "recovery.failure":
      return { label: "A recovery attempt failed", kind: "danger" };
    case "lockout": {
      const lane = typeof d.lane === "string" ? d.lane : null;
      return {
        label: lane
          ? `Repeated failed attempts locked the ${lane} lane`
          : "Repeated failed attempts locked a lane",
        kind: "danger",
      };
    }
    case "break_glass":
      return { label: "CLI break glass reset was invoked", kind: "warn" };
    case "credential.change": {
      const c = typeof d.credential === "string" ? d.credential : "";
      const text =
        c === "password"
          ? "Password was changed"
          : c === "totp"
            ? "TOTP authenticator was updated"
            : c === "recovery_codes"
              ? "Recovery codes were regenerated"
              : c === "passkey"
                ? "A passkey was removed"
                : "A credential was changed";
      return { label: text, kind: "info" };
    }
    case "stepup.grant":
      return { label: "Identity re-confirmed (step-up)", kind: "info" };
    case "stepup.failure":
      return { label: "A step-up confirmation failed", kind: "danger" };
    case "stepup.denied":
      return { label: "An action required step-up confirmation", kind: "warn" };
    default:
      return { label: e.event, kind: "info" };
  }
}

// ── inline glyphs (aria-hidden — always duplicated in adjacent text) ──────────

const S = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function IconClock({ cls }: { cls?: string }) {
  return (
    <svg className={cls} viewBox="0 0 24 24" {...S} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4l3 2" />
    </svg>
  );
}
function IconAlert({ cls }: { cls?: string }) {
  return (
    <svg className={cls} viewBox="0 0 24 24" {...S} aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}
function IconKey({ cls }: { cls?: string }) {
  return (
    <svg className={cls} viewBox="0 0 24 24" {...S} aria-hidden="true">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}
function IconLock({ cls }: { cls?: string }) {
  return (
    <svg className={cls} viewBox="0 0 24 24" {...S} aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
function IconLaptop({ cls }: { cls?: string }) {
  return (
    <svg className={cls} viewBox="0 0 24 24" {...S} aria-hidden="true">
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M2 17h20M9 21h6" />
    </svg>
  );
}
function IconPhone({ cls }: { cls?: string }) {
  return (
    <svg className={cls} viewBox="0 0 24 24" {...S} aria-hidden="true">
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <path d="M11 18h2" />
    </svg>
  );
}
function IconCheckCircle({ cls }: { cls?: string }) {
  return (
    <svg className={cls} viewBox="0 0 24 24" {...S} aria-hidden="true">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="M22 4 12 14.01l-3-3" />
    </svg>
  );
}
function IconDot({ cls }: { cls?: string }) {
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="5" />
    </svg>
  );
}
function IconInfoCircle({ cls }: { cls?: string }) {
  return (
    <svg className={cls} viewBox="0 0 24 24" {...S} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4h4" />
    </svg>
  );
}

function eventIcon(kind: Kind) {
  const cls = `icon event-row__icon event-row__icon--${kind}`;
  if (kind === "success") return <IconCheckCircle cls={cls} />;
  if (kind === "danger" || kind === "warn") return <IconAlert cls={cls} />;
  return <IconDot cls={cls} />;
}

/**
 * A labeled IP field, shared by the sessions list and the events feed — the IP
 * is the operator's key second scan signal alongside the (deliberately)
 * truncated session reference, so it must never render as bare, unlabeled mono
 * text. A NULL ip (rows/events written before the v0.4.0 metadata capture
 * existed) renders an explicit, quiet "IP not recorded" state — never a blank.
 */
function IpField({ ip }: { ip: string | null }) {
  return ip ? (
    <span>
      IP <span className="mono">{ip}</span>
    </span>
  ) : (
    <span className="ip-unknown">IP not recorded</span>
  );
}

// ── surfaces ──────────────────────────────────────────────────────────────────

function AtAGlance({ overview }: { overview: SecurityOverview }) {
  const { recoveryCodes, passkeys, totp } = overview;
  const remaining = recoveryCodes.remaining;
  const low = remaining > 0 && remaining <= RECOVERY_WARN_AT;
  const age = recoveryCodes.generatedAt ? daysAgo(recoveryCodes.generatedAt) : null;
  const ageText =
    recoveryCodes.generatedAt !== null && age !== null
      ? `generated ${age === 0 ? "today" : `${age} day${age === 1 ? "" : "s"} ago`}`
      : "generation date unknown — regenerate to start tracking";

  return (
    <div className="analytics-stats" aria-label="Security posture at a glance">
      <div className="analytics-stat" data-warn={low ? "true" : undefined}>
        <p className="analytics-stat-value">
          <IconClock cls="icon" />
          <span>{remaining === 0 ? "None" : `${remaining} of 10`}</span>
        </p>
        <p className="analytics-stat-label">
          {low ? <IconAlert cls="icon icon-inline" /> : null}
          {remaining === 0 ? (
            <>
              no recovery codes generated —{" "}
              <a href="/admin/account/security">generate a set</a>
            </>
          ) : (
            <>
              recovery codes remaining · {ageText}
              {low ? " — running low" : ""}
            </>
          )}
        </p>
      </div>

      <div className="analytics-stat">
        <p className="analytics-stat-value">
          <IconKey cls="icon" />
          <span>{passkeys.count}</span>
        </p>
        <p className="analytics-stat-label">
          passkey{passkeys.count === 1 ? "" : "s"} registered
        </p>
      </div>

      <div className="analytics-stat">
        <p className="analytics-stat-value">
          <IconLock cls="icon" />
          <span>{totp.enabled ? "Enabled" : "Not set"}</span>
        </p>
        <p className="analytics-stat-label">TOTP authenticator</p>
      </div>
    </div>
  );
}

function SessionsCard({
  sessions,
  result,
  busy,
  onRevoke,
}: {
  sessions: SessionView[];
  result: { kind: "success" | "error"; text: string } | null;
  busy: boolean;
  onRevoke: () => void;
}) {
  const otherCount = sessions.filter((s) => !s.current).length;
  return (
    <section className="shell-card">
      <div className="sc-header">
        <div className="sc-header-copy">
          <h2>Sessions &amp; devices</h2>
          <p className="muted sc-subtle">
            Every device currently signed in to this admin account.
          </p>
        </div>
        <div className="sc-header-action">
          <Button
            type="button"
            className="osshp-button--danger"
            onClick={onRevoke}
            disabled={busy}
          >
            {busy ? "Working…" : "Revoke all other sessions"}
          </Button>
          <p className="muted sc-helper">
            {otherCount > 0 ? (
              <>
                This will end <strong>{otherCount} other session{otherCount === 1 ? "" : "s"}</strong>{" "}
                and sign you back in with a fresh one.
              </>
            ) : (
              <>You have no other active sessions. This will still issue you a fresh session token.</>
            )}
          </p>
        </div>
      </div>

      <div className="sc-result" role="status" data-kind={result?.kind} hidden={!result}>
        {result?.text ?? ""}
      </div>

      <ul className="session-list" aria-label="Active sessions">
        {sessions.map((s) => {
          const { label, fallback } = sessionLabel(s);
          const mobile = isMobileUa(s.userAgent);
          return (
            <li className="session-row" key={s.idPrefix}>
              <span className="session-row__icon" aria-hidden="true">
                {mobile ? <IconPhone cls="icon icon-lg" /> : <IconLaptop cls="icon icon-lg" />}
              </span>
              <div className="session-row__body">
                <div className="session-row__top">
                  {fallback ? (
                    <span className="session-row__fallback">{label}</span>
                  ) : (
                    <strong>{label}</strong>
                  )}
                  {s.current ? (
                    <span className="badge-current">
                      <IconCheckCircle cls="icon icon-badge" />
                      This device
                    </span>
                  ) : null}
                </div>
                <div className="session-row__meta">
                  <span title={s.createdAt}>Signed in {relativeTime(s.createdAt)}</span>
                  <span title={s.lastSeenAt}>Last active {relativeTime(s.lastSeenAt)}</span>
                  <span title={s.expiresAt}>Expires {relativeTime(s.expiresAt)}</span>
                  {/* IP leads as the location signal; the session ref stays last and
                      reads unambiguously as a partial, non-secret reference — the
                      full session id never leaves the server. */}
                  <IpField ip={s.createdIp} />
                  <span
                    className="mono"
                    title="Partial session reference — the full session id never leaves the server"
                  >
                    partial id {s.idPrefix}…
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function EventsCard({
  events,
  noMore,
  loadingMore,
  onLoadOlder,
}: {
  events: AuditEventPage[];
  noMore: boolean;
  loadingMore: boolean;
  onLoadOlder: () => void;
}) {
  return (
    <section className="shell-card">
      <div className="sc-header">
        <div className="sc-header-copy">
          <h2>Recent activity</h2>
          <p className="muted sc-subtle">
            Sign-ins, credential changes, lockouts, and session actions.
          </p>
        </div>
      </div>

      <div className="feed-banner">
        <IconInfoCircle cls="icon" />
        <span>
          This feed shows durable audit history. Activity from before the Security
          Center was enabled isn&rsquo;t recorded here.
        </span>
      </div>

      <div
        className="events-feed-scroll"
        role="region"
        aria-label="Recent authentication events"
        tabIndex={0}
      >
        {events.length === 0 ? (
          <p className="muted" style={{ padding: "var(--space-xs) var(--space-2xs)" }}>
            No recorded activity yet.
          </p>
        ) : (
          <ul className="plain-list">
            {events.map((e) => {
              const { label, kind } = describeEvent(e);
              return (
                <li className="event-row" key={e.id}>
                  {eventIcon(kind)}
                  <div className="event-row__body">
                    <div className="event-row__label">{label}</div>
                    <div className="event-row__meta">
                      <span title={e.ts}>{relativeTime(e.ts)}</span>
                      {" · "}
                      <IpField ip={e.ip} />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {events.length > 0 ? (
        <p className="sc-load-more">
          <Button
            type="button"
            className="osshp-button--ghost"
            onClick={onLoadOlder}
            disabled={noMore || loadingMore}
          >
            {noMore ? "No more activity" : loadingMore ? "Loading…" : "Load older activity"}
          </Button>
        </p>
      ) : null}
    </section>
  );
}

// ── composed ──────────────────────────────────────────────────────────────────

export function SecurityCenter({
  initialOverview,
  initialEvents,
}: {
  initialOverview: SecurityOverview;
  initialEvents: AuditEventPage[];
}) {
  const [overview, setOverview] = useState(initialOverview);
  const [events, setEvents] = useState(initialEvents);
  const [noMore, setNoMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  // One shared step-up dialog, resolved via a promise per requesting action —
  // the exact pattern AccountSecurityForm uses.
  const resolverRef = useRef<((grant: string | null) => void) | null>(null);
  const [stepUpLabel, setStepUpLabel] = useState<string | null>(null);

  const requestStepUp = useCallback<RequestStepUp>((actionLabel) => {
    return new Promise<string | null>((resolve) => {
      resolverRef.current = resolve;
      setStepUpLabel(actionLabel);
    });
  }, []);

  const settle = useCallback((grant: string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setStepUpLabel(null);
    resolve?.(grant);
  }, []);

  const handleRevoke = useCallback(async () => {
    setResult(null);
    const grant = await requestStepUp("revoke all other sessions");
    if (!grant) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/security/sessions/revoke-others", {
        method: "POST",
        headers: { [GRANT_HEADER]: grant },
      });
      if (res.status === 403) {
        setResult({ kind: "error", text: EXPIRED_MSG });
        return;
      }
      if (!res.ok) {
        setResult({ kind: "error", text: "Could not revoke sessions. Please try again." });
        return;
      }
      const data = (await res.json()) as { revoked: number };
      setResult({
        kind: "success",
        text: `All other sessions were signed out. ${data.revoked} session${data.revoked === 1 ? "" : "s"} ended. You're still signed in on this device.`,
      });
      // Re-fetch the overview with the fresh cookie the response just set.
      const refreshed = await fetch("/api/admin/security/overview");
      if (refreshed.ok) setOverview((await refreshed.json()) as SecurityOverview);
    } catch {
      setResult({ kind: "error", text: "Could not revoke sessions. Please try again." });
    } finally {
      setBusy(false);
    }
  }, [requestStepUp]);

  const handleLoadOlder = useCallback(async () => {
    if (noMore || events.length === 0) return;
    setLoadingMore(true);
    try {
      const before = events[events.length - 1].ts;
      const res = await fetch(`/api/admin/security/events?before=${encodeURIComponent(before)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { events: AuditEventPage[] };
      if (data.events.length === 0) {
        setNoMore(true);
        return;
      }
      setEvents((prev) => [...prev, ...data.events]);
    } finally {
      setLoadingMore(false);
    }
  }, [events, noMore]);

  return (
    <div className="stack-l">
      <div>
        <h1 className="sc-title">Security Center</h1>
        <p className="muted sc-intro">
          Sessions, recent authentication activity, and recovery-code status for
          this admin account — plus a one-click way to end every other session if
          something looks wrong.
        </p>
      </div>

      <AtAGlance overview={overview} />

      <SessionsCard
        sessions={overview.sessions}
        result={result}
        busy={busy}
        onRevoke={handleRevoke}
      />

      <EventsCard
        events={events}
        noMore={noMore}
        loadingMore={loadingMore}
        onLoadOlder={handleLoadOlder}
      />

      <StepUpDialog
        open={stepUpLabel !== null}
        actionLabel={stepUpLabel ?? ""}
        onGrant={(grant) => settle(grant)}
        onCancel={() => settle(null)}
      />
    </div>
  );
}
