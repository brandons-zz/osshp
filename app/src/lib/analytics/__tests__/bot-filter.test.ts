import { expect, test } from "bun:test";
import { isBotUserAgent } from "../bot-filter";

test("recognizes well-known crawler/bot user agents", () => {
  expect(isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
  expect(isBotUserAgent("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)")).toBe(true);
  expect(isBotUserAgent("facebookexternalhit/1.1")).toBe(true);
  expect(isBotUserAgent("curl/8.4.0")).toBe(true);
  expect(isBotUserAgent("python-requests/2.31.0")).toBe(true);
  expect(isBotUserAgent("Slackbot-LinkExpanding 1.0")).toBe(true);
});

test("treats a missing or blank User-Agent as excluded (conservative)", () => {
  expect(isBotUserAgent(null)).toBe(true);
  expect(isBotUserAgent(undefined)).toBe(true);
  expect(isBotUserAgent("")).toBe(true);
  expect(isBotUserAgent("   ")).toBe(true);
});

test("an ordinary browser User-Agent is not flagged as a bot", () => {
  expect(
    isBotUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    ),
  ).toBe(false);
  expect(
    isBotUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    ),
  ).toBe(false);
});
