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
