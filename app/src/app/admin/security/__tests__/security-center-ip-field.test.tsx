// Security Center IP-as-location-signal (v0.4.x follow-up): the operator's only
// practical way to recognize an unexpected session/event is the source IP — the
// session id is deliberately truncated (a full id is a live credential). This
// pins the structural contract: both the sessions list and the events feed
// render a LABELED IP field (never bare mono text) with an explicit, quiet
// "IP not recorded" state for a NULL ip, and no full session id ever appears in
// the rendered output or the data shapes that feed it.

import { expect, test, describe } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SecurityCenter } from "../SecurityCenter";
import type { AuditEventPage, SecurityOverview } from "@/lib/auth";

const FULL_SESSION_ID_WITH_IP =
  "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22"; // 48 hex chars — never truncated to this
const IP_PREFIX = FULL_SESSION_ID_WITH_IP.slice(0, 8);

const NO_IP_FULL_ID = "00112233445566778899aabbccddeeff0011223";
const NO_IP_PREFIX = NO_IP_FULL_ID.slice(0, 8);

function overview(): SecurityOverview {
  return {
    sessions: [
      {
        idPrefix: IP_PREFIX,
        current: true,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        createdIp: "203.0.113.7",
        userAgent: "Mozilla/5.0 Test",
      },
      {
        idPrefix: NO_IP_PREFIX,
        current: false,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        createdIp: null,
        userAgent: null,
      },
    ],
    recoveryCodes: { remaining: 10, generatedAt: new Date().toISOString() },
    totp: { enabled: true },
    passkeys: { count: 1 },
  };
}

function events(): AuditEventPage[] {
  return [
    {
      id: "evt-1",
      ts: new Date().toISOString(),
      event: "login.success",
      outcome: "success",
      ip: "198.51.100.9",
      details: null,
    },
    {
      id: "evt-2",
      ts: new Date().toISOString(),
      event: "break_glass",
      outcome: "success",
      ip: null,
      details: null,
    },
  ];
}

describe("SecurityCenter — IP-as-location-signal (sessions + events)", () => {
  const html = renderToStaticMarkup(
    <SecurityCenter initialOverview={overview()} initialEvents={events()} />,
  );

  test("a session with a recorded IP renders a labeled IP field, not bare mono text", () => {
    expect(html).toContain("IP <span class=\"mono\">203.0.113.7</span>");
  });

  test("a session with no recorded IP renders an explicit, quiet not-recorded state (never a blank)", () => {
    expect(html).toContain('<span class="ip-unknown">IP not recorded</span>');
  });

  test("an event with a recorded IP renders a labeled IP field, not bare mono text", () => {
    expect(html).toContain("IP <span class=\"mono\">198.51.100.9</span>");
  });

  test("an event with no recorded IP renders the same explicit not-recorded state", () => {
    // Two distinct null-ip rows (one session, one event) both hit ip-unknown.
    const matches = html.match(/<span class="ip-unknown">IP not recorded<\/span>/g);
    expect(matches?.length).toBe(2);
  });

  test("the session ref communicates it is a partial reference, not a full id", () => {
    expect(html).toContain(`partial id ${IP_PREFIX}…`);
    expect(html).toContain("Partial session reference");
  });

  test("no full session id ever appears in the rendered markup", () => {
    expect(html.includes(FULL_SESSION_ID_WITH_IP)).toBe(false);
    expect(html.includes(NO_IP_FULL_ID)).toBe(false);
  });

  test("SessionView response shape carries only an idPrefix, never a full id field", () => {
    const view = overview().sessions[0];
    expect(Object.keys(view)).not.toContain("id");
    expect(view.idPrefix.length).toBe(8);
  });
});
