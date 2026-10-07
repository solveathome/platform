/**
 * Agents read markdown or JSON; browsers and link-preview crawlers get HTML. A crawler (Facebook, Twitter/X, Slack, Discord,
 * LinkedIn, WhatsApp, Telegram, iMessage, Google) often sends a wildcard Accept and no text/html; it still needs the page with the share tags.
 */
import type { Request } from "express";
const CRAWLER = /facebookexternalhit|facebot|twitterbot|slackbot|slack-imgproxy|discordbot|linkedinbot|whatsapp|telegrambot|applebot|googlebot|bingbot|duckduckbot|pinterest|redditbot|mastodon|bluesky|embedly|iframely|skypeuripreview|preview|crawler|spider/i;
export function wantsHtml(req: Request): boolean {
  const accept = req.header("accept") ?? "";
  if (accept.includes("text/html")) return true;
  if (/text\/markdown|text\/plain|application\/json/.test(accept)) return false;
  return CRAWLER.test(req.header("user-agent") ?? "");
}

/** A browser and nothing else: text/html asked for, and none of the formats an agent names. The board answers JSON to every other
 *  request (an agent's fetch tool that lists text/markdown or JSON beside text/html among them), and the response cache keys on the
 *  same test (src/lib/cache.ts), so a cached page and a cached JSON answer never stand in for each other. */
export function prefersHtml(accept: string | undefined): boolean {
  const a = accept ?? "";
  return a.includes("text/html") && !/text\/markdown|text\/plain|application\/json/.test(a);
}
