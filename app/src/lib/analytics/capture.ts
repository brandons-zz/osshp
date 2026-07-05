// Server-side pageview capture (issue 029) — the single write path every public
// route funnels through (wired once, in lib/platform/render.ts's renderPublicRoute
// — see that file's comment for why it is the one choke point for every public
// HTML page-serve). Zero client script, zero cookies: everything here runs on the
// server before/while the response is written.
//
// Privacy posture (design direction, ratified 2026-07-04 — also documented in
// docs/modules.md § Analytics):
//  - DNT: 1 or Sec-GPC: 1 → the request is not recorded at all (not anonymized,
//    not queued — simply never looked at beyond the two header checks).
//  - Obvious bots/crawlers (bot-filter.ts) are excluded before any hash is computed.
//  - No raw IP or User-Agent is ever stored — only a salted one-way hash
//    (hash.ts) computed from them, and the salt itself is never persisted
//    (salt.ts). The stored event row (store.ts) carries UTC day, path, and
//    referrer HOST only — never a query string, never the visitor hash's inputs.
//  - Same-origin referrers (internal navigation) are not recorded as a
//    "referrer host" — only external sources are meaningful for a top-referrers
//    report; this also keeps the operator's own domain out of its own referrer
//    table.
//
// Fail-open by design: ANY error here (bad config, DB unreachable, malformed
// header) is caught and the event is silently dropped. Recording a pageview must
// never be the reason a real page-serve fails or slows down — the caller invokes
// this WITHOUT awaiting it (fire-and-forget) for exactly that reason.

import type { Db } from "@/lib/db/types";
import { config } from "@/lib/config";
import { clientIp } from "@/lib/auth/rate-limit";
import { isBotUserAgent } from "./bot-filter";
import { hashVisitor, utcDayString } from "./hash";
import { insertPageview, pruneEventsOlderThan } from "./store";
import { ANALYTICS_MODULE_ID } from "@/modules/analytics/manifest";

/**
 * True iff the Analytics module is in the enabled-module id list. Pure and
 * dependency-free so it is directly unit-testable (issue 029 acceptance evidence): the render
 * path (lib/platform/render.ts) already fetches `enabled` once per request for
 * its own slot/nav-guard logic, so this just re-uses that array — disabling the
 * module means this returns false and recordPageview is never even called.
 */
export function shouldCaptureForEnabledModules(
  enabledModuleIds: readonly string[],
): boolean {
  return enabledModuleIds.includes(ANALYTICS_MODULE_ID);
}

/**
 * The FULL capture decision the render path applies (issue 067): a pageview is
 * recorded only for a 200 serve of an enabled-analytics site. A 404 (or any
 * other non-200) render is NOT a pageview — recording it would let any
 * unauthenticated visitor spray random slugs to mint unbounded unique `path`
 * rows and poison the top-content report. Pure so the rule is unit-tested
 * directly (render.ts itself pulls next-request-scoped imports and cannot be
 * imported by bun tests — same constraint as slice.test.ts documents).
 */
export function shouldCapturePageview(
  status: number,
  enabledModuleIds: readonly string[],
): boolean {
  return status === 200 && shouldCaptureForEnabledModules(enabledModuleIds);
}

/** Recorded events are pruned once they are older than this many days. */
export const ANALYTICS_RETENTION_DAYS = 90;

// ── Capture-time string bounds (issue 067 — security gate) ───────────────────
// `path` and the referrer host are attacker-controlled request data; unbounded,
// a multi-KB request path / Referer value becomes a multi-KB row in
// analytics_events. The policy is DROP the event, not truncate-and-store: a
// truncated over-long value is still stored attacker garbage (and a truncated
// path was never a real page), while a legitimate pageview never exceeds either
// bound — so dropping loses nothing real.

/** Max recordable path length. Real content paths (/blog/<slug> etc.) are far
 *  shorter; anything beyond this is junk or an attack, never a real page. */
export const MAX_PATH_CHARS = 512;

/** Max recordable referrer-host length — the DNS hostname ceiling (RFC 1035,
 *  253 chars). No valid hostname is longer, so anything beyond is fabricated. */
export const MAX_REFERRER_HOST_CHARS = 253;

// Amortized, no-infra pruning: this codebase has no cron/scheduler (see
// lib/db/migrate.ts's own "run on every boot" idempotent pattern for the same
// no-infra bias). Rather than add one, a random 1-in-N recorded pageview also
// triggers a prune sweep. At any real traffic volume this keeps the table bounded
// without ever adding a scheduled job; at zero traffic there is nothing to prune.
const PRUNE_PROBABILITY = 1 / 500;

/** The referrer's origin HOST, or null when absent/unparseable/hostless/same-origin. */
function externalReferrerHost(request: Request): string | null {
  const referer = request.headers.get("referer");
  if (!referer) return null;
  try {
    const referrerUrl = new URL(referer);
    // QA-gate finding (2026-07-05): scheme-only URLs — javascript:, data:,
    // mailto:, about:blank, file:/// — PARSE successfully but carry an empty
    // `.host`. Without this check the empty string was stored as a referrer
    // host, passed the dashboard's IS NOT NULL filter, and rendered as a
    // permanent blank top-referrers row. No host = no referrer, exactly like
    // an absent header.
    if (referrerUrl.host === "") return null;
    let ownHost: string | null = null;
    try {
      ownHost = new URL(config.origin).host;
    } catch {
      ownHost = null; // misconfigured/unset origin — fall through, still record
    }
    if (ownHost && referrerUrl.host === ownHost) return null; // internal nav
    return referrerUrl.host;
  } catch {
    return null; // unparseable Referer header
  }
}

/**
 * Record one public pageview, or silently do nothing when the request should not
 * be counted (DNT/GPC, bot UA) or anything fails. `path` must already be the
 * pathname only (no query string) — callers pass `new URL(request.url).pathname`.
 */
export async function recordPageview(
  db: Db,
  request: Request,
  path: string,
): Promise<void> {
  try {
    if (request.headers.get("dnt") === "1") return;
    if (request.headers.get("sec-gpc") === "1") return;

    const ua = request.headers.get("user-agent");
    if (isBotUserAgent(ua)) return;

    // issue 067 — drop (never truncate) events whose attacker-controlled
    // strings exceed the bounds; see the constants above for why drop-not-store.
    if (path.length > MAX_PATH_CHARS) return;
    const referrerHost = externalReferrerHost(request);
    if (referrerHost !== null && referrerHost.length > MAX_REFERRER_HOST_CHARS) {
      return;
    }

    const day = utcDayString();
    const ip = clientIp(request) ?? "unknown";
    const visitorHash = hashVisitor(ip, ua ?? "", day);

    await insertPageview(db, { day, path, referrerHost, visitorHash });

    if (Math.random() < PRUNE_PROBABILITY) {
      await pruneEventsOlderThan(db, ANALYTICS_RETENTION_DAYS);
    }
  } catch {
    // Fail open (design direction: capture must never hurt serving).
  }
}
