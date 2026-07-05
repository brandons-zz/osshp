// Obvious-bot/crawler User-Agent heuristic (issue 029 design direction: "filter
// obvious bots/crawlers by UA heuristic before recording").
//
// This is intentionally a coarse, well-known-substring heuristic — not a
// device-detection library. It is not a security control (a scraper that spoofs
// a browser UA sails through, same as every other first-party analytics tool);
// its job is only to keep search-engine/uptime/social-preview crawlers from
// inflating pageview and unique-visitor counts.

const BOT_UA_RX =
  /bot|crawl|spider|slurp|archiver|preview|facebookexternalhit|whatsapp|telegrambot|discordbot|pingdom|uptimerobot|monitor|headlesschrome|phantomjs|puppeteer|playwright|curl\/|wget\/|python-requests|python-urllib|go-http-client|okhttp|libwww-perl|scrapy|node-fetch|axios\/|postmanruntime/i;

/**
 * True when the User-Agent looks like a known bot/crawler/monitoring tool, OR is
 * missing/blank. A real browser always sends a non-empty User-Agent; a blank one
 * is far more often a script or health-check than a privacy-hardened human
 * browser, so it is treated the same as a recognized bot — excluded from capture
 * rather than recorded as an ordinary visit.
 */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  const value = (ua ?? "").trim();
  if (value === "") return true;
  return BOT_UA_RX.test(value);
}
