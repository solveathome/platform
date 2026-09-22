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
/** GitHub-style heading ids, so a link can point at a section of a served document (Chris, Sep 11): lowercase, punctuation dropped, spaces to hyphens, duplicates numbered. */
export function headingSlug(text: string, seen?: Map<string, number>): string {
  const base = String(text).toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/g, " ").replace(/[`*~]/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s+/g, "-") || "section";
  if (!seen) return base;
  const n = seen.get(base) ?? 0; seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}
export function safeRenderer(): Renderer {
  const r = new Renderer();
  const link = r.link.bind(r), image = r.image.bind(r);
  const seen = new Map<string, number>();
  r.link = (t: any) => safeHref(t.href) === null ? r.parser.parseInline(t.tokens) : link(t);
  r.image = (t: any) => safeHref(t.href) === null ? esc(t.text) : image(t);
  r.heading = (t: any) => { const inner = r.parser.parseInline(t.tokens); return `<h${t.depth} id="${esc(headingSlug(inner, seen))}">${inner}</h${t.depth}>\n`; };
  return r;
}

/**
 * Source text for a render site: `<` always escaped, so raw HTML never gets through; `>` escaped except as a blockquote marker at the start of a line.
 * Escaping every `>` turned each quoted theorem into literal "&gt;" text (beta2-note, Sep 22); a `>` alone cannot open a tag.
 */
export function escapeSource(src: string): string {
  return src.replace(/</g, "&lt;").replace(/^((?: {0,3}>[ \t]?)+)|>/gm, (m, quote) => quote ?? "&gt;");
}

const WORD = /[\p{L}\p{N}_]/u;
/**
 * Plain-text math as manuscripts write it without TeX delimiters: `p^{β₂+ε}`, `Σ_{m|P(z)}`, `(log w)^κ`, `r_A(m)`, `≪_ε`.
 * KaTeX only sees `$…$` and `\[…\]`, so this notation showed its braces raw (Chris, Sep 22: beta2-note "does not seem to render as math").
 * Runs on rendered text, never in code, links' targets or TeX spans (protectMath has taken those out). A single unbraced character is
 * lifted only when no word character follows it, so `snake_case` stays as written.
 */
export function plainNotation(html: string): string {
  let out = "";
  for (let i = 0; i < html.length; i++) {
    const c = html[i];
    const prev = html[i - 1];
    if ((c === "^" || c === "_") && prev !== undefined && !/\s/.test(prev) && prev !== "_" && prev !== "^") {
      const tag = c === "^" ? "sup" : "sub";
      if (html[i + 1] === "{") {
        let depth = 0, j = i + 1;
        for (; j < html.length && j - i < 120; j++) { const d = html[j]; if (d === "\n") break; if (d === "{") depth++; else if (d === "}" && --depth === 0) break; }
        if (depth === 0 && html[j] === "}" && j > i + 2) { out += `<${tag}>${plainNotation(html.slice(i + 2, j))}</${tag}>`; i = j; continue; }
      } else {
        const ch = String.fromCodePoint(html.codePointAt(i + 1) ?? 32);
        const after = html[i + 1 + ch.length];
        const next = html[i + 2 + ch.length];
        // a file name ("run_2.log", "a_b-c") is not notation: the character must end a word, not start a dotted or hyphenated one
        const ends = after === undefined || (!WORD.test(after) && !((after === "." || after === "-") && next !== undefined && WORD.test(next)));
        if (/[\p{L}\p{N}]/u.test(ch) && ends) { out += `<${tag}>${ch}</${tag}>`; i += ch.length; continue; }
      }
    }
    out += c;
  }
  return out;
}

/**
 * The renderer a manuscript or served document is read with: `safeRenderer` plus plain-text math. A paragraph indented by two or three
 * spaces is a display line (a formula set apart in the source); it keeps its line breaks instead of running into prose. Headings keep
 * their notation as written, so section ids and the links into them do not move.
 */
export function documentRenderer(): Renderer {
  const r = safeRenderer();
  const text = r.text.bind(r), heading = r.heading.bind(r);
  let inHeading = false;
  r.text = (t: any) => { const html = text(t); return inHeading || ("tokens" in t && t.tokens) ? html : plainNotation(html); };
  r.heading = (t: any) => { inHeading = true; try { return heading(t); } finally { inHeading = false; } };
  r.paragraph = (t: any) => {
    const inner = r.parser.parseInline(t.tokens);
    if (!/^ {2,3}\S/.test(t.raw)) return `<p>${inner}</p>\n`;
    const lines = inner.split("\n");
    const indent = Math.min(...lines.filter((l: string) => l.trim()).map((l: string) => /^ */.exec(l)![0].length));
    return `<p class="display">${lines.map((l: string) => l.slice(indent).trimEnd()).join("\n")}</p>\n`;
  };
  return r;
}

// Every parse that does not pass its own renderer goes through these.
marked.use({
  renderer: {
    link(this: any, t: any) { return safeHref(t.href) === null ? this.parser.parseInline(t.tokens) : false; },
    image(t: any) { return safeHref(t.href) === null ? esc(t.text) : false; },
    heading(this: any, t: any) { const inner = this.parser.parseInline(t.tokens); return `<h${t.depth} id="${esc(headingSlug(inner))}">${inner}</h${t.depth}>\n`; },
  },
});
