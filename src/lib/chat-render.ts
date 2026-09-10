/**
 * Chat rendering for browsers (Chris, Sep 10): the channel is organisation, not a work log. Messages are short and point
 * at the body of work, so everything they point at is clickable: returns, asks, files, documents, handles, URLs.
 */
import { marked } from "marked";
import { protectMath } from "./math.js";
import { linkPeople } from "./people.js";
import { linkPaths } from "./paths-link.js";

/** Link references in already-rendered HTML, outside tags and existing anchors: "return #12", "ask #3", a sha256, "/files/<sha>", "job #7". */
export function linkRefs(html: string, slug: string): string {
  const parts = html.split(/(<[^>]+>)/); let inA = 0; let inCode = 0; const out: string[] = [];
  for (const part of parts) {
    if (part.startsWith("<")) {
      if (/^<a[\s>]/i.test(part)) inA++; else if (/^<\/a>/i.test(part)) inA = Math.max(0, inA - 1);
      if (/^<(code|pre)[\s>]/i.test(part)) inCode++; else if (/^<\/(code|pre)>/i.test(part)) inCode = Math.max(0, inCode - 1);
      out.push(part); continue;
    }
    if (inA || inCode) { out.push(part); continue; }
    out.push(part
      .replace(/\b(return|result)s? #(\d+)/gi, (_m, w, n) => `<a href="/projects/${slug}/return/${n}">${w} #${n}</a>`)
      .replace(/\bask #(\d+)/gi, (_m, n) => `<a href="/projects/${slug}/asks/${n}">ask #${n}</a>`)
      .replace(/\bjob #(\d+)/gi, (_m, n) => `<a href="/projects/${slug}/job/${n}">job #${n}</a>`)
      .replace(/\bmessage #?(\d{1,9})\b/gi, (_m, n) => `<a href="#m${n}">message ${n}</a>`)
      .replace(/(?:\/files\/)?\b([a-f0-9]{64})\b/g, (_m, sha) => `<a href="/files/${sha}">${sha.slice(0, 12)}…</a>`));
  }
  return out.join("");
}

/** Markdown -> HTML for one message: math protected, raw HTML escaped, GFM autolinks, then paths, people and references linked. */
export async function renderMessage(body_md: string, slug: string, pages: Map<string, string> = new Map()): Promise<string> {
  const m = protectMath(String(body_md ?? "").replace(/<!--[\s\S]*?-->/g, ""));
  const html = m.restore(marked.parse(m.text.replace(/</g, "&lt;").replace(/>/g, "&gt;"), { gfm: true, breaks: true }) as string);
  return linkRefs(linkPaths(await linkPeople(html), slug, "", pages), slug);
}

/** The cap on a channel message. Findings live in files and returns; the channel carries the point and the link. */
export const MAX_MESSAGE_CHARS = 1500;
export const MAX_STATUS_CHARS = 500;   // claim and done: one line in, one line out
export const TOO_LONG = (kind: string, n: number) => `message too long (${n} chars, ${kind === "claim" || kind === "done" ? MAX_STATUS_CHARS : MAX_MESSAGE_CHARS} max for "${kind}"; ${n - (kind === "claim" || kind === "done" ? MAX_STATUS_CHARS : MAX_MESSAGE_CHARS)} over). A claim is one line: the job, and a conflict if you have one; the disclosure in full belongs in the return. The channel is organisation, not a work log: put the text in a file (POST /files, then "files": ["<sha256>"]) or in your return, and post the point, the question or the request with the link. Findings, derivations and logs do not belong in a message.`;
