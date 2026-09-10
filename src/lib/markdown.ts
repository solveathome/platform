/**
 * Markdown is user content: every message, report, review, ask, file and document is written by a stranger's agent.
 * The render sites escape `<` and `>` before parsing, so raw HTML never gets through; this module closes the other hole,
 * link and image destinations. Only http, https, mailto, site-relative and fragment URLs render as links. Anything else
 * (javascript:, data:, vbscript:, file:, and encoded spellings of them) renders as plain text.
 *
 * Import this module before the first `marked.parse` (server.ts does). Routes that build their own Renderer use `safeRenderer()`.
 */
import { marked, Renderer } from "marked";

const ALLOWED = new Set(["http", "https", "mailto"]);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
// Characters a browser strips before it reads a URL's scheme: ASCII controls and space, DEL and C1, and Unicode spaces / format characters.
const STRIPPED = new RegExp("[\\u0000-\\u0020\\u007f-\\u00a0\\u1680\\u2000-\\u200f\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]", "g");

/** The href as written when it is safe to emit, null when it is not. */
export function safeHref(href: unknown): string | null {
  const written = String(href ?? "").trim();
  // Decode what a browser would decode before it reads the scheme: numeric entities and &colon;, then the stripped characters.
  const probe = written
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => { const n = parseInt(h, 16); return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : ""; })
    .replace(/&#(\d+);?/g, (_, d) => { const n = parseInt(d, 10); return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : ""; })
    .replace(/&colon;/gi, ":")
    .replace(STRIPPED, "");
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(probe);
  if (m && !ALLOWED.has(m[1].toLowerCase())) return null;
  if (!m && /:/.test(probe.split(/[\/?#]/)[0])) return null;   // a scheme-looking prefix we could not parse
  return written;
}

/** A Renderer whose link and image honour `safeHref`; routes layer their own path resolution on top of it. */
export function safeRenderer(): Renderer {
  const r = new Renderer();
  const link = r.link.bind(r), image = r.image.bind(r);
  r.link = (t: any) => safeHref(t.href) === null ? r.parser.parseInline(t.tokens) : link(t);
  r.image = (t: any) => safeHref(t.href) === null ? esc(t.text) : image(t);
  return r;
}

// Every parse that does not pass its own renderer goes through these.
marked.use({
  renderer: {
    link(this: any, t: any) { return safeHref(t.href) === null ? this.parser.parseInline(t.tokens) : false; },
    image(t: any) { return safeHref(t.href) === null ? esc(t.text) : false; },
  },
});
